'use strict';
/* ═══════════════════════════════════════════
   Downloads — the download manager behind the Downloads tab.

   Downloads used to be a plain navigation to /api/download (see
   DownloadAPI.url), which the browser handled invisibly. They now go through
   fetch() so the app can show what's happening:
     queued      → waiting for a free slot (CONCURRENCY at a time — the server
                   encodes each track in full, which is CPU-heavy)
     preparing   → request sent, the server is pulling + encoding the audio
     downloading → bytes arriving (percentage when the server reports a size)
     done        → saved to the browser's downloads via a temporary blob link
     error / canceled

   The audio is held in memory until the file is complete, then handed to the
   browser as a normal download. Finished entries (not in-flight ones) are
   remembered in localStorage so the tab survives a reload.
═══════════════════════════════════════════ */
const Downloads = {
  KEY: 'nl_downloads',
  KEEP: 50,
  CONCURRENCY: 2,
  EXT: { opus: 'ogg', mp3: 'mp3', wav: 'wav' },
  LABEL: { opus: 'Opus', mp3: 'MP3', wav: 'WAV' },

  items: [],
  _seq: 0,
  _sig: '',
  _renderTimer: 0,
  _wired: false,

  /* ───────── lifecycle ───────── */
  init() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEY) || '[]');
      if (Array.isArray(saved)) {
        saved.forEach(s => {
          if (!s || !['done', 'error', 'canceled'].includes(s.status)) return;
          this.items.push(Object.assign({ id: ++this._seq, loaded: 0, total: 0, size: 0, error: '', ctrl: null }, s, { id: ++this._seq }));
        });
      }
    } catch (_) {}
    this._wire();
    this.render();
  },

  _persist() {
    try {
      const fin = this.items.filter(i => ['done', 'error', 'canceled'].includes(i.status))
        .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, this.KEEP)
        .map(i => ({ encoded: i.encoded, title: i.title, author: i.author, artwork: i.artwork, length: i.length,
                     format: i.format, status: i.status, size: i.size, error: i.error,
                     addedAt: i.addedAt, finishedAt: i.finishedAt }));
      localStorage.setItem(this.KEY, JSON.stringify(fin));
    } catch (_) {}
  },

  isActive(i) { return i.status === 'queued' || i.status === 'preparing' || i.status === 'downloading'; },
  activeCount() { return this.items.filter(i => this.isActive(i)).length; },

  /* ───────── public: add tracks ───────── */
  add(tracks, format) {
    if (!DownloadAPI.available()) { toast('Downloads need a server connection', 'warn'); return 0; }
    if (!this.EXT[format]) return 0;
    const list = (Array.isArray(tracks) ? tracks : [tracks]).filter(t => t && t.encoded);
    if (!list.length) { toast('Nothing to download', 'warn'); return 0; }
    let added = 0, dup = 0;
    for (const t of list) {
      if (this.items.some(i => i.encoded === t.encoded && i.format === format && this.isActive(i))) { dup++; continue; }
      this.items.push({
        id: ++this._seq, encoded: t.encoded,
        title: t.info?.title || 'Unknown title', author: t.info?.author || '',
        artwork: t.info?.artworkUrl || '', length: t.info?.length || 0,
        format, status: 'queued', loaded: 0, total: 0, size: 0, error: '',
        addedAt: Date.now(), finishedAt: 0, ctrl: null,
      });
      added++;
    }
    if (!added) { toast('Already downloading', 'info', 2200); return 0; }
    if (added === 1) toast(`Downloading "${list[0].info?.title || 'track'}" — this can take a moment`, 'info', 3000);
    else toast(`Downloading ${added} tracks${dup ? ` (${dup} already in progress)` : ''} — see the Downloads tab`, 'info', 3500);
    this._pump();
    this.render();
    return added;
  },

  /* ───────── queue runner ───────── */
  _pump() {
    let running = this.items.filter(i => i.status === 'preparing' || i.status === 'downloading').length;
    for (const it of this.items) {
      if (running >= this.CONCURRENCY) break;
      if (it.status === 'queued') { running++; this._run(it); }
    }
  },

  _filename(it) {
    const base = (it.author ? `${it.author} - ${it.title}` : it.title)
      .replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 120) || 'track';
    return `${base}.${this.EXT[it.format]}`;
  },

  async _run(it) {
    it.status = 'preparing'; it.loaded = 0; it.total = 0; it.error = '';
    it.ctrl = new AbortController();
    this.render();
    try {
      const res = await fetch(DownloadAPI.url({ encoded: it.encoded, info: { title: it.title, author: it.author } }, it.format),
                              { signal: it.ctrl.signal });
      if (!res.ok) {
        let msg = `Server returned ${res.status}`;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      it.total = Number(res.headers.get('Content-Length')) || 0;
      it.status = 'downloading';
      this.render();
      const type = res.headers.get('Content-Type') || 'application/octet-stream';
      let blob;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          it.loaded += value.length;
          this._scheduleRender();
        }
        blob = new Blob(chunks, { type });
      } else {
        blob = await res.blob();
        it.loaded = blob.size;
      }
      it.size = blob.size; it.total = it.total || blob.size; it.loaded = blob.size;
      it.status = 'done'; it.finishedAt = Date.now();
      this._save(blob, this._filename(it));
    } catch (e) {
      it.finishedAt = Date.now();
      if (e && e.name === 'AbortError') { it.status = 'canceled'; it.error = ''; }
      else {
        it.status = 'error';
        it.error = /Failed to fetch|NetworkError/i.test(e.message || '') ? 'Could not reach the server' : (e.message || 'Download failed');
      }
    } finally {
      it.ctrl = null;
      this._persist();
      this.render();
      this._pump();
    }
  },

  _save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },

  /* ───────── actions ───────── */
  cancel(id) {
    const it = this.items.find(i => i.id === id);
    if (!it || !this.isActive(it)) return;
    if (it.ctrl) { it.ctrl.abort(); return; }          // _run's catch finishes the bookkeeping
    it.status = 'canceled'; it.finishedAt = Date.now();  // was only queued
    this._persist(); this.render();
  },
  cancelAll() { this.items.filter(i => this.isActive(i)).forEach(i => this.cancel(i.id)); },
  retry(id) {
    const it = this.items.find(i => i.id === id);
    if (!it || this.isActive(it)) return;
    it.status = 'queued'; it.error = ''; it.loaded = 0; it.total = 0;
    this._pump(); this.render();
  },
  remove(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) return;
    if (it.ctrl) it.ctrl.abort();
    this.items = this.items.filter(i => i.id !== id);
    this._persist(); this.render();
  },
  clearFinished() {
    this.items = this.items.filter(i => this.isActive(i));
    this._persist(); this.render();
  },

  /* ───────── UI ───────── */
  _wire() {
    if (this._wired) return;
    this._wired = true;
    const list = document.getElementById('dl-list');
    if (list) list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (!b) return;
      const id = parseInt(b.closest('.dl-item').dataset.id, 10);
      const a = b.dataset.dl;
      if (a === 'cancel') this.cancel(id); else if (a === 'retry') this.retry(id); else if (a === 'rm') this.remove(id);
    });
    const clr = document.getElementById('btn-dl-clear');
    if (clr) clr.addEventListener('click', () => this.clearFinished());
    const can = document.getElementById('btn-dl-cancel');
    if (can) can.addEventListener('click', () => this.cancelAll());
  },

  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => { this._renderTimer = 0; this.render(); }, 150);
  },

  _size(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  },

  _status(it) {
    switch (it.status) {
      case 'queued': return 'Waiting…';
      case 'preparing': return 'Preparing…';
      case 'downloading': return it.total ? `${Math.min(100, Math.floor(it.loaded / it.total * 100))}% · ${this._size(it.loaded)} / ${this._size(it.total)}` : this._size(it.loaded);
      case 'done': return `Done · ${this._size(it.size)}`;
      case 'canceled': return 'Canceled';
      default: return it.error || 'Failed';
    }
  },

  _pct(it) {
    if (it.status === 'done') return 100;
    if (it.status === 'downloading' && it.total) return Math.min(100, it.loaded / it.total * 100);
    return 0;
  },

  _ordered() {
    const act = this.items.filter(i => this.isActive(i));
    const fin = this.items.filter(i => !this.isActive(i)).sort((a, b) => b.finishedAt - a.finishedAt);
    return act.concat(fin);
  },

  render() {
    const badge = document.getElementById('dl-badge');
    const active = this.activeCount();
    if (badge) badge.textContent = active > 0 ? `(${active})` : '';

    const list = document.getElementById('dl-list');
    if (!list) return;
    const done = this.items.filter(i => i.status === 'done').length;
    const failed = this.items.filter(i => i.status === 'error' || i.status === 'canceled').length;
    const info = document.getElementById('dl-info');
    if (info) {
      const parts = [];
      if (active) parts.push(`${active} active`);
      if (done) parts.push(`${done} completed`);
      if (failed) parts.push(`${failed} failed/canceled`);
      info.textContent = parts.length ? parts.join(' · ') : 'No downloads yet';
    }
    const can = document.getElementById('btn-dl-cancel');
    if (can) can.disabled = !active;
    const clr = document.getElementById('btn-dl-clear');
    if (clr) clr.disabled = active === this.items.length;

    const ordered = this._ordered();
    const sig = ordered.map(i => `${i.id}:${i.status}`).join(',');
    if (sig === this._sig) {                         // same rows, same states: just move the bars
      ordered.forEach(it => {
        const row = list.querySelector(`.dl-item[data-id="${it.id}"]`);
        if (!row) return;
        const bar = row.querySelector('.dl-bar i');
        if (bar) bar.style.width = this._pct(it) + '%';
        const st = row.querySelector('.dl-st');
        const txt = this._status(it);
        if (st && st.textContent !== txt) st.textContent = txt;
      });
      return;
    }
    this._sig = sig;
    if (!ordered.length) {
      list.innerHTML = `<div class="empty"><span class="material-symbols-outlined">download</span><p>Downloads you start will show up here</p></div>`;
      return;
    }
    list.innerHTML = ordered.map(it => {
      const thumb = it.artwork
        ? `<img class="qi-th" src="${esc(it.artwork)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="qi-nth"><span class="material-symbols-outlined">music_note</span></div>`;
      const btns = this.isActive(it)
        ? `<button class="qib del" data-dl="cancel" title="Cancel"><span class="material-symbols-outlined">close</span></button>`
        : `${it.status !== 'done' ? `<button class="qib" data-dl="retry" title="Retry"><span class="material-symbols-outlined">refresh</span></button>` : `<button class="qib" data-dl="retry" title="Download again"><span class="material-symbols-outlined">download</span></button>`}
           <button class="qib del" data-dl="rm" title="Remove from list"><span class="material-symbols-outlined">delete</span></button>`;
      return `<div class="dl-item ${it.status}" data-id="${it.id}">
        ${thumb}
        <div class="dl-m">
          <div class="dl-t">${esc(it.title)}</div>
          <div class="dl-a">${esc(it.author)}</div>
          <div class="dl-bar"><i style="width:${this._pct(it)}%"></i></div>
        </div>
        <span class="dl-fmt">${esc(this.LABEL[it.format] || it.format)}</span>
        <span class="dl-st">${esc(this._status(it))}</span>
        <div class="qi-bs dl-bs">${btns}</div>
      </div>`;
    }).join('');
  },
};