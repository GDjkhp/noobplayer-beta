//! Optional noobplayer server password (NOOBPLAYER_PASSWORD in .env).
//! Empty / unset = open server. When set, every /api/ route, the live Socket.IO
//! connection and the WebTransport audio session need the access token the
//! client gets from POST /api/auth/login (an HMAC of the password, never the
//! password itself).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use axum::extract::{ConnectInfo, FromRequestParts, Request};
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use bytes::Bytes;
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use serde_json::json;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::util::{jerr, jsonify, jsonify_status, now_secs, parse_body, str_or};

struct AuthCfg {
    password: String,
    token: String,
}
static CFG: OnceLock<AuthCfg> = OnceLock::new();
static LOGIN_FAILS: LazyLock<Mutex<HashMap<String, Vec<f64>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn init(password: String) {
    let token = if password.is_empty() {
        String::new()
    } else {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(password.as_bytes()).expect("hmac key");
        mac.update(b"noobplayer-auth-v1");
        mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect()
    };
    let _ = CFG.set(AuthCfg { password, token });
}

fn cfg() -> &'static AuthCfg {
    CFG.get().expect("auth not initialised")
}

pub fn password_set() -> bool {
    !cfg().password.is_empty()
}

pub fn token_ok(tok: Option<&str>) -> bool {
    if !password_set() {
        return true;
    }
    match tok {
        Some(t) => bool::from(t.as_bytes().ct_eq(cfg().token.as_bytes())),
        None => false,
    }
}

/// `X-Forwarded-For` first hop, else the peer address.
pub struct ClientIp(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _s: &S) -> Result<Self, Self::Rejection> {
        let fwd = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !fwd.is_empty() {
            return Ok(ClientIp(fwd));
        }
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string())
            .unwrap_or_else(|| "?".into());
        Ok(ClientIp(ip))
    }
}

pub fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let q = query?;
    url_pairs(q).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// parse_qs-style decoding (first value wins via find).
pub fn url_pairs(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (dec(k), dec(v))
        })
        .collect()
}

fn dec(s: &str) -> String {
    let s = s.replace('+', " ");
    percent_encoding::percent_decode_str(&s).decode_utf8_lossy().into_owned()
}

/// `@app.before_request _require_password`
pub async fn require_password(req: Request, next: Next) -> Response {
    if !password_set() || req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    let path = req.uri().path();
    if !path.starts_with("/api/") || path == "/api/auth/status" || path == "/api/auth/login" {
        return next.run(req).await;
    }
    let hdr = req.headers().get("x-noobplayer-token").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    // Python: header OR ?token= (an empty header falls through to the query).
    let tok = match hdr {
        Some(h) if !h.is_empty() => Some(h),
        _ => query_param(req.uri().query(), "token"),
    };
    if token_ok(tok.as_deref()) {
        return next.run(req).await;
    }
    jsonify_status(json!({"error": "password required", "auth": "required"}), 401)
}

/// Public. Tells the client whether this server wants a password, and whether
/// the token it sent (if any) is still good.
pub async fn auth_status(req: Request) -> Response {
    let hdr = req.headers().get("x-noobplayer-token").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let tok = match hdr {
        Some(h) if !h.is_empty() => Some(h),
        _ => query_param(req.uri().query(), "token"),
    };
    jsonify(json!({"required": password_set(), "authorized": token_ok(tok.as_deref())}))
}

pub async fn auth_login(ClientIp(ip): ClientIp, body: Bytes) -> Response {
    if !password_set() {
        return jsonify(json!({"ok": true, "required": false, "token": ""}));
    }
    let now = now_secs();
    {
        let mut m = LOGIN_FAILS.lock();
        let fails: Vec<f64> = m.get(&ip).cloned().unwrap_or_default().into_iter().filter(|t| now - t < 60.0).collect();
        if fails.len() >= 8 {
            m.insert(ip, fails);
            return jerr(429, "too many attempts — wait a minute");
        }
    }
    let data = parse_body(&body);
    let given = str_or(data.get("password"), "");
    if bool::from(given.as_bytes().ct_eq(cfg().password.as_bytes())) {
        LOGIN_FAILS.lock().remove(&ip);
        return jsonify(json!({"ok": true, "required": true, "token": cfg().token}));
    }
    {
        let mut m = LOGIN_FAILS.lock();
        let mut fails: Vec<f64> = m.get(&ip).cloned().unwrap_or_default().into_iter().filter(|t| now - t < 60.0).collect();
        fails.push(now);
        m.insert(ip, fails);
    }
    tokio::time::sleep(Duration::from_millis(600)).await; // slows down guessing
    jerr(401, "wrong password")
}
