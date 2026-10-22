'use strict';
/* ═══════════════════════════════════════════
   Library — saved tracks, albums and playlists, kept in this browser's
   IndexedDB (one record per library item, so adding/removing one item only
   rewrites that item) so they can be queued (or shuffle-queued) without
   searching again. Backs the Library tab (the first tab).

   Older versions kept the library in localStorage ('nl_library'); that data is
   migrated into IndexedDB automatically on first load.

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

  /* ───────── persistence (IndexedDB) ───────── */
  DB_NAME: 'nl_library_db',
  STORE: 'items',
  _db: null,
  _ready: null,
  _persistWarned: false,

  init() {
    const $ = id => document.getElementById(id);
    $('btn-lib-add').addEventListener('click', () => this.addFromInput());
    $('lib-in').addEventListener('keydown', e => { if (e.key === 'Enter') this.addFromInput(); });
    $('lib-filter').addEventListener('input', e => { this._filter = e.target.value.trim().toLowerCase(); this._lLimit = this._LCHUNK; this._subLimit.clear(); this.render(); });
    $('btn-lib-qall').addEventListener('click', () => this._bulk(this._visibleTracks(), false, 'library'));
    $('btn-lib-sall').addEventListener('click', () => this._bulk(this._visibleTracks(), true, 'library'));
    $('lib-list').addEventListener('click', e => this._onListClick(e));
    if (!('IntersectionObserver' in window)) {   // fallback for progressive loading
      let raf = 0;
      const check = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this._lCheck(); }); };
      window.addEventListener('scroll', check, { passive: true });
      window.addEventListener('resize', check, { passive: true });
      $('lib-list').addEventListener('scroll', check, { passive: true });
    }
    $('btn-lib-export').addEventListener('click', () => this.exportJson());
    $('btn-lib-import').addEventListener('click', () => $('lib-import-file').click());
    $('lib-import-file').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';          // so picking the same file twice still fires
      if (f) await this.importFile(f);
    });
    this.render();
    this._ready = this._load();
  },

  _openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.STORE)) db.createObjectStore(this.STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
  },

  // Runs fn(store) inside one transaction and resolves when it commits.
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!this._db) { reject(new Error('library storage is not available')); return; }
      const tx = this._db.transaction(this.STORE, mode);
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      out = fn(tx.objectStore(this.STORE), tx);
    });
  },

  async _load() {
    try {
      this._db = await this._openDb();
      const stored = await new Promise((resolve, reject) => {
        const all = [];
        this._tx('readonly', st => {
          const req = st.getAll();
          req.onsuccess = () => all.push(...req.result);
        }).then(() => resolve(all), reject);
      });

      // One-time migration from the old localStorage-based library (store.js has
      // already moved that key into the Store, so it is read from there).
      let legacy = [];
      try {
        const raw = Store.getItem('nl_library');
        if (raw) legacy = JSON.parse(raw);
      } catch (_) { legacy = []; }
      legacy = Array.isArray(legacy) ? legacy.filter(i => i && i.id && Array.isArray(i.tracks) && i.tracks.length) : [];
      const have = new Set(stored.map(i => i.id));
      const toMove = legacy.filter(i => !have.has(i.id));
      if (toMove.length) {
        await this._tx('readwrite', st => toMove.forEach(i => st.put(i)));
        stored.push(...toMove);
      }
      if (legacy.length || Store.getItem('nl_library') !== null) {
        try { Store.removeItem('nl_library'); } catch (_) {}
        if (toMove.length) toast(`Moved ${toMove.length} library item${toMove.length !== 1 ? 's' : ''} to IndexedDB`, 'info', 2500);
      }

      // Anything added while we were loading is already in this.items — merge, newest first.
      const known = new Set(this.items.map(i => i.id));
      const loaded = stored.filter(i => i && i.id && Array.isArray(i.tracks) && i.tracks.length && !known.has(i.id));
      this.items = [...this.items, ...loaded].sort((a, b) => (b.added || 0) - (a.added || 0));
    } catch (e) {
      this._db = null;
      console.error('Library storage error:', e);
      if (!this._persistWarned) {
        this._persistWarned = true;
        toast('Library storage is unavailable in this browser — saves will last only until you close the page', 'warn', 6000);
      }
    }
    this.render();
  },

  // Writes happen in the background; the in-memory list (what's rendered) is
  // updated first. If a write fails, onFail() lets the caller undo the change.
  async _persist(item, onFail) {
    try {
      await this._ready;
      if (!this._db) return;   // no storage → memory-only (already warned)
      await this._tx('readwrite', st => st.put(JSON.parse(JSON.stringify(item))));
    } catch (e) {
      console.error('Library save failed:', e);
      toast('Could not save to library storage — ' + (e && e.name === 'QuotaExceededError' ? 'the browser is out of space' : 'write failed'), 'error', 5000);
      if (onFail) onFail();
    }
  },

  async _unpersist(id) {
    try {
      await this._ready;
      if (!this._db) return;
      await this._tx('readwrite', st => st.delete(id));
    } catch (e) { console.error('Library delete failed:', e); }
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
  // Does this track's title / author contain the filter?
  _tHit(t) {
    const q = this._filter;
    if (!q) return true;
    const ti = String((t.info && t.info.title) || '').toLowerCase();
    const au = String((t.info && t.info.author) || '').toLowerCase();
    return ti.includes(q) || au.includes(q) || (ti + ' ' + au).includes(q);
  },
  // What to show for one item under the current filter:
  //   rows — [{ t, i }] the tracks to list (i = index into item.tracks, so the
  //          row buttons keep pointing at the right track while filtered)
  //   hit  — whether the item survives the filter at all
  // A playlist with track hits lists ONLY those tracks. A playlist hit by name
  // or author alone (no track hits) still lists everything, since the playlist
  // itself is what matched.
  _view(item) {
    const all = item.tracks.map((t, i) => ({ t, i }));
    const q = this._filter;
    if (!q) return { rows: all, hit: true, filtered: false };
    const selfHit = String(item.name || '').toLowerCase().includes(q) || String(item.author || '').toLowerCase().includes(q);
    if (item.kind !== 'collection') return { rows: all, hit: selfHit || this._tHit(item.tracks[0]), filtered: false };
    const rows = all.filter(r => this._tHit(r.t));
    if (rows.length) return { rows, hit: true, filtered: rows.length !== all.length };
    return { rows: selfHit ? all : [], hit: selfHit, filtered: false };
  },
  _matches(item) { return this._view(item).hit; },
  _visibleTracks() {
    return this._uniq(this.items.flatMap(i => { const v = this._view(i); return v.hit ? v.rows.map(r => r.t) : []; }));
  },

  _dropFromMemory(id) {
    this.items = this.items.filter(i => i.id !== id);
    this._open.delete(id);
    this.render();
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
    const item = this.items[0];
    this.render();
    this._persist(item, () => this._dropFromMemory(item.id));
    if (!quiet) toast(`Saved to library: ${track.info.title}`, 'success', 2000);
    return true;
  },

  // The playlist's OWN name / author / thumbnail from a loadtracks "playlist"
  // response. NodeLink (playlist-author-thumbnail-support) returns them as
  // data.info.author / data.info.thumbnail ('' when a source has none, e.g.
  // Tidal has no author); pluginInfo is only the fallback for older nodes.
  // Empty fields make addCollection fall back to a shared track artist
  // (author) or the first track's art (thumbnail).
  playlistMeta(data, link) {
    const d = (data && data.data) || {};
    const info = d.info || {}, plugin = d.pluginInfo || {};
    return {
      name: info.name || plugin.name || 'Playlist',
      source: link,
      author: info.author || plugin.author || plugin.owner || '',
      artwork: info.thumbnail || info.artworkUrl || plugin.artworkUrl || plugin.artwork || plugin.thumbnail || '',
    };
  },

  // A playlist has no author of its own unless the node says so. When every
  // track shares one artist (an album) that artist is the author; a mixed
  // playlist gets none — never just "whoever sang track #1".
  _commonAuthor(tracks) {
    const set = new Set(tracks.map(t => t.info && t.info.author).filter(Boolean));
    return set.size === 1 ? [...set][0] : '';
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
      author: author || this._commonAuthor(tracks),
      artwork: artwork || tracks[0].info.artworkUrl || '',
      source: source || '', tracks: tracks.map(t => this._slim(t)), added: Date.now(),
    });
    const item = this.items[0];
    this.render();
    this._persist(item, () => this._dropFromMemory(item.id));
    if (!quiet) toast(`Saved to library: ${name || 'collection'} (${tracks.length} tracks)`, 'success', 2200);
    return true;
  },

  // Turns whatever a loadtracks call returned into library items.
  _addResolved(data, link) {
    if (!data) return 0;
    if (data.loadType === 'track') return this.addTrack(data.data, { quiet: true }) ? 1 : 0;
    if (data.loadType === 'playlist') {
      return this.addCollection({ ...this.playlistMeta(data, link), tracks: data.data.tracks }, { quiet: true }) ? 1 : 0;
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
      // Also re-read the playlist's own name / author / thumbnail — this is what
      // repairs older items that were saved with the first track's artist & art.
      if (item.kind === 'collection' && d && d.loadType === 'playlist') {
        const m = this.playlistMeta(d, item.source);
        if (d.data && d.data.info && d.data.info.name) item.name = m.name;
        item.author = m.author || this._commonAuthor(item.tracks);
        item.artwork = m.artwork || item.tracks[0].info.artworkUrl || '';
      }
      this.render();
      this._persist(item);
      toast(`Refreshed ${item.name} (${delta >= 0 ? '+' : ''}${delta})`, 'success', 2200);
    } catch (e) { toast(`Refresh failed: ${e.message}`, 'error'); }
  },

  remove(id) {
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return;
    const [gone] = this.items.splice(i, 1);
    this._open.delete(id);
    this._unpersist(id); this.render();
    toast(`Removed ${gone.name} from library`, 'info', 1800);
  },

  /* ───────── export / import ───────── */
  FORMAT: 'noobplayer-library',

  exportJson() {
    if (!this.items.length) { toast('Library is empty — nothing to export', 'warn'); return; }
    const payload = { format: this.FORMAT, version: 1, exported: new Date().toISOString(), items: this.items };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `noobplayer-library-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Exported ${this.items.length} item${this.items.length !== 1 ? 's' : ''}`, 'success', 2200);
  },

  // Validates one imported item and returns a clean copy, or null if unusable.
  _sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) return null;
    const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
    const tracks = this._uniq(raw.tracks.filter(t =>
      t && typeof t === 'object' && typeof t.encoded === 'string' && t.encoded &&
      t.info && typeof t.info === 'object' && typeof t.info.title === 'string'
    ).map(t => this._slim(t)));
    if (!tracks.length) return null;
    const kind = raw.kind === 'collection' ? 'collection' : 'track';
    const first = tracks[0].info;
    return {
      id: str(raw.id, 60) || this._newId(),
      kind: kind === 'track' ? 'track' : 'collection',
      name: str(raw.name) || first.title,
      // A track's author is its artist; a collection's is the playlist's own (or the one shared artist).
      author: str(raw.author) || (kind === 'track' ? str(first.author) : this._commonAuthor(tracks)),
      artwork: str(raw.artwork, 2000) || str(first.artworkUrl, 2000),
      source: str(raw.source, 2000),
      tracks: kind === 'track' ? [tracks[0]] : tracks,
      added: Number.isFinite(raw.added) ? raw.added : Date.now(),
    };
  },

  async importFile(file) {
    if (file.size > 200 * 1024 * 1024) { toast('That file is too large to be a library export', 'error'); return; }
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (_) { toast('That file is not valid JSON', 'error'); return; }
    const list = Array.isArray(data) ? data : (data && data.format === this.FORMAT ? data.items : null);
    if (!Array.isArray(list)) { toast('That does not look like a Noobplayer library export', 'error'); return; }

    const fresh = [];
    let skipped = 0, invalid = 0;
    const ids = new Set(this.items.map(i => i.id));
    for (const raw of list) {
      const item = this._sanitize(raw);
      if (!item) { invalid++; continue; }
      const dup = this.items.some(i =>
        i.id === item.id ||
        (item.kind === 'track' && i.kind === 'track' && this._key(i.tracks[0]) === this._key(item.tracks[0])) ||
        (item.kind === 'collection' && item.source && i.kind === 'collection' && i.source === item.source)
      ) || fresh.some(i => i.id === item.id);
      if (dup) { skipped++; continue; }
      if (ids.has(item.id)) item.id = this._newId();
      ids.add(item.id);
      fresh.push(item);
    }
    if (!fresh.length) {
      toast(invalid || skipped ? `Nothing new to import (${skipped} already here${invalid ? `, ${invalid} unreadable` : ''})` : 'The file has no items', 'info', 3500);
      return;
    }

    // Oldest first, so unshift-ing keeps the newest at the top like everywhere else.
    fresh.sort((a, b) => a.added - b.added).forEach(it => this.items.unshift(it));
    this.items.sort((a, b) => (b.added || 0) - (a.added || 0));
    this.render();
    try {
      await this._ready;
      if (this._db) await this._tx('readwrite', st => fresh.forEach(it => st.put(JSON.parse(JSON.stringify(it)))));
      toast(`Imported ${fresh.length} item${fresh.length !== 1 ? 's' : ''}${skipped ? ` · ${skipped} already here` : ''}${invalid ? ` · ${invalid} unreadable` : ''}`, 'success', 3500);
    } catch (e) {
      console.error('Library import failed:', e);
      const gone = new Set(fresh.map(i => i.id));
      this.items = this.items.filter(i => !gone.has(i.id));
      this.render();
      toast('Import failed — ' + (e && e.name === 'QuotaExceededError' ? 'the browser is out of space' : 'could not write to storage'), 'error', 5000);
    }
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
  // Thumbnail wrapped so a circular source badge (bottom-right) can overlay it.
  // `srcKey` is '' / unknown → no badge is rendered.
  _thumb(src, cls, icon, srcKey) {
    const img = src
      ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="${cls.replace('th', 'nth')}"><span class="material-symbols-outlined">${icon}</span></div>`;
    return `<span class="th-w">${img}${srcBadge(srcKey)}</span>`;
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
    ['btn-lib-qall', 'btn-lib-sall', 'btn-lib-export'].forEach(id => { document.getElementById(id).disabled = none; });

    if (none) {
      list.innerHTML = `<div class="empty"><span class="material-symbols-outlined">library_music</span><p>Paste a link above, or tap the bookmark on any search result,<br>to keep tracks, albums and playlists here</p></div>`;
      return;
    }
    const shown = this.items.filter(i => this._matches(i));
    if (!shown.length) { list.innerHTML = `<div class="empty"><p>No matches</p></div>`; return; }
    // Progressive loading: 100 top-level items, and 100 tracks per expanded
    // playlist; the next 100 are appended when the user scrolls to the footer.
    const upto = Math.min(shown.length, this._lLimit);
    list.innerHTML = shown.slice(0, upto).map(item => this._itemHtml(item)).join('')
      + (upto < shown.length ? this._moreHtml(upto, shown.length) : '');
    UI.applyLockState();   // Play buttons follow the host/DJ lock
    this._lWatch();
  },

  /* ───────── progressive loading (100 at a time) ───────── */
  _LCHUNK: 100,
  _lLimit: 100,            // top-level items rendered
  _subLimit: new Map(),    // collection id -> tracks rendered while expanded
  _lIO: null,
  _lMargin: 200,

  _moreHtml(shown, total) {
    return `<div class="q-more l-more">Showing ${shown} of ${total} \u2014 scroll for more</div>`;
  },

  _trowHtml(t, i) {
    const q = this._filter;
    return `
          <div class="si lib-trow" data-ti="${i}">
            ${this._thumb(t.info.artworkUrl, 'si-th', 'music_note', trackSrc(t))}
            <div class="si-meta"><div class="si-t">${hl(t.info.title, q)}</div><div class="si-a">${hl(t.info.author, q)}</div></div>
            <div class="si-acts">
              <button class="add-btn pnow" data-la="tplay" data-ti="${i}" title="Play"><span class="material-symbols-outlined">play_arrow</span></button>
              <button class="add-btn" data-la="tqueue" data-ti="${i}" title="Add to queue"><span class="material-symbols-outlined m-ico">playlist_add</span></button>
              <button class="add-btn" data-la="tlink" data-ti="${i}" title="Open track link" ${t.info.uri ? '' : 'disabled'}><span class="material-symbols-outlined">open_in_new</span></button>
            </div>
            <span class="si-d">${fmt(t.info.length)}</span>
          </div>`;
  },

  _itemHtml(item) {
    const isCol = item.kind === 'collection';
    const q = this._filter;
    const open = isCol && (this._open.has(item.id) || !!q);
    const view = this._view(item);
    const total = item.tracks.length;
    const count = view.rows.length;
    const countTxt = view.filtered ? `${count} of ${total} track${total !== 1 ? 's' : ''}` : `${total} track${total !== 1 ? 's' : ''}`;
    const sub = isCol
      ? `${countTxt}${item.author ? ' \u00b7 ' + hl(item.author, q) : ''}`
      : hl(item.author || '', q);
    const dur = fmt(view.rows.reduce((a, r) => a + (r.t.info.length || 0), 0));
    const srcKey = isCol ? collectionSrc(item) : trackSrc(item.tracks[0]);
    const acts = isCol
      ? `<button class="add-btn" data-la="queue" title="Add every track to the queue"><span class="material-symbols-outlined m-ico">playlist_add</span><span class="lbl">Queue</span></button>
         <button class="add-btn" data-la="shuffle" title="Shuffle these tracks, then add them to the queue"><span class="material-symbols-outlined m-ico">shuffle</span><span class="lbl">Shuffle</span></button>
         ${/^https?:\/\//i.test(item.source || '') ? `<button class="add-btn" data-la="plink" title="Open playlist link"><span class="material-symbols-outlined">open_in_new</span><span class="lbl">Link</span></button>` : ''}
         ${item.source ? `<button class="add-btn" data-la="refresh" title="Re-fetch from the original link"><span class="material-symbols-outlined">refresh</span></button>` : ''}`
      : `<button class="add-btn pnow" data-la="play" title="Play"><span class="material-symbols-outlined">play_arrow</span><span class="lbl">Play</span></button>
         <button class="add-btn" data-la="queue" title="Add to queue"><span class="material-symbols-outlined m-ico">playlist_add</span><span class="lbl">Queue</span></button>
         <button class="add-btn" data-la="link" title="Open track link" ${item.tracks[0].info.uri ? '' : 'disabled'}><span class="material-symbols-outlined">open_in_new</span><span class="lbl">Link</span></button>`;
    let html = `<div class="lib-item ${isCol ? 'col' : ''} ${open ? 'open' : ''}" data-id="${esc(item.id)}">
        <div class="si lib-row" data-la="${isCol ? 'toggle' : ''}">
          ${isCol ? `<span class="material-symbols-outlined lib-chev">${open ? 'expand_more' : 'chevron_right'}</span>` : ''}
          ${this._thumb(item.artwork, 'si-th', isCol ? 'library_music' : 'music_note', srcKey)}
          <div class="si-meta">
            <div class="si-t">${hl(item.name, q)}</div>
            <div class="si-a">${sub}</div>
          </div>
          <div class="si-acts lib-acts">${acts}
            <button class="add-btn lib-del" data-la="remove" title="Remove from library"><span class="material-symbols-outlined">delete</span></button>
          </div>
          <span class="si-d">${isCol ? dur : fmt(item.tracks[0].info.length)}</span>
        </div>`;
    if (open) {
      const upto = Math.min(count, this._subLimit.get(item.id) || this._LCHUNK);
      html += `<div class="lib-sub">` + view.rows.slice(0, upto).map(r => this._trowHtml(r.t, r.i)).join('')
        + (upto < count ? this._moreHtml(upto, count) : '') + `</div>`;
    }
    return html + `</div>`;
  },

  // Next 100 for whichever footer was reached (a playlist's, or the list's own).
  _lMore(foot) {
    if (!foot || !foot.isConnected) return;
    const wrap = foot.closest('.lib-item');
    if (wrap) {                                   // inside an expanded playlist
      const item = this.items.find(i => i.id === wrap.dataset.id);
      if (!item) return;
      const rows = this._view(item).rows;     // filtered rows, each keeping its real track index
      const have = wrap.querySelectorAll('.lib-trow').length;
      if (have >= rows.length) { foot.remove(); return; }
      const upto = Math.min(rows.length, have + this._LCHUNK);
      this._subLimit.set(item.id, upto);
      foot.insertAdjacentHTML('beforebegin', rows.slice(have, upto).map(r => this._trowHtml(r.t, r.i)).join(''));
      if (upto < rows.length) foot.textContent = `Showing ${upto} of ${rows.length} \u2014 scroll for more`;
      else foot.remove();
    } else {                                      // the list itself
      const list = document.getElementById('lib-list');
      const shown = this.items.filter(i => this._matches(i));
      const have = list.querySelectorAll(':scope > .lib-item').length;
      if (have >= shown.length) { foot.remove(); return; }
      const upto = Math.min(shown.length, have + this._LCHUNK);
      this._lLimit = upto;
      foot.insertAdjacentHTML('beforebegin', shown.slice(have, upto).map(it => this._itemHtml(it)).join(''));
      if (upto < shown.length) foot.textContent = `Showing ${upto} of ${shown.length} \u2014 scroll for more`;
      else foot.remove();
    }
    UI.applyLockState();
    this._lWatch();
  },

  // Observe every footer against the browser viewport. Re-observing after each
  // load re-reports footers that are still in view (tall screens), so a short
  // screen keeps filling until the footer is pushed out of sight.
  _lWatch() {
    const list = document.getElementById('lib-list');
    if (!list) return;
    if (!('IntersectionObserver' in window)) return;   // scroll listener (init) covers this
    if (!this._lIO) {
      this._lIO = new IntersectionObserver(entries => {
        entries.filter(en => en.isIntersecting).forEach(en => this._lMore(en.target));
      }, { root: null, rootMargin: `0px 0px ${this._lMargin}px 0px` });
    }
    this._lIO.disconnect();
    list.querySelectorAll('.l-more').forEach(f => this._lIO.observe(f));
  },

  _lCheck() {
    const list = document.getElementById('lib-list');
    if (!list) return;
    list.querySelectorAll('.l-more').forEach(f => {
      const r = f.getBoundingClientRect();
      if (r.height > 0 && r.top <= window.innerHeight + this._lMargin) this._lMore(f);
    });
  },

  // Back to the first 100 items / first 100 tracks per playlist (called on a tab switch).
  resetWindow() {
    this._lLimit = this._LCHUNK;
    this._subLimit.clear();
    this.render();
    const list = document.getElementById('lib-list');
    if (list) list.scrollTop = 0;
  },

  _onListClick(e) {
    const mf = e.target.closest('.l-more');
    if (mf) { this._lMore(mf); return; }
    const btn = e.target.closest('[data-la]');
    if (!btn || btn.disabled) return;
    const wrap = btn.closest('.lib-item');
    const item = wrap && this.items.find(i => i.id === wrap.dataset.id);
    if (!item) return;
    const a = btn.dataset.la;
    if (a === 'toggle') {
      if (e.target.closest('.lib-acts')) return;
      if (this._open.has(item.id)) { this._open.delete(item.id); this._subLimit.delete(item.id); } else this._open.add(item.id);
      this.render();
    } else if (a === 'play') this._playOrQueue(item.tracks[0]);
    else if (a === 'queue') this._bulk(item.tracks, false, item.kind === 'collection' ? item.name : '');
    else if (a === 'shuffle') this._bulk(item.tracks, true, item.name);
    else if (a === 'refresh') this.refresh(item.id);
    else if (a === 'link') UI.openTrackLink(item.tracks[0]);
    else if (a === 'tlink') UI.openTrackLink(item.tracks[+btn.dataset.ti]);
    else if (a === 'plink') {
      if (/^https?:\/\//i.test(item.source || '')) window.open(item.source, '_blank', 'noopener,noreferrer');
      else toast('No link available for this playlist', 'info', 1800);
    }
    else if (a === 'remove') this.remove(item.id);
    else if (a === 'tplay') this._playOrQueue(item.tracks[+btn.dataset.ti]);
    else if (a === 'tqueue') {
      const t = item.tracks[+btn.dataset.ti];
      Engine.addToQueue(this._clone(t));
    }
  },
};