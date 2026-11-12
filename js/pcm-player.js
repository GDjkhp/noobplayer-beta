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
    // ctx.suspend() is async — ctx.state keeps reading 'running' for a beat
    // after pause() is called. This flag flips synchronously so isPaused (and
    // the Media Session playbackState derived from it) is never stale.
    this._wantPaused = false;
    // Every AudioBufferSourceNode `feed()` has scheduled, so a hard cutover
    // (see `cutOver` below) can stop them all instantly instead of letting
    // whatever's already scheduled keep playing out.
    this._sources = [];
    // Minimum scheduling lead. 20ms is fine for standalone; the lobby
    // player raises it a little so network jitter doesn't underrun.
    this.minLead = 0.02;
  }

  async init(volume = 0.8) {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch (_) {} }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.SR });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.analyser = this.ctx.createAnalyser();
    // ONE analyser feeds everything (levels, visualizers, beat detection), raw:
    // no smoothing, so transients arrive untouched. 2048 (1024 bins, ~23 Hz each at
    // 48 kHz) is what resolves the kick/bass range; at 512 it was two ~94 Hz bins.
    // Visualizers that want smoother motion do their own smoothing.
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._beat = { out: 0, floor: 0, peak: 0, t: 0, buf: null };
    this.nextTime = this.ctx.currentTime + 0.08;
    this.startCtxTime = null;
    this.remainder = new Uint8Array(0);
    this._suspendedMs = null;
    this._wantPaused = false;
    this._sources = [];
    // Keep the OS media controls in sync with the REAL context state, so a
    // state change that lands after the fact still updates playbackState.
    this.ctx.onstatechange = () => {
      if (typeof UI !== 'undefined' && UI.updateMediaSession) UI.updateMediaSession();
    };
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
    this.feedPlanar(floatL, floatR);
  }

  // Schedules already-decoded planar float audio (-1..1). feed() above
  // converts s16le bytes and lands here; WebTransportPlayer's WebCodecs
  // Opus decoder calls this directly.
  feedPlanar(floatL, floatR) {
    if (!this.ctx || this.ctx.state === 'closed') return;
    const frames = floatL.length;
    if (!frames) return;

    const buf = this.ctx.createBuffer(this.CH, frames, this.SR);
    buf.copyToChannel(floatL, 0);
    buf.copyToChannel(floatR, 1);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    const when = Math.max(this.nextTime, this.ctx.currentTime + this.minLead);
    src.start(when);
    this._sources.push(src);
    src.onended = () => {
      const i = this._sources.indexOf(src);
      if (i !== -1) this._sources.splice(i, 1);
    };
    if (this.startCtxTime === null) this.startCtxTime = when;
    this.nextTime = when + buf.duration;
  }

  // When the next fed frame will start playing / how far ahead of the
  // speakers everything already scheduled reaches.
  nextStartTime() { return this.ctx ? Math.max(this.nextTime, this.ctx.currentTime + this.minLead) : 0; }
  leadSec() { return this.ctx ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0; }

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
  // `at` lets the caller anchor to a boundary captured earlier (engine.js
  // feeds the next track's audio immediately but only commits the switch
  // once that boundary is actually audible, by which time nextTime has
  // moved on).
  markTrackBoundary(offsetMs = 0, at = this.nextTime) {
    this.startCtxTime = at;
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
    this.nextTime = this.ctx.currentTime + this.minLead;
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

  // Beat pulse, 0-1, from the same raw analyser as everything else. Looks only at the kick/bass range (BEAT_LO-BEAT_HI Hz) and rates it
  // against what that band has been doing lately, so it is ~0 between beats and ~1 on a
  // kick, for quiet and loud songs alike (the old 0-2.9 kHz average sat near max all song).
  //   floor = slow average of the band      peak = recent maximum (decays over ~3 s)
  //   pulse = (now - floor) / (peak - floor), taken raw each frame.
  // Safe to call from several places per frame: it only recomputes every few ms.
  getBeat() {
    const a = this.analyser, b = this._beat;
    if (!a || !b) return 0;
    const now = performance.now();
    if (b.t && now - b.t < 6) return b.out;
    const dt = b.t ? Math.min((now - b.t) / 1000, 0.1) : 0.016;
    b.t = now;
    if (this.isPaused) { b.out = 0; return 0; }

    const n = a.frequencyBinCount;
    if (!b.buf || b.buf.length !== n) b.buf = new Uint8Array(n);
    a.getByteFrequencyData(b.buf);
    const hz = this.ctx.sampleRate / a.fftSize;
    const lo = Math.max(1, Math.round(PCMPlayer.BEAT_LO / hz));
    const hi = Math.max(lo + 1, Math.round(PCMPlayer.BEAT_HI / hz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += b.buf[i];
    const x = sum / (hi - lo + 1) / 255;

    b.floor += (x - b.floor) * (1 - Math.exp(-dt / 0.8));
    b.peak = x > b.peak ? x : b.peak + (x - b.peak) * (1 - Math.exp(-dt / 3));
    let target = 0;
    if (b.peak > 0.08) {                                   // silence gate
      const range = Math.max(b.peak - b.floor, 0.1);
      const norm = Math.max(0, Math.min(1, (x - b.floor) / range));
      target = norm < 0.12 ? 0 : Math.pow(norm, 1.25);
    }
    b.out = target;                                         // raw, this frame only
    return b.out;
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
      this._wantPaused = true;
      this._suspendP = this.ctx.suspend().catch(() => {});
    }
  }

  async resume() {
    this._wantPaused = false;
    if (this._suspendP) { await this._suspendP; this._suspendP = null; }   // a quick pause→resume must not be undone by the pending suspend
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
      this._suspendedMs = null;
    }
  }

  setVolume(v) { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(2, v)); }

  get isPaused() { return !this.ctx || this._wantPaused || this.ctx.state !== 'running'; }

  // Fires cb once everything scheduled has actually been played. Polls the
  // AudioContext clock instead of arming a wall-clock timeout: ctx.currentTime
  // freezes while suspended, so a long pause can't trigger the track end.
  scheduleEnd(cb) {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    if (!this.ctx) { cb(); return; }
    const tick = () => {
      this._endTimer = null;
      if (!this.ctx || this.ctx.state === 'closed') return;
      // nextTime is read live in case more audio gets scheduled meanwhile.
      if (this.ctx.currentTime >= this.nextTime + 0.3) { cb(); return; }
      this._endTimer = setTimeout(tick, 100);
    };
    this._endTimer = setTimeout(tick, 100);
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

// Band the beat pulse listens to (Hz): the kick drum / sub-bass. Change these to retune it.
PCMPlayer.BEAT_LO = 35;
PCMPlayer.BEAT_HI = 140;