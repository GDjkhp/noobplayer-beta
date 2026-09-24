'use strict';
/* ═══════════════════════════════════════════
   Visualizer — write, share and run canvas visualizers.

   ── Why this is built differently from Skins ──
   A shared skin is CSS, which can be filtered into something reasonably
   safe. A shared visualizer is JavaScript, and there is no filter that
   makes someone else's JavaScript safe to run on your page — a blocklist
   of scary substrings is security theatre, and anyone who wants past it
   gets past it. So nothing here tries.

   Instead the code never runs on this page at all. Each visualizer runs
   inside an <iframe sandbox="allow-scripts"> with no allow-same-origin,
   which puts it in an opaque origin: it cannot read this document, our
   localStorage, cookies, the lobby token, or anything else of yours. On
   top of that the frame carries a Content-Security-Policy of
   `default-src 'none'`, so it cannot fetch, XHR, WebSocket, load fonts,
   or beacon anything out. It gets a canvas, and it gets audio numbers we
   post in. That's the whole world it can see.

   What that does NOT protect against, stated plainly:
     - A visualizer can be ugly, seizure-inducing, or deliberately awful
       to look at. Nothing technical stops bad taste or malice on screen.
     - A `while(true)` in someone's draw() can hang the tab, because
       browsers don't always give a sandboxed iframe its own thread. The
       watchdog below unloads a frame that stops responding, which
       recovers a *crashed* visualizer but not a *hung* one.
   Both are visible-and-obvious failures rather than silent data theft,
   which is the trade being made here.

   ── How a frame gets drawn ──
   Parent (this file) runs one rAF loop: pull the spectrum + waveform off
   whichever player is active (PCMPlayer or AudioElPlayer — they expose
   the same getSpectrum/getWaveform surface), postMessage it into the
   frame, done. The frame owns its own canvas and draws on receipt. No
   canvas transfer, no shared memory, no back-channel.
═══════════════════════════════════════════ */

const VIZ_LS_ACTIVE = 'nl_viz_active';
const VIZ_LS_LIBRARY = 'nl_vizzes';
const VIZ_LS_DRAFT = 'nl_viz_draft';

/* ───────── built-ins ─────────
   These double as templates: "Edit" on any of them drops the source into
   the editor. Kept deliberately short and readable rather than clever. */
