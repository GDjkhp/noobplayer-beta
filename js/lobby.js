'use strict';
/* ═══════════════════════════════════════════
   Lobby — server mode. Talks to the Flask backend for:
     - lobby create/join/browse (REST)
     - shared playback state + chat (Socket.IO push)
     - music over a live QUIC/WebTransport session (see
       Lobby._connectMedia) — one raw-PCM stream straight out of the
       server's relay, no signaling handshake beyond the WebTransport
       CONNECT itself (see server.py's QuicPcmRelay/LobbyQuicProtocol).
       Replaces the old WebRTC relay (no ICE/TURN, but a little behind
       the live edge instead of sample-accurate) and, later, HLS (no
       AAC encode/container or hls.js dependency anymore either — see
       WebTransportPlayer). Voice chat has been removed along with
       WebRTC.
═══════════════════════════════════════════ */
const Lobby = {

  /* ───────── server URL setup ───────── */
  chooseDefaultServer() {
    Backend.setServer(window.location.origin);
  },
  chooseCustomServer(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    Backend.setServer(url);
  },

  async refreshPublicList() {
    const el = document.getElementById('public-lobby-list');
    el.innerHTML = `<div class="empty small"><div class="dots"><span></span><span></span><span></span></div></div>`;
    try {
      const list = await LobbyAPI.listPublic();
      if (!list.length) { el.innerHTML = `<div class="empty small"><p>No public lobbies right now</p></div>`; return; }
      const myCode = (S.mode === 'server' && S.lobby.active) ? S.lobby.code : null;
      el.innerHTML = list.map(l => `
        <div class="pl-item${l.code === myCode ? ' pl-mine' : ''}" data-code="${l.code}">
          <span class="pl-name">${esc(l.name)}${l.code === myCode ? ' <span class="cu-tag">YOURS</span>' : ''}</span>
          <span class="pl-count">${l.participants} online · ${l.code}</span>
        </div>`).join('');
      el.querySelectorAll('.pl-item').forEach(item => {
        item.addEventListener('click', async () => {
          // It's the lobby we're already hosting/in — joining it as a
          // second participant would just displace us as host (a fresh
          // join, new clientId, same as any other participant).
          if (S.mode === 'server' && S.lobby.active && item.dataset.code === S.lobby.code) { toast("You're already in this lobby", 'info', 1800); return; }
          const displayName = localStorage.getItem('nl_display_name') || 'Guest';
          await this.join(item.dataset.code, displayName);
        });
      });
    } catch (e) {
      el.innerHTML = `<div class="empty small"><p>Error: ${esc(e.message)}</p></div>`;
    }
  },

  // Join by typed code — the only way into a private lobby (they're never
  // in the public list). join() itself validates length and refuses a
  // lobby we're already in; the server rejects unknown codes.
  async joinByCode() {
    const input = document.getElementById('join-code-input');
    const btn = document.getElementById('join-code-btn');
    const code = input.value.toUpperCase().replace(/[^A-Z]/g, '').trim();
    input.value = code;
    if (!code) { toast('Enter a lobby code', 'warn'); input.focus(); return; }
    btn.disabled = true;
    try {
      const displayName = localStorage.getItem('nl_display_name') || 'Guest';
      const ok = await this.join(code, displayName);
      if (ok) input.value = '';
    } finally { btn.disabled = false; }
  },

  async create(name, isPublic, displayName) {
    try {
      const r = await LobbyAPI.create(name || 'Untitled Lobby', isPublic, displayName || 'Guest');
      this._enterLobby(r.code, r.clientId, r.token, true, displayName || 'Guest', r.state);
    } catch (e) {
      toast(`Failed to create lobby: ${e.message}`, 'error');
      UI.switchTab('config'); UI.renderConfigTab();
    }
  },

  async join(code, displayName) {
    code = (code || '').toUpperCase().trim();
    if (code.length !== 6) { toast('Lobby codes are 6 letters', 'warn'); return false; }
    // Already in this lobby — a second join would create a new participant
    // (new clientId) and displace us, so refuse it here at the source.
    // Checked live rather than trusting whatever the caller rendered earlier.
    if (S.mode === 'server' && S.lobby.active && S.lobby.code === code) {
      toast("You're already in this lobby", 'warn');
      return false;
    }
    try {
      const r = await LobbyAPI.join(code, displayName || 'Guest');
      this._enterLobby(r.code, r.clientId, r.token, r.isHost, displayName || 'Guest', r.state);
      return true;
    } catch (e) { toast(`Failed to join: ${e.message}`, 'error'); return false; }
  },

  // Tears down whatever lobby connection is currently active — socket,
  // the WebTransport session, and a best-effort server-side leave for
  // the OLD lobby — without leave()'s auto-rejoin dance. Called from
  // _enterLobby so both create() and join() get this for free; a plain
  // first join (S.lobby.active still false) is a no-op.
  _teardownCurrent() {
    if (!S.lobby.active) return;
    if (S.lobby.socket) { try { S.lobby.socket.disconnect(); } catch (_) {} }
    if (S.player) { try { S.player.destroy(); } catch (_) {} S.player = null; }
    if (S.lobby.code) LobbyAPI.leave(S.lobby.code, S.lobby.clientId).catch(() => {});
  },

  _enterLobby(code, clientId, token, isHost, displayName, initialState) {
    // Switching straight from one lobby into another — e.g. picking a
    // different one from Public Lobbies while already sitting in your own
    // auto-created lobby — skips leave()'s teardown entirely. Without this,
    // the OLD socket and, worse, the OLD WebTransportPlayer linger
    // alongside the new ones: the new lobby's state syncs fine (so the
    // player shows "playing"), but its real audio never actually arrives
    // because there's still a session #1 connected and reading frames
    // instead of session #2. A first-ever join has nothing active yet,
    // so this is a no-op then.
    this._teardownCurrent();

    S.mode = 'server';
    S.lobby.active = true;
    S.lobby.code = code;
    S.lobby.clientId = clientId;
    S.lobby.token = token;
    S.lobby.isHost = isHost;
    S.lobby.displayName = displayName;
    localStorage.setItem('nl_display_name', displayName);

    Main.enterApp();
    document.getElementById('hdr-standalone').style.display = 'none';
    document.getElementById('hdr-lobby').style.display = 'flex';
    document.getElementById('tab-chat-btn').style.display = 'flex';
    document.getElementById('lobby-code-display').textContent = code;
    document.getElementById('sdot')?.classList.add('ok');

    this._connectSocket(code, clientId);
    this._connectMedia();  // fire-and-forget — opens the lobby's live WebTransport audio session; see below
    UI.applyLockState();
    UI.renderConfigTab();
    toast(`Joined lobby ${code}${isHost ? ' as host' : ''}`, 'success');

    if (initialState) this._applyState(initialState);
  },

  _connectSocket(code, clientId) {
    if (S.lobby.socket) { S.lobby.socket.disconnect(); }
    const socket = io(Backend.serverUrl, { transports: ['websocket', 'polling'] });
    S.lobby.socket = socket;

    // 'connect' fires on the first connection AND after every automatic
    // reconnect (socket.io gives each attempt a fresh sid), so re-sending
    // join_lobby here is also how we re-associate with our lobby/clientId
    // after a drop — no separate 'reconnect' handler needed.
    socket.on('connect', () => {
      socket.emit('join_lobby', { code, clientId });
      document.getElementById('sdot')?.classList.remove('err');
      document.getElementById('sdot')?.classList.add('ok');
    });

    socket.on('join_error', (payload) => {
      const msg = payload?.error === 'not found' ? 'Lobby no longer exists' : (payload?.error || 'Failed to rejoin lobby');
      toast(msg, 'error', 5000);
    });

    socket.on('state', (state) => this._applyState(state));
    socket.on('participants', (list) => this._applyParticipants(list));
    socket.on('chat', (msg) => this._applyChat(msg));

    socket.on('disconnect', () => {
      document.getElementById('sdot')?.classList.remove('ok');
      document.getElementById('sdot')?.classList.add('err');
    });
  },

  _applyState(state) {
    S.lobby.lastServerState = state;
    const wasHost = S.lobby.isHost, wasDj = S.lobby.isDj;
    S.lobby.isHost = state.hostId === S.lobby.clientId;
    S.lobby.isDj = !S.lobby.isHost && (state.djs || []).includes(S.lobby.clientId);
    if (wasHost !== S.lobby.isHost || wasDj !== S.lobby.isDj) {
      UI.applyLockState();
      if (S.lobby.isHost && !wasHost) toast('You are now the host', 'info');
      else if (S.lobby.isDj && !wasDj) toast('You are now a DJ — you can control the player and queue', 'success', 4000);
      else if (wasDj && !S.lobby.isDj && !S.lobby.isHost) toast('You are no longer a DJ', 'info');
    }

    S.queue = state.queue || [];
    UI.renderQueue();
    UI.renderCurrentLobbyConfig();

    Engine._lobbySync(state);
  },

  // Applies a control endpoint's returned state immediately, so the person
  // who just took the action (play/pause/seek/queue-add/etc.) doesn't have
  // to wait for their own socket echo to see or hear the result.
  applyControlResult(result) {
    if (result && result.state) this._applyState(result.state);
  },

  // Host-only: rename the lobby and/or flip public/private visibility —
  // used by the Config tab. Returns true/false so callers can decide
  // whether to show an overall success toast.
  async updateSettings(patch) {
    try {
      const r = await LobbyAPI.updateSettings(S.lobby.code, S.lobby.clientId, patch);
      this._applyState(r.state);
      return true;
    } catch (e) { toast(`Error: ${e.message}`, 'error'); return false; }
  },

  // Host-only: appoint/remove a DJ. The server toggles, broadcasts the new
  // participants + state to everyone, and we apply the returned state so
  // the host's own UI updates without waiting for the socket echo.
  async toggleDj(targetId) {
    if (!S.lobby.isHost) { toast('Only the host can appoint DJs', 'warn'); return; }
    try {
      const r = await LobbyAPI.control(S.lobby.code, 'dj', { clientId: S.lobby.clientId, targetId });
      this._applyState(r.state);
    } catch (e) { toast(`Error: ${e.message}`, 'error'); }
  },

  // Anyone can rename THEMSELVES at any time from the Config tab.
  async rename(displayName) {
    try {
      const r = await LobbyAPI.rename(S.lobby.code, S.lobby.clientId, displayName);
      S.lobby.displayName = r.displayName;
      localStorage.setItem('nl_display_name', r.displayName);
      return true;
    } catch (e) { toast(`Error: ${e.message}`, 'error'); return false; }
  },

  _applyParticipants(list) {
    S.lobby.participants = list;
    const strip = document.getElementById('participants-strip');
    strip.innerHTML = list.slice(0, 8).map(p => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      return `<div class="pchip ${p.isHost ? 'is-host' : ''} ${p.isDj ? 'is-dj' : ''}" title="${esc(p.name)}${p.isHost ? ' (host)' : p.isDj ? ' (DJ)' : ''}">${esc(initial)}</div>`;
    }).join('');
    UI.renderChatUsers(list);
    UI.renderDjCard(list);
  },

  _applyChat(msg) {
    const log = document.getElementById('chat-log');
    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const el = document.createElement('div');

    if (msg.system) {
      el.className = 'chat-msg system';
      el.innerHTML = `<span class="cm-text">${esc(msg.text)}</span>`;
    } else {
      const mine = false; // server doesn't echo sender id back distinctly from others here
      el.className = 'chat-msg';
      el.innerHTML = `<span class="cm-name">${esc(msg.name)}</span><span class="cm-text">${esc(msg.text)}</span>`;
    }
    log.appendChild(el);
    if (wasAtBottom) log.scrollTop = log.scrollHeight;

    if (S.activeTab !== 'chat') {
      const badge = document.getElementById('chat-badge');
      badge.textContent = (parseInt(badge.textContent || '0') + 1) || 1;
    }
  },

  async sendChat() {
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    try { await LobbyAPI.chat(S.lobby.code, S.lobby.clientId, text); }
    catch (e) { toast(`Chat failed: ${e.message}`, 'error'); }
  },

  copyCode() {
    navigator.clipboard?.writeText(S.lobby.code).then(() => toast('Code copied', 'success', 1500))
      .catch(() => toast(S.lobby.code, 'info'));
  },

  // Best-effort synchronous-ish leave notice fired from a 'pagehide'
  // listener (tab close / navigation / refresh). sendBeacon queues the
  // request with the browser and survives the page unloading, unlike a
  // normal fetch() which gets cancelled. The server also detects the
  // socket connection dropping on its own after a grace period, so this just
  // makes teardown near-instant instead of waiting ~12s.
  leaveBeacon() {
    if (S.mode !== 'server' || !S.lobby.active || !S.lobby.code || !S.lobby.clientId) return;
    try {
      const url = `${Backend.serverUrl}/api/lobby/${S.lobby.code}/leave`;
      const blob = new Blob([JSON.stringify({ clientId: S.lobby.clientId })], { type: 'application/json' });
      navigator.sendBeacon?.(url, blob);
    } catch (_) {}
  },

  // `autoRejoin` (default true) is what keeps the app from ever landing in
  // a lobby-less limbo: S.mode null but Backend.serverUrl still pointed at
  // the Flask proxy (it's set once at boot and never cleared — see api.js —
  // so it plays on regardless of S.mode). Without a lobby to hang playback
  // off, that limbo state let you keep playing music with nothing tracking
  // it server-side: no lobby code, nobody to share it with, no chat — a
  // session that LOBBIES doesn't even know exists. So a plain "Leave" always
  // walks straight into a fresh default lobby, exactly like first load (see
  // Main.autoStart) — you're either in a lobby or explicitly in standalone
  // mode, never in between. The two callers that already have their own
  // follow-up (switching to standalone, switching Flask servers) pass
  // `autoRejoin: false` so this doesn't create a lobby only to abandon it a
  // moment later.
  async leave(opts = {}) {
    const { autoRejoin = true } = opts;
    const displayName = S.lobby.displayName || localStorage.getItem('nl_display_name') || 'Guest';

    if (S.lobby.socket) { S.lobby.socket.disconnect(); S.lobby.socket = null; }
    if (S.lobby.code) await LobbyAPI.leave(S.lobby.code, S.lobby.clientId);
    Engine._stopLocal();  // also destroys S.player (the WebTransportPlayer, if any) — see engine.js
    S.current = null; S.queue = [];
    // loopMode/autoplay/autoQueue were MIRRORS of the lobby's server-side
    // values while we were in it. Leaving hands ownership back to this
    // client, so start from defaults rather than inheriting whatever the
    // old host happened to have set.
    S.loopMode = 'none'; S.autoplay = 'enabled';
    S.autoQueue = []; S.autoQueueCount = 0;
    S.history = [];
    S.mode = null;
    S.lobby = { active:false, code:null, clientId:null, token:null, isHost:false, isDj:false, displayName:'', participants:[], socket:null, lastServerState:null, relayGen:0 };
    document.getElementById('hdr-lobby').style.display = 'none';
    document.getElementById('tab-chat-btn').style.display = 'none';
    document.getElementById('chat-log').innerHTML = '';
    document.getElementById('chat-users-list').innerHTML = '';
    document.getElementById('chat-users-count').textContent = '';
    UI.updatePlayerUI(); UI.renderQueue();
    UI.updateLoopButton(); UI.updateQueueHeader();

    if (autoRejoin) {
      const lobbyName = localStorage.getItem('nl_lobby_name') || 'New Lobby';
      await this.create(lobbyName, false, displayName);   // _enterLobby leaves whatever tab was open as-is
      return;
    }
    UI.switchTab('config');
    UI.renderConfigTab();
  },

  /* ───────── music — live WebTransport/QUIC audio session ─────────
     _connectMedia() runs once, right on joining the lobby: it opens a
     WebTransport session to the lobby's live PCM relay (see
     LobbyAPI.quicInfo/quicUrl, server.py's QuicPcmRelay/
     LobbyQuicProtocol) and hands it to S.player (a WebTransportPlayer —
     see webtransport-player.js), which reads the raw PCM straight into
     its own AudioContext scheduler.

     Ordering note: S.player is normally created lazily by
     Engine._lobbySync the first time server-authoritative state comes
     in — and _enterLobby applies `initialState` synchronously right
     after calling this (fire-and-forget), so _lobbySync very likely
     runs and creates S.player BEFORE this function's own await calls
     resolve. This creates S.player itself too, guarded the same way,
     so it works regardless of which one gets there first.

     No signaling round-trip like the old WebRTC connect beyond the one
     WebTransport handshake itself — once connected, a hard cut
     (skip/seek/filter change, `relayGen` bumping) doesn't need a
     reconnect either: it's just more audio arriving in the same
     continuous relay (see QuicPcmRelay in server.py) — the read loop in
     WebTransportPlayer picks it up on its own. */
  async _connectMedia() {
    if (!S.player) S.player = new WebTransportPlayer();
    const player = S.player;
    try {
      const info = await LobbyAPI.quicInfo();
      const url = LobbyAPI.quicUrl(S.lobby.code, info);
      await player.connect(url, info.certHashHex);
    } catch (e) {
      console.warn('Failed to connect lobby audio:', e);
      toast(`Couldn't connect to the lobby's audio (${e.message}) — try leaving and rejoining`, 'error', 8000);
    }

    // Playback itself starts once Engine._lobbySync (driven by the
    // server's 'state' broadcast) calls S.player.resume() — see
    // engine.js. Nothing to kick off here.
  },
};