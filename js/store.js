'use strict';
/* ═══════════════════════════════════════════
   Store — the app's persistent key/value storage, backed by IndexedDB.

   Replaces localStorage everywhere (skins, visualizers, key bindings, saved
   sessions, display name, downloads history, …). It deliberately keeps
   localStorage's small API — getItem / setItem / removeItem with string
   values — so call sites barely changed:

     • everything is loaded into memory once at startup (`Store.ready`), so
       reads stay synchronous;
     • writes update memory immediately and are written to IndexedDB
       straight away (no batching/delay — this matters for the session
       autosave that runs during 'pagehide');
     • other open tabs are kept in sync through a BroadcastChannel, which
       replaces localStorage's implicit cross-tab sharing.

   First run: any existing localStorage keys that belong to this app
   ('nl_*' and 'aa-anchor:*') are copied into IndexedDB, then removed from
   localStorage. If IndexedDB is unavailable or doesn't open in time, Store
   falls back to plain localStorage so the app still works.
═══════════════════════════════════════════ */
const Store = {
  DB_NAME: 'nl_store_db',
  STORE: 'kv',
  PREFIXES: ['nl_', 'aa-anchor:'],
  OPEN_TIMEOUT_MS: 4000,

  mode: 'pending',          // 'idb' | 'ls' (fallback) | 'pending' (before ready)
  ready: null,              // promise — resolves once the cache is loaded (never rejects)
  _db: null,
  _cache: new Map(),
  _touched: new Set(),      // keys written before load finished — they win over what's on disk
  _chan: null,
  _warned: false,

  init() {
    if (!this.ready) this.ready = this._init();
    return this.ready;
  },

  _mine(k) { return typeof k === 'string' && this.PREFIXES.some(p => k.startsWith(p)); },

  async _init() {
    try {
      this._db = await Promise.race([
        this._open(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB open timed out')), this.OPEN_TIMEOUT_MS)),
      ]);
      const rows = await this._run('readonly', st => st.getAll());
      const onDisk = new Map();
      (rows || []).forEach(r => { if (r && typeof r.k === 'string') onDisk.set(r.k, r.v); });

      // One-time migration of this app's localStorage keys.
      const legacy = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (this._mine(k)) legacy.push(k);
        }
      } catch (_) { /* storage blocked — nothing to migrate */ }
      const moved = [];
      for (const k of legacy) {
        if (!onDisk.has(k)) {
          const v = localStorage.getItem(k);
          if (v !== null) { onDisk.set(k, v); moved.push([k, v]); }
        }
      }
      if (moved.length) await this._run('readwrite', st => moved.forEach(([k, v]) => st.put({ k, v })));
      // Only drop the localStorage copies once they're safely in IndexedDB.
      legacy.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });

      onDisk.forEach((v, k) => { if (!this._touched.has(k)) this._cache.set(k, v); });
      this.mode = 'idb';
      this._openChannel();
      if (moved.length) console.info(`[Store] migrated ${moved.length} localStorage key(s) to IndexedDB`);
    } catch (e) {
      console.error('[Store] IndexedDB unavailable, falling back to localStorage:', e);
      this._db = null;
      this.mode = 'ls';
    }
    return this.mode;
  },

  _open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.STORE)) req.result.createObjectStore(this.STORE, { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    });
  },

  // One transaction; resolves with fn's return value (e.g. a getAll request's
  // result) once the transaction has committed.
  _run(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!this._db) { reject(new Error('no database')); return; }
      let tx, out;
      try {
        tx = this._db.transaction(this.STORE, mode);
        out = fn(tx.objectStore(this.STORE));
      } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  },

  _openChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      this._chan = new BroadcastChannel('nl_store');
      this._chan.onmessage = (e) => {
        const m = e.data;
        if (!m || typeof m.k !== 'string') return;
        if (m.v === null) this._cache.delete(m.k); else this._cache.set(m.k, m.v);
      };
    } catch (_) { this._chan = null; }
  },

  _writeFailed(e) {
    console.error('[Store] write failed:', e);
    if (this._warned) return;
    this._warned = true;
    if (typeof toast === 'function') toast('Could not save settings — browser storage write failed', 'error', 5000);
  },

  /* ───────── localStorage-shaped API ───────── */
  getItem(k) {
    if (this.mode === 'ls') { try { return localStorage.getItem(k); } catch (_) { return null; } }
    return this._cache.has(k) ? this._cache.get(k) : null;
  },

  setItem(k, v) {
    v = String(v);
    if (this.mode === 'ls') { try { localStorage.setItem(k, v); } catch (e) { this._writeFailed(e); } return; }
    this._cache.set(k, v);
    if (this.mode === 'pending') this._touched.add(k);
    this._persist(k, v);
  },

  removeItem(k) {
    if (this.mode === 'ls') { try { localStorage.removeItem(k); } catch (_) {} return; }
    this._cache.delete(k);
    if (this.mode === 'pending') this._touched.add(k);
    this._persist(k, null);
  },

  _persist(k, v) {
    const go = () => {
      if (this.mode !== 'idb') return;       // fell back to localStorage meanwhile — nothing to do
      this._run('readwrite', st => (v === null ? st.delete(k) : st.put({ k, v }))).catch(e => this._writeFailed(e));
      try { if (this._chan) this._chan.postMessage({ k, v }); } catch (_) {}
    };
    if (this.mode === 'idb') go();
    else this.ready.then(() => {
      if (this.mode === 'ls') { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { this._writeFailed(e); } }
      else go();
    });
  },

  keys(prefix = '') {
    if (this.mode === 'ls') {
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(prefix)) out.push(k); } } catch (_) {}
      return out;
    }
    return [...this._cache.keys()].filter(k => k.startsWith(prefix));
  },
};
Store.init();
