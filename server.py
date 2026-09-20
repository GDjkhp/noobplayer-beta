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
import io
import json
import random
import re
import string
import struct
import time
import uuid
import traceback
from collections import deque
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

# The relay's NodeLink /v4/loadstream connection is long-lived and can sit
# idle for an arbitrarily long time — the relay deliberately stops reading
# from it while the host has paused playback (see LobbyRelay._pump_track's
# `_resume_event.wait()`). aiohttp's default ClientTimeout (5 minutes
# total, tracked from request start regardless of read activity) would
# otherwise kill that connection mid-pause, surfacing as a TimeoutError
# the instant playback resumes. These streaming requests opt out of it
# entirely; sock_connect keeps a sane bound on just the initial handshake.
NODELINK_STREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=None)


# ── NodeLink request instrumentation (Debug tab) ───────────────────────
# Wraps the aiohttp session used for every backend → NodeLink call (the
# proxy endpoints below AND the playback relay's own internal
# loadtracks/loadstream calls) so the Debug tab can show them, without
# editing any of the ~10 call sites that already do
# `async with http_session.get(...)`. Pure observation: logs a bounded,
# most-recent-first deque and pushes each completed request to whichever
# sids are currently subscribed — nothing extra is ever sent to NodeLink,
# and nothing runs at all when no one has the Debug tab open.
NODELINK_LOG_CAP = 60
nodelink_requests = deque(maxlen=NODELINK_LOG_CAP)
NODELINK_DEBUG_SUBSCRIBERS = set()  # sids


async def _push_nodelink_entry(entry):
    for sid in list(NODELINK_DEBUG_SUBSCRIBERS):
        try:
            await sio.emit("nodelink_request", entry, room=sid)
        except Exception:
            NODELINK_DEBUG_SUBSCRIBERS.discard(sid)


class _TrackedRequest:
    """Wraps one aiohttp request context manager. Timed at __aenter__
    (time-to-headers) rather than __aexit__ — /v4/loadstream responses in
    particular stay open and get read from for the life of a whole track,
    so timing to __aexit__ would report track length as "latency" instead
    of a useful TTFB number."""

    __slots__ = ("method", "url", "_cm")

    def __init__(self, method, url, cm):
        self.method = method
        self.url = url
        self._cm = cm

    def _path(self):
        return self.url[len(NL_HOST):] if self.url.startswith(NL_HOST) else self.url

    async def __aenter__(self):
        t0 = time.monotonic()
        try:
            resp = await self._cm.__aenter__()
        except Exception as e:
            entry = {
                "method": self.method, "path": self._path(), "status": "ERR", "ok": False,
                "ms": round((time.monotonic() - t0) * 1000), "size": None,
                "ts": time.time() * 1000, "error": str(e)[:160],
            }
            nodelink_requests.appendleft(entry)
            await _push_nodelink_entry(entry)
            raise
        entry = {
            "method": self.method, "path": self._path(), "status": resp.status, "ok": resp.status < 400,
            "ms": round((time.monotonic() - t0) * 1000),
            "size": int(resp.headers["Content-Length"]) if "Content-Length" in resp.headers else None,
            "ts": time.time() * 1000,
        }
        nodelink_requests.appendleft(entry)
        await _push_nodelink_entry(entry)
        return resp

    async def __aexit__(self, *exc):
        return await self._cm.__aexit__(*exc)


class _InstrumentedSession:
    """Drop-in wrapper for aiohttp.ClientSession — only get()/post() are
    overridden; close() and everything else pass straight through via
    __getattr__, so wrapping http_session at startup is the only edit
    needed to instrument every call site."""

    def __init__(self, session):
        self._session = session

    def get(self, url, **kwargs):
        return _TrackedRequest("GET", url, self._session.get(url, **kwargs))

    def post(self, url, **kwargs):
        return _TrackedRequest("POST", url, self._session.post(url, **kwargs))

    def __getattr__(self, name):
        return getattr(self._session, name)


