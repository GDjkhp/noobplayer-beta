"""
NodeLink Lobby Server (Quart / async)
======================================
Async backend for "Server Mode" — lets multiple browser clients join a
shared lobby and listen to the same music in sync, with text chat.

NOTE: Voice chat has been removed along with WebRTC (see below). Only
music playback and text chat remain in lobby mode.

Why Quart instead of Flask
---------------------------
PyAV's in-process AAC encoding and the NodeLink stream proxy are
naturally expressed as async generators/coroutines, and Quart is an
async-first, (mostly) drop-in replacement for Flask that suits that well —
routes are `async def`, no thread bridge needed for any of it.

Architecture
------------
- Music playback: the server holds *authoritative* playback state per lobby
  (current track, paused/playing, a position anchor + server timestamp,
  queue) AND owns the actual audio pipeline too. For each
  lobby, ONE background task (LobbyRelay, below) pulls raw PCM from
  NodeLink, real-time-paces it, and hands it to a per-lobby QuicPcmRelay,
  which fans the SAME raw s16le/48kHz/stereo frames out to every
  currently-connected listener over its own QUIC/WebTransport session —
  no encoding, no container, no muxing, just the bytes the relay already
  produces written straight onto each listener's dedicated unidirectional
  stream. Every connected client opens a WebTransport session to the
  QUIC listener (see below) and gets the SAME live feed; a slow/absent
  listener never affects the relay itself or any other listener (its
  outbound queue is bounded and just drops the oldest frame if it can't
  keep up — see QuicPcmRelay/WtListener), and a track's actual progress
  no longer depends on any one client's network. NodeLink is fetched once
  per track regardless of listener count, same as before.

  This replaces the earlier HLS design (AAC-encode + rolling .m3u8
  playlist, played back via hls.js) with a raw PCM stream carried over
  QUIC — a listener's audio graph is now just PCMPlayer-style buffer
  scheduling (see WebTransportPlayer in webtransport-player.js) instead
  of an <audio> element + hls.js, and there's no AAC encode step (and no
  PyAV dependency) in the live path at all anymore. QUIC/WebTransport
  needs a TLS handshake (server certs are self-signed and pinned by hash
  — see _make_quic_cert below and GET /api/quic-info) where HLS was
  plain HTTP, but the UDP listener runs on the SAME PORT NUMBER as the
  TCP HTTP server (TCP and UDP ports are independent namespaces, so
  reusing the number is just a convenience — one port to forward/open in
  a firewall, not one shared socket). Listeners still sit a little behind
  the server's authoritative position (network + buffer margin), same
  trade-off HLS had — this is NOT the frame-accurate sync the old WebRTC
  relay had, just a different transport for the same "good enough, no
  signaling" approach.

- State sync + chat: pushed to clients over Socket.IO (WebSocket, with
  automatic long-polling fallback and automatic client-side reconnection).
  Each lobby is a Socket.IO "room" (named after the lobby code); state
  changes are broadcast to that room. A client_id -> set-of-sids map on
  each Lobby tracks which sockets are currently live for a participant,
  which drives the same disconnect-grace-period logic that used to key
  off the old SSE connection (see _schedule_disconnect_check below).
  `public_state()` still includes `relayGen` (bumps on a hard cut —
  skip/seek) for the Debug tab's benefit; playback clients
  don't need to watch it for anything — the QUIC relay just keeps
  flowing across a generation bump, no reconnect needed, same as before.

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
import datetime
import hashlib
import hmac
import io
import json
import os
import random
import re
import string
import struct
import time
import uuid
from fractions import Fraction
import traceback
from collections import deque
from pathlib import Path

import aiohttp
import av
import numpy as np
import socketio
from quart import Quart, Response, jsonify, request, send_from_directory
from quart_cors import cors

# ── QUIC / WebTransport (live lobby audio relay) ──
# See _make_quic_cert / QuicPcmRelay / start_quic_server below. This is
# the ONLY thing that talks raw QUIC in this file — REST, Socket.IO, and
# the static frontend are all still plain HTTP/WebSocket over the normal
# TCP server (asgi_app), untouched by any of this.
from aioquic.asyncio import QuicConnectionProtocol, serve as quic_serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, H3Event, HeadersReceived, WebTransportStreamDataReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated, ProtocolNegotiated, QuicEvent
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

import config
from dotenv import load_dotenv

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
load_dotenv()


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
    # Fire-and-forget: the QUIC/WebTransport listener (see
    # start_quic_server further down) runs as its own UDP server
    # alongside whatever's actually serving `asgi_app` over TCP — it
    # doesn't block the rest of startup, and a failure here (port in
    # use, cert generation failed) is logged rather than crashing the
    # whole process, since REST/Socket.IO/the frontend all work fine
    # without it — only live lobby audio depends on it.
    asyncio.create_task(start_quic_server())


@app.after_serving
async def shutdown():
    if http_session:
        await http_session.close()
    if _quic_server is not None:
        _quic_server.close()


# ═══════════════════════════════════════════════════════════════════
# Live music relay — one continuous PCM pipeline per lobby, fanned out
# raw (no encode, no container) to every listener over its own
# QUIC/WebTransport session. Replaces three earlier designs: per-client
# raw-PCM fetch off NodeLink (a client whose network couldn't sustain
# ~1.5 Mbps would fall behind, get forcibly reseeked by client-side
# drift correction, and could get skipped to the next track entirely
# once the host's own unaffected stream reached the end); a WebRTC relay
# (real UDP transport, but every listener needed a full ICE/DTLS
# handshake and its own RTCPeerConnection, and TURN was required behind
# a restrictive NAT/firewall); and later HLS (AAC-encode + rolling
# .m3u8 playlist over plain HTTP — no signaling, but an encode step and
# a browser-side demuxer/decoder (hls.js) in the loop). QUIC/WebTransport
# sits between the WebRTC and HLS designs: still a real UDP transport
# and no AAC encode (raw PCM straight onto a QUIC stream), but a much
# lighter handshake than full ICE/DTLS — one QUIC connection + one
# WebTransport CONNECT, no STUN/TURN, no per-listener RTCPeerConnection.
#
# The server still does exactly ONE NodeLink fetch per track (not one
# per listener) — every listener's WtListener just gets a copy of the
# SAME raw PCM frames the relay produces, so the PCM itself is only
# ever produced once regardless of listener count, same cost profile
# the WebRTC relay and HLS both had.
# ═══════════════════════════════════════════════════════════════════
PCM_RATE = 48000
PCM_CHANNELS = 2
PCM_FRAME_SAMPLES = 960                                     # 20ms @ 48kHz
PCM_FRAME_BYTES = PCM_FRAME_SAMPLES * PCM_CHANNELS * 2      # s16le
OPUS_BITRATE = 96000   # still used by the separate full-track /api/download encoder (see _encode_pcm_blocking) — unrelated to the live relay now

# How many 20ms frames a single listener's outbound queue holds before
# WtListener starts dropping the OLDEST queued frame rather than growing
# without bound. ~4s of slack: generous enough to absorb a brief stall
# (a GC pause, a wifi hiccup) without an audible glitch, but bounded so a
# listener whose network genuinely can't keep up drifts back toward the
# live edge instead of building an ever-growing backlog that would just
# mean they hear everything increasingly late forever. Mirrors the
# "a slow HTTP GET only affects itself" property the old HLSMuxer/WebRTC
# designs had — see WtListener.push.
WT_LISTENER_QUEUE_FRAMES = 200

# How often the idle loop wakes to top up silence while the queue is
# empty. This used to be a single 20ms frame every 15 seconds — fine back
# when this was one long-held streaming connection per listener (an idle
# one risked a reverse-proxy idle-read timeout), but it meant that the
# INSTANT a track ended with nothing queued, every listener's playback
# buffer (which typically only has a second or so of real margin, same
# as during normal playback) ran completely dry and sat there with
# literally nothing arriving for up to 15 seconds. That's what made "no
# next track" sound like the song itself got cut off, instead of the
# smooth, uninterrupted continuation a queued next track gets (there's
# never a gap in that case — real audio just keeps flowing). Waking far
# more often bounds that worst-case gap to something a listener's buffer
# margin can absorb. _feed_silence itself always makes up exactly however
# much wall-clock time has actually elapsed (see its own comment) — this
# constant only controls how promptly it's given the chance to do that,
# not how much silence gets fed.
IDLE_KEEPALIVE_SECONDS = 1.0


# ── QUIC / WebTransport listener plumbing ──
#
# One WtListener per connected browser tab's WebTransport session for a
# lobby. A session is accepted (see LobbyQuicProtocol._handle_connect
# below) by opening ONE unidirectional QUIC stream from server to client
# right away and handing it to a QuicPcmRelay, which just keeps writing
# the same raw PCM frames onto it that LobbyRelay's real-time pacing loop
# produces — no reconnect, no renegotiation, for the listener's entire
# time in the lobby, exactly like re-requesting the same rolling .m3u8
# used to work, just over one persistent stream instead of repeated GETs.
class WtListener:
    """A dedicated writer task + bounded queue decouple 'the relay just
    produced a frame' from 'this listener's QUIC stream can currently
    accept more data' — push() (called from the relay's own task) never
    blocks, and a listener that can't keep up only ever hurts itself (see
    WT_LISTENER_QUEUE_FRAMES)."""

    def __init__(self, protocol, session_id):
        self.protocol = protocol
        self.session_id = session_id
        # is_unidirectional=True: this stream only ever carries
        # server->client audio bytes. Nothing is ever expected back on
        # it — playback control (play/pause/skip/seek) all still goes
        # through the existing REST + Socket.IO channels, untouched by
        # any of this.
        self.stream_id = protocol.http.create_webtransport_stream(session_id, is_unidirectional=True)
        self.queue = asyncio.Queue(maxsize=WT_LISTENER_QUEUE_FRAMES)
        self.closed = False
        self._task = asyncio.create_task(self._writer())

    def push(self, pcm_bytes):
        if self.closed:
            return
        try:
            self.queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            # Drop the oldest queued frame, not the new one — keeps this
            # listener as close to the live edge as its network allows
            # instead of accumulating an ever-growing lag.
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(pcm_bytes)
            except asyncio.QueueFull:
                pass

    async def _writer(self):
        try:
            while True:
                chunk = await self.queue.get()
                if self.closed:
                    return
                self.protocol._quic.send_stream_data(self.stream_id, chunk)
                self.protocol.transmit()
        except asyncio.CancelledError:
            pass
        except Exception:
            traceback.print_exc()

    def close(self):
        self.closed = True
        if self._task and not self._task.done():
            self._task.cancel()


class QuicPcmRelay:
    """Fans the real-time-paced PCM the relay produces (see
    LobbyRelay.feed_chunk / _feed_silence) out to every WtListener
    currently connected for this lobby, Opus-encoded ONCE here (one
    encoder per lobby, not per listener).

    Wire format on each listener's single unidirectional stream: a
    sequence of [uint16 BE length][payload], where payload[0] is a type:
      0x00  Opus packet (20ms) — payload[1:] is the packet
      0x01  TIMELINE sync — [flags u8][positionMs f64 BE]
              positionMs = track position of the NEXT audio packet that
                           follows this message in the stream
              flags bit0 = running (position advances in real time from
                           there; clear = paused/idle/loading, frozen)
              flags bit1 = cut (discard every buffered-but-unplayed
                           sample: a skip/seek/stop)
    The client never guesses position or pause state: it plays whatever
    arrives and reads the timeline off the stream. Pausing is done HERE
    — the relay keeps streaming silence with running=False — so the
    client never suspends its AudioContext and never has stale buffers
    to play out on resume.

    One instance per lobby, created once at Lobby creation and kept
    alive for the lobby's entire life — close() is only called when the
    whole lobby goes away (see LobbyRelay.shutdown)."""

    SYNC_EVERY_FRAMES = 50      # re-assert the timeline every ~1s (heals dropped/late packets, clock drift)
    STALL_SECONDS = 0.08        # gap since last push that forces a fresh sync (source stalled, then resumed)

    def __init__(self, code):
        self.code = code
        self.listeners = set()
        self.bytes_out = 0          # encoded bytes produced (per-listener wire cost)
        self.pos_ms = 0.0           # track position of the next audio frame
        self.running = False        # is that position advancing in real time?
        self._since_sync = 0
        self._last_push = None
        self._pts = 0
        self._enc = None
        self.ok = False
        try:
            ctx = av.CodecContext.create("libopus", "w")
            ctx.sample_rate = PCM_RATE
            ctx.layout = "stereo"
            ctx.format = "s16"
            ctx.bit_rate = int(getattr(config, "QUIC_OPUS_BITRATE", 160000))
            ctx.time_base = Fraction(1, PCM_RATE)
            ctx.options = {"application": "audio", "frame_duration": "20", "vbr": "on"}
            ctx.open()
            self._enc = ctx
            self.ok = True
        except Exception:
            print(f"[quic {code}] failed to open libopus encoder — lobby audio will not work (does this PyAV/ffmpeg build include libopus?)")
            traceback.print_exc()

    @staticmethod
    def _sync_packet(pos_ms, running, cut):
        flags = (1 if running else 0) | (2 if cut else 0)
        payload = b"\x01" + struct.pack(">Bd", flags, float(pos_ms))
        return struct.pack(">H", len(payload)) + payload

    def _broadcast(self, framed):
        for listener in list(self.listeners):
            listener.push(framed)

    def set_timeline(self, pos_ms, running, cut=False):
        """Declare where the NEXT audio frame sits on the track timeline.
        Call BEFORE pushing the frame it describes."""
        self.pos_ms = float(pos_ms)
        self.running = bool(running)
        self._since_sync = 0
        self._broadcast(self._sync_packet(self.pos_ms, self.running, cut))

    def add_listener(self, listener):
        self.listeners.add(listener)
        # A joiner needs the timeline before its first audio packet.
        listener.push(self._sync_packet(self.pos_ms, self.running, False))

    def remove_listener(self, listener):
        self.listeners.discard(listener)
        listener.close()

    def push(self, pcm_bytes, silence=False):
        """Called by the relay for every 20ms PCM frame. `silence=True`
        frames (idle / paused filler) never advance the track timeline."""
        if not self.ok:
            return
        now = time.monotonic()
        stalled = self._last_push is not None and now - self._last_push > self.STALL_SECONDS
        self._last_push = now
        if self.listeners and (stalled or self._since_sync >= self.SYNC_EVERY_FRAMES):
            self._since_sync = 0
            self._broadcast(self._sync_packet(self.pos_ms, self.running, False))
        self._since_sync += 1
        try:
            frame = LobbyRelay._pcm_to_frame(pcm_bytes)
            frame.pts = self._pts
            self._pts += PCM_FRAME_SAMPLES
            packets = self._enc.encode(frame)
        except Exception:
            traceback.print_exc()
            return
        if self.running and not silence:
            self.pos_ms += PCM_FRAME_SAMPLES * 1000.0 / PCM_RATE
        for pkt in packets:
            data = bytes(pkt)
            self.bytes_out += len(data)
            if self.listeners:
                self._broadcast(struct.pack(">HB", len(data) + 1, 0) + data)

    def close(self):
        for listener in list(self.listeners):
            listener.close()
        self.listeners.clear()
        self.ok = False


class PcmCache:
    """One track's raw PCM, downloaded from NodeLink at position 0 and kept
    in memory so the relay can seek by BYTE OFFSET instead of asking
    NodeLink for `position: N`.

    Why: NodeLink's `loadstream` position handling is not sample-exact for
    every source, so audio started "at N ms" could really begin slightly
    before/after N while the timeline (and therefore the progress bar and
    the synced lyrics) claimed N exactly. A stream from position 0 has no
    such offset, and s16le/48kHz/stereo is a fixed 192000 bytes/s, so
    sample-exact seeking is just arithmetic (see LobbyRelay._pos_to_offset).

    `key` = the track's encoded id."""
    __slots__ = ("key", "encoded", "buf", "done", "failed", "task",
                 "started", "first_byte_at")

    def __init__(self, key, encoded):
        self.key = key
        self.encoded = encoded
        self.buf = bytearray()
        self.done = False        # NodeLink stream ended cleanly: buf is the whole track
        self.failed = False      # connection died before done: buf is partial
        self.task = None
        self.started = time.monotonic()
        self.first_byte_at = None


