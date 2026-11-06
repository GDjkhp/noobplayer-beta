//! NodeLink lobby server — Rust port of server.py (Quart + python-socketio).

mod analysis;
mod api;
mod auth;
mod config;
mod download;
mod gallery;
mod lobby;
mod nodelink;
mod opus;
mod pool;
mod quic;
mod relay;
mod sio;
mod static_files;
mod util;

use std::path::PathBuf;

use axum::http::{header, HeaderName, Method};
use axum::routing::{get, post};
use axum::{middleware, Router};
use socketioxide::SocketIo;
use tower_http::cors::{Any, CorsLayer};

fn project_root() -> PathBuf {
    if let Ok(r) = std::env::var("NOOBPLAYER_ROOT") {
        if !r.is_empty() {
            return PathBuf::from(r);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn router() -> Router {
    use static_files::method_fallback as fb;
    let lobby = |p: &str| format!("/api/lobby/{{code}}/{p}");

    Router::new()
        .route("/", get(static_files::index).fallback(fb))
        .route("/README.md", get(static_files::readme).fallback(fb))
        .route("/robots.txt", get(static_files::robots).fallback(fb))
        .route("/api/auth/status", get(auth::auth_status).fallback(fb))
        .route("/api/auth/login", post(auth::auth_login).fallback(fb))
        .route("/api/quic-info", get(quic::quic_info).fallback(fb))
        .route("/api/nodelink/info", get(nodelink::nl_info).fallback(fb))
        .route("/api/nodelink/loadtracks", get(nodelink::nl_loadtracks).fallback(fb))
        .route("/api/nodelink/loadlyrics", get(nodelink::nl_loadlyrics).fallback(fb))
        .route("/api/nodelink/meaning", get(nodelink::nl_meaning).fallback(fb))
        .route("/api/nodelink/loadstream", post(nodelink::nl_loadstream).fallback(fb))
        .route("/api/download", get(download::download_track).fallback(fb))
        .route("/api/lobby/create", post(api::create_lobby).fallback(fb))
        .route("/api/lobby/join", post(api::join_lobby).fallback(fb))
        .route("/api/lobby/public", get(api::list_public).fallback(fb))
        .route("/api/lobby/rejoin", post(api::rejoin_lobby).fallback(fb))
        .route("/api/lobby/restore", post(api::restore_lobby).fallback(fb))
        .route(&lobby("leave"), post(api::leave_lobby).fallback(fb))
        .route(&lobby("chat"), post(api::post_chat).fallback(fb))
        .route(&lobby("history"), get(api::lobby_history).fallback(fb))
        .route(&lobby("analysis"), get(api::lobby_analysis).fallback(fb))
        .route(&lobby("play"), post(api::lobby_play).fallback(fb))
        .route(&lobby("pause"), post(api::lobby_pause).fallback(fb))
        .route(&lobby("resume"), post(api::lobby_resume).fallback(fb))
        .route(&lobby("seek"), post(api::lobby_seek).fallback(fb))
        .route(&lobby("skip"), post(api::lobby_skip).fallback(fb))
        .route(&lobby("stop"), post(api::lobby_stop).fallback(fb))
        .route(&lobby("prev"), post(api::lobby_prev).fallback(fb))
        .route(&lobby("clear_history"), post(api::lobby_clear_history).fallback(fb))
        .route(&lobby("loop"), post(api::lobby_loop).fallback(fb))
        .route(&lobby("autoplay"), post(api::lobby_autoplay).fallback(fb))
        .route(&lobby("gapless"), post(api::lobby_gapless).fallback(fb))
        .route(&lobby("dj"), post(api::lobby_dj).fallback(fb))
        .route(&lobby("kick"), post(api::lobby_kick).fallback(fb))
        .route(&lobby("ban"), post(api::lobby_ban).fallback(fb))
        .route(&lobby("unban"), post(api::lobby_unban).fallback(fb))
        .route(&lobby("banned"), get(api::lobby_banned).fallback(fb))
        .route(&lobby("settings"), post(api::lobby_settings).fallback(fb))
        .route(&lobby("code"), post(api::lobby_change_code).fallback(fb))
        .route(&lobby("rename"), post(api::lobby_rename).fallback(fb))
        .route(&lobby("queue/add"), post(api::lobby_queue_add).fallback(fb))
        .route(&lobby("queue/add_bulk"), post(api::lobby_queue_add_bulk).fallback(fb))
        .route(&lobby("queue/remove"), post(api::lobby_queue_remove).fallback(fb))
        .route(&lobby("queue/shuffle"), post(api::lobby_queue_shuffle).fallback(fb))
        .route(&lobby("queue/clear"), post(api::lobby_queue_clear).fallback(fb))
        .route(&lobby("queue/smart"), post(api::lobby_queue_smart).fallback(fb))
        .route(&lobby("fair"), post(api::lobby_fair).fallback(fb))
        .route(&lobby("queue/move"), post(api::lobby_queue_move).fallback(fb))
        .route("/api/skins", get(gallery::skins_list).post(gallery::skin_publish).fallback(fb))
        .route("/api/skins/{sid}", get(gallery::skin_get).fallback(fb))
        .route("/api/skins/{sid}/delete", post(gallery::skin_delete).fallback(fb))
        .route("/api/skins/{sid}/install", post(gallery::skin_install).fallback(fb))
        .route("/api/visualizers", get(gallery::viz_list).post(gallery::viz_publish).fallback(fb))
        .route("/api/visualizers/{vid}", get(gallery::viz_get).fallback(fb))
        .route("/api/visualizers/{vid}/delete", post(gallery::viz_delete).fallback(fb))
        .route("/api/visualizers/{vid}/install", post(gallery::viz_install).fallback(fb))
        .route("/{*path}", get(static_files::catch_all).fallback(fb))
        .fallback(fb)
        .layer(middleware::from_fn(auth::require_password))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([header::CONTENT_TYPE, HeaderName::from_static("x-noobplayer-token")])
                .expose_headers([header::CONTENT_LENGTH, header::CONTENT_DISPOSITION]),
        )
}

#[tokio::main]
async fn main() {
    let root = project_root();
    let _ = dotenvy::from_path(root.join(".env"));

    let nl_host = std::env::var("NODELINK_HOST").unwrap_or_default().trim().trim_end_matches('/').to_string();
    let nl_pass = std::env::var("NODELINK_PASSWORD").unwrap_or_default();
    let np_pass = std::env::var("NOOBPLAYER_PASSWORD").unwrap_or_default();
    if nl_host.is_empty() || nl_pass.is_empty() {
        eprintln!(
            "Missing NodeLink credentials: set NODELINK_HOST and NODELINK_PASSWORD in the .env file next to server.py (see .env.example)."
        );
        std::process::exit(1);
    }

    auth::init(np_pass.clone());
    nodelink::init(nl_host.clone(), nl_pass);
    static_files::init(root);
    gallery::load_all();

    let (layer, io) = SocketIo::new_layer();
    sio::init(io);
    let app = router().layer(layer);

    // Fire-and-forget: a QUIC failure is logged, never fatal.
    tokio::spawn(quic::start_quic_server());
    if analysis::AVAILABLE && config::AUDIO_ANALYSIS_PREWARM {
        if let Err(e) = pool::get_pool() {
            eprintln!("{e}");
        }
    }

    println!("[NodeLink Lobby Server] NodeLink node: {nl_host}");
    println!(
        "[NodeLink Lobby Server] Lobby music transport: raw PCM over QUIC/WebTransport (udp/{})",
        config::QUIC_PORT
    );
    println!("[NodeLink Lobby Server] Realtime transport: Socket.IO (WebSocket, long-polling fallback)");
    println!(
        "[NodeLink Lobby Server] Listening on http://{}:{}{}",
        config::NOOBPLAYER_HOST,
        config::NOOBPLAYER_PORT,
        if np_pass.is_empty() { "" } else { "  (password protected)" }
    );

    let listener = match tokio::net::TcpListener::bind((config::NOOBPLAYER_HOST, config::NOOBPLAYER_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error while attempting to bind on address: {e}");
            std::process::exit(1);
        }
    };
    let _ = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await;
    pool::shutdown();
}
