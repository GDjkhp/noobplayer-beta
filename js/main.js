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
    // Invite link (?lobby=CODE&password=PW): read it and wipe it from the
    // address bar RIGHT AWAY — before any prompt or network call — so a
    // password never sits on screen (streams, screenshots) or in history.
    const invite = Lobby.consumeInviteParams();
    Lobby.chooseDefaultServer();
    UI.updateServerUrlDisplay();
    // A server with a password: ask for it BEFORE anything else talks to it
    // (the window can't be dismissed — there is no site without the password).
    await Auth.ensure(Backend.serverUrl);
    let displayName = Store.getItem('nl_display_name');
    if (!displayName) {
      displayName = `Guest${Math.floor(1000 + Math.random() * 9000)}`;
      Store.setItem('nl_display_name', displayName);
    }
    // Gapless defaults ON: no stored preference yet reads as on, an
    // explicit '0' (the person turned it off before) is respected.
    try {
      const stored = Store.getItem('nl_gapless');
      S.gaplessEnabled = stored === null ? true : stored === '1';
    } catch (_) {}
    // Immediate join from an invite link; if it fails (bad code, wrong
    // password, cancelled prompt) fall through to the usual own lobby.
    if (invite && await Lobby.join(invite.code, displayName, invite.password)) return;
    const lobbyName = Store.getItem('nl_lobby_name') || 'New Lobby';
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

  // Side-by-side layout only: the player column is as wide as the viewport is
  // tall, minus the controls panel, so the square artwork + panel fill the
  // column top to bottom and there's no empty gap under the player. The width
  // is measured because the panel's height varies (its rows wrap, the title
  // and "Requested by" line come and go). Portrait phones/tablets use the
  // overlaid-square layout, which has no gap, so the override is removed there.
  // The cover's height (--art-h) is fitted the same way, so a short window shrinks the
  // cover instead of making the player scroll.
  _initFitPlayerHeight() {
    const main = document.getElementById('main');
    const left = document.getElementById('left');
    const panel = document.getElementById('player-panel');
    if (!main || !left || !panel) return;
    const sideBySide = window.matchMedia('(min-width: 1001px), (max-width: 1000px) and (orientation: landscape)');
    let busy = false;
    const fit = () => {
      if (busy) return;
      busy = true;
      try {
        if (!sideBySide.matches) { main.style.removeProperty('--left-w'); main.style.removeProperty('--art-h'); return; }
        const vw = window.innerWidth;
        // The narrowest the column may get. This used to be the stylesheet's 480px, which kept
        // the cover from staying square on a wide but short window (the column couldn't shrink
        // to match the height, so the cover came out 480 x 448). 360px still fits the controls
        // (they wrap onto an extra row, as they do at ~450px); below that the cover crops instead.
        const minW = vw > 1000 ? 360 : Math.min(380, Math.max(280, vw * 0.36));
        const maxW = Math.max(minW, Math.floor(vw * 0.6));                         // always leave room for the tabs
        const avail = main.clientHeight;                                           // the page doesn't scroll: #main is exactly the height under the header
        let w = minW;
        // The panel re-wraps as the column's width changes, so its height (and therefore the
        // width we want) depends on the width itself. Settle over a few passes, and stop as
        // soon as a width repeats: two widths that keep answering each other is a 2-cycle,
        // and chasing it is exactly what made the layout flip back and forth every frame.
        const seen = new Set();
        for (let i = 0; i < 10; i++) {
          seen.add(w);
          main.style.setProperty('--left-w', w + 'px');
          const next = Math.min(maxW, Math.max(minW, Math.floor(avail - panel.offsetHeight)));
          if (next === w || seen.has(next)) break;
          w = next;
        }
        main.style.setProperty('--left-w', w + 'px');   // make sure the final width is the applied one
        // On a short window the column can't get narrower than minW, so a square cover
        // plus the panel would be taller than the screen. So the cover gives up the height
        // instead: it is as tall as what's left under the panel (never taller than it is
        // wide), and the image crops to fill it.
        const MIN_ART = 96;
        const artH = Math.max(MIN_ART, Math.min(w, avail - panel.offsetHeight));
        main.style.setProperty('--art-h', artH + 'px');
      } finally { busy = false; }
    };
    fit();
    if (window.ResizeObserver) { const ro = new ResizeObserver(fit); ro.observe(panel); ro.observe(main); }
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    sideBySide.addEventListener('change', fit);
  },

  // Portrait only: collapse the header and the secondary player controls
  // (loop / gapless / shuffle / info / download / volume) while the user
  // scrolls down, so the list below gets the room and only the now-playing
  // card, progress bar and transport row stay pinned. Scrolling back up does NOT
  // bring them back: they only expand again once the list is back at the very
  // top. This only sets
  // body.np-compact; the CSS does the rest ("portrait phone: one-line header"
  // in style.css).
  //
  // Two things keep it from misfiring:
  //  • Collapsing the header makes #main taller, which lowers its maximum
  //    scrollTop. Near the end of a short list that would clamp the scroll
  //    position, which looks like the user scrolling up, which would flip the
  //    state straight back (flicker). So it only collapses when more than the
  //    header's height is left to scroll.
  //  • Only real gestures count (finger drag + its momentum, wheel, scroll
  //    keys). The app scrolls by itself too (switching tabs, lyrics following
  //    the song) and a plain tap on a tab must not toggle anything.
  _initPortraitCompact() {
    const main = document.getElementById('main');
    if (!main) return;
    const mq = window.matchMedia('(max-width: 1000px) and (orientation: portrait)');
    const ENTER = 40;     // px scrolled from the top before it may collapse
    const DOWN = 10;      // px of continuous downward scrolling that triggers it
    const TOP = 6;        // at (or within this of) the top everything is shown
    const MOMENTUM = 1200;   // ms after the last gesture that scrolling still counts as the user's
    let compact = false, last = main.scrollTop, run = 0, dragging = false, lastInput = 0;

    const set = (on) => {
      if (on === compact) return;
      compact = on;
      document.body.classList.toggle('np-compact', on);
      if (typeof UI !== 'undefined' && UI._lyrQuiet) UI._lyrQuiet(600);   // the resize can fire scroll events
    };
    const headerH = () => {
      for (const id of ['hdr-lobby', 'hdr-standalone']) {
        const h = document.getElementById(id);
        if (h && h.style.display !== 'none') return h.offsetHeight;
      }
      return 0;
    };
    const input = () => { lastInput = performance.now(); };
    // The lyrics follow the song by scrolling #main themselves (see UI._lyrCenter). That is
    // scrolling the user can see, so it has to be able to collapse the player like a finger
    // does: UI calls this right before it scrolls, which lets the scroll events that follow
    // (the smooth scroll lasts well under MOMENTUM ms) count as input. Everything else the
    // app scrolls on its own (switching tabs, back to the top) still doesn't.
    Main._compactAutoScroll = input;

    main.addEventListener('touchstart', () => { dragging = false; }, { passive: true });
    main.addEventListener('touchmove', () => { dragging = true; input(); }, { passive: true });
    const release = () => { if (dragging) input(); dragging = false; };
    main.addEventListener('touchend', release, { passive: true });
    main.addEventListener('touchcancel', release, { passive: true });
    main.addEventListener('wheel', input, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)
          && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) input();
    });

    main.addEventListener('scroll', () => {
      if (!mq.matches) return;
      const st = Math.max(0, main.scrollTop);        // iOS rubber-banding can go negative
      const d = st - last;
      last = st;
      if (st <= TOP) { run = 0; set(false); return; }
      if (!dragging && performance.now() - lastInput > MOMENTUM) { run = 0; return; }   // not the user's scroll
      if (!d) return;
      run = (d > 0) === (run > 0) ? run + d : d;     // signed length of the current one-direction run
      // Collapse while scrolling down. Expanding is handled only by the
      // `st <= TOP` check above (i.e. when the top is reached) — never by
      // scrolling up part-way.
      if (!compact && run >= DOWN && st > ENTER) {
        const room = main.scrollHeight - main.clientHeight - st;
        if (room > headerH() + 8) set(true);
      }
    }, { passive: true });

    // Rotating / leaving the portrait layout: back to the normal, full header.
    mq.addEventListener('change', () => { set(false); run = 0; last = main.scrollTop; });
  },
};

