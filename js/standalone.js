'use strict';
/* ═══════════════════════════════════════════
   Standalone mode — direct browser-to-NodeLink connection.
   No server, no lobby. Bring your own NodeLink host+password.
   Reachable any time from the Config tab (no onboarding screen) — see
   main.js's Main.autoStart(), which defaults the app to a fresh lobby on
   load, and UI.setConfigMode(), which switches Config between this and
   the lobby settings.
═══════════════════════════════════════════ */
const Standalone = {
  async connect() {
    const host = document.getElementById('sa-host').value.trim();
    const pass = document.getElementById('sa-pass').value.trim();
    if (!host || !pass) { toast('Enter host and password', 'warn'); return; }

    // Switching into standalone mode from an active lobby means leaving
    // it properly (socket disconnect, REST leave, voice teardown) rather
    // than just abandoning it client-side.
    if (S.mode === 'server' && S.lobby.active) await Lobby.leave({ autoRejoin: false });

    Backend.setStandalone(host, pass);
    try {
      const info = await Backend.info();
      S.mode = 'standalone';
      Main.enterApp();
      document.getElementById('hdr-standalone').style.display = 'flex';
      document.getElementById('hdr-lobby').style.display = 'none';
      document.getElementById('tab-chat-btn').style.display = 'none';
      document.getElementById('sa-disconnect-cfg').style.display = 'inline-block';
      this.setStatus('connected', info);
      document.getElementById('cors-note').classList.remove('show');
      UI.applyLockState();
      toast('Connected to NodeLink', 'success', 2000);
    } catch (e) {
      this.setStatus('error');
      const isCors = e.message.includes('Failed to fetch') || e.message.includes('NetworkError');
      if (isCors) {
        document.getElementById('cors-note').innerHTML =
          '⚠ CORS / connection error — NodeLink must have <code>cors: true</code> and <code>enableLoadStreamEndpoint: true</code> in config.js.';
        document.getElementById('cors-note').classList.add('show');
      }
      toast(`Connection failed: ${e.message}`, 'error', 6000);
    }
  },

  disconnect() {
    Engine._stopLocal();
    S.current = null; S.queue = []; S.history = [];
    S.mode = null;
    document.getElementById('hdr-standalone').style.display = 'none';
    document.getElementById('sa-disconnect-cfg').style.display = 'none';
    UI.updatePlayerUI(); UI.renderQueue();
    UI.switchTab('config');
    UI.renderConfigTab();
  },

  setStatus(s, info) {
    const dot = document.getElementById('sdot');
    const txt = document.getElementById('stxt');
    dot.className = '';
    if (s === 'connected') {
      dot.classList.add('ok');
      const ver = info?.version?.semver || info?.version || '?';
      const sources = (info?.sourceManagers || []).slice(0, 6).join(', ');
      txt.textContent = `NodeLink ${ver} · Sources: ${sources || '?'}`;
    } else if (s === 'error') {
      dot.classList.add('err');
      txt.textContent = 'Connection failed';
    }
  },
};