'use strict';
/* ═══════════════════════════════════════════
   Pad — game controller support (Gamepad API).

   Works with anything the browser maps to the "standard" gamepad layout:
   Xbox, PlayStation (DualShock/DualSense), Switch Pro, Steam, 8BitDo,
   generic XInput pads, etc. The header badge shows what kind of
   controller is connected (see detect() — vendor id first, then name).

   Default layout (standard mapping; face buttons named Xbox / PlayStation):
     A / ✕            Play / Pause
     B / ○            Cycle loop
     X / □            Shuffle queue
     Y / △            Cycle autoplay
     LB / L1, RB / R1 Previous / Next
     D-pad or L-stick ←→  Seek -/+5s (hold to repeat)
     D-pad or L-stick ↑↓  Volume +/-5 (hold to repeat)
     LT / L2, RT / R2 Previous / next tab
     Menu / Options   Queue tab
     View / Share     Lyrics tab

   Everything goes through the same Engine calls as the on-screen
   buttons and keyboard shortcuts, so lobby permissions (host / DJ only)
   are enforced exactly as they are for a click.

   Browsers only expose a pad after its first button press on the page,
   and only poll it while the tab is focused — that's why "connected"
   may not show until you press something.
═══════════════════════════════════════════ */
const Pad = {
  RAMP_DELAY: 400,     // ms a held repeatable button waits before repeating
  STICK_TH: 0.6,       // left-stick deflection that counts as a d-pad press

  pads: {},            // index -> { prev:[bool], next:[ms], type, label, id, mapping }
  activeIdx: null,     // pad that last had input — the one the badge describes
  _raf: null,
  _seekAcc: null,      // { t, pos } — accumulates held-seek so repeats don't re-read a stale position

  /* ───────── controller identification ───────── */
  detect(id) {
    id = String(id || '');
    const lower = id.toLowerCase();
    // Chrome: "... (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"
    // Firefox: "54c-9cc-Wireless Controller" (leading zeros dropped)
    let vendor = null;
    let m = lower.match(/vendor:\s*([0-9a-f]{4})/);
    if (m) vendor = m[1];
    else if ((m = lower.match(/^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/))) vendor = m[1].padStart(4, '0');

    if (vendor === '045e' || /xbox|xinput|x-box/.test(lower)) return { type: 'xbox', label: 'Xbox' };
    if (vendor === '054c' || /dualshock|dualsense|playstation|\bps[2345]\b|sony/.test(lower)) return { type: 'playstation', label: 'PlayStation' };
    if (vendor === '057e' || /nintendo|joy-?con|pro controller/.test(lower)) return { type: 'nintendo', label: 'Switch' };
    if (vendor === '28de' || /steam/.test(lower)) return { type: 'generic', label: 'Steam' };
    if (vendor === '2dc8' || /8bitdo/.test(lower)) return { type: 'generic', label: '8BitDo' };
    if (/stadia/.test(lower)) return { type: 'generic', label: 'Stadia' };
    return { type: 'generic', label: 'Gamepad' };
  },

  // Names for the standard-mapping buttons, per controller family.
  _names(type) {
    if (type === 'playstation') return { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', start: 'Options', back: 'Share' };
    if (type === 'nintendo')    return { a: 'B', b: 'A', x: 'Y', y: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', start: '+', back: '−' };
    return { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', start: 'Menu', back: 'View' };
  },

  _tooltip(p) {
    const n = this._names(p.type);
    const lines = [
      `${p.label} controller connected`,
      `${n.a} Play/Pause · ${n.b} Loop · ${n.x} Shuffle · ${n.y} Autoplay`,
      `${n.lb}/${n.rb} Prev/Next · D-pad ←→ Seek, ↑↓ Volume`,
      `${n.lt}/${n.rt} Switch tab · ${n.start} Queue · ${n.back} Lyrics`,
    ];
    if (p.mapping !== 'standard') lines.push('⚠ Non-standard layout — buttons may not match the above');
    lines.push(p.id);
    return lines.join('\n');
  },

  _icon(type) {
    const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    if (type === 'xbox') return svg('<circle cx="12" cy="12" r="9.5"/><path d="M8 8l8 8M16 8l-8 8"/>');
    if (type === 'playstation') return svg('<path d="M12 1.8l3.2 5.4H8.8z"/><circle cx="19.5" cy="12" r="2.8"/><path d="M9.6 17.1l4.8 4.8M14.4 17.1l-4.8 4.8"/><rect x="2" y="9.5" width="5" height="5"/>');
    if (type === 'nintendo') return svg('<rect x="3" y="3" width="7" height="18" rx="3.5"/><rect x="14" y="3" width="7" height="18" rx="3.5"/><circle cx="6.5" cy="8" r="1" fill="currentColor"/><circle cx="17.5" cy="16" r="1" fill="currentColor"/>');
    return '<span class="material-symbols-outlined">sports_esports</span>';
  },

  /* ───────── badge ───────── */
  // Both headers (standalone / lobby) carry a .pad-badge; only one is
  // visible at a time, so just keep them all in sync.
  _renderBadge() {
    const badges = document.querySelectorAll('.pad-badge');
    const p = this.pads[this.activeIdx];
    badges.forEach((el) => {
      if (!p) { el.style.display = 'none'; el.innerHTML = ''; el.removeAttribute('title'); return; }
      el.style.display = 'inline-flex';
      el.dataset.type = p.type;
      el.title = this._tooltip(p);
      el.innerHTML = `${this._icon(p.type)}<span class="pad-lbl">${esc(p.label)}</span>`;
    });
  },

  _flash() {
    document.querySelectorAll('.pad-badge').forEach((el) => {
      el.classList.add('hit');
      clearTimeout(el._hitT);
      el._hitT = setTimeout(() => el.classList.remove('hit'), 140);
    });
  },

  /* ───────── connect / disconnect ───────── */
  _add(gp) {
    if (!gp || this.pads[gp.index]) return;
    const d = this.detect(gp.id);
    this.pads[gp.index] = { prev: [], next: [], type: d.type, label: d.label, id: gp.id, mapping: gp.mapping };
    this.activeIdx = gp.index;
    this._renderBadge();
    toast(`${d.label} controller connected`, 'success', 2200);
    this._start();
  },

  _remove(index) {
    const p = this.pads[index];
    if (!p) return;
    delete this.pads[index];
    const rest = Object.keys(this.pads);
    if (this.activeIdx === index) this.activeIdx = rest.length ? Number(rest[0]) : null;
    this._renderBadge();
    toast(`${p.label} controller disconnected`, 'warn', 2200);
    if (!rest.length) this._stop();
  },

  /* ───────── polling ───────── */
  _start() { if (this._raf === null) this._raf = requestAnimationFrame((t) => this._tick(t)); },
  _stop()  { if (this._raf !== null) { cancelAnimationFrame(this._raf); this._raf = null; } },

  _tick(ts) {
    this._raf = null;
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of list) {
      if (!gp || !gp.connected) continue;
      if (!this.pads[gp.index]) this._add(gp);   // pad that showed up without an event
      this._process(gp, ts);
    }
    if (Object.keys(this.pads).length) this._start();
  },

  // Buttons that fire an action, and whether holding them repeats (ms).
  BINDINGS: {
    0:  { run: () => Engine.togglePause() },
    1:  { run: () => Engine.cycleLoop() },
    2:  { run: () => Engine.shuffleQueue() },
    3:  { run: () => Engine.cycleAutoplay() },
    4:  { run: () => Engine.prev() },
    5:  { run: () => Engine.skip() },
    6:  { run: () => Pad._tab(-1) },
    7:  { run: () => Pad._tab(+1) },
    8:  { run: () => Pad._openTab('lyrics') },
    9:  { run: () => Pad._openTab('queue') },
    12: { run: () => Pad._volume(+5), repeat: 110 },
    13: { run: () => Pad._volume(-5), repeat: 110 },
    14: { run: (ts) => Pad._seek(-5000, ts), repeat: 300 },
    15: { run: (ts) => Pad._seek(+5000, ts), repeat: 300 },
  },

  _process(gp, ts) {
    const p = this.pads[gp.index];
    const down = [];
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      down[i] = !!(b && (b.pressed || b.value > 0.5));
    }
    // Left stick doubles as a d-pad.
    const ax = gp.axes || [];
    const th = this.STICK_TH;
    if ((ax[1] || 0) < -th) down[12] = true;
    if ((ax[1] || 0) >  th) down[13] = true;
    if ((ax[0] || 0) < -th) down[14] = true;
    if ((ax[0] || 0) >  th) down[15] = true;

    let any = false;
    for (const key of Object.keys(this.BINDINGS)) {
      const i = Number(key);
      const bind = this.BINDINGS[i];
      if (down[i]) {
        any = true;
        if (!p.prev[i]) {                       // fresh press
          p.next[i] = ts + this.RAMP_DELAY;
          this._fire(bind, ts);
        } else if (bind.repeat && ts >= p.next[i]) {   // held
          p.next[i] = ts + bind.repeat;
          this._fire(bind, ts);
        }
      }
    }
    for (let i = 0; i < down.length; i++) if (down[i]) any = true;
    p.prev = down;

    if (any) {
      if (this.activeIdx !== gp.index) { this.activeIdx = gp.index; this._renderBadge(); }
      this._flash();
    }
  },

  _fire(bind, ts) {
    try { Promise.resolve(bind.run(ts)).catch(() => {}); } catch (_) {}
  },

  /* ───────── actions ───────── */
  _volume(delta) {
    const sl = document.getElementById('vol-sl');
    if (!sl) return;
    sl.value = Math.max(0, Math.min(100, parseInt(sl.value, 10) + delta));
    sl.dispatchEvent(new Event('input'));
  },

  _seek(delta, ts) {
    const cur = S.player ? S.player.getPositionMs() : 0;
    // While a direction is held, build on the last target rather than the
    // player's position (a seek in flight hasn't landed yet).
    const acc = this._seekAcc;
    const base = (acc && ts - acc.t < 700) ? acc.pos : cur;
    const pos = Math.max(0, base + delta);
    this._seekAcc = { t: ts, pos };
    return Engine.seekTo(pos);
  },

  // Clicks the real tab button so all the per-tab setup in main.js
  // (skins render, visualizer start/stop, chat badge…) runs as usual.
  _tabs() {
    return [...document.querySelectorAll('.tab')].filter((b) => b.offsetParent !== null);
  },
  _tab(dir) {
    const tabs = this._tabs();
    if (!tabs.length) return;
    let i = tabs.findIndex((b) => b.classList.contains('on'));
    i = (i + dir + tabs.length) % tabs.length;
    tabs[i].click();
  },
  _openTab(name) {
    const b = document.querySelector(`.tab[data-tab="${name}"]`);
    if (b && b.offsetParent !== null) b.click();
  },

  init() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;   // no Gamepad API
    window.addEventListener('gamepadconnected', (e) => this._add(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._remove(e.gamepad.index));
    // A pad that was already connected before the page loaded.
    for (const gp of navigator.getGamepads()) if (gp && gp.connected) this._add(gp);
  },
};