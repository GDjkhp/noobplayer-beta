//! Configuration for the NodeLink lobby server (port of config.py).
//!
//! NodeLink credentials (NODELINK_HOST / NODELINK_PASSWORD) are NOT set here —
//! they live in the .env file next to the project root (copy .env.example to
//! .env). The server proxies all NodeLink API calls (search, stream, lyrics,
//! meaning) using them, so browser clients in Server Mode never need to know
//! them.
//!
//! The optional noobplayer server password is not set here either: add
//! NOOBPLAYER_PASSWORD=... to the same .env file. Leave it out (or empty) for
//! an open server; with it set, the site shows a password window before
//! anything works.

// ── noobplayer server ──
pub const NOOBPLAYER_HOST: &str = "0.0.0.0";
pub const NOOBPLAYER_PORT: u16 = 42069;
#[allow(dead_code)]
pub const DEBUG: bool = true;

// ── Lobby music transport (QUIC / WebTransport) ──
// Lobby mode's shared music relay is a live Opus stream over a
// QUIC/WebTransport session (see QuicPcmRelay / the WebTransport listener in
// quic.rs). The WebTransport listener runs as its own UDP server, on the SAME
// PORT NUMBER as NOOBPLAYER_PORT.
pub const QUIC_PORT: u16 = NOOBPLAYER_PORT;

/// Opus bitrate (bits/sec) for the live lobby stream. Encoded once per lobby,
/// not per listener.
pub const QUIC_OPUS_BITRATE: i32 = 160000;

/// The IP address browsers should actually open the WebTransport session to,
/// when this deployment sits behind a real domain name. WebTransport's
/// serverCertificateHashes pinning is ONLY accepted by browsers when the
/// connection URL's host is an IP literal, never a hostname. Set this to the
/// server's public IPv4/IPv6 address. Leave it empty for local dev.
pub const QUIC_PUBLIC_IP: &str = "187.127.124.78";

/// How long (days) each generated cert stays valid. WebTransport's
/// serverCertificateHashes pinning REQUIRES a validity window of 14 days or
/// less.
pub const QUIC_CERT_DAYS: i64 = 12;

// ── Lobbies ──
pub const LOBBY_CODE_LENGTH: usize = 6;

/// Caps how many queued tracks a restore request may carry, so a hostile or
/// corrupted snapshot can't bloat memory.
pub const RESTORE_MAX_QUEUE: usize = 9999;

// ── Recommendations / autoplay ──
/// For sources with no recommendation API (SoundCloud, Bandcamp, direct URLs)
/// fall back to a plain YouTube Music search for the track's artist.
pub const RECOMMEND_FALLBACK_SEARCH: bool = true;

/// How long (seconds) a dropped Socket.IO connection is given to reconnect
/// before the participant is treated as having actually left.
pub const DISCONNECT_GRACE_SECONDS: u64 = 120;

// ── Exact seeking (lobby mode) ──
// With this on, the server downloads each track ONCE from position 0 into
// memory and seeks by byte offset (48kHz stereo s16le = 192000 bytes/sec).
pub const SEEK_CACHE_ENABLED: bool = true;

/// Tracks longer than this (seconds), and live streams, skip the cache and use
/// the live NodeLink `position` seek instead.
pub const SEEK_CACHE_MAX_SECONDS: f64 = 900.0;

/// A seek past what has been downloaded waits for the download to reach it. If,
/// at the measured download speed, that would take longer than this many
/// seconds, the server plays live from NodeLink at `position` instead.
pub const SEEK_CACHE_WAIT_SECONDS: f64 = 6.0;

// Lobby passwords
pub const LOBBY_PASSWORD_MAX: usize = 32; // max characters
pub const PASSWORD_MAX_FAILS: usize = 8; // wrong guesses allowed per (client IP, lobby)...
pub const PASSWORD_FAIL_WINDOW: f64 = 60.0; // ...within this many seconds, then 429 until it cools off

// ── Music analysis (Debug tab › "Audio analysis", lobby mode only) ──
/// Master switch. False = nothing is analysed and playback is never held back;
/// the Debug card just says "disabled in server config".
pub const AUDIO_ANALYSIS_ENABLED: bool = true;

/// Hold the first audio frame of a track until its BPM / beat grid is ready (at
/// most AUDIO_ANALYSIS_GATE_SECONDS, then it plays anyway).
pub const AUDIO_ANALYSIS_GATE_PLAYBACK: bool = true;
pub const AUDIO_ANALYSIS_GATE_SECONDS: f64 = 3.0;

/// Where the analysis runs: dedicated low-priority worker threads (keeps the
/// 20 ms relay pacing loop free) or, with false, the runtime's blocking pool.
pub const AUDIO_ANALYSIS_USE_PROCESS: bool = true;
pub const AUDIO_ANALYSIS_WORKERS: usize = 2; // worker threads
#[allow(dead_code)]
pub const AUDIO_ANALYSIS_THREADS: usize = 2; // (BLAS threads per worker in the Python version; unused here)
pub const AUDIO_ANALYSIS_PREWARM: bool = true; // start the workers at server start
/// Replace each worker after this many jobs (0 = never). Worker threads do not
/// accumulate interpreter state, so this is accepted for parity and ignored.
#[allow(dead_code)]
pub const AUDIO_ANALYSIS_RECYCLE_TASKS: usize = 0;
/// Return freed heap pages to the OS after each analysis (glibc only).
pub const AUDIO_ANALYSIS_TRIM_SERVER: bool = true;
