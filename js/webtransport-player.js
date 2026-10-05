'use strict';
/* ═══════════════════════════════════════════
   WebTransportPlayer — lobby (server) mode's audio transport AND
   playback engine. Composes a PCMPlayer (pcm-player.js) for the actual
   AudioContext scheduling and decodes the relay's Opus stream with
   WebCodecs (see QuicPcmRelay in server.py for the wire format).

   THE SERVER IS THE PLAYER. This class never pauses, never seeks and
   never guesses a position:
     - Pause is server-side: the relay keeps streaming silence and marks
       the timeline "not running". Nothing here suspends the
       AudioContext, so there's no stale client buffer to replay on
       resume.
     - Skip/seek/filter change arrive as a "cut": everything scheduled
       but not yet audible is stopped instantly, then the new audio
       plays.
     - Position (progress bar, lyrics, media session) is read off the
       timeline events the relay embeds in the stream — "the next audio
       frame is at X ms, running or frozen" — anchored to the exact
       AudioContext time that frame plays, so it tracks what you HEAR,
       not when a REST/socket message happened to arrive.
   Socket.IO 'state' broadcasts still drive what track/queue/pause
   button to SHOW (setAnchor/isPaused); setAnchor's position is only a
   fallback until the first in-band timeline event arrives.
═══════════════════════════════════════════ */
const WT_MIN_LEAD  = 0.08;  // s of scheduling margin (jitter absorber)
const WT_LEAD_HIGH = 0.60;  // s ahead of the speakers before we assume a backlog...
const WT_LEAD_LOW  = 0.15;  // ...and drop live frames until we're back down to this

class WebTransportPlayer {
  constructor() {
    this._pcm = new PCMPlayer();
    this._pcm.minLead = WT_MIN_LEAD;
    this._pcmReady = this._pcm.init(0.8);
    this._transport = null;
    this._closed = false;
    this._live = false;             // WebTransport session open and not yet dropped
    this.onClosed = null;           // set by Lobby._connectMedia — called when the session dies on its own

    this._decoder = null;
    this._rx = new Uint8Array(0);   // partial length-prefixed message carry-over
    this._ts = 0;                   // µs timestamp handed to the decoder
    this._events = [];              // timeline events waiting for their place in decoded order
    this._inflight = 0;             // chunks submitted to the decoder, outputs not yet seen
    this._evTimer = null;
    this._catchup = false;
    this._tl = [];                  // playout timeline: [{ when (ctx s), pos (ms), running }]

    // Fallback only — see class comment.
    this._anchorMs = 0;
    this._anchorWall = performance.now();
    this._anchorPaused = true;
  }

