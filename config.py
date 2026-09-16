"""
Configuration for the NodeLink lobby server.

Set your NodeLink node's credentials here. The Flask server proxies all
NodeLink API calls (search, stream, lyrics, chapters, meaning) using these
credentials, so browser clients in Server Mode never need to know them.
"""

# ── NodeLink node ──
NODELINK_HOST = "https://nodelink.gdjkhp.com:443"
NODELINK_PASSWORD = "youshallnotpass"

# ── Flask server ──
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 42069
DEBUG = True

# ── WebRTC ──
# STUN server used for ICE gathering. A public Google STUN server works for
# most home/office networks. For clients behind symmetric NATs you may need
# a TURN server as well (not configured here).
ICE_SERVERS = ["stun:stun.l.google.com:19302"]

# ── Lobbies ──
LOBBY_CODE_LENGTH = 6
CHAT_HISTORY_LIMIT = 100

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