//! NodeLink client: every backend -> NodeLink call goes through `request`,
//! which instruments it for the Debug tab (bounded most-recent-first log, pushed
//! live to subscribed sockets), plus the `/api/nodelink/*` proxy routes that keep
//! NODELINK_PASSWORD server-side only.

use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures_util::stream::{self, Stream, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use socketioxide::socket::Sid;

use crate::sio;
use crate::util::{http_error, now_ms, parse_body};

const NODELINK_LOG_CAP: usize = 60;

struct NlConfig {
    host: String,
    pass: String,
}

static NL: OnceLock<NlConfig> = OnceLock::new();
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Most recent first.
static REQUESTS: LazyLock<Mutex<VecDeque<Value>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
/// sids currently subscribed to the Debug tab's NodeLink log.
pub static DEBUG_SUBSCRIBERS: LazyLock<Mutex<HashSet<Sid>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn init(host: String, pass: String) {
    let _ = NL.set(NlConfig { host, pass });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build the HTTP client");
    let _ = CLIENT.set(client);
}

pub fn host() -> &'static str {
    &NL.get().expect("nodelink not initialised").host
}

fn pass() -> &'static str {
    &NL.get().expect("nodelink not initialised").pass
}

fn client() -> &'static reqwest::Client {
    CLIENT.get().expect("nodelink not initialised")
}

pub fn requests_snapshot() -> Vec<Value> {
    REQUESTS.lock().iter().cloned().collect()
}

async fn push_entry(entry: Value) {
    REQUESTS.lock().push_front(entry.clone());
    {
        let mut log = REQUESTS.lock();
        while log.len() > NODELINK_LOG_CAP {
            log.pop_back();
        }
    }
    let subs: Vec<Sid> = DEBUG_SUBSCRIBERS.lock().iter().copied().collect();
    for sid in subs {
        if !sio::emit_to_sid(sid, "nodelink_request", entry.clone()).await {
            DEBUG_SUBSCRIBERS.lock().remove(&sid);
        }
    }
}

/// Stream requests (`/v4/loadstream`) opt out of the total timeout entirely
/// (the connection can sit idle for as long as a track is paused); everything
/// else keeps aiohttp's default 5 minute bound.
const DEFAULT_TOTAL_TIMEOUT: Duration = Duration::from_secs(300);

/// One instrumented NodeLink call. Timed to the response HEADERS (not to the end
/// of the body), so a long-lived /v4/loadstream reports a useful TTFB.
pub async fn request(
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    json_body: Option<&Value>,
    stream: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let url = format!("{}{}", host(), path);
    let m = if method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
    let mut rb = client().request(m, &url).header("Authorization", pass());
    if !query.is_empty() {
        rb = rb.query(query);
    }
    if let Some(b) = json_body {
        rb = rb.json(b);
    }
    if !stream {
        rb = rb.timeout(DEFAULT_TOTAL_TIMEOUT);
    }
    let t0 = Instant::now();
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let size = resp
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok());
            let entry = json!({
                "method": method, "path": path, "status": status, "ok": status < 400,
                "ms": t0.elapsed().as_millis() as u64,
                "size": size,
                "ts": now_ms(),
            });
            push_entry(entry).await;
            Ok(resp)
        }
        Err(e) => {
            let msg: String = e.to_string().chars().take(160).collect();
            let entry = json!({
                "method": method, "path": path, "status": "ERR", "ok": false,
                "ms": t0.elapsed().as_millis() as u64, "size": Value::Null,
                "ts": now_ms(), "error": msg,
            });
            push_entry(entry).await;
            Err(e)
        }
    }
}

/// GET + parse JSON, returning None for anything that isn't a clean 200 with a
/// JSON body (non-200, network error, timeout, bad JSON).
pub async fn get_json_lenient(path: &str, query: &[(&str, &str)]) -> Option<Value> {
    let r = request("GET", path, query, None, false).await.ok()?;
    if r.status().as_u16() != 200 {
        return None;
    }
    let body = r.bytes().await.ok()?;
    serde_json::from_slice(&body).ok()
}

// ───────────────────────── proxy routes ─────────────────────────

/// `Response(body, status=r.status, mimetype="application/json")`
async fn proxy_json(path: &str, query: &[(&str, &str)]) -> Response {
    let r = match request("GET", path, query, None, false).await {
        Ok(r) => r,
        Err(_) => return http_error(500),
    };
    let status = r.status().as_u16();
    let body = match r.bytes().await {
        Ok(b) => b,
        Err(_) => return http_error(500),
    };
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp
}

pub async fn nl_info() -> Response {
    proxy_json("/v4/info", &[]).await
}

pub async fn nl_loadtracks(Query(q): Query<std::collections::HashMap<String, String>>) -> Response {
    let identifier = q.get("identifier").cloned().unwrap_or_default();
    proxy_json("/v4/loadtracks", &[("identifier", identifier.as_str())]).await
}

pub async fn nl_loadlyrics(Query(q): Query<std::collections::HashMap<String, String>>) -> Response {
    let et = q.get("encodedTrack").cloned().unwrap_or_default();
    // Optional lyrics provider. Absent/empty ("Default") sends nothing, so NodeLink picks the best lyrics itself.
    let src = q.get("source").map(|s| s.trim().to_string()).unwrap_or_default();
    let mut params: Vec<(&str, &str)> = vec![("encodedTrack", et.as_str())];
    if !src.is_empty() {
        params.push(("source", src.as_str()));
    }
    proxy_json("/v4/loadlyrics", &params).await
}

pub async fn nl_meaning(Query(q): Query<std::collections::HashMap<String, String>>) -> Response {
    let et = q.get("encodedTrack").cloned().unwrap_or_default();
    proxy_json("/v4/meaning", &[("encodedTrack", et.as_str())]).await
}

/// Re-slices a byte stream into pieces of at most `n` bytes (`iter_chunked`).
pub fn chunked<S>(s: S, n: usize) -> impl Stream<Item = Result<Bytes, reqwest::Error>>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>>,
{
    s.flat_map(move |item| match item {
        Ok(b) => {
            let mut parts: Vec<Result<Bytes, reqwest::Error>> = Vec::new();
            let mut off = 0;
            while off < b.len() {
                let end = (off + n).min(b.len());
                parts.push(Ok(b.slice(off..end)));
                off = end;
            }
            stream::iter(parts)
        }
        Err(e) => stream::iter(vec![Err(e)]),
    })
}

pub async fn nl_loadstream(body: Bytes) -> Response {
    let data = Value::Object(parse_body(&body));

    // The NodeLink request is only opened once the response body is first polled
    // (same as the original async generator).
    enum St {
        Start(Value),
        Streaming(std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>),
    }
    let s = stream::unfold(St::Start(data), |st| async move {
        let mut st = st;
        loop {
            match st {
                St::Start(data) => match request("POST", "/v4/loadstream", &[], Some(&data), true).await {
                    Ok(r) => {
                        st = St::Streaming(Box::pin(chunked(r.bytes_stream(), 8192)));
                    }
                    Err(_) => return None,
                },
                St::Streaming(mut inner) => match inner.next().await {
                    Some(Ok(chunk)) => {
                        if chunk.is_empty() {
                            st = St::Streaming(inner);
                            continue;
                        }
                        return Some((Ok::<Bytes, std::io::Error>(chunk), St::Streaming(inner)));
                    }
                    Some(Err(_)) | None => return None,
                },
            }
        }
    });
    let mut resp = Response::new(Body::from_stream(s));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    resp
}