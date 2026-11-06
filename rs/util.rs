//! Small helpers that reproduce the Python semantics the server relies on:
//! `str()` / truthiness / slicing by code points, `asyncio.Event`, Quart's
//! `jsonify`, and a few shared response builders.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::Notify;

// ───────────────────────── time ─────────────────────────

/// `time.time()`
pub fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// `time.time() * 1000`
pub fn now_ms() -> f64 {
    now_secs() * 1000.0
}

// ───────────────────────── python-ish value helpers ─────────────────────────

/// Python truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i != 0
            } else if let Some(u) = n.as_u64() {
                u != 0
            } else {
                n.as_f64().map(|f| f != 0.0).unwrap_or(true)
            }
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

pub fn truthy_opt(v: Option<&Value>) -> bool {
    v.map(truthy).unwrap_or(false)
}

/// `s[:n]` on a Python str (slices by code point, not by byte).
pub fn trunc_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Python `repr(float)`.
fn py_float_repr(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let abs = f.abs();
    if (1e-4..1e16).contains(&abs) {
        let s = format!("{}", f);
        if s.contains('.') {
            s
        } else {
            format!("{}.0", s)
        }
    } else {
        // scientific: Python writes e.g. 1e-05, 1.5e+16
        let s = format!("{:e}", f);
        let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
        let exp: i32 = exp.parse().unwrap_or(0);
        format!("{}e{}{:02}", mant, if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// Python `repr(str)`.
fn py_str_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                py_float_repr(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => py_str_repr(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", py_str_repr(k), py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Python `str(x)` for a JSON-decoded value.
pub fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}

/// `str(data.get(key) or default)`
pub fn str_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(v) if truthy(v) => py_str(v),
        _ => default.to_string(),
    }
}

/// `float(x)`; None where Python would raise ValueError/TypeError.
pub fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => {
            let t = s.trim();
            let lower = t.to_ascii_lowercase();
            match lower.as_str() {
                "nan" | "+nan" | "-nan" => return Some(f64::NAN),
                "inf" | "+inf" | "infinity" | "+infinity" => return Some(f64::INFINITY),
                "-inf" | "-infinity" => return Some(f64::NEG_INFINITY),
                _ => {}
            }
            let cleaned: String = t.replace('_', "");
            if cleaned.len() != t.len() && (t.starts_with('_') || t.ends_with('_') || t.contains("__")) {
                return None;
            }
            if cleaned.is_empty() || cleaned.starts_with("0x") || cleaned.contains(char::is_whitespace) {
                return None;
            }
            cleaned.parse::<f64>().ok()
        }
        _ => None,
    }
}

/// `round(x, nd)` with Python's correctly-rounded (half-even on the exact binary value) semantics.
pub fn py_round(x: f64, nd: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{:.*}", nd, x).parse::<f64>().unwrap_or(x)
}

/// A JSON number from an f64, the way Python's json would emit it (NaN/inf
/// can't be represented by serde_json and become null).
pub fn jf(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

// ───────────────────────── asyncio.Event ─────────────────────────

/// `asyncio.Event`: set / clear / is_set / wait.
pub struct Event {
    flag: AtomicBool,
    notify: Notify,
}

impl Event {
    pub fn new() -> Self {
        Self { flag: AtomicBool::new(false), notify: Notify::new() }
    }
    pub fn set(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn clear(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register interest before re-checking the flag so a concurrent set() is never missed.
            notified.as_mut().enable();
            if self.is_set() {
                return;
            }
            notified.await;
        }
    }
    /// `asyncio.wait_for(event.wait(), timeout)`: true if the event fired, false on timeout.
    pub async fn wait_timeout(&self, d: Duration) -> bool {
        tokio::time::timeout(d, self.wait()).await.is_ok()
    }
}

/// Completion flag for a spawned task whose handle several places want to poll
/// or await (`task.done()` / `asyncio.shield(task)`).
pub struct TaskDone {
    done: AtomicBool,
    notify: Notify,
}

impl TaskDone {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { done: AtomicBool::new(false), notify: Notify::new() })
    }
    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
    fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_done() {
                return;
            }
            notified.await;
        }
    }
    /// Guard that marks the task done when dropped (normal end, panic or abort alike).
    pub fn guard(self: &std::sync::Arc<Self>) -> TaskDoneGuard {
        TaskDoneGuard(self.clone())
    }
}

pub struct TaskDoneGuard(std::sync::Arc<TaskDone>);

impl Drop for TaskDoneGuard {
    fn drop(&mut self) {
        self.0.finish();
    }
}

// ───────────────────────── JSON in / out ─────────────────────────

/// `await request.get_json(force=True, silent=True) or {}` (anything that is not an object is treated as `{}`).
pub fn parse_body(body: &Bytes) -> Map<String, Value> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// serde_json formatter that escapes every non-ASCII character as `\uXXXX`
/// (Python's `ensure_ascii=True`, which Quart's jsonify uses).
struct AsciiFormatter;

impl serde_json::ser::Formatter for AsciiFormatter {
    fn write_string_fragment<W: ?Sized + std::io::Write>(&mut self, w: &mut W, fragment: &str) -> std::io::Result<()> {
        let mut start = 0;
        for (i, c) in fragment.char_indices() {
            if (c as u32) > 0x7e {
                if start < i {
                    w.write_all(fragment[start..i].as_bytes())?;
                }
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    write!(w, "\\u{:04x}", unit)?;
                }
                start = i + c.len_utf8();
            }
        }
        if start < fragment.len() {
            w.write_all(fragment[start..].as_bytes())?;
        }
        Ok(())
    }
}

/// Quart `jsonify`: sorted keys (serde_json's default map), compact separators,
/// ASCII-only output and a trailing newline.
pub fn json_bytes(v: &Value) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    {
        let mut ser = serde_json::Serializer::with_formatter(&mut out, AsciiFormatter);
        if v.serialize(&mut ser).is_err() {
            out.clear();
            out.extend_from_slice(b"null");
        }
    }
    out.push(b'\n');
    out
}

pub fn jsonify(v: Value) -> Response {
    jsonify_status(v, 200)
}

pub fn jsonify_status(v: Value, status: u16) -> Response {
    let body = json_bytes(&v);
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    resp
}

/// `return jsonify({"error": msg}), status`
pub fn jerr(status: u16, msg: &str) -> Response {
    jsonify_status(json!({ "error": msg }), status)
}

/// Werkzeug's default error page.
pub fn http_error(status: u16) -> Response {
    let (title, desc) = match status {
        404 => (
            "404 Not Found",
            "<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n",
        ),
        405 => (
            "405 Method Not Allowed",
            "<h1>Method Not Allowed</h1>\n<p>The method is not allowed for the requested URL.</p>\n",
        ),
        _ => (
            "500 Internal Server Error",
            "<h1>Internal Server Error</h1>\n<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>\n",
        ),
    };
    let body = format!("<!doctype html>\n<title>{}</title>\n{}", title, desc);
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    resp
}

/// Short, stable id helpers (`uuid.uuid4().hex`).
pub fn uuid_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
