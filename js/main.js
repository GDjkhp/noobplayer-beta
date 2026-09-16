'use strict';
/* ═══════════════════════════════════════════
   Main — boot flow + global event wiring.

   The app used to open on a "Standalone vs Server" mode-select screen
   that blocked everything else until you picked one. It now boots
   straight into a freshly-created private lobby on this page's own
   origin (see autoStart below) and shows the normal player UI
   immediately — switching to standalone mode, renaming/reconfiguring
   the lobby, or joining/creating a different one all now live in the
   Config tab (see ui.js's renderConfigTab/setConfigMode) instead of a
   blocking overlay.
═══════════════════════════════════════════ */
const Main = {
  enterApp() {
    UI.updatePlayerUI();
    UI.renderQueue();
    UI.updateFilterStatus();
  },

  async autoStart() {
    Lobby.chooseDefaultServer();
    UI.updateServerUrlDisplay();
    let displayName = localStorage.getItem('nl_display_name');
    if (!displayName) {
      displayName = `Guest${Math.floor(1000 + Math.random() * 9000)}`;
      localStorage.setItem('nl_display_name', displayName);
    }
    await Lobby.create('New Lobby', false, displayName);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  UI.setupProgressBar();

  /* ───────── App header (standalone) ───────── */
  document.getElementById('btn-disconnect-sa').addEventListener('click', () => Standalone.disconnect());

  /* ───────── App header (lobby) ───────── */
  document.getElementById('btn-copy-code').addEventListener('click', () => Lobby.copyCode());
  document.getElementById('btn-leave-lobby').addEventListener('click', () => Lobby.leave());
  document.getElementById('btn-mic').addEventListener('click', () => Lobby.toggleMic());

  /* ───────── Playback controls ───────── */
  document.getElementById('btn-play').addEventListener('click', () => Engine.togglePause());
  document.getElementById('btn-next').addEventListener('click', () => Engine.skip());
  document.getElementById('btn-prev').addEventListener('click', () => Engine.prev());
  document.getElementById('btn-stop').addEventListener('click', () => Engine.stop());
  document.getElementById('btn-b10').addEventListener('click', () => {
    if (S.player) Engine.seekTo(S.player.getPositionMs() - 10000);
  });
  document.getElementById('btn-f10').addEventListener('click', () => {
    if (S.player) Engine.seekTo(Math.min(S.current?.info.length || 0, S.player.getPositionMs() + 10000));
  });
  document.getElementById('loop-btn').addEventListener('click', () => Engine.cycleLoop());
  document.getElementById('btn-shuf').addEventListener('click', () => Engine.shuffleQueue());

  document.getElementById('btn-qshuf').addEventListener('click', () => Engine.shuffleQueue());
  document.getElementById('btn-qclr').addEventListener('click', () => {
    if (!S.queue.length) { toast('Queue is already empty', 'warn'); return; }
    Engine.clearQueue();
  });

  document.getElementById('vol-sl').addEventListener('input', function() {
    const v = this.value / 100;
    document.getElementById('vol-lbl').textContent = this.value + '%';
    if (S.player) S.player.setVolume(v);
  });

  /* ───────── Search ───────── */
  document.getElementById('btn-srch').addEventListener('click', () => UI.doSearch());
  document.getElementById('si').addEventListener('keydown', e => { if (e.key === 'Enter') UI.doSearch(); });

  /* ───────── Tabs ───────── */
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    UI.switchTab(b.dataset.tab);
    if (b.dataset.tab === 'chat') document.getElementById('chat-badge').textContent = '';
    if (b.dataset.tab === 'config') UI.renderConfigTab();
  }));

  /* ───────── Lyrics ───────── */
  document.getElementById('btn-lyr').addEventListener('click', () => UI.fetchLyrics());

  /* ───────── Filters ───────── */
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      UI.applyPreset(btn.dataset.preset);
      await Engine.applyFilters(PRESETS[btn.dataset.preset]);
      toast(`Filter: ${btn.dataset.preset}`, 'success', 1500);
    });
  });
  [['f-speed','f-speed-v'],['f-pitch','f-pitch-v'],['f-rate','f-rate-v'],
   ['f-edel','f-edel-v'],['f-efb','f-efb-v'],['f-emix','f-emix-v'],['f-rot','f-rot-v']]
    .forEach(([sid,lid]) => document.getElementById(sid).addEventListener('input', () => UI.syncSliderLabel(sid, lid)));
  document.getElementById('btn-apply-flt').addEventListener('click', () => Engine.applyFilters(UI.buildFiltersFromUI()));

  /* ───────── Chapters ───────── */
  document.getElementById('chaps-head').addEventListener('click', () => {
    const list = document.getElementById('chaps-list');
    const arr = document.getElementById('chap-arr');
    list.classList.toggle('open');
    arr.textContent = list.classList.contains('open') ? '▾' : '▸';
  });

  /* ───────── Meaning ───────── */
  document.getElementById('btn-meaning').addEventListener('click', () => UI.fetchMeaning());
  document.getElementById('meaning-close').addEventListener('click', () => document.getElementById('meaning-modal').classList.remove('show'));
  document.getElementById('meaning-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('meaning-modal')) document.getElementById('meaning-modal').classList.remove('show');
  });

  /* ───────── Chat ───────── */
  document.getElementById('chat-send').addEventListener('click', () => Lobby.sendChat());
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') Lobby.sendChat(); });

  /* ───────── Config: mode toggle (Lobby / Standalone) ───────── */
  document.querySelectorAll('.cfg-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => UI.setConfigMode(btn.dataset.cfgmode));
  });

  /* ───────── Config: standalone connection ───────── */
  document.getElementById('sa-connect').addEventListener('click', () => Standalone.connect());
  ['sa-host','sa-pass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') Standalone.connect(); });
  });
  document.getElementById('sa-disconnect-cfg').addEventListener('click', () => Standalone.disconnect());

  /* ───────── Config: current lobby settings ───────── */
  document.getElementById('cfg-copy-code').addEventListener('click', () => Lobby.copyCode());
  document.getElementById('cfg-save-lobby').addEventListener('click', () => UI.saveConfigLobby());
  document.getElementById('cfg-leave-lobby').addEventListener('click', () => Lobby.leave());

  /* ───────── Config: switch to a different lobby (join / create / browse) ───────── */
  document.querySelectorAll('.lobby-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lobby-tab').forEach(t => t.classList.toggle('on', t === tab));
      document.querySelectorAll('.lobby-pane').forEach(p => p.classList.toggle('on', p.id === 'ltab-' + tab.dataset.ltab));
      if (tab.dataset.ltab === 'browse') Lobby.refreshPublicList();
    });
  });
  document.getElementById('join-go').addEventListener('click', () => {
    Lobby.join(document.getElementById('join-code').value, document.getElementById('join-name').value.trim());
  });
  document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('join-go').click(); });
  document.getElementById('create-go').addEventListener('click', () => {
    const isPublic = document.querySelector('input[name="vis"]:checked').value === 'public';
    Lobby.create(document.getElementById('create-lobby-name').value.trim(), isPublic, document.getElementById('create-name').value.trim());
  });

  /* ───────── Config: Flask server ───────── */
  document.querySelectorAll('input[name="cfg-srv"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('cfg-srv-url').style.display = (r.value === 'custom' && r.checked) ? 'block' : 'none';
    });
  });
  document.getElementById('cfg-srv-switch').addEventListener('click', () => UI.switchFlaskServer());

  /* ───────── Keyboard shortcuts ───────── */
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const posMs = () => S.player ? S.player.getPositionMs() : 0;
    switch (e.code) {
      case 'Space':      e.preventDefault(); Engine.togglePause(); break;
      case 'ArrowRight': e.shiftKey ? Engine.skip() : Engine.seekTo(posMs() + 5000); break;
      case 'ArrowLeft':  e.shiftKey ? Engine.prev() : Engine.seekTo(posMs() - 5000); break;
      case 'ArrowUp':    e.preventDefault(); { const sl=document.getElementById('vol-sl'); sl.value=Math.min(100,parseInt(sl.value)+5); sl.dispatchEvent(new Event('input')); } break;
      case 'ArrowDown':  e.preventDefault(); { const sl=document.getElementById('vol-sl'); sl.value=Math.max(0,parseInt(sl.value)-5); sl.dispatchEvent(new Event('input')); } break;
      case 'KeyL': Engine.cycleLoop(); break;
      case 'KeyS': Engine.shuffleQueue(); break;
      case 'KeyF': UI.switchTab('search'); document.getElementById('si').focus(); break;
      case 'KeyQ': UI.switchTab('queue'); break;
      case 'KeyY': UI.switchTab('lyrics'); break;
    }
  });

  Main.autoStart();

  /* ───────── Leave-on-close ─────────
     Tab close / refresh / navigation don't run normal JS to completion, so
     this has to be a 'pagehide' listener using sendBeacon (survives the
     page unloading). The server also self-heals via an SSE-disconnect
     grace period if this never fires (e.g. the browser kills the page
     before even 'pagehide' runs), so this is a fast-path, not the only
     safety net. */
  window.addEventListener('pagehide', () => {
    if (typeof Lobby !== 'undefined') Lobby.leaveBeacon();
  });
});