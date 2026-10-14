'use strict';
/* ═══════════════════════════════════════════
   Audio analysis — client side of the server's audio analysis (see analysis.py).

   Lobby mode only. The server analyses each track once, in stages, and PUSHES
   every finished stage over the lobby socket as an `analysis` event:

     download → decode → beats (BPM, beat grid) → sections (tempo changes) ‖ key
              → meter → key-refine (HPSS)

   Playback itself is held server-side until the `beats` stage is done, so the
   BPM is normally there before the first note. A one-off GET snapshot
   (LobbyAPI.analysis) covers joining mid-track and socket reconnects — there
   is no polling.

   This module keeps the results per track, and answers the questions the UI
   needs in real time:
     - which beat / bar position is audible at a given track position
       (the "1/4 → 2/4 → 3/4 → 4/4" counter),
     - which tempo section we are in (BPM follows tempo changes),
     - did a beat boundary just pass (beat markers on the stream waveform),
     - metronome clicks, scheduled on the Web Audio clock just ahead of the
       beats so they line up with what is audible.

   Positions come from S.player.getPositionMs(), which in lobby mode is read
   off the relay's in-band timeline (i.e. what you actually hear), and beat
   times are in the same track clock because the server analyses the PCM from
   position 0.
═══════════════════════════════════════════ */
const AudioAnalysis = {
  store: {},             // encoded id -> entry { status, phase, complete, stages, timings, reason, _v }
  order: [],             // LRU of ids in store
  forEncoded: null,      // encoded id of the current track
  _sock: null,           // socket we attached our listener to
  _fetching: false,
  _fetched: null,        // encoded id we already took a snapshot for
  _retry: 0,
  _retryT: null,

  // derived, per current entry (rebuilt when its stages change)
  _derivedFor: null, _derivedV: -1,
  beatsMs: null, _medianMs: 0, _secStartMs: null, _phases: null,

  metronomeOn: false,
  _shifts: {},           // manual 1/4 anchor shift (in beats) per encoded track
  _ctx: null, _gain: null, _timer: null,
  _lastClickIdx: -1, _lastPos: 0,

  /* ───────── availability / state ───────── */
  available() { return S.mode === 'server' && S.lobby.active; },

  get cur() { return this.forEncoded ? this.store[this.forEncoded] || null : null; },

  // Status for the card: idle | loading | analyzing | ready | unsupported | unavailable | error
  get status() {
    if (!this.available() || !S.current) return 'idle';
    const e = this.cur;
    if (!e) return 'loading';
    if (e.status === 'ready') return 'ready';
    if (e.status === 'pending' || e.status === 'none') return 'analyzing';
    return e.status || 'loading';
  },
  get message() { const e = this.cur; return (e && e.reason) || ''; },
  get phase() { const e = this.cur; return (e && e.phase) || ''; },
  get complete() { const e = this.cur; return !!(e && e.complete); },

  stage(name) { const e = this.cur; return (e && e.stages && e.stages[name]) || null; },
  timings() { const e = this.cur; return (e && e.timings) || {}; },

  // Beats are usable as soon as the BPM stage landed.
  ready() {
    if (!this.available() || !S.current || S.current.encoded !== this.forEncoded) return false;
    this._derive();
    return !!this.beatsMs && this.beatsMs.length > 0;
  },

  /* ───────── socket + snapshot ───────── */
  _attach() {
    const s = S.lobby && S.lobby.socket;
    if (!s || s === this._sock) return;
    this._sock = s;
    s.on('analysis', (p) => this._onEvent(p));
    // Events sent while we were disconnected are gone: take a fresh snapshot.
    s.on('connect', () => { this._fetched = null; this._retry = 0; this.sync(); });
  },

  _entry(id) {
    let e = this.store[id];
    if (!e) {
      e = this.store[id] = { status: 'pending', phase: '', complete: false, stages: {}, timings: {}, reason: '', _v: 0 };
      this.order.push(id);
      while (this.order.length > 10) delete this.store[this.order.shift()];
    }
    return e;
  },

  _mergeStage(e, name, data) {
    if (data === undefined || data === null) return;
    // Never let an older snapshot overwrite the HPSS-refined key.
    if (name === 'key' && e.stages.key && e.stages.key.refined && !data.refined) return;
    e.stages[name] = data;
  },

  _onEvent(p) {
    if (!p || !p.encoded) return;
    const e = this._entry(p.encoded);
    if (p.stage && p.stage !== 'done' && p.stage !== 'error') this._mergeStage(e, p.stage, p.data);
    if (p.timing) e.timings[p.stage] = p.timing;
    if (p.status) e.status = p.status;
    if (p.phase) e.phase = p.phase;
    if (p.reason != null) e.reason = p.reason;
    if (p.complete) e.complete = true;
    e._v++;
  },

  _onSnapshot(r) {
    if (!r || !r.encoded) return;
    if (r.status === 'idle') return;
    if (r.status === 'none') return;              // server hasn't started yet: events will follow
    const e = this._entry(r.encoded);
    for (const [k, v] of Object.entries(r.stages || {})) this._mergeStage(e, k, v);
    Object.assign(e.timings, r.timings || {});
    e.status = r.status; e.phase = r.phase || e.phase; e.complete = !!r.complete; e.reason = r.reason || '';
    if (r.totalSec != null) e.totalSec = r.totalSec;
    e._v++;
  },

  _reset() {
    clearTimeout(this._retryT);
    this.forEncoded = null; this._fetched = null; this._retry = 0;
    this._derivedFor = null; this.beatsMs = null; this._phases = null; this._secStartMs = null;
    this._lastClickIdx = -1;
  },

  // Cheap; call as often as you like. Notices track changes, attaches the
  // socket listener, and takes ONE snapshot per track.
  sync() {
    if (!this.available() || !S.current) { if (this.forEncoded) this._reset(); return; }
    this._attach();
    if (S.current.encoded !== this.forEncoded) {
      this._reset();
      this.forEncoded = S.current.encoded;
    }
    if (this._fetched !== this.forEncoded && !this._fetching) this._snapshot();
  },

  async _snapshot() {
    const enc = this.forEncoded;
    if (!enc || !this.available()) return;
    this._fetching = true;
    try {
      const r = await LobbyAPI.analysis(S.lobby.code, S.lobby.clientId);
      if (r && r.encoded === enc) { this._onSnapshot(r); this._fetched = enc; }
      else if (this._retry++ < 3) this._retryT = setTimeout(() => { this._fetched = null; }, 1500 * this._retry);
      else this._fetched = enc;            // give up; the socket events still arrive
    } catch (e) {
      if (this._retry++ < 3) this._retryT = setTimeout(() => { this._fetched = null; }, 3000);
      else this._fetched = enc;
    } finally {
      this._fetching = false;
    }
  },

  /* ───────── derived data ───────── */
  // The beat list in effect: the tempo-section re-track if there was a tempo
  // change, else the first (global) pass.
  _derive() {
    const e = this.cur;
    if (!e) { this.beatsMs = null; return; }
    if (this._derivedFor === this.forEncoded && this._derivedV === e._v) return;
    this._derivedFor = this.forEncoded; this._derivedV = e._v;
    this._lastClickIdx = -1;                    // beat indices may have shifted (tempo sections re-track)
    const b0 = e.stages.beats, sec = e.stages.sections;
    const src = (sec && sec.changed && sec.beats) ? sec.beats : (b0 && b0.beats);
    if (!src || !src.length) { this.beatsMs = null; this._medianMs = 0; this._phases = null; this._secStartMs = null; return; }
    this.beatsMs = Float64Array.from(src, t => t * 1000);
    if (this.beatsMs.length > 1) {
      const d = []; for (let i = 1; i < this.beatsMs.length; i++) d.push(this.beatsMs[i] - this.beatsMs[i - 1]);
      d.sort((a, b) => a - b); this._medianMs = d[d.length >> 1];
    }
    const m = e.stages.meter;
    this._phases = m ? ((m.phases && m.phases.length) ? m.phases : [{ beat: 0, phase: m.downbeatPhase || 0 }]) : null;
    this._secStartMs = (sec && sec.changed && sec.sections.length > 1) ? sec.sections.map(s => s.start * 1000) : null;
  },

  /* ───────── views for the UI ───────── */
  tempo() {
    const b0 = this.stage('beats'), sec = this.stage('sections');
    if (!b0 || !b0.tempo) return null;
    return Object.assign({}, b0.tempo, (sec && sec.changed && sec.tempo) ? sec.tempo : {});
  },
  sections() { const s = this.stage('sections'); return s && s.sections ? s.sections : null; },
  hasTempoChanges() { const s = this.stage('sections'); return !!(s && s.changed); },
  meter() { return this.stage('meter'); },
  key() { return this.stage('key'); },

  // BPM and section at a track position: follows tempo changes.
  bpmAt(posMs) {
    const t = this.tempo();
    if (!t) return null;
    const secs = this.hasTempoChanges() ? this.sections() : null;
    if (!secs) return { bpm: t.bpm, idx: 0, n: 1 };
    const s = posMs / 1000;
    let i = secs.length - 1;
    for (let k = 0; k < secs.length; k++) if (s < secs[k].end) { i = k; break; }
    return { bpm: secs[i].bpm, idx: i, n: secs.length };
  },

  /* ───────── beat lookups ───────── */
  // index of the last beat at or before posMs (-1 if none yet)
  _idxAt(posMs) {
    const b = this.beatsMs; let lo = 0, hi = b.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (b[m] <= posMs) lo = m + 1; else hi = m; }
    return lo - 1;
  },

  meterKnown() { this._derive(); return !!this._phases; },
  beatsPerBar() { const m = this.meter(); return (m && m.beatsPerBar) || 0; },

  // 1-based beat within the bar; 0 while the meter is not known yet.
  _count(idx) {
    const m = this.beatsPerBar(), ph = this._phases;
    if (!m || !ph) return 0;
    let p = ph[0];
    for (let k = 1; k < ph.length; k++) { if (ph[k].beat <= idx) p = ph[k]; else break; }
    return (((idx - p.beat - p.phase - this.anchorShift()) % m) + m) % m + 1;
  },

  // Manual alignment: positive moves the 1/4 anchor later (to the right).
  anchorShift() {
    const k = this.forEncoded;
    if (k == null) return 0;
    if (this._shifts[k] === undefined) {
      let v = 0;
      try { v = parseInt(localStorage.getItem('aa-anchor:' + k), 10) || 0; } catch (e) {}
      this._shifts[k] = v;
    }
    return this._shifts[k];
  },
  shiftAnchor(delta) {
    const k = this.forEncoded;
    if (k == null) return 0;
    const m = this.beatsPerBar() || 1;
    const v = ((((this.anchorShift() + delta) % m) + m) % m);
    this._shifts[k] = v;
    try { if (v) localStorage.setItem('aa-anchor:' + k, String(v)); else localStorage.removeItem('aa-anchor:' + k); } catch (e) {}
    return v;
  },

  _secStartAt(idx) {            // is beat idx the first beat of a tempo section (not the first section)?
    const sec = this.sections();
    if (!sec || !this.hasTempoChanges()) return false;
    for (let k = 1; k < sec.length; k++) if (sec[k].startBeat === idx) return sec[k].bpm;
    return false;
  },

  // Beat/bar position audible at posMs, or null before the first beat / after
  // the last one (the tracker trims weak leading and trailing beats).
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
    return { i: i1, count: this._count(i1), n: this.beatsPerBar(), secBpm: this._secStartAt(i1) };
  },

  /* ───────── metronome ───────── */
  toggleMetronome() {
    if (!this.available()) { toast('The metronome is only available in lobby mode', 'warn'); return false; }
    if (!this.metronomeOn && (this.status === 'disabled' || this.status === 'unavailable')) {
      toast(this.status === 'disabled' ? 'Audio analysis is disabled on this server' : 'Audio analysis is not available on this server', 'warn'); return false;
    }
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
    if (!this.metronomeOn || !this._ctx || !p || p.isPaused || !this.ready()) return;

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