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
  active filters, queue) AND now owns the actual audio pipeline too. For
  each lobby, ONE background task (LobbyRelay, below) pulls raw PCM from
  NodeLink, transcodes it to Opus/Ogg in real time, and fans the encoded
  bytes out to every connected listener over plain HTTP (GET
  /api/lobby/<code>/live). Clients are dumb — an <audio> element pointed
  at that URL, no local PCM decode/scheduling/drift-correction. A slow
  listener's queue just drops old frames (graceful degradation) instead
  of the whole track getting cut short or skipped, and a track's actual
  progress no longer depends on any one client's network. Bandwidth is
  ~12x lower than the old raw-PCM-per-client design (Opus @ ~96kbps vs
  PCM @ ~1.5Mbps) AND flat regardless of listener count (NodeLink is only
  fetched once per track, not once per client).

- State sync + chat: pushed to clients over Socket.IO (WebSocket, with
  automatic long-polling fallback and automatic client-side reconnection).
  Each lobby is a Socket.IO "room" (named after the lobby code); state
  changes are broadcast to that room. A client_id -> set-of-sids map on
  each Lobby tracks which sockets are currently live for a participant,
  which drives the same disconnect-grace-period logic that used to key
  off the old SSE connection (see _schedule_disconnect_check below).
  `public_state()` includes `relayGen`, which bumps every time the relay
  starts a fresh Opus/Ogg encode session (new track, seek, or filter
  change) — the frontend watches this to know when to point its <audio>
  element at a fresh /live connection vs. just leave it playing.

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
    hypercorn server:asgi_app --bind 0.0.0.0:5000

