'use strict';
/* ═══════════════════════════════════════════
   Lobby — server mode. Talks to the Flask backend for:
     - lobby create/join/browse (REST)
     - shared playback state + chat (Socket.IO push)
     - voice chat (WebRTC via aiortc, server-side mixed per listener)
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
    } catch (e) { toast(`Failed to create lobby: ${e.message}`, 'error'); }
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

    Main.enterApp();
    document.getElementById('hdr-standalone').style.display = 'none';
    document.getElementById('hdr-lobby').style.display = 'flex';
    document.getElementById('tab-chat-btn').style.display = 'block';
    document.getElementById('lobby-code-display').textContent = code;
    document.getElementById('sdot')?.classList.add('ok');

    this._connectSocket(code, clientId);
    UI.applyLockState();
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

    Engine._lobbySync(state);
  },

  // Applies a control endpoint's returned state immediately, so the person
  // who just took the action (play/pause/seek/queue-add/etc.) doesn't have
  // to wait for their own socket echo to see or hear the result.
  applyControlResult(result) {
    if (result && result.state) this._applyState(result.state);
  },

  _applyParticipants(list) {
    S.lobby.participants = list;
    const strip = document.getElementById('participants-strip');
    strip.innerHTML = list.slice(0, 8).map(p => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      return `<div class="pchip ${p.isHost ? 'is-host' : ''}" title="${esc(p.name)}${p.isHost ? ' (host)' : ''}">${esc(initial)}<span class="mic-dot"></span></div>`;
    }).join('');
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

  async leave() {
    if (S.lobby.socket) { S.lobby.socket.disconnect(); S.lobby.socket = null; }
    if (S.lobby.pc) { S.lobby.pc.close(); S.lobby.pc = null; }
    if (S.lobby.micStream) { S.lobby.micStream.getTracks().forEach(t => t.stop()); S.lobby.micStream = null; }
    if (S.lobby.code) await LobbyAPI.leave(S.lobby.code, S.lobby.clientId);
    Engine._stopLocal();
    S.current = null; S.queue = [];
    S.lobby = { active:false, code:null, clientId:null, token:null, isHost:false, displayName:'', participants:[], socket:null, pc:null, micStream:null, micEnabled:false, lastServerState:null, relayGen:0 };
    UI.updatePlayerUI(); UI.renderQueue();
    document.getElementById('chat-log').innerHTML = '';
    document.getElementById('app').style.display = 'none';
    showOverlay('overlay-lobby-select');
  },

  /* ───────── WebRTC voice (aiortc relay/mixer on the server) ───────── */
  async toggleMic() {
    if (!S.lobby.pc) {
      await this._startVoice();
    } else {
      S.lobby.micEnabled = !S.lobby.micEnabled;
      if (S.lobby.micStream) {
        S.lobby.micStream.getAudioTracks().forEach(t => t.enabled = S.lobby.micEnabled);
      }
      this._updateMicBtn();
    }
  },

  async _startVoice() {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      S.lobby.micStream = micStream;
      S.lobby.micEnabled = true;

      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      S.lobby.pc = pc;

      pc.addTransceiver(micStream.getAudioTracks()[0], { direction: 'sendrecv', streams: [micStream] });

      pc.ontrack = (ev) => {
        const audioEl = document.getElementById('voice-audio');
        if (audioEl.srcObject !== ev.streams[0]) audioEl.srcObject = ev.streams[0];
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitIceComplete(pc);

      const res = await fetch(LobbyAPI.webrtcOfferUrl(S.lobby.code), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: S.lobby.clientId, sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const answer = await res.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      this._updateMicBtn();
      toast('🎤 Voice connected', 'success', 2000);
    } catch (e) {
      toast(`Voice error: ${e.message}`, 'error', 5000);
      if (S.lobby.pc) { S.lobby.pc.close(); S.lobby.pc = null; }
    }
  },

  _waitIceComplete(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      function check() {
        if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); }
      }
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 3000); // safety timeout — proceed with whatever candidates gathered
    });
  },

  _updateMicBtn() {
    const btn = document.getElementById('btn-mic');
    if (S.lobby.micEnabled) { btn.textContent = '🎤 On'; btn.classList.add('mic-on'); }
    else { btn.textContent = '🎤 Off'; btn.classList.remove('mic-on'); }
  },
};