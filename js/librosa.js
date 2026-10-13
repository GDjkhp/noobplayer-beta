'use strict';
/* ═══════════════════════════════════════════
   Librosa — client side of the server's librosa analysis (see analysis.py).

   Lobby mode only. The server analyses each track once (beats, tempo,
   meter/downbeats, key) and serves the result at /api/lobby/<code>/analysis;
   this module fetches it for whatever is playing and answers questions the UI
   needs in real time:

     - which beat / bar position is audible at a given track position
       (the "1/4 → 2/4 → 3/4 → 4/4" counter),
     - did a beat boundary just pass (beat markers on the stream waveform),
     - metronome clicks, scheduled on the Web Audio clock just ahead of the
       beats so they line up with what is audible.

   Positions come from S.player.getPositionMs(), which in lobby mode is read
   off the relay's in-band timeline (i.e. what you actually hear), and beat
   times are in the same track clock because the server analyses the PCM from
   position 0.
═══════════════════════════════════════════ */
const Librosa = {
  data: null,            // last 'ready' analysis payload for forEncoded
  status: 'idle',        // idle | loading | analyzing | ready | unsupported | unavailable | error
  message: '',
  forEncoded: null,      // encoded id the fields above belong to
  beatsMs: null,         // Float64Array of beat times (ms)
  _medianMs: 0,
  _fetching: false,
  _pollT: null,
  _polls: 0,

  metronomeOn: false,
  _ctx: null, _gain: null, _timer: null,
  _lastClickIdx: -1, _lastPos: 0, _lastTickAt: 0,

  /* ───────── availability / loading ───────── */
  available() { return S.mode === 'server' && S.lobby.active; },

  ready() {
    return this.status === 'ready' && !!this.beatsMs && this.available()
      && !!S.current && S.current.encoded === this.forEncoded;
  },

  _reset() {
    clearTimeout(this._pollT);
    this.data = null; this.beatsMs = null; this._medianMs = 0;
    this.status = 'idle'; this.message = ''; this.forEncoded = null;
    this._polls = 0; this._lastClickIdx = -1;
  },

  // Cheap; call as often as you like. Notices track changes and (re)fetches.
  sync() {
    if (!this.available() || !S.current) { if (this.forEncoded || this.status !== 'idle') this._reset(); return; }
    if (S.current.encoded !== this.forEncoded) {
      this._reset();
      this.forEncoded = S.current.encoded;
      this.status = 'loading';
      this._fetch();
    }
  },

  async _fetch() {
    if (this._fetching) return;
    const enc = this.forEncoded;
    if (!enc || !this.available()) return;
    this._fetching = true;
    clearTimeout(this._pollT);
    let retryMs = 0;
    try {
      const r = await LobbyAPI.analysis(S.lobby.code, S.lobby.clientId);
      if (enc !== this.forEncoded) return;                   // track changed meanwhile — finally re-fetches
      if (r.encoded !== enc) { retryMs = 1500; return; }     // our state lags the server's — ask again shortly
      if (r.status === 'ready') {
        this.data = r;
        this.beatsMs = Float64Array.from(r.beats || [], t => t * 1000);
        if (this.beatsMs.length > 1) {
          const d = []; for (let i = 1; i < this.beatsMs.length; i++) d.push(this.beatsMs[i] - this.beatsMs[i - 1]);
          d.sort((a, b) => a - b); this._medianMs = d[d.length >> 1];
        }
        this.status = 'ready';
      } else if (r.status === 'pending' || r.status === 'none') {
        this.status = 'analyzing';
        retryMs = 2500;
      } else if (r.status === 'idle') {
        this.status = 'idle';
      } else {
        this.status = r.status;                              // unsupported | unavailable | error
        this.message = r.reason || '';
      }
    } catch (e) {
      if (enc !== this.forEncoded) return;
      this.status = 'error'; this.message = e.message; retryMs = 5000;
    } finally {
      this._fetching = false;
      if (this.forEncoded && this.forEncoded !== enc) this._fetch();
      else if (retryMs && this.forEncoded === enc && this._polls++ < 240) this._pollT = setTimeout(() => this._fetch(), retryMs);
    }
  },

  /* ───────── beat lookups ───────── */
  // index of the last beat at or before posMs (-1 if none yet)
  _idxAt(posMs) {
    const b = this.beatsMs; let lo = 0, hi = b.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] <= posMs) lo = m + 1; else hi = m; }
    return lo - 1;
  },

  beatsPerBar() { return (this.data && this.data.meter && this.data.meter.beatsPerBar) || 4; },

  _count(idx) {                                              // 1-based beat within the bar
    const m = this.beatsPerBar(), ph = (this.data && this.data.meter && this.data.meter.downbeatPhase) || 0;
    return (((idx - ph) % m) + m) % m + 1;
  },

  // Beat/bar position audible at posMs, or null before the first beat / after the
  // last one (the tracker trims weak leading and trailing beats).
  current(posMs) {
    if (!this.ready()) return null;
    const i = this._idxAt(posMs);
    if (i < 0) return null;
    if (i === this.beatsMs.length - 1 && posMs - this.beatsMs[i] > this._medianMs * 1.5) return null;
    return { i, count: this._count(i), n: this.beatsPerBar() };
  },

  // A beat boundary passed between two successive position samples? Seeks and
  // pauses (non-advancing / big jumps) never count.
  crossing(prevMs, posMs) {
    if (!this.ready() || !(posMs > prevMs) || posMs - prevMs > 500) return null;
    const i1 = this._idxAt(posMs);
    if (i1 < 0 || i1 <= this._idxAt(prevMs)) return null;
    return { i: i1, count: this._count(i1), n: this.beatsPerBar() };
  },

  /* ───────── metronome ───────── */
  toggleMetronome() {
    if (!this.available()) { toast('The metronome is only available in lobby mode', 'warn'); return false; }
    this.metronomeOn = !this.metronomeOn;
    if (this.metronomeOn) {
      try {
        if (!this._ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          this._ctx = new AC({ latencyHint: 'interactive' });
          this._gain = this._ctx.createGain();
          this._gain.gain.value = 0.5;
          this._gain.connect(this._ctx.destination);
        }
        if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
      } catch (e) { this.metronomeOn = false; toast(`Metronome unavailable: ${e.message}`, 'error'); return false; }
      this._lastClickIdx = -1;
      clearInterval(this._timer);
      this._timer = setInterval(() => this._tick(), 25);
      this.sync();
    } else {
      clearInterval(this._timer); this._timer = null;
    }
    return this.metronomeOn;
  },

  _tick() {
    this.sync();
    const p = S.player;
    if (!this.metronomeOn || !this._ctx || !p || p.isPaused || !this.ready()) { this._lastTickAt = performance.now(); return; }

    const pos = p.getPositionMs();
    if (pos < this._lastPos - 100 || pos - this._lastPos > 1500) this._lastClickIdx = -1;   // seek / skip
    this._lastPos = pos;

    // Background tabs throttle timers to ~1 Hz, so look further ahead there.
    const look = document.hidden ? 1100 : 150;
    const b = this.beatsMs;
    let i = Math.max(this._idxAt(pos) + 1, this._lastClickIdx + 1);
    for (; i < b.length && b[i] <= pos + look; i++) {
      this._click(b[i] - pos, this._count(i));
      this._lastClickIdx = i;
    }
    this._lastTickAt = performance.now();
  },

  _click(delayMs, count) {
    const ctx = this._ctx;
    // pos is what's audible NOW, so the beat is audible delayMs from now; the
    // click leaves this context outputLatency after it is rendered.
    const t = Math.max(ctx.currentTime, ctx.currentTime + delayMs / 1000 - (ctx.outputLatency || 0));
    const down = count === 1;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = down ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(down ? 0.9 : 0.55, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g); g.connect(this._gain);
    o.start(t); o.stop(t + 0.08);
  },
};