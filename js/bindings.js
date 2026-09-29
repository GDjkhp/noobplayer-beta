'use strict';
/* ═══════════════════════════════════════════
   Bindings — single source of truth for every keyboard shortcut and
   gamepad button (including combos and both analog sticks), plus the
   rebind UI behind the Bindings tab.

   Every trigger path (keyboard, gamepad, the on-screen keyboard's own
   navigation) looks an action up here instead of hardcoding a
   key/button, so remapping one spot changes it everywhere. Custom
   bindings persist in localStorage ('nl_keybinds' / 'nl_padbinds') and
   survive a reload — "Reset to defaults" in the tab clears them back to
   the tables below.

   ── Binding shapes ──
   Keyboard: { codes: [...] } — one or more normalized key codes (see
   _normalizeCode) held AT ONCE. A single key is just a one-element
   array; { codes: ['Shift','KeyS'] } means "Shift and S held together".
   Gamepad: a bare number for a single button, or an array of numbers
   for a chord (e.g. [4, 5] for "LB and RB together"). Actions whose id
   starts with "vk" are the on-screen keyboard's own controls — see
   vkeyboard.js — and live in a separate namespace from everything else,
   since the two are never active at the same time and can safely reuse
   the same physical buttons.

   ── Rebinding ──
   Capture is RELEASE-triggered, not press-triggered: click a binding,
   then hold down whatever key(s)/button(s) you want (in any order) and
   release one of them to set that whole combo. This is what makes
   multi-key/multi-button combos capturable at all — a press-triggered
   capture could only ever see the first key down.
═══════════════════════════════════════════ */
const Bindings = {
  ACTIONS: [
    { id: 'playPause',    label: 'Play / Pause',         group: 'Playback',   run: () => Engine.togglePause() },
    { id: 'next',         label: 'Next track',           group: 'Playback',   run: () => Engine.skip() },
    { id: 'prev',         label: 'Previous track',       group: 'Playback',   run: () => Engine.prev() },
    { id: 'stop',         label: 'Stop',                 group: 'Playback',   run: () => Engine.stop() },
    { id: 'seekFwd',      label: 'Seek +5s',             group: 'Playback',   run: () => Bindings.seek(5000),  repeat: true },
    { id: 'seekBack',     label: 'Seek -5s',             group: 'Playback',   run: () => Bindings.seek(-5000), repeat: true },
    { id: 'volUp',        label: 'Volume +5',            group: 'Playback',   run: () => Bindings.volume(5),   repeat: true },
    { id: 'volDown',      label: 'Volume -5',            group: 'Playback',   run: () => Bindings.volume(-5),  repeat: true },
    { id: 'loop',         label: 'Cycle loop mode',      group: 'Queue',      run: () => Engine.cycleLoop() },
    { id: 'shuffle',      label: 'Shuffle queue',        group: 'Queue',      run: () => Engine.shuffleQueue() },
    { id: 'smartShuffle', label: 'Smart shuffle',        group: 'Queue',      run: () => Engine.smartShuffle() },
    { id: 'autoplay',     label: 'Cycle autoplay',       group: 'Queue',      run: () => Engine.cycleAutoplay() },
    { id: 'gapless',      label: 'Toggle gapless',       group: 'Queue',      run: () => Engine.toggleGapless() },
    { id: 'fair',         label: 'Toggle fair queue',    group: 'Queue',      run: () => Engine.toggleFair() },
    { id: 'tabSearch',    label: 'Open Search tab',      group: 'Navigation', run: () => Bindings.openTab('search', true) },
    { id: 'tabQueue',     label: 'Open Queue tab',       group: 'Navigation', run: () => Bindings.openTab('queue') },
    { id: 'tabLyrics',    label: 'Open Lyrics tab',      group: 'Navigation', run: () => Bindings.openTab('lyrics') },
    { id: 'tabSkins',     label: 'Open Skins tab',       group: 'Navigation', run: () => Bindings.openTab('skins') },
    { id: 'tabViz',       label: 'Open Visualizer tab',  group: 'Navigation', run: () => Bindings.openTab('viz') },
    { id: 'tabConfig',    label: 'Open Config tab',      group: 'Navigation', run: () => Bindings.openTab('config') },
    { id: 'tabBindings',  label: 'Open Bindings tab',    group: 'Navigation', run: () => Bindings.openTab('bindings') },
    { id: 'tabPrev',      label: 'Previous tab',         group: 'Navigation', run: () => Bindings.cycleTab(-1) },
    { id: 'tabNext',      label: 'Next tab',             group: 'Navigation', run: () => Bindings.cycleTab(1) },
    { id: 'virtualKeyboard', label: 'Open on-screen keyboard (focused field)', group: 'Navigation', run: () => VKeyboard.openForFocused() },

    // On-screen keyboard's own controls — gamepad-only in practice (see
    // vkeyboard.js's class comment), namespaced by the "vk" id prefix so
    // they can freely reuse buttons already bound above without
    // conflicting: the two are never active at once.
    { id: 'vkUp',        label: 'On-screen keyboard: move up',    group: 'On-Screen Keyboard', run: () => VKeyboard.moveUp(),    repeat: true },
    { id: 'vkDown',      label: 'On-screen keyboard: move down',  group: 'On-Screen Keyboard', run: () => VKeyboard.moveDown(),  repeat: true },
    { id: 'vkLeft',      label: 'On-screen keyboard: move left',  group: 'On-Screen Keyboard', run: () => VKeyboard.moveLeft(),  repeat: true },
    { id: 'vkRight',     label: 'On-screen keyboard: move right', group: 'On-Screen Keyboard', run: () => VKeyboard.moveRight(), repeat: true },
    { id: 'vkSelect',    label: 'On-screen keyboard: type key',   group: 'On-Screen Keyboard', run: () => VKeyboard.select() },
    { id: 'vkBackspace', label: 'On-screen keyboard: backspace',  group: 'On-Screen Keyboard', run: () => VKeyboard.backspace() },
    { id: 'vkClear',     label: 'On-screen keyboard: clear field',group: 'On-Screen Keyboard', run: () => VKeyboard.clearField() },
    { id: 'vkShift',     label: 'On-screen keyboard: toggle shift', group: 'On-Screen Keyboard', run: () => VKeyboard.toggleShift() },
    { id: 'vkLayout',    label: 'On-screen keyboard: toggle 123/ABC', group: 'On-Screen Keyboard', run: () => VKeyboard.toggleLayout() },
    { id: 'vkSpace',     label: 'On-screen keyboard: space',      group: 'On-Screen Keyboard', run: () => VKeyboard.space() },
    { id: 'vkClose',     label: 'On-screen keyboard: close',      group: 'On-Screen Keyboard', run: () => VKeyboard.close() },
  ],

  // actionId -> { codes: [...normalized key codes] }
  DEFAULT_KEYS: {
    playPause:    { codes: ['Space'] },
    next:         { codes: ['Shift', 'ArrowRight'] },
    seekFwd:      { codes: ['ArrowRight'] },
    prev:         { codes: ['Shift', 'ArrowLeft'] },
    seekBack:     { codes: ['ArrowLeft'] },
    volUp:        { codes: ['ArrowUp'] },
    volDown:      { codes: ['ArrowDown'] },
    loop:         { codes: ['KeyL'] },
    shuffle:      { codes: ['KeyS'] },
    smartShuffle: { codes: ['Shift', 'KeyS'] },
    autoplay:     { codes: ['KeyA'] },
    tabSearch:    { codes: ['KeyF'] },
    tabQueue:     { codes: ['KeyQ'] },
    tabLyrics:    { codes: ['KeyY'] },
    tabSkins:     { codes: ['KeyK'] },
    tabViz:       { codes: ['KeyV'] },
  },

  // actionId -> standard-mapping button index, or an array for a chord.
  // 100-103 / 104-107 are the left/right stick's own pseudo-indices (see
  // Pad.LS_*/RS_* in gamepad.js) — distinct from the real d-pad (12-15).
  DEFAULT_PAD: {
    playPause: 0, loop: 1, shuffle: 2, autoplay: 3,
    prev: 4, next: 5, tabPrev: 6, tabNext: 7,
    tabLyrics: 8, tabQueue: 9,
    volUp: 12, volDown: 13, seekBack: 14, seekFwd: 15,
    vkUp: 12, vkDown: 13, vkLeft: 14, vkRight: 15,
    vkSelect: 0, vkBackspace: 1, vkClear: 2, vkShift: 3,
    vkLayout: 4, vkSpace: 5, vkClose: 9,
  },

  keys: {},
  pad: {},

  _byId(id) { return this.ACTIONS.find(a => a.id === id); },
  _isVk(id) { return id.startsWith('vk'); },

  // Physical Left/Right variants of a modifier key are folded into one
  // generic token, so a binding captured with the left Shift still
  // matches when the right Shift is pressed later (and vice versa).
  _normalizeCode(code) {
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
    if (code === 'ControlLeft' || code === 'ControlRight') return 'Control';
    if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
    if (code === 'MetaLeft' || code === 'MetaRight') return 'Meta';
    return code;
  },
  _comboKey(arr) { return [...arr].sort().join('+'); },

  load() {
    try { this.keys = this._migrateKeys({ ...this.DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('nl_keybinds') || '{}') }); }
    catch (_) { this.keys = { ...this.DEFAULT_KEYS }; }
    try { this.pad = { ...this.DEFAULT_PAD, ...JSON.parse(localStorage.getItem('nl_padbinds') || '{}') }; }
    catch (_) { this.pad = { ...this.DEFAULT_PAD }; }
  },
  // Upgrades any binding saved by an earlier version of this file (a
  // single `code` plus shift/ctrl/alt booleans) into the current
  // multi-key `codes` array shape.
  _migrateKeys(map) {
    const out = {};
    for (const id of Object.keys(map)) {
      const b = map[id];
      if (!b) { out[id] = null; continue; }
      if (Array.isArray(b.codes)) { out[id] = b; continue; }
      const codes = [];
      if (b.shift) codes.push('Shift');
      if (b.ctrl) codes.push('Control');
      if (b.alt) codes.push('Alt');
      if (b.code) codes.push(b.code);
      out[id] = { codes };
    }
    return out;
  },
  saveKeys() { try { localStorage.setItem('nl_keybinds', JSON.stringify(this.keys)); } catch (_) {} },
  savePad()  { try { localStorage.setItem('nl_padbinds', JSON.stringify(this.pad)); } catch (_) {} },
  resetKeys() { this.keys = { ...this.DEFAULT_KEYS }; this.saveKeys(); this.renderTab(); toast('Keyboard bindings reset', 'success', 1800); },
  resetPad()  { this.pad = { ...this.DEFAULT_PAD }; this.savePad(); this.renderTab(); toast('Controller bindings reset', 'success', 1800); },

  // A key combo / button combo can only belong to one action within its
  // own namespace — reassigning it strips it from whoever had it, same
  // as most games' rebind screens. `vk*` actions and everything else
  // are separate namespaces (see class comment) so they never conflict
  // with each other even when they share a button.
  setKey(actionId, binding) {
    if (binding && binding.codes && binding.codes.length) {
      const key = this._comboKey(binding.codes);
      for (const id of Object.keys(this.keys)) {
        if (id !== actionId && this.keys[id] && this._comboKey(this.keys[id].codes) === key) this.keys[id] = null;
      }
    }
    this.keys[actionId] = binding;
    this.saveKeys();
  },
  setPad(actionId, binding) {
    const arr = (binding === null || binding === undefined) ? null : (Array.isArray(binding) ? binding : [binding]);
    if (arr && arr.length) {
      const key = this._comboKey(arr);
      const vk = this._isVk(actionId);
      for (const id of Object.keys(this.pad)) {
        if (id === actionId || this._isVk(id) !== vk) continue;
        const b = this.pad[id];
        if (b === null || b === undefined) continue;
        const bArr = Array.isArray(b) ? b : [b];
        if (this._comboKey(bArr) === key) this.pad[id] = null;
      }
    }
    this.pad[actionId] = arr && arr.length === 1 ? arr[0] : arr;
    this.savePad();
  },

  // ── runtime lookups ──
  actionForKeyCombo(codes) {
    const key = this._comboKey(codes);
    for (const id of Object.keys(this.keys)) {
      const b = this.keys[id];
      if (b && b.codes && b.codes.length && this._comboKey(b.codes) === key) return id;
    }
    return null;
  },
  actionForPadCombo(indices, vkOnly) {
    const key = this._comboKey(indices);
    for (const id of Object.keys(this.pad)) {
      if (this._isVk(id) !== !!vkOnly) continue;
      const b = this.pad[id];
      if (b === null || b === undefined) continue;
      const arr = Array.isArray(b) ? b : [b];
      if (this._comboKey(arr) === key) return id;
    }
    return null;
  },
  run(actionId) {
    const a = this._byId(actionId);
    if (a) { try { a.run(); } catch (_) {} }
  },

  // ── keyboard runtime dispatch — press-triggered (combos fire the
  // instant the full set is down); only rebind CAPTURE is release-based ──
  _held: new Set(),
  init() {
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => this._onKeyUp(e));
  },
  _onKeyDown(e) {
    if (this._capturing) return;   // the Bindings tab owns keyboard input right now
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    this._held.add(this._normalizeCode(e.code));
    const id = this.actionForKeyCombo(this._held);
    if (!id) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    this.run(id);
  },
  _onKeyUp(e) {
    if (this._capturing) return;
    this._held.delete(this._normalizeCode(e.code));
  },

  // ── shared action helpers ──
  seek(delta) { Engine.seekTo((S.player ? S.player.getPositionMs() : 0) + delta); },
  volume(delta) {
    const sl = document.getElementById('vol-sl');
    if (!sl) return;
    sl.value = Math.max(0, Math.min(100, parseInt(sl.value, 10) + delta));
    sl.dispatchEvent(new Event('input'));
  },
  _tabs() { return [...document.querySelectorAll('.tab')].filter(b => b.offsetParent !== null); },
  openTab(name, focusSearch) {
    const b = document.querySelector(`.tab[data-tab="${name}"]`);
    if (b && b.offsetParent !== null) b.click();
    if (focusSearch) { const si = document.getElementById('si'); if (si) si.focus(); }
  },
  cycleTab(dir) {
    const tabs = this._tabs();
    if (!tabs.length) return;
    let i = tabs.findIndex(b => b.classList.contains('on'));
    i = (i + dir + tabs.length) % tabs.length;
    tabs[i].click();
  },

  /* ═══════ Bindings tab UI ═══════ */
  _capturing: null,
  _keyDownHandler: null, _keyUpHandler: null, _keyHeld: null,
  _padCaptureEsc: null, _padHeld: null, _padBaseline: null, _padPrevDown: null,

  renderTab() {
    const el = document.getElementById('bindings-list');
    if (el) {
      const groups = {};
      this.ACTIONS.forEach(a => (groups[a.group] = groups[a.group] || []).push(a));
      el.innerHTML = Object.keys(groups).map(g => `
        <div class="bnd-group">
          <div class="bnd-group-h">${esc(g)}</div>
          ${groups[g].map(a => this._row(a)).join('')}
        </div>`).join('');

      el.querySelectorAll('[data-bnd-key]').forEach(btn => btn.addEventListener('click', () => this._capture(btn.dataset.bndKey, 'key')));
      el.querySelectorAll('[data-bnd-pad]').forEach(btn => btn.addEventListener('click', () => this._capture(btn.dataset.bndPad, 'pad')));
      el.querySelectorAll('[data-clr-key]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); this.setKey(btn.dataset.clrKey, null); this.renderTab(); }));
      el.querySelectorAll('[data-clr-pad]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); this.setPad(btn.dataset.clrPad, null); this.renderTab(); }));
    }
    // Keep the "game controller only" prompt bar / on-screen keyboard's
    // prompt row in sync with whatever was just rebound.
    if (typeof Pad !== 'undefined') Pad._renderPrompts();
  },

  _codeLabel(code) {
    if (code === 'Control') return 'Ctrl';
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
  },
  _keyLabel(b) {
    if (!b || !b.codes || !b.codes.length) return '—';
    return b.codes.map(c => this._codeLabel(c)).join('+');
  },
  PAD_BTN_NAMES: { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start',
    10: 'L3', 11: 'R3', 12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right' },
  // Pad's stick pseudo-indices (see gamepad.js) — read off Pad rather than
  // re-declaring them here, so the two files can't drift out of sync.
  _stickNames() {
    if (typeof Pad === 'undefined') return {};
    return {
      [Pad.LS_UP]: 'L-Stick Up', [Pad.LS_DOWN]: 'L-Stick Down', [Pad.LS_LEFT]: 'L-Stick Left', [Pad.LS_RIGHT]: 'L-Stick Right',
      [Pad.RS_UP]: 'R-Stick Up', [Pad.RS_DOWN]: 'R-Stick Down', [Pad.RS_LEFT]: 'R-Stick Left', [Pad.RS_RIGHT]: 'R-Stick Right',
    };
  },
  _btnLabel1(i) { return this.PAD_BTN_NAMES[i] || this._stickNames()[i] || `Btn ${i}`; },
  _padLabel(b) {
    if (b === null || b === undefined) return '—';
    const arr = Array.isArray(b) ? b : [b];
    return arr.map(i => this._btnLabel1(i)).join('+');
  },

  _row(a) {
    const capKey = this._capturing && this._capturing.actionId === a.id && this._capturing.kind === 'key';
    const capPad = this._capturing && this._capturing.actionId === a.id && this._capturing.kind === 'pad';
    const k = this.keys[a.id], p = this.pad[a.id];
    return `<div class="bnd-row">
      <div class="bnd-lbl">${esc(a.label)}</div>
      <div class="bnd-cell">
        <button class="bnd-btn ${capKey ? 'listening' : ''}" data-bnd-key="${a.id}">${capKey ? 'Hold, then release…' : esc(this._keyLabel(k))}</button>
        ${k ? `<button class="bnd-x" data-clr-key="${a.id}" title="Unbind"><span class="material-symbols-outlined">close</span></button>` : ''}
      </div>
      <div class="bnd-cell">
        <button class="bnd-btn ${capPad ? 'listening' : ''}" data-bnd-pad="${a.id}">${capPad ? 'Hold, then release…' : esc(this._padLabel(p))}</button>
        ${(p !== undefined && p !== null) ? `<button class="bnd-x" data-clr-pad="${a.id}" title="Unbind"><span class="material-symbols-outlined">close</span></button>` : ''}
      </div>
    </div>`;
  },

  _capture(actionId, kind) {
    if (this._capturing && this._capturing.actionId === actionId && this._capturing.kind === kind) { this._cancelCapture(); return; }
    this._cancelCapture();
    this._capturing = { actionId, kind };
    this.renderTab();
    if (kind === 'key') {
      this._keyHeld = new Set();
      this._keyDownHandler = (e) => {
        if (e.code === 'Escape') { this._cancelCapture(); return; }
        e.preventDefault();
        this._keyHeld.add(this._normalizeCode(e.code));
      };
      this._keyUpHandler = (e) => {
        e.preventDefault();
        if (!this._keyHeld.size) return;   // released a key we never saw go down (e.g. focus loss) — keep waiting
        this.setKey(actionId, { codes: [...this._keyHeld] });
        this._cancelCapture();
      };
      document.addEventListener('keydown', this._keyDownHandler, true);
      document.addEventListener('keyup', this._keyUpHandler, true);
    } else {
      this._padHeld = new Set();
      this._padBaseline = null;
      this._padPrevDown = null;
      this._padCaptureEsc = (e) => { if (e.code === 'Escape') { e.preventDefault(); this._cancelCapture(); } };
      document.addEventListener('keydown', this._padCaptureEsc, true);
    }
  },

  _cancelCapture() {
    if (this._keyDownHandler) { document.removeEventListener('keydown', this._keyDownHandler, true); this._keyDownHandler = null; }
    if (this._keyUpHandler) { document.removeEventListener('keyup', this._keyUpHandler, true); this._keyUpHandler = null; }
    if (this._padCaptureEsc) { document.removeEventListener('keydown', this._padCaptureEsc, true); this._padCaptureEsc = null; }
    this._capturing = null;
    this._keyHeld = null;
    this._padHeld = null; this._padBaseline = null; this._padPrevDown = null;
    this.renderTab();
  },

  // Called every frame from gamepad.js while a pad capture is active,
  // with every button/stick index currently held down. Accumulates
  // every NEW index pressed since capture started into a combo, and
  // finalizes the binding the moment any one of them is released —
  // release-triggered so a genuine chord (hold LB, then also hold RB)
  // can be captured at all, not just whichever button went down first.
  _capturePadTick(downIndices) {
    if (!this._capturing || this._capturing.kind !== 'pad') return;
    const downSet = new Set(downIndices);
    if (!this._padBaseline) { this._padBaseline = downSet; this._padPrevDown = downSet; return; }
    for (const i of downSet) if (!this._padBaseline.has(i)) this._padHeld.add(i);
    for (const i of this._padPrevDown) {
      if (this._padHeld.has(i) && !downSet.has(i)) {
        const actionId = this._capturing.actionId;
        this.setPad(actionId, [...this._padHeld].sort((x, y) => x - y));
        this._cancelCapture();
        return;
      }
    }
    this._padPrevDown = downSet;
  },
};