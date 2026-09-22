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

# ── Lobby music transport (HLS) ──
# Lobby mode's shared music relay is delivered as a live HLS stream (AAC,
# short rolling segments) — see HLSMuxer / LobbyRelay in server.py. No
# STUN/TURN needed: it's just an <audio> element pointed at a .m3u8 URL
# over plain HTTP.

# Segment length in seconds. Shorter = listeners sit closer to the live
# edge, at the cost of more segment files and a bit more HTTP overhead.
# 1s is a reasonable floor without moving to LL-HLS (partial segments) —
# see the module docstring in server.py for why true sub-second latency
# needs more than this.
HLS_SEGMENT_SECONDS = 1

# How many segments stay listed in the rolling playlist (and on disk —
# older ones are deleted automatically). Also roughly how many segments
# a player buffers before it starts, so end-to-end lag is on the order of
# HLS_SEGMENT_SECONDS * (HLS_LIST_SIZE + 1).
HLS_LIST_SIZE = 6

# AAC encode bitrate for the live relay (bits/sec).
HLS_BITRATE = 128000

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