@app.before_serving
async def startup():
    global http_session
    http_session = _InstrumentedSession(aiohttp.ClientSession())


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
PCM_FRAME_SAMPLES = 960                                     # 20ms @ 48kHz
PCM_FRAME_BYTES = PCM_FRAME_SAMPLES * PCM_CHANNELS * 2      # s16le
OPUS_BITRATE = 96000
# Chunks; a slow client gets its OLDEST buffered chunk dropped to make
# room, not a growing backlog. That drop is destructive for that
# listener though — it's a permanent hole in their Ogg byte stream, not
# a retransmittable gap, and browsers don't recover gracefully from
# missing bytes mid-container (typically a glitch or stall, not a clean
# skip). 8 was thin enough that ordinary network jitter — not just a
# genuinely stalled client — triggered it constantly, which is the most
# likely source of frequent audio dropouts. Each queued item is one
# `sink_write` call (roughly one flushed Ogg page, well under 100ms of
# audio), so 8 was only ~1s of slack for the WHOLE relay pipeline,
# shared across every listener independently. Bumped to give a few
# seconds of real cushion; a still-slow listener after this many still
# genuinely can't keep up and dropping for them is correct.
LISTENER_QUEUE_MAX = 150
# How often the idle loop wakes to top up silence while the queue is
# empty. This used to be a single 20ms frame every 15 seconds — fine for
# keeping the TCP connection alive through a reverse-proxy idle-read
# timeout, but it meant that the INSTANT a track ended with nothing
# queued, every listener's <audio> buffer (which typically only has a
# second or so of real margin, same as during normal playback) ran
# completely dry and sat there with literally nothing arriving for up to
# 15 seconds. That's what made "no next track" sound like the song itself
# got cut off, instead of the smooth, uninterrupted continuation a queued
# next track gets (there's never a gap in that case — real audio just
# keeps flowing). Waking far more often bounds that worst-case gap to
# something a listener's buffer margin can absorb. _feed_silence itself
# always makes up exactly however much wall-clock time has actually
# elapsed (see its own comment) — this constant only controls how promptly
# it's given the chance to do that, not how much silence gets fed.
IDLE_KEEPALIVE_SECONDS = 1.0


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

        # ---- gapless preload ----------------------------------------
        # Whatever track is predicted to play next (see
        # _predict_next_track) gets its NodeLink connection opened and
        # its raw PCM buffered here WHILE the current track is still
        # streaming — so when the current track's NodeLink stream ends
        # naturally, _pump_track can start feeding the next track's audio
        # into the SAME ongoing Ogg/Opus mux session immediately, with no
        # dead air. Host-controlled per lobby (self.lobby.gapless — see
        # the /gapless route); ensure_preload() no-ops entirely while it's
        # off, so a natural advance falls through to _pump_track's live
        # NodeLink fetch instead, which is what actually produces the
        # gap — the Ogg session itself and the listener's connection
        # (relayGen) are untouched either way; only the boundary is quiet
        # rather than instant.
        # Shape: {"track": dict, "chunks": [bytes], "done": bool, "task": Task}
        self._preload = None

        # ---- idle keep-alive ----------------------------------------
        # When the queue naturally runs dry, _run used to flush the Opus
        # stream and return, ending the task entirely — which meant every
        # listener's <audio> connection went dead, AND whatever played
        # next had to open a brand new one (see resume_or_start below).
        # Now _run instead parks itself in an idle wait right where it is:
        # same task, same still-open Ogg container, same /live connection
        # every listener is already attached to. _feed_silence tops that
        # connection up at exactly real-time speed (see its own comment for
        # why "exactly" matters) every IDLE_KEEPALIVE_SECONDS, which both
        # keeps a listener's <audio> buffer from ever running dry and keeps
        # the connection warm through any reverse-proxy idle-read timeout
        # in front of this server.
        self._idle = False               # True while parked in the idle wait below
        self._idle_event = asyncio.Event()
        self._pending = None             # (track, position_ms, filters) waiting to resume with

        # ---- real-time pacing anchor ---------------------------------
        # See feed_chunk() in _pump_track: a naive `sleep(0.02)` per 1s
        # frame drifts behind real time by whatever the encode/mux/write
        # work costs each iteration, compounding over a track's length.
        # `_pace_next` is the monotonic deadline for the NEXT frame;
        # sleeping to a deadline (rather than sleeping a fixed duration)
        # cancels out that drift automatically. None means "no schedule
        # yet — start fresh on the next frame", which feed_chunk also
        # falls back to whenever the gap since the last frame is large
        # (pause, seek, idle-to-active), so it never tries to "catch up"
        # a multi-second backlog by firehosing frames.
        self._pace_next = None

        # ---- debug/stats instrumentation -----------------------------
        # Lightweight, bounded-memory counters surfaced read-only via
        # GET /api/lobby/<code>/debug for the client's Debug tab. Purely
        # observational — nothing here changes playback behaviour, and a
        # deque(maxlen=...) means it can never grow unbounded.
        self.stats = {
            "frames_encoded": 0,
            "pcm_bytes_in": 0,
            "opus_bytes_out": 0,
            "encode_ms": deque(maxlen=200),
            "pace_drift_ms": deque(maxlen=200),
            "listener_drops": 0,
            "sessions_started": 0,
            "last_frame_ts": None,
        }

        # ---- debug/stats push (Socket.IO) ------------------------------
        # The Debug tab subscribes/unsubscribes over the socket (see
        # socket_debug_subscribe below) instead of polling a REST route,
        # so stats only ever go out to sockets that actually asked for
        # them, and only while at least one is asking. Nothing runs when
        # nobody has the tab open.
        self._debug_subscribers = set()   # sids
        self._debug_task = None

        # ---- buffered-waveform lookahead (Socket.IO push, Debug tab only) ---
        # Per-20ms-frame peak levels, computed right where feed_chunk
        # already encodes each frame below — this is genuine lookahead
        # (ahead of network transit AND the listener's own <audio>
        # buffering), not a guess reconstructed from audio.buffered like a
        # client-side heuristic would have to be. deque(maxlen=...) bounds
        # it even if the push loop ever lags; only populated at all while
        # someone actually has the Debug tab open (see feed_chunk).
        self._wave_peaks = deque(maxlen=300)
        self._wave_task = None

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
                self.stats["listener_drops"] += 1
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass

    def debug_snapshot(self):
        """Read-only stats snapshot for the client Debug tab. Safe to call
        from any task — only ever reads the bounded counters above."""
        enc = list(self.stats["encode_ms"])
        drift = list(self.stats["pace_drift_ms"])
        avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
        last_ts = self.stats["last_frame_ts"]
        return {
            "generation": self.generation,
            "idle": self._idle,
            "listeners": len(self.listeners),
            "hasPreload": self._preload is not None,
            "framesEncoded": self.stats["frames_encoded"],
            "pcmBytesIn": self.stats["pcm_bytes_in"],
            "opusBytesOut": self.stats["opus_bytes_out"],
            "encodeMsAvg": avg(enc),
            "encodeMsLast": round(enc[-1], 3) if enc else None,
            "encodeMsMax": round(max(enc), 3) if enc else None,
            "paceDriftMsAvg": avg(drift),
            "paceDriftMsMax": round(max(drift), 3) if drift else None,
            "listenerDrops": self.stats["listener_drops"],
            "sessionsStarted": self.stats["sessions_started"],
            "lastFrameAgeMs": round((time.time() - last_ts) * 1000, 1) if last_ts else None,
            "participants": len(self.lobby.participants),
            "queueLength": len(self.lobby.queue),
            "paused": self.lobby.paused,
            "positionMs": self.lobby.current_position_ms(),
            # The recommendation pool (get_rekt equivalent) — never exposed
            # to clients otherwise, it's purely a server-side implementation
            # detail Autoplay/Smart Shuffle drain from. Capped + stripped
            # down (see _track_brief) since this goes out on every push.
            "autoQueueCount": len(self.lobby.auto_queue),
            "autoQueue": [_track_brief(t) for t in self.lobby.auto_queue[:30]],
        }

    # ---- debug/stats push (Socket.IO) --------------------------------
    def debug_subscribe(self, sid):
        self._debug_subscribers.add(sid)
        if self._debug_task is None or self._debug_task.done():
            self._debug_task = asyncio.create_task(self._debug_push_loop())
        if self._wave_task is None or self._wave_task.done():
            self._wave_task = asyncio.create_task(self._wave_push_loop())

    def debug_unsubscribe(self, sid):
        self._debug_subscribers.discard(sid)
        # No need to cancel either task explicitly — both check the
        # subscriber set themselves each cycle and exit once it's empty.

    async def _debug_push_loop(self):
        try:
            while self._debug_subscribers:
                snap = self.debug_snapshot()
                for sid in list(self._debug_subscribers):
                    try:
                        await sio.emit("debug_stats", snap, room=sid)
                    except Exception:
                        self._debug_subscribers.discard(sid)
                await asyncio.sleep(1.5)
        finally:
            self._debug_task = None

    # Drains self._wave_peaks (filled by feed_chunk, one entry per 20ms
    # frame actually encoded) every 150ms and pushes it as one batch —
    # real, already-decided audio the listener hasn't heard yet, in the
    # exact order it'll play. `generation` rides along so the client can
    # tell a hard cut (skip/seek/new track) apart from the normal gapless
    # case, where peaks just keep flowing with no reset.
    async def _wave_push_loop(self):
        try:
            while self._debug_subscribers:
                if self._wave_peaks:
                    peaks = list(self._wave_peaks)
                    self._wave_peaks.clear()
                    payload = {"peaks": peaks, "generation": self.generation}
                    for sid in list(self._debug_subscribers):
                        try:
                            await sio.emit("wave_peaks", payload, room=sid)
                        except Exception:
                            self._debug_subscribers.discard(sid)
                await asyncio.sleep(0.15)
        finally:
            self._wave_task = None

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

    # ---- gapless preload ------------------------------------------------
    def _predict_next_track(self):
        """Whatever should play right after the current one. Delegates to
        Lobby.peek_next_track() so loop modes, autoplay and the plain queue
        head are all decided in exactly one place — the same place
        _advance_for_gapless() consumes from, which is what stops the
        prefetch from ever buffering a track that isn't the one that
        actually plays."""
        return self.lobby.peek_next_track()

    def ensure_preload(self):
        """Call whenever the queue changes (add/remove/move), a track
        starts, or the host flips the Gapless toggle, so the prefetch
        always targets whatever will actually play next. Cheap no-op if
        the prediction hasn't changed. No-op entirely (and drops any
        preload already in flight) while the lobby's Gapless setting is
        off — see the /gapless route."""
        if not self.lobby.gapless:
            self._cancel_preload()
            return
        next_track = self._predict_next_track()
        want_id = next_track.get("encoded") if next_track else None
        have_id = self._preload["track"].get("encoded") if self._preload else None
        if want_id == have_id:
            return
        self._cancel_preload()
        if next_track is None:
            return
        pre = {"track": next_track, "chunks": [], "done": False, "task": None}
        pre["task"] = asyncio.create_task(self._preload_fetch(pre))
        self._preload = pre

    def _cancel_preload(self):
        if self._preload and self._preload["task"] and not self._preload["task"].done():
            self._preload["task"].cancel()
        self._preload = None

    async def _preload_fetch(self, pre):
        """Background task: open the NodeLink connection for `pre["track"]`
        early and keep buffering its raw PCM so it's ready (or at least
        well underway) by the time the current track ends."""
        body = {"encodedTrack": pre["track"].get("encoded"), "position": 0}
        try:
            async with http_session.post(f"{NL_HOST}/v4/loadstream", json=body,
                                          headers={"Authorization": NL_PASS},
                                          timeout=NODELINK_STREAM_TIMEOUT) as r:
                if r.status != 200:
                    return
                async for chunk in r.content.iter_chunked(8192):
                    if self._preload is not pre:
                        return  # superseded by a newer prediction
                    pre["chunks"].append(bytes(chunk))
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError):
            pass  # preload is best-effort — _pump_track just falls back to a live fetch
        except Exception:
            traceback.print_exc()
        finally:
            pre["done"] = True

    # ---- session control ----------------------------------------------
    async def start_track(self, track, position_ms, filters):
        """(Re)start the encode session for `track` at `position_ms` with
        `filters`. Bumps `generation`, which the frontend watches (via
        state.relayGen) to know when to point its <audio> element at a
        fresh /live connection. This is for explicit, deliberate track
        changes (play/skip/seek/filters) — a NATURAL end-of-track advance
        does NOT go through here; see _run's internal loop, which stitches
        the next track into the same session instead (gapless), and
        resume_or_start below, which does the same across an idle gap."""
        self._cancel_task()
        self._cancel_preload()
        self._idle = False
        self._idle_event.clear()
        self._pending = None
        self._pace_next = None
        self.generation += 1
        self._header_chunks = []
        self._header_chunks_done = False
        self._wave_peaks.clear()  # hard cut — discard any pending lookahead from the old session
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

    async def resume_or_start(self, track, position_ms=0, filters=None):
        """Cheap path back from silence. If the pipeline is still alive and
        sitting in the idle wait (queue ran dry but nothing tore the
        session down — see _run), hand it this track and wake it up: same
        generation, same still-open Ogg container, same /live connection
        every listener is already attached to, so nobody reconnects.
        Falls back to a full start_track() (new generation, forced
        reconnect) whenever that shortcut doesn't apply — most commonly
        the very first track ever played in a fresh lobby, where there's
        no pipeline running yet to resume."""
        if self._task is not None and not self._task.done() and self._idle:
            self._pending = (track, position_ms, filters if filters is not None else self.lobby.filters)
            self._idle = False
            self._idle_event.set()
            return
        await self.start_track(track, position_ms, filters)

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
        self._cancel_preload()
        self._idle = False
        self._idle_event.clear()
        self._pending = None
        self.generation += 1
        self._header_chunks = []
        self._header_chunks_done = False
        self._wave_peaks.clear()
        self._close_all_listeners()

    # ---- the actual pipeline ----------------------------------------------
    # Runs for an entire GENERATION, not just one track: as long as tracks
    # keep advancing naturally (queue autoplay), this stays in ONE av.open
    # session and just keeps muxing more Opus packets into it — that's
    # what makes the transition gapless (no new container, no generation
    # bump, no listener reconnect). It only returns (ending the
    # generation) when the queue truly runs dry or something external
    # bumps `generation` out from under it (explicit play/skip/seek/
    # filters, which go through start_track instead).
    async def _run(self, track, position_ms, filters, my_generation):
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
            self.stats["sessions_started"] += 1

            cur_track, cur_pos, cur_filters = track, position_ms, filters
            retry_count = 0
            while True:
                if self.generation != my_generation:
                    return
                self._idle = False
                # NOTE: prefetching whatever plays after cur_track is kicked
                # off from inside _pump_track itself, right after it claims
                # (or rules out) any preload matching cur_track — see the
                # comment there for why it can't happen here.

                result = await self._pump_track(
                    container, stream, cur_track, cur_pos, cur_filters, my_generation
                )
                if self.generation != my_generation:
                    return
                if result == "interrupted":
                    return  # something else already changed the session

                if result == "error":
                    # The NodeLink connection dropped or timed out mid-track
                    # (e.g. the host paused long enough that it went stale —
                    # see NODELINK_STREAM_TIMEOUT above for the fix on new
                    # connections, this handles ones that die anyway).
                    # Reconnect at the current position instead of leaving
                    # the whole lobby silently stuck — same container/
                    # generation, so listeners don't even notice a reconnect
                    # happened besides a brief stutter.
                    retry_count += 1
                    if retry_count > 5:
                        await broadcast(self.lobby, "chat", {
                            "system": True,
                            "text": "Playback connection kept failing — try skipping or replaying the track.",
                            "ts": time.time() * 1000,
                        })
                        self.lobby.paused = True
                        await broadcast(self.lobby, "state", self.lobby.public_state())
                        return
                    print(f"[relay {self.lobby.code}] stream error, reconnecting (attempt {retry_count})")
                    await asyncio.sleep(min(0.5 * retry_count, 3.0))
                    if self.generation != my_generation:
                        return
                    cur_pos = self.lobby.current_position_ms()
                    continue  # retry the SAME track from the recovered position

                retry_count = 0  # that track segment streamed cleanly
                nxt = await self._advance_for_gapless(my_generation)
                if self.generation != my_generation:
                    return
                if nxt is not None:
                    cur_track, cur_pos, cur_filters = nxt, 0, self.lobby.filters
                    continue

                # Queue (and autoplay) are genuinely empty. The OLD behaviour
                # here flushed the Opus stream and returned, which finalized
                # the Ogg logical bitstream and ended this task — every
                # listener's <audio> connection died right then, mid- (or
                # right at the very end of) whatever was still sitting in
                # their own playback buffer, which is what made the last
                # track of a queue (or a lobby's only track) cut off abruptly
                # a moment before it actually finished.
                #
                # Instead: stay right here. Container stays open, task stays
                # alive, generation doesn't change, nobody reconnects. Waking
                # every IDLE_KEEPALIVE_SECONDS and letting _feed_silence make
                # up exactly however much real time has passed keeps a
                # listener's <audio> buffer continuously topped up at 1x (so
                # idle never itself sounds like a dropout, and never builds
                # up a backlog either) and keeps the Ogg bitstream + the
                # connection warm through any reverse-proxy idle-read timeout.
                # resume_or_start() is what wakes this back up — see
                # lobby_play / queue/add.
                self._idle = True
                self._cancel_preload()  # nothing to predict past — re-established on resume
                self._idle_event.clear()
                while True:
                    if self.generation != my_generation:
                        return
                    try:
                        await asyncio.wait_for(self._idle_event.wait(), timeout=IDLE_KEEPALIVE_SECONDS)
                        break  # woken by resume_or_start with a real track queued in self._pending
                    except asyncio.TimeoutError:
                        if self.generation != my_generation:
                            return
                        self._feed_silence(container, stream)
                if self.generation != my_generation:
                    return
                cur_track, cur_pos, cur_filters = self._pending
                self._pending = None
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

    async def _pump_track(self, container, stream, track, position_ms, filters, my_generation):
        """Streams ONE track's PCM into the ongoing Opus/Ogg mux session.
        Returns "ended" if the track's audio source ended naturally (caller
        should advance to whatever's next), "interrupted" if the session
        changed out from under it (caller should stop silently — something
        else, e.g. an explicit skip, is already handling it), or "error" if
        the NodeLink connection itself failed/dropped (caller should
        reconnect and retry rather than treating it like a real track end)."""
        pcm_buf = bytearray()
        frame_dur = PCM_FRAME_SAMPLES / PCM_RATE  # 20ms
        anchor_corrected = False

        async def flush_tail():
            # feed_chunk only ever muxes whole PCM_FRAME_BYTES frames, so
            # whatever's left in pcm_buf when the source genuinely ends
            # (under one frame — under 20ms) never goes through it. Left
            # alone that's silently dropped instead of played, same bug
            # _encode_pcm_blocking already pads around for downloads (see
            # its "remainder" handling) — pad it out to a full frame with
            # silence and mux it here so a track's last few milliseconds
            # actually reach listeners instead of being cut short.
            if not pcm_buf:
                return
            frame_bytes = bytes(pcm_buf) + bytes(PCM_FRAME_BYTES - len(pcm_buf))
            pcm_buf.clear()
            frame = self._pcm_to_frame(frame_bytes)
            for pkt in stream.encode(frame):
                container.mux(pkt)
            self._header_chunks_done = True

        async def feed_chunk(chunk):
            nonlocal anchor_corrected
            pcm_buf.extend(chunk)
            while len(pcm_buf) >= PCM_FRAME_BYTES:
                frame_bytes = bytes(pcm_buf[:PCM_FRAME_BYTES])
                del pcm_buf[:PCM_FRAME_BYTES]
                frame = self._pcm_to_frame(frame_bytes)
                _t0 = time.monotonic()
                for pkt in stream.encode(frame):
                    container.mux(pkt)
                    try:
                        self.stats["opus_bytes_out"] += pkt.size
                    except Exception:
                        pass
                self.stats["encode_ms"].append((time.monotonic() - _t0) * 1000)
                self.stats["frames_encoded"] += 1
                self.stats["pcm_bytes_in"] += len(frame_bytes)
                self.stats["last_frame_ts"] = time.time()
                self._header_chunks_done = True

                # Buffered-waveform lookahead — see _wave_push_loop. Only
                # computed at all while someone's actually subscribed
                # (Debug tab open), same "don't run when nobody's
                # watching" rule as the rest of this instrumentation.
                if self._debug_subscribers:
                    peak = float(np.abs(np.frombuffer(frame_bytes, dtype="<i2")).max()) / 32768.0
                    self._wave_peaks.append(peak)

                if not anchor_corrected:
                    # This is the first frame of audio actually ready to
                    # go out for this track/segment — the true moment
                    # `position_ms` becomes "now", not whenever the
                    # play/skip/seek/queue-add command was issued. Every
                    # route that kicks off a track sets the lobby's
                    # position anchor optimistically right away (so the
                    # UI updates instantly), but fetching from NodeLink —
                    # track lookup, stream negotiation — can easily take
                    # a few seconds, during which that optimistic anchor
                    # just keeps ticking with nothing actually playing
                    # yet. That's what caused the progress bar to open
                    # already several seconds in instead of at 0:00.
                    # Correcting it here, the instant real audio is
                    # actually ready, fixes that for every path that
                    # reaches this loop — explicit plays, skips, seeks,
                    # retries after a dropped connection, and gapless
                    # natural advances alike.
                    anchor_corrected = True
                    self.lobby.position_anchor_ms = position_ms
                    self.lobby.anchor_time = time.time()
                    await broadcast(self.lobby, "state", self.lobby.public_state())

                # Real-time pacing: sleep to an absolute deadline rather
                # than a fixed `sleep(0.02)`. A fixed sleep only measures
                # its OWN duration — it says nothing about how long the
                # encode/mux/write above just took, so that overhead is
                # pure, uncorrected drift that compounds every iteration
                # (the classic cause of a live relay slowly falling
                # behind real time until listeners' buffers run dry).
                # Scheduling against a deadline means any overhead just
                # eats into the next sleep instead of extending the total.
                now = time.monotonic()
                if self._pace_next is None or now - self._pace_next > frame_dur * 2:
                    # First frame of a session, or a big gap since the
                    # last one (pause/seek/idle->active) — start a fresh
                    # schedule from now rather than firehosing frames to
                    # "catch up" a backlog that was never really owed.
                    self._pace_next = now
                self._pace_next += frame_dur
                delay = self._pace_next - now
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    self.stats["pace_drift_ms"].append(-delay * 1000)

        # Prefer an already-running preload for this exact track. Only
        # applies at position 0 — explicit seeks/skips always take the
        # live-fetch path below since those go through start_track (a
        # fresh generation), never through this natural-advance loop.
        pre = self._preload
        use_preload = (
            pre is not None and position_ms == 0
            and pre["track"].get("encoded") == track.get("encoded")
        )
        if use_preload:
            self._preload = None  # this track is live now, not "next" anymore

        # Now that `track`'s own preload (if any) has been claimed above —
        # so a fresh prediction below can't cancel it out from under us —
        # it's safe to start prefetching whatever plays AFTER `track`.
        # `self.lobby.current_track` already equals `track` here (every
        # caller sets it before invoking us), so ensure_preload()'s
        # prediction correctly looks one track further ahead rather than
        # re-predicting `track` itself. Calling this any earlier (at the
        # top of _run's loop, or right when lobby.current_track was first
        # set to `track`) raced with the claim above and kept cancelling
        # the very preload this function was about to consume — which is
        # why the Debug tab's preload stat read "nothing preloaded" even
        # with Gapless on, and every transition fell through to a blocking
        # live NodeLink fetch instead.
        self.ensure_preload()

        if use_preload:
            idx = 0
            try:
                while True:
                    if self.generation != my_generation:
                        return "interrupted"
                    await self._resume_event.wait()
                    if self.generation != my_generation:
                        return "interrupted"
                    if idx < len(pre["chunks"]):
                        await feed_chunk(pre["chunks"][idx])
                        idx += 1
                    elif pre["done"]:
                        break
                    else:
                        await asyncio.sleep(0.02)  # preload still catching up to real time
            except asyncio.CancelledError:
                raise
            except Exception:
                traceback.print_exc()
                return "error"
            await flush_tail()
            return "ended"

        # Normal live fetch — first track of a session, or the preload
        # missed/failed/didn't match (still counts as gapless-attempted,
        # just falls back to a live fetch instead of buffered bytes).
        body = {"encodedTrack": track.get("encoded"), "position": round(position_ms)}
        if filters:
            body["filters"] = filters
        try:
            async with http_session.post(f"{NL_HOST}/v4/loadstream", json=body,
                                          headers={"Authorization": NL_PASS},
                                          timeout=NODELINK_STREAM_TIMEOUT) as r:
                if r.status != 200:
                    print(f"[relay {self.lobby.code}] NodeLink loadstream {r.status}: {await r.text()}")
                    return "error"
                async for chunk in r.content.iter_chunked(8192):
                    if self.generation != my_generation:
                        return "interrupted"
                    await self._resume_event.wait()   # blocks here while paused, resumes exactly in place
                    if self.generation != my_generation:
                        return "interrupted"
                    await feed_chunk(chunk)
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError) as e:
            print(f"[relay {self.lobby.code}] NodeLink stream dropped: {e!r}")
            return "error"
        await flush_tail()
        return "ended"

    @staticmethod
    def _pcm_to_frame(raw):
        # Packed/interleaved s16 wants a single plane shaped (1, samples*channels).
        arr = np.frombuffer(raw, dtype="<i2").reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(arr, format="s16", layout="stereo")
        frame.sample_rate = PCM_RATE
        return frame

    def _feed_silence(self, container, stream):
        """Enough digital silence to keep the SAME real-time clock feed_chunk
        uses (self._pace_next) caught up to wall time — muxed exactly like
        real audio, back-to-back with no per-frame sleep between them (it's
        inaudible filler, nothing for a listener to sync against, so there's
        no reason to pace it out one frame at a time the way real audio has
        to be).

        This has to land on exactly 1x real time, not just "some amount
        periodically" — an earlier version of this fed a fixed multi-second
        burst on every wake, which oversupplied relative to wall-clock time.
        That silently built up an ever-growing backlog the whole time the
        queue stayed empty: a listener's <audio> buffer kept getting further
        and further ahead, so after any decently long idle stretch, resuming
        real playback meant sitting through minutes of already-buffered
        silence before reaching the resumed track, at 1x. Computing the
        frame count from self._pace_next instead means exactly as much
        silence is muxed as time has actually elapsed — no drift either way
        — and it's the same clock feed_chunk resumes on, so the handoff back
        to real audio in either direction (silence -> real, real -> silence)
        never has a seam.
        """
        frame_dur = PCM_FRAME_SAMPLES / PCM_RATE
        now = time.monotonic()
        if self._pace_next is None or now - self._pace_next > frame_dur * 2:
            # No schedule yet, or a gap big enough that catching it up
            # would mean firehosing frames that were never really owed
            # (mirrors feed_chunk's identical fallback) — start fresh.
            self._pace_next = now
        frame_count = 0
        while self._pace_next <= now:
            frame_count += 1
            self._pace_next += frame_dur
        if frame_count == 0:
            return
        silent_bytes = bytes(PCM_FRAME_BYTES)
        for _ in range(frame_count):
            for pkt in stream.encode(self._pcm_to_frame(silent_bytes)):
                container.mux(pkt)
        self._header_chunks_done = True

    async def _advance_for_gapless(self, my_generation):
        """A track's audio source just ended naturally. Pop the next one
        off the queue (if any), update the lobby's authoritative state,
        and broadcast it — WITHOUT touching `generation`, so listeners'
        <audio> elements keep playing uninterrupted while the caller
        (`_run`) starts muxing the new track's audio into the very same
        Ogg/Opus session."""
        if self.generation != my_generation:
            return None
        lobby = self.lobby
        nxt = lobby.advance_track()
        if nxt is not None:
            lobby.current_track = nxt
            lobby.position_anchor_ms = 0
            lobby.anchor_time = time.time()
            lobby.paused = False
            await broadcast(lobby, "state", lobby.public_state())
            # NOTE: deliberately NOT calling ensure_preload() here. `nxt`
            # itself may already have a preload sitting ready (fetched
            # while the track that just ended was still playing) — that's
            # exactly what _pump_track is about to consume for `nxt`. Any
            # call to ensure_preload() at this point would predict PAST
            # nxt (lobby.current_track is already nxt, so peek_next_track()
            # answers "what's after nxt", not "what's nxt") and cancel that
            # still-needed preload before it's ever used. _pump_track calls
            # ensure_preload() itself right after claiming nxt's preload,
            # once it's actually safe to look further ahead.
            await populate_recommendations(lobby)
            return nxt
        else:
            lobby.current_track = None
            lobby.paused = True
            await broadcast(lobby, "state", lobby.public_state())
            return None