  async connect(url, certHashHex) {
    await this._pcmReady;
    // Missing browser features can't be fixed by retrying — flag them so
    // the self-heal loop doesn't spin forever on them.
    const unsupported = (msg) => Object.assign(new Error(msg), { nonRetryable: true });
    if (typeof WebTransport === 'undefined') throw unsupported('this browser has no WebTransport (needed for the lobby audio stream)');
    if (typeof AudioDecoder === 'undefined') throw unsupported('this browser has no WebCodecs AudioDecoder (needed for the Opus lobby stream)');
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    const sup = await AudioDecoder.isConfigSupported(cfg);
    if (!sup.supported) throw unsupported('this browser cannot decode Opus via WebCodecs');
    this._decoder = new AudioDecoder({
      output: (ad) => this._onDecoded(ad),
      error: (e) => { if (!this._closed) console.warn('Opus decoder error:', e); },
    });
    this._decoder.configure(cfg);

    const bytes = certHashHex.match(/../g).map((h) => parseInt(h, 16));
    this._transport = new WebTransport(url, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(bytes) }],
    });
    await this._transport.ready;
    this._live = true;

    // If the session dies on its own (server restart, network drop) hand it
    // to the self-heal loop; without a handler fall back to the old toast.
    const dropped = (msg, kind, ms) => {
      this._live = false;
      if (this._closed) return;
      if (this.onClosed) this.onClosed(); else toast(msg, kind, ms);
    };
    this._transport.closed
      .then(() => dropped('Lobby audio connection closed', 'warn', 4000))
      .catch(() => dropped('Lobby audio connection dropped — try leaving and rejoining', 'error', 6000));

    const streamsReader = this._transport.incomingUnidirectionalStreams.getReader();
    const { value: stream, done } = await streamsReader.read();
    if (done || !stream) throw new Error('lobby relay never opened an audio stream');
    this._readLoop(stream.getReader());
  }

  async _readLoop(reader) {
    try {
      while (!this._closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this._ingest(value);
      }
    } catch (e) {
      if (!this._closed) console.warn('WebTransportPlayer read loop ended:', e);
    }
  }

  // Messages: [uint16 BE length][type u8][body]. type 0 = Opus packet,
  // type 1 = timeline sync [flags u8][positionMs f64 BE] (bit0 running,
  // bit1 cut). Stream reads can split/merge messages arbitrarily.
  _ingest(chunk) {
    let buf = chunk;
    if (this._rx.length) {
      buf = new Uint8Array(this._rx.length + chunk.length);
      buf.set(this._rx); buf.set(chunk, this._rx.length);
    }
    let off = 0;
    while (buf.length - off >= 2) {
      const len = (buf[off] << 8) | buf[off + 1];
      if (buf.length - off - 2 < len) break;
      const msg = buf.subarray(off + 2, off + 2 + len);
      off += 2 + len;
      if (!len) continue;
      if (msg[0] === 0) {
        if (this._decoder && this._decoder.state === 'configured') {
          try {
            this._decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this._ts, data: msg.subarray(1) }));
            this._inflight++;
          } catch (e) { console.warn('Opus decode failed:', e); }
        }
        this._ts += 20000;
      } else if (msg[0] === 1 && len >= 10) {
        const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
        const flags = msg[1];
        // Applies right before the audio packet that FOLLOWS it (ts of
        // the next chunk), i.e. in decoded-audio order.
        this._events.push({ ts: this._ts, running: !!(flags & 1), cut: !!(flags & 2), pos: dv.getFloat64(2, false) });
      }
    }
    this._rx = off < buf.length ? buf.slice(off) : new Uint8Array(0);

    if (this._events.length) {
      if (this._inflight <= 0) this._applyEvents(Infinity);   // nothing decoding: apply now (e.g. a cut while the source is still loading)
      else if (!this._evTimer) {
        // Safety net if the decoder ever emits fewer outputs than chunks.
        this._evTimer = setTimeout(() => { this._evTimer = null; this._applyEvents(Infinity); }, 80);
      }
    }
  }

  _applyEvents(uptoTs) {
    while (this._events.length && this._events[0].ts <= uptoTs) this._applyEvent(this._events.shift());
  }

  _applyEvent(ev) {
    if (ev.cut) {
      // Skip/seek/filter change/stop: kill everything already scheduled.
      this._pcm.cutOver(0);
      this._tl = [];
      this._catchup = false;
    } else if (this._catchup) {
      return;   // describes audio we're dropping to catch up — the next sync re-anchors
    }
    this._tl.push({ when: this._pcm.nextStartTime(), pos: ev.pos, running: ev.running });
    if (this._tl.length > 64) this._tl.splice(0, this._tl.length - 32);
  }

  _onDecoded(ad) {
    this._inflight = Math.max(0, this._inflight - 1);
    try {
      this._applyEvents(ad.timestamp);

      // Stay live: if a stall/burst left us far ahead of the speakers,
      // drop frames until the backlog has played down — the server is
      // the clock, not our queue.
      const lead = this._pcm.leadSec();
      if (this._catchup) { if (lead <= WT_LEAD_LOW) this._catchup = false; }
      else if (lead > WT_LEAD_HIGH) this._catchup = true;
      if (this._catchup) return;

      const n = ad.numberOfFrames;
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
      ad.copyTo(R, { planeIndex: ad.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
      this._pcm.feedPlanar(L, R);
    } finally {
      ad.close();
    }
  }

  // ── server state mirroring (what the buttons show) + position ──
  // setAnchor is called on every 'state' broadcast. The paused flag is
  // the server's, applied instantly; the position is only used until the
  // in-band timeline has produced one.
  setAnchor(positionMs, paused) {
    this._anchorMs = positionMs;
    this._anchorWall = performance.now();
    this._anchorPaused = paused;
  }

  get isPaused() { return this._anchorPaused; }

  // True while the WebTransport session is open — the heal loop uses this
  // to decide whether the audio side needs rebuilding.
  get connected() { return this._live && !this._closed; }

  getPositionMs() {
    const ctx = this._pcm.ctx;
    if (!ctx || !this._tl.length) {
      return this._anchorPaused ? this._anchorMs : this._anchorMs + (performance.now() - this._anchorWall);
    }
    const t = ctx.currentTime - (ctx.outputLatency || 0);   // what's audible now
    while (this._tl.length > 1 && this._tl[1].when <= t) this._tl.shift();
    const ev = this._tl[0];
    if (!ev.running || t <= ev.when) return ev.pos;
    return ev.pos + (t - ev.when) * 1000;
  }

  // Only ever makes sure the AudioContext is allowed to run (autoplay
  // policy). Never used for pausing.
  async resume() {
    await this._pcmReady;
    await this._pcm.resume();
  }

  // Deliberately does NOT touch the AudioContext: pausing is the
  // server's job (it streams silence), so nothing stale is left here.
  pause() { this._anchorPaused = true; }

  setVolume(v) { this._pcm.setVolume(v); }
  getLevels() { return this._pcm.getLevels(); }

  // ── visualizer feeds — identical surface to PCMPlayer ──
  get binCount() { return this._pcm.binCount; }
  getSpectrum(out) { return this._pcm.getSpectrum(out); }
  getWaveform(out) { return this._pcm.getWaveform(out); }

  async destroy() {
    this._closed = true;
    this._live = false;
    if (this._evTimer) { clearTimeout(this._evTimer); this._evTimer = null; }
    if (this._decoder) { try { this._decoder.close(); } catch (_) {} this._decoder = null; }
    if (this._transport) { try { this._transport.close(); } catch (_) {} this._transport = null; }
    await this._pcm.destroy();
  }
}