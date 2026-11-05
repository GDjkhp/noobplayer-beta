//! Static frontend, served out of the project root exactly like Quart's
//! `send_from_directory`: ETag / Last-Modified / Cache-Control: public, conditional
//! GET (304) and single-range requests (206), plus the werkzeug error pages.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use time::OffsetDateTime;

use crate::util::{http_error, jerr, jf, py_str};

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// STATIC_DIR — the project root (index.html lives here).
pub fn init(root: PathBuf) {
    let _ = ROOT.set(root);
}

pub fn root() -> &'static Path {
    ROOT.get().expect("static root not initialised")
}

const STATIC_ALLOWED_DIRS: [&str; 5] = ["css/", "js/", "assets/", "img/", "fonts/"];
const STATIC_ALLOWED_SUFFIXES: [&str; 14] = [
    ".css", ".js", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".html",
];

/// mimetypes.guess_type(...)[0] or "application/octet-stream" (CPython 3.13 table)
fn guess_mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "map" => "application/octet-stream",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "xml" => "text/xml",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/x-wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// werkzeug `get_content_type`: text-ish types get "; charset=utf-8".
fn content_type(mime: &str) -> String {
    let m = mime.to_lowercase();
    if m.starts_with("text/")
        || matches!(
            m.as_str(),
            "application/ecmascript"
                | "application/javascript"
                | "application/sql"
                | "application/xml"
                | "application/xml-dtd"
                | "application/xml-external-parsed-entity"
        )
        || m.ends_with("+xml")
    {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &d in data {
        a = (a + d as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn http_date(secs: i64) -> String {
    let t = OffsetDateTime::from_unix_timestamp(secs).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        DAYS[t.weekday().number_days_from_monday() as usize],
        t.day(),
        MONTHS[t.month() as usize - 1],
        t.year(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

fn parse_http_date(s: &str) -> Option<i64> {
    OffsetDateTime::parse(s.trim(), &time::format_description::well_known::Rfc2822).ok().map(|t| t.unix_timestamp())
}

#[derive(Default)]
struct ETags {
    star: bool,
    strong: Vec<String>,
    weak: Vec<String>,
}

impl ETags {
    fn truthy(&self) -> bool {
        self.star || !self.strong.is_empty() || !self.weak.is_empty()
    }
    fn is_strong(&self, e: &str) -> bool {
        self.strong.iter().any(|s| s == e)
    }
    fn contains_weak(&self, e: &str) -> bool {
        self.star || self.is_strong(e) || self.weak.iter().any(|s| s == e)
    }
}

fn parse_etags(v: Option<&str>) -> ETags {
    let mut out = ETags::default();
    let Some(v) = v else { return out };
    if v.trim() == "*" {
        out.star = true;
        return out;
    }
    for part in v.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let (weak, q) = match p.strip_prefix("W/") {
            Some(r) => (true, r),
            None => (false, p),
        };
        let q = q.trim();
        if q.len() >= 2 && q.starts_with('"') && q.ends_with('"') {
            let inner = q[1..q.len() - 1].to_string();
            if weak {
                out.weak.push(inner);
            } else {
                out.strong.push(inner);
            }
        }
    }
    out
}

fn hv<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

/// werkzeug `is_resource_modified` for our (always-present) etag + last-modified.
fn is_modified(req: &HeaderMap, etag: &str, last_modified: i64, ignore_if_range: bool) -> bool {
    let mut unmodified = false;
    let mut if_range_etag: Option<String> = None;
    let mut modified_since = parse_http_date_opt(hv(req, "if-modified-since"));
    if !ignore_if_range && req.contains_key(header::RANGE) {
        if let Some(ir) = hv(req, "if-range") {
            let ir = ir.trim();
            if ir.starts_with('"') || ir.starts_with("W/") {
                let t = parse_etags(Some(ir));
                if let Some(e) = t.strong.first().or(t.weak.first()) {
                    if_range_etag = Some(e.clone());
                }
            } else if let Some(d) = parse_http_date(ir) {
                modified_since = Some(d);
            }
        }
    }
    if let Some(ms) = modified_since {
        if last_modified <= ms {
            unmodified = true;
        }
    }
    if let Some(e) = if_range_etag {
        unmodified = e == etag;
    } else {
        let inm = parse_etags(hv(req, "if-none-match"));
        if inm.truthy() {
            unmodified = inm.contains_weak(etag);
        }
        let im = parse_etags(hv(req, "if-match"));
        if im.truthy() {
            unmodified = !im.is_strong(etag);
        }
    }
    !unmodified
}

fn parse_http_date_opt(v: Option<&str>) -> Option<i64> {
    v.and_then(parse_http_date)
}

fn range_not_satisfiable(total: Option<u64>) -> Response {
    let body = "<!doctype html>\n<title>416 Requested Range Not Satisfiable</title>\n<h1>Requested Range Not Satisfiable</h1>\n<p>The server cannot provide the requested range.</p>\n";
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    if let Some(t) = total {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{t}")) {
            r.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    r
}

/// Quart `send_from_directory(STATIC_DIR, name, mimetype=...)` (conditional=True).
pub async fn send_from_directory(name: &str, mimetype: Option<&str>, method: &Method, req_headers: &HeaderMap) -> Response {
    // safe_join
    let part = normpath(name);
    if part.starts_with('/') || part == ".." || part.starts_with("../") || part.contains('\\') && false {
        return http_error(404);
    }
    let path = root().join(&part);
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return http_error(404),
    };
    let size = meta.len();
    let (mtime_s, mtime_ns) = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| (d.as_secs() as i64, d.subsec_nanos()))
        .unwrap_or((0, 0));
    let mtime_f = mtime_s as f64 + mtime_ns as f64 * 1e-9;
    let abs = path.to_string_lossy().to_string();
    let etag = format!("{}-{}-{}", py_str(&jf(mtime_f)), size, adler32(abs.as_bytes()));

    let fname = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mime = mimetype.unwrap_or_else(|| guess_mime(&fname));

    let mut status = StatusCode::OK;
    let mut begin = 0u64;
    let mut end = size;
    let mut content_range: Option<String> = None;
    let mut accept_ranges = false;
    let mut empty_body = false;

    if method == Method::GET || method == Method::HEAD {
        let processable = !req_headers.contains_key("if-range") || !is_modified(req_headers, &etag, mtime_s, false);
        let processable = processable && req_headers.contains_key(header::RANGE);
        if size > 0 && processable {
            let Some(rng) = parse_range(hv(req_headers, "range")) else { return range_not_satisfiable(Some(size)) };
            if rng.units != "bytes" || rng.ranges.len() > 1 {
                return range_not_satisfiable(None);
            }
            let (b, e) = rng.ranges[0];
            let (b, e) = if b < 0 {
                // suffix range: the last -b bytes
                let n = (-b) as u64;
                (size.saturating_sub(n), size)
            } else {
                (b as u64, e.map(|e| e as u64).unwrap_or(size).min(size))
            };
            if b >= e || b > size {
                return range_not_satisfiable(None);
            }
            begin = b;
            end = e;
            status = StatusCode::PARTIAL_CONTENT;
            accept_ranges = true;
            content_range = Some(format!("bytes {}-{}/{}", begin, end - 1, size));
        } else if !is_modified(req_headers, &etag, mtime_s, true) {
            if !parse_etags(hv(req_headers, "if-match")).truthy() {
                status = StatusCode::NOT_MODIFIED;
                empty_body = true;
            } else {
                status = StatusCode::PRECONDITION_FAILED;
            }
        }
    }

    let body: Vec<u8> = if empty_body || *method == Method::HEAD {
        vec![]
    } else {
        match read_range(&path, begin, end).await {
            Some(b) => b,
            None => return http_error(500),
        }
    };

    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&content_type(mime)) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if !empty_body {
        let len = if status == StatusCode::PARTIAL_CONTENT { end - begin } else { size };
        h.insert(header::CONTENT_LENGTH, HeaderValue::from_str(&len.to_string()).unwrap());
    }
    h.insert(header::LAST_MODIFIED, HeaderValue::from_str(&http_date(mtime_s)).unwrap());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public"));
    h.insert(header::ETAG, HeaderValue::from_str(&format!("\"{etag}\"")).unwrap());
    if accept_ranges {
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    if let Some(cr) = content_range {
        h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&cr).unwrap());
    }
    resp
}

async fn read_range(path: &Path, begin: u64, end: u64) -> Option<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(path).await.ok()?;
    if begin > 0 {
        f.seek(std::io::SeekFrom::Start(begin)).await.ok()?;
    }
    let mut buf = Vec::with_capacity((end - begin) as usize);
    f.take(end - begin).read_to_end(&mut buf).await.ok()?;
    Some(buf)
}

/// posixpath.normpath for a relative URL path
fn normpath(p: &str) -> String {
    let mut out: Vec<&str> = vec![];
    let abs = p.starts_with('/');
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if out.last().map(|l| *l != "..").unwrap_or(false) {
                out.pop();
            } else if !abs {
                out.push("..");
            }
            continue;
        }
        out.push(seg);
    }
    let s = out.join("/");
    if abs {
        format!("/{s}")
    } else if s.is_empty() {
        ".".into()
    } else {
        s
    }
}