# ═══════════════════════════════════════════════════════════════════
# Track helpers + the recommendation populator
#
# This is the server-side port of `get_rekt()` from the Discord bot
# (music_lyra.py): when a track starts playing, ask the node for tracks
# like it, drop anything already played or queued, shuffle, and park the
# rest in `lobby.auto_queue`. Autoplay and Smart Shuffle both feed off
# that pool — autoplay drains it when the queue runs dry, Smart Shuffle
# dumps it into the queue on demand.
#
# lava-lyra's Node.get_recommendations() builds these queries; since we
# talk to NodeLink over plain REST here, the same query strings are built
# directly instead of going through the library.
# ═══════════════════════════════════════════════════════════════════
HISTORY_LIMIT = 100
AUTO_QUEUE_LIMIT = 60

# source name (as NodeLink reports it) -> recommendation search prefix
REC_PREFIXES = {
    "spotify": "sprec",
    "deezer": "dzrec",
    "tidal": "tdrec",
    "jiosaavn": "jsrec",
}
YOUTUBE_SOURCES = {"youtube", "youtubemusic", "ytmusic", "youtube_music"}


def track_id(track):
    """Stable per-track identity. `identifier` is the source's own id (video
    id, Spotify id, …) and is what the bot dedupes on; fall back to the
    encoded blob for sources that don't report one."""
    if not track:
        return None
    info = track.get("info") or {}
    return info.get("identifier") or track.get("encoded")


