'use strict';
/* ═══════════════════════════════════════════
   Auth — optional noobplayer server password.

   A server started with NOOBPLAYER_PASSWORD in its .env refuses every /api/
   call, the live socket and the audio session until the client presents an
   access token (POST /api/auth/login trades the password for one). Only the
   token is kept (per server URL, in the persistent Store) — never the password.

   fetch() is wrapped once, below: any request to the current server gets the
   token header, and a 401 "password required" pops the password window and then
   retries the request, so the rest of the app doesn't need to know about any of
   this. A server without a password never answers 401, so nothing changes there.
═══════════════════════════════════════════ */
const Auth = {
  _mem: {},          // server url -> token (mirror of the Store, also works if storage is blocked)
  _prompts: {},      // server url -> in-flight password window (shared by concurrent 401s)
  _raw: window.fetch.bind(window),

  normalize(url) {
    url = String(url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  },
  _key(base) { return 'nl_srvtok:' + base; },
  token(base) {
    base = base || Backend.serverUrl;
    if (!base) return '';
    if (this._mem[base] !== undefined) return this._mem[base];
    let t = '';
    try { t = Store.getItem(this._key(base)) || ''; } catch (_) {}
    return (this._mem[base] = t);
  },
  setToken(base, t) {
    this._mem[base] = t || '';
    try { if (t) Store.setItem(this._key(base), t); else Store.removeItem(this._key(base)); } catch (_) {}
  },
  forServer(url) { return !!Backend.serverUrl && (url === Backend.serverUrl || url.startsWith(Backend.serverUrl + '/')); },

  // → { required, authorized } ; null when the server can't be asked (old server / unreachable)
  async status(base) {
    try {
      const t = this.token(base);
      const res = await this._raw(`${base}/api/auth/status`, t ? { headers: { 'X-Noobplayer-Token': t } } : undefined);
      if (!res.ok) return null;
      const j = await res.json();
      return { required: !!j.required, authorized: !!j.authorized };
    } catch (_) { return null; }
  },

  // Trades a password for a token. Throws Error('wrong password' …) on failure.
  async login(base, password) {
    const res = await this._raw(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
    this.setToken(base, j.token || '');
    return true;
  },

  // Makes sure we may talk to `base`. With `password` it logs in with that;
  // otherwise it reuses the saved token and, if that is missing / stale, opens
  // the password window. → { ok, required, error? }
  async ensure(base, { password, askIfNeeded = true, cancelable = false } = {}) {
    const st = await this.status(base);
    if (!st || !st.required) return { ok: true, required: false };
    if (st.authorized && !password) return { ok: true, required: true };
    if (password) {
      try { await this.login(base, password); return { ok: true, required: true }; }
      catch (e) { return { ok: false, required: true, error: e.message }; }
    }
    if (!askIfNeeded) return { ok: false, required: true, error: 'password required' };
    const ok = await this.prompt(base, { cancelable });
    return { ok, required: true, error: ok ? undefined : 'password required' };
  },

  // The password window. Resolves true once logged in, false if cancelled.
  prompt(base, { cancelable = false } = {}) {
    base = base || Backend.serverUrl;
    if (this._prompts[base]) return this._prompts[base];
    const p = new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'confirm-overlay auth-overlay';
      ov.innerHTML = `
        <form class="confirm-box auth-box" autocomplete="off">
          <div class="confirm-title">noobplayer server password</div>
          <div class="confirm-text"><b class="auth-host"></b> needs a password.</div>
          <input class="hi full auth-pw" type="password" placeholder="Password" autocomplete="off" style="margin-top:14px">
          <div class="auth-err" role="alert"></div>
          <div class="auth-btns">
            ${cancelable ? '<button type="button" class="overlay-btn ghost auth-cancel">Cancel</button>' : ''}
            <button type="submit" class="overlay-btn auth-go">Enter</button>
          </div>
        </form>`;
      ov.querySelector('.auth-host').textContent = base;
      const form = ov.querySelector('form'), pw = ov.querySelector('.auth-pw');
      const err = ov.querySelector('.auth-err'), go = ov.querySelector('.auth-go');
      const done = ok => { ov.remove(); delete this._prompts[base]; resolve(ok); };
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!pw.value) { pw.focus(); return; }
        go.disabled = true; err.textContent = '';
        try { await this.login(base, pw.value); done(true); }
        catch (ex) {
          go.disabled = false;
          err.textContent = ex.status === 401 ? 'Wrong password' : ex.message;
          pw.select();
        }
      });
      const cancel = ov.querySelector('.auth-cancel');
      if (cancel) cancel.addEventListener('click', () => done(false));
      document.body.appendChild(ov);
      setTimeout(() => pw.focus(), 0);
    });
    this._prompts[base] = p;
    return p;
  },
};

