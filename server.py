"""
NodeLink Lobby Server (Quart / async)
======================================
Async backend for "Server Mode" — lets multiple browser clients join a
shared lobby, listen to the same music in sync, text chat, and talk over
voice (mixed server-side via aiortc).

Why Quart instead of Flask
---------------------------
aiortc is asyncio-native. Flask is sync/WSGI, which means every aiortc call
(setRemoteDescription, createAnswer, closing peer connections, etc.) has to
be bounced onto a separate asyncio event loop running in a background
thread. Quart is an async-first, (mostly) drop-in replacement for Flask —
routes are `async def`, and aiortc coroutines can be `await`-ed directly
inside a request handler. No thread bridge, no run_coroutine_threadsafe.
It also streams Server-Sent Events and the NodeLink PCM proxy natively via
async generators, which suits this app well.

Architecture
------------
- Music playback: the server holds *authoritative* playback state per lobby
  (current track, paused/playing, a position anchor + server timestamp,
  active filters, queue). It does NOT relay audio bytes for music — each
  connected client independently streams identical PCM from NodeLink via
  the /api/nodelink/loadstream proxy below, computing the correct start
  position from the broadcast anchor so everyone stays in sync. Bandwidth
  stays flat regardless of listener count.

- State sync + chat: pushed to clients over Server-Sent Events, using an
  asyncio.Queue per subscriber.

- Voice chat: real audio, so it goes over WebRTC (aiortc). Each client
  opens ONE RTCPeerConnection to the server carrying their mic (send) and
  receiving a personalized *mixed* track (server sums every other
  participant's audio for them, live). New participants are simply
  included in everyone's mix on the fly — no renegotiation needed.

Run (dev)
---------
    pip install -r requirements.txt
    python server.py

Run (production, recommended)
------------------------------
    hypercorn server:app --bind 0.0.0.0:5000

Then open http://localhost:5000 — this process serves both the API and the
static frontend, so "use this server (default)" works with zero extra
configuration.
"""

import asyncio
import fractions
import json
import random
import string
import time
import uuid
from pathlib import Path

import aiohttp
import numpy as np
from quart import Quart, Response, jsonify, request, send_from_directory
from quart_cors import cors

import config

try:
    import av
    from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
    from aiortc.contrib.media import MediaRelay
    WEBRTC_AVAILABLE = True
except ImportError:
    WEBRTC_AVAILABLE = False
    print("[!] aiortc/av not installed — voice chat will be disabled. Run: pip install aiortc av numpy")

# ═══════════════════════════════════════════════════════════════════
# App setup
# ═══════════════════════════════════════════════════════════════════
STATIC_DIR = Path(__file__).resolve().parent.parent  # project root (index.html lives here)