class LobbyRelay:
    """Owns the single live NodeLink -> PCM -> QUIC pipeline for one lobby."""

    def __init__(self, lobby):
        self.lobby = lobby
        self.generation = 0          # bumped on every fresh session (skip/seek)
        # The single shared PCM fan-out every listener's WebTransport
        # session reads from (see QuicPcmRelay) — replaces the old
        # per-listener HTTP `_Listener` queue dict, then the WebRTC
        # MusicSourceTrack, then the AAC/HLS encode, entirely.
        self.audio_out = QuicPcmRelay(lobby.code)
        self._task = None
        self._resume_event = asyncio.Event()
        self._resume_event.set()     # not paused by default

        # ---- gapless preload ----------------------------------------
        # Whatever track is predicted to play next (see
        # _predict_next_track) gets its NodeLink connection opened and
        # its raw PCM buffered here WHILE the current track is still
        # streaming — so when the current track's NodeLink stream ends
        # naturally, _pump_track can start feeding the next track's audio
        # into the relay immediately, with no dead air. Host-controlled
        # per lobby (self.lobby.gapless — see the /gapless route);
        # ensure_preload() no-ops entirely while it's off, so a natural
        # advance falls through to _pump_track's live NodeLink fetch
        # instead, which is what actually produces the gap — the relay
        # itself is untouched either way; only the boundary is quiet
        # rather than instant.
        # Shape: {"track": dict, "cache": PcmCache, "task": Task}
        self._preload = None

        # ---- seek cache ---------------------------------------------
        # The CURRENT track's full PCM (see PcmCache). The pump reads from
        # it — not straight off the NodeLink socket — so every seek is a
        # sample-exact byte offset. A claimed gapless preload becomes this.
        self._cache = None

        # ---- idle keep-alive ----------------------------------------
        # When the queue naturally runs dry, _run used to just return,
        # ending the task entirely — which meant every listener's audio
        # went dead, AND whatever played next had to establish a fresh
        # connection (see resume_or_start below). Now _run instead parks
        # itself in an idle wait right where it is: same task, same
        # relay, nobody reconnects. _feed_silence tops it up at
        # exactly real-time speed (see its own comment for why "exactly"
        # matters) every IDLE_KEEPALIVE_SECONDS, which keeps a listener's
        # playback buffer from ever running dry.
        self._idle = False               # True while parked in the idle wait below
        self._idle_event = asyncio.Event()
        self._pending = None             # (track, position_ms) waiting to resume with

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
            "frames_sent": 0,
            "pcm_bytes_in": 0,
            "pace_drift_ms": deque(maxlen=200),
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

    def debug_snapshot(self):
        """Read-only stats snapshot for the client Debug tab. Safe to call
        from any task — only ever reads the bounded counters above."""
        drift = list(self.stats["pace_drift_ms"])
        avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
        last_ts = self.stats["last_frame_ts"]
        return {
            "generation": self.generation,
            "idle": self._idle,
            # Unlike the old HLS design (anonymous HTTP GETs, no tracked
            # connection), every QUIC listener is a real WtListener the
            # server holds a reference to — an exact count, not a proxy.
            "listeners": len(self.audio_out.listeners),
            "hasPreload": self._preload is not None,
            "seekCacheBytes": len(self._cache.buf) if self._cache else 0,
            "framesSent": self.stats["frames_sent"],
            "pcmBytesIn": self.stats["pcm_bytes_in"],
            "wireBytesOut": self.audio_out.bytes_out,   # Opus bytes produced (before per-listener fan-out)
            "paceDriftMsAvg": avg(drift),
            "paceDriftMsMax": round(max(drift), 3) if drift else None,
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
            "autoQueue": [_track_brief(t) for t in self.lobby.auto_queue],
            # Everything that already played (Lobby.history is oldest->newest,
            # unbounded), flipped so the most recent track is
            # first — the Debug tab's History Queue card renders it as-is.
            "historyCount": len(self.lobby.history),
            "history": [_track_brief(t) for t in reversed(self.lobby.history)],
        }

    # ---- debug/stats push (Socket.IO) --------------------------------
    def debug_subscribe(self, sid):
        self._debug_subscribers.add(sid)
        if self._debug_task is None or self._debug_task.done():
            self._debug_task = asyncio.create_task(self._debug_push_loop())

    def debug_unsubscribe(self, sid):
        self._debug_subscribers.discard(sid)
        # No need to cancel the push task explicitly — it checks the
        # subscriber set itself each cycle and exits once it's empty.

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
        cache = PcmCache(self._cache_key(next_track), next_track.get("encoded"))
        pre = {"track": next_track, "cache": cache, "task": None}
        cache.task = pre["task"] = asyncio.create_task(self._fill_cache(cache))
        self._preload = pre

    def _cancel_preload(self):
        if self._preload and self._preload["task"] and not self._preload["task"].done():
            self._preload["task"].cancel()
        self._preload = None

    # ---- seek cache -----------------------------------------------------
    @staticmethod
    def _cache_key(track):
        return track.get("encoded")

    @staticmethod
    def _pos_to_offset(position_ms):
        """Track position -> byte offset into the PCM. Whole frames only
        (4 bytes: 2ch x s16), so the L/R samples can never swap."""
        return int(round(max(0.0, position_ms) * PCM_RATE / 1000.0)) * (PCM_CHANNELS * 2)

    def _cacheable(self, track):
        if not getattr(config, "SEEK_CACHE_ENABLED", True):
            return False
        info = track.get("info") or {}
        if info.get("isStream"):
            return False
        length = info.get("length")
        max_s = getattr(config, "SEEK_CACHE_MAX_SECONDS", 900)
        return isinstance(length, (int, float)) and 0 < length <= max_s * 1000

    def _cancel_cache(self):
        c = self._cache
        if c is not None and c.task and not c.task.done():
            c.task.cancel()
        self._cache = None

    def _set_cache(self, cache):
        if self._cache is not cache:
            self._cancel_cache()
        self._cache = cache

    def _acquire_cache(self, track):
        """The cache for `track`, starting its download if needed. None if
        this track can't/shouldn't be cached (live stream, or longer than
        SEEK_CACHE_MAX_SECONDS) — the caller then falls back to a live
        NodeLink fetch at `position`."""
        if not self._cacheable(track):
            self._cancel_cache()
            return None
        key = self._cache_key(track)
        c = self._cache
        if c is not None and c.key == key and not (c.failed and not c.done):
            return c
        self._cancel_cache()
        c = PcmCache(key, track.get("encoded"))
        c.task = asyncio.create_task(self._fill_cache(c))
        self._cache = c
        return c

    async def _fill_cache(self, cache):
        """Background task: pull the whole track from NodeLink at position
        0 (NOT the seek target) into cache.buf as fast as NodeLink sends it."""
        body = {"encodedTrack": cache.encoded, "position": 0}
        try:
            async with http_session.post(f"{NL_HOST}/v4/loadstream", json=body,
                                          headers={"Authorization": NL_PASS},
                                          timeout=NODELINK_STREAM_TIMEOUT) as r:
                if r.status != 200:
                    print(f"[relay {self.lobby.code}] NodeLink loadstream {r.status} (seek cache): {await r.text()}")
                    cache.failed = True
                    return
                async for chunk in r.content.iter_chunked(65536):
                    if cache.first_byte_at is None:
                        cache.first_byte_at = time.monotonic()
                    cache.buf.extend(chunk)
            cache.done = True
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError):
            cache.failed = True   # best-effort: _pump_track falls back / retries
        except Exception:
            traceback.print_exc()
            cache.failed = True

    async def _cache_wait(self, cache, need, my_generation):
        """Wait until the cache reaches byte `need`. True = go ahead and play
        from the cache. False = it can't get there quickly enough (or the
        download failed) — play live from NodeLink instead, which is the
        old, less exact behaviour but doesn't stall on a far-ahead seek."""
        limit = float(getattr(config, "SEEK_CACHE_WAIT_SECONDS", 6))
        t0 = time.monotonic()
        while True:
            have = len(cache.buf)
            if have >= need or cache.done:
                return True   # (done + need past the end = seeking past the end -> track just ends)
            if self.generation != my_generation:
                return True   # caller notices and stops
            if cache.failed:
                return False
            now = time.monotonic()
            if have == 0:
                # Nothing yet — a live fetch would be just as slow (track
                # lookup / stream negotiation), so just keep waiting.
                if now - t0 > 45:
                    return False
            else:
                if now - t0 > limit * 3:
                    return False
                flowing = now - (cache.first_byte_at or now)
                if flowing >= 1.0:
                    rate = have / flowing            # bytes/s NodeLink is actually delivering
                    if (need - have) / max(rate, 1.0) > limit:
                        return False
            await asyncio.sleep(0.05)

    # ---- session control ----------------------------------------------
    async def start_track(self, track, position_ms):
        """(Re)start the pipeline for `track` at `position_ms`. Bumps `generation` — the hard cut just becomes part of
        the continuous relay's next couple of frames; listeners hear
        it whenever their player reaches that point in the stream, no
        reconnect involved. This is for explicit, deliberate track
        changes (play/skip/seek) — a NATURAL end-of-track advance
        does NOT go through here; see _run's internal loop, which
        stitches the next track into the same session instead (gapless),
        and resume_or_start below, which does the same across an idle
        gap."""
        self._cancel_task()
        self._cancel_preload()
        self._idle = False
        self._idle_event.clear()
        self._pending = None
        self._pace_next = None
        self.generation += 1
        # A seek while PAUSED must stay paused (previously
        # this unconditionally un-paused the relay while lobby.paused was
        # still True, so audio streamed under a "paused" state).
        if self.lobby.paused:
            self._resume_event.clear()
        else:
            self._resume_event.set()
        # Hard cut: every listener discards whatever it has buffered and
        # shows the target position frozen until real audio arrives.
        self.audio_out.set_timeline(position_ms if track is not None else 0, False, cut=True)
        if track is None:
            return
        self._task = asyncio.create_task(self._run(track, position_ms, self.generation))

    async def reseek(self, position_ms):
        track = self.lobby.current_track
        if track is None:
            return
        await self.start_track(track, position_ms)

    async def resume_or_start(self, track, position_ms=0):
        """Cheap path back from silence. If the pipeline is still alive and
        sitting in the idle wait (queue ran dry but nothing tore the
        session down — see _run), hand it this track and wake it up: same
        generation, nobody reconnects. Falls back to a full start_track()
        (new generation) whenever that shortcut doesn't apply — most
        commonly the very first track ever played in a fresh lobby, where
        there's no pipeline running yet to resume."""
        if self._task is not None and not self._task.done() and self._idle:
            if self.lobby.paused:
                self._resume_event.clear()
            else:
                self._resume_event.set()
            self._pending = (track, position_ms)
            self._idle = False
            self._idle_event.set()
            return
        await self.start_track(track, position_ms)

    def set_paused(self, paused):
        # Freezes the relay's own real-time pacing loop in place (no
        # re-fetch, no reseek) — sample-accurate, and resuming just
        # continues exactly where it left off.
        if paused:
            self._resume_event.clear()
        else:
            self._resume_event.set()

    async def _gate(self):
        """Server-side pause. While paused the relay keeps the SAME
        stream flowing — real-time silence, timeline frozen — instead of
        going quiet. Listeners never pause anything themselves, so
        there's no stale client-side buffer to replay on resume, and a
        seek/skip while paused just arrives as a cut. Returns once
        resumed, having told listeners the exact frame position that
        playback continues from."""
        if self._resume_event.is_set():
            return
        ao = self.audio_out
        ao.set_timeline(ao.pos_ms, False)
        while not self._resume_event.is_set():
            try:
                await asyncio.wait_for(self._resume_event.wait(), timeout=0.02)
            except asyncio.TimeoutError:
                self._feed_silence()
        ao.set_timeline(ao.pos_ms, True)
        # Keep the lobby's own clock exactly on the stream position.
        self.lobby.position_anchor_ms = ao.pos_ms
        self.lobby.anchor_time = time.time()

    def _cancel_task(self):
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None

    async def stop(self):
        """Cancel the pipeline task without tearing down the relay output
        itself — the lobby may still be around and get a new track later
        (see resume_or_start), so the encode/playlist stay open, they
        just stop receiving new frames until then. For a full teardown
        (lobby going away for good) see shutdown() below."""
        self._cancel_task()
        self._cancel_preload()
        self._cancel_cache()
        self._idle = False
        self._idle_event.clear()
        self._pending = None
        self.generation += 1
        self.audio_out.set_timeline(0, False, cut=True)

    async def shutdown(self):
        """Full teardown — called once, when the lobby's last participant
        leaves (see _finalize_leave). Stops the pipeline AND finalizes +
        closes out every connected listener, unlike stop() above."""
        await self.stop()
        self.audio_out.close()

    # ---- the actual pipeline ----------------------------------------------
    # Runs for an entire GENERATION, not just one track: as long as tracks
    # keep advancing naturally (queue autoplay), this stays in ONE pipeline
    # and just keeps pushing more PCM frames into the relay — that's
    # what makes the transition gapless (no listener reconnect, no generation
    # bump, no listener reconnect). It only returns (ending the
    # generation) when the queue truly runs dry or something external
    # bumps `generation` out from under it (explicit play/skip/seek/
    # seeks, which go through start_track instead).
    async def _run(self, track, position_ms, my_generation):
        try:
            self.stats["sessions_started"] += 1

            cur_track, cur_pos = track, position_ms
            retry_count = 0
            while True:
                if self.generation != my_generation:
                    return
                self._idle = False
                # NOTE: prefetching whatever plays after cur_track is kicked
                # off from inside _pump_track itself, right after it claims
                # (or rules out) any preload matching cur_track — see the
                # comment there for why it can't happen here.

                result = await self._pump_track(cur_track, cur_pos, my_generation)
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
                    cur_track, cur_pos = nxt, 0
                    continue

                # Queue (and autoplay) are genuinely empty. The OLD behaviour
                # here returned, ending this task — every listener's <audio>
                # connection died right then, mid- (or right at the very end
                # of) whatever was still sitting in their own playback
                # buffer, which is what made the last track of a queue (or a
                # lobby's only track) cut off abruptly a moment before it
                # actually finished.
                #
                # Instead: stay right here. Task stays alive, generation
                # doesn't change, the relay keeps flowing, nobody
                # reconnects. Waking every IDLE_KEEPALIVE_SECONDS and letting
                # _feed_silence make up exactly however much real time has
                # passed keeps a listener's playback buffer continuously
                # topped up at 1x (so idle never itself sounds like a
                # dropout, and never builds up a backlog either).
                # resume_or_start() is what wakes this back up — see
                # lobby_play / queue/add.
                self.audio_out.set_timeline(0, False)   # nothing playing: timeline frozen while silence keeps flowing
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
                        self._feed_silence()
                if self.generation != my_generation:
                    return
                cur_track, cur_pos = self._pending
                self._pending = None
        except asyncio.CancelledError:
            pass
        except Exception:
            traceback.print_exc()

    async def _pump_track(self, track, position_ms, my_generation):
        """Streams ONE track's PCM into the relay (and onward to every
        listener over plain HTTP). Returns "ended" if the track's
        audio source ended naturally (caller should advance to whatever's
        next), "interrupted" if the session changed out from under it
        (caller should stop silently — something else, e.g. an explicit
        skip, is already handling it), or "error" if the NodeLink
        connection itself failed/dropped (caller should reconnect and
        retry rather than treating it like a real track end)."""
        pcm_buf = bytearray()
        frame_dur = PCM_FRAME_SAMPLES / PCM_RATE  # 20ms
        anchor_corrected = False

        async def flush_tail():
            # feed_chunk only ever pushes whole PCM_FRAME_BYTES frames, so
            # whatever's left in pcm_buf when the source genuinely ends
            # (under one frame — under 20ms) never goes through it. Left
            # alone that's silently dropped instead of played, same bug
            # _encode_pcm_blocking already pads around for downloads (see
            # its "remainder" handling) — pad it out to a full frame with
            # silence and push it here so a track's last few milliseconds
            # actually reach listeners instead of being cut short.
            if not pcm_buf:
                return
            frame_bytes = bytes(pcm_buf) + bytes(PCM_FRAME_BYTES - len(pcm_buf))
            pcm_buf.clear()
            self.audio_out.push(frame_bytes)

        async def feed_chunk(chunk):
            nonlocal anchor_corrected
            pcm_buf.extend(chunk)
            while len(pcm_buf) >= PCM_FRAME_BYTES:
                frame_bytes = bytes(pcm_buf[:PCM_FRAME_BYTES])
                del pcm_buf[:PCM_FRAME_BYTES]
                if not anchor_corrected:
                    # Frame 0 of this track/segment sits at position_ms
                    # and the timeline runs from here (also marks the
                    # exact sample a gapless track boundary lands on).
                    self.audio_out.set_timeline(position_ms, True)
                self.audio_out.push(frame_bytes)
                self.stats["frames_sent"] += 1
                self.stats["pcm_bytes_in"] += len(frame_bytes)
                self.stats["last_frame_ts"] = time.time()

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

        # Where PCM comes from, best first:
        #   1. an already-running gapless preload of this exact track (only
        #      at position 0 — it's just a PcmCache, and it becomes THE
        #      cache for this track so later seeks reuse it);
        #   2. the seek cache for `track`: the whole track is
        #      fetched once from position 0 and every seek is a byte offset
        #      into it — sample-exact, unlike NodeLink's `position` param;
        #   3. a live NodeLink fetch at `position` (below) — only for
        #      uncacheable tracks (live streams, very long tracks) or
        #      a seek so far ahead the cache can't get there in time.
        pre = self._preload
        use_preload = (
            pre is not None and position_ms == 0
            and pre["track"].get("encoded") == track.get("encoded")
        )
        if use_preload:
            self._preload = None  # this track is live now, not "next" anymore
            cache = pre["cache"]
            self._set_cache(cache)
        else:
            cache = self._acquire_cache(track)

        # Now that `track`'s own preload (if any) has been claimed above —
        # so a fresh prediction below can't cancel it out from under us —
        # it's safe to start prefetching whatever plays AFTER `track`.
        # `self.lobby.current_track` already equals `track` here (every
        # caller sets it before invoking us), so ensure_preload()'s
        # prediction correctly looks one track further ahead rather than
        # re-predicting `track` itself. Calling this any earlier (at the
        # top of _run's loop, or right when lobby.current_track was first
        # set to `track`) raced with the claim above and kept cancelling
        # the very preload this function was about to consume.
        self.ensure_preload()

        if cache is not None:
            target = self._pos_to_offset(position_ms)
            if await self._cache_wait(cache, target + PCM_FRAME_BYTES * 10, my_generation):
                off = target
                try:
                    while True:
                        if self.generation != my_generation:
                            return "interrupted"
                        await self._gate()   # server-side pause: streams silence here, resumes exactly in place
                        if self.generation != my_generation:
                            return "interrupted"
                        have = len(cache.buf)
                        if off < have:
                            end = min(off + 8192, have)
                            chunk = bytes(cache.buf[off:end])
                            off = end
                            await feed_chunk(chunk)
                        elif cache.done:
                            break
                        elif cache.failed:
                            return "error"
                        else:
                            await asyncio.sleep(0.02)   # download still catching up to real time
                except asyncio.CancelledError:
                    raise
                except Exception:
                    traceback.print_exc()
                    return "error"
                await flush_tail()
                return "ended"
            if self.generation != my_generation:
                return "interrupted"
            print(f"[relay {self.lobby.code}] seek to {position_ms:.0f}ms is past what the cache can reach in time — live fetch fallback")

        # Live fetch at `position` — the fallback described above.
        body = {"encodedTrack": track.get("encoded"), "position": round(position_ms)}
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
                    await self._gate()   # server-side pause: streams silence here, resumes exactly in place
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

    def _feed_silence(self):
        """Enough digital silence to keep the SAME real-time clock feed_chunk
        uses (self._pace_next) caught up to wall time — pushed to
        the relay exactly like real audio, back-to-back with no
        per-frame sleep between them (it's inaudible filler, nothing for a
        listener to sync against, so there's no reason to pace it out one
        frame at a time the way real audio has to be).

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
            self.audio_out.push(silent_bytes, silence=True)

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


def fair_order(queue, current_track):
    """Round-robin `queue` between whoever added each track, keeping every
    person's own tracks in their existing relative order. The rotation
    deliberately starts on someone OTHER than whoever's track is playing
    (their turn comes round last). Pure function: returns a new list, and
    applying it to an already-fair queue returns the same order, which is
    what lets Lobby.apply_fair run after every queue operation."""
    order, by_requester = [], {}
    for t in queue:
        key = requester_key(t)
        if key not in by_requester:
            order.append(key)
            by_requester[key] = []
        by_requester[key].append(t)
    if len(order) <= 1:
        return list(queue)
    current_key = requester_key(current_track)
    if current_key in order:
        order.remove(current_key)
        order.append(current_key)
    out = []
    for rnd in range(max(len(v) for v in by_requester.values())):
        for key in order:
            tracks = by_requester[key]
            if rnd < len(tracks):
                out.append(tracks[rnd])
    return out


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
            tid = track_id(t)
            if tid in played or tid in queued or tid in have:
                continue
            have.add(tid)
            t.setdefault("requester", {"id": "__auto__", "name": "Autoplay"})
            lobby.auto_queue.append(t)
        # Shuffle the whole pool, not just this batch: batches are appended in
        # the order tracks were played, so the front of the pool (what Smart
        # Shuffle / autoplay take first) would always come from the oldest seed.
        random.shuffle(lobby.auto_queue)
        if broadcast_state and LOBBIES.get(lobby.code) is lobby:
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
        self.chat = []
        self.created_at = time.time()

        # Optional join password. Only a salted hash is kept; it never leaves
        # the server (public_state exposes just `hasPassword`).
        self.pw_salt = None
        self.pw_hash = None

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
        # On by default, same as standalone. See LobbyRelay.ensure_preload.
        self.gapless = True

        # Fair Queue — a lobby-wide, host-controlled ON/OFF state (see the
        # /fair route), ON by default. While on, apply_fair() re-balances
        # the queue after every queue operation (add, remove, move,
        # shuffle, smart shuffle) instead of waiting for a manual button.
        self.fair = True

        # Disc Jockeys — participants the host has appointed (client ids).
        # They pass _require_controller like the host does, so they can drive
        # playback and the queue; host-only things (lobby settings, managing
        # DJs) stay with the host. Cleaned up when someone leaves and when
        # they become host (see remove_participant / /dj).
        self.djs = set()

        self.relay = LobbyRelay(self)

    def apply_fair(self):
        """Re-balance the queue if Fair Queue is on. Returns True if the
        order actually changed. Call it BEFORE relay.ensure_preload() so
        the gapless prefetch targets the real next track."""
        if not self.fair or len(self.queue) < 2:
            return False
        new = fair_order(self.queue, self.current_track)
        if all(a is b for a, b in zip(new, self.queue)):
            return False
        self.queue[:] = new
        return True

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

    @property
    def has_password(self):
        return self.pw_hash is not None

    def set_password(self, pw):
        """Set (non-empty string) or clear (empty/None) the join password."""
        pw = str(pw or "")[:config.LOBBY_PASSWORD_MAX]
        if not pw:
            self.pw_salt = self.pw_hash = None
            return
        self.pw_salt = os.urandom(16)
        self.pw_hash = hashlib.pbkdf2_hmac("sha256", pw.encode(), self.pw_salt, 50_000)

    def check_password(self, pw):
        if not self.has_password:
            return True
        cand = hashlib.pbkdf2_hmac("sha256", str(pw or "")[:config.LOBBY_PASSWORD_MAX].encode(), self.pw_salt, 50_000)
        return hmac.compare_digest(cand, self.pw_hash)

    def public_state(self):
        return {
            "code": self.code,
            "hasPassword": self.has_password,
            "name": self.name,
            "isPublic": self.is_public,
            "hostId": self.host_id,
            "currentTrack": self.current_track,
            "paused": self.paused,
            "positionMs": self.current_position_ms(),
            "queue": self.queue,
            "relayGen": self.relay.generation,
            "loopMode": self.loop_mode,
            "autoplay": self.autoplay,
            "autoQueueCount": len(self.auto_queue),
            "historyCount": len(self.history),
            "gapless": self.gapless,
            "fair": self.fair,
            "djs": sorted(self.djs),
        }

    def participant_list(self):
        return [{"id": p.id, "name": p.name, "isHost": p.id == self.host_id, "isDj": p.id in self.djs} for p in self.participants.values()]


LOBBIES = {}

# Socket.IO sid -> (lobby_code, client_id), so the disconnect handler
# (which only gets a bare sid from Socket.IO) knows who dropped.
_sid_registry = {}


# ── Lobby code registry ────────────────────────────────────────────────
# LOBBIES IS the registry of every running lobby code. All mutation goes
# through register_lobby / unregister_lobby / the re-key in lobby_change_code
# so a code can never belong to two lobbies at once. Everything runs on one
# event loop and none of these helpers await between their check and their
# write, so check-then-claim is atomic.
LOBBY_CODE_RE = re.compile(r"[A-Z]{%d}" % config.LOBBY_CODE_LENGTH)
CLIENT_ID_RE = re.compile(r"[0-9a-f]{32}")


def clean_code(raw):
    """Normalise user input to a valid lobby code (exactly N letters A-Z), or None."""
    code = str(raw or "").strip().upper()
    return code if LOBBY_CODE_RE.fullmatch(code) else None


def code_in_use(code):
    return code in LOBBIES


def register_lobby(lobby):
    if lobby.code in LOBBIES:
        raise ValueError(f"lobby code {lobby.code} is already in use")
    LOBBIES[lobby.code] = lobby


def unregister_lobby(lobby):
    # Identity check: only ever free the code if it still points at THIS lobby.
    if LOBBIES.get(lobby.code) is lobby:
        LOBBIES.pop(lobby.code, None)


def gen_code():
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=config.LOBBY_CODE_LENGTH))
        if not code_in_use(code):
            return code


def get_lobby_or_404(code):
    return LOBBIES.get((code or "").upper())


def find_lobby_by_client(client_id):
    """The lobby a client id belongs to, whatever its code is NOW. Lets a
    participant who missed a host's code change find their way back."""
    if not client_id:
        return None
    for l in LOBBIES.values():
        if client_id in l.participants:
            return l
    return None


