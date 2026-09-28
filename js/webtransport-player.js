'use strict';
/* ═══════════════════════════════════════════
   WebTransportPlayer — lobby (server) mode's audio transport AND
   playback engine, replacing AudioElPlayer + hls.js entirely. Composes
   a PCMPlayer (see pcm-player.js) for the actual AudioContext
   scheduling — the bytes arriving over the WebTransport session are
   the exact same 48kHz/stereo/s16le format PCMPlayer already knows how
   to feed (see server.py's QuicPcmRelay/WtListener) — and adds on top
   of it:
     - the WebTransport connect + read loop (see connect() below)
     - the same wall-clock anchor-mirroring AudioElPlayer used for
       getPositionMs()/isPaused, kept deliberately SEPARATE from
       PCMPlayer's own AudioContext-clock-based position tracking. The
       raw byte stream carries no per-track timestamps, so there's no
       reliable way to know from the bytes alone when a track boundary
       happened inside it — the server's 'state' broadcasts (see
       Engine._lobbySync) are still the source of truth for what
       track/position to SHOW, exactly like they were with HLS; only
       WHERE the actual sound comes from changed.

   Because this owns a real AudioContext directly (via PCMPlayer)
   rather than routing through an <audio> element +
   createMediaElementSource, it also sidesteps the whole "an element
   can only ever be captured by WebAudio once, for its entire
   lifetime" workaround AudioElPlayer needed — there's no shared DOM
   element to fight over between lobby joins anymore. Each join here is
   just a fresh AudioContext via a fresh PCMPlayer, same as standalone
   mode already worked.
═══════════════════════════════════════════ */
class WebTransportPlayer {
  constructor() {
    this._pcm = new PCMPlayer();
    this._pcmReady = this._pcm.init(0.8);
    this._transport = null;
    this._closed = false;
    this._decoder = null;
    this._rx = new Uint8Array(0);   // partial length-prefixed packet carry-over
    this._ts = 0;                    // µs timestamp for EncodedAudioChunk

    this._anchorMs = 0;
    this._anchorWall = performance.now();
    this._anchorPaused = true;
  }

  // Opens the WebTransport session for one lobby's live audio and starts
  // reading it straight into the PCMPlayer scheduler. `certHashHex` is
  // the self-signed cert's SHA-256 hash from GET /api/quic-info (see
  // LobbyAPI.quicInfo/quicUrl in api.js) — WebTransport's
  // serverCertificateHashes pinning is how the browser trusts it
  // without a real CA involved. A production deployment fronted by a
  // real (CA-signed) certificate instead would just drop the
  // `serverCertificateHashes` option below and connect by hostname —
  // none of the pinning/IP-literal restrictions apply to a normal
  // trusted cert.
  async connect(url, certHashHex) {
    await this._pcmReady;
    if (typeof AudioDecoder === 'undefined') throw new Error('this browser has no WebCodecs AudioDecoder (needed for the Opus lobby stream)');
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    const sup = await AudioDecoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error('this browser cannot decode Opus via WebCodecs');
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

    this._transport.closed
      .then(() => { if (!this._closed) toast('Lobby audio connection closed', 'warn', 4000); })
      .catch(() => { if (!this._closed) toast('Lobby audio connection dropped — try leaving and rejoining', 'error', 6000); });

    // The relay opens exactly ONE unidirectional stream toward us for
    // the whole session (see WtListener in server.py) and just keeps
    // writing to it — grab that one stream off the incoming-streams
    // queue and read it until it ends or the session closes.
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

  // Wire format (see QuicPcmRelay in server.py): repeated
  // [uint16 BE length][Opus packet], one packet per 20 ms. Stream reads
  // can split/merge packets arbitrarily, so keep the tail between reads.
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
      const pkt = buf.subarray(off + 2, off + 2 + len);
      off += 2 + len;
      if (this._decoder && this._decoder.state === 'configured') {
        try {
          this._decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this._ts, data: pkt }));
        } catch (e) { console.warn('Opus decode failed:', e); }
      }
      this._ts += 20000;
    }
    this._rx = off < buf.length ? buf.slice(off) : new Uint8Array(0);
  }

  _onDecoded(ad) {
    try {
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

  // ── UI-facing anchor mirroring (matches AudioElPlayer's contract
  // exactly — see the class doc comment above for why this stays
  // separate from PCMPlayer's own internal AudioContext clock) ──
  setAnchor(positionMs, paused) {
    this._anchorMs = positionMs;
    this._anchorWall = performance.now();
    this._anchorPaused = paused;
  }

  getPositionMs() {
    return this._anchorPaused ? this._anchorMs : this._anchorMs + (performance.now() - this._anchorWall);
  }

  get isPaused() { return this._anchorPaused; }

  async resume() {
    this._anchorPaused = false;
    await this._pcmReady;
    await this._pcm.resume();
  }

  pause() {
    this._anchorPaused = true;
    this._pcm.pause();
  }

  setVolume(v) { this._pcm.setVolume(v); }
  getLevels() { return this._pcm.getLevels(); }

  // ── visualizer feeds — identical surface to PCMPlayer/AudioElPlayer,
  // so visualizer.js never has to know which mode is running ──
  get binCount() { return this._pcm.binCount; }
  getSpectrum(out) { return this._pcm.getSpectrum(out); }
  getWaveform(out) { return this._pcm.getWaveform(out); }

  async destroy() {
    this._closed = true;
    if (this._decoder) { try { this._decoder.close(); } catch (_) {} this._decoder = null; }
    if (this._transport) { try { this._transport.close(); } catch (_) {} this._transport = null; }
    await this._pcm.destroy();
  }
}