app = Quart(__name__, static_folder=None)
app = cors(app, allow_origin="*", allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"])

NL_HOST = config.NODELINK_HOST.rstrip("/")
NL_PASS = config.NODELINK_PASSWORD

http_session: aiohttp.ClientSession | None = None


@app.before_serving
async def startup():
    global http_session
    http_session = aiohttp.ClientSession()


@app.after_serving
async def shutdown():
    if http_session:
        await http_session.close()


relay = MediaRelay() if WEBRTC_AVAILABLE else None

# ═══════════════════════════════════════════════════════════════════
# Mixed audio track — one instance per listener, sums every OTHER
# participant's relayed mic track live. Avoids renegotiation when
# people join/leave: the source list is read fresh on every recv().
# ═══════════════════════════════════════════════════════════════════
if WEBRTC_AVAILABLE:

    class MixedAudioTrack(MediaStreamTrack):
        kind = "audio"

        def __init__(self, sources_getter, exclude_id):
            super().__init__()
            self.sources_getter = sources_getter  # callable -> dict[client_id] -> relayed track
            self.exclude_id = exclude_id
            self._ts = 0
            self._rate = 48000
            self._samples = 960  # 20ms @ 48kHz

        async def recv(self):
            pts, time_base = self._ts, fractions.Fraction(1, self._rate)
            self._ts += self._samples

            sources = [t for cid, t in self.sources_getter().items() if cid != self.exclude_id and t is not None]

            if not sources:
                return self._silence(pts, time_base)

            frames = []
            for t in sources:
                try:
                    f = await asyncio.wait_for(t.recv(), timeout=0.06)
                    frames.append(f)
                except Exception:
                    pass

            if not frames:
                return self._silence(pts, time_base)

            mixed = None
            for f in frames:
                arr = f.to_ndarray().astype(np.int32)
                if arr.ndim == 1:
                    arr = arr.reshape(1, -1)
                if mixed is None:
                    mixed = arr
                else:
                    n = min(mixed.shape[-1], arr.shape[-1])
                    mixed = mixed[..., :n] + arr[..., :n]

            mixed = np.clip(mixed, -32768, 32767).astype(np.int16)
            layout = "mono" if mixed.shape[0] == 1 else "stereo"
            new_frame = av.AudioFrame.from_ndarray(mixed, format="s16", layout=layout)
            new_frame.sample_rate = self._rate
            new_frame.pts = pts
            new_frame.time_base = time_base
            return new_frame

        def _silence(self, pts, time_base):
            frame = av.AudioFrame(format="s16", layout="mono", samples=self._samples)
            for p in frame.planes:
                p.update(bytes(p.buffer_size))
            frame.pts = pts
            frame.sample_rate = self._rate
            frame.time_base = time_base
            return frame


# ═══════════════════════════════════════════════════════════════════
# Lobby data model (in-memory)
#
# Everything here runs on a single asyncio event loop (Quart's), so plain
# dict mutations between `await` points are atomic — no threading.Lock
# needed like the Flask/background-thread version required.
# ═══════════════════════════════════════════════════════════════════
class Participant:
    def __init__(self, pid, name):
        self.id = pid
        self.name = name
        self.pc = None          # RTCPeerConnection
        self.mic_track = None   # relayed incoming mic track


class Lobby:
    def __init__(self, code, name, is_public, host_id):
        self.code = code
        self.name = name
        self.is_public = is_public
        self.host_id = host_id
        self.participants = {}   # client_id -> Participant
        self.subscribers = {}    # client_id -> asyncio.Queue (SSE)
        self.queue = []          # list of track dicts
        self.current_track = None
        self.paused = True
        self.position_anchor_ms = 0
        self.anchor_time = time.time()
        self.filters = {}
        self.chat = []
        self.created_at = time.time()

    def current_position_ms(self):
        if self.paused or not self.current_track:
            return self.position_anchor_ms
        elapsed = (time.time() - self.anchor_time) * 1000
        return self.position_anchor_ms + elapsed

    def public_state(self):
        return {
            "code": self.code,
            "name": self.name,
            "isPublic": self.is_public,
            "hostId": self.host_id,
            "currentTrack": self.current_track,
            "paused": self.paused,
            "positionMs": self.current_position_ms(),
            "queue": self.queue,
            "filters": self.filters,
        }

    def participant_list(self):
        return [{"id": p.id, "name": p.name, "isHost": p.id == self.host_id} for p in self.participants.values()]


LOBBIES = {}


def gen_code():
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=config.LOBBY_CODE_LENGTH))
        if code not in LOBBIES:
            return code


def get_lobby_or_404(code):
    return LOBBIES.get((code or "").upper())