async def broadcast(lobby, event, data):
    await sio.emit(event, data, room=lobby.code)


# ═══════════════════════════════════════════════════════════════════
# QUIC / WebTransport listener — the actual transport for QuicPcmRelay/
# WtListener (defined earlier). Runs as its own UDP server, independent
# of the TCP server uvicorn runs for `asgi_app` — WebTransport needs a
# real QUIC connection (an HTTP/3 CONNECT), which nothing in the Quart/
# ASGI stack speaks, so this is a second, much smaller server started
# alongside it (see start_quic_server, kicked off from the existing
# `startup()` hook above). It only ever handles ONE thing: the
# WebTransport handshake for /api/lobby/<code>/audio — no general HTTP/3
# request handling, no static files, nothing else. REST, Socket.IO and
# the frontend are all still served over the normal TCP HTTP server,
# completely untouched by any of this.
#
# Defined down here (after LOBBIES exists) purely for readability —
# LobbyQuicProtocol only looks LOBBIES up at connect time, long after
# the whole module has finished loading, so the actual definition order
# doesn't matter to Python.
# ═══════════════════════════════════════════════════════════════════
QUIC_PORT = getattr(config, "QUIC_PORT", config.FLASK_PORT)   # same NUMBER as the HTTP server — TCP and UDP are independent port namespaces, so this is just a convenience (one number to open/forward in a firewall), never a shared socket
# WebTransport's serverCertificateHashes pinning (see GET /api/quic-info
# below) — how a browser trusts this self-signed cert with no real CA
# involved — requires the certificate's validity window to be 14 days or
# less. The cert lives purely in memory (never written to disk): it's
# generated at startup and re-rolled in the background well before it
# expires (see _quic_cert_rotation_loop), so nothing needs managing by
# hand and a restart just mints a fresh one.
QUIC_CERT_DAYS = getattr(config, "QUIC_CERT_DAYS", 12)
QUIC_CERT_ROTATE_DAYS = 5   # re-roll well inside the validity window

