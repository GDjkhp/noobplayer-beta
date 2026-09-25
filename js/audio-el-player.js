'use strict';
/* ═══════════════════════════════════════════
   AudioElPlayer — wraps a plain <audio> element so it satisfies the same
   interface as PCMPlayer (getPositionMs/isPaused/getLevels/setVolume/
   pause/resume/destroy). Used for lobby (server) mode, where playback
   arrives as a live HLS stream (see Lobby._connectMedia in lobby.js) —
   hls.js (or native HLS support) feeds the element, no local PCM decode/
   scheduling on this end either way. Keeping the same interface as
   PCMPlayer means ui.js (progress bar, EQ, level meter, play/pause
   icons) works completely unchanged regardless of which mode is active.

   Position is intentionally NOT read from audio.currentTime: a listener
   who joins mid-track only starts receiving segments from "now" (it's a
   live relay, not a seekable file — currentTime is HLS's own internal
   buffer position, not the track's true elapsed time), so it would read
   near 0 at connect time, not the track's actual position. The server
   already computes and broadcasts the authoritative position (anchor +
   elapsed wall-clock); setAnchor() below just mirrors that same anchor
   math locally so the progress bar reads correctly between broadcasts.

   The WebAudio graph (ctx/srcNode/analyser) is cached on the <audio>
   ELEMENT itself (audioEl._waGraph), not on this class instance, and
   built only once per element. createMediaElementSource() can only ever
   be called ONCE for a given <audio>/<video> element, for its entire
   lifetime — a second call throws InvalidStateError even from a brand
   new AudioContext, even after the first context was closed (a real
   WebAudio restriction, not a bug in the try/catch below). #lobby-audio
   is one persistent DOM element reused across every lobby join in the
   page's lifetime (see Lobby._connectMedia), so every join after the
   first used to hit that error — caught silently, degrading to
   ctx=null/analyser=null — and because the element had already been
   captured for WebAudio output by the FIRST (now-closed) context, its
   native output stayed permanently disabled with nowhere to route to:
   playback looked fine (currentTime advancing, segments loading) but
   was completely silent. Building the graph once and reusing it (just
   resetting this instance's own audio-element state in destroy() below)
   avoids the second call entirely.
═══════════════════════════════════════════ */
class AudioElPlayer {
  constructor(audioEl) {
    this.audio = audioEl;
    this._anchorMs = 0;
    this._anchorWall = performance.now();
    this._anchorPaused = true;

    let g = audioEl._waGraph;
    if (!g) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const srcNode = ctx.createMediaElementSource(audioEl);
        const analyser = ctx.createAnalyser();
        // 512 (256 bins) to match PCMPlayer — visualizers read the same
        // shape of data regardless of which mode is playing.
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        srcNode.connect(analyser);
        analyser.connect(ctx.destination);
        g = { ctx, srcNode, analyser };
      } catch (e) {
        // Level metering is best-effort — playback itself doesn't depend
        // on this WebAudio graph, so degrade gracefully if it fails.
        g = { ctx: null, srcNode: null, analyser: null };
      }
      audioEl._waGraph = g;
    }
    this.ctx = g.ctx;
    this.srcNode = g.srcNode;
    this.analyser = g.analyser;
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

  // ── visualizer feeds ── (identical surface to PCMPlayer's)
  //
  // Caveat worth knowing: lobby-audio's source is now a fetched HLS
  // playlist/segments (see Lobby._connectMedia in lobby.js), so WebAudio's
  // cross-origin restriction on createMediaElementSource applies again —
  // that's why #lobby-audio has crossorigin="anonymous" in index.html,
  // and why server.py's CORS wrapper needs to cover the /hls/ route (it
  // does — see the app-wide `cors(app, allow_origin="*", ...)` call).
  // Without both of those, getSpectrum/getWaveform below would silently
  // return all-zero data instead of throwing (a "tainted" media element
  // just reports silence, no error) whenever the Flask server is on a
  // different origin than the page.
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

  // The WebAudio graph is shared across every AudioElPlayer built for this
  // element (see the constructor) and must survive a destroy() so the NEXT
  // lobby join can reuse it — closing the context or disconnecting the
  // source node here would permanently silence the element (see the class
  // doc comment above). Only this instance's own audio-element state is
  // reset; nothing about destroy() needs to be async anymore, but the
  // signature stays the same since callers still (optionally) await it.
  async destroy() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.srcObject = null;
    try { this.audio.load(); } catch (_) {}
  }
}