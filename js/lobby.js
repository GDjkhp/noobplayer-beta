'use strict';
/* ═══════════════════════════════════════════
   Lobby — server mode. Talks to the Flask backend for:
     - lobby create/join/browse (REST)
     - shared playback state + chat (Socket.IO push)
     - music over a live HLS stream (see Lobby._connectMedia) — a plain
       HTTP GET of the lobby's rolling .m3u8 playlist, played back via
       hls.js (native HLS in Safari). Replaces the old WebRTC relay:
       no signaling, no ICE/TURN, but a couple of seconds behind the
       live edge instead of sample-accurate (see server.py's HLSMuxer).
       Voice chat has been removed along with WebRTC.
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
      el.innerHTML = list.map(l => `
        <div class="pl-item" data-code="${l.code}">
          <span class="pl-name">${esc(l.name)}</span>
          <span class="pl-count">${l.participants} online · ${l.code}</span>
        </div>`).join('');
      el.querySelectorAll('.pl-item').forEach(item => {
        item.addEventListener('click', () => {
          document.getElementById('join-code').value = item.dataset.code;
          document.querySelectorAll('.lobby-tab').forEach(t => t.classList.toggle('on', t.dataset.ltab === 'join'));
          document.querySelectorAll('.lobby-pane').forEach(p => p.classList.toggle('on', p.id === 'ltab-join'));
        });
      });
    } catch (e) {
      el.innerHTML = `<div class="empty small"><p>Error: ${esc(e.message)}</p></div>`;
    }
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
    if (code.length !== 6) { toast('Lobby codes are 6 letters', 'warn'); return; }
    try {
      const r = await LobbyAPI.join(code, displayName || 'Guest');
      this._enterLobby(r.code, r.clientId, r.token, r.isHost, displayName || 'Guest', r.state);
    } catch (e) { toast(`Failed to join: ${e.message}`, 'error'); }
  },

  _enterLobby(code, clientId, token, isHost, displayName, initialState) {
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
    document.getElementById('tab-chat-btn').style.display = 'block';
    document.getElementById('lobby-code-display').textContent = code;
    document.getElementById('sdot')?.classList.add('ok');

    this._connectSocket(code, clientId);
    this._connectMedia();  // fire-and-forget — points #lobby-audio at the lobby's live HLS stream; see below
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
    const wasHost = S.lobby.isHost;
    S.lobby.isHost = state.hostId === S.lobby.clientId;
    if (wasHost !== S.lobby.isHost) {
      UI.applyLockState();
      if (S.lobby.isHost && !wasHost) toast('You are now the host', 'info');
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
      return `<div class="pchip ${p.isHost ? 'is-host' : ''}" title="${esc(p.name)}${p.isHost ? ' (host)' : ''}">${esc(initial)}</div>`;
    }).join('');
    UI.renderChatUsers(list);
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
    if (S.lobby.hls) { try { S.lobby.hls.destroy(); } catch (_) {} S.lobby.hls = null; }
    const lobbyAudio = document.getElementById('lobby-audio');
    if (lobbyAudio) { lobbyAudio.pause(); lobbyAudio.removeAttribute('src'); lobbyAudio.load(); }
    if (S.lobby.code) await LobbyAPI.leave(S.lobby.code, S.lobby.clientId);
    Engine._stopLocal();
    S.current = null; S.queue = [];
    // loopMode/autoplay/autoQueue were MIRRORS of the lobby's server-side
    // values while we were in it. Leaving hands ownership back to this
    // client, so start from defaults rather than inheriting whatever the
    // old host happened to have set.
    S.loopMode = 'none'; S.autoplay = 'enabled';
    S.autoQueue = []; S.autoQueueCount = 0;
    S.history = [];
    S.mode = null;
    S.lobby = { active:false, code:null, clientId:null, token:null, isHost:false, displayName:'', participants:[], socket:null, hls:null, lastServerState:null, relayGen:0 };
    document.getElementById('hdr-lobby').style.display = 'none';
    document.getElementById('tab-chat-btn').style.display = 'none';
    document.getElementById('chat-log').innerHTML = '';
    document.getElementById('chat-users-list').innerHTML = '';
    document.getElementById('chat-users-count').textContent = '';
    UI.updatePlayerUI(); UI.renderQueue();
    UI.updateLoopButton(); UI.updateQueueHeader();

    if (autoRejoin) {
      await this.create('New Lobby', false, displayName);   // _enterLobby leaves whatever tab was open as-is
      return;
    }
    UI.switchTab('config');
    UI.renderConfigTab();
  },

  /* ───────── music — live HLS stream ─────────
     _connectMedia() runs once, right on joining the lobby: it points
     #lobby-audio at the lobby's rolling live.m3u8 playlist (see
     LobbyAPI.hlsUrl / server.py's HLSMuxer) via hls.js, which handles
     the playlist polling and segment fetch/buffer/feed loop. Safari (and
     any browser with native HLS support) skips hls.js entirely and just
     sets the <audio> element's src directly — canPlayType covers that.

     No signaling round-trip like the old WebRTC connect — the URL is
     stable and joinable immediately, hls.js just starts pulling
     segments over plain HTTP. A hard cut (skip/seek/filter change,
     `relayGen` bumping) doesn't need a reconnect either: it's just more
     audio arriving in the same continuous stream (see HLSMuxer in
     server.py) — hls.js's own live-playlist polling picks it up on its
     own. */
  async _connectMedia() {
    const audio = document.getElementById('lobby-audio');
    if (!audio) return;
    const url = LobbyAPI.hlsUrl(S.lobby.code);

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        // Keep the client's own buffer short too — a big buffer just
        // means sitting further from the live edge, which defeats the
        // point of the server's short (see config.HLS_SEGMENT_SECONDS)
        // segments. liveSyncDurationCount is "how many segments behind
        // the playlist head to target", the hls.js analogue of
        // HLS_LIST_SIZE on the server.
        liveSyncDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.1, // nudges playback slightly faster when it drifts behind the live edge, instead of just accumulating lag forever
        backBufferLength: 10,
      });
      S.lobby.hls = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        console.warn('hls.js fatal error:', data.type, data.details);
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            toast('Lobby stream connection dropped — retrying…', 'warn', 3000);
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            toast('Lobby stream error — try leaving and rejoining', 'error', 6000);
            break;
        }
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari (and any browser with native HLS support) plays an HLS
      // playlist directly off a plain src — no library needed.
      S.lobby.hls = null;
      audio.src = url;
    } else {
      toast('This browser can\u2019t play the lobby\u2019s audio stream (no HLS support)', 'error', 8000);
      return;
    }

    // Playback itself starts once Engine._lobbySync (driven by the
    // server's 'state' broadcast) calls S.player.resume() — see
    // engine.js. Nothing to kick off here.
  },
};