const VIZ_BUILTINS = [
{
  name: 'Bars',
  author: 'Noobplayer',
  code: `// Classic spectrum bars.
function draw(ctx, v) {
  ctx.clearRect(0, 0, v.w, v.h);
  const bars = 64;
  const step = Math.floor(v.freq.length / bars);
  const bw = v.w / bars;
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += v.freq[i * step + j];
    const amp = (sum / step) / 255;
    const h = amp * v.h * 0.9;
    const grad = ctx.createLinearGradient(0, v.h, 0, v.h - h);
    grad.addColorStop(0, v.theme.accent);
    grad.addColorStop(1, v.theme.accent2);
    ctx.fillStyle = grad;
    ctx.fillRect(i * bw + 1, v.h - h, bw - 2, h);
  }
}`
},
{
  name: 'Oscilloscope',
  author: 'Noobplayer',
  code: `// Waveform trace with a soft afterglow.
function draw(ctx, v) {
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, v.w, v.h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = v.theme.accent;
  ctx.beginPath();
  for (let i = 0; i < v.wave.length; i++) {
    const x = (i / (v.wave.length - 1)) * v.w;
    const y = (v.wave[i] / 255) * v.h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}`
},
{
  name: 'Radial',
  author: 'Noobplayer',
  code: `// Spectrum spokes around a pulsing core.
function draw(ctx, v) {
  ctx.clearRect(0, 0, v.w, v.h);
  const cx = v.w / 2, cy = v.h / 2;
  const base = Math.min(v.w, v.h) * 0.16;
  const r = base * (1 + v.bass * 0.5);

  ctx.fillStyle = v.theme.accent2;
  ctx.globalAlpha = 0.25 + v.level * 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const spokes = 96;
  const step = Math.floor(v.freq.length / spokes) || 1;
  ctx.strokeStyle = v.theme.accent;
  ctx.lineWidth = 2;
  for (let i = 0; i < spokes; i++) {
    const amp = v.freq[i * step] / 255;
    const a = (i / spokes) * Math.PI * 2 + v.t * 0.15;
    const len = r + amp * Math.min(v.w, v.h) * 0.3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }
}`
},
{
  name: 'Starfield',
  author: 'Noobplayer',
  code: `// Stars that accelerate with the bass. setup() runs once.
let stars = [];
function setup(ctx, v) {
  stars = Array.from({ length: 260 }, () => ({
    x: (Math.random() - 0.5) * 2,
    y: (Math.random() - 0.5) * 2,
    z: Math.random(),
  }));
}
function draw(ctx, v) {
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, v.w, v.h);
  const cx = v.w / 2, cy = v.h / 2;
  const speed = (0.06 + v.bass * 0.55) * v.dt * 60;
  ctx.fillStyle = v.theme.text;
  for (const s of stars) {
    s.z -= speed * 0.01;
    if (s.z <= 0.02) { s.z = 1; s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; }
    const k = 0.5 / s.z;
    const x = cx + s.x * k * v.w;
    const y = cy + s.y * k * v.h;
    if (x < 0 || x > v.w || y < 0 || y > v.h) continue;
    const size = Math.max(0.5, (1 - s.z) * 2.6);
    ctx.globalAlpha = Math.min(1, 1 - s.z + v.level * 0.4);
    ctx.fillRect(x, y, size, size);
  }
  ctx.globalAlpha = 1;
}`
},
];

const VIZ_TEMPLATE = `// draw() runs once per animation frame.
//   v.freq  Uint8Array  spectrum, 0-255 per bin (low -> high)
//   v.wave  Uint8Array  waveform, 128 = silence
//   v.level v.bass v.mid v.treble   0-1
//   v.t  seconds playing   v.dt  seconds since last frame
//   v.w  v.h  canvas size    v.paused
//   v.track {title, author, length} or null
//   v.theme {bg, surf, text, accent, accent2, ...} from your active skin
// Optional: define setup(ctx, v) to run once before the first frame.

function draw(ctx, v) {
  ctx.clearRect(0, 0, v.w, v.h);
  ctx.fillStyle = v.theme.accent;
  const r = 20 + v.level * 120;
  ctx.beginPath();
  ctx.arc(v.w / 2, v.h / 2, r, 0, Math.PI * 2);
  ctx.fill();
}`;