struct Range {
    units: String,
    /// (begin, end-exclusive); begin < 0 means "suffix of that length"
    ranges: Vec<(i64, Option<i64>)>,
}

/// werkzeug `parse_range_header`
fn parse_range(value: Option<&str>) -> Option<Range> {
    let value = value?;
    if value.is_empty() || !value.contains('=') {
        return None;
    }
    let (units, rng) = value.split_once('=')?;
    let units = units.trim_matches(|c| c == ' ' || c == '\t').to_lowercase();
    let mut ranges = vec![];
    let mut last_end: i64 = 0;
    for item in rng.split(',') {
        let item = item.trim_matches(|c| c == ' ' || c == '\t');
        if !item.contains('-') {
            return None;
        }
        if item.starts_with('-') {
            if last_end < 0 {
                return None;
            }
            let begin: i64 = item.parse().ok()?;
            if begin == 0 {
                return None;
            }
            ranges.push((begin, None));
            last_end = -1;
        } else {
            let (bs, es) = item.split_once('-')?;
            let bs = bs.trim_matches(|c| c == ' ' || c == '\t');
            let es = es.trim_matches(|c| c == ' ' || c == '\t');
            let begin: i64 = bs.parse().ok().filter(|_| bs.chars().all(|c| c.is_ascii_digit()))?;
            if begin < last_end || last_end < 0 {
                return None;
            }
            let end = if !es.is_empty() {
                let e: i64 = es.parse::<i64>().ok().filter(|_| es.chars().all(|c| c.is_ascii_digit()))? + 1;
                if begin >= e {
                    return None;
                }
                Some(e)
            } else {
                None
            };
            last_end = end.unwrap_or(-1);
            ranges.push((begin, end));
        }
    }
    Some(Range { units, ranges })
}

