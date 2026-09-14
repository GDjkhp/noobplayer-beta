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
DEBUG = False

# ── WebRTC ──
# STUN server used for ICE gathering. A public Google STUN server works for
# most home/office networks. For clients behind symmetric NATs you may need
# a TURN server as well (not configured here).
ICE_SERVERS = ["stun:stun.l.google.com:19302"]

# ── Lobbies ──
LOBBY_CODE_LENGTH = 6
CHAT_HISTORY_LIMIT = 100
