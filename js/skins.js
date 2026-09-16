'use strict';
/* ═══════════════════════════════════════════
   Skins — look-and-feel customisation.

   A skin is deliberately small: a bag of CSS custom properties (the same
   ones :root declares in style.css), a handful of layout knobs, and an
   optional block of free-form CSS. That means applying one is instant and
   reversible — set the properties on <html>, drop the generated rules into
   a single <style> tag, done. Nothing rebuilds, nothing reloads.

   Three places a skin can live:
     - applied   : painted onto the page right now (localStorage nl_skin_active)
     - mine      : saved in this browser (localStorage nl_skins)
     - gallery   : published to the server for anyone to install (SkinAPI)

   On the free-form CSS: it's filtered here AND on the server (see
   _sanitize_css in server.py) before it ever runs — no @import, no url()
   pointing anywhere but https/data-image, nothing that breaks out of the
   <style> block. That closes the obvious holes but not the category:
   CSS can still fetch a remote image (which tells the host you loaded the
   skin) and can hide or cover interface elements. Installing a stranger's
   skin is a trust decision, which is why the Browse list shows a badge on
   any skin carrying custom CSS and the editor says so out loud.
═══════════════════════════════════════════ */

// The variables exposed in the editor, in the order they're shown. Anything
// in :root that ISN'T listed here still works in a skin (the server accepts
// any [a-z0-9-] key) — this list is just what gets a colour picker.
const SKIN_VARS = [
  { key: 'bg',     label: 'Page' },
  { key: 'surf',   label: 'Surface' },
  { key: 'surf2',  label: 'Surface 2' },
  { key: 'surf3',  label: 'Surface 3' },
  { key: 'brd',    label: 'Border' },
  { key: 'brd2',   label: 'Border 2' },
  { key: 'text',   label: 'Text' },
  { key: 'muted',  label: 'Muted' },
  { key: 'muted2', label: 'Muted 2' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent2',label: 'Accent 2' },
  { key: 'green',  label: 'Success' },
  { key: 'red',    label: 'Danger' },
  { key: 'amber',  label: 'Warning' },
  { key: 'pink',   label: 'Pink' },
];

const SKIN_FONTS = [
  { value: "'Syne', sans-serif",            label: 'Syne' },
  { value: "'JetBrains Mono', monospace",   label: 'JetBrains Mono' },
  { value: "system-ui, sans-serif",         label: 'System UI' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia (serif)' },
  { value: "'Courier New', monospace",      label: 'Courier' },
  { value: "Impact, 'Arial Black', sans-serif", label: 'Impact' },
  { value: "Verdana, Geneva, sans-serif",   label: 'Verdana' },
  { value: "'Comic Sans MS', cursive",      label: 'Comic Sans' },
];

const SKIN_OPT_DEFAULTS = {
  radius: 0, artRadius: 0, noise: 3, glow: 0, density: 1,
  bgUrl: '', bgDim: 70, bgBlur: 0,
};

// Built-in starting points. Each only overrides what it cares about —
// Skins.normalize() fills the rest in from the stock theme.
const SKIN_PRESETS = {
  'Midnight (default)': { vars: {}, opts: {} },
  'Vaporwave': {
    vars: { bg:'#1a0b2e', surf:'#241041', surf2:'#2d1452', surf3:'#3a1a68', brd:'#3d1f66',
            brd2:'#552d8c', text:'#ffe9ff', muted:'#a97fd4', muted2:'#7a5aa0',
            accent:'#ff71ce', accent2:'#01cdfe', green:'#05ffa1', pink:'#ff71ce' },
    opts: { radius: 0, glow: 14, noise: 5 },
  },
  'Terminal': {
    vars: { bg:'#000000', surf:'#050f05', surf2:'#0a1a0a', surf3:'#0f230f', brd:'#123d12',
            brd2:'#1c5c1c', text:'#c8ffc8', muted:'#4f9e4f', muted2:'#2f6b2f',
            accent:'#00ff66', accent2:'#8bff00', fn:"'JetBrains Mono', monospace" },
    opts: { radius: 0, noise: 1, glow: 8 },
  },
  'Paper': {
    vars: { bg:'#f4f1ea', surf:'#ffffff', surf2:'#f7f4ee', surf3:'#efe9de', brd:'#ddd6c8',
            brd2:'#c9c0ad', text:'#2a2722', muted:'#7d7568', muted2:'#a8a093',
            accent:'#b4552d', accent2:'#7a6a4f', green:'#3f7d43', red:'#b03b3b',
            fn:"Georgia, 'Times New Roman', serif" },
    opts: { radius: 4, noise: 0, glow: 0 },
  },
  'Ember': {
    vars: { bg:'#120806', surf:'#1c0e0a', surf2:'#251310', surf3:'#301a14', brd:'#3a201a',
            brd2:'#5a2e22', text:'#ffe8dd', muted:'#a3705c', muted2:'#6d4638',
            accent:'#ff6b35', accent2:'#ffb347', green:'#8bc34a' },
    opts: { radius: 2, glow: 18, noise: 4 },
  },
  'Mono': {
    vars: { bg:'#0a0a0a', surf:'#121212', surf2:'#181818', surf3:'#202020', brd:'#262626',
            brd2:'#383838', text:'#f0f0f0', muted:'#8a8a8a', muted2:'#5a5a5a',
            accent:'#ffffff', accent2:'#b0b0b0' },
    opts: { radius: 6, noise: 0, glow: 0 },
  },
};

const LS_ACTIVE = 'nl_skin_active';
const LS_LIBRARY = 'nl_skins';
const LS_DRAFT   = 'nl_skin_draft';

const Skins = {
  _defaults: null,          // stock values read off :root before anything is applied
  _styleEl: null,

  /* ───────── lifecycle ───────── */

  init() {
    this._captureDefaults();
    this._ensureStyleEl();
    this.loadLibrary();

    // Reapply whatever was active last session before first paint of the
    // player, so there's no flash of the stock theme.
    try {
      const raw = localStorage.getItem(LS_ACTIVE);
      if (raw) {
        const skin = this.normalize(JSON.parse(raw));
        S.skins.active = skin;
        S.skins.activeId = skin._id || null;
        this.apply(skin, { persist: false });
      }
    } catch (_) { localStorage.removeItem(LS_ACTIVE); }

    try {
      const draft = localStorage.getItem(LS_DRAFT);
      S.skins.draft = draft ? this.normalize(JSON.parse(draft)) : this.normalize(S.skins.active || {});
    } catch (_) { S.skins.draft = this.normalize({}); }
  },

  // Read the stock theme straight off the stylesheet so "Reset" and any
  // partial skin can fall back to real values instead of hardcoded copies
  // that would drift the moment style.css changes.
  _captureDefaults() {
    if (this._defaults) return;
    const cs = getComputedStyle(document.documentElement);
    this._defaults = {};
    for (const { key } of SKIN_VARS) this._defaults[key] = (cs.getPropertyValue('--' + key) || '').trim();
    this._defaults.fn = (cs.getPropertyValue('--fn') || '').trim();
    this._defaults.fm = (cs.getPropertyValue('--fm') || '').trim();
  },

  _ensureStyleEl() {
    if (this._styleEl) return this._styleEl;
    let el = document.getElementById('skin-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'skin-style';
      document.head.appendChild(el);
    }
    this._styleEl = el;
    return el;
  },

  /* ───────── skin shape ───────── */

  normalize(skin) {
    skin = skin || {};
    return {
      _id: skin._id || skin.id || null,
      _editToken: skin._editToken || skin.editToken || null,
      name: String(skin.name || 'Untitled Skin').slice(0, 40),
      author: String(skin.author || '').slice(0, 24),
      vars: { ...(skin.vars || {}) },
      opts: { ...SKIN_OPT_DEFAULTS, ...(skin.opts || {}) },
      css: String(skin.css || ''),
    };
  },

  // What gets sent to the server / written to a file: no local-only fields.
  serialize(skin) {
    const s = this.normalize(skin);
    return { name: s.name, author: s.author, vars: s.vars, opts: s.opts, css: s.css };
  },

  /* ───────── CSS filtering ─────────
     Mirrors _sanitize_css() in server.py. Both run: the server so a
     malicious skin never reaches the gallery, the client so a skin
     imported from a file (which never touched the server) gets the same
     treatment. */
  sanitizeCss(raw) {
    if (!raw) return '';
    let css = String(raw).slice(0, 4000);
    css = css.replace(/(@import|javascript\s*:|expression\s*\(|<\s*\/\s*style|behavior\s*:|-moz-binding)/gi, '');
    css = css.replace(/url\(\s*['"]?([^)'"]*)['"]?\s*\)/gi, (m, target) => {
      const t = (target || '').trim();
      return (t.startsWith('https://') || t.startsWith('data:image/')) ? m : 'none';
    });
    return css;
  },

  _safeUrl(url) {
    const u = String(url || '').trim();
    return u.startsWith('https://') ? u : '';
  },

  /* ───────── applying ───────── */

  apply(skin, { persist = true } = {}) {
    skin = this.normalize(skin);
    const root = document.documentElement;

    // Clear first so a skin that omits a variable falls back to the stock
    // value rather than inheriting the previous skin's.
    this._clearVars();
    for (const [k, v] of Object.entries(skin.vars || {})) {
      if (/^[a-z0-9-]{1,32}$/.test(k) && v) root.style.setProperty('--' + k, v);
    }

    this._ensureStyleEl().textContent = this._buildCss(skin);

    S.skins.active = skin;
    S.skins.activeId = skin._id || null;
    if (persist) {
      try { localStorage.setItem(LS_ACTIVE, JSON.stringify(skin)); } catch (_) {}
    }
  },

  _clearVars() {
    const root = document.documentElement;
    for (const { key } of SKIN_VARS) root.style.removeProperty('--' + key);
    root.style.removeProperty('--fn');
    root.style.removeProperty('--fm');
  },

  reset() {
    this._clearVars();
    this._ensureStyleEl().textContent = '';
    S.skins.active = null;
    S.skins.activeId = null;
    localStorage.removeItem(LS_ACTIVE);
    toast('Back to the default look', 'info', 1500);
  },

  // Turns the layout knobs into real rules. Everything here is additive on
  // top of style.css — nothing is overwritten that a skin didn't ask for.
  _buildCss(skin) {
    const o = { ...SKIN_OPT_DEFAULTS, ...(skin.opts || {}) };
    const out = [];

    if (Number(o.radius) > 0) {
      const r = Number(o.radius) + 'px';
      out.push(`.cfg-block,.hi,.overlay-btn,.cb,.qa,.add-btn,.preset-btn,.toast,
        .pl-item,#meaning-box,#si,#btn-srch,#chat-input,#chat-send,#src-sel,
        .si-th,.qi-th,.si-nth,.qi-nth,#flt-status{border-radius:${r}}`);
      out.push(`.cb.sm,.cb.lg{border-radius:${Math.min(Number(o.radius) * 2, 50)}%}`);
    }
    if (Number(o.artRadius) > 0) {
      out.push(`#art-wrap{border-radius:${o.artRadius}%;overflow:hidden}`);
    }

    // The stock grain lives in body::after with a fixed opacity baked into
    // the SVG; scaling the pseudo-element's own opacity moves it without
    // regenerating the image. 3 is the stock amount.
    const noise = Number(o.noise);
    if (noise !== 3) out.push(`body::after{opacity:${(noise / 3).toFixed(3)}}`);

    if (Number(o.glow) > 0) {
      const g = Number(o.glow);
      out.push(`.cb.lg,#btn-srch,.overlay-btn:not(.ghost),#chat-send{box-shadow:0 0 ${g}px color-mix(in srgb, var(--accent) 60%, transparent)}`);
      out.push(`.tab.on,.lobby-tab.on,.skin-tab.on{text-shadow:0 0 ${Math.round(g / 2)}px var(--accent)}`);
    }

    const d = Number(o.density);
    if (d && d !== 1) out.push(`body{font-size:${(14 * d).toFixed(2)}px}`);

    const bg = this._safeUrl(o.bgUrl);
    if (bg) {
      const dim = Math.max(0, Math.min(100, Number(o.bgDim))) / 100;
      out.push(`body{background-image:linear-gradient(color-mix(in srgb, var(--bg) ${Math.round(dim * 100)}%, transparent),
        color-mix(in srgb, var(--bg) ${Math.round(dim * 100)}%, transparent)),url("${bg}");
        background-size:cover;background-position:center;background-attachment:fixed}`);
      // The panels sit on top of the wallpaper, so they need to go
      // translucent or it's invisible behind them.
      out.push(`#left,#right,#tabs,.hdr,#main{background:transparent}`);
      out.push(`.pane,#left{backdrop-filter:blur(${Math.max(2, Number(o.bgBlur))}px)}`);
      out.push(`#left,#tabs,.hdr{background:color-mix(in srgb, var(--surf) 78%, transparent)}`);
      if (Number(o.bgBlur) > 0) out.push(`body{backdrop-filter:blur(${o.bgBlur}px)}`);
    }

    const custom = this.sanitizeCss(skin.css);
    if (custom) out.push(`/* custom */\n${custom}`);

    return out.join('\n');
  },

  /* ───────── local library ───────── */

  loadLibrary() {
    try {
      const raw = localStorage.getItem(LS_LIBRARY);
      S.skins.mine = raw ? JSON.parse(raw).map(s => this.normalize(s)) : [];
    } catch (_) { S.skins.mine = []; }
  },

  saveLibrary() {
    try { localStorage.setItem(LS_LIBRARY, JSON.stringify(S.skins.mine)); }
    catch (_) { toast('Browser storage is full — could not save skin', 'error'); }
  },

  saveDraft() {
    try { localStorage.setItem(LS_DRAFT, JSON.stringify(S.skins.draft)); } catch (_) {}
  },

  saveCurrent() {
    const draft = this.normalize(S.skins.draft);
    if (!draft.name || draft.name === 'Untitled Skin') {
      const name = prompt('Name this skin:', 'My Skin');
      if (!name) return;
      draft.name = name.slice(0, 40);
      document.getElementById('skin-name').value = draft.name;
    }
    // Saving over a skin with the same name replaces it instead of
    // accumulating near-identical copies every time you tweak a slider.
    const idx = S.skins.mine.findIndex(s => s.name === draft.name);
    if (idx >= 0) S.skins.mine[idx] = draft; else S.skins.mine.push(draft);
    S.skins.draft = draft;
    this.saveLibrary(); this.saveDraft();
    this.renderMine();
    toast(`Saved "${draft.name}"`, 'success', 2000);
  },

  deleteLocal(name) {
    S.skins.mine = S.skins.mine.filter(s => s.name !== name);
    this.saveLibrary();
    this.renderMine();
  },

  /* ───────── gallery ───────── */

  async publish() {
    if (!SkinAPI.available()) { toast('No server configured — publishing needs one', 'warn'); return; }
    const draft = this.normalize(S.skins.draft);
    if (!draft.author) {
      const who = prompt('Publish as:', localStorage.getItem('nl_display_name') || 'Anonymous');
      if (!who) return;
      draft.author = who.slice(0, 24);
      document.getElementById('skin-author').value = draft.author;
    }
    if (draft.css && !confirm(
      'This skin includes custom CSS.\n\nAnyone who installs it runs that CSS in their browser. ' +
      'It is filtered, but filtered CSS can still load remote images and hide parts of the interface.\n\nPublish anyway?'
    )) return;

    // Republishing an existing skin (we still hold its edit token) updates
    // it in place rather than spawning a duplicate in the gallery.
    const existing = S.skins.mine.find(s => s.name === draft.name && s._id);
    try {
      const r = await SkinAPI.publish(this.serialize(draft), existing?._id, existing?._editToken);
      draft._id = r.id; draft._editToken = r.editToken;
      const idx = S.skins.mine.findIndex(s => s.name === draft.name);
      if (idx >= 0) S.skins.mine[idx] = draft; else S.skins.mine.push(draft);
      S.skins.draft = draft;
      this.saveLibrary(); this.saveDraft(); this.renderMine();
      toast(existing ? 'Gallery entry updated' : 'Published to the gallery', 'success', 2500);
    } catch (e) { toast(`Publish failed: ${e.message}`, 'error', 5000); }
  },

  async unpublish(name) {
    const skin = S.skins.mine.find(s => s.name === name);
    if (!skin?._id || !skin._editToken) { toast('That skin was never published from this browser', 'warn'); return; }
    try {
      await SkinAPI.remove(skin._id, skin._editToken);
      skin._id = null; skin._editToken = null;
      this.saveLibrary(); this.renderMine();
      toast('Removed from the gallery', 'info', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  async refreshGallery(sort) {
    if (sort) S.skins.gallerySort = sort;
    const el = document.getElementById('skin-gallery');
    if (!SkinAPI.available()) {
      el.innerHTML = `<div class="empty small"><p>No server configured — the gallery needs one</p></div>`;
      return;
    }
    el.innerHTML = `<div class="empty small"><div class="dots"><span></span><span></span><span></span></div></div>`;
    try {
      S.skins.gallery = await SkinAPI.list(S.skins.gallerySort);
      this.renderGallery();
    } catch (e) {
      el.innerHTML = `<div class="empty small"><p>Could not load gallery: ${esc(e.message)}</p></div>`;
    }
  },

  async installFromGallery(id, { editToo = false } = {}) {
    try {
      const full = await SkinAPI.get(id);
      const skin = this.normalize({ ...full, _id: null, _editToken: null });
      if (skin.css && !confirm(
        `"${skin.name}" includes custom CSS from ${skin.author || 'an anonymous author'}.\n\n` +
        'Filtered CSS can still load remote images and hide parts of the interface. Apply it?'
      )) return;
      this.apply(skin);
      SkinAPI.countInstall(id);
      if (editToo) { S.skins.draft = skin; this.saveDraft(); this.renderEditor(); this._switchSkinTab('editor'); }
      toast(`Applied "${skin.name}"`, 'success', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  async saveFromGallery(id) {
    try {
      const full = await SkinAPI.get(id);
      const skin = this.normalize({ ...full, _id: null, _editToken: null });
      if (S.skins.mine.some(s => s.name === skin.name)) skin.name = `${skin.name} (copy)`.slice(0, 40);
      S.skins.mine.push(skin);
      this.saveLibrary(); this.renderMine();
      SkinAPI.countInstall(id);
      toast(`Saved "${skin.name}" to My Skins`, 'success', 2000);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  /* ───────── import / export ───────── */

  exportDraft() {
    const data = JSON.stringify(this.serialize(S.skins.draft), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(S.skins.draft.name || 'skin').replace(/[^\w.-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  importSkin() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const skin = this.normalize(JSON.parse(reader.result));
          S.skins.draft = skin;
          this.saveDraft(); this.renderEditor(); this.applyDraft();
          toast(`Loaded "${skin.name}"`, 'success', 2000);
        } catch (e) { toast('That file is not a valid skin', 'error'); }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  /* ═══════════════ rendering ═══════════════ */

  renderTab() {
    this.renderEditor();
    this.renderMine();
    if (!S.skins.gallery.length) this.refreshGallery();
  },

  _switchSkinTab(name) {
    document.querySelectorAll('.skin-tab').forEach(t => t.classList.toggle('on', t.dataset.stab === name));
    document.querySelectorAll('.skin-pane').forEach(p => p.classList.toggle('on', p.id === 'stab-' + name));
    if (name === 'browse' && !S.skins.gallery.length) this.refreshGallery();
  },

  // Push whatever the editor currently shows onto the live page. Called on
  // every input so the whole thing is a live preview rather than an
  // apply-and-hope form.
  applyDraft() {
    this.apply(S.skins.draft);
    this.saveDraft();
  },

  renderEditor() {
    const d = S.skins.draft = this.normalize(S.skins.draft);

    document.getElementById('skin-name').value = d.name === 'Untitled Skin' ? '' : d.name;
    document.getElementById('skin-author').value = d.author || '';
    document.getElementById('skin-css').value = d.css || '';

    // Presets
    const presets = document.getElementById('skin-presets');
    if (!presets.dataset.wired) {
      presets.innerHTML = Object.keys(SKIN_PRESETS).map(n =>
        `<button class="preset-btn" data-skinpreset="${esc(n)}">${esc(n.split(' (')[0])}</button>`).join('');
      presets.querySelectorAll('[data-skinpreset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = SKIN_PRESETS[btn.dataset.skinpreset];
          S.skins.draft = this.normalize({
            name: S.skins.draft.name, author: S.skins.draft.author,
            vars: { ...p.vars }, opts: { ...SKIN_OPT_DEFAULTS, ...p.opts }, css: S.skins.draft.css,
          });
          this.renderEditor(); this.applyDraft();
        });
      });
      presets.dataset.wired = '1';
    }

    // Colour pickers. Each row is a native colour input plus a text field,
    // because plenty of useful values (rgba, gradients, colour names) can't
    // be expressed in a colour picker.
    const colors = document.getElementById('skin-colors');
    colors.innerHTML = SKIN_VARS.map(v => {
      const val = d.vars[v.key] || this._defaults[v.key] || '#000000';
      const hex = /^#[0-9a-f]{6}$/i.test(val.trim()) ? val.trim() : this._toHex(val);
      return `<div class="skin-color" data-var="${v.key}">
        <input type="color" class="skin-swatch" value="${esc(hex)}" data-var="${v.key}" title="${esc(v.label)}">
        <div class="skin-color-meta">
          <span class="skin-color-label">${esc(v.label)}</span>
          <input type="text" class="skin-color-text hi" value="${esc(val)}" data-var="${v.key}" spellcheck="false">
        </div>
      </div>`;
    }).join('');
    colors.querySelectorAll('.skin-swatch').forEach(inp => {
      inp.addEventListener('input', () => {
        d.vars[inp.dataset.var] = inp.value;
        const txt = colors.querySelector(`.skin-color-text[data-var="${inp.dataset.var}"]`);
        if (txt) txt.value = inp.value;
        this.applyDraft();
      });
    });
    colors.querySelectorAll('.skin-color-text').forEach(inp => {
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        if (v) d.vars[inp.dataset.var] = v; else delete d.vars[inp.dataset.var];
        this.applyDraft();
      });
    });

    // Fonts
    const fd = document.getElementById('skin-font-display');
    const fm = document.getElementById('skin-font-mono');
    const fontOpts = (selected) => SKIN_FONTS.map(f =>
      `<option value="${esc(f.value)}" ${f.value === selected ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
    fd.innerHTML = fontOpts(d.vars.fn || this._defaults.fn);
    fm.innerHTML = fontOpts(d.vars.fm || this._defaults.fm);
    fd.onchange = () => { d.vars.fn = fd.value; this.applyDraft(); };
    fm.onchange = () => { d.vars.fm = fm.value; this.applyDraft(); };

    // Sliders + text opts
    const sliders = [
      ['skin-radius', 'radius'], ['skin-art-radius', 'artRadius'], ['skin-noise', 'noise'],
      ['skin-glow', 'glow'], ['skin-density', 'density'], ['skin-bg-dim', 'bgDim'], ['skin-bg-blur', 'bgBlur'],
    ];
    sliders.forEach(([id, key]) => {
      const el = document.getElementById(id);
      el.value = d.opts[key];
      document.getElementById(id + '-v').textContent = d.opts[key];
      el.oninput = () => {
        d.opts[key] = parseFloat(el.value);
        document.getElementById(id + '-v').textContent = el.value;
        this.applyDraft();
      };
    });

    const bgUrl = document.getElementById('skin-bg-url');
    bgUrl.value = d.opts.bgUrl || '';
    bgUrl.oninput = () => {
      const v = bgUrl.value.trim();
      d.opts.bgUrl = v;
      bgUrl.classList.toggle('bad', !!v && !v.startsWith('https://'));
      this.applyDraft();
    };

    document.getElementById('skin-name').oninput = e => { d.name = e.target.value.trim() || 'Untitled Skin'; this.saveDraft(); };
    document.getElementById('skin-author').oninput = e => { d.author = e.target.value.trim(); this.saveDraft(); };
    document.getElementById('skin-css').oninput = e => { d.css = e.target.value; this.applyDraft(); };
  },

  // Best-effort colour -> hex for seeding the native picker. Anything the
  // browser can't resolve just falls back to black; the text field beside
  // it still holds the real value, so nothing is lost.
  _toHex(value) {
    try {
      const probe = document.createElement('div');
      probe.style.color = '';
      probe.style.color = value;
      if (!probe.style.color) return '#000000';
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      const m = rgb.match(/\d+/g);
      if (!m) return '#000000';
      return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    } catch (_) { return '#000000'; }
  },

  _swatches(vars) {
    const pick = ['bg', 'surf2', 'accent', 'accent2', 'text'];
    return pick.map(k => {
      const c = vars[k] || this._defaults[k] || 'transparent';
      return `<span class="skin-sw" style="background:${esc(c)}"></span>`;
    }).join('');
  },

  renderMine() {
    const el = document.getElementById('skin-mine-list');
    document.getElementById('skins-mine-count').textContent = S.skins.mine.length ? `(${S.skins.mine.length})` : '';
    if (!S.skins.mine.length) {
      el.innerHTML = `<div class="empty small"><p>No saved skins yet — build one in the Editor and hit Save</p></div>`;
      return;
    }
    el.innerHTML = S.skins.mine.map(s => `
      <div class="skin-card" data-name="${esc(s.name)}">
        <div class="skin-card-swatches">${this._swatches(s.vars)}</div>
        <div class="skin-card-meta">
          <div class="skin-card-name">${esc(s.name)}${s._id ? '<span class="skin-badge pub">PUBLISHED</span>' : ''}${s.css ? '<span class="skin-badge css">CSS</span>' : ''}</div>
          <div class="skin-card-author">${esc(s.author || 'no author')}</div>
        </div>
        <div class="skin-card-acts">
          <button class="add-btn" data-sa="apply">Apply</button>
          <button class="add-btn" data-sa="edit">Edit</button>
          ${s._id ? '<button class="add-btn" data-sa="unpublish">Unpublish</button>' : ''}
          <button class="add-btn" data-sa="del">✕</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.skin-card').forEach(card => {
      const name = card.dataset.name;
      card.querySelectorAll('[data-sa]').forEach(btn => btn.addEventListener('click', () => {
        const skin = S.skins.mine.find(s => s.name === name);
        if (!skin) return;
        switch (btn.dataset.sa) {
          case 'apply': this.apply(skin); toast(`Applied "${skin.name}"`, 'success', 1500); break;
          case 'edit': S.skins.draft = this.normalize(skin); this.saveDraft(); this.renderEditor(); this.applyDraft(); this._switchSkinTab('editor'); break;
          case 'unpublish': this.unpublish(name); break;
          case 'del':
            if (confirm(`Delete "${name}" from this browser?`)) this.deleteLocal(name);
            break;
        }
      }));
    });
  },

  renderGallery() {
    const el = document.getElementById('skin-gallery');
    const list = S.skins.gallery || [];
    if (!list.length) {
      el.innerHTML = `<div class="empty small"><p>Nothing published yet — be the first</p></div>`;
      return;
    }
    el.innerHTML = list.map(s => `
      <div class="skin-card" data-id="${esc(s.id)}">
        <div class="skin-card-swatches">${this._swatches(s.vars || {})}</div>
        <div class="skin-card-meta">
          <div class="skin-card-name">${esc(s.name)}${s.hasCss ? '<span class="skin-badge css" title="Includes custom CSS">CSS</span>' : ''}</div>
          <div class="skin-card-author">by ${esc(s.author || 'Anonymous')} · ${s.installs || 0} installs</div>
        </div>
        <div class="skin-card-acts">
          <button class="add-btn pnow" data-ga="apply">Apply</button>
          <button class="add-btn" data-ga="save">Save</button>
          <button class="add-btn" data-ga="fork">Edit</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.skin-card').forEach(card => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-ga]').forEach(btn => btn.addEventListener('click', () => {
        if (btn.dataset.ga === 'apply') this.installFromGallery(id);
        else if (btn.dataset.ga === 'save') this.saveFromGallery(id);
        else this.installFromGallery(id, { editToo: true });
      }));
    });
  },
};