/// `static_files(path)` — the catch-all, with the allow-list so .env / config / skins.json never leak.
pub async fn serve_path(path: &str, method: &Method, headers: &HeaderMap) -> Response {
    let norm = path.replace('\\', "/");
    let norm = norm.trim_start_matches('/').to_string();
    if norm.contains("..") {
        return jerr(404, "not found");
    }
    let in_allowed_dir = STATIC_ALLOWED_DIRS.iter().any(|d| norm.starts_with(d));
    let lower = norm.to_lowercase();
    let allowed_suffix = STATIC_ALLOWED_SUFFIXES.iter().any(|s| lower.ends_with(s));
    if !(in_allowed_dir && allowed_suffix) && !(!norm.contains('/') && allowed_suffix) {
        return jerr(404, "not found");
    }
    send_from_directory(&norm, None, method, headers).await
}

pub async fn index(req: Request) -> Response {
    send_from_directory("index.html", None, req.method(), req.headers()).await
}

pub async fn readme(req: Request) -> Response {
    send_from_directory("README.md", Some("text/markdown"), req.method(), req.headers()).await
}

pub async fn robots(req: Request) -> Response {
    send_from_directory("robots.txt", Some("text/plain"), req.method(), req.headers()).await
}

/// The `/<path:path>` catch-all (GET only; anything else on an unknown path is a 405).
pub async fn catch_all(req: Request) -> Response {
    let path = percent_encoding::percent_decode_str(req.uri().path()).decode_utf8_lossy().to_string();
    serve_path(&path, req.method(), req.headers()).await
}

/// Fallback for a route that exists for other methods only: werkzeug matches the
/// GET catch-all for a GET/HEAD, and answers 405 for everything else.
pub async fn method_fallback(req: Request) -> Response {
    if req.method() == Method::GET || req.method() == Method::HEAD {
        catch_all(req).await
    } else {
        http_error(405)
    }
}