def _track_brief(track):
    """Lightweight {title, author, ...} view of a track for the Debug tab's
    Smart Queue card — deliberately drops `encoded` (can be a large base64
    blob) since this gets sent to every subscribed sid on each stats push."""
    info = (track or {}).get("info") or {}
    return {
        "title": info.get("title"),
        "author": info.get("author"),
        "length": info.get("length"),
        "sourceName": info.get("sourceName"),
    }


def stamp_requester(track, participant):
    """Tag a track with who added it. Fair Queue needs this to know whose
    turn it is, and the queue list shows it as a small chip."""
    if not isinstance(track, dict):
        return track
    if participant:
        track["requester"] = {"id": participant.id, "name": participant.name}
    return track


def requester_key(track):
    req = (track or {}).get("requester") or {}
    return req.get("id") or "__unknown__"


def recommendation_query(track):
    """The identifier to hand /v4/loadtracks to get tracks like this one,
    or None if the source doesn't support recommendations."""
    info = (track or {}).get("info") or {}
    source = (info.get("sourceName") or "").lower().replace(" ", "")
    identifier = info.get("identifier")
    if not identifier:
        return None
    if source in YOUTUBE_SOURCES:
        # YouTube has no rec endpoint — its "radio" playlist (RD + video id)
        # is the equivalent, and loads as a normal playlist.
        return f"https://www.youtube.com/watch?v={identifier}&list=RD{identifier}"
    prefix = REC_PREFIXES.get(source)
    if prefix:
        return f"{prefix}:{identifier}"
    if config.RECOMMEND_FALLBACK_SEARCH and info.get("author"):
        # SoundCloud, Bandcamp, direct URLs, … have no recommendation
        # support at all. Searching the artist is a rough stand-in; it's
        # opt-out via config for anyone who'd rather autoplay just stop.
        return f"ytmsearch:{info['author']}"
    return None


async def fetch_recommendations(track):
    """Returns a list of track dicts similar to `track` (possibly empty)."""
    query = recommendation_query(track)
    if not query:
        return []
    try:
        async with http_session.get(f"{NL_HOST}/v4/loadtracks", params={"identifier": query},
                                     headers={"Authorization": NL_PASS}) as r:
            if r.status != 200:
                return []
            data = await r.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []
    except Exception:
        traceback.print_exc()
        return []

    load_type = (data or {}).get("loadType")
    payload = (data or {}).get("data")
    if load_type == "playlist":
        tracks = (payload or {}).get("tracks") or []
    elif load_type == "search":
        tracks = payload or []
    elif load_type == "track":
        tracks = [payload] if payload else []
    else:
        tracks = []
    return [t for t in tracks if isinstance(t, dict) and t.get("encoded")]


