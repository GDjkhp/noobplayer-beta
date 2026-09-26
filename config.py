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
# design's plain HTTP <audio> element — see QUIC_CERT_FILE/QUIC_KEY_FILE
# below. The WebTransport listener runs as its own UDP server, on the
# SAME PORT NUMBER as FLASK_PORT above (TCP and UDP are independent
# port namespaces, so this never conflicts with the HTTP server — it's
# just one port number to open/forward instead of two).
QUIC_PORT = FLASK_PORT

# Self-signed cert for the WebTransport listener — regenerated
# automatically by server.py whenever it's missing or close to expiry,
# nothing to set up by hand. The browser trusts it via WebTransport's
# serverCertificateHashes pinning (the client fetches the current hash
# from GET /api/quic-info) rather than a real CA chain, which is why
# this can just be a throwaway self-signed cert instead of something
# from Let's Encrypt or similar.
QUIC_CERT_FILE = "quic_cert.pem"
QUIC_KEY_FILE = "quic_key.pem"

# How long (days) each generated cert stays valid before server.py
# rotates it. WebTransport's serverCertificateHashes pinning REQUIRES a
# validity window of 14 days or less (see the WebTransport spec) — this
# just needs to be comfortably under that; going all the way to 14 risks
# briefly serving an already-expired cert if the server happens to be
# offline right at the boundary.
QUIC_CERT_DAYS = 12

# ── Lobbies ──
LOBBY_CODE_LENGTH = 6
CHAT_HISTORY_LIMIT = 100

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