const Viz = {
  _frame: null,        // the sandboxed <iframe>
  _raf: null,
  _running: false,
  _ready: false,
  _lastAck: 0,
  _lastFrameTime: 0,
  _errCount: 0,
  _specBuf: null,
  _waveBuf: null,
  _startedAt: 0,

  // Resource-saving recovery (see _beginProbe / _autoRefresh below).
  _tick: null,         // the rAF callback, kept so it can be re-armed after a suspend
  _lastPump: 0,        // when _pump last actually ran to completion of its visibility checks
  _away: false,        // true while the stage wasn't being drawn (tab hidden, other tab open, scrolled off-screen)
  _probing: false,     // just came back — the frame must prove it's alive quickly or it gets refreshed
  _inView: true,       // IntersectionObserver result for #viz-stage
  _io: null,
  _refreshLog: [],     // timestamps of recent auto-refreshes, to stop a genuinely broken visualizer looping forever

  /* ═══════════════ lifecycle ═══════════════ */

  init() {
    this.loadLibrary();
    try {
      const raw = localStorage.getItem(VIZ_LS_DRAFT);
      S.viz.draft = raw ? this.normalize(JSON.parse(raw)) : this.normalize({ name: '', code: VIZ_TEMPLATE });
    } catch (_) { S.viz.draft = this.normalize({ name: '', code: VIZ_TEMPLATE }); }

    try {
      const raw = localStorage.getItem(VIZ_LS_ACTIVE);
      if (raw) S.viz.active = this.normalize(JSON.parse(raw));
    } catch (_) { localStorage.removeItem(VIZ_LS_ACTIVE); }
    if (!S.viz.active) S.viz.active = this.normalize(VIZ_BUILTINS[0]);

    window.addEventListener('message', e => this._onFrameMessage(e));

    // Browsers stop rAF and freeze/throttle background and off-screen frames
    // to save power, and none of that is visible to us as an "error". The
    // watchdog used to read the resulting silence as a crash and unload the
    // visualizer for good. These hooks tell it "we were away, not dead" and
    // make it re-check the frame instead — refreshing it if it really did
    // get stuck.
    this._tick = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._tick);
      this._pump();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._away = true;
      else this._resumed();
    });
    window.addEventListener('pageshow', () => this._resumed());   // bfcache restore
    document.addEventListener('resume', () => this._resumed());   // Page Lifecycle: tab un-frozen
    window.addEventListener('online', () => this._resumed());
  },

  normalize(v) {
    v = v || {};
    return {
      _id: v._id || v.id || null,
      _editToken: v._editToken || v.editToken || null,
      name: String(v.name || 'Untitled Visualizer').slice(0, 40),
      author: String(v.author || '').slice(0, 24),
      code: String(v.code || VIZ_TEMPLATE).slice(0, 20000),
    };
  },

  serialize(v) {
    const n = this.normalize(v);
    return { name: n.name, author: n.author, code: n.code };
  },

  /* ═══════════════ the sandbox ═══════════════ */

  // Built fresh for every visualizer rather than reusing one frame and
  // swapping code: a new frame means a clean global scope, so one
  // visualizer's leftover timers and globals can't bleed into the next.
  _buildSrcdoc(code) {
    // The frame is an opaque origin with no network, so the user code
    // can't reach anything — this escape only stops a stray "</script>"
    // in a comment from ending the block early and breaking the page.
    const safe = String(code).replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}