Note it's `server:asgi_app`, not `server:app` — `asgi_app` is the Quart app
wrapped with the Socket.IO ASGI layer, so websocket traffic gets routed
correctly. Then open http://localhost:5000 — this process serves the API,
Socket.IO, and the static frontend, so "use this server (default)" works
with zero extra configuration.
"""

import asyncio
import fractions
import random
import string
import time
import uuid
import traceback
from pathlib import Path

import aiohttp
import av
import numpy as np
import socketio
from quart import Quart, Response, jsonify, request, send_from_directory
from quart_cors import cors

import config

try:
    from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
    from aiortc.contrib.media import MediaRelay
    WEBRTC_AVAILABLE = True
except ImportError:
    WEBRTC_AVAILABLE = False
    print("[!] aiortc not installed — voice chat will be disabled. Run: pip install aiortc")

# ═══════════════════════════════════════════════════════════════════
# App setup
# ═══════════════════════════════════════════════════════════════════
STATIC_DIR = Path(__file__).resolve().parent  # project root (index.html lives here)

app = Quart(__name__, static_folder=None)
app = cors(app, allow_origin="*", allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"])

# Socket.IO server for real-time push (state/participants/chat), mounted
# in front of the Quart app. Quart apps are themselves valid ASGI apps, so
# socketio.ASGIApp forwards anything that isn't a Socket.IO request
# straight through to `app` unchanged — regular REST routes below are
# untouched. `asgi_app` (not `app`) is what you point a real server at.
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
asgi_app = socketio.ASGIApp(sio, other_asgi_app=app)

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
                    traceback.print_exc()
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
# Live music relay — one continuous Opus/Ogg encode per lobby, fanned
# out to every listener over plain HTTP. Replaces the old design where
# each client independently pulled raw PCM from NodeLink and paced it
# against a wall-clock anchor: a client whose network couldn't sustain
# ~1.5 Mbps of raw PCM would fall behind, get forcibly reseeked back onto
# the anchor by the old client-side drift correction (cutting out
# whatever audio it hadn't caught up on yet), and could get skipped to
# the next track entirely once the host's own (unaffected) stream
# reached the end.
#
# Now the server does exactly ONE NodeLink fetch per track (not one per
# listener), transcodes it to Opus (~12x smaller than raw PCM, so far
# more connections can keep up), and fans the encoded bytes out. A slow
# listener just has old frames dropped from their own queue — nobody
# else, and the track's own progress, are affected at all.
#
# Ogg/Opus specifically (rather than e.g. raw Opus packets) because it's
# natively supported by <audio> elements in every modern browser with
# zero client-side code, and a late-joining listener can be brought up
# to speed just by replaying the two small cached header pages (Opus ID
# + comment) ahead of the live tail — exactly how Icecast-style internet
# radio relays work. Verified empirically: PyAV's ogg muxer emits those
# two header pages as the very first writes, and a decoder fed only
# [headers + an arbitrary later page] decodes fine, skipping cleanly to
# wherever the live edge currently is.
# ═══════════════════════════════════════════════════════════════════
PCM_RATE = 48000
PCM_CHANNELS = 2
PCM_FRAME_SAMPLES = 960                                    # 20ms @ 48kHz
PCM_FRAME_BYTES = PCM_FRAME_SAMPLES * PCM_CHANNELS * 2      # s16le
OPUS_BITRATE = 96000
LISTENER_QUEUE_MAX = 8   # chunks; a slow client gets old ones dropped, not a backlog


class _CallbackIO:
    """Minimal writable file-like object PyAV can mux an Ogg container
    into — forwards every write straight to a callback instead of
    buffering to a real file."""
    def __init__(self, write_cb):
        self._write_cb = write_cb

    def write(self, data):
        self._write_cb(data)
        return len(data)


class _Listener:
    __slots__ = ("queue",)
    def __init__(self):
        self.queue = asyncio.Queue(maxsize=LISTENER_QUEUE_MAX)


class LobbyRelay:
    """Owns the single live NodeLink -> Opus/Ogg pipeline for one lobby."""

    def __init__(self, lobby):
        self.lobby = lobby
        self.generation = 0          # bumped on every fresh encode session
        self.listeners = {}          # opaque key -> _Listener
        self._task = None
        self._resume_event = asyncio.Event()
        self._resume_event.set()     # not paused by default
        self._header_chunks = []     # cached Ogg header pages for the CURRENT generation
        self._header_chunks_done = False

    # ---- listener management ----------------------------------------
    def add_listener(self):
        key = object()
        listener = _Listener()
        self.listeners[key] = listener
        # Replay this generation's cached header pages immediately, so a
        # mid-track joiner's decoder has the Opus ID/comment pages before
        # any audio data — then everything after is just the live tail,
        # same as every other listener gets.
        for chunk in self._header_chunks:
            self._push(listener, chunk)
        return key, listener.queue

    def remove_listener(self, key):
        self.listeners.pop(key, None)

    def _push(self, listener, data):
        q = listener.queue
        if q.full():
            try:
                q.get_nowait()  # drop the oldest chunk to make room — never block the relay for one slow listener
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass

    def _broadcast_bytes(self, data):
        for listener in list(self.listeners.values()):
            self._push(listener, data)

    def _close_all_listeners(self):
        """Push the end-of-response sentinel to every currently attached
        listener so their HTTP connection ends immediately — used when a
        new encode session starts, since old listeners must reconnect to
        get valid Ogg headers for the new session rather than receiving
        a second logical stream chained onto their existing connection
        (technically legal Ogg, but unreliably supported by browsers)."""
        for listener in list(self.listeners.values()):
            while not listener.queue.empty():
                try:
                    listener.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            try:
                listener.queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    # ---- session control ----------------------------------------------
    async def start_track(self, track, position_ms, filters):
        """(Re)start the encode session for `track` at `position_ms` with
        `filters`. Bumps `generation`, which the frontend watches (via
        state.relayGen) to know when to point its <audio> element at a
        fresh /live connection."""
        self._cancel_task()
        self.generation += 1
        self._header_chunks = []
        self._header_chunks_done = False
        self._close_all_listeners()
        self._resume_event.set()
        if track is None:
            return
        self._task = asyncio.create_task(self._run(track, position_ms, filters, self.generation))

    async def reseek(self, position_ms, filters=None):
        track = self.lobby.current_track
        if track is None:
            return
        await self.start_track(track, position_ms, filters if filters is not None else self.lobby.filters)

    def set_paused(self, paused):
        # Freezes the relay's own real-time pacing loop in place (no
        # re-fetch, no reseek) — sample-accurate, and resuming just
        # continues exactly where it left off.
        if paused:
            self._resume_event.clear()
        else:
            self._resume_event.set()

    def _cancel_task(self):
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None

    async def stop(self):
        self._cancel_task()
        self.generation += 1
        self._header_chunks = []
        self._header_chunks_done = False
        self._close_all_listeners()

    # ---- the actual pipeline ----------------------------------------------
    async def _run(self, track, position_ms, filters, my_generation):
        body = {"encodedTrack": track.get("encoded"), "position": round(position_ms)}
        if filters:
            body["filters"] = filters

        container = stream = None

        def sink_write(data):
            if self.generation != my_generation:
                return
            data = bytes(data)
            if not self._header_chunks_done:
                self._header_chunks.append(data)
            self._broadcast_bytes(data)

        try:
            container = av.open(_CallbackIO(sink_write), mode="w", format="ogg")
            stream = container.add_stream("libopus", rate=PCM_RATE)
            stream.layout = "stereo"
            stream.bit_rate = OPUS_BITRATE

            async with http_session.post(f"{NL_HOST}/v4/loadstream", json=body,
                                          headers={"Authorization": NL_PASS}) as r:
                if r.status != 200:
                    print(f"[relay {self.lobby.code}] NodeLink loadstream {r.status}: {await r.text()}")
                    return

                pcm_buf = bytearray()
                async for chunk in r.content.iter_chunked(8192):
                    if self.generation != my_generation:
                        return
                    await self._resume_event.wait()   # blocks here while paused, resumes exactly in place
                    if self.generation != my_generation:
                        return

                    pcm_buf.extend(chunk)
                    while len(pcm_buf) >= PCM_FRAME_BYTES:
                        frame_bytes = bytes(pcm_buf[:PCM_FRAME_BYTES])
                        del pcm_buf[:PCM_FRAME_BYTES]
                        frame = self._pcm_to_frame(frame_bytes)
                        for pkt in stream.encode(frame):
                            container.mux(pkt)
                        self._header_chunks_done = True
                        # Real-time pacing: ~one 20ms frame per 20ms of
                        # wall clock, so CPU/bandwidth stay flat and
                        # listeners' buffers fill at a natural rate
                        # instead of the whole track being transcoded
                        # and pushed as fast as NodeLink can send it.
                        await asyncio.sleep(PCM_FRAME_SAMPLES / PCM_RATE)

            # NodeLink stream ended naturally — flush the encoder and advance the queue.
            if self.generation == my_generation:
                for pkt in stream.encode(None):
                    container.mux(pkt)
                await self._advance_after_track_end(my_generation)
        except asyncio.CancelledError:
            pass
        except Exception:
            traceback.print_exc()
        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    traceback.print_exc()

    @staticmethod
    def _pcm_to_frame(raw):
        # Packed/interleaved s16 wants a single plane shaped (1, samples*channels).
        arr = np.frombuffer(raw, dtype="<i2").reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(arr, format="s16", layout="stereo")
        frame.sample_rate = PCM_RATE
        return frame

    async def _advance_after_track_end(self, my_generation):
        if self.generation != my_generation:
            return  # something else already changed the session; don't double-advance
        lobby = self.lobby
        if lobby.queue:
            lobby.current_track = lobby.queue.pop(0)
            lobby.position_anchor_ms = 0
            lobby.anchor_time = time.time()
            lobby.paused = False
            await self.start_track(lobby.current_track, 0, lobby.filters)
        else:
            lobby.current_track = None
            lobby.paused = True
            await self.stop()
        await broadcast(lobby, "state", lobby.public_state())


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
        self.sids = {}           # client_id -> set of live Socket.IO sids
        self.queue = []          # list of track dicts
        self.current_track = None
        self.paused = True
        self.position_anchor_ms = 0
        self.anchor_time = time.time()
        self.filters = {}
        self.chat = []
        self.created_at = time.time()
        self.relay = LobbyRelay(self)

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
            "relayGen": self.relay.generation,
        }

    def participant_list(self):
        return [{"id": p.id, "name": p.name, "isHost": p.id == self.host_id} for p in self.participants.values()]


LOBBIES = {}

# Socket.IO sid -> (lobby_code, client_id), so the disconnect handler
# (which only gets a bare sid from Socket.IO) knows who dropped.
_sid_registry = {}


def gen_code():
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=config.LOBBY_CODE_LENGTH))
        if code not in LOBBIES:
            return code


def get_lobby_or_404(code):
    return LOBBIES.get((code or "").upper())


async def broadcast(lobby, event, data):
    await sio.emit(event, data, room=lobby.code)


# ═══════════════════════════════════════════════════════════════════
# Participant departure — shared by the explicit /leave endpoint AND by
# Socket.IO disconnects (tab close, refresh, network drop). A dropped
# socket alone isn't necessarily a real departure — socket.io auto-
# reconnects with backoff, and brief network blips happen — so
# disconnects go through a short grace period first; an explicit /leave
# (or the sendBeacon fired on page unload) skips straight to
# _finalize_leave.
# ═══════════════════════════════════════════════════════════════════
async def _finalize_leave(lobby, client_id):
    """Remove a participant for real: close their WebRTC connection,
    promote a new host if they were host, broadcast the change, and tear
    the whole lobby down if that was the last participant."""
    if client_id not in lobby.participants:
        return  # already handled by a prior call (explicit leave + a
                 # later-expiring grace-period check both land here)

    p = lobby.participants.pop(client_id, None)
    for sid in lobby.sids.pop(client_id, set()):
        _sid_registry.pop(sid, None)
        try:
            await sio.disconnect(sid)
        except Exception:
            traceback.print_exc()
            pass
    if p and p.pc:
        try:
            await p.pc.close()
        except Exception:
            traceback.print_exc()
            pass

    was_host = lobby.host_id == client_id
    if was_host and lobby.participants:
        lobby.host_id = next(iter(lobby.participants))

    if not lobby.participants:
        await lobby.relay.stop()
        LOBBIES.pop(lobby.code, None)
        return  # lobby is gone, nobody left to notify

    if p:
        await broadcast(lobby, "participants", lobby.participant_list())
        text = f"{p.name} left"
        if was_host:
            new_host = lobby.participants.get(lobby.host_id)
            if new_host:
                text += f" \u00b7 {new_host.name} is now host"
        await broadcast(lobby, "chat", {"system": True, "text": text, "ts": time.time() * 1000})

    if was_host:
        # hostId changed — push fresh state so host-only UI locks update
        # on every remaining client, including the newly promoted host.
        await broadcast(lobby, "state", lobby.public_state())


async def _schedule_disconnect_check(lobby, client_id):
    """Wait out the grace period after a Socket.IO connection drops; if
    the client hasn't reconnected (registered a new live sid) by then,
    treat it as a real departure."""
    await asyncio.sleep(config.DISCONNECT_GRACE_SECONDS)
    if lobby.sids.get(client_id):
        return  # reconnected in time — nothing to do
    await _finalize_leave(lobby, client_id)


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

    return jsonify({"code": code, "clientId": client_id, "isHost": True, "state": lobby.public_state()})


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

    await broadcast(lobby, "participants", plist)
    await broadcast(lobby, "chat", {"system": True, "text": f"{display_name} joined", "ts": time.time() * 1000})

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
    if lobby and client_id:
        await _finalize_leave(lobby, client_id)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════
# Socket.IO — real-time push. REST handlers above already return fresh
# state to whoever made the change; these events are purely for fanning
# that state out to everyone else in the lobby (room = lobby code), and
# for tracking which participants currently have a live connection.
# ═══════════════════════════════════════════════════════════════════
@sio.event
async def connect(sid, environ):
    # No lobby association yet — the client already has clientId/code
    # from its REST create/join call and sends join_lobby right after
    # connecting. Nothing to do here but accept the connection.
    pass


@sio.on("join_lobby")
async def socket_join_lobby(sid, data):
    data = data or {}
    code = (data.get("code") or "").upper()
    client_id = data.get("clientId")
    lobby = get_lobby_or_404(code)

    if not lobby or client_id not in lobby.participants:
        await sio.emit("join_error", {"error": "not found"}, room=sid)
        return

    await sio.enter_room(sid, code)
    _sid_registry[sid] = (code, client_id)
    lobby.sids.setdefault(client_id, set()).add(sid)

    # Bring this (re)connecting client fully up to date right away rather
    # than waiting for someone else's next state-changing action.
    await sio.emit("state", lobby.public_state(), room=sid)
    await sio.emit("participants", lobby.participant_list(), room=sid)


@sio.event
async def disconnect(sid):
    info = _sid_registry.pop(sid, None)
    if not info:
        return
    code, client_id = info
    lobby = get_lobby_or_404(code)
    if not lobby:
        return
    sids = lobby.sids.get(client_id)
    if sids:
        sids.discard(sid)
    # Don't remove the participant yet — this may just be a reconnect
    # (tab backgrounded, brief network blip, etc). See
    # _schedule_disconnect_check, which double-checks after a grace
    # period whether a new sid ever showed up for this client_id.
    asyncio.create_task(_schedule_disconnect_check(lobby, client_id))


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
    await broadcast(lobby, "chat", msg)
    return jsonify({"ok": True})


def _require_host(lobby, client_id):
    return lobby.host_id == client_id


@app.route("/api/lobby/<code>/live")
async def lobby_live(code):
    """Listener endpoint — one Opus/Ogg byte stream, shared across every
    connected client via LobbyRelay. Plain chunked HTTP so a browser
    <audio src="..."> just works with zero client-side decode logic."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404

    key, queue = lobby.relay.add_listener()

    async def gen():
        try:
            while True:
                data = await queue.get()
                if data is None:  # relay started a new session — end this response, client reconnects fresh
                    return
                yield data
        except asyncio.CancelledError:
            pass
        finally:
            lobby.relay.remove_listener(key)

    return Response(
        gen(),
        mimetype="audio/ogg",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


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
    await lobby.relay.start_track(lobby.current_track, 0, lobby.filters)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
    lobby.relay.set_paused(True)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
    lobby.relay.set_paused(False)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
    await lobby.relay.reseek(lobby.position_anchor_ms)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
        await lobby.relay.start_track(lobby.current_track, 0, lobby.filters)
    else:
        lobby.current_track = None
        lobby.paused = True
        await lobby.relay.stop()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
    await lobby.relay.reseek(lobby.position_anchor_ms, filters=lobby.filters)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
        await lobby.relay.start_track(lobby.current_track, 0, lobby.filters)
    else:
        lobby.queue.append(track)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


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
            traceback.print_exc()
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
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    return jsonify({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


# ═══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    print(f"[NodeLink Lobby Server] NodeLink node: {NL_HOST}")
    print(f"[NodeLink Lobby Server] Voice chat (aiortc): {'enabled' if WEBRTC_AVAILABLE else 'DISABLED — see warning above'}")
    print(f"[NodeLink Lobby Server] Realtime transport: Socket.IO (WebSocket, long-polling fallback)")
    print(f"[NodeLink Lobby Server] Listening on http://{config.FLASK_HOST}:{config.FLASK_PORT}")

    # Quart's own app.run() only serves `app` — the plain Quart/REST
    # layer. Socket.IO is mounted a level above that (see `asgi_app`
    # near the top of this file), so it has to be what actually gets
    # served, or every websocket/polling request 404s.
    hyper_cfg = HyperConfig()
    hyper_cfg.bind = [f"{config.FLASK_HOST}:{config.FLASK_PORT}"]
    hyper_cfg.debug = config.DEBUG
    asyncio.run(hypercorn.asyncio.serve(asgi_app, hyper_cfg))