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
  async openStream(encodedTrack, positionMs, signal) {
    const path = this.mode === 'standalone' ? '/v4/loadstream' : '/api/nodelink/loadstream';
    const body = { encodedTrack, position: Math.round(positionMs) };
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

  async create(name, isPublic, displayName, password) {
    const res = await fetch(`${this.base()}/api/lobby/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isPublic, displayName, password: password || '' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async join(code, displayName, password) {
    const res = await fetch(`${this.base()}/api/lobby/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName, password: password || '' }),
    });
    if (!res.ok) {
      const t = await res.json().catch(() => ({}));
      const err = new Error(t.error || `HTTP ${res.status}`);
      err.status = res.status; err.reason = t.reason;
      throw err;
    }
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
        // Leaving must never hang on a dead server (self-heal cancel / leave
        // while reconnecting both go through here).
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(4000) : undefined,
      });
    } catch (_) {}
  },

  // Self-heal. Errors carry `.status` (undefined = the server couldn't be
  // reached at all) and `.reason`, so the reconnect loop can tell "keep
  // retrying" from "this will never work" — see Heal in sessions.js.
  async _post(path, payload) {
    const res = await fetch(`${this.base()}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status; err.reason = body.reason;
      throw err;
    }
    return body;
  },

  // Ask for the same identity back (blip) or re-enter as a new participant
  // (the lobby was rebuilt). Never creates a lobby.
  rejoin(code, clientId, displayName, password) {
    return this._post('/api/lobby/rejoin', { code, clientId, displayName, password: password || '' });
  },

  // Host-only in practice: rebuild a lobby from a saved snapshot.
  restore(snapshot, clientId, displayName, allowNewCode) {
    return this._post('/api/lobby/restore', { snapshot, clientId, displayName, allowNewCode: !!allowNewCode });
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

  // The lobby's live audio relay — WebTransport connection info (see
  // QuicPcmRelay/LobbyQuicProtocol in server.py). Replaces hlsUrl(): the
  // relay isn't a plain URL you can point an <audio> element at anymore,
  // opening the session itself needs the self-signed cert's hash too
  // (see WebTransportPlayer.connect in webtransport-player.js).
  async quicInfo() {
    const res = await fetch(`${this.base()}/api/quic-info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();   // { port, certHashHex, path }
  },

  // Builds the actual WebTransport URL for one lobby's audio session.
  // WebTransport always uses an https:// URL even though the real
  // transport underneath is QUIC/UDP on its own port (see QUIC_PORT in
  // config.py) — and per the WebTransport spec, serverCertificateHashes
  // pinning (how the browser trusts our self-signed cert without a real
  // CA, see quicInfo() above) is ONLY accepted when the URL's host is an
  // IP literal, not a hostname — "localhost" included, even though it
  // resolves to 127.0.0.1. Browsers reject the handshake before it ever
  // reaches the server if this isn't an IP (surfaces as a generic
  // "Opening handshake failed." with no further detail — see
  // WebTransportPlayer.connect). We can't DNS-resolve an arbitrary
  // hostname from JS, but "localhost" specifically is safe to hardcode.
  // A real (CA-signed, non-pinned) deployment wouldn't hit this at all —
  // see the comment in WebTransportPlayer.connect for that path.
  quicUrl(code, info) {
    let host = new URL(this.base()).hostname;
    if (host === 'localhost') host = '127.0.0.1';
    else if (info.host) host = info.host;
    else if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.startsWith('[')) {
      const err = new Error(`can't open a pinned WebTransport session to "${host}" — connect via its IP address instead (or use a CA-signed cert to skip pinning entirely)`);
      err.nonRetryable = true;   // a config problem — reconnecting can't fix it
      throw err;
    }
    const path = info.path.replace('{code}', code);
    return `https://${host}:${info.port}${path}`;
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

/* ═══════════════════════════════════════════
   DownloadAPI — full-track downloads (opus/ogg, mp3, or wav).

   Same shape as SkinAPI/VizAPI: it's a plain feature of whichever Quart
   server you're pointed at, not tied to being in an active lobby, so it
   works in standalone mode too as long as Backend.serverUrl is set
   (which it is from boot — see Main.autoStart in main.js).
═══════════════════════════════════════════ */
const DownloadAPI = {
  base() { return Backend.serverUrl || ''; },
  available() { return !!this.base(); },

  // Builds the download URL — a plain GET with Content-Disposition:
  // attachment, so the caller just needs to navigate to it (see
  // triggerDownload in utils.js) rather than fetch()-ing the body itself.
  url(track, format) {
    const p = new URLSearchParams({
      encodedTrack: track.encoded,
      format,
      title: track.info?.title || '',
      author: track.info?.author || '',
    });
    return `${this.base()}/api/download?${p.toString()}`;
  },
};

/* ═══════════════════════════════════════════
   VizAPI — the public visualizer gallery.

   Same shape as SkinAPI, different payload: a visualizer is JavaScript,
   which the server stores verbatim because there is no useful way to
   sanitize it. Safety comes from WHERE it runs, not what it contains —
   see the sandbox notes at the top of visualizer.js.
═══════════════════════════════════════════ */
const VizAPI = {
  base() { return Backend.serverUrl || ''; },
  available() { return !!this.base(); },

  async list(sort = 'new') {
    const res = await fetch(`${this.base()}/api/visualizers?sort=${encodeURIComponent(sort)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async get(id) {
    const res = await fetch(`${this.base()}/api/visualizers/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async publish(viz, id, editToken) {
    const res = await fetch(`${this.base()}/api/visualizers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viz, id, editToken }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  async remove(id, editToken) {
    const res = await fetch(`${this.base()}/api/visualizers/${encodeURIComponent(id)}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editToken }),
    });
    if (!res.ok) { const t = await res.json().catch(() => ({})); throw new Error(t.error || `HTTP ${res.status}`); }
    return res.json();
  },

  async countInstall(id) {
    try {
      await fetch(`${this.base()}/api/visualizers/${encodeURIComponent(id)}/install`, { method: 'POST' });
    } catch (_) {}
  },
};