_quic_cert_hash_hex = None   # hex sha-256 of the DER cert; set by _make_quic_cert() below
_quic_server = None          # the aioquic asyncio.Server instance once start_quic_server() has run


def _make_quic_cert():
    """Generates a fresh self-signed EC (P-256) cert entirely in memory.
    Returns (cert, key) as cryptography objects — exactly what aioquic's
    QuicConfiguration.certificate / .private_key hold — and updates
    _quic_cert_hash_hex to the SHA-256 (hex) of the DER-encoded cert,
    which is what the browser pins via serverCertificateHashes (see
    /api/quic-info and webtransport-player.js). EC P-256 + SHA-256
    signing matches aioquic's own test fixtures."""
    global _quic_cert_hash_hex
    import ipaddress
    key = ec.generate_private_key(ec.SECP256R1())
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "nodelink-lobby")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=QUIC_CERT_DAYS))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    _quic_cert_hash_hex = hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).digest().hex()
    return cert, key


async def _quic_cert_rotation_loop(configuration):
    """Swaps in a fresh in-memory cert every QUIC_CERT_ROTATE_DAYS so a
    long-running process never ends up serving an expired one. Mutating
    the shared QuicConfiguration in place is enough: each NEW connection
    reads certificate/private_key at handshake time, while sessions
    already established are unaffected (TLS is only validated once).
    Tiny edge: a client that fetched /api/quic-info a moment before a
    rotation pins the old hash and fails its handshake — leaving and
    rejoining picks up the new one."""
    while True:
        await asyncio.sleep(QUIC_CERT_ROTATE_DAYS * 86400)
        try:
            configuration.certificate, configuration.private_key = _make_quic_cert()
            print(f"[quic] rotated in-memory cert (sha-256 {_quic_cert_hash_hex[:16]}…)")
        except Exception:
            traceback.print_exc()


