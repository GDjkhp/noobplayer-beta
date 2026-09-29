'use strict';
/* ═══════════════════════════════════════════
   Bindings — single source of truth for every keyboard shortcut and
   gamepad button, plus the rebind UI behind the Bindings tab.

   main.js's keydown listener and gamepad.js's button poll both look an
   action up here instead of hardcoding a key/button, so remapping one
   spot changes both trigger paths. Custom bindings persist in
   localStorage ('nl_keybinds' / 'nl_padbinds') and survive a reload —
   "Reset to defaults" in the tab clears them back to the table below.
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
  ],

  // actionId -> { code, shift, ctrl, alt }. Only `code` is required.
  DEFAULT_KEYS: {
    playPause:    { code: 'Space' },
    next:         { code: 'ArrowRight', shift: true },
    seekFwd:      { code: 'ArrowRight' },
    prev:         { code: 'ArrowLeft', shift: true },
    seekBack:     { code: 'ArrowLeft' },
    volUp:        { code: 'ArrowUp' },
    volDown:      { code: 'ArrowDown' },
    loop:         { code: 'KeyL' },
    shuffle:      { code: 'KeyS' },
    smartShuffle: { code: 'KeyS', shift: true },
    autoplay:     { code: 'KeyA' },
    tabSearch:    { code: 'KeyF' },
    tabQueue:     { code: 'KeyQ' },
    tabLyrics:    { code: 'KeyY' },
    tabSkins:     { code: 'KeyK' },
    tabViz:       { code: 'KeyV' },
  },

  // actionId -> standard-mapping button index. 12-15 (d-pad) also fire
  // from the left stick — see gamepad.js's axis-to-button emulation.
  DEFAULT_PAD: {
    playPause: 0, loop: 1, shuffle: 2, autoplay: 3,
    prev: 4, next: 5, tabPrev: 6, tabNext: 7,
    tabLyrics: 8, tabQueue: 9,
    volUp: 12, volDown: 13, seekBack: 14, seekFwd: 15,
  },

  keys: {},
  pad: {},

  _byId(id) { return this.ACTIONS.find(a => a.id === id); },

  load() {
    try { this.keys = { ...this.DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('nl_keybinds') || '{}') }; }
    catch (_) { this.keys = { ...this.DEFAULT_KEYS }; }
    try { this.pad = { ...this.DEFAULT_PAD, ...JSON.parse(localStorage.getItem('nl_padbinds') || '{}') }; }
    catch (_) { this.pad = { ...this.DEFAULT_PAD }; }
  },
  saveKeys() { try { localStorage.setItem('nl_keybinds', JSON.stringify(this.keys)); } catch (_) {} },
  savePad()  { try { localStorage.setItem('nl_padbinds', JSON.stringify(this.pad)); } catch (_) {} },
  resetKeys() { this.keys = { ...this.DEFAULT_KEYS }; this.saveKeys(); this.renderTab(); toast('Keyboard bindings reset', 'success', 1800); },
  resetPad()  { this.pad = { ...this.DEFAULT_PAD }; this.savePad(); this.renderTab(); toast('Controller bindings reset', 'success', 1800); },

  // A key/button can only belong to one action — reassigning it strips
  // it from whoever had it, same as most games' rebind screens.
  setKey(actionId, binding) {
    if (binding) for (const id of Object.keys(this.keys)) {
      if (id !== actionId && this._sameKey(this.keys[id], binding)) this.keys[id] = null;
    }
    this.keys[actionId] = binding;
    this.saveKeys();
  },
  setPad(actionId, buttonIndex) {
    if (buttonIndex !== null && buttonIndex !== undefined) for (const id of Object.keys(this.pad)) {
      if (id !== actionId && this.pad[id] === buttonIndex) this.pad[id] = null;
    }
    this.pad[actionId] = buttonIndex;
    this.savePad();
  },
  _sameKey(a, b) {
    if (!a || !b) return false;
    return a.code === b.code && !!a.shift === !!b.shift && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt;
  },

  actionForKeyEvent(e) {
    for (const id of Object.keys(this.keys)) {
      const b = this.keys[id];
      if (b && b.code === e.code && !!b.shift === e.shiftKey && !!b.ctrl === e.ctrlKey && !!b.alt === e.altKey) return id;
    }
    return null;
  },
  actionForPadButton(index) {
    for (const id of Object.keys(this.pad)) if (this.pad[id] === index) return id;
    return null;
  },
  run(actionId) {
    const a = this._byId(actionId);
    if (a) { try { a.run(); } catch (_) {} }
  },

  handleKeydown(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const id = this.actionForKeyEvent(e);
    if (!id) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    this.run(id);
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
  _capturing: null,           // { actionId, kind } while listening for the next input
  _keyCaptureHandler: null,
  _padCaptureEsc: null,
  _capturePadBaseline: null,

  renderTab() {
    const el = document.getElementById('bindings-list');
    if (!el) return;
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
  },

  _keyLabel(b) {
    if (!b) return '—';
    const parts = [];
    if (b.shift) parts.push('Shift');
    if (b.ctrl) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    parts.push(b.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, ''));
    return parts.join('+');
  },
  PAD_BTN_NAMES: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right'],
  _padLabel(i) { return (i === null || i === undefined) ? '—' : (this.PAD_BTN_NAMES[i] || `Btn ${i}`); },

  _row(a) {
    const capKey = this._capturing && this._capturing.actionId === a.id && this._capturing.kind === 'key';
    const capPad = this._capturing && this._capturing.actionId === a.id && this._capturing.kind === 'pad';
    const k = this.keys[a.id], p = this.pad[a.id];
    return `<div class="bnd-row">
      <div class="bnd-lbl">${esc(a.label)}</div>
      <div class="bnd-cell">
        <button class="bnd-btn ${capKey ? 'listening' : ''}" data-bnd-key="${a.id}">${capKey ? 'Press a key…' : esc(this._keyLabel(k))}</button>
        ${k ? `<button class="bnd-x" data-clr-key="${a.id}" title="Unbind"><span class="material-symbols-outlined">close</span></button>` : ''}
      </div>
      <div class="bnd-cell">
        <button class="bnd-btn ${capPad ? 'listening' : ''}" data-bnd-pad="${a.id}">${capPad ? 'Press a button…' : esc(this._padLabel(p))}</button>
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
      this._keyCaptureHandler = (e) => {
        e.preventDefault();
        if (e.code === 'Escape') { this._cancelCapture(); return; }
        this.setKey(actionId, { code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
        this._cancelCapture();
      };
      document.addEventListener('keydown', this._keyCaptureHandler, true);
    } else {
      this._capturePadBaseline = null;
      this._padCaptureEsc = (e) => { if (e.code === 'Escape') { e.preventDefault(); this._cancelCapture(); } };
      document.addEventListener('keydown', this._padCaptureEsc, true);
    }
  },

  _cancelCapture() {
    if (this._keyCaptureHandler) { document.removeEventListener('keydown', this._keyCaptureHandler, true); this._keyCaptureHandler = null; }
    if (this._padCaptureEsc) { document.removeEventListener('keydown', this._padCaptureEsc, true); this._padCaptureEsc = null; }
    this._capturing = null;
    this._capturePadBaseline = null;
    this.renderTab();
  },

  // Called every frame from gamepad.js while a pad capture is active,
  // with every button index currently held down. Picks the first index
  // that wasn't already down when capture started, so the click that
  // opened "Press a button…" can't self-select.
  _capturePadTick(downIndices) {
    if (!this._capturing || this._capturing.kind !== 'pad') return;
    if (!this._capturePadBaseline) { this._capturePadBaseline = new Set(downIndices); return; }
    for (const i of downIndices) {
      if (!this._capturePadBaseline.has(i)) {
        const actionId = this._capturing.actionId;
        this.setPad(actionId, i);
        this._cancelCapture();
        return;
      }
    }
  },
};