async def populate_recommendations(lobby, seed=None, broadcast_state=True):
    """Refill `lobby.auto_queue` from whatever is playing. Safe to call on
    every track change — it's a no-op while a fetch is already in flight."""
    if lobby.autoplay == "disabled":
        return 0
    if lobby.rec_task and not lobby.rec_task.done():
        return 0
    seed = seed or lobby.current_track
    if not seed:
        return 0

    async def run():
        recs = await fetch_recommendations(seed)
        if not recs:
            return
        random.shuffle(recs)
        played, queued = lobby._played_ids(), lobby._queued_ids()
        have = {track_id(t) for t in lobby.auto_queue}
        for t in recs:
            if len(lobby.auto_queue) >= AUTO_QUEUE_LIMIT:
                break
            tid = track_id(t)
            if tid in played or tid in queued or tid in have:
                continue
            have.add(tid)
            t.setdefault("requester", {"id": "__auto__", "name": "Autoplay"})
            lobby.auto_queue.append(t)
        if broadcast_state and lobby.code in LOBBIES:
            await broadcast(lobby, "state", lobby.public_state())

    lobby.rec_task = asyncio.create_task(run())
    return 1


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

        # ---- queue behaviour (mirrors the standalone client's own S.loopMode
        # / S.autoplay / S.history / S.autoQueue, and the bot's Queue +
        # auto_queue + history_queue triple in music_lyra.py) --------------
        self.loop_mode = "none"        # 'none' | 'track' | 'queue'
        self.autoplay = "enabled"      # 'enabled' | 'partial' | 'disabled'
        self.history = []              # tracks that already played, newest last
        self.auto_queue = []           # recommendation pool (get_rekt equivalent)
        self.rec_task = None           # in-flight recommendation fetch

        # Gapless preload — shared lobby-wide, host-controlled (see the
        # /gapless route), mirrors the standalone client's own toggle.
        # Off by default, same as standalone. See LobbyRelay.ensure_preload.
        self.gapless = False

        self.relay = LobbyRelay(self)

    def current_position_ms(self):
        if self.paused or not self.current_track:
            return self.position_anchor_ms
        elapsed = (time.time() - self.anchor_time) * 1000
        return self.position_anchor_ms + elapsed

    # ---- queue rules ---------------------------------------------------
    # peek_next_track() and advance_track() are a matched pair: the first
    # answers "what plays after this one" without touching anything (used by
    # the relay's gapless prefetch), the second actually performs that move.
    # They MUST agree, which is why they're one place instead of scattered
    # through the endpoints — same reason engine.js keeps _computeNextTrack
    # and _advanceQueueState side by side for standalone mode.
    def _played_ids(self):
        ids = {track_id(t) for t in self.history}
        ids.discard(None)
        return ids

    def _queued_ids(self):
        ids = {track_id(t) for t in self.queue}
        ids.add(track_id(self.current_track))
        ids.discard(None)
        return ids

    def next_auto_track(self):
        """First recommendation that isn't already played or queued — the
        non-mutating counterpart of drain_auto_queue()."""
        if self.autoplay != "enabled":
            return None
        played, queued = self._played_ids(), self._queued_ids()
        for t in self.auto_queue:
            tid = track_id(t)
            if tid not in played and tid not in queued:
                return t
        return None

    def drain_auto_queue(self):
        """Move every still-eligible recommendation into the real queue and
        empty the pool — same shape as queue_on_end()'s autoplay branch in
        youtubeplayer_lyra.py."""
        if self.autoplay != "enabled" or not self.auto_queue:
            return 0
        played = self._played_ids()
        moved = 0
        for t in self.auto_queue:
            tid = track_id(t)
            if tid is None or (tid not in played and tid not in self._queued_ids()):
                self.queue.append(t)
                moved += 1
        self.auto_queue = []
        return moved

    def peek_next_track(self):
        if self.loop_mode == "track" and self.current_track:
            return self.current_track
        if self.queue:
            return self.queue[0]
        if self.loop_mode == "queue" and self.current_track:
            return self.current_track  # wraps to itself once the queue drains
        return self.next_auto_track()

    def advance_track(self, *, skip_track_loop=False):
        """Consume whatever should play next and return it (or None if the
        lobby should go idle). `skip_track_loop` is for an explicit skip —
        "repeat one" shouldn't trap a user who deliberately pressed next."""
        finished = self.current_track
        if self.loop_mode == "track" and finished and not skip_track_loop:
            return finished
        if finished:
            self.history.append(finished)
            del self.history[:-HISTORY_LIMIT]
        if self.loop_mode == "queue" and finished:
            self.queue.append(finished)
        if not self.queue:
            self.drain_auto_queue()
        if self.queue:
            return self.queue.pop(0)
        return None

    def previous_track(self):
        """Step backwards through history, pushing the current track back to
        the front of the queue so nothing is lost."""
        if not self.history:
            return None
        prev = self.history.pop()
        if self.current_track:
            self.queue.insert(0, self.current_track)
        return prev

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
            "loopMode": self.loop_mode,
            "autoplay": self.autoplay,
            "autoQueueCount": len(self.auto_queue),
            "historyCount": len(self.history),
            "gapless": self.gapless,
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


# The catch-all below serves the frontend out of the project root, which is
# also where the server's own files live — so it would happily hand out
# config.py (containing NODELINK_PASSWORD) and skins.json (containing every
# author's edit token) to anyone who asked for them by name. Only the
# directories and file types the browser actually needs get through.
STATIC_ALLOWED_DIRS = ("css/", "js/", "assets/", "img/", "fonts/")
STATIC_ALLOWED_SUFFIXES = (".css", ".js", ".map", ".png", ".jpg", ".jpeg", ".gif",
                           ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".html")


@app.route("/<path:path>")
async def static_files(path):
    norm = path.replace("\\", "/").lstrip("/")
    if ".." in norm:
        return jsonify({"error": "not found"}), 404
    in_allowed_dir = norm.startswith(STATIC_ALLOWED_DIRS)
    allowed_suffix = norm.lower().endswith(STATIC_ALLOWED_SUFFIXES)
    if not (in_allowed_dir and allowed_suffix) and not (
        "/" not in norm and allowed_suffix
    ):
        return jsonify({"error": "not found"}), 404
    return await send_from_directory(STATIC_DIR, norm)


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
                                      headers={"Authorization": NL_PASS},
                                      timeout=NODELINK_STREAM_TIMEOUT) as r:
            async for chunk in r.content.iter_chunked(8192):
                if chunk:
                    yield chunk

    return Response(gen(), mimetype="application/octet-stream")


# ═══════════════════════════════════════════════════════════════════
# Track download — full-track, one-shot, from position 0 regardless of
# where playback currently is. Reuses the same PCM constants as
# LobbyRelay (above) but none of its real-time pacing/gapless machinery:
# a download just wants the whole file as fast as possible, not a live
# feed. Available from BOTH standalone and lobby mode — this route lives
# on the Quart server, and Backend.serverUrl (see api.js) is set on boot
# regardless of which playback mode is active, same as the skin/
# visualizer galleries.
# ═══════════════════════════════════════════════════════════════════
DOWNLOAD_FORMATS = {
    "opus": {"mime": "audio/ogg", "ext": "ogg"},
    "mp3":  {"mime": "audio/mpeg", "ext": "mp3"},
    "wav":  {"mime": "audio/wav", "ext": "wav"},
}


async def _fetch_full_pcm(encoded_track):
    """Pulls an entire track's raw PCM from NodeLink in one go — no
    pacing, no chunk-by-chunk playback scheduling, just read as fast as
    the connection allows."""
    body = {"encodedTrack": encoded_track, "position": 0}
    buf = bytearray()
    async with http_session.post(f"{NL_HOST}/v4/loadstream", json=body,
                                  headers={"Authorization": NL_PASS},
                                  timeout=NODELINK_STREAM_TIMEOUT) as r:
        if r.status != 200:
            raise RuntimeError(f"NodeLink loadstream {r.status}: {await r.text()}")
        async for chunk in r.content.iter_chunked(65536):
            buf.extend(chunk)
    return bytes(buf)


def _pcm_to_wav_bytes(pcm_bytes):
    """Wraps raw s16le/48kHz/stereo PCM in a standard WAV header — no
    re-encoding needed, just the 44-byte RIFF/fmt/data header in front,
    with exact sizes since we have the whole buffer already."""
    channels, bits = PCM_CHANNELS, 16
    byte_rate = PCM_RATE * channels * bits // 8
    block_align = channels * bits // 8
    data_size = len(pcm_bytes)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, channels, PCM_RATE, byte_rate, block_align, bits,
        b"data", data_size,
    )
    return header + pcm_bytes


def _encode_pcm_blocking(pcm_bytes, codec, container_fmt, bitrate):
    """CPU-bound PyAV encode of a full PCM buffer into an in-memory
    container. Run via asyncio.to_thread — this blocks the thread it
    runs on for the whole track's encode, which would stall the event
    loop (and every lobby's relay) if called directly from a route."""
    # Pad the tail to a whole number of frames with silence rather than
    # truncating — losing up to ~20ms is inaudible, losing part of the
    # actual last frame's audio isn't.
    remainder = len(pcm_bytes) % PCM_FRAME_BYTES
    if remainder:
        pcm_bytes = pcm_bytes + b"\x00" * (PCM_FRAME_BYTES - remainder)

    buf = io.BytesIO()
    container = av.open(buf, mode="w", format=container_fmt)
    stream = container.add_stream(codec, rate=PCM_RATE)
    stream.layout = "stereo"
    if bitrate:
        stream.bit_rate = bitrate
    try:
        for i in range(0, len(pcm_bytes), PCM_FRAME_BYTES):
            frame = LobbyRelay._pcm_to_frame(pcm_bytes[i:i + PCM_FRAME_BYTES])
            for pkt in stream.encode(frame):
                container.mux(pkt)
        for pkt in stream.encode(None):  # flush the encoder
            container.mux(pkt)
    finally:
        container.close()
    return buf.getvalue()


def _safe_filename(name):
    name = re.sub(r'[\\/:*?"<>|\r\n]', "", name or "").strip()
    return name[:120] or "track"