def sse_format(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def broadcast(lobby, event, data):
    msg = sse_format(event, data)
    for q in list(lobby.subscribers.values()):
        q.put_nowait(msg)


# ═══════════════════════════════════════════════════════════════════
# Static frontend
# ═══════════════════════════════════════════════════════════════════
@app.route("/")
async def index():
    return await send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:path>")
async def static_files(path):
    return await send_from_directory(STATIC_DIR, path)


# ═══════════════════════════════════════════════════════════════════
# NodeLink proxy (keeps NODELINK_PASSWORD server-side only)
# ═══════════════════════════════════════════════════════════════════
@app.route("/api/nodelink/info")
async def nl_info():
    async with http_session.get(f"{NL_HOST}/v4/info", headers={"Authorization": NL_PASS}) as r:
        body = await r.read()
        return Response(body, status=r.status, mimetype="application/json")


@app.route("/api/nodelink/loadtracks")
async def nl_loadtracks():
    identifier = request.args.get("identifier", "")
    async with http_session.get(f"{NL_HOST}/v4/loadtracks", params={"identifier": identifier},
                                 headers={"Authorization": NL_PASS}) as r:
        body = await r.read()
        return Response(body, status=r.status, mimetype="application/json")


@app.route("/api/nodelink/loadlyrics")
async def nl_loadlyrics():
    et = request.args.get("encodedTrack", "")
    async with http_session.get(f"{NL_HOST}/v4/loadlyrics", params={"encodedTrack": et},
                                 headers={"Authorization": NL_PASS}) as r:
        body = await r.read()
        return Response(body, status=r.status, mimetype="application/json")


@app.route("/api/nodelink/loadchapters")
async def nl_loadchapters():
    et = request.args.get("encodedTrack", "")
    async with http_session.get(f"{NL_HOST}/v4/loadchapters", params={"encodedTrack": et},
                                 headers={"Authorization": NL_PASS}) as r:
        body = await r.read()
        return Response(body, status=r.status, mimetype="application/json")


@app.route("/api/nodelink/meaning")
async def nl_meaning():
    et = request.args.get("encodedTrack", "")
    async with http_session.get(f"{NL_HOST}/v4/meaning", params={"encodedTrack": et},
                                 headers={"Authorization": NL_PASS}) as r:
        body = await r.read()
        return Response(body, status=r.status, mimetype="application/json")


@app.route("/api/nodelink/loadstream", methods=["POST"])
async def nl_loadstream():
    data = await request.get_json(force=True, silent=True) or {}

    async def gen():
        async with http_session.post(f"{NL_HOST}/v4/loadstream", json=data,
                                      headers={"Authorization": NL_PASS}) as r:
            async for chunk in r.content.iter_chunked(8192):
                if chunk:
                    yield chunk

    return Response(gen(), mimetype="application/octet-stream")


# ═══════════════════════════════════════════════════════════════════
# Lobby REST API
# ═══════════════════════════════════════════════════════════════════
@app.route("/api/lobby/create", methods=["POST"])
async def create_lobby():
    data = await request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "Untitled Lobby")[:40]
    is_public = bool(data.get("isPublic", False))
    display_name = (data.get("displayName") or "Guest")[:24]

    code = gen_code()
    client_id = uuid.uuid4().hex
    lobby = Lobby(code, name, is_public, client_id)
    lobby.participants[client_id] = Participant(client_id, display_name)
    LOBBIES[code] = lobby

    return jsonify({"code": code, "clientId": client_id, "isHost": True})


@app.route("/api/lobby/join", methods=["POST"])
async def join_lobby():
    data = await request.get_json(force=True, silent=True) or {}
    code = (data.get("code") or "").upper().strip()
    display_name = (data.get("displayName") or "Guest")[:24]

    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "Lobby not found"}), 404

    client_id = uuid.uuid4().hex
    lobby.participants[client_id] = Participant(client_id, display_name)
    state = lobby.public_state()
    plist = lobby.participant_list()

    broadcast(lobby, "participants", plist)
    broadcast(lobby, "chat", {"system": True, "text": f"{display_name} joined", "ts": time.time() * 1000})

    return jsonify({"code": code, "clientId": client_id, "isHost": False, "state": state})


@app.route("/api/lobby/public")
async def list_public():
    out = [
        {"code": l.code, "name": l.name, "participants": len(l.participants)}
        for l in LOBBIES.values() if l.is_public
    ]
    return jsonify(out)


@app.route("/api/lobby/<code>/leave", methods=["POST"])
async def leave_lobby(code):
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    lobby = get_lobby_or_404(code)
    if lobby and client_id in lobby.participants:
        p = lobby.participants.pop(client_id, None)
        lobby.subscribers.pop(client_id, None)
        if p and p.pc:
            await p.pc.close()
        if lobby.host_id == client_id and lobby.participants:
            lobby.host_id = next(iter(lobby.participants))

        if p:
            broadcast(lobby, "participants", lobby.participant_list())
            broadcast(lobby, "chat", {"system": True, "text": f"{p.name} left", "ts": time.time() * 1000})
        if not lobby.participants:
            LOBBIES.pop(code.upper(), None)
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/events")
async def lobby_events(code):
    client_id = request.args.get("clientId")
    lobby = get_lobby_or_404(code)
    if not lobby or client_id not in lobby.participants:
        return jsonify({"error": "not in lobby"}), 404

    q = asyncio.Queue()
    lobby.subscribers[client_id] = q

    async def gen():
        try:
            yield sse_format("state", lobby.public_state()).encode()
            yield sse_format("participants", lobby.participant_list()).encode()
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield msg.encode()
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
        finally:
            lobby.subscribers.pop(client_id, None)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/lobby/<code>/chat", methods=["POST"])