_LOBBY_AUDIO_PATH_RE = re.compile(r"^/api/lobby/([A-Za-z0-9]{6})/audio$")


class LobbyQuicProtocol(QuicConnectionProtocol):
    """One instance per QUIC connection — i.e. one browser tab's
    WebTransport connection to the lobby relay. Handles exactly one
    HTTP/3 request shape: an extended CONNECT with `:protocol:
    webtransport` to /api/lobby/<code>/audio, accepted by replying
    `:status: 200` on that same stream (the WebTransport-over-HTTP/3
    handshake) — then hands the resulting session straight to that
    lobby's QuicPcmRelay as a new WtListener. Nothing else is served
    here; a client never reuses this connection for anything but that
    one session."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.http = None
        self._listeners = {}   # session_id (== the CONNECT stream's id) -> WtListener

    def quic_event_received(self, event: QuicEvent):
        if isinstance(event, ProtocolNegotiated):
            if event.alpn_protocol in H3_ALPN:
                self.http = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(event, ConnectionTerminated):
            # NOTE: aioquic's QuicServer drives each QUIC connection's
            # protocol instance by hand (there's one real asyncio
            # transport for the whole UDP socket, shared across every
            # client) — so unlike a normal asyncio protocol, this
            # server-side instance's own connection_lost() is NEVER
            # called by anything; ConnectionTerminated arriving here is
            # the only reliable signal that this client is gone (tab
            # closed, navigated away, network dropped). Confirmed by
            # testing: overriding connection_lost() looked correct but
            # silently never ran.
            self._cleanup_listeners()
        if self.http is not None:
            for h3_event in self.http.handle_event(event):
                self._h3_event_received(h3_event)

    def _h3_event_received(self, event: H3Event):
        if isinstance(event, HeadersReceived):
            self._handle_connect(event)
        # WebTransportStreamDataReceived / DatagramReceived (client ->
        # server) are deliberately ignored — this session is one-way
        # (server -> client audio only); playback control stays on the
        # existing REST + Socket.IO channels.

    def _handle_connect(self, event: HeadersReceived):
        headers = dict(event.headers)
        method = headers.get(b":method", b"").decode()
        protocol = headers.get(b":protocol", b"").decode()
        path = headers.get(b":path", b"").decode()

        def reject(status: bytes):
            self.http.send_headers(stream_id=event.stream_id, headers=[(b":status", status)], end_stream=True)
            self.transmit()

        if method != "CONNECT" or protocol != "webtransport":
            reject(b"400")
            return
        m = _LOBBY_AUDIO_PATH_RE.match(path)
        lobby = LOBBIES.get(m.group(1).upper()) if m else None
        if lobby is None:
            reject(b"404")
            return

        # Per the WebTransport-over-HTTP/3 draft, the session id IS the
        # CONNECT request's own stream id — accepting just means
        # answering that stream with a 200, no body.
        session_id = event.stream_id
        self.http.send_headers(stream_id=session_id, headers=[(b":status", b"200")])
        self.transmit()

        listener = WtListener(self, session_id)
        self._listeners[session_id] = listener
        lobby.relay.audio_out.add_listener(listener)
        print(f"[quic {lobby.code}] listener connected ({len(lobby.relay.audio_out.listeners)} total)")
        listener._lobby_relay = lobby.relay  # so _cleanup_listeners below can unregister it

    def _cleanup_listeners(self):
        for listener in list(self._listeners.values()):
            relay = getattr(listener, "_lobby_relay", None)
            if relay is not None:
                relay.audio_out.remove_listener(listener)
            else:
                listener.close()
        self._listeners.clear()


async def start_quic_server():
    """Starts the UDP/QUIC listener on the SAME PORT NUMBER as the HTTP
    server (see QUIC_PORT above). Called fire-and-forget from the
    existing `startup()` hook, so it starts in the same asyncio event
    loop/process uvicorn actually ends up serving `asgi_app` from.
    Failure here (port in use, cert generation failed, `aioquic` not
    installed correctly) is logged and swallowed rather than crashing
    the whole process — REST/Socket.IO/the frontend all work fine
    without it; only live lobby audio depends on it."""
    global _quic_server
    if _quic_server is not None:
        return
    try:
        configuration = QuicConfiguration(alpn_protocols=H3_ALPN, is_client=False)
        # WebTransport (H3Connection(enable_webtransport=True)) advertises
        # H3_DATAGRAM support in its SETTINGS regardless of whether this
        # app actually uses unreliable datagrams (it doesn't — audio only
        # ever goes out on reliable per-listener streams, see WtListener)
        # — but that advertisement is a protocol violation unless the
        # QUIC layer itself has the datagram extension turned on, which
        # is exactly this line. Skipping it, the connection completes its
        # TLS handshake and then immediately tears itself down with
        # H3_SETTINGS_ERROR the moment the client sends its own SETTINGS
        # frame — caught by testing (see the WebTransport E2E test run
        # against this file), not something you'd notice from a plain
        # syntax check.
        configuration.max_datagram_frame_size = 65536
        configuration.certificate, configuration.private_key = _make_quic_cert()
        cert_hash = _quic_cert_hash_hex
        bind_host = config.FLASK_HOST
        _quic_server = await quic_serve(
            bind_host,
            QUIC_PORT,
            configuration=configuration,
            create_protocol=LobbyQuicProtocol,
        )
        asyncio.ensure_future(_quic_cert_rotation_loop(configuration))
        print(f"[quic] WebTransport listener on udp://{bind_host}:{QUIC_PORT} (in-memory cert sha-256 {cert_hash[:16]}…)")
    except Exception:
        traceback.print_exc()
        print("[quic] failed to start the WebTransport listener — lobby audio will not work until this is fixed (is the UDP port already in use? is `aioquic`/`cryptography` installed?)")


@app.route("/api/quic-info")
async def quic_info():
    """Everything a browser needs to open a lobby's WebTransport session
    itself: which UDP port to connect to, and the self-signed cert's
    hash to pin via serverCertificateHashes (see webtransport-player.js)
    since there's no real CA involved. `path` is a template — the client
    fills in `{code}` with the lobby it's joining.

    `host`, when set (QUIC_PUBLIC_IP in config.py), is the IP literal
    LobbyAPI.quicUrl (api.js) should connect to instead of trying to use
    the page's own hostname — required because serverCertificateHashes
    pinning only works against an IP literal, never a hostname, and
    unlike "localhost" an arbitrary production domain can't be resolved
    client-side. Omitted (null) when not configured, so the client falls
    back to its own hostname/localhost handling."""
    if _quic_cert_hash_hex is None:
        return jsonify({"error": "QUIC listener not ready yet — try again in a moment"}), 503
    return jsonify({
        "port": QUIC_PORT,
        "certHashHex": _quic_cert_hash_hex,
        "path": "/api/lobby/{code}/audio",
        "host": getattr(config, "QUIC_PUBLIC_IP", "") or None,
    })


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
    """Remove a participant for real: promote a new host if they were
    host, broadcast the change, and tear the whole lobby down (including
    every listener's session) if that was the last participant."""
    if client_id not in lobby.participants:
        return  # already handled by a prior call (explicit leave + a
                 # later-expiring grace-period check both land here)

    p = lobby.participants.pop(client_id, None)
    lobby.djs.discard(client_id)
    for sid in lobby.sids.pop(client_id, set()):
        _sid_registry.pop(sid, None)
        try:
            await sio.disconnect(sid)
        except Exception:
            traceback.print_exc()
            pass

    was_host = lobby.host_id == client_id
    if was_host and lobby.participants:
        lobby.host_id = next(iter(lobby.participants))
        lobby.djs.discard(lobby.host_id)   # the host already controls everything

    if not lobby.participants:
        await lobby.relay.shutdown()
        unregister_lobby(lobby)
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
# ── Lobby passwords ────────────────────────────────────────────────────
# Wrong guesses are throttled per (client IP, lobby code) so a 6-letter code
# plus a short password can't just be brute-forced.
_PW_FAILS = {}


def _client_ip():
    fwd = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    return fwd or request.remote_addr or "?"


def _password_gate(lobby, data):
    """None if the caller may enter `lobby`; otherwise a (response, status) to return as-is."""
    if not lobby.has_password:
        return None
    key = (_client_ip(), lobby.code)
    now = time.time()
    hits = [t for t in _PW_FAILS.get(key, []) if now - t < config.PASSWORD_FAIL_WINDOW]
    if len(hits) >= config.PASSWORD_MAX_FAILS:
        _PW_FAILS[key] = hits
        return jsonify({"error": "Too many wrong passwords — wait a minute and try again", "reason": "rate_limited"}), 429
    supplied = data.get("password")
    if supplied is None or supplied == "":
        return jsonify({"error": "This lobby needs a password", "reason": "password_required"}), 403
    if not lobby.check_password(supplied):
        hits.append(now)
        _PW_FAILS[key] = hits
        return jsonify({"error": "Wrong password", "reason": "wrong_password"}), 403
    _PW_FAILS.pop(key, None)
    return None


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
    lobby.set_password(data.get("password"))
    register_lobby(lobby)

    return jsonify({"code": code, "clientId": client_id, "isHost": True, "state": lobby.public_state()})


@app.route("/api/lobby/join", methods=["POST"])
async def join_lobby():
    data = await request.get_json(force=True, silent=True) or {}
    code = (data.get("code") or "").upper().strip()
    display_name = (data.get("displayName") or "Guest")[:24]

    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "Lobby not found"}), 404

    blocked = _password_gate(lobby, data)
    if blocked:
        return blocked

    client_id = uuid.uuid4().hex
    lobby.participants[client_id] = Participant(client_id, display_name)
    state = lobby.public_state()
    plist = lobby.participant_list()

    await broadcast(lobby, "participants", plist)
    await broadcast(lobby, "chat", {"system": True, "text": f"{display_name} joined", "ts": time.time() * 1000})

    return jsonify({"code": code, "clientId": client_id, "isHost": False, "state": state})