@app.route("/api/download")
async def download_track():
    encoded = request.args.get("encodedTrack")
    fmt = (request.args.get("format") or "opus").lower()
    title = request.args.get("title") or "track"
    author = request.args.get("author") or ""
    if not encoded:
        return jsonify({"error": "encodedTrack required"}), 400
    if fmt not in DOWNLOAD_FORMATS:
        return jsonify({"error": "format must be opus, mp3, or wav"}), 400

    try:
        pcm = await _fetch_full_pcm(encoded)
    except (asyncio.TimeoutError, aiohttp.ClientError, RuntimeError) as e:
        return jsonify({"error": f"failed to fetch audio: {e}"}), 502
    if not pcm:
        return jsonify({"error": "empty stream"}), 502

    if fmt == "wav":
        data = _pcm_to_wav_bytes(pcm)
    else:
        codec, container_fmt, bitrate = (
            ("libopus", "ogg", OPUS_BITRATE) if fmt == "opus" else ("libmp3lame", "mp3", 192000)
        )
        try:
            data = await asyncio.to_thread(_encode_pcm_blocking, pcm, codec, container_fmt, bitrate)
        except Exception as e:
            # Most likely cause: this ffmpeg build doesn't have the
            # requested encoder (libmp3lame in particular isn't always
            # bundled) rather than anything wrong with the track itself.
            return jsonify({"error": f"encoding to {fmt} failed: {e}"}), 500

    spec = DOWNLOAD_FORMATS[fmt]
    filename = _safe_filename(f"{author} - {title}" if author else title)
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}.{spec["ext"]}"',
        "Content-Length": str(len(data)),
    }
    return Response(data, mimetype=spec["mime"], headers=headers)


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
    NODELINK_DEBUG_SUBSCRIBERS.discard(sid)
    info = _sid_registry.pop(sid, None)
    if not info:
        return
    code, client_id = info
    lobby = get_lobby_or_404(code)
    if not lobby:
        return
    lobby.relay.debug_unsubscribe(sid)
    sids = lobby.sids.get(client_id)
    if sids:
        sids.discard(sid)
    # Don't remove the participant yet — this may just be a reconnect
    # (tab backgrounded, brief network blip, etc). See
    # _schedule_disconnect_check, which double-checks after a grace
    # period whether a new sid ever showed up for this client_id.
    asyncio.create_task(_schedule_disconnect_check(lobby, client_id))


# The Debug tab subscribes to this per-connection (not per-participant —
# a sid disappears on every reconnect, so the client re-subscribes with
# its fresh sid rather than this being tied to clientId/token).
@sio.on("debug_subscribe")
async def socket_debug_subscribe(sid, data):
    data = data or {}
    lobby = get_lobby_or_404((data.get("code") or "").upper())
    if lobby:
        lobby.relay.debug_subscribe(sid)
    NODELINK_DEBUG_SUBSCRIBERS.add(sid)
    # NodeLink requests aren't tied to any one lobby (the http_session is
    # server-wide), so a fresh subscriber gets whatever's already in the
    # log immediately instead of waiting for the next request to happen.
    if nodelink_requests:
        await sio.emit("nodelink_requests_backlog", list(nodelink_requests), room=sid)


@sio.on("debug_unsubscribe")
async def socket_debug_unsubscribe(sid, data):
    data = data or {}
    lobby = get_lobby_or_404((data.get("code") or "").upper())
    if lobby:
        lobby.relay.debug_unsubscribe(sid)
    NODELINK_DEBUG_SUBSCRIBERS.discard(sid)


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

    r = Response(
        gen(),
        mimetype="audio/ogg",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    )
    r.timeout = None # remove 60 sec limit timeout

    return r

@app.route("/api/lobby/<code>/play", methods=["POST"])
async def lobby_play(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if not _require_host(lobby, client_id):
        return jsonify({"error": "host only"}), 403
    # Resuming from true silence (nothing currently playing) reuses the
    # existing /live connection if the relay is still parked idle-alive;
    # interrupting a track that's actively playing still needs a hard
    # restart, since there's a live NodeLink fetch to abandon mid-stream.
    was_idle = lobby.current_track is None
    if lobby.current_track:
        lobby.history.append(lobby.current_track)
        del lobby.history[:-HISTORY_LIMIT]
    lobby.current_track = stamp_requester(data.get("track"), lobby.participants.get(client_id))
    lobby.paused = False
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    if was_idle:
        await lobby.relay.resume_or_start(lobby.current_track, 0, lobby.filters)
    else:
        await lobby.relay.start_track(lobby.current_track, 0, lobby.filters)
    await populate_recommendations(lobby)
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
    # skip_track_loop: pressing next under "repeat one" should move on, not
    # replay the same track forever. Everything else (repeat all re-queuing
    # the finished track, autoplay topping up an empty queue) applies here
    # exactly as it does on a natural track end.
    nxt = lobby.advance_track(skip_track_loop=True)
    if nxt is not None:
        lobby.current_track = nxt
        lobby.position_anchor_ms = 0
        lobby.anchor_time = time.time()
        lobby.paused = False
        await lobby.relay.start_track(lobby.current_track, 0, lobby.filters)
        await populate_recommendations(lobby)
    else:
        lobby.current_track = None
        lobby.paused = True
        await lobby.relay.stop()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/stop", methods=["POST"])
async def lobby_stop(code):
    """Host-only: stop playback outright and clear the queue, along with
    the recommendation pool behind Autoplay/Smart Shuffle (auto_queue).
    Unlike skip, this does NOT advance to whatever's next — it mirrors
    standalone mode's Stop button (Engine.stop() there empties
    S.current/S.queue/S.autoQueue)."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.current_track = None
    lobby.queue = []
    lobby.auto_queue = []
    lobby.paused = True
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    await lobby.relay.stop()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/prev", methods=["POST"])
async def lobby_prev(code):
    """Step back to the previously played track. Lobby mode used to have no
    history at all, so the client just refused; now the server keeps one and
    the button works the same way it does standalone."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    prev = lobby.previous_track()
    if prev is None:
        return jsonify({"error": "no previous track"}), 400
    was_idle = lobby.current_track is None
    lobby.current_track = prev
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    lobby.paused = False
    if was_idle:
        await lobby.relay.resume_or_start(prev, 0, lobby.filters)
    else:
        await lobby.relay.start_track(prev, 0, lobby.filters)
    await populate_recommendations(lobby)
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/loop", methods=["POST"])
async def lobby_loop(code):
    """Host-only: 'none' | 'track' (repeat one) | 'queue' (repeat all)."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    mode = data.get("mode")
    if mode not in ("none", "track", "queue"):
        return jsonify({"error": "bad mode"}), 400
    lobby.loop_mode = mode
    # What plays next just changed, so whatever the relay prefetched may be
    # the wrong track now.
    lobby.relay.ensure_preload()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/autoplay", methods=["POST"])
async def lobby_autoplay(code):
    """Host-only: 'enabled' (fill the queue with recommendations when it runs
    dry), 'partial' (keep collecting recommendations but never auto-queue
    them — Smart Shuffle still works), or 'disabled'."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    mode = data.get("mode")
    if mode not in ("enabled", "partial", "disabled"):
        return jsonify({"error": "bad mode"}), 400
    lobby.autoplay = mode
    if mode == "disabled":
        lobby.auto_queue = []
    else:
        await populate_recommendations(lobby, broadcast_state=False)
    lobby.relay.ensure_preload()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/gapless", methods=["POST"])
async def lobby_gapless(code):
    """Host-only: turn the relay's gapless preload/splice on or off for
    the whole lobby — mirrors the standalone client's own Gapless toggle
    (Engine.toggleGapless), except this one is shared state instead of a
    per-client preference, same as loop mode and autoplay. Off doesn't
    force a hard reconnect at each track boundary (the Ogg/Opus session
    stays open either way — see LobbyRelay._run) — it just stops
    prefetching the next track ahead of time, so a natural advance has to
    open a fresh NodeLink connection right at the boundary instead of
    already having bytes buffered, which is what makes the transition
    non-instant."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    lobby.gapless = bool(data.get("enabled"))
    lobby.relay.ensure_preload()  # ON: start prefetching now; OFF: drop whatever was in flight
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


@app.route("/api/lobby/<code>/settings", methods=["POST"])
async def lobby_settings(code):
    """Host-only: rename the lobby and/or flip its public/private
    visibility — the settings previously only settable at creation time,
    now editable any time from the Config tab."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    if "name" in data:
        name = (data.get("name") or "").strip()[:40]
        if name:
            lobby.name = name
    if "isPublic" in data:
        lobby.is_public = bool(data.get("isPublic"))
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/rename", methods=["POST"])
async def lobby_rename(code):
    """Anyone can change their OWN display name — not host-gated."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    p = lobby.participants.get(client_id)
    if not p:
        return jsonify({"error": "not in lobby"}), 403
    new_name = (data.get("displayName") or "").strip()[:24]
    if new_name and new_name != p.name:
        old_name = p.name
        p.name = new_name
        await broadcast(lobby, "participants", lobby.participant_list())
        await broadcast(lobby, "chat", {
            "system": True,
            "text": f"{old_name} is now known as {new_name}",
            "ts": time.time() * 1000,
        })
    return jsonify({"ok": True, "displayName": p.name})


@app.route("/api/lobby/<code>/queue/add", methods=["POST"])
async def lobby_queue_add(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if client_id not in lobby.participants:
        return jsonify({"error": "not in lobby"}), 403
    track = stamp_requester(data.get("track"), lobby.participants.get(client_id))
    if not lobby.current_track:
        lobby.current_track = track
        lobby.paused = False
        lobby.position_anchor_ms = 0
        lobby.anchor_time = time.time()
        await lobby.relay.resume_or_start(lobby.current_track, 0, lobby.filters)
        await populate_recommendations(lobby)
    else:
        lobby.queue.append(track)
        lobby.relay.ensure_preload()  # queue may have just gone from empty -> non-empty
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/queue/add_bulk", methods=["POST"])
async def lobby_queue_add_bulk(code):
    """Same as queue/add, but for a whole list of tracks in one request —
    used by "+ Add All" on a playlist result so the client fires a single
    call instead of one per track. Mirrors queue/add's logic (first track
    becomes current_track if nothing is playing, rest go on the queue) but
    only starts playback / kicks off preload / broadcasts once at the end."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if client_id not in lobby.participants:
        return jsonify({"error": "not in lobby"}), 403
    tracks = data.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        return jsonify({"error": "no tracks"}), 400
    participant = lobby.participants.get(client_id)
    tracks = [stamp_requester(t, participant) for t in tracks]

    started_playback = False
    if not lobby.current_track:
        lobby.current_track = tracks[0]
        lobby.queue.extend(tracks[1:])
        lobby.paused = False
        lobby.position_anchor_ms = 0
        lobby.anchor_time = time.time()
        started_playback = True
    else:
        lobby.queue.extend(tracks)

    if started_playback:
        await lobby.relay.resume_or_start(lobby.current_track, 0, lobby.filters)
        await populate_recommendations(lobby, broadcast_state=False)
    else:
        lobby.relay.ensure_preload()  # queue may have just gone from empty -> non-empty

    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state, "added": len(tracks)})


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
    if not isinstance(idx, int) or not (0 <= idx < len(lobby.queue)):
        return jsonify({"error": "bad index"}), 400
    # The host can remove anything; everyone else can remove tracks they
    # added themselves. Removing your own mistake shouldn't need the host,
    # and letting anyone clear anyone's picks makes shared queues miserable.
    entry = lobby.queue[idx]
    if not _require_host(lobby, client_id) and requester_key(entry) != client_id:
        return jsonify({"error": "you can only remove tracks you added"}), 403
    lobby.queue.pop(idx)
    lobby.relay.ensure_preload()  # the queue head may have changed
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/queue/shuffle", methods=["POST"])
async def lobby_queue_shuffle(code):
    """Host-only: plain Fisher-Yates over the pending queue. The currently
    playing track is untouched — only what hasn't played yet moves."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    random.shuffle(lobby.queue)
    lobby.relay.ensure_preload()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/queue/clear", methods=["POST"])
async def lobby_queue_clear(code):
    """Host-only: empty the shared queue, and with it the recommendation
    pool behind Autoplay/Smart Shuffle (auto_queue). The current track
    keeps playing — this clears what's lined up behind it, not what's on
    air."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    removed = len(lobby.queue)
    lobby.queue = []
    lobby.auto_queue = []
    lobby.relay.ensure_preload()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "removed": removed, "state": state})


