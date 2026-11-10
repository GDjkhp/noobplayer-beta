//! Thumbnail image proxy (`GET /api/img?url=…`) — port of `image_proxy` in server.py.
//!
//! Playlist covers are saved in the browser as small base64 data: URLs because
//! the CDN links expire. Reading an image's bytes from the page needs the image
//! host to send CORS headers, and most of them don't, so the browser asks THIS
//! server for the image and the server fetches it. Because the route makes
//! outbound requests to a caller-chosen URL it is locked down:
//!   * http/https on ports 80/443 only, no credentials in the URL
//!   * public addresses only (loopback / private / link-local / CGNAT … refused).
//!     Names are resolved here, vetted, and the connection is PINNED to the vetted
//!     addresses, so DNS rebinding cannot swap the address after validation
//!   * redirects are followed by hand (<= MAX_HOPS), each hop re-validated
//!   * raster images only (never SVG), capped at MAX_BYTES, 15s total timeout

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderValue};
use axum::response::Response;
use futures_util::StreamExt;
use tokio::sync::Semaphore;

use crate::util::jerr;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_HOPS: usize = 4;
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const TYPES: [&str; 7] = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/bmp",
];

/// At most this many upstream fetches in flight at once (the Python side's connector limit).
static SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(16));

type Fail = (u16, String);

fn fail(status: u16, msg: &str) -> Fail {
    (status, msg.to_string())
}

fn v4_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || o[0] == 0                                  // 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 64)       // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)    // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18)       // 198.18.0.0/15 benchmarking
        || o[0] >= 240)                               // 240.0.0.0/4 reserved
}

/// True only for globally routable unicast addresses.
fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_public(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4_public(v4); // ::ffff:127.0.0.1 and friends
            }
            let s = v6.segments();
            if s[..6] == [0u16; 6] {
                return false; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
            }
            if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0u16; 4] {
                // NAT64 64:ff9b::/96 — judged by the IPv4 address it embeds
                let [a, b] = s[6].to_be_bytes();
                let [c, d] = s[7].to_be_bytes();
                return v4_public(Ipv4Addr::new(a, b, c, d));
            }
            if s[0] == 0x2002 {
                // 6to4 2002::/16 — judged by the embedded IPv4 address
                let [a, b] = s[1].to_be_bytes();
                let [c, d] = s[2].to_be_bytes();
                return v4_public(Ipv4Addr::new(a, b, c, d));
            }
            !(v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00                // fc00::/7 unique local
                || (s[0] & 0xffc0) == 0xfe80                // fe80::/10 link-local
                || (s[0] == 0x2001 && s[1] == 0x0db8))      // 2001:db8::/32 documentation
        }
    }
}

pub async fn image_proxy(Query(q): Query<HashMap<String, String>>) -> Response {
    let url = q.get("url").map(|s| s.trim().to_string()).unwrap_or_default();
    if url.is_empty() || url.len() > 2048 {
        return jerr(400, "url required");
    }
    let Ok(_permit) = SLOTS.acquire().await else {
        return jerr(500, "image proxy unavailable");
    };
    match tokio::time::timeout(TOTAL_TIMEOUT, fetch(url)).await {
        Ok(Ok(resp)) => resp,
        Ok(Err((status, msg))) => jerr(status, &msg),
        Err(_) => jerr(502, "failed to fetch image: timed out"),
    }
}

async fn fetch(mut url: String) -> Result<Response, Fail> {
    for _ in 0..=MAX_HOPS {
        let parsed = reqwest::Url::parse(&url).map_err(|_| fail(400, "bad url"))?;
        let unsupported = || fail(400, "unsupported url");
        if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(unsupported());
        }
        let port = parsed.port_or_known_default().unwrap_or(0);
        if port != 80 && port != 443 {
            return Err(unsupported());
        }
        // The URL parser has already normalised odd IPv4 spellings (2130706433, 0x7f.1 …).
        let host = parsed.host_str().ok_or_else(unsupported)?.to_string();
        let bare = host.trim_start_matches('[').trim_end_matches(']');

        // no_proxy: connect straight to the vetted address (an env HTTP(S)_PROXY would
        // resolve the name itself and sidestep the check above).
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Mozilla/5.0 (compatible; noobplayer-thumbnail-proxy)")
            .connect_timeout(Duration::from_secs(10));
        if let Ok(ip) = bare.parse::<IpAddr>() {
            if !ip_is_public(ip) {
                return Err(unsupported());
            }
        } else {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
                .await
                .map_err(|e| (502, format!("failed to fetch image: {}", e.to_string().chars().take(120).collect::<String>())))?
                .filter(|a| ip_is_public(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(fail(502, "failed to fetch image: host does not resolve to a public address"));
            }
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
        let client = builder.build().map_err(|_| fail(500, "http client error"))?;

        let resp = client
            .get(parsed.clone())
            .header(header::ACCEPT, "image/*,*/*;q=0.5")
            .send()
            .await
            .map_err(|e| (502, format!("failed to fetch image: {}", e.to_string().chars().take(120).collect::<String>())))?;

        let code = resp.status().as_u16();
        if matches!(code, 301 | 302 | 303 | 307 | 308) {
            let loc = resp
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| fail(502, "bad redirect"))?;
            url = parsed.join(loc).map_err(|_| fail(502, "bad redirect"))?.to_string();
            continue;
        }
        if code != 200 {
            return Err((502, format!("upstream returned {code}")));
        }
        let ctype = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
            .unwrap_or_default();
        let Some(ctype) = TYPES.iter().copied().find(|t| *t == ctype) else {
            return Err(fail(415, "not a supported image"));
        };
        if resp.content_length().map(|n| n > MAX_BYTES as u64).unwrap_or(false) {
            return Err(fail(413, "image too large"));
        }
        let mut buf: Vec<u8> = Vec::new();
        let mut body = resp.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| (502, format!("failed to fetch image: {}", e.to_string().chars().take(120).collect::<String>())))?;
            if buf.len() + chunk.len() > MAX_BYTES {
                return Err(fail(413, "image too large"));
            }
            buf.extend_from_slice(&chunk);
        }

        let mut out = Response::new(Body::from(buf));
        let h = out.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ctype));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
        h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        return Ok(out);
    }
    Err(fail(502, "too many redirects"))
}