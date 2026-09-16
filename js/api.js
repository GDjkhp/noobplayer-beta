'use strict';
/* ═══════════════════════════════════════════
   Backend — unifies standalone (direct NodeLink) and
   server mode (Flask proxy) behind one interface.
   ui.js / engine.js call these without knowing which mode is active.
═══════════════════════════════════════════ */
const Backend = {
  mode: null,        // 'standalone' | 'server'
  host: '', pass: '', // standalone
  serverUrl: '',      // server mode — Flask base URL

  setStandalone(host, pass) {
    this.mode = 'standalone';
    this.host = host.replace(/\/$/, '');
    this.pass = pass;
  },
  setServer(url) {
    this.mode = 'server';
    this.serverUrl = url.replace(/\/$/, '');
  },

  _base() { return this.mode === 'standalone' ? this.host : this.serverUrl; },
  _headers() {
    return this.mode === 'standalone'
      ? { Authorization: this.pass, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  },

  async _get(path) {
    const res = await fetch(this._base() + path, { headers: this._headers() });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t}`);
    }
    return res.json();
  },

  async info() {
    const path = this.mode === 'standalone' ? '/v4/info' : '/api/nodelink/info';
    return this._get(path);
  },

  async loadtracks(identifier) {
    const path = this.mode === 'standalone'
      ? `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`
      : `/api/nodelink/loadtracks?identifier=${encodeURIComponent(identifier)}`;
    return this._get(path);
  },

  async loadlyrics(encodedTrack) {
    const path = this.mode === 'standalone'
      ? `/v4/loadlyrics?encodedTrack=${encodeURIComponent(encodedTrack)}`
      : `/api/nodelink/loadlyrics?encodedTrack=${encodeURIComponent(encodedTrack)}`;
    return this._get(path);
  },

  async loadchapters(encodedTrack) {
    const path = this.mode === 'standalone'
      ? `/v4/loadchapters?encodedTrack=${encodeURIComponent(encodedTrack)}`
      : `/api/nodelink/loadchapters?encodedTrack=${encodeURIComponent(encodedTrack)}`;
    return this._get(path);
  },

  async meaning(encodedTrack) {
    const path = this.mode === 'standalone'
      ? `/v4/meaning?encodedTrack=${encodeURIComponent(encodedTrack)}`
      : `/api/nodelink/meaning?encodedTrack=${encodeURIComponent(encodedTrack)}`;
    return this._get(path);
  },

  // Returns a raw fetch Response with a readable stream body of PCM bytes.
  // `signal` is optional — pass an AbortController's signal so a
  // background gapless preload can be cancelled if it's no longer needed
  // (queue reordered, track removed, etc.) without waiting it out.
  async openStream(encodedTrack, positionMs, filters, signal) {
    const path = this.mode === 'standalone' ? '/v4/loadstream' : '/api/nodelink/loadstream';
    const body = { encodedTrack, position: Math.round(positionMs) };
    if (filters && Object.keys(filters).length) body.filters = filters;
    return fetch(this._base() + path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal,
    });
  },
};

/* ═══════════════════════════════════════════
   LobbyAPI — REST calls to the Flask lobby backend (server mode only)
═══════════════════════════════════════════ */
const LobbyAPI = {
  base() { return Backend.serverUrl; },

  async create(name, isPublic, displayName) {
    const res = await fetch(`${this.base()}/api/lobby/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isPublic, displayName }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async join(code, displayName) {
    const res = await fetch(`${this.base()}/api/lobby/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  async listPublic() {
    const res = await fetch(`${this.base()}/api/lobby/public`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async leave(code, clientId) {
    try {
      await fetch(`${this.base()}/api/lobby/${code}/leave`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
    } catch (_) {}
  },

  async chat(code, clientId, text) {
    return fetch(`${this.base()}/api/lobby/${code}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, text }),
    });
  },

  async control(code, action, payload) {
    const res = await fetch(`${this.base()}/api/lobby/${code}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  // Host-only: rename the lobby and/or flip public/private. `patch` is
  // whichever of { name, isPublic } changed — omitted keys are left as-is.
  async updateSettings(code, clientId, patch) {
    const res = await fetch(`${this.base()}/api/lobby/${code}/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, ...patch }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  // Anyone can rename THEMSELVES — not host-gated.
  async rename(code, clientId, displayName) {
    const res = await fetch(`${this.base()}/api/lobby/${code}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, displayName }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  liveUrl(code, relayGen) {
    return `${this.base()}/api/lobby/${code}/live?g=${relayGen}`;
  },

  webrtcOfferUrl(code) {
    return `${this.base()}/api/lobby/${code}/webrtc/offer`;
  },
};

/* ═══════════════════════════════════════════
   SkinAPI — the public skin gallery.

   Unlike LobbyAPI this works in standalone mode too: the gallery is a
   plain feature of whichever Noobplayer server you're pointed at, not
   part of any lobby. Backend.serverUrl is set on boot (Main.autoStart)
   and survives switching to standalone, so browsing/publishing keeps
   working after you disconnect from a lobby. If someone starts the page
   from a file:// URL with no server at all, base() is empty and every
   call here fails fast — skins.js catches that and just shows local
   skins.
═══════════════════════════════════════════ */
const SkinAPI = {
  base() { return Backend.serverUrl || ''; },
  available() { return !!this.base(); },

  async list(sort = 'new') {
    const res = await fetch(`${this.base()}/api/skins?sort=${encodeURIComponent(sort)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async get(id) {
    const res = await fetch(`${this.base()}/api/skins/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  // Publishing the same id again with its edit token updates in place
  // instead of creating a duplicate.
  async publish(skin, id, editToken) {
    const res = await fetch(`${this.base()}/api/skins`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skin, id, editToken }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  async remove(id, editToken) {
    const res = await fetch(`${this.base()}/api/skins/${encodeURIComponent(id)}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  async countInstall(id) {
    try {
      await fetch(`${this.base()}/api/skins/${encodeURIComponent(id)}/install`, { method: 'POST' });
    } catch (_) {}
  },
};