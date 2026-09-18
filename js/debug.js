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
     - PCM chunks received / sent to speaker, buffer dropouts
       (standalone) → PCMPlayer.prototype.feed is wrapped. The original
       already decides "am I behind schedule" every call (that's the
       whole point of `nextTime` vs `ctx.currentTime`); this just reads
       that same math before/after calling through.
     - Audio element stalls/waits/playing (lobby)  → listeners attached
       straight to #lobby-audio.
     - Player action → time-to-audible latency  → Engine's public
       methods (playTrack/togglePause/skip/prev/stop/seekTo) are
       wrapped to open a "pending action"; it's closed by whichever
       instrumentation point below is the actual audible signal for that
       mode (a PCM feed(), an AudioContext resume(), or the <audio>
       'playing' event).
     - Server encode/pacing (lobby only)  → pushed over the lobby's
       existing Socket.IO connection while this tab is subscribed (see
       server.py's LobbyRelay.debug_subscribe / _debug_push_loop). No
       REST polling, and nothing runs server-side when no one is
       subscribed.
═══════════════════════════════════════════ */

const NET_CAP = 40, EVT_CAP = 30, LANE_CAP = 28;

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
  networkChunks: [],  // raw bytes arriving off the PCM stream (standalone)
  speakerChunks: [],  // bytes scheduled onto the AudioContext timeline
  nodelinkRequests: [], // backend → NodeLink calls, pushed live (lobby mode)

  server: null,       // last snapshot pushed over the socket by the server

  _initDone: false,
  _built: false,
  _running: false,
  _actionSeq: 0,
  _netSeq: 0,
  _pendingAction: null,
  _pendingTimeout: null,
  _renderTimer: null,

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
      const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      self.networkChunk(raw.length);

      let starvedMs = 0;
      if (this.ctx && this.startCtxTime !== null) {
        const need = this.ctx.currentTime + 0.02;
        if (need > this.nextTime + 0.005) starvedMs = (need - this.nextTime) * 1000;
      }
      const preNextTime = this.nextTime;

      const result = origFeed.call(this, bytes);

      if (this.nextTime > preNextTime) {
        self.speakerChunk(raw.length, (this.nextTime - preNextTime) * 1000);
      }
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
  networkChunk(bytes) { dbgPushCap(this.networkChunks, { ts: Date.now(), bytes }, LANE_CAP); },
  speakerChunk(bytes, durationMs) { dbgPushCap(this.speakerChunks, { ts: Date.now(), bytes, durationMs }, LANE_CAP); },
  dropout(gapMs, context) { dbgPushCap(this.dropouts, { ts: Date.now(), gapMs: Math.round(gapMs), context: context || '' }, EVT_CAP); },
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
  },
  stop() {
    this._running = false;
    this.unsubscribeSocket();
    clearInterval(this._renderTimer); this._renderTimer = null;
  },
  clear() {
    this.net = []; this.playerEvents = []; this.dropouts = [];
    this.audioElEvents = []; this.networkChunks = []; this.speakerChunks = [];
    this.nodelinkRequests = [];
    this.render();
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
          <span class="dbg-sub">live instrumentation — network · audio pipeline · player events</span>
          <button class="qa d" id="dbg-clear">Clear</button>
        </div>

        <div class="dbg-grid" id="dbg-cards"></div>

        <div class="dbg-section">
          <div class="dbg-section-title">Audio pipeline</div>
          <div class="dbg-lane-wrap">
            <span class="dbg-lane-lbl">Network → decode <span class="dbg-lane-hint">(box width ≈ chunk size)</span></span>
            <div class="dbg-lane" id="dbg-lane-net"></div>
          </div>
          <div class="dbg-lane-wrap">
            <span class="dbg-lane-lbl">Scheduled → speaker <span class="dbg-lane-hint">(box width ≈ audio duration)</span></span>
            <div class="dbg-lane" id="dbg-lane-spk"></div>
          </div>
          <div class="dbg-lane-wrap">
            <span class="dbg-lane-lbl">Output level</span>
            <div class="dbg-meter"><div class="dbg-meter-fill" id="dbg-meter-fill"></div></div>
          </div>
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
  },

  /* ───────── DOM: render (cheap, throttled to ~3.5fps by the caller) ───────── */
  render() {
    if (!this._built) return;
    this._renderCards();
    this._renderLane('dbg-lane-net', this.networkChunks, 'net');
    this._renderLane('dbg-lane-spk', this.speakerChunks, 'spk');
    this._renderMeter();
    this._renderNetTable();
    this._renderNodelinkTable();
    this._renderEvtTable();
    this._renderDrops();
    this._renderAel();
    this._renderServer();
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

  _renderLane(id, arr, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!arr.length) { el.innerHTML = `<span class="dbg-lane-empty">no chunks yet</span>`; return; }
    const items = arr.slice(0, LANE_CAP).slice().reverse();
    el.innerHTML = items.map(c => {
      const w = Math.max(6, Math.min(64, Math.round(6 + c.bytes / 120)));
      const title = `${c.bytes}B` + (c.durationMs ? ` · ${c.durationMs.toFixed(1)}ms audio` : '');
      return `<div class="dbg-box ${cls}" style="width:${w}px" title="${esc(title)}"></div>`;
    }).join('');
  },

  _renderMeter() {
    const fill = document.getElementById('dbg-meter-fill');
    if (!fill) return;
    let level = 0;
    if (S.player && typeof S.player.getLevels === 'function') {
      try { level = (S.player.getLevels()[0]) || 0; } catch (_) {}
    }
    fill.style.width = `${Math.min(100, Math.round(level * 140))}%`;
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