@app.route("/api/lobby/<code>/queue/smart", methods=["POST"])
async def lobby_queue_smart(code):
    """Host-only Smart Shuffle — the port of the bot's `smart` command.
    Tops the recommendation pool up if it's thin, moves up to `count` of
    them into the queue, then shuffles the whole thing so the additions are
    interleaved with what people actually picked rather than tacked on the
    end."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    if not lobby.current_track:
        return jsonify({"error": "nothing playing to base recommendations on"}), 400

    try:
        count = max(1, min(int(data.get("count", 20)), AUTO_QUEUE_LIMIT))
    except (TypeError, ValueError):
        count = 20

    if len(lobby.auto_queue) < count:
        # Fetch inline rather than firing and forgetting: the person pressed
        # a button and is waiting for tracks to appear.
        await populate_recommendations(lobby, broadcast_state=False)
        if lobby.rec_task:
            try:
                await asyncio.wait_for(asyncio.shield(lobby.rec_task), timeout=12)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

    played, queued = lobby._played_ids(), lobby._queued_ids()
    added, leftover = [], []
    for t in lobby.auto_queue:
        tid = track_id(t)
        if len(added) < count and tid not in played and tid not in queued:
            queued.add(tid)
            added.append(t)
        else:
            leftover.append(t)
    lobby.auto_queue = leftover
    lobby.queue.extend(added)
    random.shuffle(lobby.queue)
    lobby.relay.ensure_preload()

    if added:
        await broadcast(lobby, "chat", {
            "system": True,
            "text": f"🔀 Smart Shuffle added {len(added)} recommended track{'s' if len(added) != 1 else ''}",
            "ts": time.time() * 1000,
        })
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "added": len(added), "state": state})


@app.route("/api/lobby/<code>/queue/fair", methods=["POST"])
async def lobby_queue_fair(code):
    """Host-only Fair Queue — round-robins the queue between whoever added
    the tracks, so one person dumping a 40-track playlist doesn't bury
    everyone else. Mirrors the bot's `fair` command, including starting the
    rotation on someone OTHER than whoever's track is currently playing."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    if not lobby.queue:
        return jsonify({"error": "queue is empty"}), 400

    order, by_requester = [], {}
    for t in lobby.queue:
        key = requester_key(t)
        if key not in by_requester:
            order.append(key)
            by_requester[key] = []
        by_requester[key].append(t)

    if len(order) <= 1:
        return jsonify({"ok": True, "changed": False, "state": lobby.public_state()})

    current_key = requester_key(lobby.current_track)
    if current_key in order:
        order.remove(current_key)
        order.append(current_key)  # their turn comes round last

    new_queue = []
    for rnd in range(max(len(v) for v in by_requester.values())):
        for key in order:
            tracks = by_requester[key]
            if rnd < len(tracks):
                new_queue.append(tracks[rnd])
    lobby.queue = new_queue
    lobby.relay.ensure_preload()

    names = []
    for key in order:
        name = (by_requester[key][0].get("requester") or {}).get("name") or "Unknown"
        names.append(f"{name} ({len(by_requester[key])})")
    await broadcast(lobby, "chat", {
        "system": True,
        "text": "⚖️ Queue rebalanced · " + " · ".join(names),
        "ts": time.time() * 1000,
    })
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "changed": True, "state": state})


