'use strict';
/* ═══════════════════════════════════════════
   Pad — game controller support (Gamepad API).

   Works with anything the browser maps to the "standard" gamepad layout:
   Xbox, PlayStation (DualShock/DualSense), Switch Pro, Steam, 8BitDo,
   generic XInput pads, etc. The header badge shows what kind of
   controller is connected (see detect() — vendor id first, then name).

   Every button press is looked up in Bindings (see bindings.js) rather
   than hardcoded here, so remapping a button in the Bindings tab takes
   effect immediately — including the badge's own tooltip, which lists
   whatever's currently bound instead of a fixed legend. While the
   on-screen keyboard (vkeyboard.js) is open, presses go to it instead
   for grid navigation/typing.

   Everything a bound action does goes through the same Engine calls as
   the on-screen buttons and keyboard shortcuts, so lobby permissions
   (host / DJ only) are enforced exactly as they are for a click.

   Browsers only expose a pad after its first button press on the page,
   and only poll it while the tab is focused — that's why "connected"
   may not show until you press something.
═══════════════════════════════════════════ */
const Pad = {
  RAMP_DELAY: 400,     // ms a held repeatable button waits before repeating
  VK_REPEAT: 250,       // ms a held d-pad direction repeats while the on-screen keyboard is open
  STICK_TH: 0.6,       // left-stick deflection that counts as a d-pad press

  pads: {},            // index -> { prev:[bool], next:[ms], type, label, id, mapping }
  activeIdx: null,     // pad that last had input — the one the badge describes
  _raf: null,

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

  // Every standard-mapping index -> this controller family's name for it.
  _btnName(type, idx) {
    const n = this._names(type);
    const table = { 0: n.a, 1: n.b, 2: n.x, 3: n.y, 4: n.lb, 5: n.rb, 6: n.lt, 7: n.rt, 8: n.back, 9: n.start,
      10: 'L3', 11: 'R3', 12: 'D-pad/Stick ↑', 13: 'D-pad/Stick ↓', 14: 'D-pad/Stick ←', 15: 'D-pad/Stick →' };
    return table[idx] || `Btn ${idx}`;
  },

  // Built from whatever's actually bound right now (see bindings.js), so
  // rebinding a button updates the tooltip immediately.
  _tooltip(p) {
    const bits = ['playPause', 'loop', 'shuffle', 'autoplay', 'prev', 'next', 'tabPrev', 'tabNext', 'tabQueue', 'tabLyrics', 'seekFwd', 'volUp']
      .map((id) => {
        const btn = Bindings.pad[id];
        if (btn === undefined || btn === null) return null;
        const a = Bindings._byId(id);
        return `${this._btnName(p.type, btn)} ${a.label}`;
      })
      .filter(Boolean);
    const lines = [`${p.label} controller connected`, bits.join(' · '), 'Open the Bindings tab to remap'];
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

    // The Bindings tab is waiting for the next press to assign a new
    // binding — feed it everything currently held and don't dispatch any
    // bound action while that's happening.
    if (Bindings._capturing && Bindings._capturing.kind === 'pad') {
      const downIdx = [];
      for (let i = 0; i < down.length; i++) if (down[i]) downIdx.push(i);
      Bindings._capturePadTick(downIdx);
      p.prev = down;
      if (downIdx.length) { this.activeIdx = gp.index; this._renderBadge(); this._flash(); }
      return;
    }

    const vk = VKeyboard.active;
    let any = false;
    for (let i = 0; i < down.length; i++) {
      if (!down[i]) continue;
      any = true;
      const fresh = !p.prev[i];
      const repeatMs = vk ? (i >= 12 && i <= 15 ? this.VK_REPEAT : 0) : this._repeatFor(i);
      if (fresh) {
        p.next[i] = ts + this.RAMP_DELAY;
        this._dispatch(i, vk);
      } else if (repeatMs && ts >= (p.next[i] || 0)) {
        p.next[i] = ts + repeatMs;
        this._dispatch(i, vk);
      }
    }
    p.prev = down;

    if (any) {
      if (this.activeIdx !== gp.index) { this.activeIdx = gp.index; this._renderBadge(); }
      this._flash();
    }
  },

  _repeatFor(i) {
    const id = Bindings.actionForPadButton(i);
    const a = id && Bindings._byId(id);
    return a && a.repeat ? 110 : 0;
  },

  _dispatch(i, vk) {
    if (vk) { try { VKeyboard.padPress(i); } catch (_) {} return; }
    const id = Bindings.actionForPadButton(i);
    if (id) Bindings.run(id);
  },

  init() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;   // no Gamepad API
    window.addEventListener('gamepadconnected', (e) => this._add(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._remove(e.gamepad.index));
    // A pad that was already connected before the page loaded.
    for (const gp of navigator.getGamepads()) if (gp && gp.connected) this._add(gp);
  },
};