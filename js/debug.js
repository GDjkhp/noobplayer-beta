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
       optional segment grid (seconds, toggled in the UI) draws over both
       strips, with a scrolling time label per line — see _drawSegments.
     - Buffered waveform → a single FIFO queue (_futureQueue) of real,
       already-decided audio that hasn't reached the listener's ears yet,
       front = soonest to play. Rather than scrolling, this strip draws
       like an oscilloscope sweep: unless a dropout is being simulated
       (_bufFrozen — see below), one item is popped off the front of
       _futureQueue per tick and APPENDED to _bufHistory at the next free
       column, left to right, and every column already drawn stays put —
       nothing shifts. Once _bufHistory fills the strip edge-to-edge
       (there's no free column left to draw the next one into), it's
       cleared outright and the sweep starts over from the left edge —
       see _bufSweepTick. Freezing on a dropout (instead of continuing to
       pop) simulates nothing being consumed while playback is stalled,
       so the sweep just pauses in place rather than skipping ahead.
       Where that future data actually comes from, in either mode:
         - standalone: PCMPlayer.feed()'s own bytes, sampled the instant
           they arrive (already decoded and scheduled onto the
           AudioContext timeline, just not at `currentTime` yet) — plus a
           poll of S.preload.chunks so the gapless-next-track's already-
           fetched bytes queue up too, stitched with no seam.
         - lobby: server.py's LobbyRelay.feed_chunk computes a peak for
           every 20ms PCM frame as it's encoded — ahead of network
           transit and the listener's own <audio> buffering, so it's
           genuine lookahead, not reconstructed from audio.buffered.
           Pushed as `wave_peaks` over the same debug socket subscription
           every 150ms, only while this tab is open (see
           LobbyRelay._wave_push_loop server-side).
       A hard cut (PCMPlayer.cutOver, or a generation bump from the
       server) drops whatever was still queued and wipes the sweep — it
       was stopped, not played, so it shouldn't stay drawn as if it were.
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
const FUTURE_QUEUE_MAX = 400;   // hard memory cap on _futureQueue — see _futureEnqueue (NOT a sweep-speed threshold; _bufSweepTick always advances by exactly one)

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
  _waveHistory: [],   // rolling waveform columns: {amp:0..1, dropout:bool, ts}, oldest first (index 0 = left edge = oldest, last index = right edge = "now")
  _bufHistory: [],    // the buffered strip's current sweep frame: columns accumulate left→right, fixed in place once drawn, and the whole array is cleared (not shifted) once it fills — see _bufSweepTick
  _futureQueue: [],   // FIFO of real, already-decided-but-unheard audio, front = soonest to play — see _bufSample
  _lastWaveGen: null, // last-seen server relay generation from wave_peaks — a change means a hard cut
  _bufFrozen: false,      // true while a stall is live — pauses the buffered strip's sweep in place (nothing is being "consumed" while playback is stalled). Recomputed live every tick in _bufSample — see _isPlaybackStalled.
  _audioElWaiting: false, // lobby mode: live "is #lobby-audio currently buffering" flag, set directly by the waiting/stalled/playing listeners — see _isPlaybackStalled

  // segment overlay toggle for the STREAM strip only — 'off' | 'seconds'
  // (the buffered strip never draws its own grid — see _drawBufWave)
  _segMode: 'off',

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
      // Enqueue it rather than pushing straight to history — _bufSweepTick
      // paces it onto the strip one column per tick instead of dumping a
      // whole chunk's worth in at once.
      self._futureEnqueueBytes(bytes);

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

    // A hard cut stops every scheduled source right now — whatever was
    // still sitting in _futureQueue for the old track was stopped, not
    // played, so it shouldn't stay drawn on the buffered strip's sweep
    // as if it were.
    const origCutOver = PCMPlayer.prototype.cutOver;
    PCMPlayer.prototype.cutOver = function (...args) {
      const r = origCutOver.apply(this, args);
      self._futureQueue.length = 0;
      self._bufHistory = [];
      self._bufFrozen = false;
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
          self._audioElWaiting = true; // live flag — see _isPlaybackStalled
        }
        if (type === 'playing') {
          self._audioElWaiting = false;
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
      // Real, already-decided-but-unheard audio for the buffered
      // waveform — see LobbyRelay._wave_push_loop / feed_chunk in
      // server.py. `generation` changing mid-stream means a hard cut
      // happened server-side (skip/seek/new track) — whatever's still
      // sitting in the queue from before that is stale, drop it.
      socket.on('wave_peaks', (payload) => {
        if (!payload || !payload.peaks) return;
        if (this._lastWaveGen !== null && payload.generation !== this._lastWaveGen) {
          this._futureQueue.length = 0;
          this._bufHistory = [];
          this._bufFrozen = false;
        }
        this._lastWaveGen = payload.generation;
        for (const amp of payload.peaks) this._futureEnqueue(amp);
      });
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
    this._lastWaveGen = null;
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
    this._futureQueue = [];
    this._bufFrozen = false;
    this._lastPreloadRef = null; this._lastPreloadSampledCount = 0;
  },
  clear() {
    this.net = []; this.playerEvents = []; this.dropouts = [];
    this.audioElEvents = [];
    this.nodelinkRequests = [];
    this._waveHistory = [];
    this._bufHistory = [];
    this._futureQueue = [];
    this._bufFrozen = false;
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

  // Called from dropout() — there's no real signal during a dropout (the
  // whole point is nothing arrived), so this doesn't invent one: it's
  // silence, drawn as a flat red line (amp 0 — _drawStrip's Math.max(1, …)
  // floor still gives it a hairline so it's visible), not a fake glitchy
  // reading. Column count is roughly proportional to how long the gap
  // was (capped so one huge stall doesn't swallow the whole visible
  // window).
  _injectWaveGlitch(gapMs) {
    const cols = Math.max(3, Math.min(28, Math.round(gapMs / WAVE_TICK_MS)));
    for (let i = 0; i < cols; i++) {
      this._waveHistory.push({ amp: 0, dropout: true, ts: performance.now() });
    }
    while (this._waveHistory.length > WAVE_MAX_COLS) this._waveHistory.shift();
  },

  // Live check, read fresh every tick from _bufSample — NOT a timer.
  // Freezing has to start exactly when the stall starts and end exactly
  // when it ends, or the buffered strip either scrolls through a stall
  // it should've paused for, or sits frozen past the point playback
  // actually recovered — either way the queue and real time drift apart,
  // and the strip has to fast-forward to resync once they're compared
  // again. Reading live state sidesteps that entirely: nothing to drift.
  //   - standalone: mirrors the same "am I behind schedule" comparison
  //     patchPCMPlayer's feed hook uses for starvedMs — nextTime only
  //     moves forward when feed() actually schedules a new buffer, so if
  //     ctx.currentTime has caught up to (or passed) nextTime, playback
  //     has run out of scheduled audio right now, this instant — no need
  //     to wait for the next feed() call to find out.
  //   - lobby: _audioElWaiting is set true/false directly by the
  //     'waiting'/'stalled'/'playing' listeners in attachAudioElListeners,
  //     live, the moment each fires.
  _isPlaybackStalled() {
    if (S.mode === 'standalone') {
      const p = S.player;
      if (!p || !p.ctx || p.startCtxTime === null || p.isPaused) return false;
      return p.ctx.currentTime + 0.02 > p.nextTime + 0.005;
    }
    if (S.mode === 'server') return !!this._audioElWaiting;
    return false;
  },

  /* ───────── buffered waveform ─────────
     Second strip, drawn under the stream waveform. Where the strip above
     reads S.player.getWaveform() (audio actually reaching the speaker
     right now), this one shows real, already-decided audio the listener
     hasn't heard yet — held in a single FIFO (_futureQueue), front =
     soonest to play.

     Unlike the stream strip, this one does NOT scroll. It sweeps: every
     tick (unless _bufFrozen — see _isPlaybackStalled), the front item is
     popped off _futureQueue and appended to _bufHistory at the next free
     column, left to right — see _bufSweepTick. Every column, once drawn,
     stays exactly where it was drawn; nothing already on the strip ever
     moves. When _bufHistory fills the strip edge-to-edge and there's no
     free column left to draw into, it's cleared outright and the sweep
     starts over from the left edge — like an oscilloscope retracing
     rather than a ticker scrolling past.

     Where the queue actually gets filled, never fabricated:
       - standalone: every chunk passed to PCMPlayer.feed() (patched
         above) is sampled the instant it arrives, before scheduling —
         already decided, already on the AudioContext timeline, just not
         at `currentTime` yet.
       - also standalone: S.preload.chunks (engine.js's background
         gapless prefetch for whatever plays next) is polled every tick
         and newly-arrived chunks get enqueued too, right after the
         current track's own tail — so the next track's audio queues up
         before the gapless splice ever happens, no seam at the join.
       - lobby: server.py's LobbyRelay computes a real peak per 20ms PCM
         frame as it encodes (see feed_chunk/_wave_push_loop server-side)
         and pushes it over the debug socket as `wave_peaks` every 150ms
         — genuine server-side lookahead, ahead of network transit and
         the listener's own <audio> buffering, not a client-side guess. */
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

  _futureEnqueue(amp) {
    this._futureQueue.push({ amp, dropout: false, ts: performance.now() });
    // Safety cap only — _bufSweepTick already drains one per tick on its
    // own regardless of how far ahead the queue gets; this just bounds
    // worst-case memory if draining ever falls badly behind (e.g. the tab
    // was backgrounded).
    if (this._futureQueue.length > FUTURE_QUEUE_MAX * 2) {
      this._futureQueue.splice(0, this._futureQueue.length - FUTURE_QUEUE_MAX * 2);
    }
  },

  _futureEnqueueBytes(bytes) {
    if (S.mode !== 'standalone') return;
    this._futureEnqueue(this._ampFromBytes(bytes));
  },

  _bufPollPreload() {
    const pre = S.preload;
    if (!pre) { this._lastPreloadRef = null; this._lastPreloadSampledCount = 0; return; }
    if (this._lastPreloadRef !== pre) { this._lastPreloadRef = pre; this._lastPreloadSampledCount = 0; }
    const chunks = pre.chunks;
    for (let i = this._lastPreloadSampledCount; i < chunks.length; i++) {
      this._futureEnqueue(this._ampFromBytes(chunks[i]));
    }
    this._lastPreloadSampledCount = chunks.length;
  },

  // Pops exactly one item off the FRONT of _futureQueue per tick and
  // appends it to _bufHistory at the next free column — it has just
  // reached "now" and is about to be audible, so it "becomes" the next
  // drawn bar rather than sliding the strip. Skipped entirely while
  // _bufFrozen (set live, per tick, in _bufSample — see
  // _isPlaybackStalled): while a stall is actually happening, nothing is
  // being consumed, so the sweep shouldn't advance either — it just
  // pauses in place until the stall clears, rather than continuing to
  // fill in columns for audio that hasn't actually arrived yet.
  // Deliberately always exactly one, never more: the sweep's pace has to
  // stay constant and match the stream strip's per-tick rate. A queue
  // that's building up faster than real-time just grows further ahead of
  // where the sweep currently is instead of being caught up on — the
  // safety cap in _futureEnqueue bounds that, not this.
  //
  // Once _bufHistory has a column for every position the strip can show,
  // there's nowhere left to append the next one: clear the whole strip
  // and start the sweep over from the left edge, then draw the item that
  // just arrived as the sweep's new first column.
  _bufSweepTick() {
    if (this._bufFrozen) return;
    if (!this._futureQueue.length) return; // nothing new arrived this tick — leave the strip exactly as it is
    if (this._bufHistory.length >= WAVE_MAX_COLS) this._bufHistory = [];
    this._bufHistory.push(this._futureQueue.shift());
  },

  _bufSample() {
    if (S.mode === 'standalone') this._bufPollPreload();
    this._bufFrozen = this._isPlaybackStalled();
    this._bufSweepTick();
  },

  // Shared renderer for both strips — stream waveform and buffered
  // waveform are the same scrolling-columns visual over two different
  // data sources, so this draws either given a canvas id + history ring.
  // No centerline, no playhead — "now" is marked only by an edge:
  //   - stream strip (opts.anchor omitted/'right'): newest sample sits
  //     flush against the RIGHT edge, older ones trail off to the left.
  //   - buffered strip (opts.anchor:'left'): soonest-to-play sample sits
  //     flush against the LEFT edge — the same "now" instant as the
  //     stream strip's right edge — with the future trailing off to the
  //     right as more gets buffered. This matters whenever the buffer is
  //     shorter than a full window: anchoring left keeps "now" pinned at
  //     x=0 instead of sliding around with however much is buffered.
  //   opts.segments:false skips the grid overlay (buffered strip only —
  //   the stream strip already carries it, a second copy is redundant).
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
    const startX = opts.anchor === 'left' ? 0 : cssW - n * colW;

    if (opts.segments !== false) this._drawSegments(ctx, cssW, cssH, hist); // behind the bars

    for (let i = 0; i < n; i++) {
      const col = hist[i];
      const x = startX + i * colW;
      if (x < -colW || x > cssW) continue;
      const h = Math.max(1, col.amp * (cssH / 2 - 4));
      ctx.fillStyle = col.dropout ? 'rgba(248,81,73,.92)' : opts.color;
      ctx.fillRect(x, midY - h, Math.max(1, colW - 0.4), h * 2);
    }
  },

  _drawWave() {
    this._drawStrip('dbg-wave', this._waveHistory, { color: 'rgba(91,156,246,.85)' });
  },

  _drawBufWave() {
    this._drawStrip('dbg-wave-buf', this._bufHistory, { color: 'rgba(167,139,250,.85)', anchor: 'left', segments: false });
  },

  // Vertical grid lines toggled via the Off/Seconds control, one per
  // second, plus a small elapsed-time label riding along the top of each
  // line. Anchored to real timestamps stored on each column (see
  // _waveSample/_futureEnqueue), not to array index, so the grid — lines
  // AND labels — scrolls smoothly and drift-free with the bars instead
  // of stepping. Stream strip only — see _drawStrip's opts.segments;
  // drawing it a second time on the buffered strip below would just be
  // a duplicate of the same grid.
  _drawSegments(ctx, cssW, cssH, hist) {
    if (this._segMode === 'off' || !hist.length) return;
    const nowTs = hist[hist.length - 1].ts;
    const intervalMs = 1000;
    const lineColor = 'rgba(255,255,255,.14)';
    const labelColor = 'rgba(255,255,255,.55)';
    const visibleMs = WAVE_MAX_COLS * WAVE_TICK_MS;
    const colW = Math.max(1.5, cssW / WAVE_MAX_COLS);

    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let secsAgo = 0;
    for (let t = nowTs; t >= nowTs - visibleMs - intervalMs; t -= intervalMs, secsAgo++) {
      const x = cssW - ((nowTs - t) / WAVE_TICK_MS) * colW;
      if (x < -2) break;
      if (x > cssW + 2) continue;

      ctx.strokeStyle = lineColor;
      ctx.beginPath();
      ctx.moveTo(x, 3); ctx.lineTo(x, cssH - 3);
      ctx.stroke();

      // The label moves with its line (same `x`) so it tracks the scroll
      // exactly rather than sitting fixed while the grid slides under it.
      const label = secsAgo === 0 ? 'now' : `-${secsAgo}s`;
      const lx = Math.min(Math.max(x, 12), cssW - 12);
      ctx.fillStyle = labelColor;
      ctx.fillText(label, lx, 4);
    }
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
          <span class="dbg-sub">live instrumentation — network · stream + buffered waveform · player events</span>
          <button class="qa d" id="dbg-clear">Clear</button>
        </div>

        <div class="dbg-grid" id="dbg-cards"></div>

        <div class="dbg-section">
          <div class="dbg-section-title">
            Stream waveform <span class="dbg-lane-hint">scrolling · red = dropout/glitch</span>
            <div class="dbg-seg-toggle" id="dbg-seg-toggle">
              <button class="dbg-seg-btn on" data-seg="off">Off</button>
              <button class="dbg-seg-btn" data-seg="seconds">Seconds</button>
            </div>
          </div>
          <canvas id="dbg-wave" class="dbg-wave-canvas"></canvas>
        </div>

        <div class="dbg-section">
          <div class="dbg-section-title">Buffered waveform <span class="dbg-lane-hint" id="dbg-wave-buf-hint">received, not yet played · sweeps left→right, clears, repeats</span></div>
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
      ? 'server-computed lookahead, one peak per 20ms frame · pushed every 150ms · sweeps left→right, clears, repeats'
      : 'already fed to the player, not yet audible · sweeps left→right, clears, repeats · stitched gapless into the next track';
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
      ['Listeners (WebRTC)', s.listeners],
      ['Frames sent', s.framesSent],
      ['Pace drift ms (avg/max)', `${s.paceDriftMsAvg ?? '—'} / ${s.paceDriftMsMax ?? '—'}`],
      ['Sessions started', s.sessionsStarted],
      ['PCM produced', this._fmtBytes(s.pcmBytesIn)],
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