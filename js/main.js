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
    UI.updateGaplessButton();
  },

  async autoStart() {
    Lobby.chooseDefaultServer();
    UI.updateServerUrlDisplay();
    let displayName = localStorage.getItem('nl_display_name');
    if (!displayName) {
      displayName = `Guest${Math.floor(1000 + Math.random() * 9000)}`;
      localStorage.setItem('nl_display_name', displayName);
    }
    try { S.gaplessEnabled = localStorage.getItem('nl_gapless') === '1'; } catch (_) {}
    await Lobby.create('New Lobby', false, displayName);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  // Before anything else paints: reapplies whatever skin was active last
  // session, so there's no flash of the stock theme on load.
  Skins.init();
  Viz.init();
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
  document.getElementById('gapless-btn').addEventListener('click', () => Engine.toggleGapless());
  document.getElementById('btn-shuf').addEventListener('click', () => Engine.shuffleQueue());

  document.getElementById('btn-qshuf').addEventListener('click', () => Engine.shuffleQueue());
  document.getElementById('btn-qsmart').addEventListener('click', () => Engine.smartShuffle());
  document.getElementById('btn-qfair').addEventListener('click', () => Engine.fairQueue());
  document.getElementById('btn-autoplay').addEventListener('click', () => Engine.cycleAutoplay());
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
    if (b.dataset.tab === 'skins') Skins.renderTab();
    // The visualizer burns a rAF loop, so it's started on entering the tab
    // and stopped on leaving rather than running behind hidden panes.
    if (b.dataset.tab === 'viz') Viz.renderTab(); else Viz.stop();
  }));

  /* ───────── Visualizer ───────── */
  document.querySelectorAll('.viz-tab').forEach(t => {
    t.addEventListener('click', () => Viz._switchVizTab(t.dataset.vtab));
  });
  document.getElementById('btn-viz-run').addEventListener('click', () => Viz.runDraft());
  document.getElementById('btn-viz-save').addEventListener('click', () => Viz.saveCurrent());
  document.getElementById('btn-viz-publish').addEventListener('click', () => Viz.publish());
  document.getElementById('btn-viz-export').addEventListener('click', () => Viz.exportDraft());
  document.getElementById('btn-viz-import').addEventListener('click', () => Viz.importViz());
  document.getElementById('btn-viz-refresh').addEventListener('click', () => Viz.refreshGallery());
  document.getElementById('btn-viz-full').addEventListener('click', () => Viz.toggleFullscreen());
  document.querySelectorAll('[data-vsort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-vsort]').forEach(b => b.classList.toggle('on', b === btn));
      Viz.refreshGallery(btn.dataset.vsort);
    });
  });

  /* ───────── Skins ───────── */
  document.querySelectorAll('.skin-tab').forEach(t => {
    t.addEventListener('click', () => Skins._switchSkinTab(t.dataset.stab));
  });
  document.getElementById('btn-skin-save').addEventListener('click', () => Skins.saveCurrent());
  document.getElementById('btn-skin-publish').addEventListener('click', () => Skins.publish());
  document.getElementById('btn-skin-export').addEventListener('click', () => Skins.exportDraft());
  document.getElementById('btn-skin-import').addEventListener('click', () => Skins.importSkin());
  document.getElementById('btn-skin-reset').addEventListener('click', () => Skins.reset());
  document.getElementById('btn-skin-refresh').addEventListener('click', () => Skins.refreshGallery());
  document.querySelectorAll('[data-ssort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-ssort]').forEach(b => b.classList.toggle('on', b === btn));
      Skins.refreshGallery(btn.dataset.ssort);
    });
  });

  /* ───────── Lyrics ───────── */
  document.getElementById('btn-lyr').addEventListener('click', () => UI.fetchLyrics());

  /* ───────── Download (now-playing) ───────── */
  document.getElementById('btn-dl').addEventListener('click', e => UI.openDownloadMenu(e.currentTarget, S.current));

  /* ───────── Media Session (lock-screen / hardware media keys) ─────────
     Metadata + playback/position state are pushed from
     UI.updateMediaSession() whenever the track or play state changes
     (see ui.js); this just wires the OS-side controls back into the same
     Engine methods the on-page buttons use, so host-locking in lobby
     mode etc. is respected automatically. */
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => Engine.togglePause());
    navigator.mediaSession.setActionHandler('pause', () => Engine.togglePause());
    navigator.mediaSession.setActionHandler('previoustrack', () => Engine.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => Engine.skip());
    navigator.mediaSession.setActionHandler('stop', () => Engine.stop());
    navigator.mediaSession.setActionHandler('seekbackward', details => {
      if (!S.player) return;
      Engine.seekTo(S.player.getPositionMs() - (details.seekOffset || 10) * 1000);
    });
    navigator.mediaSession.setActionHandler('seekforward', details => {
      if (!S.player) return;
      Engine.seekTo(Math.min(S.current?.info.length || 0, S.player.getPositionMs() + (details.seekOffset || 10) * 1000));
    });
    try {
      navigator.mediaSession.setActionHandler('seekto', details => {
        if (details.seekTime == null) return;
        Engine.seekTo(details.seekTime * 1000);
      });
    } catch (_) { /* not all browsers support the 'seekto' action */ }
  }

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
      case 'KeyS': e.shiftKey ? Engine.smartShuffle() : Engine.shuffleQueue(); break;
      case 'KeyA': Engine.cycleAutoplay(); break;
      case 'KeyF': UI.switchTab('search'); document.getElementById('si').focus(); break;
      case 'KeyQ': UI.switchTab('queue'); break;
      case 'KeyY': UI.switchTab('lyrics'); break;
      case 'KeyK': UI.switchTab('skins'); Skins.renderTab(); Viz.stop(); break;
      case 'KeyV': UI.switchTab('viz'); Viz.renderTab(); break;
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