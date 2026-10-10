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
    UI.updateGaplessButton();
    UI.updateFairButton();
  },

  async autoStart() {
    Lobby.chooseDefaultServer();
    UI.updateServerUrlDisplay();
    let displayName = localStorage.getItem('nl_display_name');
    if (!displayName) {
      displayName = `Guest${Math.floor(1000 + Math.random() * 9000)}`;
      localStorage.setItem('nl_display_name', displayName);
    }
    // Gapless defaults ON: no stored preference yet reads as on, an
    // explicit '0' (the person turned it off before) is respected.
    try {
      const stored = localStorage.getItem('nl_gapless');
      S.gaplessEnabled = stored === null ? true : stored === '1';
    } catch (_) {}
    const lobbyName = localStorage.getItem('nl_lobby_name') || 'New Lobby';
    await Lobby.create(lobbyName, false, displayName);
  },

  // Portrait layout only (see the "STICKY PLAYER" block in style.css): the
  // player is a square with its controls overlaid on the bottom, and on
  // scroll everything above the controls slides away while the controls stay
  // put. CSS needs to know how tall the whole player and its bottom panel
  // are to compute that offset, and the panel's height varies with screen
  // width (its rows wrap), so measure both and keep them current.
  _initStickyPlayer() {
    const left = document.getElementById('left');
    const panel = document.getElementById('player-panel');
    if (!left || !panel) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty('--player-panel-h', panel.offsetHeight + 'px');
      root.style.setProperty('--player-left-h', left.offsetHeight + 'px');
    };
    sync();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(sync);
      ro.observe(panel); ro.observe(left);
    }
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  // Before anything else paints: reapplies whatever skin was active last
  // session, so there's no flash of the stock theme on load.
  Skins.init();
  Viz.init();
  UI.setupProgressBar();
  Main._initStickyPlayer();

  /* ───────── App header (standalone) ───────── */
  document.getElementById('btn-disconnect-sa').addEventListener('click', () => Standalone.disconnect());

  /* ───────── App header (lobby) ───────── */
  document.getElementById('btn-copy-code').addEventListener('click', () => Lobby.copyCode());
  document.getElementById('btn-leave-lobby').addEventListener('click', () => Lobby.leave());

  /* ───────── Playback controls ───────── */
  document.getElementById('btn-play').addEventListener('click', () => Engine.togglePause());
  document.getElementById('btn-next').addEventListener('click', () => Engine.skip());
  document.getElementById('btn-prev').addEventListener('click', () => Engine.prev());
  // Stop: tap = stop playback, hold ~0.8s = clear history instead.
  (() => {
    const btn = document.getElementById('btn-stop');
    const HOLD_MS = 800;
    let timer = null, fired = false;
    const release = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      btn.classList.remove('holding');
      // The click that follows a completed hold must be swallowed; clear the flag afterwards.
      if (fired) setTimeout(() => { fired = false; }, 150);
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fired = false;
      btn.classList.add('holding');
      timer = setTimeout(() => {
        timer = null; fired = true;
        btn.classList.remove('holding');
        Engine.clearHistory();
      }, HOLD_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, release));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());   // touch long-press menu
    btn.addEventListener('click', (e) => {
      if (fired) { fired = false; e.preventDefault(); return; }
      Engine.stop();
    });
  })();
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
  document.getElementById('btn-qfair').addEventListener('click', () => Engine.toggleFair());
  document.getElementById('btn-autoplay').addEventListener('click', () => Engine.cycleAutoplay());
  document.getElementById('dj-list').addEventListener('click', (e) => {
    const b = e.target.closest('.dj-btn');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'dj') Lobby.toggleDj(b.dataset.id);
    else if (act === 'kick') Lobby.kick(b.dataset.id, b.closest('.dj-item')?.dataset.name);
    else if (act === 'ban') Lobby.ban(b.dataset.id, b.closest('.dj-item')?.dataset.name);
    else if (act === 'unban') Lobby.unban(b.dataset.uid);
  });
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
    if (b.dataset.tab === 'bindings') Bindings.renderTab();
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

  /* ───────── Download (now-playing) ───────── */
  document.getElementById('btn-dl').addEventListener('click', e => UI.openDownloadMenu(e.currentTarget, S.current));
  document.getElementById('public-refresh-btn').addEventListener('click', () => Lobby.refreshPublicList());
  document.getElementById('btn-link').addEventListener('click', () => UI.openTrackLink(S.current));

  /* ───────── Media Session (lock-screen / hardware media keys) ─────────
     Metadata + playback/position state are pushed from
     UI.updateMediaSession() whenever the track or play state changes
     (see ui.js); this just wires the OS-side controls back into the same
     Engine methods the on-page buttons use, so host-locking in lobby
     mode etc. is respected automatically. */
  if ('mediaSession' in navigator) {
    // Explicit play/pause rather than two toggles: headphone buttons can
    // send 'play' while we already think we're playing (or vice versa),
    // and a blind toggle would then do the opposite of what was pressed.
    navigator.mediaSession.setActionHandler('play', async () => {
      console.debug('[mediaSession] play', { paused: S.player?.isPaused });
      if (!S.current || !S.player || S.player.isPaused) await Engine.togglePause();
      else UI.updateMediaSession();
    });
    navigator.mediaSession.setActionHandler('pause', async () => {
      console.debug('[mediaSession] pause', { paused: S.player?.isPaused });
      if (S.current && S.player && !S.player.isPaused) await Engine.togglePause();
      else UI.updateMediaSession();
    });
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
  {
    const ci = document.getElementById('cfg-code-input');
    const doChange = async () => {
      const btn = document.getElementById('cfg-code-btn');
      btn.disabled = true;
      try { if (await Lobby.changeCode(ci.value)) ci.value = ''; } finally { btn.disabled = false; }
    };
    ci.addEventListener('input', () => { ci.value = ci.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6); });
    ci.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doChange(); } });
    document.getElementById('cfg-code-btn').addEventListener('click', doChange);
  }
  {
    const pi = document.getElementById('cfg-pass-input');
    pi.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); UI.setLobbyPassword(false); } });
    document.getElementById('cfg-pass-set').addEventListener('click', () => UI.setLobbyPassword(false));
    document.getElementById('cfg-pass-clear').addEventListener('click', () => UI.setLobbyPassword(true));
    document.getElementById('join-pass-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); Lobby.joinByCode(); } });
  }
  document.getElementById('sessions-save').addEventListener('click', () => Sessions.save());
  document.getElementById('heal-cancel').addEventListener('click', () => Heal.cancel());
  document.getElementById('cfg-save-lobby').addEventListener('click', () => UI.saveConfigLobby());
  document.getElementById('cfg-leave-lobby').addEventListener('click', () => Lobby.leave());

  /* ───────── Config: join a lobby by code (works for private lobbies) ───────── */
  document.getElementById('join-code-btn').addEventListener('click', () => Lobby.joinByCode());
  document.getElementById('join-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') Lobby.joinByCode(); });
  document.getElementById('join-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  /* ───────── Config: user settings (display name / default lobby name) ───────── */
  document.getElementById('us-save').addEventListener('click', () => UI.saveUserSettings());

  /* ───────── Config: Flask server ───────── */
  document.querySelectorAll('input[name="cfg-srv"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('cfg-srv-url').style.display = (r.value === 'custom' && r.checked) ? 'block' : 'none';
    });
  });
  document.getElementById('cfg-srv-switch').addEventListener('click', () => UI.switchFlaskServer());

  /* ───────── Bindings tab ───────── */
  document.getElementById('btn-bnd-reset-key').addEventListener('click', () => Bindings.resetKeys());
  document.getElementById('btn-bnd-reset-pad').addEventListener('click', () => Bindings.resetPad());

  // Keyboard shortcuts are remappable (see the Bindings tab) — Bindings
  // owns its own keydown/keyup listeners, so nothing to wire up here.
  Bindings.load();
  Bindings.init();
  VKeyboard.init();
  Pad.init();
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

  /* ───────── Confirm on close ─────────
     A host with something worth keeping gets the browser's "Leave site?"
     alert on tab close / refresh / navigation. Browsers don't allow custom
     text here. Choosing Leave carries on to 'pagehide' above, which saves the
     session; Cancel keeps the lobby running. */
  window.addEventListener('beforeunload', (e) => {
    if (typeof Sessions !== 'undefined' && Sessions.shouldConfirmClose()) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
});