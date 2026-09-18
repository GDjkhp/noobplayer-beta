'use strict';
/* ═══════════════════════════════════════════
   PCMPlayer — Web Audio API decoder/scheduler
   Format: signed 16-bit little-endian, 48 kHz, 2ch stereo
   Fed chunks from a ReadableStream (NodeLink /v4/loadstream)
═══════════════════════════════════════════ */
class PCMPlayer {
  constructor() {
    this.SR = 48000;
    this.CH = 2;
    this.BPF = 4; // bytes per frame (2ch x 2 bytes)
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.nextTime = 0;
    this.startCtxTime = null;
    this.remainder = new Uint8Array(0);
    this._endTimer = null;
    this.seekOffsetMs = 0;
    this._suspendedMs = null;
    // Every AudioBufferSourceNode `feed()` has scheduled, so a hard cutover
    // (see `cutOver` below) can stop them all instantly instead of letting
    // whatever's already scheduled keep playing out.
    this._sources = [];
  }

  async init(volume = 0.8) {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch (_) {} }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.SR });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.analyser = this.ctx.createAnalyser();
    // 512 (256 bins) rather than 256: the level meter only ever needed a
    // peak, but visualizers want enough frequency resolution to look like
    // something. Still cheap enough to read every animation frame.
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.nextTime = this.ctx.currentTime + 0.08;
    this.startCtxTime = null;
    this.remainder = new Uint8Array(0);
    this._suspendedMs = null;
    this._sources = [];
    return this;
  }

  feed(bytes) {
    if (!this.ctx || this.ctx.state === 'closed') return;
    let data;
    if (this.remainder.length > 0) {
      data = new Uint8Array(this.remainder.length + bytes.length);
      data.set(this.remainder); data.set(bytes, this.remainder.length);
      this.remainder = new Uint8Array(0);
    } else {
      data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    }

    const frames = Math.floor(data.length / this.BPF);
    if (frames === 0) { this.remainder = data; return; }
    const used = frames * this.BPF;
    if (data.length > used) this.remainder = data.slice(used);

    const floatL = new Float32Array(frames);
    const floatR = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const b = i * 4;
      let l = data[b] | (data[b + 1] << 8);
      if (l > 32767) l -= 65536;
      floatL[i] = l / 32768.0;
      let r = data[b + 2] | (data[b + 3] << 8);
      if (r > 32767) r -= 65536;
      floatR[i] = r / 32768.0;
    }

    const buf = this.ctx.createBuffer(this.CH, frames, this.SR);
    buf.copyToChannel(floatL, 0);
    buf.copyToChannel(floatR, 1);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    const when = Math.max(this.nextTime, this.ctx.currentTime + 0.02);
    src.start(when);
    this._sources.push(src);
    src.onended = () => {
      const i = this._sources.indexOf(src);
      if (i !== -1) this._sources.splice(i, 1);
    };
    if (this.startCtxTime === null) this.startCtxTime = when;
    this.nextTime = when + buf.duration;
  }

  getPositionMs() {
    if (!this.ctx) return this.seekOffsetMs;
    if (this.ctx.state === 'suspended' && this._suspendedMs !== null) return this._suspendedMs;
    if (this.startCtxTime === null) return this.seekOffsetMs;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
    return this.seekOffsetMs + elapsed * 1000;
  }

  // Called at a gapless splice: the next track's audio picks up exactly
  // where the previous one's scheduled buffers end (`this.nextTime`), on
  // the SAME AudioContext timeline — no init(), no new context, no gap.
  // This just re-anchors position reporting (progress bar, lyrics sync,
  // etc.) to that same instant so it reads 0:00 for the new track instead
  // of continuing the previous track's elapsed time.
  markTrackBoundary(offsetMs = 0) {
    this.startCtxTime = this.nextTime;
    this.seekOffsetMs = offsetMs;
  }

  // Hard cutover: stops every buffer this player has scheduled — whether
  // it's already audibly playing or still queued up ahead — RIGHT NOW, and
  // resets the scheduling clock to "this instant", all on the SAME
  // AudioContext. Used for an interrupt (Next/Previous/explicit play, or a
  // filter change) where the point is to switch immediately rather than
  // let more of the current audio play out first (that's what
  // markTrackBoundary above is for). Because the context itself is never
  // closed/recreated, there's no re-init delay and nothing to reconnect —
  // feed() can start scheduling the new audio again the instant this
  // returns, which is what makes the switch gapless instead of a beat of
  // silence.
  cutOver(offsetMs = 0) {
    if (!this.ctx) return;
    for (const src of this._sources) { try { src.stop(0); } catch (_) {} }
    this._sources = [];
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    this.nextTime = this.ctx.currentTime + 0.02;
    this.startCtxTime = null;
    this.seekOffsetMs = offsetMs;
    this.remainder = new Uint8Array(0);
    this._suspendedMs = null;
  }

  getLevels() {
    if (!this.analyser) return [0, 0];
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return [peak, peak];
  }

  // ── visualizer feeds ──
  // Both players expose these identically (see AudioElPlayer), so
  // visualizer.js never has to know which mode is running — same reason
  // getLevels/getPositionMs/isPaused are duplicated across the two.
  get binCount() { return this.analyser ? this.analyser.frequencyBinCount : 0; }

  getSpectrum(out) {
    if (!this.analyser) return null;
    const n = this.analyser.frequencyBinCount;
    if (!out || out.length !== n) out = new Uint8Array(n);
    this.analyser.getByteFrequencyData(out);
    return out;
  }

  getWaveform(out) {
    if (!this.analyser) return null;
    const n = this.analyser.fftSize;
    if (!out || out.length !== n) out = new Uint8Array(n);
    this.analyser.getByteTimeDomainData(out);
    return out;
  }

  pause() {
    if (this.ctx && this.ctx.state === 'running') {
      this._suspendedMs = this.getPositionMs();
      this.ctx.suspend();
    }
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
      this._suspendedMs = null;
    }
  }

  setVolume(v) { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(2, v)); }

  get isPaused() { return !this.ctx || this.ctx.state !== 'running'; }

  scheduleEnd(cb) {
    if (this._endTimer) clearTimeout(this._endTimer);
    if (!this.ctx) { cb(); return; }
    const drainMs = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000) + 300;
    this._endTimer = setTimeout(cb, drainMs);
  }

  async destroy() {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch (_) {} this.ctx = null; }
    this.remainder = new Uint8Array(0);
    this.startCtxTime = null;
    this._suspendedMs = null;
    this._sources = [];
  }
}