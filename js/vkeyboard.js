'use strict';
/* ═══════════════════════════════════════════
   VKeyboard — on-screen keyboard for typing without a physical
   keyboard, controller-only: opens when a text field has focus and the
   player presses A (see the hardcoded intercept in gamepad.js's
   _process — deliberately not a Bindings action, so it can't collide
   with Play/Pause's own A binding). Once open, navigation/typing is
   exposed as plain methods (moveUp, select, backspace, ...) that ARE
   ordinary rebindable "On-Screen Keyboard" actions in the Bindings tab
   (vkUp/vkSelect/etc. — see bindings.js).
═══════════════════════════════════════════ */
const VKeyboard = {
  target: null,
  active: false,
  layout: 'letters',   // 'letters' | 'symbols'
  shift: false,
  row: 0, col: 0,

  ROWS_LETTERS: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
  ],
  ROWS_SYMBOLS: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '_', '.', ',', "'", '&', '!', '?'],
    ['@', '#', '$', '%', '(', ')', '/', ':'],
  ],

  init() {
    this._buildOverlay();
  },

  _isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return ['text', 'search', ''].includes((el.type || '').toLowerCase());
    return false;
  },

  open(field) {
    if (!field) return;
    this.target = field;
    this.active = true;
    this.row = 0; this.col = 0; this.shift = false; this.layout = 'letters';
    this._overlay.classList.add('show');
    this._renderKeys();
    this._renderPreview();
    if (typeof Pad !== 'undefined') Pad._renderElementHints();
  },

  close() {
    this.active = false;
    this._overlay.classList.remove('show');
    if (this.target) this.target.focus();
    if (typeof Pad !== 'undefined') Pad._renderElementHints();
  },

  _buildOverlay() {
    const ov = document.createElement('div');
    ov.id = 'vk-overlay';
    ov.innerHTML = `
      <div id="vk-panel">
        <div id="vk-preview"></div>
        <div id="vk-rows"></div>
        <div id="vk-bottom">
          <button data-vk="shift" class="vk-k vk-wide">⇧ Shift</button>
          <button data-vk="layout" class="vk-k vk-wide">123</button>
          <button data-vk="space" class="vk-k vk-space">Space</button>
          <button data-vk="back" class="vk-k vk-wide">⌫ Back</button>
          <button data-vk="clear" class="vk-k vk-wide">Clear</button>
          <button data-vk="close" class="vk-k vk-wide vk-go">Done</button>
        </div>
      </div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) this.close(); });
    document.body.appendChild(ov);
    this._overlay = ov;
    this._wireBottom();
  },

  _rows() { return this.layout === 'letters' ? this.ROWS_LETTERS : this.ROWS_SYMBOLS; },

  _renderKeys() {
    const wrap = this._overlay.querySelector('#vk-rows');
    const rows = this._rows();
    this.row = Math.min(this.row, rows.length - 1);
    this.col = Math.min(this.col, rows[this.row].length - 1);
    wrap.innerHTML = rows.map((r, ri) => `<div class="vk-row">${r.map((ch, ci) => {
      const label = this.layout === 'letters' && this.shift ? ch.toUpperCase() : ch;
      const sel = ri === this.row && ci === this.col ? ' sel' : '';
      return `<button class="vk-k${sel}" data-vk-r="${ri}" data-vk-c="${ci}">${esc(label)}</button>`;
    }).join('')}</div>`).join('');

    wrap.querySelectorAll('[data-vk-r]').forEach(btn => btn.addEventListener('click', () => {
      this.row = parseInt(btn.dataset.vkR, 10); this.col = parseInt(btn.dataset.vkC, 10);
      this._pressSelected();
    }));

    const layoutBtn = this._overlay.querySelector('[data-vk="layout"]');
    if (layoutBtn) layoutBtn.textContent = this.layout === 'letters' ? '123' : 'ABC';
    const shiftBtn = this._overlay.querySelector('[data-vk="shift"]');
    if (shiftBtn) shiftBtn.classList.toggle('on', this.shift);

    // The highlighted key just moved to a new element — re-place its
    // "type this key" badge there (see Pad.ACTION_EL's vkSelect entry).
    if (typeof Pad !== 'undefined') Pad._renderElementHints();
  },

  _wireBottom() {
    const map = {
      shift: () => this.toggleShift(),
      layout: () => this.toggleLayout(),
      space: () => this.space(),
      back: () => this.backspace(),
      clear: () => this.clearField(),
      close: () => this.close(),
    };
    this._overlay.querySelectorAll('[data-vk]').forEach(btn => { btn.onclick = map[btn.dataset.vk] || null; });
  },

  _renderPreview() {
    const pv = this._overlay.querySelector('#vk-preview');
    pv.textContent = this.target ? (this.target.value || '') : '';
    pv.classList.toggle('empty', !this.target || !this.target.value);
  },

  _insert(ch) {
    const el = this.target;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    const pos = start + ch.length;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this._renderPreview();
  },
  _backspace() {
    const el = this.target;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === end && start > 0) el.value = el.value.slice(0, start - 1) + el.value.slice(start);
    else el.value = el.value.slice(0, start) + el.value.slice(end);
    const pos = Math.max(0, start - (start === end ? 1 : 0));
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this._renderPreview();
  },
  _clear() {
    if (!this.target) return;
    this.target.value = '';
    this.target.dispatchEvent(new Event('input', { bubbles: true }));
    this._renderPreview();
  },
  _pressSelected() {
    const rows = this._rows();
    const ch = rows[this.row][this.col];
    this._insert(this.layout === 'letters' && this.shift ? ch.toUpperCase() : ch);
    this._renderKeys();
  },

  // ── public control surface — what Bindings' "vk*" actions call ──
  moveUp()    { const rows = this._rows(); this.row = Math.max(0, this.row - 1); this.col = Math.min(this.col, rows[this.row].length - 1); this._renderKeys(); },
  moveDown()  { const rows = this._rows(); this.row = Math.min(rows.length - 1, this.row + 1); this.col = Math.min(this.col, rows[this.row].length - 1); this._renderKeys(); },
  moveLeft()  { const rows = this._rows(); this.col = this.col > 0 ? this.col - 1 : rows[this.row].length - 1; this._renderKeys(); },
  moveRight() { const rows = this._rows(); this.col = this.col < rows[this.row].length - 1 ? this.col + 1 : 0; this._renderKeys(); },
  select()      { this._pressSelected(); },
  backspace()   { this._backspace(); },
  clearField()  { this._clear(); },
  toggleShift() { this.shift = !this.shift; this._renderKeys(); },
  toggleLayout(){ this.layout = this.layout === 'letters' ? 'symbols' : 'letters'; this.row = 0; this.col = 0; this._renderKeys(); },
  space()       { this._insert(' '); },
};