async def post_chat(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    p = lobby.participants.get(client_id)
    if not p:
        return jsonify({"error": "not in lobby"}), 403
    msg = {"id": uuid.uuid4().hex, "name": p.name, "text": str(data.get("text", ""))[:500], "ts": time.time() * 1000}
    lobby.chat.append(msg)
    lobby.chat = lobby.chat[-config.CHAT_HISTORY_LIMIT:]
    broadcast(lobby, "chat", msg)
    return jsonify({"ok": True})


def _require_host(lobby, client_id):
    return lobby.host_id == client_id


@app.route("/api/lobby/<code>/play", methods=["POST"])
async def lobby_play(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.current_track = data.get("track")
    lobby.paused = False
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/pause", methods=["POST"])
async def lobby_pause(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.position_anchor_ms = lobby.current_position_ms()
    lobby.paused = True
    lobby.anchor_time = time.time()
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/resume", methods=["POST"])
async def lobby_resume(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.paused = False
    lobby.anchor_time = time.time()
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/seek", methods=["POST"])
async def lobby_seek(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.position_anchor_ms = float(data.get("positionMs", 0))
    lobby.anchor_time = time.time()
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/skip", methods=["POST"])
async def lobby_skip(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    if lobby.queue:
        lobby.current_track = lobby.queue.pop(0)
        lobby.position_anchor_ms = 0
        lobby.anchor_time = time.time()
        lobby.paused = False
    else:
        lobby.current_track = None
        lobby.paused = True
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/filters", methods=["POST"])
async def lobby_filters(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.position_anchor_ms = lobby.current_position_ms()
    lobby.anchor_time = time.time()
    lobby.filters = data.get("filters", {})
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/queue/add", methods=["POST"])
async def lobby_queue_add(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if client_id not in lobby.participants:
        return jsonify({"error": "not in lobby"}), 403
    track = data.get("track")
    if not lobby.current_track:
        lobby.current_track = track
        lobby.paused = False
        lobby.position_anchor_ms = 0
        lobby.anchor_time = time.time()
    else:
        lobby.queue.append(track)
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


@app.route("/api/lobby/<code>/queue/remove", methods=["POST"])
async def lobby_queue_remove(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if client_id not in lobby.participants:
        return jsonify({"error": "not in lobby"}), 403
    idx = data.get("index")
    if isinstance(idx, int) and 0 <= idx < len(lobby.queue):
        lobby.queue.pop(idx)
    broadcast(lobby, "state", lobby.public_state())
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════
# WebRTC voice — now just plain `await`s, no thread bridge required
# ═══════════════════════════════════════════════════════════════════
@app.route("/api/lobby/<code>/webrtc/offer", methods=["POST"])
async def webrtc_offer(code):
    if not WEBRTC_AVAILABLE:
        return jsonify({"error": "Voice chat unavailable — install aiortc, av, numpy on the server"}), 503

    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    participant = lobby.participants.get(client_id)
    if not participant:
        return jsonify({"error": "not in lobby"}), 403

    if participant.pc:
        try:
            await participant.pc.close()
        except Exception:
            pass

    ice_servers = [RTCIceServer(urls=u) for u in config.ICE_SERVERS]
    pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=ice_servers))
    participant.pc = pc

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            participant.mic_track = relay.subscribe(track)

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in ("failed", "closed"):
            participant.mic_track = None

    def sources_getter():
        return {cid: p.mic_track for cid, p in lobby.participants.items()}

    mixed_track = MixedAudioTrack(sources_getter, exclude_id=client_id)
    pc.addTrack(mixed_track)

    try:
        offer = RTCSessionDescription(sdp=data["sdp"], type=data["type"])
        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


# ═══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print(f"[NodeLink Lobby Server] NodeLink node: {NL_HOST}")
    print(f"[NodeLink Lobby Server] Voice chat (aiortc): {'enabled' if WEBRTC_AVAILABLE else 'DISABLED — see warning above'}")
    print(f"[NodeLink Lobby Server] Listening on http://{config.FLASK_HOST}:{config.FLASK_PORT}")
    app.run(host=config.FLASK_HOST, port=config.FLASK_PORT, debug=config.DEBUG)
