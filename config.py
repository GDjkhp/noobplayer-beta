"""
Configuration for the NodeLink lobby server.

Set your NodeLink node's credentials here. The Flask server proxies all
NodeLink API calls (search, stream, lyrics, meaning) using these
credentials, so browser clients in Server Mode never need to know them.
"""

# ── NodeLink node ──
NODELINK_HOST = "https://nodelink.gdjkhp.com:443"
NODELINK_PASSWORD = "youshallnotpass"

# ── Flask server ──
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 42069
DEBUG = True

# ── Lobby music transport (QUIC / WebTransport) ──
# Lobby mode's shared music relay is delivered as a live raw-PCM stream
# over a QUIC/WebTransport session — see QuicPcmRelay / WtListener /
# LobbyQuicProtocol in server.py. No AAC encode, no container, no CDN-
# cacheable playlist the way HLS had: each listener's browser opens one
# WebTransport connection and gets the same 48kHz/stereo/s16le frames
# the relay produces, written straight onto its own QUIC stream.
#
# This DOES need a TLS handshake (QUIC always does), unlike the old HLS
# design's plain HTTP <audio> element — see the cert note
# below. The WebTransport listener runs as its own UDP server, on the
# SAME PORT NUMBER as FLASK_PORT above (TCP and UDP are independent
# port namespaces, so this never conflicts with the HTTP server — it's
# just one port number to open/forward instead of two).
QUIC_PORT = FLASK_PORT

# Opus bitrate (bits/sec) for the live lobby stream. Raw PCM was ~1536 kbps
# per listener; Opus at 160 kbps is ~10x smaller and, because the source
# tracks are already lossy (YouTube/SoundCloud etc. are Opus/AAC at
# roughly 128-256 kbps), is effectively transparent. Raise it (192000-
# 256000) if you want extra headroom for high-bitrate sources; lower it
# (96000-128000) to save more. Encoded once per lobby, not per listener.
QUIC_OPUS_BITRATE = 160000

# The IP address browsers should actually open the WebTransport session
# to, when this deployment sits behind a real domain name (like a
# Hostinger VPS fronted by Traefik/DNS — NODELINK_HOST above being a
# hostname is exactly this situation).
#
# WebTransport's serverCertificateHashes pinning (see the cert note
# below) is ONLY accepted by browsers when the connection URL's host is
# an IP literal, never a hostname — even one that resolves to the right
# server. api.js's LobbyAPI.quicUrl already special-cases "localhost" to
# 127.0.0.1 for local dev, but has no way to resolve an arbitrary
# hostname from the browser, so on a real domain it refuses the
# handshake with "can't open a pinned WebTransport session to
# '<hostname>'" rather than connecting somewhere that would just fail
# anyway.
#
# Set this to the server's public IPv4/IPv6 address to fix that — the
# client will use it for the WebTransport connection specifically while
# everything else (the REST API, Socket.IO) keeps using NODELINK_HOST /
# whatever domain the page was loaded from.
#
# Leave this empty (the default) for local dev, or if you've swapped
# the in-memory cert for a real CA-signed certificate —
# that removes the need for pinning (and this IP) entirely, and the
# client will connect by hostname instead once serverCertificateHashes
# is dropped there too.
QUIC_PUBLIC_IP = "187.127.124.78"

# The WebTransport listener's self-signed cert is generated in memory at
# startup — nothing is written to disk, nothing to set up by hand. The
# browser trusts it via WebTransport's serverCertificateHashes pinning
# (the client fetches the current hash from GET /api/quic-info) rather
# than a real CA chain. It's re-rolled in the background every few days
# while the server runs (see _quic_cert_rotation_loop in server.py).

# How long (days) each generated cert stays valid. WebTransport's serverCertificateHashes pinning REQUIRES a
# validity window of 14 days or less (see the WebTransport spec) — this
# just needs to be comfortably under that; going all the way to 14 risks
# briefly serving an already-expired cert if the server happens to be
# offline right at the boundary.
QUIC_CERT_DAYS = 12

# ── Lobbies ──
LOBBY_CODE_LENGTH = 6

# Saved sessions (self-heal / "Saved Sessions" card): the host's browser keeps
# a snapshot of the lobby and, after a server restart, asks the server to
# rebuild it under the same code. This caps how many queued tracks a restore
# request may carry, so a hostile or corrupted snapshot can't bloat memory.
RESTORE_MAX_QUEUE = 9999

# ── Recommendations / autoplay ──
# Autoplay and Smart Shuffle ask the node for tracks similar to whatever is
# playing. Only some sources support that: YouTube/YouTube Music (via the
# RD... radio playlist) and Spotify/Deezer/Tidal/JioSaavn (via the *rec:
# search prefixes their LavaSrc plugins expose).
#
# For everything else — SoundCloud, Bandcamp, direct file URLs — there is no
# recommendation API at all. With this on, those fall back to a plain
# YouTube Music search for the track's artist, which keeps autoplay alive at
# the cost of looser picks. Turn it off to have autoplay simply stop rather
# than guess.
RECOMMEND_FALLBACK_SEARCH = True

# How long (seconds) a dropped SSE connection is given to reconnect before
# the participant is treated as having actually left. Covers EventSource's
# own auto-retry and brief network blips without wrongly evicting someone
# or handing off the host mid-session over a hiccup.
#
# Kept generous (not just a few seconds) because mobile browsers throttle
# or fully suspend background-tab network connections on screen lock /
# app switch, and won't reconnect until the tab is foregrounded again.
# A short grace period here tears the whole lobby down under completely
# normal usage (someone locks their phone for a bit) the moment the last
# active participant's stream drops.
DISCONNECT_GRACE_SECONDS = 120

# ── Exact seeking (lobby mode) ──
# NodeLink's /v4/loadstream `position` isn't sample-exact for every source,
# so a seek could start the audio a bit before/after the requested time
# while the progress bar and synced lyrics assumed it was exact. With this
# on, the server downloads each track ONCE from position 0 into memory and
# seeks by byte offset (48kHz stereo s16le = 192000 bytes/sec), which is
# sample-exact and makes seeks within the downloaded part instant.
#
# Cost: ~11.5 MB of RAM per minute of audio, for the current track (plus
# the gapless-preloaded next track, same as before).
SEEK_CACHE_ENABLED = True

# Tracks longer than this (seconds), and live streams, skip the cache and
# use the old live NodeLink `position` seek instead. 900s (15 min) ~= 170 MB.
SEEK_CACHE_MAX_SECONDS = 900

# A seek past what has been downloaded waits for the download to reach it.
# If, at the measured download speed, that would take longer than this many
# seconds, the server plays live from NodeLink at `position` instead (the
# old, less exact behaviour) rather than leaving listeners in silence.
SEEK_CACHE_WAIT_SECONDS = 6