@app.route("/api/lobby/<code>/queue/move", methods=["POST"])
async def lobby_queue_move(code):
    """Reorders the shared queue — backs drag-and-drop reordering (and,
    by extension, "swapping" two tracks by dropping one onto the other's
    slot) in lobby mode. Host only, like every other queue-mutating
    control besides add."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    from_idx = data.get("fromIndex")
    to_idx = data.get("toIndex")
    if (isinstance(from_idx, int) and isinstance(to_idx, int)
            and 0 <= from_idx < len(lobby.queue) and 0 <= to_idx < len(lobby.queue)
            and from_idx != to_idx):
        item = lobby.queue.pop(from_idx)
        lobby.queue.insert(to_idx, item)
        lobby.relay.ensure_preload()  # the queue head may have changed
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


# ═══════════════════════════════════════════════════════════════════
# Skin gallery
#
# Skins are just a bag of CSS custom properties plus a few layout knobs,
# so they're small, safe-ish to share, and apply instantly client-side.
# Published skins land in skins.json next to this file — flat file rather
# than a database because the whole payload is a few KB per skin and the
# lobby state is already in-memory anyway.
#
# The `css` field is free-form CSS the author wrote, which is the one
# genuinely risky part of accepting skins from strangers: CSS can't run
# JavaScript, but it CAN phone home via url() and it can cover or hide
# interface elements. _sanitize_css strips the worst of it (@import,
# url() pointing anywhere but https, javascript:, expression(), and any
# attempt to break out of the <style> block) and the client re-applies
# the same filter before injecting. Treat community skins the way you'd
# treat any user-submitted content — review before featuring one.
# ═══════════════════════════════════════════════════════════════════
SKINS_FILE = STATIC_DIR / "skins.json"
SKIN_FIELD_LIMIT = 4000
SKINS = {}

_CSS_BANNED = re.compile(
    r"(@import|javascript\s*:|expression\s*\(|</\s*style|behavior\s*:|-moz-binding)",
    re.IGNORECASE,
)
_CSS_URL = re.compile(r"url\(\s*['\"]?([^)'\"]*)['\"]?\s*\)", re.IGNORECASE)


def _sanitize_css(raw):
    if not raw:
        return ""
    css = str(raw)[:SKIN_FIELD_LIMIT]
    css = _CSS_BANNED.sub("", css)

    def _url_ok(m):
        target = (m.group(1) or "").strip()
        if target.startswith("https://") or target.startswith("data:image/"):
            return m.group(0)
        return "none"

    return _CSS_URL.sub(_url_ok, css)


def _clean_skin(payload):
    """Normalise whatever the client sent into the shape we store. Unknown
    keys are dropped rather than passed through."""
    payload = payload or {}
    variables = {}
    for k, v in (payload.get("vars") or {}).items():
        if not isinstance(k, str) or not re.fullmatch(r"[a-z0-9-]{1,32}", k):
            continue
        if isinstance(v, (str, int, float)):
            variables[k] = str(v)[:120]
    opts = {}
    for k, v in (payload.get("opts") or {}).items():
        if isinstance(k, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", k):
            opts[k] = v if isinstance(v, (int, float, bool)) else str(v)[:300]
    return {
        "name": (str(payload.get("name") or "Untitled Skin"))[:40],
        "author": (str(payload.get("author") or "Anonymous"))[:24],
        "vars": variables,
        "opts": opts,
        "css": _sanitize_css(payload.get("css")),
    }


def _load_skins():
    global SKINS
    try:
        if SKINS_FILE.exists():
            SKINS = json.loads(SKINS_FILE.read_text("utf-8"))
    except Exception:
        traceback.print_exc()
        SKINS = {}


def _save_skins():
    try:
        SKINS_FILE.write_text(json.dumps(SKINS, indent=2), "utf-8")
    except Exception:
        traceback.print_exc()


_load_skins()


def _skin_summary(sid, skin):
    return {
        "id": sid,
        "name": skin.get("name"),
        "author": skin.get("author"),
        "vars": skin.get("vars", {}),
        "opts": skin.get("opts", {}),
        "hasCss": bool(skin.get("css")),
        "installs": skin.get("installs", 0),
        "createdAt": skin.get("createdAt"),
    }


@app.route("/api/skins")
async def skins_list():
    sort = request.args.get("sort", "new")
    items = [_skin_summary(sid, s) for sid, s in SKINS.items()]
    if sort == "popular":
        items.sort(key=lambda s: (-(s["installs"] or 0), -(s["createdAt"] or 0)))
    else:
        items.sort(key=lambda s: -(s["createdAt"] or 0))
    return jsonify(items[:200])


@app.route("/api/skins/<sid>")
async def skin_get(sid):
    skin = SKINS.get(sid)
    if not skin:
        return jsonify({"error": "not found"}), 404
    out = _skin_summary(sid, skin)
    out["css"] = skin.get("css", "")
    return jsonify(out)


@app.route("/api/skins", methods=["POST"])
async def skin_publish():
    """Publish a skin to the gallery. Returns an edit token the author keeps
    locally — there are no accounts here, so that token is the only proof of
    authorship for deleting or updating it later."""
    data = await request.get_json(force=True, silent=True) or {}
    skin = _clean_skin(data.get("skin") or data)
    if not skin["vars"] and not skin["css"]:
        return jsonify({"error": "skin is empty"}), 400

    sid = (data.get("id") or "").strip()
    token = (data.get("editToken") or "").strip()
    if sid and sid in SKINS:
        if SKINS[sid].get("editToken") != token:
            return jsonify({"error": "wrong edit token"}), 403
        skin["editToken"] = SKINS[sid]["editToken"]
        skin["createdAt"] = SKINS[sid].get("createdAt", time.time() * 1000)
        skin["installs"] = SKINS[sid].get("installs", 0)
    else:
        sid = uuid.uuid4().hex[:10]
        skin["editToken"] = uuid.uuid4().hex
        skin["createdAt"] = time.time() * 1000
        skin["installs"] = 0

    SKINS[sid] = skin
    _save_skins()
    return jsonify({"ok": True, "id": sid, "editToken": skin["editToken"]})


@app.route("/api/skins/<sid>/delete", methods=["POST"])
async def skin_delete(sid):
    data = await request.get_json(force=True, silent=True) or {}
    skin = SKINS.get(sid)
    if not skin:
        return jsonify({"error": "not found"}), 404
    if skin.get("editToken") != (data.get("editToken") or ""):
        return jsonify({"error": "wrong edit token"}), 403
    SKINS.pop(sid, None)
    _save_skins()
    return jsonify({"ok": True})


@app.route("/api/skins/<sid>/install", methods=["POST"])
async def skin_install(sid):
    """Bumps the install counter — that's what the 'popular' sort reads."""
    skin = SKINS.get(sid)
    if not skin:
        return jsonify({"error": "not found"}), 404
    skin["installs"] = skin.get("installs", 0) + 1
    _save_skins()
    return jsonify({"ok": True, "installs": skin["installs"]})


# ═══════════════════════════════════════════════════════════════════
# Visualizer gallery
#
# Same storage shape as skins, but a fundamentally different trust model
# worth spelling out, because the code below deliberately does NOT try to
# sanitize what it stores.
#
# A skin is CSS and can be filtered. A visualizer is JavaScript, and
# there is no substring blocklist that makes someone else's JavaScript
# safe — anyone who wants past such a filter gets past it, and having one
# mostly just creates false confidence. So this endpoint stores the code
# verbatim and the safety lives entirely on the client: every visualizer
# runs inside <iframe sandbox="allow-scripts"> (opaque origin, no access
# to the page, its storage, or the lobby token) with a CSP of
# `default-src 'none'` (no fetch, no XHR, no beacons). See the header
# comment in js/visualizer.js.
#
# What this server is still on the hook for: size limits, so one person
# can't fill the disk, and the fact that visualizers.json must never be
# served as a static file — it holds every author's edit token. The
# static allowlist below covers that.
# ═══════════════════════════════════════════════════════════════════
VIZ_FILE = STATIC_DIR / "visualizers.json"
VIZ_CODE_LIMIT = 20000
VISUALIZERS = {}


def _clean_viz(payload):
    payload = payload or {}
    return {
        "name": (str(payload.get("name") or "Untitled Visualizer"))[:40],
        "author": (str(payload.get("author") or "Anonymous"))[:24],
        "code": str(payload.get("code") or "")[:VIZ_CODE_LIMIT],
    }


def _load_visualizers():
    global VISUALIZERS
    try:
        if VIZ_FILE.exists():
            VISUALIZERS = json.loads(VIZ_FILE.read_text("utf-8"))
    except Exception:
        traceback.print_exc()
        VISUALIZERS = {}


def _save_visualizers():
    try:
        VIZ_FILE.write_text(json.dumps(VISUALIZERS, indent=2), "utf-8")
    except Exception:
        traceback.print_exc()


_load_visualizers()


def _viz_summary(vid, viz):
    return {
        "id": vid,
        "name": viz.get("name"),
        "author": viz.get("author"),
        "lines": (viz.get("code") or "").count("\n") + 1,
        "installs": viz.get("installs", 0),
        "createdAt": viz.get("createdAt"),
    }


@app.route("/api/visualizers")
async def viz_list():
    sort = request.args.get("sort", "new")
    items = [_viz_summary(vid, v) for vid, v in VISUALIZERS.items()]
    if sort == "popular":
        items.sort(key=lambda v: (-(v["installs"] or 0), -(v["createdAt"] or 0)))
    else:
        items.sort(key=lambda v: -(v["createdAt"] or 0))
    return jsonify(items[:200])


@app.route("/api/visualizers/<vid>")
async def viz_get(vid):
    viz = VISUALIZERS.get(vid)
    if not viz:
        return jsonify({"error": "not found"}), 404
    out = _viz_summary(vid, viz)
    out["code"] = viz.get("code", "")
    return jsonify(out)


@app.route("/api/visualizers", methods=["POST"])
async def viz_publish():
    data = await request.get_json(force=True, silent=True) or {}
    viz = _clean_viz(data.get("viz") or data)
    if not viz["code"].strip():
        return jsonify({"error": "visualizer has no code"}), 400
    if "function draw" not in viz["code"] and "draw =" not in viz["code"]:
        # Not a security check — just catching the common mistake of
        # publishing something that can't possibly render.
        return jsonify({"error": "no draw(ctx, v) function found"}), 400

    vid = (data.get("id") or "").strip()
    token = (data.get("editToken") or "").strip()
    if vid and vid in VISUALIZERS:
        if VISUALIZERS[vid].get("editToken") != token:
            return jsonify({"error": "wrong edit token"}), 403
        viz["editToken"] = VISUALIZERS[vid]["editToken"]
        viz["createdAt"] = VISUALIZERS[vid].get("createdAt", time.time() * 1000)
        viz["installs"] = VISUALIZERS[vid].get("installs", 0)
    else:
        vid = uuid.uuid4().hex[:10]
        viz["editToken"] = uuid.uuid4().hex
        viz["createdAt"] = time.time() * 1000
        viz["installs"] = 0

    VISUALIZERS[vid] = viz
    _save_visualizers()
    return jsonify({"ok": True, "id": vid, "editToken": viz["editToken"]})


@app.route("/api/visualizers/<vid>/delete", methods=["POST"])
async def viz_delete(vid):
    data = await request.get_json(force=True, silent=True) or {}
    viz = VISUALIZERS.get(vid)
    if not viz:
        return jsonify({"error": "not found"}), 404
    if viz.get("editToken") != (data.get("editToken") or ""):
        return jsonify({"error": "wrong edit token"}), 403
    VISUALIZERS.pop(vid, None)
    _save_visualizers()
    return jsonify({"ok": True})


@app.route("/api/visualizers/<vid>/install", methods=["POST"])
async def viz_install(vid):
    viz = VISUALIZERS.get(vid)
    if not viz:
        return jsonify({"error": "not found"}), 404
    viz["installs"] = viz.get("installs", 0) + 1
    _save_visualizers()
    return jsonify({"ok": True, "installs": viz["installs"]})


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
    import uvicorn

    print(f"[NodeLink Lobby Server] NodeLink node: {NL_HOST}")
    print(f"[NodeLink Lobby Server] Voice chat (aiortc): {'enabled' if WEBRTC_AVAILABLE else 'DISABLED — see warning above'}")
    print(f"[NodeLink Lobby Server] Realtime transport: Socket.IO (WebSocket, long-polling fallback)")
    print(f"[NodeLink Lobby Server] Listening on http://{config.FLASK_HOST}:{config.FLASK_PORT}")

    # Quart's own app.run() only serves `app` — the plain Quart/REST
    # layer. Socket.IO is mounted a level above that (see `asgi_app`
    # near the top of this file), so it has to be what actually gets
    # served, or every websocket/polling request 404s.
    uvicorn.run("server:asgi_app", host=config.FLASK_HOST, port=config.FLASK_PORT, reload=True)