'use strict';
/* ═══════════════════════════════════════════
   Library — saved tracks, albums and playlists, kept in this browser's
   localStorage so they can be queued (or shuffle-queued) without searching
   again. Backs the Library tab (the first tab).

   Everything is stored as a "library item":
     { id, kind: 'track' | 'collection', name, author, artwork,
       source,            // the link it was resolved from (collections), used by Refresh
       tracks: [track…],  // full NodeLink track objects (a 'track' item holds exactly one)
       added }
   Collections (albums / playlists / several links) keep a snapshot of their
   tracks, so queueing is instant and doesn't hit the node. Refresh re-resolves
   the source link to pick up changes.
═══════════════════════════════════════════ */
const Library = {
  KEY: 'nl_library',
  items: [],
  _open: new Set(),   // ids of expanded collections
  _filter: '',

  /* ───────── persistence ───────── */
  init() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEY) || '[]');
      if (Array.isArray(saved)) this.items = saved.filter(i => i && i.id && Array.isArray(i.tracks) && i.tracks.length);
    } catch (_) { this.items = []; }

    const $ = id => document.getElementById(id);
    $('btn-lib-add').addEventListener('click', () => this.addFromInput());
    $('lib-in').addEventListener('keydown', e => { if (e.key === 'Enter') this.addFromInput(); });
    $('lib-filter').addEventListener('input', e => { this._filter = e.target.value.trim().toLowerCase(); this.render(); });
    $('btn-lib-qall').addEventListener('click', () => this._bulk(this._visibleTracks(), false, 'library'));
    $('btn-lib-sall').addEventListener('click', () => this._bulk(this._visibleTracks(), true, 'library'));
    $('lib-list').addEventListener('click', e => this._onListClick(e));
    this.render();
  },

  _save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.items)); return true; }
    catch (e) {
      toast('Could not save the library — browser storage is full', 'error');
      return false;
    }
  },

  /* ───────── helpers ───────── */
  _slim(t) {            // a plain copy without per-session fields like `requester`
    const c = JSON.parse(JSON.stringify(t));
    delete c.requester;
    return c;
  },
  _clone(t) { return this._slim(t); },
  _key(t) { return t.encoded || (t.info && (t.info.uri || t.info.identifier)) || ''; },
  _newId() { return 'lib_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
  _uniq(tracks) {
    const seen = new Set(), out = [];
    for (const t of tracks) {
      const k = this._key(t);
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(t);
    }
    return out;
  },
  _shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },
  _matches(item) {
    if (!this._filter) return true;
    const hay = [item.name, item.author, ...(item.kind === 'collection' ? item.tracks.map(t => t.info.title + ' ' + t.info.author) : [])]
      .join(' ').toLowerCase();
    return hay.includes(this._filter);
  },
  _visibleTracks() {
    return this._uniq(this.items.filter(i => this._matches(i)).flatMap(i => i.tracks));
  },

  /* ───────── adding ───────── */
  hasTrack(t) { const k = this._key(t); return !!k && this.items.some(i => i.kind === 'track' && this._key(i.tracks[0]) === k); },

  addTrack(track, { quiet = false } = {}) {
    if (!track || !track.info) return false;
    if (this.hasTrack(track)) { if (!quiet) toast('Already in your library', 'info', 1800); return false; }
    this.items.unshift({
      id: this._newId(), kind: 'track',
      name: track.info.title, author: track.info.author, artwork: track.info.artworkUrl || '',
      source: track.info.uri || '', tracks: [this._slim(track)], added: Date.now(),
    });
    if (!this._save()) { this.items.shift(); return false; }
    this.render();
    if (!quiet) toast(`Saved to library: ${track.info.title}`, 'success', 2000);
    return true;
  },

  addCollection({ name, source, artwork, tracks, author }, { quiet = false } = {}) {
    tracks = this._uniq((tracks || []).filter(t => t && t.info));
    if (!tracks.length) { if (!quiet) toast('Nothing to save', 'warn'); return false; }
    if (source && this.items.some(i => i.kind === 'collection' && i.source === source)) {
      if (!quiet) toast('Already in your library', 'info', 1800);
      return false;
    }
    this.items.unshift({
      id: this._newId(), kind: 'collection',
      name: name || 'Untitled collection',
      author: author || tracks[0].info.author || '',
      artwork: artwork || tracks[0].info.artworkUrl || '',
      source: source || '', tracks: tracks.map(t => this._slim(t)), added: Date.now(),
    });
    if (!this._save()) { this.items.shift(); return false; }
    this.render();
    if (!quiet) toast(`Saved to library: ${name || 'collection'} (${tracks.length} tracks)`, 'success', 2200);
    return true;
  },

  // Turns whatever a loadtracks call returned into library items.
  _addResolved(data, link) {
    if (!data) return 0;
    if (data.loadType === 'track') return this.addTrack(data.data, { quiet: true }) ? 1 : 0;
    if (data.loadType === 'playlist') {
      const info = data.data.info || {};
      const plugin = data.data.pluginInfo || {};
      return this.addCollection({
        name: info.name || 'Playlist', source: link,
        artwork: plugin.artworkUrl || plugin.artwork || '',
        author: plugin.author || '', tracks: data.data.tracks,
      }, { quiet: true }) ? 1 : 0;
    }
    if (data.loadType === 'search') {      // a link that resolved to a list of results
      const list = data.data || [];
      return list.length === 1 ? (this.addTrack(list[0], { quiet: true }) ? 1 : 0)
        : this.addCollection({ name: 'Saved results', source: link, tracks: list }, { quiet: true }) ? 1 : 0;
    }
    return 0;
  },

  async addFromInput() {
    const input = document.getElementById('lib-in');
    const links = [...new Set(input.value.split(/[\s,]+/).filter(Boolean))];
    if (!links.length) { toast('Paste a track, album or playlist link', 'warn'); return; }
    const bad = links.filter(l => !/^https?:\/\/\S+$/i.test(l));
    if (bad.length) { toast('The library takes links — to save something you searched for, use the bookmark button in Search', 'warn', 4500); return; }

    const btn = document.getElementById('btn-lib-add');
    btn.disabled = true;
    const prev = btn.textContent; btn.textContent = 'Adding…';
    let added = 0, failed = 0, dup = 0;
    try {
      const settled = await Promise.allSettled(links.map(l => Backend.loadtracks(l)));
      settled.forEach((r, i) => {
        const d = r.status === 'fulfilled' ? r.value : null;
        if (!d || d.loadType === 'empty' || d.loadType === 'error') { failed++; return; }
        this._addResolved(d, links[i]) ? added++ : dup++;
      });
    } finally { btn.disabled = false; btn.textContent = prev; }

    if (added) { input.value = ''; toast(`Saved ${added} item${added !== 1 ? 's' : ''} to your library`, 'success', 2200); }
    if (dup) toast(`${dup} already in your library`, 'info', 2000);
    if (failed) toast(`${failed} link${failed !== 1 ? 's' : ''} could not be loaded`, 'warn');
  },

  async refresh(id) {
    const item = this.items.find(i => i.id === id);
    if (!item || !item.source) return;
    try {
      const d = await Backend.loadtracks(item.source);
      let tracks = [];
      if (d && d.loadType === 'playlist') tracks = d.data.tracks || [];
      else if (d && d.loadType === 'search') tracks = d.data || [];
      else if (d && d.loadType === 'track') tracks = [d.data];
      tracks = this._uniq(tracks);
      if (!tracks.length) { toast('Could not refresh — nothing came back', 'warn'); return; }
      const delta = tracks.length - item.tracks.length;
      item.tracks = tracks.map(t => this._slim(t));
      if (this._save()) { this.render(); toast(`Refreshed ${item.name} (${delta >= 0 ? '+' : ''}${delta})`, 'success', 2200); }
    } catch (e) { toast(`Refresh failed: ${e.message}`, 'error'); }
  },

  remove(id) {
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return;
    const [gone] = this.items.splice(i, 1);
    this._open.delete(id);
    this._save(); this.render();
    toast(`Removed ${gone.name} from library`, 'info', 1800);
  },

  /* ───────── queueing ───────── */
  async _bulk(tracks, shuffle, label) {
    if (!tracks.length) { toast('Nothing to queue', 'warn'); return; }
    const copies = tracks.map(t => this._clone(t));
    await Engine.addAllToQueue(copies, { shuffle });
    toast(`${shuffle ? 'Shuffle-added' : 'Added'} ${copies.length} track${copies.length !== 1 ? 's' : ''}${label ? ' from ' + label : ''}`, 'success', 2500);
  },

  async _playOrQueue(t) {
    const copy = this._clone(t);
    if (S.current) {
      const ok = await Engine.addToQueue(copy, { silent: true });
      if (ok) toast(`Queued from library: ${copy.info.title}`, 'success', 2500);
    } else {
      if (S.mode === 'standalone') { S.queue = []; if (S.current) S.history.push(S.current); }
      Engine.playTrack(copy);
    }
  },

  /* ───────── rendering ───────── */
  _thumb(src, cls, icon) {
    return src
      ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="${cls.replace('th', 'nth')}"><span class="material-symbols-outlined">${icon}</span></div>`;
  },

  render() {
    const list = document.getElementById('lib-list');
    if (!list) return;
    const info = document.getElementById('lib-info');
    const nTracks = new Set(this.items.flatMap(i => i.tracks.map(t => this._key(t)))).size;
    info.textContent = this.items.length
      ? `${this.items.length} saved · ${nTracks} track${nTracks !== 1 ? 's' : ''}`
      : 'Library empty';
    const badge = document.getElementById('lib-badge');
    if (badge) badge.textContent = this.items.length ? `(${this.items.length})` : '';
    const none = !this.items.length;
    ['btn-lib-qall', 'btn-lib-sall'].forEach(id => { document.getElementById(id).disabled = none; });

    if (none) {
      list.innerHTML = `<div class="empty"><span class="material-symbols-outlined">library_music</span><p>Paste a link above, or tap the bookmark on any search result,<br>to keep tracks, albums and playlists here</p></div>`;
      return;
    }
    const shown = this.items.filter(i => this._matches(i));
    if (!shown.length) { list.innerHTML = `<div class="empty"><p>No matches</p></div>`; return; }

    list.innerHTML = shown.map(item => {
      const isCol = item.kind === 'collection';
      const open = isCol && (this._open.has(item.id) || !!this._filter);
      const count = item.tracks.length;
      const sub = isCol
        ? `${count} track${count !== 1 ? 's' : ''}${item.author ? ' · ' + esc(item.author) : ''}`
        : esc(item.author || '');
      const dur = fmt(item.tracks.reduce((a, t) => a + (t.info.length || 0), 0));
      const acts = isCol
        ? `<button class="add-btn" data-la="queue" title="Add every track to the queue"><span class="material-symbols-outlined m-ico">playlist_add</span><span class="lbl">Queue</span></button>
           <button class="add-btn" data-la="shuffle" title="Shuffle these tracks, then add them to the queue"><span class="material-symbols-outlined m-ico">shuffle</span><span class="lbl">Shuffle</span></button>
           ${item.source ? `<button class="add-btn" data-la="refresh" title="Re-fetch from the original link"><span class="material-symbols-outlined">refresh</span></button>` : ''}`
        : `<button class="add-btn pnow" data-la="play" title="Play"><span class="material-symbols-outlined">play_arrow</span><span class="lbl">Play</span></button>
           <button class="add-btn" data-la="queue" title="Add to queue"><span class="material-symbols-outlined m-ico">playlist_add</span><span class="lbl">Queue</span></button>`;
      let html = `<div class="lib-item ${isCol ? 'col' : ''} ${open ? 'open' : ''}" data-id="${esc(item.id)}">
        <div class="si lib-row" data-la="${isCol ? 'toggle' : ''}">
          ${isCol ? `<span class="material-symbols-outlined lib-chev">${open ? 'expand_more' : 'chevron_right'}</span>` : ''}
          ${this._thumb(item.artwork, 'si-th', isCol ? 'library_music' : 'music_note')}
          <div class="si-meta">
            <div class="si-t">${esc(item.name)}</div>
            <div class="si-a">${sub}</div>
          </div>
          <div class="si-acts lib-acts">${acts}
            <button class="add-btn lib-del" data-la="remove" title="Remove from library"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <span class="si-d">${isCol ? dur : fmt(item.tracks[0].info.length)}</span>
        </div>`;
      if (open) {
        html += `<div class="lib-sub">` + item.tracks.map((t, i) => `
          <div class="si lib-trow" data-ti="${i}">
            ${this._thumb(t.info.artworkUrl, 'si-th', 'music_note')}
            <div class="si-meta"><div class="si-t">${esc(t.info.title)}</div><div class="si-a">${esc(t.info.author)}</div></div>
            <div class="si-acts">
              <button class="add-btn pnow" data-la="tplay" data-ti="${i}" title="Play"><span class="material-symbols-outlined">play_arrow</span></button>
              <button class="add-btn" data-la="tqueue" data-ti="${i}" title="Add to queue"><span class="material-symbols-outlined m-ico">playlist_add</span></button>
            </div>
            <span class="si-d">${fmt(t.info.length)}</span>
          </div>`).join('') + `</div>`;
      }
      return html + `</div>`;
    }).join('');
    UI.applyLockState();   // Play buttons follow the host/DJ lock
  },

  _onListClick(e) {
    const btn = e.target.closest('[data-la]');
    if (!btn || btn.disabled) return;
    const wrap = btn.closest('.lib-item');
    const item = wrap && this.items.find(i => i.id === wrap.dataset.id);
    if (!item) return;
    const a = btn.dataset.la;
    if (a === 'toggle') {
      if (e.target.closest('.lib-acts')) return;
      this._open.has(item.id) ? this._open.delete(item.id) : this._open.add(item.id);
      this.render();
    } else if (a === 'play') this._playOrQueue(item.tracks[0]);
    else if (a === 'queue') this._bulk(item.tracks, false, item.kind === 'collection' ? item.name : '');
    else if (a === 'shuffle') this._bulk(item.tracks, true, item.name);
    else if (a === 'refresh') this.refresh(item.id);
    else if (a === 'remove') this.remove(item.id);
    else if (a === 'tplay') this._playOrQueue(item.tracks[+btn.dataset.ti]);
    else if (a === 'tqueue') {
      const t = item.tracks[+btn.dataset.ti];
      Engine.addToQueue(this._clone(t));
    }
  },
};
