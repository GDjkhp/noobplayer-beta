'use strict';
/* ═══════════════════════════════════════════
   Pad — game controller support (Gamepad API).

   Works with anything the browser maps to the "standard" gamepad layout:
   Xbox, PlayStation (DualShock/DualSense), Switch Pro, Steam, 8BitDo,
   generic XInput pads, etc. The header badge shows what kind of
   controller is connected (see detect() — vendor id first, then name).

   Every button/chord is looked up in Bindings (see bindings.js) rather
   than hardcoded here, so remapping a binding in the Bindings tab takes
   effect immediately — including the badge's tooltip and the floating
   button-prompt bar, both generated from whatever's actually bound.
   While the on-screen keyboard (vkeyboard.js) is open, its own
   "On-Screen Keyboard" bindings are dispatched instead of the regular
   ones — see the "vk" namespace note in bindings.js.

   Dispatch matches the exact set of buttons/stick-directions currently
   held against Bindings' pad map (single button or chord) and fires the
   action the instant that combo is complete — same press-triggered
   model as the keyboard. Only the Bindings tab's own capture flow is
   release-triggered (see bindings.js), so chords can be recorded.

   Everything a bound action does goes through the same Engine calls as
   the on-screen buttons and keyboard shortcuts, so lobby permissions
   (host / DJ only) are enforced exactly as they are for a click.

   Browsers only expose a pad after its first button press on the page,
   and only poll it while the tab is focused — that's why "connected"
   may not show until you press something.

   The floating button-prompt bar (and the equivalent row inside the
   on-screen keyboard) is shown only while the controller is the most
   recently used input — any mouse/touch/keyboard activity hides it
   again, so it doesn't clutter the screen for people who aren't using
   a controller.
═══════════════════════════════════════════ */
const Pad = {
  RAMP_DELAY: 400,      // ms a held repeatable combo waits before repeating
  VK_REPEAT: 250,       // ms a held direction repeats while the on-screen keyboard is open
  STICK_TH: 0.6,        // stick deflection that counts as a directional press

  // Pseudo-button indices for the two analog sticks, kept well past any
  // real button index (standard mapping tops out at 15, plus an
  // occasional vendor Home button at 16) so they're distinct "buttons"
  // in Bindings and never collide with a physical one.
  LS_UP: 100, LS_DOWN: 101, LS_LEFT: 102, LS_RIGHT: 103,
  RS_UP: 104, RS_DOWN: 105, RS_LEFT: 106, RS_RIGHT: 107,

  pads: {},            // index -> { prevComboKey, comboNext, type, label, id, mapping }
  activeIdx: null,     // pad that last had input — the one the badge/prompts describe
  _raf: null,
  _padActive: false,   // true while the controller is the most-recently-used input

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

  // Every button/stick index -> this controller family's short name for
  // it — used for the badge tooltip and the button-prompt chips.
  _btnName(type, idx) {
    const n = this._names(type);
    const table = { 0: n.a, 1: n.b, 2: n.x, 3: n.y, 4: n.lb, 5: n.rb, 6: n.lt, 7: n.rt, 8: n.back, 9: n.start,
      10: 'L3', 11: 'R3', 12: '↑', 13: '↓', 14: '←', 15: '→',
      [this.LS_UP]: 'LS↑', [this.LS_DOWN]: 'LS↓', [this.LS_LEFT]: 'LS←', [this.LS_RIGHT]: 'LS→',
      [this.RS_UP]: 'RS↑', [this.RS_DOWN]: 'RS↓', [this.RS_LEFT]: 'RS←', [this.RS_RIGHT]: 'RS→' };
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
        const arr = Array.isArray(btn) ? btn : [btn];
        return `${arr.map(i => this._btnName(p.type, i)).join('+')} ${a.label}`;
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

  /* ───────── in-place button prompts ("game controller only") ───────── */
  // Rather than a separate floating list, each bound action's own real
  // GUI control grows a tiny badge showing what's bound to it — the
  // play button gets its own prompt at the bottom of its circle, a tab
  // gets one in its corner, and so on. Badges live as a child of the
  // real element (position: relative on the host, position: absolute
  // on the badge) and are hidden by CSS whenever body doesn't have the
  // "pad-active" class, so no per-element JS toggling is needed for
  // show/hide — only for keeping their text in sync with the bindings.
  //
  // Only actions with a genuine one-to-one on-screen control get an
  // entry here; sliders (volume) and directional/continuous actions
  // (seek repeat, vk grid movement) have no single element to pin a
  // badge to and are skipped.
  ACTION_EL: {
    playPause: '#btn-play', next: '#btn-next', prev: '#btn-prev', stop: '#btn-stop',
    seekFwd: '#btn-f10', seekBack: '#btn-b10',
    loop: '#loop-btn', shuffle: '#btn-shuf', autoplay: '#btn-autoplay', gapless: '#gapless-btn',
    tabSearch: '.tab[data-tab="search"]', tabQueue: '.tab[data-tab="queue"]', tabLyrics: '.tab[data-tab="lyrics"]',
    tabSkins: '.tab[data-tab="skins"]', tabViz: '.tab[data-tab="viz"]', tabConfig: '.tab[data-tab="config"]',
    tabBindings: '.tab[data-tab="bindings"]',
    // On-screen keyboard's own buttons — "vkSelect" tracks whichever
    // grid key is currently highlighted, since that's the one A/✕ would
    // actually type; the rest are the overlay's fixed bottom-row buttons.
    vkSelect: '.vk-k.sel', vkBackspace: '[data-vk="back"]', vkClear: '[data-vk="clear"]',
    vkShift: '[data-vk="shift"]', vkLayout: '[data-vk="layout"]', vkSpace: '[data-vk="space"]', vkClose: '[data-vk="close"]',
    // In-tab navigation — "navSelect" tracks whichever element currently
    // has native DOM focus (see navMove/navSelect below), so its badge
    // moves the same way vkSelect's does. navUp/Down/Left/Right have no
    // single fixed target and get no badge, same as the player's own
    // seek/volume repeat actions.
    navSelect: ':focus',
  },
  // Tabs are wide/rectangular — a bottom-center badge would sit on top
  // of their label, so they get a corner badge instead. Everything else
  // (the round transport buttons, the vk grid key) gets the
  // bottom-of-circle placement.
  _hintCorner(id) { return id.startsWith('tab'); },

  // Targets that track "whichever element is currently selected/focused"
  // rather than a fixed one — their host moves between renders, so any
  // stale badge left on the PREVIOUS host has to be found and removed
  // before re-placing it, using the data-hint-for back-reference set
  // when each badge is created below.
  DYNAMIC_HINT_IDS: ['vkSelect', 'navSelect'],

  _renderElementHints() {
    const p = this.pads[this.activeIdx];
    for (const dynId of this.DYNAMIC_HINT_IDS) {
      document.querySelectorAll(`.pad-hint[data-hint-for="${dynId}"]`).forEach(h => h.remove());
    }
    for (const id of Object.keys(this.ACTION_EL)) {
      const el = document.querySelector(this.ACTION_EL[id]);
      if (!el) continue;
      const b = p ? Bindings.pad[id] : null;
      let hint = el.querySelector('.pad-hint');
      if (b === null || b === undefined || !p) {
        if (hint) hint.remove();
        continue;
      }
      const arr = Array.isArray(b) ? b : [b];
      const glyph = arr.map(i => this._btnName(p.type, i)).join('+');
      if (!hint) {
        hint = document.createElement('span');
        hint.className = 'pad-hint' + (this._hintCorner(id) ? ' corner' : '') + (this._isPlayerAction(id) ? ' pad-hint-playeronly' : '');
        hint.dataset.hintFor = id;
        // Only force position:relative on elements that aren't already
        // positioned — a fixed/absolute element's own positioning would
        // be silently overridden by .pad-hint-host's position:relative.
        if (getComputedStyle(el).position === 'static') el.classList.add('pad-hint-host');
        el.appendChild(hint);
      }
      hint.textContent = glyph;
    }
  },
  _setPadActive(v) {
    if (this._padActive === v) return;
    this._padActive = v;
    document.body.classList.toggle('pad-active', v);
  },

  /* ───────── connect / disconnect ───────── */
  _add(gp) {
    if (!gp || this.pads[gp.index]) return;
    const d = this.detect(gp.id);
    this.pads[gp.index] = { prevComboKey: '', comboNext: 0, type: d.type, label: d.label, id: gp.id, mapping: gp.mapping };
    this.activeIdx = gp.index;
    this._renderBadge();
    this._renderElementHints();
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
    this._renderElementHints();
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
    // Left/right stick are separate, independently bindable "buttons" —
    // see LS_*/RS_* above — distinct from the real d-pad (12-15).
    const ax = gp.axes || [];
    const th = this.STICK_TH;
    if ((ax[1] || 0) < -th) down[this.LS_UP]    = true;
    if ((ax[1] || 0) >  th) down[this.LS_DOWN]  = true;
    if ((ax[0] || 0) < -th) down[this.LS_LEFT]  = true;
    if ((ax[0] || 0) >  th) down[this.LS_RIGHT] = true;
    if ((ax[3] || 0) < -th) down[this.RS_UP]    = true;
    if ((ax[3] || 0) >  th) down[this.RS_DOWN]  = true;
    if ((ax[2] || 0) < -th) down[this.RS_LEFT]  = true;
    if ((ax[2] || 0) >  th) down[this.RS_RIGHT] = true;

    const downIdx = [];
    for (let i = 0; i < down.length; i++) if (down[i]) downIdx.push(i);

    if (downIdx.length) {
      this._setPadActive(true);
      if (this.activeIdx !== gp.index) { this.activeIdx = gp.index; this._renderBadge(); this._renderElementHints(); }
      this._flash();
    }

    // The Bindings tab is waiting for a release to finalize a new
    // binding — feed it every currently-held index and don't dispatch
    // any bound action while that's happening.
    if (Bindings._capturing && Bindings._capturing.kind === 'pad') {
      Bindings._capturePadTick(downIdx);
      return;
    }

    const vk = typeof VKeyboard !== 'undefined' && VKeyboard.active;
    const comboKey = downIdx.slice().sort((a, b) => a - b).join('+');

    // Hardcoded, NOT a Bindings action on purpose: A opens the on-screen
    // keyboard whenever a text field has focus, taking priority over
    // whatever A would otherwise do there (Play/Pause in the player
    // zone, "activate" in the tab zone). Making this rebindable would
    // let it collide with Play/Pause's own A binding, which is the bug
    // this replaced — so it's pinned to button 0 specifically and
    // skips the whole lookup below.
    if (!vk && downIdx.length === 1 && downIdx[0] === 0 && typeof VKeyboard !== 'undefined' && VKeyboard._isTextField(document.activeElement)) {
      if (comboKey !== p.prevComboKey) {
        p.prevComboKey = comboKey;
        p.comboNext = ts + this.RAMP_DELAY;
        VKeyboard.open(document.activeElement);
      }
      return;
    }

    // Which binding namespace this combo should be looked up in: the
    // on-screen keyboard's own controls while it's open, in-tab
    // navigation while a tab has focus (falling back to the Navigation
    // group — tab-switch and open-this-tab shortcuts, which are never
    // gated by focus since none of them are playback controls), or the
    // normal player/tab-switch namespace otherwise.
    let id = null;
    if (downIdx.length) {
      if (vk) id = Bindings.actionForPadCombo(downIdx, 'vk');
      else if (this.focus === 'tabs') {
        id = Bindings.actionForPadCombo(downIdx, 'nav');
        if (!id) {
          const normalId = Bindings.actionForPadCombo(downIdx, 'normal');
          const a = normalId && Bindings._byId(normalId);
          if (a && a.group === 'Navigation') id = normalId;
        }
      } else {
        id = Bindings.actionForPadCombo(downIdx, 'normal');
      }
    }

    if (comboKey !== p.prevComboKey) {
      p.prevComboKey = comboKey;
      p.comboNext = ts + this.RAMP_DELAY;
      if (id) this._dispatch(id);
    } else if (id) {
      const a = Bindings._byId(id);
      const repeatMs = a && a.repeat ? (vk ? this.VK_REPEAT : 110) : 0;
      if (repeatMs && ts >= (p.comboNext || 0)) { p.comboNext = ts + repeatMs; this._dispatch(id); }
    }
  },

  /* ───────── player-vs-tabs focus ─────────
     A controller has one cursor, not a mouse, so it needs to know
     whether a button press means "control playback" or "navigate the
     tabs" — otherwise browsing the Search tab with the d-pad would also
     seek the current track. tabPrev/tabNext (LT/RT by default) cycle
     through a ring of stops: Player, then each visible tab in order,
     wrapping back to Player. Only while Player has focus do Playback/
     Queue-group actions (play/pause, seek, volume, loop, shuffle...)
     fire; while any tab has focus they're silently suppressed. Direct
     tab-opening shortcuts (tabSearch, tabQueue, ...) and the on-screen
     keyboard's own controls are exempt — they work in either zone.
     This only governs GAMEPAD dispatch — keyboard bindings, and mouse/
     touch clicks on the buttons themselves, are never gated. */
  focus: 'player',   // 'player' | 'tabs'
  TAB_OPEN_ACTIONS: ['tabSearch', 'tabQueue', 'tabLyrics', 'tabSkins', 'tabViz', 'tabConfig', 'tabBindings'],
  _isPlayerAction(id) {
    const a = Bindings._byId(id);
    return !!a && (a.group === 'Playback' || a.group === 'Queue');
  },
  _setFocus(f) {
    if (this.focus === f) return;
    this.focus = f;
    document.body.classList.toggle('pad-tabs-focused', f === 'tabs');
    this._renderElementHints();
  },
  _cycleFocus(dir) {
    const tabs = Bindings._tabs();
    if (this.focus === 'player') {
      if (!tabs.length) return;
      this._setFocus('tabs');
      if (dir < 0) { const last = tabs[tabs.length - 1]; if (last) last.click(); }
      // dir > 0 just enters the tab ring at whichever tab is already showing.
      return;
    }
    if (!tabs.length) { this._setFocus('player'); return; }
    let i = tabs.findIndex(b => b.classList.contains('on'));
    i += dir;
    if (i < 0 || i >= tabs.length) { this._setFocus('player'); return; }
    tabs[i].click();
  },

  /* ───────── in-tab navigation (only while focus === 'tabs') ─────────
     Rather than hand-wiring each tab's own layout, this moves the
     browser's OWN focus between whatever's already naturally focusable
     inside the active pane — search-result buttons, queue-row buttons,
     config inputs, bindings rebind buttons, and so on all just work,
     with no per-tab code. navSelect activates whatever ends up focused;
     on a range slider, left/right nudge its value instead of moving
     focus, matching how arrow keys already behave on a focused slider. */
  _activePane() {
    const tab = document.querySelector('.tab.on');
    if (!tab) return null;
    return document.getElementById('pane-' + tab.dataset.tab);
  },
  _focusableIn(pane) {
    if (!pane) return [];
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...pane.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
  },
  navMove(dir, axis) {
    const el = document.activeElement;
    if (axis === 'h' && el && el.tagName === 'INPUT' && el.type === 'range') {
      const step = parseFloat(el.step) || 1;
      const min = el.min === '' ? -Infinity : parseFloat(el.min);
      const max = el.max === '' ? Infinity : parseFloat(el.max);
      el.value = Math.max(min, Math.min(max, (parseFloat(el.value) || 0) + dir * step));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      this._renderElementHints();
      return;
    }
    const items = this._focusableIn(this._activePane());
    if (!items.length) return;
    let i = items.indexOf(el);
    i = i === -1 ? (dir > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + dir));
    items[i].focus();
    if (items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
    this._renderElementHints();
  },
  navSelect() {
    const el = document.activeElement;
    if (el && typeof el.click === 'function') el.click();
  },

  _dispatch(id) {
    if (!id) return;
    if (Bindings._isVk(id)) { Bindings.run(id); return; }        // on-screen keyboard is modal — always active
    if (id === 'tabPrev') { this._cycleFocus(-1); return; }
    if (id === 'tabNext') { this._cycleFocus(1); return; }
    if (this.TAB_OPEN_ACTIONS.includes(id)) { Bindings.run(id); this._setFocus('tabs'); return; }
    if (this._isPlayerAction(id) && this.focus !== 'player') return;   // a tab has focus — playback buttons disabled
    Bindings.run(id);
  },

  init() {
    // Any non-controller input hides the "game controller only" prompts.
    window.addEventListener('mousemove', () => this._setPadActive(false), { passive: true });
    window.addEventListener('mousedown', () => this._setPadActive(false));
    window.addEventListener('touchstart', () => this._setPadActive(false), { passive: true });
    document.addEventListener('keydown', () => this._setPadActive(false));

    // Keep gamepad focus in sync with whatever was actually clicked —
    // clicking a tab (or one of its keyboard/mouse shortcuts, which
    // route through Bindings.openTab and click the tab button too)
    // moves focus to the tab ring; clicking inside the player controls
    // brings focus back, same as cycling all the way around with the
    // controller would.
    document.addEventListener('click', (e) => {
      if (e.target.closest('#ctrls')) this._setFocus('player');
      else if (e.target.closest('.tab')) this._setFocus('tabs');
    });

    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;   // no Gamepad API
    window.addEventListener('gamepadconnected', (e) => this._add(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._remove(e.gamepad.index));
    // A pad that was already connected before the page loaded.
    for (const gp of navigator.getGamepads()) if (gp && gp.connected) this._add(gp);
  },
};