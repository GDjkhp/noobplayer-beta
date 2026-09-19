'use strict';
/* ═══════════════════════════════════════════
   Debug — the "Debug" tab.

   Design goal: instrument the app WITHOUT editing engine.js, pcm-player.js,
   audio-el-player.js, lobby.js or api.js. Everything here is either a
   monkey-patch (wrap a function on an existing prototype/object and call
   the original) or a direct DOM listener on elements that already exist
   in index.html (#lobby-audio, #voice-audio). That keeps every other
   module's diff to ~nothing and means this file can be deleted with zero
   side effects on the rest of the app.

   What gets tracked, and how:
     - Server requests + latency   → window.fetch is wrapped once; every
       call the app already makes (lobby control, chat, skins gallery,
       NodeLink proxy, stream open TTFB…) is logged automatically.
     - Buffer dropouts (standalone) → PCMPlayer.prototype.feed is
       wrapped. The original already decides "am I behind schedule"
       every call (that's the whole point of `nextTime` vs
       `ctx.currentTime`); this just reads that same math before/after
       calling through.
     - Stream waveform → a rolling window sampled from
       S.player.getWaveform(), the analyser feed both PCMPlayer and
       AudioElPlayer expose identically, so it works unmodified in both
       modes. A detected dropout (either side) injects a few red glitch
       columns instead of a real reading — see _injectWaveGlitch. An
       optional segment grid (seconds or detected BPM, toggled in the UI)
       draws over both strips — see _drawSegments.
     - Beat/BPM detection → a lightweight energy-based onset detector
       reading S.player.getSpectrum()'s low-frequency bins every tick;
       see _beatSample/_recomputeBpm. Shown as a stat card and used to
       phase-lock the BPM segment grid.
     - Buffered waveform → a second strip under the stream waveform.
       Standalone: sampled straight from PCMPlayer.feed()'s incoming
       bytes (patched below) plus a poll of S.preload.chunks, so it shows
       audio that's arrived but hasn't played yet, stitched gapless into
       whatever preloads next. Lobby: no raw PCM is available client-side
       (encoded relay), so it falls back to an approximate buffered-
       seconds fill — see _bufSample/_bufSampleServer.
     - Audio element stalls/waits/playing (lobby)  → listeners attached
       straight to #lobby-audio.
     - Player action → time-to-audible latency  → Engine's public
       methods (playTrack/togglePause/skip/prev/stop/seekTo) are
       wrapped to open a "pending action"; it's closed by whichever
       instrumentation point below is the actual audible signal for that
       mode (a PCM feed(), an AudioContext resume(), or the <audio>
       'playing' event).
     - Server encode/pacing + the hidden Smart Queue (lobby only)  →
       pushed over the lobby's existing Socket.IO connection while this
       tab is subscribed (see server.py's LobbyRelay.debug_subscribe /
       _debug_push_loop). No REST polling, and nothing runs server-side
       when no one is subscribed.
═══════════════════════════════════════════ */

const NET_CAP = 40, EVT_CAP = 30;
const WAVE_MAX_COLS = 360, WAVE_TICK_MS = 30;
const BEAT_MIN_GAP_MS = 250;    // debounce → caps detection at 240 BPM
const BEAT_ENERGY_WINDOW = 43;  // ~1.3s of ticks — local average/variance window

function dbgPushCap(arr, item, cap) {
  arr.unshift(item);
  if (arr.length > cap) arr.length = cap;
}