// One wrapper for every request to the current server (see Auth above).
window.fetch = async function (input, init) {
  if (typeof input !== 'string' || !Auth.forServer(input) || input.includes('/api/auth/')) return Auth._raw(input, init);
  const base = Backend.serverUrl;
  const withToken = () => {
    const h = new Headers((init && init.headers) || {});
    const t = Auth.token(base);
    if (t) h.set('X-Noobplayer-Token', t);
    return { ...(init || {}), headers: h };
  };
  let res = await Auth._raw(input, withToken());
  if (res.status === 401) {
    const body = await res.clone().json().catch(() => null);
    if (body && body.auth === 'required') {
      // The default server (this page's own origin) can't be skipped; another one can.
      const ok = await Auth.prompt(base, { cancelable: base !== window.location.origin });
      if (ok) res = await Auth._raw(input, withToken());
    }
  }
  return res;
};

/* ═══════════════════════════════════════════
   Backend — unifies standalone (direct NodeLink) and
   server mode (noobplayer server proxy) behind one interface.
   ui.js / engine.js call these without knowing which mode is active.
═══════════════════════════════════════════ */
const Backend = {
  mode: null,        // 'standalone' | 'server'
  host: '', pass: '', // standalone
  serverUrl: '',      // server mode — noobplayer server base URL

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
   LobbyAPI — REST calls to the noobplayer lobby backend (server mode only)
═══════════════════════════════════════════ */
const LobbyAPI = {
  base() { return Backend.serverUrl; },

  // Persistent per-browser user id: generated once, kept in the persistent Store (IndexedDB), and
  // sent on every create/join/rejoin/restore. It is what tags a user's queued
  // tracks and what a ban sticks to, so it survives leaving and rejoining
  // (the per-join clientId does not). Falls back to a per-page-load id when
  // storage is blocked.
  _uid: null,
  userId() {
    if (this._uid) return this._uid;
    let id = null;
    try { id = Store.getItem('nl_user_id'); } catch (_) {}
    if (!/^[0-9a-f]{32}$/.test(id || '')) {
      const b = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(b);
      id = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      try { Store.setItem('nl_user_id', id); } catch (_) {}
    }
    return (this._uid = id);
  },

  async create(name, isPublic, displayName, password) {
    const res = await fetch(`${this.base()}/api/lobby/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isPublic, displayName, password: password || '', userId: this.userId() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async join(code, displayName, password) {
    const res = await fetch(`${this.base()}/api/lobby/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName, password: password || '', userId: this.userId() }),
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
    return this._post('/api/lobby/rejoin', { code, clientId, displayName, password: password || '', userId: this.userId() });
  },

  // Host-only in practice: rebuild a lobby from a saved snapshot.
  restore(snapshot, clientId, displayName, allowNewCode) {
    return this._post('/api/lobby/restore', { snapshot, clientId, displayName, allowNewCode: !!allowNewCode, userId: this.userId() });
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

  // audio analysis (beats / tempo / meter / key) of the lobby's current
  // track. status is 'pending'/'none' until the server has finished; poll.
  async analysis(code, clientId) {
    const res = await fetch(`${this.base()}/api/lobby/${code}/analysis?clientId=${encodeURIComponent(clientId)}`);
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
    // Servers with a password only accept the audio session with the access token.
    const tok = Auth.token(this.base());
    return `https://${host}:${info.port}${path}${tok ? '?token=' + encodeURIComponent(tok) : ''}`;
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
    // A plain navigation can't carry a header, so the access token rides in the URL.
    const tok = Auth.token(this.base());
    if (tok) p.set('token', tok);
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