@app.route("/api/lobby/public")
async def list_public():
    out = []
    for l in LOBBIES.values():
        if not l.is_public:
            continue
        info = (l.current_track or {}).get("info") or {}
        out.append({
            "code": l.code, "name": l.name, "participants": len(l.participants),
            "hasPassword": l.has_password,
            # Brief only — never the encoded track blob.
            "nowPlaying": {"title": info.get("title"), "author": info.get("author")} if l.current_track else None,
            "paused": l.paused,
            "queueLength": len(l.queue),
        })
    return jsonify(out)


@app.route("/api/lobby/<code>/leave", methods=["POST"])
async def leave_lobby(code):
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    lobby = get_lobby_or_404(code)
    if lobby and client_id:
        await _finalize_leave(lobby, client_id)
    return jsonify({"ok": True})


# ── Self-heal: rejoin / restore ────────────────────────────────────────
# After the server drops (or restarts) every client keeps retrying:
#   - non-hosts call /rejoin until the lobby exists again;
#   - the host calls /rejoin first and, if the lobby is gone, /restore with
#     the snapshot its browser saved, which rebuilds the lobby under the
#     SAME code (unless another lobby grabbed it meanwhile — see below).
# Neither endpoint can squat on a code: /rejoin never creates a lobby, and
# /restore goes through register_lobby like everything else.
def _clean_track(t):
    """Keep only what a track needs; reject anything that isn't a real track."""
    if not isinstance(t, dict):
        return None
    encoded, info = t.get("encoded"), t.get("info")
    if not isinstance(encoded, str) or not encoded or not isinstance(info, dict):
        return None
    out = {"encoded": encoded, "info": info}
    if isinstance(t.get("pluginInfo"), dict):
        out["pluginInfo"] = t["pluginInfo"]
    req = t.get("requester")
    if isinstance(req, dict) and isinstance(req.get("id"), str) and isinstance(req.get("name"), str):
        out["requester"] = {"id": req["id"][:64], "name": req["name"][:24]}
    return out


