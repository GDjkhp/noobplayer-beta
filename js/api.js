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

  // Returns a raw fetch Response with a readable stream body of PCM bytes
  async openStream(encodedTrack, positionMs, filters) {
    const path = this.mode === 'standalone' ? '/v4/loadstream' : '/api/nodelink/loadstream';
    const body = { encodedTrack, position: Math.round(positionMs) };
    if (filters && Object.keys(filters).length) body.filters = filters;
    return fetch(this._base() + path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
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

  webrtcOfferUrl(code) {
    return `${this.base()}/api/lobby/${code}/webrtc/offer`;
  },
};