document.addEventListener('DOMContentLoaded', async () => {
  // Persistent storage (IndexedDB, see store.js) has to be loaded before
  // anything below reads a saved skin, binding, name or session.
  await Store.ready;
  // Before anything else paints: reapplies whatever skin was active last
  // session, so there's no flash of the stock theme on load.
  Skins.init();
  Viz.init();
  UI.setupProgressBar();
  Main._initStickyPlayer();
  Main._initFitPlayerHeight();
  Main._initPortraitCompact();

  /* ───────── App header (standalone) ───────── */
  document.getElementById('btn-disconnect-sa').addEventListener('click', () => Standalone.disconnect());

  /* ───────── App header (lobby) ───────── */
  document.getElementById('btn-copy-code').addEventListener('click', () => Lobby.copyCode());
  document.getElementById('btn-leave-lobby').addEventListener('click', () => Lobby.requestLeave());
  // The avatars squish to fit the one-line portrait header; re-fit whenever
  // the room they have changes (the pad badge appears, the screen rotates…).
  (() => {
    const strip = document.getElementById('participants-strip');
    if (strip && window.ResizeObserver) new ResizeObserver(() => Lobby._fitParticipants()).observe(strip);
    window.matchMedia('(max-width: 1000px) and (orientation: portrait)').addEventListener('change', () => Lobby._fitParticipants());
  })();

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

  // With the queue filter active, Shuffle / Download All / Clear only touch the filtered tracks.
  document.getElementById('btn-qshuf').addEventListener('click', () => {
    const idx = UI.queueFilterIndices();
    if (idx && !idx.length) { toast('No tracks match the search', 'warn'); return; }
    Engine.shuffleQueue(idx || undefined);
  });
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
  document.getElementById('btn-qdl').addEventListener('click', e => {
    const idx = UI.queueFilterIndices();
    if (idx && !idx.length) { toast('No tracks match the search', 'warn'); return; }
    // The currently playing track isn't in S.queue — put it first, without duplicating it if it's also queued.
    // (With a filter active only the filtered queue tracks are downloaded.)
    const all = !idx && S.current && S.current.encoded ? [S.current] : [];
    const seen = new Set(all.map(t => t.encoded));
    (idx ? idx.map(i => S.queue[i]) : (S.queue || [])).forEach(t => { if (t && t.encoded && !seen.has(t.encoded)) { seen.add(t.encoded); all.push(t); } });
    UI.openDownloadMenu(e.currentTarget, all);
  });
  document.getElementById('btn-qclr').addEventListener('click', () => {
    if (!S.queue.length) { toast('Queue is already empty', 'warn'); return; }
    const idx = UI.queueFilterIndices();
    if (idx && !idx.length) { toast('No tracks match the search', 'warn'); return; }
    Engine.clearQueue(idx || undefined);
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
    if (b.dataset.tab === 'downloads') Downloads.render();
    if (b.dataset.tab === 'library') Library.render();
    if (b.dataset.tab === 'skins') Skins.renderTab();
    if (b.dataset.tab === 'bindings') Bindings.renderTab();
    if (b.dataset.tab === 'about') About.render();
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
  UI.initLyricsTranslate();
  UI.initLyricsProvider();
  document.getElementById('lyr-provider').addEventListener('change', e => UI.setLyricsProvider(e.target.value));
  document.getElementById('lyr-tr-lang').addEventListener('change', e => UI.setLyricsTranslateLang(e.target.value));

  /* ───────── Download (now-playing) ───────── */
  document.getElementById('btn-dl').addEventListener('click', e => UI.openDownloadMenu(e.currentTarget, S.current));
  document.getElementById('public-refresh-btn').addEventListener('click', () => Lobby.refreshPublicList());
  document.getElementById('btn-link').addEventListener('click', () => UI.openTrackLink(S.current));
  document.getElementById('btn-lyr-refetch').addEventListener('click', () => UI.refetchLyrics());

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
  document.getElementById('cfg-share-code').addEventListener('click', () => Lobby.shareLink());
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
  document.getElementById('cfg-leave-lobby').addEventListener('click', () => Lobby.requestLeave());

  /* ───────── Config: join a lobby by code (works for private lobbies) ───────── */
  document.getElementById('join-code-btn').addEventListener('click', () => Lobby.joinByCode());
  document.getElementById('join-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') Lobby.joinByCode(); });
  document.getElementById('join-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  /* ───────── Config: user settings (display name / default lobby name) ───────── */
  document.getElementById('us-save').addEventListener('click', () => UI.saveUserSettings());

  /* ───────── Config: noobplayer server ───────── */
  document.querySelectorAll('input[name="cfg-srv"]').forEach(r => {
    r.addEventListener('change', () => {
      const show = (r.value === 'custom' && r.checked) ? 'block' : 'none';
      document.getElementById('cfg-srv-url').style.display = show;
      document.getElementById('cfg-srv-pw').style.display = show;
    });
  });
  document.getElementById('cfg-srv-switch').addEventListener('click', () => UI.switchNoobplayerServer());

  /* ───────── Bindings tab ───────── */
  document.getElementById('btn-bnd-reset-key').addEventListener('click', () => Bindings.resetKeys());
  document.getElementById('btn-bnd-reset-pad').addEventListener('click', () => Bindings.resetPad());

  // Keyboard shortcuts are remappable (see the Bindings tab) — Bindings
  // owns its own keydown/keyup listeners, so nothing to wire up here.
  Bindings.load();
  Bindings.init();
  VKeyboard.init();
  Pad.init();
  Downloads.init();
  Library.init();
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
    // Unfinished downloads live in this page's memory — closing would lose them.
    const dlBusy = typeof Downloads !== 'undefined' && Downloads.activeCount() > 0;
    if (dlBusy || (typeof Sessions !== 'undefined' && Sessions.shouldConfirmClose())) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
});