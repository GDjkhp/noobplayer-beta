'use strict';
/* ═══════════════════════════════════════════
   AudioElPlayer — wraps a plain <audio> element so it satisfies the same
   interface as PCMPlayer (getPositionMs/isPaused/getLevels/setVolume/
   pause/resume/destroy). Used for lobby (server) mode, where playback is
   now a server-side Opus/Ogg relay and the client is just <audio src=...>
   — no local PCM decode/scheduling. Keeping the same interface as
   PCMPlayer means ui.js (progress bar, EQ, level meter, play/pause
   icons) works completely unchanged regardless of which mode is active.

   Position is intentionally NOT read from audio.currentTime: a listener
   who joins mid-track only starts receiving bytes from "now" (it's a
   live relay, not a seekable file), so audio.currentTime would read
   from 0 at connect time, not the track's true elapsed position. The
   server already computes and broadcasts the authoritative position
   (anchor + elapsed wall-clock); setAnchor() below just mirrors that
   same anchor math locally so the progress bar reads correctly between
   broadcasts.
═══════════════════════════════════════════ */
class AudioElPlayer {
  constructor(audioEl) {
    this.audio = audioEl;
    this._anchorMs = 0;
    this._anchorWall = performance.now();
    this._anchorPaused = true;

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.srcNode = this.ctx.createMediaElementSource(audioEl);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.srcNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch (e) {
      // Level metering is best-effort — playback itself doesn't depend
      // on this WebAudio graph, so degrade gracefully if it fails.
      this.ctx = null; this.analyser = null;
    }
  }

  // Called on every server state broadcast to keep local position math
  // anchored to the server's authoritative anchor + timestamp.
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
    if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
    try { await this.audio.play(); } catch (_) { /* likely blocked pending a user gesture; retried on next interaction */ }
  }

  pause() {
    this._anchorPaused = true;
    this.audio.pause();
  }

  setVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); }

  getLevels() {
    if (!this.analyser) return [0, 0];
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return [peak, peak];
  }

  async destroy() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    try { this.audio.load(); } catch (_) {}
    try { this.srcNode && this.srcNode.disconnect(); } catch (_) {}
    try { this.analyser && this.analyser.disconnect(); } catch (_) {}
    try { if (this.ctx) await this.ctx.close(); } catch (_) {}
  }
}