def _join_payload(lobby, client_id, **extra):
    return jsonify({
        "code": lobby.code, "clientId": client_id,
        "isHost": lobby.host_id == client_id,
        "state": lobby.public_state(), **extra,
    })


@app.route("/api/lobby/rejoin", methods=["POST"])
async def rejoin_lobby():
    data = await request.get_json(force=True, silent=True) or {}
    code = clean_code(data.get("code"))
    client_id = str(data.get("clientId") or "")
    display_name = (data.get("displayName") or "Guest")[:24]

    # Same identity still valid (a network blip, not a restart) — possibly
    # under a different code if the host renamed the lobby meanwhile.
    lobby = find_lobby_by_client(client_id)
    if lobby:
        return _join_payload(lobby, client_id, rejoined=True)

    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "Lobby not found", "reason": "not_found"}), 404

    # The lobby exists but no longer knows us (it was rebuilt by its host
    # after a restart, or we were evicted): come back in as a new participant
    # — through the password gate, like any other newcomer.
    blocked = _password_gate(lobby, data)
    if blocked:
        return blocked
    new_id = uuid.uuid4().hex
    lobby.participants[new_id] = Participant(new_id, display_name)
    await broadcast(lobby, "participants", lobby.participant_list())
    await broadcast(lobby, "chat", {"system": True, "text": f"{display_name} reconnected", "ts": time.time() * 1000})
    return _join_payload(lobby, new_id, rejoined=True)


@app.route("/api/lobby/restore", methods=["POST"])
async def restore_lobby():
    """Rebuild a lobby from a snapshot the host's browser saved. The restored
    lobby starts PAUSED at the saved position (nobody is startled by audio),
    with the saved queue and queue/loop/autoplay/gapless/fair settings."""
    data = await request.get_json(force=True, silent=True) or {}
    snap = data.get("snapshot") if isinstance(data.get("snapshot"), dict) else {}
    code = clean_code(snap.get("code"))
    if not code:
        return jsonify({"error": "snapshot has no valid lobby code", "reason": "bad_snapshot"}), 400

    client_id = str(data.get("clientId") or "")
    if not CLIENT_ID_RE.fullmatch(client_id):
        client_id = uuid.uuid4().hex
    display_name = (data.get("displayName") or snap.get("displayName") or "Guest")[:24]
    allow_new = bool(data.get("allowNewCode"))

    existing = LOBBIES.get(code)
    if existing:
        if existing.host_id == client_id and client_id in existing.participants:
            return _join_payload(existing, client_id, restored=False)   # already alive
        if not allow_new:
            return jsonify({"error": f"Code {code} is in use by another lobby", "reason": "code_in_use"}), 409
        code = gen_code()   # the original code was taken meanwhile — restore under a fresh one

    name = str(snap.get("name") or "Untitled Lobby")[:40]
    lobby = Lobby(code, name, bool(snap.get("isPublic", False)), client_id)
    lobby.participants[client_id] = Participant(client_id, display_name)
    if snap.get("loopMode") in ("none", "track", "queue"):
        lobby.loop_mode = snap["loopMode"]
    if snap.get("autoplay") in ("enabled", "partial", "disabled"):
        lobby.autoplay = snap["autoplay"]
    lobby.gapless = bool(snap.get("gapless", True))
    lobby.fair = bool(snap.get("fair", True))
    lobby.set_password(snap.get("password"))

    me = {"id": client_id, "name": display_name}
    limit = int(getattr(config, "RESTORE_MAX_QUEUE", 500))
    queue = [t for t in (_clean_track(x) for x in (snap.get("queue") or [])[:limit]) if t]
    current = _clean_track(snap.get("currentTrack"))
    pos = 0.0
    if current:
        try:
            pos = max(0.0, float(snap.get("positionMs") or 0))
        except (TypeError, ValueError):
            pos = 0.0
        length = (current.get("info") or {}).get("length")
        if isinstance(length, (int, float)) and length > 0:
            pos = min(pos, max(0.0, length - 1000))
    elif queue:
        current = queue.pop(0)   # a queue with nothing playing: line the first one up
    for t in queue + ([current] if current else []):
        t.setdefault("requester", me)
    lobby.queue = queue
    # Restore history before recommendations so they dedupe against it.
    lobby.history = [t for t in (_clean_track(x) for x in (snap.get("history") or [])[-limit:]) if t]
    # Smart (recommendation) pool, minus anything already queued/played.
    seen = {track_id(t) for t in queue + lobby.history}
    if current:
        seen.add(track_id(current))
    for x in (snap.get("smart") or [])[:limit]:
        t = _clean_track(x)
        if not t or track_id(t) in seen:
            continue
        seen.add(track_id(t))
        t.setdefault("requester", {"id": "__auto__", "name": "Autoplay"})
        lobby.auto_queue.append(t)

    register_lobby(lobby)   # raises if the code got claimed since the check above (can't — no await in between)
    if current:
        lobby.current_track = current
        lobby.paused = True
        lobby.position_anchor_ms = pos
        lobby.anchor_time = time.time()
        await lobby.relay.start_track(current, pos)   # stays gated (silence) until the host presses play
        await populate_recommendations(lobby, broadcast_state=False)
    lobby.apply_fair()
    lobby.relay.ensure_preload()
    return _join_payload(lobby, client_id, restored=True, codeChanged=(code != clean_code(snap.get("code"))))


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
        # The host may have changed the lobby code while this client was
        # disconnected — the client id still identifies its lobby.
        lobby = find_lobby_by_client(client_id)

    if not lobby:
        await sio.emit("join_error", {"error": "not found"}, room=sid)
        return

    code = lobby.code
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
    await broadcast(lobby, "chat", msg)
    return jsonify({"ok": True})