canvas{display:block;width:100%;height:100%}</style>
</head><body><canvas id="c"></canvas>
<script>${safe}<\/script>
<script>
(function(){
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var didSetup = false, errs = 0, dead = false, n = 0, lastAck = 0;

  function resize(w, h) {
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fail(e) {
    errs++;
    parent.postMessage({ type: 'viz-error', message: String(e && e.message || e), fatal: errs >= 5 }, '*');
    // Five throws in a row means it's broken, not unlucky. Stop calling
    // it so the console isn't a waterfall of the same error at 60fps.
    if (errs >= 5) dead = true;
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'viz-frame' || dead) return;
    n++;
    // Ack about once a second regardless of frame rate (a heavy visualizer
    // at 5fps would otherwise look dead), and straight away when the parent
    // is probing after the tab/frame was suspended.
    var nowT = performance.now();
    if (d.probe || nowT - lastAck > 1000) { lastAck = nowT; parent.postMessage({ type: 'viz-ack', n: n }, '*'); }
    if (canvas.width !== Math.round(d.w * dpr) || canvas.height !== Math.round(d.h * dpr)) resize(d.w, d.h);
    try {
      if (!didSetup) {
        didSetup = true;
        if (typeof setup === 'function') setup(ctx, d);
      }
      if (typeof draw !== 'function') { fail(new Error('No draw(ctx, v) function defined')); return; }
      draw(ctx, d);
      errs = 0;
    } catch (e) { fail(e); }
  });

  window.onerror = function (msg) { fail(new Error(msg)); return true; };
  parent.postMessage({ type: 'viz-ready' }, '*');
})();
<\/script></body></html>`;
  },

  mount(visualizer) {
    const stage = document.getElementById('viz-stage');
    if (!stage) return;
    const v = this.normalize(visualizer || S.viz.active);
    S.viz.active = v;
    try { localStorage.setItem(VIZ_LS_ACTIVE, JSON.stringify(v)); } catch (_) {}

    this.unmount();
    this._setError('');

    const frame = document.createElement('iframe');
    // No allow-same-origin: that's the whole isolation guarantee. Adding
    // it alongside allow-scripts would let the frame reach back into this
    // document and remove the sandbox itself.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'viz-frame';
    frame.srcdoc = this._buildSrcdoc(v.code);
    stage.appendChild(frame);

    this._frame = frame;
    this._ready = false;
    this._errCount = 0;
    this._startedAt = performance.now();
    this._lastAck = performance.now();
    this._lastFrameTime = performance.now();
    this._lastPump = performance.now();
    this._observeStage(stage);
    this.start();
    // A brand-new frame has nothing to "come back" from — clear the flags
    // start() sets for the resume-from-idle case.
    this._away = false;
    this._probing = false;
    this._renderActiveLabel();
  },

  unmount() {
    this.stop();
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._frame) { this._frame.remove(); this._frame = null; }
    this._ready = false;
    this._probing = false;
  },

  // Off-screen stages aren't worth drawing (and browsers deprioritise
  // off-screen frames anyway), so pause pumping while the stage is scrolled
  // out of view — coming back into view counts as a resume.
  _observeStage(stage) {
    if (this._io) { this._io.disconnect(); this._io = null; }
    this._inView = true;
    if (!('IntersectionObserver' in window)) return;
    this._io = new IntersectionObserver(entries => {
      const vis = entries[entries.length - 1].isIntersecting;
      if (vis && !this._inView) this._resumed();
      this._inView = vis;
    });
    this._io.observe(stage);
  },

  // We were away (hidden / suspended / frozen / off-screen). Whatever the
  // watchdog measured while away doesn't count against the frame — but the
  // frame now has to answer quickly, or it's refreshed (see _pump).
  _beginProbe(now) {
    this._lastAck = now;
    this._lastFrameTime = now;
    this._probing = true;
  },

  _resumed() {
    if (!this._frame) return;
    this._away = true;            // next _pump() will _beginProbe
    // Some browsers don't restart a rAF loop cleanly after a suspend — re-arm it.
    if (this._running && this._tick) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(this._tick);
    }
  },

  // Rebuild the frame from scratch — same as pressing Run, minus the click.
  // Capped so a visualizer that's actually broken (or hangs on frame one)
  // can't refresh-loop forever: 3 refreshes in 30s and it's unloaded with
  // the error shown instead.
  _autoRefresh(why) {
    const now = performance.now();
    this._refreshLog = this._refreshLog.filter(t => now - t < 30000);
    if (this._refreshLog.length >= 3) {
      this._setError('Visualizer keeps stopping responding — unloaded it. Press Run to try again.');
      this.unmount();
      return;
    }
    this._refreshLog.push(now);
    console.info('[viz] auto-refreshing visualizer:', why);
    this.mount(S.viz.active);
  },

  _onFrameMessage(e) {
    // Only trust messages from our own frame's window object. The frame is
    // opaque-origin so e.origin is "null", which is not something to match
    // on — the source check is what actually identifies it.
    if (!this._frame || e.source !== this._frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === 'viz-ready') { this._ready = true; this._probing = false; this._lastAck = performance.now(); }
    else if (d.type === 'viz-ack') { this._probing = false; this._lastAck = performance.now(); }
    else if (d.type === 'viz-error') {
      this._setError(d.fatal
        ? `${d.message} — stopped after repeated errors`
        : d.message);
    }
  },

  /* ═══════════════ the frame pump ═══════════════ */

  start() {
    if (this._running) return;
    this._running = true;
    // Coming back to the tab after stop() (see main.js) — the frame has been
    // idle the whole time, so don't let that idle time trip the watchdog.
    if (this._frame) this._away = true;
    this._raf = requestAnimationFrame(this._tick);
  },

  stop() {
    this._running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  },

  _pump() {
    const frame = this._frame;
    if (!frame || !frame.contentWindow) return;
    const stage = document.getElementById('viz-stage');
    // Not being looked at: tab hidden, another tab open, or stage scrolled
    // off-screen. (getClientRects rather than offsetParent: a fullscreen
    // stage is position:fixed, which makes offsetParent null even though
    // it's plainly visible.)
    if (document.hidden || !stage || !stage.getClientRects().length || !this._inView) {
      this._away = true;
      return;
    }

    const now = performance.now();

    // Just came back from being away, or the loop itself was starved
    // (rAF throttled to a crawl): forgive the silence, then require an
    // answer from the frame within a couple of seconds.
    if (this._away || now - this._lastPump > 1500) {
      this._away = false;
      this._beginProbe(now);
    }
    this._lastPump = now;

    // Watchdog. A visualizer that stopped acking has either crashed hard
    // or is stuck in a loop, or the browser froze its frame to save
    // resources. Rather than leave a dead picture on screen (or unload it
    // for good), rebuild the frame — see _autoRefresh for the loop guard.
    if (now - this._lastAck > (this._probing ? 2500 : 5000)) {
      this._autoRefresh(this._ready ? 'no ack from frame' : 'frame never became ready');
      return;
    }
    if (!this._ready) return;   // still loading — nothing to draw into yet

    const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
    this._lastFrameTime = now;

    const player = S.player;
    this._specBuf = player?.getSpectrum ? player.getSpectrum(this._specBuf) : this._specBuf;
    this._waveBuf = player?.getWaveform ? player.getWaveform(this._waveBuf) : this._waveBuf;
    const freq = this._specBuf || new Uint8Array(256);
    const wave = this._waveBuf || new Uint8Array(512).fill(128);

    const rect = stage.getBoundingClientRect();
    const t = S.current;

    frame.contentWindow.postMessage({
      type: 'viz-frame',
      probe: this._probing,
      freq, wave,
      level: player?.getLevels ? Math.min(1, player.getLevels()[0]) : 0,
      bass: this._band(freq, 0, 0.12),
      mid: this._band(freq, 0.12, 0.45),
      treble: this._band(freq, 0.45, 1),
      t: (now - this._startedAt) / 1000,
      dt,
      w: Math.max(1, Math.round(rect.width)),
      h: Math.max(1, Math.round(rect.height)),
      paused: !player || player.isPaused,
      positionMs: player?.getPositionMs ? player.getPositionMs() : 0,
      track: t ? { title: t.info.title, author: t.info.author, length: t.info.length } : null,
      theme: this._theme(),
    }, '*');
  },

  _band(freq, from, to) {
    const a = Math.floor(freq.length * from), b = Math.max(a + 1, Math.floor(freq.length * to));
    let sum = 0;
    for (let i = a; i < b; i++) sum += freq[i];
    return (sum / (b - a)) / 255;
  },

  // Handed to every visualizer so they can match the active skin instead
  // of hardcoding colours that clash with whatever the user picked.
  _theme() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const k of ['bg','surf','surf2','surf3','brd','brd2','text','muted','accent','accent2','green','red','amber','pink']) {
      out[k] = (cs.getPropertyValue('--' + k) || '').trim() || '#888';
    }
    return out;
  },

  _setError(msg) {
    const el = document.getElementById('viz-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
  },

  _renderActiveLabel() {
    const el = document.getElementById('viz-active-name');
    if (el) el.textContent = S.viz.active ? S.viz.active.name : '—';
  },

  toggleFullscreen() {
    const stage = document.getElementById('viz-stage');
    if (!document.fullscreenElement) stage?.requestFullscreen?.().catch(() => toast('Fullscreen was refused', 'warn'));
    else document.exitFullscreen?.();
  },

  /* ═══════════════ library ═══════════════ */

  loadLibrary() {
    try {
      const raw = localStorage.getItem(VIZ_LS_LIBRARY);
      S.viz.mine = raw ? JSON.parse(raw).map(v => this.normalize(v)) : [];
    } catch (_) { S.viz.mine = []; }
  },

  saveLibrary() {
    try { localStorage.setItem(VIZ_LS_LIBRARY, JSON.stringify(S.viz.mine)); }
    catch (_) { toast('Browser storage is full — could not save', 'error'); }
  },

  saveDraft() {
    try { localStorage.setItem(VIZ_LS_DRAFT, JSON.stringify(S.viz.draft)); } catch (_) {}
  },

  saveCurrent() {
    const d = this.normalize(S.viz.draft);
    if (!d.name || d.name === 'Untitled Visualizer') {
      const name = prompt('Name this visualizer:', 'My Visualizer');
      if (!name) return;
      d.name = name.slice(0, 40);
      document.getElementById('viz-name').value = d.name;
    }
    const idx = S.viz.mine.findIndex(v => v.name === d.name);
    if (idx >= 0) S.viz.mine[idx] = d; else S.viz.mine.push(d);
    S.viz.draft = d;
    this.saveLibrary(); this.saveDraft(); this.renderMine();
    toast(`Saved "${d.name}"`, 'success', 2000);
  },

  deleteLocal(name) {
    S.viz.mine = S.viz.mine.filter(v => v.name !== name);
    this.saveLibrary(); this.renderMine();
  },

  runDraft() {
    S.viz.draft = this.normalize(S.viz.draft);
    this.saveDraft();
    this.mount(S.viz.draft);
    this._switchVizTab('stage');
  },

  /* ═══════════════ gallery ═══════════════ */

  async publish() {
    if (!VizAPI.available()) { toast('No server configured — publishing needs one', 'warn'); return; }
    const d = this.normalize(S.viz.draft);
    if (!d.author) {
      const who = prompt('Publish as:', localStorage.getItem('nl_display_name') || 'Anonymous');
      if (!who) return;
      d.author = who.slice(0, 24);
      document.getElementById('viz-author').value = d.author;
    }
    const existing = S.viz.mine.find(v => v.name === d.name && v._id);
    try {
      const r = await VizAPI.publish(this.serialize(d), existing?._id, existing?._editToken);
      d._id = r.id; d._editToken = r.editToken;
      const idx = S.viz.mine.findIndex(v => v.name === d.name);
      if (idx >= 0) S.viz.mine[idx] = d; else S.viz.mine.push(d);
      S.viz.draft = d;
      this.saveLibrary(); this.saveDraft(); this.renderMine();
      toast(existing ? 'Gallery entry updated' : 'Published to the gallery', 'success', 2500);
    } catch (e) { toast(`Publish failed: ${e.message}`, 'error', 5000); }
  },

  async unpublish(name) {
    const v = S.viz.mine.find(x => x.name === name);
    if (!v?._id || !v._editToken) { toast('That was never published from this browser', 'warn'); return; }
    try {
      await VizAPI.remove(v._id, v._editToken);
      v._id = null; v._editToken = null;
      this.saveLibrary(); this.renderMine();
      toast('Removed from the gallery', 'info', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  async refreshGallery(sort) {
    if (sort) S.viz.gallerySort = sort;
    const el = document.getElementById('viz-gallery');
    if (!el) return;
    if (!VizAPI.available()) {
      el.innerHTML = `<div class="empty small"><p>No server configured — the gallery needs one</p></div>`;
      return;
    }
    el.innerHTML = `<div class="empty small"><div class="dots"><span></span><span></span><span></span></div></div>`;
    try {
      S.viz.gallery = await VizAPI.list(S.viz.gallerySort);
      this.renderGallery();
    } catch (e) {
      el.innerHTML = `<div class="empty small"><p>Could not load gallery: ${esc(e.message)}</p></div>`;
    }
  },

  async useFromGallery(id, { editToo = false } = {}) {
    try {
      const full = await VizAPI.get(id);
      const v = this.normalize({ ...full, _id: null, _editToken: null });
      this.mount(v);
      VizAPI.countInstall(id);
      if (editToo) {
        S.viz.draft = v; this.saveDraft(); this.renderEditor(); this._switchVizTab('editor');
      } else {
        this._switchVizTab('stage');
      }
      toast(`Running "${v.name}"`, 'success', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  async saveFromGallery(id) {
    try {
      const full = await VizAPI.get(id);
      const v = this.normalize({ ...full, _id: null, _editToken: null });
      if (S.viz.mine.some(x => x.name === v.name)) v.name = `${v.name} (copy)`.slice(0, 40);
      S.viz.mine.push(v);
      this.saveLibrary(); this.renderMine();
      VizAPI.countInstall(id);
      toast(`Saved "${v.name}"`, 'success', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  /* ═══════════════ import / export ═══════════════ */

  exportDraft() {
    const blob = new Blob([JSON.stringify(this.serialize(S.viz.draft), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(S.viz.draft.name || 'visualizer').replace(/[^\w.-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  importViz() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json,.js';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result);
          // Accept either a full exported visualizer or a bare .js file.
          const v = this.normalize(file.name.endsWith('.js')
            ? { name: file.name.replace(/\.js$/, ''), code: text }
            : JSON.parse(text));
          S.viz.draft = v;
          this.saveDraft(); this.renderEditor();
          toast(`Loaded "${v.name}"`, 'success', 2000);
        } catch (_) { toast('That file is not a valid visualizer', 'error'); }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  /* ═══════════════ rendering ═══════════════ */

  renderTab() {
    this.renderEditor();
    this.renderMine();
    if (!this._frame) this.mount(S.viz.active);
    else this.start();
    this._renderActiveLabel();
    if (!S.viz.gallery.length) this.refreshGallery();
  },

  _switchVizTab(name) {
    document.querySelectorAll('.viz-tab').forEach(t => t.classList.toggle('on', t.dataset.vtab === name));
    document.querySelectorAll('.viz-pane').forEach(p => p.classList.toggle('on', p.id === 'vtab-' + name));
    if (name === 'browse' && !S.viz.gallery.length) this.refreshGallery();
  },

  renderEditor() {
    const d = S.viz.draft = this.normalize(S.viz.draft);
    const name = document.getElementById('viz-name');
    const author = document.getElementById('viz-author');
    const code = document.getElementById('viz-code');
    if (!name) return;

    name.value = d.name === 'Untitled Visualizer' ? '' : d.name;
    author.value = d.author || '';
    if (document.activeElement !== code) code.value = d.code;

    name.oninput = () => { d.name = name.value.trim() || 'Untitled Visualizer'; this.saveDraft(); };
    author.oninput = () => { d.author = author.value.trim(); this.saveDraft(); };
    code.oninput = () => { d.code = code.value; this.saveDraft(); };
    // Tab should indent, not escape the textarea — this is a code editor.
    code.onkeydown = (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = code.selectionStart, en = code.selectionEnd;
      code.value = code.value.slice(0, s) + '  ' + code.value.slice(en);
      code.selectionStart = code.selectionEnd = s + 2;
      d.code = code.value; this.saveDraft();
    };

    const tpl = document.getElementById('viz-templates');
    if (tpl && !tpl.dataset.wired) {
      tpl.innerHTML = VIZ_BUILTINS.map(b =>
        `<button class="preset-btn" data-vtpl="${esc(b.name)}">${esc(b.name)}</button>`).join('') +
        `<button class="preset-btn" data-vtpl="__blank">Blank</button>`;
      tpl.querySelectorAll('[data-vtpl]').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.vtpl;
        const src = key === '__blank'
          ? { name: '', author: d.author, code: VIZ_TEMPLATE }
          : { ...VIZ_BUILTINS.find(b => b.name === key), author: d.author };
        S.viz.draft = this.normalize(src);
        this.renderEditor();
      }));
      tpl.dataset.wired = '1';
    }
  },

  _cardActs(v, kind) {
    return `<div class="viz-card-acts">
      <button class="add-btn pnow" data-va="use">Use</button>
      <button class="add-btn" data-va="edit">Edit</button>
      ${kind === 'mine' && v._id ? '<button class="add-btn" data-va="unpublish">Unpublish</button>' : ''}
      ${kind === 'mine' ? '<button class="add-btn" data-va="del">✕</button>' : '<button class="add-btn" data-va="save">Save</button>'}
    </div>`;
  },

  renderMine() {
    const el = document.getElementById('viz-mine-list');
    if (!el) return;
    const countEl = document.getElementById('viz-mine-count');
    if (countEl) countEl.textContent = S.viz.mine.length ? `(${S.viz.mine.length})` : '';

    const builtins = VIZ_BUILTINS.map(b => this.normalize(b));
    const rows = [
      ...builtins.map(v => ({ v, builtin: true })),
      ...S.viz.mine.map(v => ({ v, builtin: false })),
    ];

    el.innerHTML = rows.map(({ v, builtin }) => `
      <div class="viz-card" data-name="${esc(v.name)}" data-builtin="${builtin}">
        <div class="viz-card-meta">
          <div class="viz-card-name">${esc(v.name)}
            ${builtin ? '<span class="skin-badge">BUILT-IN</span>' : ''}
            ${v._id ? '<span class="skin-badge pub">PUBLISHED</span>' : ''}</div>
          <div class="viz-card-author">${esc(v.author || 'no author')} · ${v.code.split('\n').length} lines</div>
        </div>
        <div class="viz-card-acts">
          <button class="add-btn pnow" data-va="use">Use</button>
          <button class="add-btn" data-va="edit">Edit</button>
          ${!builtin && v._id ? '<button class="add-btn" data-va="unpublish">Unpublish</button>' : ''}
          ${!builtin ? '<button class="add-btn" data-va="del">✕</button>' : ''}
        </div>
      </div>`).join('');

    el.querySelectorAll('.viz-card').forEach(card => {
      const isBuiltin = card.dataset.builtin === 'true';
      const name = card.dataset.name;
      const find = () => (isBuiltin ? builtins : S.viz.mine).find(v => v.name === name);
      card.querySelectorAll('[data-va]').forEach(btn => btn.addEventListener('click', () => {
        const v = find();
        if (!v) return;
        switch (btn.dataset.va) {
          case 'use': this.mount(v); this._switchVizTab('stage'); toast(`Running "${v.name}"`, 'success', 1500); break;
          case 'edit':
            S.viz.draft = this.normalize({ ...v, _id: null, _editToken: null,
              name: isBuiltin ? `${v.name} (copy)` : v.name });
            this.saveDraft(); this.renderEditor(); this._switchVizTab('editor');
            break;
          case 'unpublish': this.unpublish(name); break;
          case 'del': if (confirm(`Delete "${name}" from this browser?`)) this.deleteLocal(name); break;
        }
      }));
    });
  },

  renderGallery() {
    const el = document.getElementById('viz-gallery');
    if (!el) return;
    const list = S.viz.gallery || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty small"><p>Nothing published yet — be the first</p></div>`;
      return;
    }
    el.innerHTML = list.map(v => `
      <div class="viz-card" data-id="${esc(v.id)}">
        <div class="viz-card-meta">
          <div class="viz-card-name">${esc(v.name)}</div>
          <div class="viz-card-author">by ${esc(v.author || 'Anonymous')} · ${v.lines || '?'} lines · ${v.installs || 0} uses</div>
        </div>
        <div class="viz-card-acts">
          <button class="add-btn pnow" data-ga="use">Use</button>
          <button class="add-btn" data-ga="fork">Edit</button>
          <button class="add-btn" data-ga="save">Save</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.viz-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-ga]').forEach(btn => btn.addEventListener('click', () => {
        if (btn.dataset.ga === 'use') this.useFromGallery(id);
        else if (btn.dataset.ga === 'fork') this.useFromGallery(id, { editToo: true });
        else this.saveFromGallery(id);
      }));
    });
  },
};