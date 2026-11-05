//! QUIC / WebTransport listener — the actual transport for QuicPcmRelay /
//! WtListener (relay.rs). Runs as its own UDP server next to the TCP HTTP
//! server and only ever handles ONE thing: the WebTransport handshake for
//! /api/lobby/<code>/audio. The in-memory self-signed P-256 cert is re-rolled
//! in the background well before it expires.

use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::response::Response;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use wtransport::tls::Identity;
use wtransport::{Endpoint, ServerConfig};

use crate::auth;
use crate::config;
use crate::lobby::LOBBIES;
use crate::relay::{QuicPcmRelay, WtListener};
use crate::util::{jsonify, jsonify_status};

const QUIC_CERT_ROTATE_DAYS: u64 = 5; // re-roll well inside the validity window

/// hex sha-256 of the DER cert; set by make_identity()
static CERT_HASH_HEX: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static STARTED: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));

static AUDIO_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/lobby/([A-Za-z0-9]{6})/audio$").unwrap());

/// A fresh self-signed EC (P-256) cert, entirely in memory; updates the pinned hash.
fn make_identity() -> Result<Identity, String> {
    let now = time::OffsetDateTime::now_utc();
    let identity = Identity::self_signed_builder()
        .subject_alt_names(["localhost", "127.0.0.1"])
        .validity_period(now - time::Duration::minutes(5), now + time::Duration::days(config::QUIC_CERT_DAYS))
        .build()
        .map_err(|e| e.to_string())?;
    let cert = identity.certificate_chain().as_slice().first().ok_or("empty certificate chain")?;
    let hash: String = Sha256::digest(cert.der()).iter().map(|b| format!("{:02x}", b)).collect();
    *CERT_HASH_HEX.lock() = Some(hash);
    Ok(identity)
}

fn server_config(bind: SocketAddr, identity: Identity) -> Result<ServerConfig, String> {
    Ok(ServerConfig::builder()
        .with_bind_address(bind)
        .with_identity(identity)
        .max_idle_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| e.to_string())?
        .build())
}

fn hash_prefix() -> String {
    CERT_HASH_HEX.lock().as_ref().map(|h| h.chars().take(16).collect()).unwrap_or_default()
}

/// Starts the UDP/QUIC listener on the SAME PORT NUMBER as the HTTP server.
/// Failure is logged and swallowed — REST/Socket.IO/the frontend all work fine
/// without it; only live lobby audio depends on it.
pub async fn start_quic_server() {
    {
        let mut s = STARTED.lock();
        if *s {
            return;
        }
        *s = true;
    }
    let res: Result<(), String> = async {
        let bind: SocketAddr = format!("{}:{}", config::NOOBPLAYER_HOST, config::QUIC_PORT).parse().map_err(|e: std::net::AddrParseError| e.to_string())?;
        let identity = make_identity()?;
        let cert_hash = hash_prefix();
        let endpoint = Endpoint::server(server_config(bind, identity)?).map_err(|e| e.to_string())?;
        let endpoint = Arc::new(endpoint);
        tokio::spawn(cert_rotation_loop(endpoint.clone(), bind));
        tokio::spawn(accept_loop(endpoint));
        println!("[quic] WebTransport listener on udp://{}:{} (in-memory cert sha-256 {}…)", config::NOOBPLAYER_HOST, config::QUIC_PORT, cert_hash);
        Ok(())
    }
    .await;
    if let Err(e) = res {
        eprintln!("{e}");
        println!("[quic] failed to start the WebTransport listener — lobby audio will not work until this is fixed (is the UDP port already in use?)");
        *STARTED.lock() = false;
    }
}

/// Swaps in a fresh in-memory cert every QUIC_CERT_ROTATE_DAYS so a long-running
/// process never ends up serving an expired one. New connections pick up the new
/// cert; established sessions are unaffected.
async fn cert_rotation_loop(endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>, bind: SocketAddr) {
    loop {
        tokio::time::sleep(Duration::from_secs(QUIC_CERT_ROTATE_DAYS * 86400)).await;
        let r = make_identity().and_then(|id| server_config(bind, id)).and_then(|cfg| endpoint.reload_config(cfg, false).map_err(|e| e.to_string()));
        match r {
            Ok(()) => println!("[quic] rotated in-memory cert (sha-256 {}…)", hash_prefix()),
            Err(e) => eprintln!("{e}"),
        }
    }
}

async fn accept_loop(endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>) {
    loop {
        let incoming = endpoint.accept().await;
        tokio::spawn(async move {
            let Ok(req) = incoming.await else { return };
            handle_session(req).await;
        });
    }
}

/// One browser tab's WebTransport connection. Accepts exactly one request shape
/// (a CONNECT to /api/lobby/<code>/audio) and hands the session to that
/// lobby's relay as a new listener; nothing else is served here.
async fn handle_session(req: wtransport::endpoint::SessionRequest) {
    let full = req.path().to_string();
    let (path, query) = match full.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (full.clone(), String::new()),
    };
    if auth::password_set() {
        let tok = auth::url_pairs(&query).into_iter().find(|(k, v)| k == "token" && !v.is_empty()).map(|(_, v)| v);
        if !auth::token_ok(Some(tok.as_deref().unwrap_or(""))) {
            req.forbidden().await;
            return;
        }
    }
    let lobby = AUDIO_PATH_RE.captures(&path).and_then(|m| LOBBIES.lock().get(&m[1].to_uppercase()).cloned());
    let Some(lobby) = lobby else {
        req.not_found().await;
        return;
    };
    let Ok(conn) = req.accept().await else { return };

    // This session is one-way (server -> client audio only): ONE unidirectional
    // stream, opened right away, for the listener's entire time in the lobby.
    let mut stream = match conn.open_uni().await {
        Ok(opening) => match opening.await {
            Ok(s) => s,
            Err(_) => return,
        },
        Err(_) => return,
    };
    let listener = WtListener::new();
    let relay: Arc<QuicPcmRelay> = lobby.relay.audio_out.clone();
    relay.add_listener(listener.clone());
    println!("[quic {}] listener connected ({} total)", lobby.code(), relay.listener_count());

    let l2 = listener.clone();
    let writer = async {
        while let Some(chunk) = l2.next().await {
            if stream.write_all(&chunk).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = writer => {}
        _ = conn.closed() => {}
    }
    relay.remove_listener(&listener);
}

/// GET /api/quic-info — everything a browser needs to open a lobby's WebTransport
/// session itself: the UDP port, and the self-signed cert's hash to pin.
pub async fn quic_info() -> Response {
    let hash = CERT_HASH_HEX.lock().clone();
    let Some(hash) = hash else {
        return jsonify_status(json!({"error": "QUIC listener not ready yet — try again in a moment"}), 503);
    };
    let host = if config::QUIC_PUBLIC_IP.is_empty() { serde_json::Value::Null } else { json!(config::QUIC_PUBLIC_IP) };
    jsonify(json!({
        "port": config::QUIC_PORT,
        "certHashHex": hash,
        "path": "/api/lobby/{code}/audio",
        "host": host,
    }))
}