const Debug = {
  // ── ring buffers ──
  net: [],            // server requests (from the fetch wrapper)
  playerEvents: [],   // Engine action → latency
  dropouts: [],       // detected gaps/stalls, either side
  audioElEvents: [],  // #lobby-audio DOM events
  nodelinkRequests: [], // backend → NodeLink calls, pushed live (lobby mode)
  _waveHistory: [],   // rolling waveform columns: {amp:0..1, dropout:bool, ts}, oldest first (index 0 = left edge)
  _bufHistory: [],    // rolling BUFFERED (not-yet-played) columns, same shape — see "buffered waveform" below

  // segment overlay toggle for both strips — 'off' | 'seconds' | 'bpm'
  _segMode: 'off',

  // beat/BPM detection (energy-based onset, see _beatSample)
  _bpm: null,
  _bpmTrackKey: null,
  _beatTimes: [],      // recent onset timestamps (performance.now(), ms)
  _energyHistory: [],  // recent low-band energy readings, for local avg/variance
  _lastBeatTs: 0,
  _specBuf: null,

  // buffered-waveform bookkeeping (standalone mode reads S.preload.chunks
  // directly rather than waiting for engine.js to feed() them — see
  // _bufPollPreload)
  _lastPreloadRef: null,
  _lastPreloadSampledCount: 0,

  server: null,       // last snapshot pushed over the socket by the server

  _initDone: false,
  _built: false,
  _running: false,
  _actionSeq: 0,
  _netSeq: 0,
  _pendingAction: null,
  _pendingTimeout: null,
  _renderTimer: null,
  _waveRaf: null,
  _waveLastTick: 0,

  /* ───────── setup (called once, at script load) ───────── */
  _init() {
    if (this._initDone) return;
    this._initDone = true;
    this.installFetchHook();
    this.patchPCMPlayer();
    this.patchAudioElPlayer();
    this.patchEngineActions();
    this.patchSwitchTab();
    this.attachAudioElListeners();
  },

  installFetchHook() {
    if (this._fetchPatched) return;
    this._fetchPatched = true;
    const orig = window.fetch.bind(window);
    const self = this;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      let path = url;
      try { const u = new URL(url, window.location.href); path = u.pathname + (u.search.length < 40 ? u.search : '?…'); } catch (_) {}
      const entry = { id: ++self._netSeq, method, path, status: null, ok: null, ms: null, size: null, ts: Date.now(), pending: true };
      dbgPushCap(self.net, entry, NET_CAP);
      const t0 = performance.now();
      try {
        const res = await orig(input, init);
        entry.pending = false;
        entry.status = res.status;
        entry.ok = res.ok;
        entry.ms = Math.round(performance.now() - t0);
        const len = res.headers.get('content-length');
        entry.size = len ? parseInt(len, 10) : null;
        return res;
      } catch (e) {
        entry.pending = false;
        entry.status = e.name === 'AbortError' ? 'aborted' : 'ERR';
        entry.ok = false;
        entry.ms = Math.round(performance.now() - t0);
        throw e;
      }
    };
  },

  // Wraps PCMPlayer.prototype.feed — the single point every incoming PCM
  // chunk (standalone mode) passes through on its way to the speaker.
  // Reads the exact same "am I ahead of or behind ctx.currentTime"
  // comparison the original uses to schedule playback, so the dropout
  // detection below can't drift out of sync with what's actually audible.
  patchPCMPlayer() {
    if (typeof PCMPlayer === 'undefined' || PCMPlayer.prototype._dbgPatched) return;
    PCMPlayer.prototype._dbgPatched = true;
    const self = this;

    const origFeed = PCMPlayer.prototype.feed;
    PCMPlayer.prototype.feed = function (bytes) {
      let starvedMs = 0;
      if (this.ctx && this.startCtxTime !== null) {
        const need = this.ctx.currentTime + 0.02;
        if (need > this.nextTime + 0.005) starvedMs = (need - this.nextTime) * 1000;
      }

      // Sample BEFORE origFeed schedules it — every byte handed to feed()
      // is, by definition, audio that hasn't reached the speaker yet
      // (PCMPlayer schedules it ahead on its own AudioContext timeline).
      // This is the only external point that sees "buffered, not yet
      // played" content without touching engine.js/pcm-player.js.
      self._bufPushFromBytes(bytes);

      const result = origFeed.call(this, bytes);

      if (starvedMs > 2) {
        self.dropout(starvedMs, (S.current && S.current.info && S.current.info.title) || '');
      }
      self.actionReady(); // first bytes of a new stream = "audible now"
      return result;
    };

    const origResume = PCMPlayer.prototype.resume;
    PCMPlayer.prototype.resume = async function (...args) {
      const r = await origResume.apply(this, args);
      self.actionReady(); // ctx.resume() completing IS the audible signal here
      return r;
    };

    const origPause = PCMPlayer.prototype.pause;
    PCMPlayer.prototype.pause = function (...args) {
      const r = origPause.apply(this, args);
      self.actionReady();
      return r;
    };
  },

  patchAudioElPlayer() {
    if (typeof AudioElPlayer === 'undefined' || AudioElPlayer.prototype._dbgPatched) return;
    AudioElPlayer.prototype._dbgPatched = true;
    const self = this;
    const origPause = AudioElPlayer.prototype.pause;
    AudioElPlayer.prototype.pause = function (...args) {
      const r = origPause.apply(this, args);
      self.actionReady();
      return r;
    };
    // resume() intentionally NOT patched for latency — audio.play()
    // resolving doesn't mean audio is audible yet (it can still be
    // buffering). The 'playing' DOM event listened for below is the
    // real signal, same as the reconnect-buffering logic in engine.js
    // already treats it.
  },

  // #lobby-audio exists in the DOM from page load regardless of mode
  // (see index.html), so this can attach immediately at init instead of
  // waiting for a lobby to exist.
  attachAudioElListeners() {
    const audio = document.getElementById('lobby-audio');
    if (!audio || audio._dbgAttached) return;
    audio._dbgAttached = true;
    const self = this;
    let waitStart = null;
    ['waiting', 'stalled', 'playing', 'pause', 'play', 'error', 'ended', 'progress'].forEach(type => {
      audio.addEventListener(type, () => {
        const now = performance.now();
        if (type === 'waiting' || type === 'stalled') {
          if (waitStart === null) waitStart = now;
        }
        if (type === 'playing') {
          if (waitStart !== null) { self.dropout(now - waitStart, 'lobby stream stall'); waitStart = null; }
          self.actionReady();
        }
        self.audioElEvent(type, { t: audio.currentTime, buffered: self._bufferedAheadSec(audio) });
      });
    });
  },

  _bufferedAheadSec(audio) {
    try {
      if (!audio.buffered || !audio.buffered.length) return 0;
      return Math.max(0, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime);
    } catch (_) { return 0; }
  },

  // Wraps Engine's public transport methods so every user-triggered
  // action gets an entry in the Player Events table, paired up with
  // whichever instrumentation point above signals "and now it's audible".
  patchEngineActions() {
    if (typeof Engine === 'undefined' || Engine._dbgPatched) return;
    Engine._dbgPatched = true;
    const self = this;
    ['playTrack', 'togglePause', 'skip', 'prev', 'stop', 'seekTo'].forEach(name => {
      const orig = Engine[name];
      if (typeof orig !== 'function') return;
      Engine[name] = async function (...args) {
        self.action(name, { mode: S.mode });
        const r = await orig.apply(Engine, args);
        // 'stop' has no audible-again signal to wait for (it goes to
        // silence, not a new playing stream) — resolve it right here
        // rather than leaving it "pending" forever.
        if (name === 'stop') self.actionReady();
        return r;
      };
    });
  },

  // So the render loop only runs while the person is actually looking at
  // it — same pattern main.js already uses for the visualizer tab.
  patchSwitchTab() {
    if (typeof UI === 'undefined' || UI._dbgSwitchPatched) return;
    UI._dbgSwitchPatched = true;
    const self = this;
    const orig = UI.switchTab.bind(UI);
    UI.switchTab = function (name) {
      const leaving = S.activeTab;
      orig(name);
      if (name === 'debug') self.start();
      else if (leaving === 'debug') self.stop();
    };
  },

  /* ───────── instrumentation entry points ───────── */
  action(name, meta) {
    const id = ++this._actionSeq;
    this._pendingAction = { id, ts: performance.now() };
    dbgPushCap(this.playerEvents, { id, name, mode: (meta && meta.mode) || null, ts: Date.now(), latencyMs: null }, EVT_CAP);
    clearTimeout(this._pendingTimeout);
    this._pendingTimeout = setTimeout(() => {
      if (this._pendingAction && this._pendingAction.id === id) this._pendingAction = null;
    }, 8000);
  },
  actionReady() {
    const pa = this._pendingAction;
    if (!pa) return;
    const rec = this.playerEvents.find(e => e.id === pa.id);
    if (rec) rec.latencyMs = Math.round(performance.now() - pa.ts);
    this._pendingAction = null;
  },
  dropout(gapMs, context) {
    dbgPushCap(this.dropouts, { ts: Date.now(), gapMs: Math.round(gapMs), context: context || '' }, EVT_CAP);
    this._injectWaveGlitch(gapMs);
  },
  audioElEvent(type, meta) { dbgPushCap(this.audioElEvents, { ts: Date.now(), type, meta }, EVT_CAP); },

  /* ───────── server-pushed stats (Socket.IO, lobby mode only) ─────────
     No polling: the Debug tab subscribes over the lobby's existing
     socket when opened and unsubscribes when closed. The server only
     runs its stats-push loop while at least one sid is subscribed (see
     LobbyRelay.debug_subscribe in server.py), so this produces zero
     extra traffic to your NodeLink node and zero extra HTTP requests —
     just socket messages, and only while you're actually looking. */
  _debugSocket: null,
  _socketSub: false,

  subscribeSocket() {
    if (!(S.mode === 'server' && S.lobby.active && S.lobby.socket)) return;
    const socket = S.lobby.socket;
    if (this._debugSocket !== socket) {
      this._debugSocket = socket;
      socket.on('debug_stats', (snap) => { this.server = snap; });
      socket.on('nodelink_request', (entry) => { dbgPushCap(this.nodelinkRequests, entry, NET_CAP); });
      socket.on('nodelink_requests_backlog', (list) => { this.nodelinkRequests = (list || []).slice(0, NET_CAP); });
      // A reconnect gets a fresh sid server-side, so the server's
      // subscriber-by-sid entry from before the drop is gone — resubscribe.
      socket.on('connect', () => {
        this._socketSub = false;
        if (this._running && S.activeTab === 'debug') this.subscribeSocket();
      });
    }
    if (!this._socketSub && socket.connected) {
      socket.emit('debug_subscribe', { code: S.lobby.code });
      this._socketSub = true;
    }
  },

  unsubscribeSocket() {
    if (this._debugSocket && this._socketSub) {
      try { this._debugSocket.emit('debug_unsubscribe', { code: S.lobby.code }); } catch (_) {}
    }
    this._socketSub = false;
    this.server = null;
    this.nodelinkRequests = [];
  },

  /* ───────── lifecycle ───────── */
  start() {
    this.ensureSkeleton();
    this._running = true;
    this.subscribeSocket();
    clearInterval(this._renderTimer); this._renderTimer = setInterval(() => this.render(), 280);
    this.render();
    this._startWave();
  },
  stop() {
    this._running = false;
    this.unsubscribeSocket();
    clearInterval(this._renderTimer); this._renderTimer = null;
    this._stopWave();
    this._waveHistory = []; // fresh sweep next time the tab opens, rather than a stale gap stitched in
    this._bufHistory = [];
    this._energyHistory = []; this._beatTimes = []; this._bpm = null; this._bpmTrackKey = null;
    this._lastPreloadRef = null; this._lastPreloadSampledCount = 0;
  },
  clear() {
    this.net = []; this.playerEvents = []; this.dropouts = [];
    this.audioElEvents = [];
    this.nodelinkRequests = [];
    this._waveHistory = [];
    this._bufHistory = [];
    this._energyHistory = []; this._beatTimes = []; this._bpm = null; this._bpmTrackKey = null;
    this._lastPreloadRef = null; this._lastPreloadSampledCount = 0;
    this.render();
  },

  /* ───────── stream waveform ─────────
     Runs its own requestAnimationFrame loop (throttled to WAVE_TICK_MS)
     independent of the slower render() interval, since a scrolling
     waveform needs to feel smooth. Reads S.player.getWaveform() — the
     analyser feed both PCMPlayer (standalone) and AudioElPlayer (lobby)
     expose identically — so this works the same way in both modes and
     needs zero mode-specific branching.

     Gapless stitching: this never resets on a track change (playTrack /
     skip / prev / gapless splice don't touch _waveHistory), and the
     analyser output is continuous across a gapless boundary anyway, so
     the waveform just keeps scrolling through it with no visible seam —
     exactly like the audio itself. It only resets on Clear or on
     leaving the tab (see stop() above). */
  _startWave() {
    if (this._waveRaf) return;
    const loop = (ts) => {
      if (!this._running) { this._waveRaf = null; return; }
      if (ts - this._waveLastTick >= WAVE_TICK_MS) {
        this._waveLastTick = ts;
        this._waveSample();
        this._bufSample();
        this._beatSample();
        this._drawWave();
        this._drawBufWave();
      }
      this._waveRaf = requestAnimationFrame(loop);
    };
    this._waveRaf = requestAnimationFrame(loop);
  },
  _stopWave() {
    if (this._waveRaf) cancelAnimationFrame(this._waveRaf);
    this._waveRaf = null;
  },

  _waveSample() {
    let amp = 0;
    if (S.player && typeof S.player.getWaveform === 'function') {
      try {
        const buf = S.player.getWaveform();
        if (buf && buf.length) {
          let peak = 0;
          for (let i = 0; i < buf.length; i += 4) { // sparse sample, cheap — this runs ~33x/sec
            const dev = Math.abs(buf[i] - 128);
            if (dev > peak) peak = dev;
          }
          amp = Math.min(1, peak / 128);
        }
      } catch (_) {}
    }
    this._waveHistory.push({ amp, dropout: false, ts: performance.now() });
    if (this._waveHistory.length > WAVE_MAX_COLS) this._waveHistory.shift();
  },

  // Called from dropout() — simulates the visual "jump" by inserting a
  // few erratic, red-flagged columns instead of a real reading, roughly
  // proportional to how long the gap was (capped so one huge stall
  // doesn't swallow the whole visible window).
  _injectWaveGlitch(gapMs) {
    const cols = Math.max(3, Math.min(28, Math.round(gapMs / WAVE_TICK_MS)));
    for (let i = 0; i < cols; i++) {
      this._waveHistory.push({ amp: 0.2 + Math.random() * 0.8, dropout: true, ts: performance.now() });
    }
    while (this._waveHistory.length > WAVE_MAX_COLS) this._waveHistory.shift();
  },

  /* ───────── buffered waveform ─────────
     Second strip, drawn under the stream waveform. Where the strip above
     reads S.player.getWaveform() (i.e. audio actually reaching the
     speaker right now), this one shows audio that has ARRIVED at the
     client but hasn't played yet:
       - standalone: every chunk passed to PCMPlayer.feed() (patched
         above) is sampled the instant it arrives, before scheduling —
         that's the live track's buffered-ahead tail.
       - also standalone: S.preload.chunks (engine.js's background
         gapless prefetch for whatever plays next) is polled every tick
         and any newly-arrived chunks get sampled too, appended right
         after the current track's own buffered tail — so the next
         track's audio shows up on this strip before the gapless splice
         ever happens, with no seam at the join (same continuous
         _bufHistory ring, never reset on track change).
       - lobby/server mode has no raw PCM client-side at all (the relay
         hands the browser an already-encoded Opus/Ogg stream via
         <audio src>) — _bufSampleServer approximates it from
         audio.buffered instead and flags those columns `approx: true`
         so they render dimmer and the section hint can say so. */
  _ampFromBytes(bytes) {
    if (!bytes || bytes.length < 2) return 0;
    let peak = 0;
    for (let i = 0; i + 1 < bytes.length; i += 10) { // sparse — feed() can fire many times/sec
      let v = bytes[i] | (bytes[i + 1] << 8);
      if (v > 32767) v -= 65536;
      const dev = Math.abs(v);
      if (dev > peak) peak = dev;
    }
    return Math.min(1, peak / 32768);
  },

  _bufPush(amp, extra) {
    this._bufHistory.push(Object.assign({ amp, dropout: false, ts: performance.now() }, extra || {}));
    if (this._bufHistory.length > WAVE_MAX_COLS) this._bufHistory.shift();
  },

  _bufPushFromBytes(bytes) {
    if (S.mode !== 'standalone') return;
    this._bufPush(this._ampFromBytes(bytes));
  },

  _bufPollPreload() {
    const pre = S.preload;
    if (!pre) { this._lastPreloadRef = null; this._lastPreloadSampledCount = 0; return; }
    if (this._lastPreloadRef !== pre) { this._lastPreloadRef = pre; this._lastPreloadSampledCount = 0; }
    const chunks = pre.chunks;
    for (let i = this._lastPreloadSampledCount; i < chunks.length; i++) {
      this._bufPush(this._ampFromBytes(chunks[i]));
    }
    this._lastPreloadSampledCount = chunks.length;
  },

  _bufSampleServer() {
    const audio = document.getElementById('lobby-audio');
    const aheadSec = audio ? this._bufferedAheadSec(audio) : 0;
    this._bufPush(Math.min(1, aheadSec / 6), { approx: true });
  },

  _bufSample() {
    if (S.mode === 'standalone') this._bufPollPreload();
    else if (S.mode === 'server') this._bufSampleServer();
  },

  /* ───────── beat / BPM detection ─────────
     Lightweight real-time energy-based onset detector, fed by
     S.player.getSpectrum() — the same analyser surface PCMPlayer and
     AudioElPlayer both expose, so this needs no mode-specific branching
     either. Every tick: sum a low-frequency band (~90–375Hz, i.e. kick/
     bass territory), keep a rolling ~1.3s window of that energy, and
     flag an onset when the instantaneous reading spikes well above the
     local average (classic adaptive-threshold beat detection). Onset
     timestamps feed a median inter-onset-interval → BPM, smoothed with
     an EMA so the reading doesn't jitter every beat. Not a substitute
     for a real offline BPM analyzer, but close enough to draw a beat
     grid that tracks the actual track. */
  _beatSample() {
    if (!S.player || typeof S.player.getSpectrum !== 'function') return;

    const trackKey = (S.current && S.current.encoded) || null;
    if (trackKey !== this._bpmTrackKey) {
      this._bpmTrackKey = trackKey;
      this._energyHistory = [];
      this._beatTimes = [];
      this._bpm = null;
    }
    if (!trackKey) return;

    let spec;
    try { spec = S.player.getSpectrum(this._specBuf); } catch (_) { return; }
    if (!spec || !spec.length) return;
    this._specBuf = spec;

    const bins = Math.min(5, spec.length);
    let sum = 0;
    for (let i = 1; i < bins; i++) sum += spec[i]; // skip bin 0 (DC)
    const energy = sum / Math.max(1, bins - 1);    // 0..255

    const hist = this._energyHistory;
    hist.push(energy);
    if (hist.length > BEAT_ENERGY_WINDOW) hist.shift();
    if (hist.length < 10) return; // warm up before trusting the average

    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    let variance = 0;
    for (const e of hist) variance += (e - avg) * (e - avg);
    variance /= hist.length;

    // higher variance (busy, dynamic section) → demand a bigger spike;
    // quiet/steady section → a smaller one is enough
    const threshold = Math.min(2.4, Math.max(1.15, 1.3 + variance / 3000));
    const now = performance.now();

    if (avg > 4 && energy > avg * threshold && (now - this._lastBeatTs) > BEAT_MIN_GAP_MS) {
      this._lastBeatTs = now;
      this._beatTimes.push(now);
      if (this._beatTimes.length > 16) this._beatTimes.shift();
      this._recomputeBpm();
    }
  },

  _recomputeBpm() {
    const times = this._beatTimes;
    if (times.length < 4) return;
    const intervals = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    if (median <= 0) return;
    let bpm = 60000 / median;
    while (bpm < 70) bpm *= 2;   // fold half/double-time readings into one sane range
    while (bpm > 190) bpm /= 2;
    this._bpm = this._bpm ? (this._bpm * 0.75 + bpm * 0.25) : bpm; // EMA smoothing
  },

  _bpmLabel() {
    if (!S.mode) return '—';
    if (!this._bpm) return this._beatTimes.length ? 'analyzing…' : 'listening…';
    return `${Math.round(this._bpm)} BPM`;
  },

  // Shared renderer for both strips — stream waveform and buffered
  // waveform are the same scrolling-columns visual over two different
  // data sources, so this draws either given a canvas id + history ring.
  // No centerline, no playhead: newest sample sits flush against the
  // right edge and scrolls left as history fills in, nothing marks "now"
  // except that edge itself.
  _drawStrip(canvasId, hist, opts) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const cssW = canvas.clientWidth || 600, cssH = canvas.clientHeight || 90;
    const dpr = window.devicePixelRatio || 1;
    if (canvas._dbgW !== cssW || canvas._dbgH !== cssH) {
      canvas.width = cssW * dpr; canvas.height = cssH * dpr;
      canvas._dbgW = cssW; canvas._dbgH = cssH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const midY = cssH / 2;
    const n = hist.length;
    const colW = Math.max(1.5, cssW / WAVE_MAX_COLS);
    const startX = cssW - n * colW;

    this._drawSegments(ctx, cssW, cssH, hist); // behind the bars

    for (let i = 0; i < n; i++) {
      const col = hist[i];
      const x = startX + i * colW;
      if (x < -colW) continue;
      const h = Math.max(1, col.amp * (cssH / 2 - 4));
      ctx.fillStyle = col.dropout ? 'rgba(248,81,73,.92)'
        : col.approx ? opts.approxColor
        : opts.color;
      ctx.fillRect(x, midY - h, Math.max(1, colW - 0.4), h * 2);
    }
  },

  _drawWave() {
    this._drawStrip('dbg-wave', this._waveHistory, { color: 'rgba(91,156,246,.85)', approxColor: 'rgba(91,156,246,.4)' });
  },

  _drawBufWave() {
    this._drawStrip('dbg-wave-buf', this._bufHistory, { color: 'rgba(167,139,250,.85)', approxColor: 'rgba(167,139,250,.35)' });
  },

  // Vertical grid lines toggled via the Off/Seconds/BPM control. Anchored
  // to real timestamps stored on each column (see _waveSample/_bufPush),
  // not to array index, so the grid scrolls smoothly and drift-free with
  // the bars instead of stepping. BPM mode phase-locks to the most
  // recently detected beat rather than an arbitrary offset, so lines
  // land on the actual onsets rather than just "every N seconds".
  _drawSegments(ctx, cssW, cssH, hist) {
    if (this._segMode === 'off' || !hist.length) return;
    const nowTs = hist[hist.length - 1].ts;
    let intervalMs, color;
    if (this._segMode === 'bpm') {
      if (!this._bpm) return;
      intervalMs = 60000 / this._bpm;
      color = 'rgba(251,191,36,.45)';
    } else {
      intervalMs = 1000;
      color = 'rgba(255,255,255,.14)';
    }
    const anchorTs = (this._segMode === 'bpm' && this._beatTimes.length)
      ? this._beatTimes[this._beatTimes.length - 1] : nowTs;
    const visibleMs = WAVE_MAX_COLS * WAVE_TICK_MS;
    const colW = Math.max(1.5, cssW / WAVE_MAX_COLS);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let t = anchorTs;
    while (t < nowTs) t += intervalMs; // fold forward in case anchor is stale
    for (; t >= nowTs - visibleMs - intervalMs; t -= intervalMs) {
      const x = cssW - ((nowTs - t) / WAVE_TICK_MS) * colW;
      if (x < -2) break;
      if (x <= cssW + 2) { ctx.moveTo(x, 3); ctx.lineTo(x, cssH - 3); }
    }
    ctx.stroke();
  },

  /* ───────── DOM: skeleton (built once) ───────── */
  ensureSkeleton() {
    if (this._built) return;
    this._built = true;
    const root = document.getElementById('dbg-root');
    root.innerHTML = `
      <div class="dbg-wrap">
        <div class="dbg-toolbar">
          <span class="dbg-title">⌁ Debug</span>
          <span class="dbg-sub">live instrumentation — network · stream + buffered waveform · beat detection · player events</span>
          <button class="qa d" id="dbg-clear">Clear</button>
        </div>

        <div class="dbg-grid" id="dbg-cards"></div>

        <div class="dbg-section">
          <div class="dbg-section-title">
            Stream waveform <span class="dbg-lane-hint">scrolling · red = dropout/glitch</span>
            <div class="dbg-seg-toggle" id="dbg-seg-toggle">
              <button class="dbg-seg-btn on" data-seg="off">Off</button>
              <button class="dbg-seg-btn" data-seg="seconds">Seconds</button>
              <button class="dbg-seg-btn" data-seg="bpm">BPM</button>
            </div>
          </div>
          <canvas id="dbg-wave" class="dbg-wave-canvas"></canvas>
        </div>

        <div class="dbg-section">
          <div class="dbg-section-title">Buffered waveform <span class="dbg-lane-hint" id="dbg-wave-buf-hint">received, not yet played · scrolls right→left</span></div>
          <canvas id="dbg-wave-buf" class="dbg-wave-canvas dbg-wave-canvas-buf"></canvas>
        </div>

        <div class="dbg-cols">
          <div class="dbg-section">
            <div class="dbg-section-title">Server requests <span class="dbg-lane-hint">(browser → backend)</span> <span class="dbg-count" id="dbg-net-count"></span></div>
            <div class="dbg-scroll"><table class="dbg-table">
              <thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>latency</th><th>size</th></tr></thead>
              <tbody id="dbg-net-body"></tbody>
            </table></div>
          </div>
          <div class="dbg-section">
            <div class="dbg-section-title">NodeLink requests <span class="dbg-lane-hint">(backend → NodeLink, pushed live)</span> <span class="dbg-count" id="dbg-nl-count"></span></div>
            <div class="dbg-scroll"><table class="dbg-table">
              <thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>latency</th><th>size</th></tr></thead>
              <tbody id="dbg-nl-body"></tbody>
            </table></div>
          </div>
        </div>

        <div class="dbg-cols">
          <div class="dbg-section">
            <div class="dbg-section-title">Player events <span class="dbg-count" id="dbg-evt-count"></span></div>
            <div class="dbg-scroll"><table class="dbg-table">
              <thead><tr><th>time</th><th>action</th><th>mode</th><th>latency</th></tr></thead>
              <tbody id="dbg-evt-body"></tbody>
            </table></div>
          </div>
          <div class="dbg-section">
            <div class="dbg-section-title">Dropouts / gaps <span class="dbg-count" id="dbg-drop-count"></span></div>
            <div class="dbg-scroll"><div id="dbg-drop-list" class="dbg-list"></div></div>
          </div>
        </div>

        <div class="dbg-cols">
          <div class="dbg-section">
            <div class="dbg-section-title">Audio element events <span class="dbg-count" id="dbg-ael-count"></span></div>
            <div class="dbg-scroll"><div id="dbg-ael-list" class="dbg-list"></div></div>
          </div>
          <div class="dbg-section">
            <div class="dbg-section-title">Smart Queue <span class="dbg-lane-hint">hidden recommendation pool</span> <span class="dbg-count" id="dbg-sq-count"></span></div>
            <div class="dbg-scroll"><div id="dbg-sq-list" class="dbg-list"></div></div>
          </div>
        </div>

        <div class="dbg-section" id="dbg-server-section" style="display:none">
          <div class="dbg-section-title">Server relay — encode / pacing <span class="dbg-lane-hint">(lobby mode, pushed live over the socket)</span></div>
          <div class="dbg-grid" id="dbg-server-cards"></div>
        </div>
      </div>
    `;
    document.getElementById('dbg-clear').addEventListener('click', () => this.clear());
    document.getElementById('dbg-seg-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.dbg-seg-btn');
      if (!btn) return;
      this._segMode = btn.dataset.seg;
      document.querySelectorAll('#dbg-seg-toggle .dbg-seg-btn').forEach(b => b.classList.toggle('on', b === btn));
    });
  },

  /* ───────── DOM: render (cheap, throttled to ~3.5fps by the caller) ───────── */
  render() {
    if (!this._built) return;
    this._renderCards();
    this._renderNetTable();
    this._renderNodelinkTable();
    this._renderEvtTable();
    this._renderDrops();
    this._renderAel();
    this._renderSmartQueue();
    this._renderServer();
    this._updateBufHint();
  },

  _updateBufHint() {
    const el = document.getElementById('dbg-wave-buf-hint');
    if (!el) return;
    el.textContent = S.mode === 'server'
      ? 'approx. — encoded relay has no raw PCM client-side, shown as buffered-seconds fill · scrolls right→left'
      : 'raw PCM already fed to the player, not yet audible · scrolls right→left · stitched gapless into the next track';
  },

  _renderCards() {
    const el = document.getElementById('dbg-cards');
    if (!el) return;
    const ctx = S.player && S.player.ctx;
    const connLabel = S.mode === 'server'
      ? `lobby ${S.lobby.code || '—'} · ${S.lobby.socket && S.lobby.socket.connected ? 'socket ok' : 'socket down'}`
      : S.mode === 'standalone' ? `standalone · ${Backend.host || '—'}` : 'not connected';
    const netMs = this._recentAvg(this.net.filter(n => n.ms != null).map(n => n.ms));
    const cards = [
      ['Mode', S.mode || '—'],
      ['Connection', connLabel],
      ['AudioContext', ctx ? `${ctx.state} · ${ctx.sampleRate}Hz` : '—'],
      ['Base/Output latency', ctx ? `${((ctx.baseLatency || 0) * 1000).toFixed(1)} / ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms` : '—'],
      ['Buffered ahead', this._fmtMaybeMs(this._bufferedAheadMs())],
      ['Detected BPM', this._bpmLabel()],
      ['Avg request latency', this._fmtMaybeMs(netMs)],
      ['Dropouts logged', String(this.dropouts.length)],
      ['Preload / queue chunks', this._queueChunksLabel()],
    ];
    el.innerHTML = cards.map(([k, v]) => `<div class="dbg-card"><div class="dbg-card-k">${esc(k)}</div><div class="dbg-card-v">${esc(String(v))}</div></div>`).join('');
  },

  _bufferedAheadMs() {
    if (!S.player) return null;
    if (S.mode === 'standalone' && S.player.ctx && S.player.nextTime != null) {
      return Math.max(0, (S.player.nextTime - S.player.ctx.currentTime) * 1000);
    }
    if (S.mode === 'server') {
      const audio = document.getElementById('lobby-audio');
      if (audio) return this._bufferedAheadSec(audio) * 1000;
    }
    return null;
  },

  _queueChunksLabel() {
    if (S.mode === 'standalone') return S.preload ? `${S.preload.chunks.length} chunk(s) preloaded` : 'none preloaded';
    if (S.mode === 'server' && this.server && !this.server.error) return this.server.hasPreload ? 'server has next track preloaded' : 'nothing preloaded';
    return '—';
  },

  _recentAvg(arr) {
    if (!arr.length) return null;
    const last = arr.slice(0, 10);
    return last.reduce((a, b) => a + b, 0) / last.length;
  },

  _renderNetTable() {
    const body = document.getElementById('dbg-net-body');
    const count = document.getElementById('dbg-net-count');
    if (!body) return;
    count.textContent = `(${this.net.length})`;
    body.innerHTML = this.net.slice(0, 20).map(n => `
      <tr class="${n.ok === false ? 'dbg-row-err' : ''}">
        <td>${this._fmtTime(n.ts)}</td>
        <td>${esc(n.method)}</td>
        <td class="dbg-mono" title="${esc(n.path)}">${esc(this._trunc(n.path, 26))}</td>
        <td>${n.pending ? '…' : esc(String(n.status))}</td>
        <td>${n.ms == null ? '—' : n.ms + 'ms'}</td>
        <td>${this._fmtBytes(n.size)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="dbg-empty-row">no requests yet</td></tr>`;
  },

  _renderNodelinkTable() {
    const body = document.getElementById('dbg-nl-body');
    const count = document.getElementById('dbg-nl-count');
    if (!body) return;
    if (S.mode !== 'server') {
      count.textContent = '';
      body.innerHTML = `<tr><td colspan="6" class="dbg-empty-row">standalone mode — your browser talks to NodeLink directly, see Server requests</td></tr>`;
      return;
    }
    count.textContent = `(${this.nodelinkRequests.length})`;
    body.innerHTML = this.nodelinkRequests.slice(0, 20).map(n => `
      <tr class="${n.ok === false ? 'dbg-row-err' : ''}">
        <td>${this._fmtTime(n.ts)}</td>
        <td>${esc(n.method)}</td>
        <td class="dbg-mono" title="${esc(n.path)}">${esc(this._trunc(n.path, 26))}</td>
        <td>${esc(String(n.status))}</td>
        <td>${n.ms == null ? '—' : n.ms + 'ms'}</td>
        <td>${this._fmtBytes(n.size)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="dbg-empty-row">no NodeLink requests yet</td></tr>`;
  },

  _renderEvtTable() {
    const body = document.getElementById('dbg-evt-body');
    const count = document.getElementById('dbg-evt-count');
    if (!body) return;
    count.textContent = `(${this.playerEvents.length})`;
    body.innerHTML = this.playerEvents.slice(0, 20).map(e => `
      <tr>
        <td>${this._fmtTime(e.ts)}</td>
        <td>${esc(e.name)}</td>
        <td>${esc(e.mode || '—')}</td>
        <td>${e.latencyMs == null ? (this._pendingAction && this._pendingAction.id === e.id ? 'pending…' : '—') : e.latencyMs + 'ms'}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="dbg-empty-row">no actions yet</td></tr>`;
  },

  _renderDrops() {
    const list = document.getElementById('dbg-drop-list');
    const count = document.getElementById('dbg-drop-count');
    if (!list) return;
    count.textContent = `(${this.dropouts.length})`;
    list.innerHTML = this.dropouts.slice(0, 20).map(d => `
      <div class="dbg-list-row dbg-row-err">
        <span class="dbg-mono">${this._fmtTime(d.ts)}</span>
        <span>gap ${d.gapMs}ms</span>
        <span class="dbg-muted">${esc(d.context || '')}</span>
      </div>`).join('') || `<div class="dbg-empty-row">no dropouts detected</div>`;
  },

  _renderAel() {
    const list = document.getElementById('dbg-ael-list');
    const count = document.getElementById('dbg-ael-count');
    if (!list) return;
    count.textContent = `(${this.audioElEvents.length})`;
    list.innerHTML = this.audioElEvents.slice(0, 20).map(a => `
      <div class="dbg-list-row ${['waiting', 'stalled', 'error'].includes(a.type) ? 'dbg-row-warn' : ''}">
        <span class="dbg-mono">${this._fmtTime(a.ts)}</span>
        <span>${esc(a.type)}</span>
        <span class="dbg-muted">${a.meta ? `t=${(a.meta.t || 0).toFixed(1)}s · buf+${(a.meta.buffered || 0).toFixed(1)}s` : ''}</span>
      </div>`).join('') || `<div class="dbg-empty-row">no audio element events yet</div>`;
  },

  // Standalone: S.autoQueue is already client-side (nothing hidden).
  // Lobby: the pool lives entirely server-side (Lobby.auto_queue) and was
  // never sent to clients before — this reads the autoQueue field added
  // to the debug_stats push in server.py specifically for this card.
  _renderSmartQueue() {
    const list = document.getElementById('dbg-sq-list');
    const count = document.getElementById('dbg-sq-count');
    if (!list) return;
    let items = [], total = 0;
    if (S.mode === 'standalone') {
      items = (S.autoQueue || []).map(t => ({ title: t.info && t.info.title, author: t.info && t.info.author }));
      total = items.length;
    } else if (S.mode === 'server' && this.server && !this.server.error) {
      items = this.server.autoQueue || [];
      total = this.server.autoQueueCount || 0;
    }
    count.textContent = total ? `(${total})` : '';
    if (!items.length) {
      list.innerHTML = `<div class="dbg-empty-row">${S.mode ? 'empty — nothing queued for autoplay/smart shuffle yet' : 'not connected'}</div>`;
      return;
    }
    list.innerHTML = items.slice(0, 25).map((t, i) => `
      <div class="dbg-list-row">
        <span class="dbg-mono">#${i + 1}</span>
        <span>${esc(t.title || 'Unknown title')}</span>
        <span class="dbg-muted">${esc(t.author || '')}</span>
      </div>`).join('');
  },

  _renderServer() {
    const section = document.getElementById('dbg-server-section');
    const el = document.getElementById('dbg-server-cards');
    if (!section || !el) return;
    if (S.mode !== 'server' || !this.server) { section.style.display = 'none'; return; }
    section.style.display = '';
    const s = this.server;
    if (s.error) { el.innerHTML = `<div class="dbg-card"><div class="dbg-card-k">error</div><div class="dbg-card-v">${esc(s.error)}</div></div>`; return; }
    const cards = [
      ['Generation', s.generation],
      ['Idle', s.idle ? 'yes (silence keepalive)' : 'no'],
      ['Listeners', s.listeners],
      ['Frames encoded', s.framesEncoded],
      ['Encode ms (avg/max)', `${s.encodeMsAvg ?? '—'} / ${s.encodeMsMax ?? '—'}`],
      ['Pace drift ms (avg/max)', `${s.paceDriftMsAvg ?? '—'} / ${s.paceDriftMsMax ?? '—'}`],
      ['Listener queue drops', s.listenerDrops],
      ['Encode sessions started', s.sessionsStarted],
      ['PCM in / Opus out', `${this._fmtBytes(s.pcmBytesIn)} / ${this._fmtBytes(s.opusBytesOut)}`],
      ['Last frame age', s.lastFrameAgeMs == null ? '—' : `${Math.round(s.lastFrameAgeMs)}ms`],
      ['Participants / Queue len', `${s.participants ?? '—'} / ${s.queueLength ?? '—'}`],
    ];
    el.innerHTML = cards.map(([k, v]) => `<div class="dbg-card"><div class="dbg-card-k">${esc(k)}</div><div class="dbg-card-v">${esc(String(v))}</div></div>`).join('');
  },

  /* ───────── formatting helpers ───────── */
  _fmtTime(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  },
  _fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
  },
  _fmtMaybeMs(n) { return n == null ? '—' : `${Math.round(n)} ms`; },
  _trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''); },
};

Debug._init();