def _require_host(lobby, client_id):
    return lobby.host_id == client_id


def _require_controller(lobby, client_id):
    """Host OR a DJ the host has appointed (see /dj and Lobby.djs). This is
    the gate for everything that drives the player and the queue; lobby
    settings and DJ management stay host-only (_require_host)."""
    return lobby.host_id == client_id or client_id in lobby.djs


@app.route("/api/lobby/<code>/history", methods=["GET"])
async def lobby_history(code):
    """History + smart-pool contents (public_state only carries the counts).
    Controllers only; the host's browser caches this so saved sessions can
    include both."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    if not _require_controller(lobby, request.args.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    limit = int(getattr(config, "RESTORE_MAX_QUEUE", 500))
    tracks = [t for t in (_clean_track(x) for x in lobby.history[-limit:]) if t]
    smart = [t for t in (_clean_track(x) for x in lobby.auto_queue[:limit]) if t]
    return jsonify({"history": tracks, "count": len(lobby.history),
                    "smart": smart, "smartCount": len(lobby.auto_queue)})


@app.route("/api/lobby/<code>/play", methods=["POST"])
async def lobby_play(code):
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    client_id = data.get("clientId")
    if not _require_controller(lobby, client_id):
        return jsonify({"error": "host or DJ only"}), 403
    # Resuming from true silence (nothing currently playing) reuses the
    # existing pipeline if the relay is still parked idle-alive; interrupting
    # a track that's actively playing still needs a hard restart, since
    # there's a live NodeLink fetch to abandon mid-stream.
    was_idle = lobby.current_track is None
    if lobby.current_track:
        lobby.history.append(lobby.current_track)
    lobby.current_track = stamp_requester(data.get("track"), lobby.participants.get(client_id))
    lobby.paused = False
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    if was_idle:
        await lobby.relay.resume_or_start(lobby.current_track, 0)
    else:
        await lobby.relay.start_track(lobby.current_track, 0)
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
        await lobby.relay.start_track(lobby.current_track, 0)
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    prev = lobby.previous_track()
    if prev is None:
        return jsonify({"error": "no previous track"}), 400
    was_idle = lobby.current_track is None
    lobby.current_track = prev
    lobby.position_anchor_ms = 0
    lobby.anchor_time = time.time()
    lobby.paused = False
    if was_idle:
        await lobby.relay.resume_or_start(prev, 0)
    else:
        await lobby.relay.start_track(prev, 0)
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    lobby.gapless = bool(data.get("enabled"))
    lobby.relay.ensure_preload()  # ON: start prefetching now; OFF: drop whatever was in flight
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/dj", methods=["POST"])
async def lobby_dj(code):
    """Host-only: appoint (or remove) a Disc Jockey. A DJ can control the
    player and the queue exactly like the host — play/pause/seek/skip/stop,
    loop/autoplay/gapless/fair, and every queue operation — but can't change
    lobby settings or appoint other DJs. `enabled` omitted toggles."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    target = data.get("targetId")
    p = lobby.participants.get(target)
    if not p:
        return jsonify({"error": "that user isn't in the lobby"}), 404
    if target == lobby.host_id:
        return jsonify({"error": "the host already controls everything"}), 400
    enabled = data.get("enabled")
    enabled = (target not in lobby.djs) if enabled is None else bool(enabled)
    if enabled == (target in lobby.djs):
        return jsonify({"ok": True, "isDj": enabled, "state": lobby.public_state()})
    if enabled:
        lobby.djs.add(target)
    else:
        lobby.djs.discard(target)
    await broadcast(lobby, "chat", {
        "system": True,
        "text": f"🎧 {p.name} is now a DJ" if enabled else f"{p.name} is no longer a DJ",
        "ts": time.time() * 1000,
    })
    await broadcast(lobby, "participants", lobby.participant_list())
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "isDj": enabled, "state": state})


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
    if "password" in data:
        lobby.set_password(data.get("password"))   # empty string removes it
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state})


@app.route("/api/lobby/<code>/code", methods=["POST"])
async def lobby_change_code(code):
    """Host-only: pick your own lobby code instead of the random one. Must be
    exactly LOBBY_CODE_LENGTH letters (A-Z) and not belong to any running
    lobby. Re-keys the lobby in the registry and moves every connected
    socket into the new Socket.IO room, then broadcasts the new code."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_host(lobby, data.get("clientId")):
        return jsonify({"error": "host only"}), 403
    new_code = clean_code(data.get("newCode"))
    if not new_code:
        return jsonify({"error": f"Lobby codes are exactly {config.LOBBY_CODE_LENGTH} letters (A-Z)"}), 400
    if new_code == lobby.code:
        return jsonify({"ok": True, "state": lobby.public_state()})
    if code_in_use(new_code):
        return jsonify({"error": f"The code {new_code} is already in use by another lobby"}), 409

    old = lobby.code
    # Claim + release with no await in between: the registry never shows
    # the lobby under both codes, or neither.
    LOBBIES[new_code] = lobby
    LOBBIES.pop(old, None)
    lobby.code = new_code
    lobby.relay.audio_out.code = new_code
    for cid, sids in list(lobby.sids.items()):
        for sid in list(sids):
            _sid_registry[sid] = (new_code, cid)
            try:
                await sio.leave_room(sid, old)
                await sio.enter_room(sid, new_code)
            except Exception:
                traceback.print_exc()

    await broadcast(lobby, "chat", {"system": True, "text": f"Lobby code changed to {new_code}", "ts": time.time() * 1000})
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
        await lobby.relay.resume_or_start(lobby.current_track, 0)
        await populate_recommendations(lobby)
    else:
        lobby.queue.append(track)
        lobby.apply_fair()
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

    lobby.apply_fair()
    if started_playback:
        await lobby.relay.resume_or_start(lobby.current_track, 0)
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
    if not _require_controller(lobby, client_id) and requester_key(entry) != client_id:
        return jsonify({"error": "you can only remove tracks you added"}), 403
    lobby.queue.pop(idx)
    lobby.apply_fair()
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    random.shuffle(lobby.queue)
    lobby.apply_fair()   # with Fair on this only shuffles within each person's own tracks
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    if not lobby.current_track:
        return jsonify({"error": "nothing playing to base recommendations on"}), 400

    try:
        count = max(1, int(data.get("count", 20)))
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

    # Shuffle the pool BEFORE taking from it, so the picks aren't just the
    # first ones parked (which come from the earliest-played seeds).
    random.shuffle(lobby.auto_queue)
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
    lobby.apply_fair()
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


@app.route("/api/lobby/<code>/fair", methods=["POST"])
async def lobby_fair(code):
    """Host-only: turn Fair Queue ON or OFF for the whole lobby — same shape
    as /gapless. While ON, every queue operation re-balances the queue
    between whoever added the tracks (see Lobby.apply_fair), so one
    person's 40-track playlist doesn't bury everyone else. Turning it ON
    re-balances the current queue right away; turning it OFF just stops
    the automatic re-balancing and leaves the queue as it is."""
    lobby = get_lobby_or_404(code)
    if not lobby:
        return jsonify({"error": "not found"}), 404
    data = await request.get_json(force=True, silent=True) or {}
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    lobby.fair = bool(data.get("enabled"))
    changed = lobby.apply_fair()
    if changed:
        lobby.relay.ensure_preload()
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "changed": changed, "state": state})


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
    if not _require_controller(lobby, data.get("clientId")):
        return jsonify({"error": "host or DJ only"}), 403
    from_idx = data.get("fromIndex")
    to_idx = data.get("toIndex")
    fair_snapped = False
    if (isinstance(from_idx, int) and isinstance(to_idx, int)
            and 0 <= from_idx < len(lobby.queue) and 0 <= to_idx < len(lobby.queue)
            and from_idx != to_idx):
        item = lobby.queue.pop(from_idx)
        lobby.queue.insert(to_idx, item)
        # With Fair on, a move that crosses between people snaps back to
        # the alternating order; moves among one person's own tracks stick.
        # fairSnapped lets the client say so instead of the row silently
        # jumping back.
        fair_snapped = lobby.apply_fair()
        lobby.relay.ensure_preload()  # the queue head may have changed
    state = lobby.public_state()
    await broadcast(lobby, "state", state)
    return jsonify({"ok": True, "state": state, "fairSnapped": fair_snapped})


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
if __name__ == "__main__":
    import uvicorn

    print(f"[NodeLink Lobby Server] NodeLink node: {NL_HOST}")
    print(f"[NodeLink Lobby Server] Lobby music transport: raw PCM over QUIC/WebTransport (udp/{QUIC_PORT})")
    print(f"[NodeLink Lobby Server] Realtime transport: Socket.IO (WebSocket, long-polling fallback)")
    print(f"[NodeLink Lobby Server] Listening on http://{config.FLASK_HOST}:{config.FLASK_PORT}")

    # Quart's own app.run() only serves `app` — the plain Quart/REST
    # layer. Socket.IO is mounted a level above that (see `asgi_app`
    # near the top of this file), so it has to be what actually gets
    # served, or every websocket/polling request 404s.
    uvicorn.run("server:asgi_app", host=config.FLASK_HOST, port=config.FLASK_PORT, reload=True)