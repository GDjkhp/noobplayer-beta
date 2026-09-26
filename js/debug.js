'use strict';
/* ═══════════════════════════════════════════
   Debug — the "Debug" tab.

   Design goal: instrument the app WITHOUT editing engine.js, pcm-player.js,
   audio-el-player.js, lobby.js or api.js. Everything here is either a
   monkey-patch (wrap a function on an existing prototype/object and call
   the original) or a direct DOM listener on elements that already exist
   in index.html (#lobby-audio). That keeps every other
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
       optional segment grid (seconds, toggled in the UI) draws over this
       strip, with a scrolling time label per line — see _drawSegments.
     - Buffered waveform → everything this BROWSER has already received and
       is holding ready to play, drawn as a waveform, with what has already
       been played in a different colour and a playhead between the two.
       Nothing is computed server-side; it's built from data the client
       already has (see the "buffered waveform" section below):
         - standalone: every chunk PCMPlayer.feed() receives is binned into
           100ms peaks on the track's own timeline, together with the
           AudioContext time each bin is scheduled to be heard — so
           "played" is just `scheduled time <= ctx.currentTime`. Whole-
           track view; if the gapless preload has fetched the next track,
           S.preload is drawn after it.
         - lobby: a thin hls.js loader wrapper copies every HLS segment as
           it's fetched; the copy is decoded (decodeAudioData) into 50ms
           peaks and drawn wherever <audio>.buffered says the element
           really holds it, scrolling with the element's playhead.
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
// Buffered-waveform resolution + look. Standalone draws a whole track in one
// strip so it's coarse (100ms per bar); the lobby view only spans ~20s so it
// can afford 50ms.
const BUF_BIN_MS = 100;
const HLS_BIN_MS = 50;
const HLS_FRAG_KEEP = 40;            // HLS segments remembered for the lobby view (hls.js itself only keeps ~10s of back buffer)
const HLS_VIEW_SPAN_S = 20;          // seconds of stream the lobby strip covers...
const HLS_PLAYHEAD_FRAC = 0.5;       // ...with the playhead centered across it (played on the left, ready on the right)
const COL_PLAYED = 'rgba(148,163,184,.55)';
const COL_READY = 'rgba(167,139,250,.9)';

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

  // segment overlay toggle for the STREAM strip only — 'off' | 'seconds'
  // (the buffered strip never draws its own grid)
  _segMode: 'off',

  // ── buffered waveform (client-received audio) ──
  // standalone: one entry per track whose PCM has reached PCMPlayer, in
  // playback order — see _bufRecord. The gapless preload's own (not yet
  // scheduled) chunks are tracked separately in _bufPre.
  _bufSegs: [],
  _bufPre: null,      // { ref: S.preload, seg, sampled } — the preloaded next track, binned as its chunks arrive
  // lobby: every HLS segment hls.js fetched: sn -> { frag, raw, peaks, state }
  _hlsFrags: new Map(),
  _hlsDecodeCtx: null,
  _hlsDecodeErr: null,

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
    this.patchLobbyMedia();
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

      // Record BEFORE origFeed schedules it: player.nextTime is still
      // where this chunk is about to land on the AudioContext timeline,
      // which is what lets the buffered strip tell played from ready.
      self._bufRecord(this, bytes);

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

    // The buffered strip mirrors what this PCMPlayer instance is holding,
    // so it has to forget things exactly when the player does:
    //   - init(): brand-new AudioContext (new track, or a seek) — audio
    //     scheduled on the old one is gone.
    //   - cutOver(): a hard cut stops every scheduled source right now.
    //   - markTrackBoundary(): gapless splice — the old track's tail keeps
    //     playing, so its data STAYS; the next feed() just starts a new
    //     segment for the incoming track.
    //   - destroy(): player torn down.
    const origInit = PCMPlayer.prototype.init;
    PCMPlayer.prototype.init = function (...args) {
      self._bufSegs = []; this._dbgSeg = null;
      return origInit.apply(this, args);
    };
    const origCutOver = PCMPlayer.prototype.cutOver;
    PCMPlayer.prototype.cutOver = function (...args) {
      const r = origCutOver.apply(this, args);
      self._bufSegs = []; this._dbgSeg = null;
      return r;
    };
    const origBoundary = PCMPlayer.prototype.markTrackBoundary;
    PCMPlayer.prototype.markTrackBoundary = function (...args) {
      this._dbgSeg = null;
      return origBoundary.apply(this, args);
    };
    const origDestroy = PCMPlayer.prototype.destroy;
    PCMPlayer.prototype.destroy = function (...args) {
      self._bufSegs = []; this._dbgSeg = null;
      return origDestroy.apply(this, args);
    };
  },

  // Lobby mode plays an HLS stream through hls.js (see Lobby._connectMedia).
  // Wrap that so the fresh Hls instance can be tapped for the segments it
  // fetches — they ARE the buffered audio, so decoding them is the honest
  // way to draw it. _connectMedia has no awaits before it stores
  // S.lobby.hls, so by the time it returns the instance exists.
  patchLobbyMedia() {
    if (typeof Lobby === 'undefined' || Lobby._dbgPatched) return;
    Lobby._dbgPatched = true;
    const self = this;
    const orig = Lobby._connectMedia;
    Lobby._connectMedia = function (...args) {
      const r = orig.apply(this, args);
      self._attachHls(S.lobby.hls);
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
    // HLS segments that arrived while the tab was closed are kept raw —
    // decode them now so the played half of the strip isn't empty.
    for (const e of this._hlsFrags.values()) this._hlsDecode(e);
  },
  stop() {
    this._running = false;
    this.unsubscribeSocket();
    clearInterval(this._renderTimer); this._renderTimer = null;
    this._stopWave();
    this._waveHistory = []; // fresh sweep next time the tab opens, rather than a stale gap stitched in
    // (the buffered strip is deliberately NOT reset here: it's a live view
    // of what the player holds, recorded whether or not this tab is open)
  },
  clear() {
    this.net = []; this.playerEvents = []; this.dropouts = [];
    this.audioElEvents = [];
    this.nodelinkRequests = [];
    this._waveHistory = [];
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
     leaving the tab (see stop() above). (The buffered strip further down
     is a different beast — it's a picture of the player's buffer, not a
     scrolling history.) */
  _startWave() {
    if (this._waveRaf) return;
    const loop = (ts) => {
      if (!this._running) { this._waveRaf = null; return; }
      if (ts - this._waveLastTick >= WAVE_TICK_MS) {
        this._waveLastTick = ts;
        this._waveSample();
        this._bufTick();
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

  /* ───────── buffered waveform ─────────
     Second strip, drawn under the stream waveform. Where the strip above
     reads S.player.getWaveform() (audio actually reaching the speaker
     right now), this one shows everything the CLIENT has already received
     and is holding ready to play. Audio that has already been played is
     drawn in COL_PLAYED, audio still waiting in COL_READY, with a playhead
     line between them. Nothing is computed server-side — it's built purely
     from data this browser already has:

       - standalone: every chunk handed to PCMPlayer.feed() (patched above)
         is binned into BUF_BIN_MS peaks on the track's own timeline
         (_bufRecord), together with the AudioContext time each bin is
         scheduled to be heard. "Played" is then simply `scheduled time <=
         ctx.currentTime`, read straight off the audio clock — so pause,
         stalls and seeks come out right with no bookkeeping of our own.
         The strip shows the whole track: received parts filled in, the
         rest blank while it's still streaming. If the gapless preload has
         already fetched the next track, S.preload's chunks are binned too
         (_bufPollPreload) and drawn after it, all "ready".

       - lobby: a thin loader wrapper takes a copy of every HLS segment
         hls.js fetches (see _attachHls). Each is an independently decodable
         ADTS/AAC file, so a copy is run through decodeAudioData and reduced
         to HLS_BIN_MS peaks (_hlsDecode). The strip is a window that
         scrolls with the <audio> element's playhead, and a span only draws
         where <audio>.buffered says the element really has it — so "ready"
         is what it can play right now, "played" is what it hasn't evicted
         from its back buffer yet. If a segment can't be decoded (or the
         browser is playing HLS natively, with no hls.js in the loop) the
         buffered ranges are still drawn, as flat lines. */

  // ── standalone ──
  _bufNewSeg(track) {
    const info = (track && track.info) || {};
    return {
      label: info.title || '',
      lengthMs: info.length || 0,
      startMs: 0,      // where in the track this stream began (seek offset)
      bytes: 0,        // PCM bytes received for this segment so far
      amps: [],        // peak 0..1 per BUF_BIN_MS bin, indexed by ABSOLUTE track position (holes = not received)
      ctxT: [],        // AudioContext time each bin is scheduled to start being heard (Infinity = not scheduled yet)
      endCtx: 0,       // AudioContext time this segment's last received audio finishes
    };
  },

  // Called from the patched PCMPlayer.feed() BEFORE it schedules `bytes`.
  _bufRecord(player, bytes) {
    if (!player.ctx || player.ctx.state === 'closed' || !bytes || !bytes.length) return;
    let seg = player._dbgSeg;
    if (!seg) {
      seg = player._dbgSeg = this._bufNewSeg(S.current);
      seg.startMs = player.seekOffsetMs || 0;
      this._bufSegs.push(seg);
    }
    const bps = player.SR * player.BPF;
    const when = Math.max(player.nextTime, player.ctx.currentTime + 0.02);   // the same expression feed() itself uses
    this._bufBin(seg, bytes, when, bps);
    seg.endCtx = Math.max(seg.endCtx, when + bytes.length / bps);
  },

  // Folds a chunk of s16le stereo PCM into seg's bins. `when` is the
  // AudioContext time the chunk's first byte will be heard (Infinity for a
  // preloaded chunk that hasn't been scheduled yet).
  _bufBin(seg, bytes, when, bps) {
    const binBytes = Math.round(bps * BUF_BIN_MS / 1000);
    const base = Math.round(seg.startMs / BUF_BIN_MS);
    const off = seg.bytes, end = off + bytes.length;
    for (let b = Math.floor(off / binBytes); b * binBytes < end; b++) {
      const s = Math.max(off, b * binBytes), e = Math.min(end, (b + 1) * binBytes);
      let peak = 0;
      // Left-channel sample of every 2nd frame. Alignment is taken from the
      // absolute byte offset, so a chunk boundary that splits a frame can't
      // shift us onto the wrong bytes.
      for (let p = s + ((4 - (s & 3)) & 3); p + 1 < e; p += 8) {
        const i = p - off;
        let v = bytes[i] | (bytes[i + 1] << 8);
        if (v > 32767) v -= 65536;
        if (v < 0) v = -v;
        if (v > peak) peak = v;
      }
      const idx = base + b, amp = peak / 32768;
      const prev = seg.amps[idx];
      seg.amps[idx] = prev === undefined ? amp : Math.max(prev, amp);
      if (seg.ctxT[idx] === undefined) seg.ctxT[idx] = when + (s - off) / bps;
    }
    seg.bytes = end;
  },

  // engine.js's background gapless prefetch (S.preload) is audio the
  // client has already received for the NEXT track, even though it hasn't
  // been handed to the player yet. Bin whatever's newly arrived.
  _bufPollPreload() {
    const pre = S.preload;
    if (!pre || S.mode !== 'standalone') { this._bufPre = null; return; }
    let bp = this._bufPre;
    if (!bp || bp.ref !== pre) bp = this._bufPre = { ref: pre, seg: this._bufNewSeg(pre.track), sampled: 0 };
    for (; bp.sampled < pre.chunks.length; bp.sampled++) {
      this._bufBin(bp.seg, pre.chunks[bp.sampled], Infinity, 48000 * 4);   // PCM stream format is fixed: 48kHz s16 stereo
    }
  },

  _bufTick() {
    if (S.mode === 'standalone') this._bufPollPreload(); else this._bufPre = null;
    // A track that has played all the way through drops off once something
    // else is queued after it.
    const p = S.player, now = p && p.ctx ? p.ctx.currentTime : 0;
    while (this._bufSegs.length > 1 && this._bufSegs[0].endCtx <= now) this._bufSegs.shift();
  },

  // ── lobby ──
  // hls.js gives no usable segment bytes through its events: by the time
  // FRAG_LOADED fires the payload has already been transferred to its
  // transmuxer worker (detached, byteLength 0). The loader itself is the
  // one place the bytes exist intact, and hls.js reads config.fLoader afresh
  // for every fragment request — so slot a thin subclass of whatever loader
  // is configured in there. It changes nothing about the request; it just
  // takes a copy of the response on its way past. No extra network traffic.
  _attachHls(hls) {
    this._hlsFrags.clear();
    this._hlsDecodeErr = null;
    if (!hls || !hls.config || hls._dbgAttached) return;
    const Base = hls.config.fLoader || hls.config.loader;
    if (!Base) return;
    hls._dbgAttached = true;
    const self = this;
    hls.config.fLoader = class extends Base {
      load(context, config, callbacks) {
        const onSuccess = callbacks.onSuccess;
        const tapped = Object.assign({}, callbacks, {
          onSuccess(response, stats, ctx, details) {
            try {
              if (context.frag && response && response.data instanceof ArrayBuffer) self._onHlsFrag(context.frag, response.data);
            } catch (_) {}
            return onSuccess(response, stats, ctx, details);
          },
        });
        return super.load(context, config, tapped);
      }
    };
  },

  _onHlsFrag(frag, buffer) {
    if (frag.type && frag.type !== 'main') return;
    // `frag` is kept by reference on purpose: hls.js refines frag.start to the
    // real media-timeline position once it has parsed the segment, and the
    // strip is drawn against <audio>.currentTime, which lives on that timeline.
    const entry = { frag, raw: buffer.slice(0), peaks: null, state: 'raw' };
    this._hlsFrags.set(frag.sn, entry);
    if (this._hlsFrags.size > HLS_FRAG_KEEP) {
      let oldest = Infinity;
      for (const k of this._hlsFrags.keys()) if (k < oldest) oldest = k;
      this._hlsFrags.delete(oldest);
    }
    if (this._running) this._hlsDecode(entry);
  },

  async _hlsDecode(e) {
    if (e.state !== 'raw') return;
    e.state = 'decoding';
    try {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!this._hlsDecodeCtx) this._hlsDecodeCtx = new AC(2, 1, 48000);
      const buf = await this._hlsDecodeCtx.decodeAudioData(e.raw);   // detaches e.raw
      e.raw = null;
      e.peaks = this._peaksOf(buf, HLS_BIN_MS);
      e.state = 'done';
    } catch (err) {
      e.raw = null;
      e.state = 'failed';
      this._hlsDecodeErr = (err && err.message) || String(err);
    }
  },

  _peaksOf(audioBuf, binMs) {
    const n = audioBuf.length, binSamples = Math.max(1, Math.round(audioBuf.sampleRate * binMs / 1000));
    const bins = Math.ceil(n / binSamples), out = new Uint8Array(bins);
    const chans = [];
    for (let c = 0; c < audioBuf.numberOfChannels; c++) chans.push(audioBuf.getChannelData(c));
    for (let b = 0; b < bins; b++) {
      let peak = 0;
      for (let i = b * binSamples, end = Math.min(n, i + binSamples); i < end; i += 4) {
        for (let c = 0; c < chans.length; c++) { const v = Math.abs(chans[c][i]); if (v > peak) peak = v; }
      }
      out[b] = Math.min(255, Math.round(peak * 255));
    }
    return out;
  },

  /* ───────── drawing ───────── */
  _prepCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 90;
    const dpr = window.devicePixelRatio || 1;
    if (canvas._dbgW !== w || canvas._dbgH !== h) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas._dbgW = w; canvas._dbgH = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  },

  // Stream strip: newest sample sits flush against the RIGHT edge, older
  // ones trail off to the left. No centerline, no playhead — "now" is
  // marked only by that edge.
  _drawStrip(canvasId, hist, opts) {
    const c = this._prepCanvas(canvasId);
    if (!c) return;
    const { ctx, w: cssW, h: cssH } = c;
    const midY = cssH / 2;
    const n = hist.length;
    const colW = Math.max(1.5, cssW / WAVE_MAX_COLS);
    const startX = cssW - n * colW;

    this._drawSegments(ctx, cssW, cssH, hist); // behind the bars

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
    const c = this._prepCanvas('dbg-wave-buf');
    if (!c) return;
    if (S.mode === 'server') this._drawBufLobby(c.ctx, c.w, c.h);
    else if (S.mode === 'standalone') this._drawBufStandalone(c.ctx, c.w, c.h);
    else this._drawBufNote(c.ctx, c.w, c.h, 'not connected');
  },

  _drawBufNote(ctx, w, h, text) {
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  },

  _drawBufStandalone(ctx, W, H) {
    const segs = this._bufSegs.slice();
    if (this._bufPre) segs.push(this._bufPre.seg);
    if (!segs.length) { this._drawBufNote(ctx, W, H, 'nothing buffered'); return; }

    const p = S.player, now = p && p.ctx ? p.ctx.currentTime : 0;
    const GAP = 6;
    // Each segment gets width in proportion to its length (or how much of it
    // has arrived, if the length isn't known).
    const spans = segs.map(sg => Math.max(sg.lengthMs, sg.amps.length * BUF_BIN_MS, BUF_BIN_MS));
    const totalMs = spans.reduce((a, b) => a + b, 0);
    const usable = Math.max(10, W - GAP * (segs.length - 1));
    let x0 = 0;
    segs.forEach((sg, i) => {
      const w = Math.max(2, Math.round(usable * spans[i] / totalMs));
      this._drawBufSeg(ctx, sg, x0, w, H, now, spans[i], !!(this._bufPre && sg === this._bufPre.seg));
      x0 += w + GAP;
    });
  },

  _drawBufSeg(ctx, sg, x0, w, H, now, spanMs, isNext) {
    const midY = H / 2, maxH = H / 2 - 4;
    const nb = Math.max(1, Math.ceil(spanMs / BUF_BIN_MS));
    const amps = sg.amps, ctxT = sg.ctxT;

    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(x0, midY - 0.5, w, 1);              // the track's full extent, received or not

    for (let px = 0; px < w; px++) {
      const bA = Math.floor(px * nb / w), bB = Math.max(bA + 1, Math.floor((px + 1) * nb / w));
      let amp = -1, rep = -1;
      for (let b = bA; b < bB; b++) {
        const a = amps[b];
        if (a !== undefined && a > amp) { amp = a; rep = b; }
      }
      if (rep < 0) continue;                          // not received (yet)
      ctx.fillStyle = ctxT[rep] <= now ? COL_PLAYED : COL_READY;
      const h = Math.max(1, amp * maxH);
      ctx.fillRect(x0 + px, midY - h, 1, h * 2);
    }

    // Playhead: the first received bin that hasn't been heard yet, provided
    // some of this segment has been (a segment that's all ready has none).
    let front = -1, anyPlayed = false;
    for (let b = 0; b < amps.length; b++) {
      const t = ctxT[b];
      if (t === undefined) continue;
      if (t > now) { front = b; break; }
      anyPlayed = true;
    }
    if (anyPlayed && front > 0) {
      const x = x0 + Math.round(front * w / nb);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(Math.min(x, x0 + w - 1), 2, 1.5, H - 4);
    }

    if (w > 56 && (sg.label || isNext)) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, 0, w, 12); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText((isNext ? 'next · ' : '') + sg.label, x0 + 3, 2);
      ctx.restore();
    }
  },

  _drawBufLobby(ctx, W, H) {
    const audio = document.getElementById('lobby-audio');
    if (!audio) { this._drawBufNote(ctx, W, H, 'no <audio> element'); return; }
    const now = audio.currentTime || 0;
    const midY = H / 2, maxH = H / 2 - 4;
    const pxPerSec = W / HLS_VIEW_SPAN_S, playX = W * HLS_PLAYHEAD_FRAC;
    const xOf = (t) => playX + (t - now) * pxPerSec;

    const ranges = [];
    for (let i = 0; i < audio.buffered.length; i++) ranges.push([audio.buffered.start(i), audio.buffered.end(i)]);
    if (!ranges.length) { this._drawBufNote(ctx, W, H, 'nothing buffered'); return; }
    const inBuffer = (t) => { for (const r of ranges) if (t >= r[0] - 0.02 && t <= r[1] + 0.02) return true; return false; };

    // 1) What the element holds, as a flat line — always drawn, so the range
    //    is visible even where there's no decoded waveform to put on it.
    for (const [s, e] of ranges) {
      const a = Math.max(0, xOf(s)), b = Math.min(W, xOf(e)), split = Math.min(b, Math.max(a, xOf(now)));
      if (b <= a) continue;
      ctx.fillStyle = COL_PLAYED; ctx.fillRect(a, midY - 1, split - a, 2);
      ctx.fillStyle = COL_READY;  ctx.fillRect(split, midY - 1, b - split, 2);
    }

    // 2) Decoded waveform on top of it.
    const binS = HLS_BIN_MS / 1000, barW = Math.max(1, binS * pxPerSec - 0.5);
    for (const e of this._hlsFrags.values()) {
      if (e.state !== 'done' || !e.peaks) continue;
      const t0 = e.frag.start;
      if (!isFinite(t0)) continue;
      for (let k = 0; k < e.peaks.length; k++) {
        const t = t0 + k * binS, x = xOf(t);
        if (x > W || x + barW < 0) continue;
        if (!inBuffer(t + binS / 2)) continue;
        ctx.fillStyle = t + binS / 2 <= now ? COL_PLAYED : COL_READY;
        const h = Math.max(1, (e.peaks[k] / 255) * maxH);
        ctx.fillRect(x, midY - h, barW, h * 2);
      }
    }

    // Playhead + how much is on either side of it.
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(playX, 2, 1.5, H - 4);
    let behind = 0, ahead = 0;
    for (const [s, e] of ranges) if (now >= s - 0.05 && now <= e + 0.05) { behind = now - s; ahead = e - now; }
    ctx.font = '9px ui-monospace, monospace'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.textAlign = 'left';  ctx.fillText(`${behind.toFixed(1)}s played`, 3, 2);
    ctx.textAlign = 'right'; ctx.fillText(`${ahead.toFixed(1)}s ready`, W - 3, 2);
  },

  // Vertical grid lines toggled via the Off/Seconds control, one per
  // second, plus a small elapsed-time label riding along the top of each
  // line. Anchored to real timestamps stored on each column (see
  // _waveSample), not to array index, so the grid — lines
  // AND labels — scrolls smoothly and drift-free with the bars instead
  // of stepping. Stream strip only — the buffered strip has its own
  // playhead and no per-second grid.
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
          <span class="dbg-title"><span class="material-symbols-outlined">bug_report</span>Debug</span>
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
          <div class="dbg-section-title">Buffered waveform <span class="dbg-key"><i class="dbg-key-sw played"></i>played</span> <span class="dbg-key"><i class="dbg-key-sw ready"></i>ready</span> <span class="dbg-lane-hint" id="dbg-wave-buf-hint"></span></div>
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
            <div class="dbg-section-title">Smart Queue <span class="dbg-lane-hint">hidden recommendation pool</span> <span class="dbg-count" id="dbg-sq-count"></span></div>
            <div class="dbg-scroll"><div id="dbg-sq-list" class="dbg-list"></div></div>
          </div>
          <div class="dbg-section">
            <div class="dbg-section-title">History Queue <span class="dbg-lane-hint">already played · most recent first</span> <span class="dbg-count" id="dbg-hq-count"></span></div>
            <div class="dbg-scroll"><div id="dbg-hq-list" class="dbg-list"></div></div>
          </div>
        </div>

        <div class="dbg-section">
          <div class="dbg-section-title">Audio element events <span class="dbg-count" id="dbg-ael-count"></span></div>
          <div class="dbg-scroll"><div id="dbg-ael-list" class="dbg-list"></div></div>
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
    this._renderHistoryQueue();
    this._renderServer();
    this._updateBufHint();
  },

  _updateBufHint() {
    const el = document.getElementById('dbg-wave-buf-hint');
    if (!el) return;
    if (S.mode !== 'server' && S.mode !== 'standalone') {
      el.textContent = 'not connected';
    } else if (S.mode === 'server') {
      el.textContent = !S.lobby.hls
        ? 'native HLS playback — no hls.js to tap, so only the buffered ranges can be drawn'
        : this._hlsDecodeErr
          ? `couldn't decode HLS segments (${this._hlsDecodeErr}) — showing buffered ranges only`
          : 'HLS segments this browser has buffered, decoded for display · scrolls with the playhead';
    } else {
      el.textContent = 'PCM this browser has received · whole track, playhead = audio clock · next track appears once preloaded';
    }
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

  // Everything that has already finished playing, most recent at the top.
  // Standalone: S.history is oldest->newest, so it's flipped here. Lobby:
  // the server owns the history and already sends it newest-first (see
  // debug_snapshot's `history` field in server.py) — no client-side copy
  // exists otherwise, same situation as the Smart Queue pool above.
  _renderHistoryQueue() {
    const list = document.getElementById('dbg-hq-list');
    const count = document.getElementById('dbg-hq-count');
    if (!list) return;
    let items = [], total = 0;
    if (S.mode === 'standalone') {
      items = (S.history || []).slice().reverse().map(t => ({ title: t.info && t.info.title, author: t.info && t.info.author }));
      total = items.length;
    } else if (S.mode === 'server' && this.server && !this.server.error) {
      items = this.server.history || [];
      total = this.server.historyCount != null ? this.server.historyCount : items.length;
    }
    count.textContent = total ? `(${total})` : '';

    // render() runs ~3.5x/sec; skip the DOM rebuild when nothing changed so
    // a scroll position inside this card isn't fighting constant re-renders.
    const sig = (S.mode || '-') + '|' + total + '|' + items.map(t => (t.title || '') + '\u0001' + (t.author || '')).join('\u0002');
    if (list._sig === sig) return;
    list._sig = sig;

    if (!items.length) {
      list.innerHTML = `<div class="dbg-empty-row">${S.mode ? 'nothing has finished playing yet' : 'not connected'}</div>`;
      return;
    }
    list.innerHTML = items.map((t, i) => `
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
      ['Listeners (participants)', s.listeners],
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