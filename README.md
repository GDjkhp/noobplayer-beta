# NodeLink Client — Server Mode Setup

This folder contains the Flask + aiortc backend that powers **Server / Lobby
mode**. Standalone mode needs none of this — it's only required if you want
shared lobbies (synced playback + chat + voice).

## 1. Install dependencies

```bash
cd server
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

`aiortc` needs system-level audio/video codec libraries on some platforms:

- **Debian/Ubuntu**: `sudo apt install libavdevice-dev libavfilter-dev libopus-dev libvpx-dev pkg-config`
- **macOS**: `brew install ffmpeg opus`
- **Windows**: prebuilt wheels usually work out of the box via pip.

If `aiortc`/`av` fail to install, the server still runs — voice chat is
simply disabled (music sync, chat, and lobbies all still work).

## 2. Set your NodeLink credentials

Edit `server/config.py`:

```python
NODELINK_HOST = "https://your-nodelink-host:443"
NODELINK_PASSWORD = "your-password"
```

The browser never sees these — every NodeLink call (search, stream, lyrics,
chapters, meaning) is proxied through Flask.

## 3. Run it

The backend is built on **Quart** (an async, Flask-shaped framework) rather
than Flask, because aiortc's WebRTC calls are `async`/`await` natively —
Quart lets route handlers `await` them directly instead of bouncing work
onto a background thread.

Dev mode:

```bash
python server.py
```

Production (recommended — runs under Hypercorn, Quart's ASGI server):

```bash
hypercorn server:app --bind 0.0.0.0:42069
```

Either way, this serves **both** the API and the static frontend
(`index.html`, `css/`, `js/` one directory up) on the same origin — so
opening `http://localhost:42069` and picking "Server Mode → Use this server
(default)" just works with no extra config.

To let others join your lobbies, either port-forward `42069` or deploy this
behind a reverse proxy (nginx/Caddy) with a real domain + TLS — WebRTC and
`getUserMedia` require a secure context (HTTPS or `localhost`) in the
browser.

## How it works

### Music sync (no audio relay)
The server keeps *authoritative* playback state per lobby: current track,
paused/playing, and a `(position_anchor_ms, anchor_time)` pair. It does
**not** forward audio bytes for music. Instead, every client independently
streams identical PCM from NodeLink via `/api/nodelink/loadstream`,
computing their local start position from the broadcast anchor. This keeps
server bandwidth flat no matter how many people are listening, and reuses
the exact same `PCMPlayer` engine as standalone mode.

State changes are pushed to every participant over Server-Sent Events
(`/api/lobby/<code>/events`), so no polling is needed.

### Voice chat (real audio relay)
Voice needs actual low-latency audio, so it goes over WebRTC. Each client
opens **one** `RTCPeerConnection` to the server: their mic goes up, and they
receive back a personalized **mixed track** — the server sums every other
participant's audio for them live (`MixedAudioTrack` in `server.py`). New
joiners are automatically included in everyone's mix without any
renegotiation, since the mixer reads the current participant list on every
frame.

This is a lightweight, best-effort mixer suitable for small lobbies (a
handful of simultaneous speakers). It is not a production-grade SFU — there's
no jitter buffer tuning, no Opus bitrate control, and ICE uses a public STUN
server only (add a TURN server in `config.py` if your users are behind
strict NATs).

### Permissions
Whoever creates a lobby is the **host**. Only the host can play/pause/seek/
skip/change filters — this keeps playback from fighting itself with multiple
people clicking buttons. Anyone can add tracks to the shared queue and use
text/voice chat. If the host leaves, the next remaining participant is
promoted automatically.

## Endpoints reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/lobby/create` | Create a lobby, become host |
| POST | `/api/lobby/join` | Join by 6-letter code |
| GET  | `/api/lobby/public` | List public lobbies |
| POST | `/api/lobby/<code>/leave` | Leave a lobby |
| GET  | `/api/lobby/<code>/events` | SSE stream: state / participants / chat |
| POST | `/api/lobby/<code>/chat` | Send a chat message |
| POST | `/api/lobby/<code>/play` \| `/pause` \| `/resume` \| `/seek` \| `/skip` \| `/filters` | Host-only playback control |
| POST | `/api/lobby/<code>/queue/add` \| `/queue/remove` | Anyone can manage the shared queue |
| POST | `/api/lobby/<code>/webrtc/offer` | WebRTC signaling for voice |
| GET/POST | `/api/nodelink/*` | Proxies to your NodeLink node |
