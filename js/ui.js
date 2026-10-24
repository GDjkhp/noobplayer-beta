'use strict';
/* ═══════════════════════════════════════════
   UI — all DOM rendering. Mode-agnostic except where it checks
   S.mode / S.lobby.isHost to lock host-only controls.
═══════════════════════════════════════════ */
const UI = {

  // Host OR an appointed DJ (see the Disc Jockey card) may drive the player
  // and the queue; everyone else in a lobby is locked out of those controls.
  // Lobby SETTINGS and DJ management stay host-only and check isHost directly.
  canControl() { return S.mode !== 'server' || S.lobby.isHost || S.lobby.isDj; },
  isLocked() { return S.mode === 'server' && !this.canControl(); },

  applyLockState() {
    const locked = this.isLocked();
    const ids = ['btn-prev','btn-b10','btn-play','btn-f10','btn-next','btn-stop'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = locked; });
    document.getElementById('prog-bar').classList.toggle('locked', locked);

    // These used to be disabled for the whole of server mode because the
    // lobby had no server-side notion of loop/shuffle/clear at all. It does
    // now (see Lobby.peek_next_track / advance_track in server.py), so they
    // follow the same host rule as every other playback control rather than
    // being switched off for everyone including the host.
    ['btn-shuf','loop-btn','gapless-btn','btn-qshuf','btn-qclr','btn-qsmart','btn-autoplay']
      .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = locked; });
    this.updateFairButton();   // also disabled outside lobby mode, so it owns its own state

    document.querySelectorAll('.add-btn.pnow').forEach(b => b.disabled = locked);
    document.getElementById('lock-badge').classList.toggle('show', locked);
  },

  // Loop and autoplay are mirrored from the server in lobby mode and owned
  // locally in standalone, so both buttons render off S.* either way and
  // whoever changed it doesn't matter to the rendering.
  updateLoopButton() {
    const btn = document.getElementById('loop-btn');
    if (!btn) return;
    const map = {
      none:  { icon: 'repeat',     label: 'OFF' },
      track: { icon: 'repeat_one', label: 'ONE' },
      queue: { icon: 'repeat',     label: 'ALL' },
    };
    const m = map[S.loopMode] || map.none;
    btn.innerHTML = `<span class="material-symbols-outlined">${m.icon}</span><span class="cb-lbl">${m.label}</span>`;
    btn.classList.toggle('on', S.loopMode !== 'none');
  },

  // Gapless mirrors S.gaplessEnabled in both modes now — lobby mode's
  // value comes from the server (see Engine._lobbySync), standalone's
  // is owned locally (see Engine.toggleGapless). Host-lock for lobby
  // mode is handled by applyLockState, same as loop-btn.
  updateGaplessButton() {
    const btn = document.getElementById('gapless-btn');
    if (!btn) return;
    btn.textContent = S.gaplessEnabled ? 'GAPLESS ON' : 'GAPLESS OFF';
    btn.classList.toggle('on', S.gaplessEnabled);
    btn.title = S.mode === 'server'
      ? 'Gapless playback (host-controlled, shared by the whole lobby)'
      : 'Gapless playback (standalone mode)';
  },

  // Fair Queue is an ON/OFF state mirrored from the lobby (see
  // Engine._lobbySync). It only means something with more than one
  // person, so it's disabled in standalone as well as for non-hosts.
  updateFairButton() {
    const btn = document.getElementById('btn-qfair');
    if (!btn) return;
    (btn.querySelector('.lbl') || btn).textContent = S.fairEnabled ? 'Fair: On' : 'Fair: Off';
    btn.classList.toggle('on', S.fairEnabled);
    btn.disabled = S.mode !== 'server' || this.isLocked();
    btn.title = S.mode === 'server'
      ? 'Fair Queue — keeps the queue alternating between whoever added each track, automatically (host-controlled, shared by the whole lobby)'
      : 'Fair Queue — only applies in a lobby (needs tracks from more than one person)';
  },

  updateQueueHeader() {
    const count = S.queue.length;
    const totalMs = S.queue.reduce((a, t) => a + (t.info?.length || 0), 0);
    const info = document.getElementById('q-info');
    if (info) {
      info.textContent = count === 0
        ? 'Queue empty'
        : `${count} track${count !== 1 ? 's' : ''} · ${fmt(totalMs)}`;
      if (count && this._qFilter) {
        const n = this._qMatches(this._qFilter).length;
        info.textContent = `${n} of ${info.textContent}`;
      }
    }

    const ap = document.getElementById('btn-autoplay');
    if (ap) {
      const pool = S.autoQueueCount || 0;
      const lbls = { enabled: 'Auto: On', partial: 'Auto: ½', disabled: 'Auto: Off' };
      (ap.querySelector('.lbl') || ap).textContent = S.recPending ? 'Auto …' : lbls[S.autoplay] || 'Auto';
      ap.classList.toggle('on', S.autoplay === 'enabled');
      ap.title = {
        enabled:  'Autoplay: keeps the queue going with recommendations when it runs dry',
        partial:  'Autoplay: collecting recommendations for Smart Shuffle, but not auto-queueing them',
        disabled: 'Autoplay: off',
      }[S.autoplay] + (pool ? ` · ${pool} in the pool` : '');
    }
  },

  // Opens the track's source page (info.uri) in a new window/tab.
  openTrackLink(track) {
    const uri = track && track.info && track.info.uri;
    if (!uri || !/^https?:\/\//i.test(uri)) { toast('No link available for this track', 'info', 1800); return; }
    window.open(uri, '_blank', 'noopener,noreferrer');
  },

  setBuffering(on) { document.getElementById('buf-ring').classList.toggle('show', on); },

  /* ───────── Player artwork ─────────
     • YouTube / YouTube Music tracks use the biggest thumbnail that exists:
       maxresdefault → sddefault → hqdefault → mqdefault → default (then the
       track's own artworkUrl). Library / Search / Queue keep info.artworkUrl.
     • Changing track animates the artwork: next → new art slides in from the
       right, previous → current art slides off to the right revealing the
       previous track, override play → new art rises from the bottom. */
  _artKey: null,       // track whose artwork is shown / loading
  _artTok: 0,          // bumps to cancel an in-flight artwork load
  _artDirHint: null,   // { dir, at } set by Engine just before it changes track
  _artGhost: null,
  _artAnims: [],

  artHint(dir) { this._artDirHint = { dir, at: Date.now() }; },

  _takeArtDir() {
    const h = this._artDirHint;
    this._artDirHint = null;
    return h && Date.now() - h.at < 15000 ? h.dir : 'next';   // natural advance = 'next'
  },

  _artUrls(t) {
    const info = t.info || {};
    const out = [];
    const src = trackSrc(t);
    if ((src === 'youtube' || src === 'youtubemusic') && info.identifier && /^[\w-]{6,}$/.test(info.identifier)) {
      for (const q of ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', 'default'])
        out.push(`https://i.ytimg.com/vi/${info.identifier}/${q}.jpg`);
    }
    if (info.artworkUrl && !out.includes(info.artworkUrl)) out.push(info.artworkUrl);
    return out;
  },

  // Resolves with the first URL that really loads (YouTube answers 404 — or a
  // 120px grey placeholder — for sizes a video doesn't have), else null.
  _artProbe(urls) {
    return new Promise(resolve => {
      let k = 0;
      const next = () => {
        if (k >= urls.length) { resolve(null); return; }
        const u = urls[k++];
        const im = new Image();
        // default.jpg is legitimately 120px wide; every bigger size at 120px is YouTube's placeholder.
        im.onload = () => { if (im.naturalWidth <= 120 && /i\.ytimg\.com\/vi\/[^/]+\/(?!default\.jpg)/.test(u)) next(); else resolve(u); };
        im.onerror = next;
        im.src = u;
      };
      next();
    });
  },

  _artClean(img) {
    this._artAnims.forEach(a => { try { a.cancel(); } catch (_) {} });
    this._artAnims = [];
    if (this._artGhost) { this._artGhost.remove(); this._artGhost = null; }
    if (img) img.style.transition = '';
  },

  _updateArt(t, img, empty) {
    const key = t.encoded || (t.info && (t.info.identifier || t.info.uri)) || '';
    if (key && key === this._artKey) return;       // same track: nothing to redo
    this._artKey = key;
    const tok = ++this._artTok;
    const dir = this._takeArtDir();
    const urls = this._artUrls(t);
    if (!urls.length) {
      this._artClean(img); img.classList.remove('vis'); empty.style.display = 'flex';
      return;
    }
    this._artProbe(urls).then(url => {
      if (tok !== this._artTok) return;            // a newer track took over
      if (!url) { this._artClean(img); img.classList.remove('vis'); empty.style.display = 'flex'; return; }
      this._artShow(img, empty, url, dir);
    });
  },

  _artShow(img, empty, url, dir) {
    const had = img.classList.contains('vis') && !!img.getAttribute('src');
    this._artClean(img);
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnim = !reduce && typeof img.animate === 'function' &&
      (dir === 'prev' ? had : (had || dir === 'up'));
    let ghost = null;
    if (canAnim && had) {
      ghost = img.cloneNode(false);
      ghost.removeAttribute('id');
      ghost.className = 'art-ghost';
      // prev: the old art sits ABOVE and slides away; otherwise it stays beneath.
      img.insertAdjacentElement(dir === 'prev' ? 'afterend' : 'beforebegin', ghost);
      this._artGhost = ghost;
    }
    empty.style.display = 'none';
    if (canAnim) img.style.transition = 'none';
    img.src = url;
    img.classList.add('vis');
    if (!canAnim) return;

    const opts = { duration: 480, easing: 'cubic-bezier(.22,.8,.3,1)', fill: 'both' };
    const anim = dir === 'prev'
      ? ghost.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], opts)
      : img.animate([{ transform: dir === 'up' ? 'translateY(100%)' : 'translateX(100%)' }, { transform: 'none' }], opts);
    this._artAnims = [anim];
    anim.onfinish = () => {
      if (this._artAnims[0] !== anim) return;
      this._artClean(img);
    };
  },

  updatePlayerUI() {
    const t = S.current;
    const img = document.getElementById('art-img');
    const empty = document.getElementById('art-empty');
    document.getElementById('btn-dl').disabled = !t;
    document.getElementById('btn-link').disabled = !(t && t.info.uri);

    if (t) {
      this._updateArt(t, img, empty);

      const srcMap = { youtube:'YOUTUBE', youtubemusic:'YT MUSIC', soundcloud:'SOUNDCLOUD',
        spotify:'SPOTIFY', deezer:'DEEZER', bandcamp:'BANDCAMP', applemusic:'APPLE MUSIC', yandexmusic:'YANDEX' };
      const src = (t.info.sourceName || '').toLowerCase();
      document.getElementById('info-src-txt').textContent = srcMap[src] || src.toUpperCase() || '— PLAYING —';
      document.getElementById('info-title').textContent = t.info.title;
      document.getElementById('info-title').style.color = 'var(--text)';
      document.getElementById('info-artist').textContent = t.info.author;
      document.getElementById('t-tot').textContent = fmt(t.info.length);
      // Lyrics used to need a manual "Fetch Lyrics" click — now they load
      // automatically whenever the current track changes. fetchLyrics()
      // itself no-ops if it's already fetched (or is fetching) for this
      // exact track, so calling it on every updatePlayerUI() re-render is
      // cheap and safe.
      this.fetchLyrics();
    } else {
      this._artKey = null; this._artTok++; this._artClean(img);
      img.classList.remove('vis'); empty.style.display = 'flex';
      document.getElementById('info-src-txt').textContent = '— IDLE —';
      document.getElementById('info-title').textContent = 'Nothing playing';
      document.getElementById('info-title').style.color = 'var(--muted)';
      document.getElementById('info-artist').textContent = '—';
      document.getElementById('t-cur').textContent = '0:00';
      document.getElementById('t-tot').textContent = '0:00';
      document.getElementById('prog-fill').style.width = '0%';
      document.getElementById('prog-thumb').style.left = '0%';
      document.getElementById('pcm-meter').classList.remove('active');
      document.getElementById('lyr-body').innerHTML =
        `<div class="empty"><span class="material-symbols-outlined">lyrics</span><p>Play a track and fetch lyrics</p></div>`;
      document.getElementById('lyr-src-lbl').textContent = 'No lyrics loaded';
      this._lyrBadge();
      this._lyrBusy(false);
    }
    this.updatePlayPauseIcons(); this.updateEQ(); this.applyLockState();
  },

  updateProgress() {
    // While the user is actively dragging the thumb, S.progDrag is true and
    // setupProgressBar() below is already writing the dragged position on
    // every mousemove. This timer-driven tick used to run regardless and
    // stomp that with the real (stale, pre-seek) playback position 10x a
    // second, which is what caused the bar to flicker back and forth.
    if (!S.current || !S.player || S.progDrag) return;
    const posMs = S.player.getPositionMs();
    const durMs = S.current.info.length;
    if (!durMs) return;
    const pct = Math.min((posMs / durMs) * 100, 100);
    document.getElementById('prog-fill').style.width = pct + '%';
    document.getElementById('prog-thumb').style.left = pct + '%';
    document.getElementById('t-cur').textContent = fmt(posMs);
  },

  updatePlayPauseIcons() {
    const playing = S.current && S.player && !S.player.isPaused;
    document.getElementById('ico-play').style.display = playing ? 'none' : 'block';
    document.getElementById('ico-pause').style.display = playing ? 'block' : 'none';
    this.updateMediaSession();
  },

  // Media Session API — drives the OS/browser "now playing" integration
  // (lock screen, hardware media keys, the tab-level flyout Chrome shows —
  // see main.js for the action handlers that make its buttons actually do
  // something). Called on every track change and every play/pause toggle;
  // cheap enough not to worry about over-calling it.
  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = S.current;
    MediaKeepAlive.sync(!!t, !!(t && S.player && !S.player.isPaused));   // mirror play/pause onto the silent element (see utils.js)
    if (!t) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    const artwork = t.info.artworkUrl
      ? [96, 192, 256, 384, 512].map(size => ({ src: t.info.artworkUrl, sizes: `${size}x${size}`, type: 'image/png' }))
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.info.title || 'Unknown title',
      artist: t.info.author || 'Unknown artist',
      album: 'Noobplayer',
      artwork,
    });
    navigator.mediaSession.playbackState = (S.player && !S.player.isPaused) ? 'playing' : 'paused';
    if (S.player && t.info.length) {
      try {
        navigator.mediaSession.setPositionState({
          duration: t.info.length / 1000,
          playbackRate: 1,
          position: Math.min(S.player.getPositionMs(), t.info.length) / 1000,
        });
      } catch (_) { /* duration/position can briefly be inconsistent right at a track boundary */ }
    }
  },

  // Small fixed-position format picker spawned next to whichever download
  // button was clicked — the now-playing one in #ctrls-sec, or a queue
  // item's. One instance at a time; opening a new one (or clicking
  // anywhere outside, or Escape) closes whatever's already open.
  openDownloadMenu(anchorEl, trackOrTracks) {
    this.closeDownloadMenu();
    const tracks = (Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks]).filter(t => t && t.encoded);
    if (!tracks.length) { toast('Nothing to download', 'warn'); return; }
    if (!DownloadAPI.available()) { toast('Downloads need a server connection', 'warn'); return; }

    const menu = document.createElement('div');
    menu.className = 'dl-menu';
    menu.innerHTML = `
      ${tracks.length > 1 ? `<div class="dl-menu-t">Download ${tracks.length} tracks</div>` : ''}
      <button class="dl-opt" data-fmt="opus"><span>Opus</span><small>.ogg</small></button>
      <button class="dl-opt" data-fmt="mp3"><span>MP3</span><small>.mp3</small></button>
      <button class="dl-opt" data-fmt="wav"><span>WAV</span><small>.wav</small></button>
    `;
    document.body.appendChild(menu);

    const r = anchorEl.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
    let top = r.bottom + 6;
    if (top + menu.offsetHeight > window.innerHeight) top = r.top - menu.offsetHeight - 6;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    menu.querySelectorAll('.dl-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        Downloads.add(tracks, btn.dataset.fmt);
        this.closeDownloadMenu();
      });
    });

    this._dlMenu = menu;
    // Deferred a tick so the same click that opened the menu doesn't also
    // immediately fire this outside-click listener and close it.
    setTimeout(() => {
      document.addEventListener('click', this._dlMenuOutside = (e) => {
        if (!menu.contains(e.target)) this.closeDownloadMenu();
      });
      document.addEventListener('keydown', this._dlMenuEsc = (e) => {
        if (e.key === 'Escape') this.closeDownloadMenu();
      });
    }, 0);
  },

  closeDownloadMenu() {
    if (this._dlMenu) { this._dlMenu.remove(); this._dlMenu = null; }
    if (this._dlMenuOutside) { document.removeEventListener('click', this._dlMenuOutside); this._dlMenuOutside = null; }
    if (this._dlMenuEsc) { document.removeEventListener('keydown', this._dlMenuEsc); this._dlMenuEsc = null; }
  },

  updateEQ() {
    const playing = S.current && S.player && !S.player.isPaused;
    document.getElementById('eq').classList.toggle('active', playing);
    document.getElementById('eq').querySelectorAll('.eb').forEach(b => b.classList.toggle('paused', !playing));
  },

  updateLevelMeter() {
    if (!S.player || S.player.isPaused) {
      document.getElementById('pm-l').style.height = '0%';
      document.getElementById('pm-r').style.height = '0%';
      document.getElementById('pcm-meter').classList.remove('active');
      return;
    }
    document.getElementById('pcm-meter').classList.add('active');
    const [l, r] = S.player.getLevels();
    document.getElementById('pm-l').style.height = (Math.min(l, 1) * 100) + '%';
    document.getElementById('pm-r').style.height = (Math.min(r, 1) * 100) + '%';
  },

  startPosTimer() {
    if (S.posTimer) clearInterval(S.posTimer);
    S.posTimer = setInterval(() => {
      if (!S.current || !S.player) return;
      UI.updateProgress(); UI.syncLyrics(); UI.updateLevelMeter();
    }, 100);
  },

  /* ───────── Queue list ─────────
     Windowed + keyed. Only the first _qLimit rows exist in the DOM (100 to
     start, +100 each time the user scrolls to the end of what's rendered —
     tracked against the BROWSER VIEWPORT with an IntersectionObserver on the
     footer, see _qWatch), and every
     renderQueue() call RECONCILES that window instead of rebuilding it:
     rows are matched by a key (track + requester + nth occurrence), existing
     rows are kept as-is (so their album art never reloads), only genuinely
     new rows are built, vanished ones are removed, and moved ones are
     repositioned with the fewest DOM moves (longest-increasing-subsequence).
     Per-row state that depends on position (number, up/down enabled, lock
     state) is patched in place, and only when it actually changed. Clicks and
     drag-and-drop are delegated from #ql, wired once. */
  _QCHUNK: 100,
  _qLimit: 100,
  _qRows: null,        // key -> row element (only rows currently in the DOM)
  _qFilter: '',        // lowercase queue filter ('' = off)
  _qVisCount: 0,       // rows that pass the filter (== queue length when off)
  _qDragFrom: null,
  _qDragOver: null,
  _qMargin: 200,       // px before the footer actually enters the viewport that we start loading
  _qIO: null,          // IntersectionObserver watching the footer vs. the viewport
  _qSentinel: null,    // the footer element currently being watched

  renderQueue() {
    const count = S.queue.length;
    document.getElementById('q-badge').textContent = count > 0 ? `(${count})` : '';
    this.updateQueueHeader();
    this.updateLoopButton();

    const el = document.getElementById('ql');
    if (!this._qRows) { this._qRows = new Map(); this._wireQueueEvents(el); }

    // Filter: `vis` maps a visible position to its REAL queue index (null = no
    // filter, identity). Rows always carry the real index, so play / move /
    // remove / drag keep acting on the right track while the list is filtered.
    const q = this._qFilter;
    const vis = q ? this._qMatches(q) : null;
    const visCount = vis ? vis.length : count;
    this._qVisCount = visCount;

    if (visCount === 0) {
      this._qRows.clear();
      if (this._qIO) this._qIO.disconnect();
      this._qSentinel = null;
      if (count === 0) this._qLimit = this._QCHUNK;
      el.innerHTML = count === 0
        ? `<div class="empty"><span class="material-symbols-outlined">queue_music</span><p>Queue is empty</p></div>`
        : `<div class="empty"><p>No matches</p></div>`;
      this.applyLockState();
      return;
    }
    const emptyEl = el.querySelector(':scope > .empty');
    if (emptyEl) emptyEl.remove();

    const locked = this.isLocked();
    const me = LobbyAPI.userId();
    const shown = Math.min(visCount, this._qLimit);
    const at = j => vis ? vis[j] : j;

    // Keys for the visible window. "nth occurrence" keeps duplicate tracks distinct.
    const seen = new Map();
    const keys = new Array(shown);
    for (let j = 0; j < shown; j++) {
      const t = S.queue[at(j)];
      const base = (t.encoded || t.info?.identifier || '') + '|' + (t.requester?.id || '');
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      keys[j] = base + '#' + n;
    }

    // Drop rows that left the window / queue.
    const want = new Set(keys);
    for (const [k, row] of this._qRows) {
      if (!want.has(k)) { row.remove(); this._qRows.delete(k); }
    }

    // Where each surviving row currently sits in the DOM.
    const order = new Map();
    let p = 0;
    for (const c of el.children) if (c.classList.contains('qi')) order.set(c, p++);
    const seq = keys.map(k => { const r = this._qRows.get(k); return r ? order.get(r) : -1; });
    const stay = this._qLis(seq);   // rows in this set are already in the right relative order

    // "Load more" footer, always last.
    let more = el.querySelector(':scope > .q-more');
    if (shown < visCount) {
      if (!more) { more = document.createElement('div'); more.className = 'q-more'; }
      more.textContent = `Showing ${shown} of ${visCount} — scroll for more`;
      if (more.parentNode !== el || more !== el.lastElementChild) el.appendChild(more);
    } else if (more) {
      more.remove(); more = null;   // null it: it must not be used as the insert anchor below
      if (this._qIO) this._qIO.disconnect();
      this._qSentinel = null;
    }

    let anchor = more || null;
    for (let j = shown - 1; j >= 0; j--) {
      const i = at(j);
      const t = S.queue[i];
      let row = this._qRows.get(keys[j]);
      if (!row) {
        row = this._qBuildRow(t);
        this._qRows.set(keys[j], row);
        el.insertBefore(row, anchor);
      } else if (!stay.has(j)) {
        el.insertBefore(row, anchor);
      }
      this._qSyncRow(row, i, t, count, locked, me);
      anchor = row;
    }

    this.applyLockState();
    this.preloadNextLyrics();   // queue head may have changed

    // Make sure the footer is being tracked against the viewport.
    if (more && more.parentNode === el) this._qWatch(more);
  },

  // Real queue indices whose title / author contain q (q is lowercase).
  _qMatches(q) {
    const out = [];
    for (let i = 0; i < S.queue.length; i++) {
      const t = S.queue[i], info = t.info || {};
      const ti = String(info.title || '').toLowerCase();
      const au = String(info.author || '').toLowerCase();
      if (ti.includes(q) || au.includes(q) || (ti + ' ' + au).includes(q)) out.push(i);
    }
    return out;
  },

  // Real queue indices the filter currently matches, or null when no filter is
  // active — the queue toolbar's Shuffle / Download All / Clear use this.
  queueFilterIndices() {
    return this._qFilter ? this._qMatches(this._qFilter) : null;
  },

  // Called from the queue filter box: back to the first 100 matches.
  setQueueFilter(raw) {
    this._qFilter = String(raw || '').trim().toLowerCase();
    this._qLimit = this._QCHUNK;
    this.renderQueue();
    const el = document.getElementById('ql');
    if (el) el.scrollTop = 0;
  },

  // Back to the first 100 rows (called on a tab switch).
  resetQueueWindow() {
    this._qLimit = this._QCHUNK;
    this.renderQueue();
    const el = document.getElementById('ql');
    if (el) el.scrollTop = 0;
  },

  _qLoadMore() {
    if (this._qLimit >= this._qVisCount) return;
    this._qLimit += this._QCHUNK;
    this.renderQueue();
    // Re-arm: the new footer sits 100 rows further down. If it is STILL inside
    // the viewport (very tall screen), observing it again reports it straight
    // away and loads the next 100; otherwise it waits for the next scroll.
    const s = this._qSentinel;
    if (this._qIO && s && s.isConnected) { this._qIO.unobserve(s); this._qIO.observe(s); }
    else requestAnimationFrame(() => this._qCheck());
  },

  // Tracks the "Showing N of M" footer against the browser viewport. The page
  // (not #ql) is what scrolls in the sticky layouts, and an IntersectionObserver
  // with root:null reports correctly either way — page scroll, #ql's own
  // scroll, resize, or the Queue tab being shown/hidden.
  _qWatch(more) {
    if (this._qSentinel === more) return;
    this._qSentinel = more;
    if (!('IntersectionObserver' in window)) return;   // _qCheck + scroll listeners cover this
    if (!this._qIO) {
      this._qIO = new IntersectionObserver(entries => {
        if (entries.some(en => en.isIntersecting)) this._qLoadMore();
      }, { root: null, rootMargin: `0px 0px ${this._qMargin}px 0px` });
    }
    this._qIO.disconnect();
    this._qIO.observe(more);
  },

  // Manual version of the same test (only used where IntersectionObserver is missing).
  _qCheck() {
    const m = this._qSentinel;
    if (!m || !m.isConnected || this._qLimit >= this._qVisCount) return;
    const r = m.getBoundingClientRect();
    if (r.height > 0 && r.top <= window.innerHeight + this._qMargin) this._qLoadMore();
  },

  // Indices (into seq) of a longest increasing subsequence, ignoring -1 (new rows).
  _qLis(seq) {
    const tails = [], prev = new Array(seq.length).fill(-1), out = new Set();
    for (let i = 0; i < seq.length; i++) {
      const v = seq[i];
      if (v < 0) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < v) lo = m + 1; else hi = m; }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.add(k);
    return out;
  },

  // Builds the row for a track ONCE. Nothing in here depends on position or
  // lock state — _qSyncRow fills those in.
  _qBuildRow(t) {
    const art = t.info.artworkUrl
      ? `<img class="qi-th" src="${esc(t.info.artworkUrl)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
      : `<div class="qi-nth"><span class="material-symbols-outlined">music_note</span></div>`;
    const thumb = `<span class="th-w">${art}${srcBadge(trackSrc(t))}</span>`;
    const req = t.requester || null;
    const auto = req && req.id === '__auto__';
    const chip = req
      ? `<span class="qi-req ${auto ? 'auto' : ''}" title="Added by ${esc(req.name)}">${auto ? '<span class="material-symbols-outlined chip-ico">auto_awesome</span>auto' : esc(req.name)}</span>`
      : '';
    const tpl = document.createElement('div');
    tpl.innerHTML = `<div class="qi">
        <span class="qi-drag material-symbols-outlined" title="Drag to reorder">drag_indicator</span>
        <span class="qi-n"></span>${thumb}
        <div class="qi-m">
          <div class="qi-t">${esc(t.info.title)}</div>
          <div class="qi-a"><span class="qi-au">${esc(t.info.author)}</span>${chip}</div>
        </div>
        <div class="qi-bs">
          <button class="qib" data-qa="play" title="Play now"><span class="material-symbols-outlined">play_arrow</span></button>
          <button class="qib" data-qa="top" title="Move to top"><span class="material-symbols-outlined">keyboard_double_arrow_up</span></button>
          <button class="qib" data-qa="up" title="Move up"><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
          <button class="qib" data-qa="dn" title="Move down"><span class="material-symbols-outlined">keyboard_arrow_down</span></button>
          <button class="qib" data-qa="bot" title="Move to bottom"><span class="material-symbols-outlined">keyboard_double_arrow_down</span></button>
          <button class="qib" data-qa="link" title="Open track link" ${t.info.uri ? '' : 'disabled'}><span class="material-symbols-outlined">open_in_new</span></button>
          <button class="qib" data-qa="save" title="Save to library"><span class="material-symbols-outlined">bookmark_add</span></button>
          <button class="qib dl" data-qa="dl" title="Download"><span class="material-symbols-outlined">download</span></button>
          <button class="qib del" data-qa="rm"><span class="material-symbols-outlined">close</span></button>
        </div>
        <span class="qi-d">${fmt(t.info.length)}</span>
      </div>`;
    const row = tpl.firstElementChild;
    row._nEl = row.querySelector('.qi-n');
    row._btn = {};
    row.querySelectorAll('.qib').forEach(b => { row._btn[b.dataset.qa] = b; });
    row._chip = row.querySelector('.qi-req');
    row._tEl = row.querySelector('.qi-t');
    row._auEl = row.querySelector('.qi-au');
    row._hq = '';     // filter the title/author <mark>s were last drawn for
    row._sig = null;
    return row;
  },

  // Patches only what depends on position / lock state, and only if it changed.
  _qSyncRow(row, i, t, count, locked, me) {
    row._i = i;
    // <mark> the filter hits in title/author (only redrawn when the filter changed).
    const q = this._qFilter;
    if (row._hq !== q) {
      row._hq = q;
      row._tEl.innerHTML = hl(t.info.title, q);
      row._auEl.innerHTML = hl(t.info.author, q);
    }
    const last = i === count - 1;
    const sig = `${i}|${last ? 1 : 0}|${locked ? 1 : 0}|${me || ''}`;
    if (row._sig === sig) return;
    row._sig = sig;

    row.dataset.qi = i;
    row._nEl.textContent = i + 1;
    row.draggable = !locked;
    row.setAttribute('draggable', locked ? 'false' : 'true');

    const b = row._btn;
    b.play.disabled = locked;
    b.up.disabled = locked || i === 0;
    b.top.disabled = locked || i === 0;
    b.dn.disabled = locked || last;
    b.bot.disabled = locked || last;

    // Anyone can pull a track they added themselves; only the host can pull
    // someone else's — same rule the server enforces on /queue/remove.
    const req = t.requester || null;
    const mine = !!(req && me && req.id === me);
    const canRemove = !locked || mine;
    b.rm.disabled = !canRemove;
    b.rm.title = canRemove ? 'Remove' : 'Only the host can remove other people\u2019s tracks';
    if (row._chip) row._chip.classList.toggle('mine', mine);
  },

  // One set of delegated listeners for the whole list (wired once).
  _wireQueueEvents(el) {
    const qf = document.getElementById('q-filter');
    if (qf) qf.addEventListener('input', e => this.setQueueFilter(e.target.value));
    el.addEventListener('click', e => {
      const more = e.target.closest('.q-more');
      if (more) { this._qLoadMore(); return; }
      const btn = e.target.closest('.qib');
      if (!btn || btn.disabled) return;
      const row = btn.closest('.qi');
      if (!row) return;
      e.stopPropagation();
      const i = row._i;
      const a = btn.dataset.qa;
      if (a === 'play') {
        // Lobby mode: jumping the queue means telling the server to drop
        // that track from the shared queue and play it. Don't splice
        // locally first — the next state broadcast would overwrite it
        // anyway, and a mismatched index would remove the wrong track.
        if (S.mode === 'server') {
          const tr = S.queue[i];
          Engine.removeFromQueue(i).then(() => Engine.playTrack(tr));
          return;
        }
        if (S.current) S.history.push(S.current);
        const [tr] = S.queue.splice(i, 1);
        Engine.playTrack(tr);
      } else if (a === 'up' && i > 0) { Engine.moveQueueItem(i, i - 1); }
      else if (a === 'dn' && i < S.queue.length - 1) { Engine.moveQueueItem(i, i + 1); }
      else if (a === 'top' && i > 0) { Engine.moveQueueItem(i, 0); }
      else if (a === 'bot' && i < S.queue.length - 1) { Engine.moveQueueItem(i, S.queue.length - 1); }
      else if (a === 'rm') Engine.removeFromQueue(i);
      else if (a === 'save') Library.addTrack(S.queue[i]);
      else if (a === 'dl') UI.openDownloadMenu(btn, S.queue[i]);
      else if (a === 'link') UI.openTrackLink(S.queue[i]);
    });

    // Progressive loading: next 100 when the user reaches the end of the
    // rendered rows. Normally handled by the IntersectionObserver (_qWatch);
    // this is only the fallback for browsers without one.
    if (!('IntersectionObserver' in window)) {
      let raf = 0;
      const check = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this._qCheck(); }); };
      window.addEventListener('scroll', check, { passive: true });
      window.addEventListener('resize', check, { passive: true });
      el.addEventListener('scroll', check, { passive: true });
    }

    // HTML5 drag-and-drop reordering — dragging a row onto another row's
    // slot moves it there (Engine.moveQueueItem), which also covers
    // "swapping" two tracks: drag A onto B and A lands where B was.
    const clearOver = () => { if (this._qDragOver) { this._qDragOver.classList.remove('drag-over'); this._qDragOver = null; } };
    el.addEventListener('dragstart', e => {
      const row = e.target.closest && e.target.closest('.qi');
      if (!row || this.isLocked()) return;
      this._qDragFrom = row._i;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(row._i)); } catch (_) {}
    });
    el.addEventListener('dragend', e => {
      const row = e.target.closest && e.target.closest('.qi');
      if (row) row.classList.remove('dragging');
      clearOver();
      this._qDragFrom = null;
    });
    el.addEventListener('dragover', e => {
      if (this._qDragFrom === null) return;
      const row = e.target.closest && e.target.closest('.qi');
      if (!row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (this._qDragOver !== row) { clearOver(); row.classList.add('drag-over'); this._qDragOver = row; }
    });
    el.addEventListener('drop', e => {
      const row = e.target.closest && e.target.closest('.qi');
      clearOver();
      if (!row || this._qDragFrom === null) return;
      e.preventDefault();
      const from = this._qDragFrom, to = row._i;
      this._qDragFrom = null;
      if (from === to || to === undefined) return;
      Engine.moveQueueItem(from, to);
    });
  },

  /* ───────── Search results: progressive loading ─────────
     Same idea as the queue: 100 rows to start, +100 whenever the user scrolls
     to the end of what's rendered. Rows are only ever APPENDED (results don't
     reorder), so there's no reconcile step — just build the next slice. */
  _SCHUNK: 100,
  _sLimit: 100,
  _sShown: 0,          // rows currently in the DOM
  _sIO: null,          // IntersectionObserver watching the footer vs. the viewport
  _sFoot: null,        // the footer element currently being watched
  _sWired: false,

  _sRowHtml(t, i, locked) {
    const art = t.info.artworkUrl
      ? `<img class="si-th" src="${esc(t.info.artworkUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="si-nth"><span class="material-symbols-outlined">music_note</span></div>`;
    const thumb = `<span class="th-w">${art}${srcBadge(trackSrc(t))}</span>`;
    return `<div class="si" data-i="${i}">${thumb}
          <div class="si-meta">
            <div class="si-t">${esc(t.info.title)}</div>
            <div class="si-a">${esc(t.info.author)}</div>
          </div>
          <div class="si-acts">
            <button class="add-btn pnow" data-a="play" data-i="${i}" title="Play" ${locked?'disabled':''}><span class="material-symbols-outlined">play_arrow</span><span class="lbl">Play</span></button>
            <button class="add-btn" data-a="q" data-i="${i}" title="Add to queue"><span class="material-symbols-outlined m-ico">playlist_add</span><span class="lbl">Queue</span></button>
            <button class="add-btn" data-a="link" data-i="${i}" title="Open track link" ${t.info.uri ? '' : 'disabled'}><span class="material-symbols-outlined">open_in_new</span><span class="lbl">Link</span></button>
            <button class="add-btn" data-a="save" data-i="${i}" title="Save to library"><span class="material-symbols-outlined">bookmark_add</span><span class="lbl">Save</span></button>
            <button class="add-btn" data-a="dl" data-i="${i}" title="Download this track"><span class="material-symbols-outlined">download</span><span class="lbl">Download</span></button>
          </div>
          <span class="si-d">${fmt(t.info.length)}</span>
        </div>`;
  },

  // Appends rows [_sShown, min(_sLimit, total)) and keeps the footer last.
  _sRender(res) {
    const all = S.searchResults;
    const total = all.length;
    const upto = Math.min(total, this._sLimit);
    const old = res.querySelector(':scope > .s-more');
    if (old) old.remove();

    if (upto > this._sShown) {
      const locked = this.isLocked();
      let html = '';
      for (let i = this._sShown; i < upto; i++) html += this._sRowHtml(all[i], i, locked);
      res.insertAdjacentHTML('beforeend', html);
      this._sShown = upto;
    }

    if (this._sShown < total) {
      const more = document.createElement('div');
      more.className = 'q-more s-more';
      more.textContent = `Showing ${this._sShown} of ${total} — scroll for more`;
      res.appendChild(more);
      this._sWatch(more);
    } else {
      if (this._sIO) this._sIO.disconnect();
      this._sFoot = null;
    }
  },

  _sLoadMore() {
    const res = document.getElementById('sres');
    if (!res || this._sShown >= S.searchResults.length) return;
    this._sLimit += this._SCHUNK;
    this._sRender(res);
    // The new footer is observed fresh, so if it's STILL in view (very tall
    // screen) it reports straight away and loads the next 100.
  },

  // Footer vs. the browser viewport: works whether #sres or the page is what
  // scrolls, and when the Search tab is shown/hidden.
  _sWatch(more) {
    this._sFoot = more;
    if (!('IntersectionObserver' in window)) return;   // scroll listeners in _sWire cover this
    if (!this._sIO) {
      this._sIO = new IntersectionObserver(entries => {
        if (entries.some(en => en.isIntersecting)) this._sLoadMore();
      }, { root: null, rootMargin: `0px 0px ${this._qMargin}px 0px` });
    }
    this._sIO.disconnect();
    this._sIO.observe(more);
  },

  _sCheck() {
    const m = this._sFoot;
    if (!m || !m.isConnected || this._sShown >= S.searchResults.length) return;
    const r = m.getBoundingClientRect();
    if (r.height > 0 && r.top <= window.innerHeight + this._qMargin) this._sLoadMore();
  },

  // Delegated listeners on #sres, wired once (rows come and go).
  _sWire(res) {
    if (this._sWired) return;
    this._sWired = true;
    res.addEventListener('click', e => {
      if (e.target.closest('.s-more')) { this._sLoadMore(); return; }
      const btn = e.target.closest('.add-btn[data-a]');
      if (!btn || !res.contains(btn) || btn.disabled) return;
      e.stopPropagation();
      const t = S.searchResults[parseInt(btn.dataset.i)];
      if (!t) return;
      if (btn.dataset.a === 'dl') { UI.openDownloadMenu(btn, t); return; }
      if (btn.dataset.a === 'link') { UI.openTrackLink(t); return; }
      if (btn.dataset.a === 'save') { Library.addTrack(t); return; }
      // Something is already loaded (playing OR paused): Play on a search
      // result queues it instead of replacing the current track.
      if (btn.dataset.a === 'play' && S.current) {
        Engine.addToQueue(t, { silent: true }).then(ok => {
          if (ok) toast(`Queued from search: ${t.info.title}`, 'success', 2500);
        });
      } else if (btn.dataset.a === 'play') {
        if (S.mode === 'standalone') { S.queue = []; if (S.current) S.history.push(S.current); }
        Engine.playTrack(t);
      } else {
        Engine.addToQueue(t);
      }
    });
    if (!('IntersectionObserver' in window)) {
      let raf = 0;
      const check = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this._sCheck(); }); };
      window.addEventListener('scroll', check, { passive: true });
      window.addEventListener('resize', check, { passive: true });
      res.addEventListener('scroll', check, { passive: true });
    }
  },

  async doSearch() {
    const raw = document.getElementById('si').value.trim();
    if (!raw) { toast('Enter a search term or URL', 'warn'); return; }

    const src = document.getElementById('src-sel').value;
    const isUrl = raw.startsWith('http://') || raw.startsWith('https://');
    const id = (isUrl || !src) ? raw : src + raw;

    // Several links separated by whitespace/commas: resolve every one and merge
    // (songs, albums and playlists can be mixed). Anything else is a normal query.
    const parts = raw.split(/[\s,]+/).filter(Boolean);
    const links = [...new Set(parts)];
    const multi = parts.length > 1 && parts.every(p => /^https?:\/\/\S+$/i.test(p));

    const res = document.getElementById('sres');
    res.innerHTML = `<div class="empty"><div class="dots"><span></span><span></span><span></span></div><p>${multi ? `Loading ${links.length} links…` : 'Searching…'}</p></div>`;

    try {
      let data, tracks = [], banner = '';
      const bannerCss = 'padding:8px 12px;font-family:var(--fm);font-size:10px;color:var(--muted);border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:10px';
      const actions = `
          <button class="add-btn" id="btn-add-all" style="opacity:1;margin-left:auto"><span class="material-symbols-outlined m-ico">playlist_add</span>Add All</button><button class="add-btn" id="btn-shuf-all" style="opacity:1" title="Shuffle these tracks, then add them to the queue"><span class="material-symbols-outlined m-ico">shuffle</span>Shuffle Add</button>
          <button class="add-btn" id="btn-dl-all" style="opacity:1" title="Download every track listed"><span class="material-symbols-outlined">download</span>Download All</button>`;

      if (multi) {
        const settled = await Promise.allSettled(links.map(l => Backend.loadtracks(l)));
        const seen = new Set();
        let failed = 0;
        for (const r of settled) {
          const d = r.status === 'fulfilled' ? r.value : null;
          let list = [];
          if (d && d.loadType === 'playlist') list = d.data.tracks || [];
          else if (d && d.loadType === 'search') list = d.data || [];
          else if (d && d.loadType === 'track') list = [d.data];
          else failed++;
          for (const t of list) {
            const key = t.encoded || (t.info && (t.info.uri || t.info.identifier));
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            tracks.push(t);
          }
        }
        if (failed) toast(`${failed} of ${links.length} links could not be loaded`, 'warn');
        banner = `<div style="${bannerCss}"><span style="color:var(--text);font-weight:600">${links.length} links</span><span>${tracks.length} tracks</span>${actions}</div>`;
        data = { loadType: tracks.length ? 'multi' : 'empty' };
      } else {
        data = await Backend.loadtracks(id);
      }
      if (!data || data.loadType === 'empty') { res.innerHTML = `<div class="empty"><p>No results found</p></div>`; return; }
      if (data.loadType === 'error') { res.innerHTML = `<div class="empty"><p>Error: ${esc(data.data?.message || 'Unknown')}</p></div>`; return; }

      let plMeta = null;
      if (data.loadType === 'playlist') {
        tracks = data.data.tracks;
        plMeta = Library.playlistMeta(data, id);
        banner = `<div style="padding:8px 12px;font-family:var(--fm);font-size:10px;color:var(--muted);border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:10px">
          ${srcBadge(srcFromUrl(id) || trackSrc(tracks[0]), 'inline')}<span style="color:var(--text);font-weight:600">${esc(data.data.info?.name || 'Playlist')}</span>
          <span>${tracks.length} tracks</span>
          <button class="add-btn" id="btn-add-all" style="opacity:1;margin-left:auto"><span class="material-symbols-outlined m-ico">playlist_add</span>Add All</button><button class="add-btn" id="btn-shuf-all" style="opacity:1" title="Shuffle these tracks, then add them to the queue"><span class="material-symbols-outlined m-ico">shuffle</span>Shuffle Add</button>
          <button class="add-btn" id="btn-lib-save" style="opacity:1" title="Save this playlist to your library"><span class="material-symbols-outlined">bookmark_add</span>Save</button>
          <button class="add-btn" id="btn-dl-all" style="opacity:1" title="Download every track in this playlist"><span class="material-symbols-outlined">download</span>Download All</button>
        </div>`;
      } else if (data.loadType === 'search') {
        tracks = data.data;
      } else if (data.loadType === 'track') {
        tracks = [data.data];
      }

      S.searchResults = tracks;
      if (!tracks.length) { res.innerHTML = `<div class="empty"><p>No results</p></div>`; return; }

      if (!banner && tracks.length > 1) {
        banner = `<div style="padding:8px 12px;font-family:var(--fm);font-size:10px;color:var(--muted);border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:10px">
          <span>${tracks.length} results</span>
          <button class="add-btn" id="btn-add-all" style="opacity:1;margin-left:auto"><span class="material-symbols-outlined m-ico">playlist_add</span>Add All</button><button class="add-btn" id="btn-shuf-all" style="opacity:1" title="Shuffle these tracks, then add them to the queue"><span class="material-symbols-outlined m-ico">shuffle</span>Shuffle Add</button>
          <button class="add-btn" id="btn-dl-all" style="opacity:1" title="Download every result"><span class="material-symbols-outlined">download</span>Download All</button>
        </div>`;
      }

      // Only the first 100 rows go into the DOM; the next 100 are appended each
      // time the user scrolls to the end (see _sRender / _sWatch). The banner,
      // Add All / Shuffle Add / Download All and S.searchResults all still use
      // the FULL result list — only the rendering is windowed.
      res.innerHTML = banner;
      this._sLimit = this._SCHUNK;
      this._sShown = 0;
      this._sRender(res);
      this._sWire(res);

      const addAll = document.getElementById('btn-add-all');
      if (addAll) addAll.addEventListener('click', async () => {
        addAll.disabled = true;
        const prevLabel = addAll.innerHTML;
        addAll.textContent = 'Adding…';
        await Engine.addAllToQueue(tracks);
        toast(`Added ${tracks.length} tracks`, 'success');
        UI.switchTab('queue');
        addAll.disabled = false;
        addAll.innerHTML = prevLabel;
      });

      const shufAll = document.getElementById('btn-shuf-all');
      if (shufAll) shufAll.addEventListener('click', async () => {
        shufAll.disabled = true;
        const prevLabel = shufAll.innerHTML;
        shufAll.textContent = 'Adding…';
        await Engine.addAllToQueue(tracks, { shuffle: true });
        toast(`Shuffle-added ${tracks.length} tracks`, 'success');
        UI.switchTab('queue');
        shufAll.disabled = false;
        shufAll.innerHTML = prevLabel;
      });

      const libSave = document.getElementById('btn-lib-save');
      if (libSave && plMeta) libSave.addEventListener('click', () => Library.addCollection({ ...plMeta, tracks }));

      const dlAll = document.getElementById('btn-dl-all');
      if (dlAll) dlAll.addEventListener('click', e => { e.stopPropagation(); UI.openDownloadMenu(dlAll, tracks); });
    } catch (e) {
      res.innerHTML = `<div class="empty"><p>Error: ${esc(e.message)}</p></div>`;
      console.error('Search error:', e);
    }
  },

  /* Lyrics cache + preload. _lyrLoad(encoded) returns ONE shared promise per
     track, so a preload that is still in flight when the track becomes current
     is simply awaited by fetchLyrics() instead of being requested twice.
     Failures are not cached (a later attempt retries); "no lyrics" is. */
  _lyrCache: new Map(),   // encoded -> Promise<response>
  _LYR_CACHE_MAX: 2,    // current + next
  _lyrPreFor: null,       // encoded of the track last preloaded

  _lyrLoad(encoded, keep) {
    let p = this._lyrCache.get(encoded);
    if (p) {                                   // hit: mark as most recently used
      this._lyrCache.delete(encoded); this._lyrCache.set(encoded, p);
      return p;
    }
    p = Promise.resolve(Backend.loadlyrics(encoded)).catch(e => { this._lyrCache.delete(encoded); throw e; });
    this._lyrCache.set(encoded, p);
    this._lyrEvict(encoded, keep);
    return p;
  },

  // Trim to _LYR_CACHE_MAX, oldest first — but never drop an entry that is
  // about to be needed. When a track starts, the queue (and so the "next"
  // preload) updates BEFORE the new current track asks for its lyrics, so at
  // that instant the track that is about to play is neither current nor the
  // queue head. Dropping it there is what made lyrics fetch twice. Entries in
  // `keep` (the previous preload target) are protected for that reason; the
  // cache may sit one over the limit for a moment and trims on the next insert.
  _lyrEvict(justAdded, keep) {
    const cur = S.current && S.current.encoded;
    const head = S.queue && S.queue[0] && S.queue[0].encoded;
    const safe = new Set([justAdded, cur, head, ...(keep || [])]);
    for (const k of this._lyrCache.keys()) {
      if (this._lyrCache.size <= this._LYR_CACHE_MAX) break;
      if (!safe.has(k)) this._lyrCache.delete(k);
    }
  },

  // Warm the cache for the next track in the queue (if there is one). Safe to
  // call as often as you like — it only fires once per distinct next track.
  preloadNextLyrics() {
    const next = S.queue && S.queue[0];
    const enc = next && next.encoded;
    if (!enc || enc === (S.current && S.current.encoded)) return;
    if (this._lyrPreFor === enc) return;
    const prev = this._lyrPreFor;
    this._lyrPreFor = enc;
    this._lyrLoad(enc, [prev]).catch(() => { if (this._lyrPreFor === enc) this._lyrPreFor = null; });
  },

  // Manual "Fetch Lyrics": throw away whatever we have for this track (cached
  // result, including a cached "no lyrics found" or an error) and ask again.
  refetchLyrics() {
    if (!S.current) return;
    const enc = S.current.encoded;
    this._lyrCache.delete(enc);
    S.lyricsFetchedFor = null;
    S.lyrics = null; S.lyricsType = null; S._lyrLastIdx = -1;
    this.fetchLyrics({ notify: true });
  },

  // Synced / Unsynced pill next to the Fetch Lyrics button. Not rendered at
  // all unless lyrics are actually loaded for the current track.
  _lyrBadge() {
    const b = document.getElementById('lyr-badge');
    if (!b) return;
    const kind = S.lyrics && S.lyrics.length ? S.lyricsType : null;
    if (kind !== 'synced' && kind !== 'plain') { b.hidden = true; b.className = ''; b.innerHTML = ''; return; }
    const synced = kind === 'synced';
    b.hidden = false;
    b.className = synced ? 'synced' : '';
    b.title = synced ? 'These lyrics are timed to the song' : 'These lyrics have no timing, so they will not follow the song';
    b.innerHTML = `<span class="material-symbols-outlined">${synced ? 'sync' : 'sync_disabled'}</span>${synced ? 'Synced' : 'Not synced'}`;
  },

  // The button is disabled while a fetch is running (and with no track).
  _lyrBusy(busy) {
    const b = document.getElementById('btn-lyr-refetch');
    if (b) b.disabled = busy || !S.current;
  },

  async fetchLyrics(opts = {}) {
    if (!S.current) { this._lyrBusy(false); return; }
    // Already fetched (or currently fetching) lyrics for this exact track —
    // nothing to do. This is what makes it safe to call fetchLyrics() from
    // updatePlayerUI() on every re-render instead of only from a manual
    // button click.
    const enc = S.current.encoded;
    if (S.lyricsFetchedFor === enc) { this.preloadNextLyrics(); return; }
    S.lyricsFetchedFor = enc;
    this._lyrBusy(true);
    this._lyrHold(false);
    this._lyrBadge();
    // Only a manual "Fetch Lyrics" gets an operation toast; the automatic
    // fetch on every track change stays quiet.
    const note = opts.notify ? toast.loading('Fetching lyrics…') : null;
    document.getElementById('lyr-src-lbl').textContent = 'Loading…';
    document.getElementById('lyr-body').innerHTML = `<div class="empty"><div class="dots"><span></span><span></span><span></span></div><p>Fetching lyrics…</p></div>`;
    const stale = () => !S.current || S.current.encoded !== enc;   // track changed while we waited
    try {
      await this._fetchLyricsInto(enc, stale);
      if (note) {
        if (S.lyrics && S.lyrics.length) note.update(`Lyrics loaded · ${S.lyricsType === 'synced' ? 'synced' : 'not synced'}`, 'success', 2200);
        else if (document.getElementById('lyr-src-lbl').textContent === 'Error') note.update('Could not fetch lyrics', 'error', 4000);
        else note.update('No lyrics found for this track', 'warn', 3000);
      }
    } finally {
      if (note && stale()) note.dismiss();
      if (!stale()) this._lyrBusy(false);
    }
  },

  async _fetchLyricsInto(enc, stale) {
    try {
      const data = await this._lyrLoad(enc);
      if (stale()) return;
      if (!data || data.loadType === 'empty' || !data.data) {
        S.lyrics = null; S.lyricsType = null;
        document.getElementById('lyr-src-lbl').textContent = 'No lyrics found';
        document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>No lyrics available</p></div>`;
        return;
      }
      const d = data.data;
      document.getElementById('lyr-src-lbl').textContent = `Source: ${d.provider || '?'}`;
      if (Array.isArray(d.lines) && d.lines.length > 0) {
        S.lyricsType = d.synced ? 'synced' : 'plain';
        S.lyrics = d.lines.map(l => ({ t: typeof l.time === 'number' ? l.time : parseFloat(l.time || 0), txt: l.text || '' }));
        document.getElementById('lyr-body').innerHTML =
          S.lyrics.map((l, i) => `<div class="ll" data-i="${i}" data-t="${l.t}">${esc(l.txt) || '<span class="material-symbols-outlined ll-note">music_note</span>'}</div>`).join('');
        if (d.synced) {
          document.querySelectorAll('.ll').forEach(el => {
            el.addEventListener('click', () => { this._lyrHold(false); Engine.seekTo(parseFloat(el.dataset.t)); });
          });
        }
      } else {
        S.lyrics = null; S.lyricsType = null;
        document.getElementById('lyr-src-lbl').textContent = 'No lyrics found';
        document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>No lyrics available</p></div>`;
      }
    } catch (e) {
      if (stale()) return;
      document.getElementById('lyr-src-lbl').textContent = `Error`;
      document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    }
    if (!stale()) this._lyrBadge();
    // Current track's lyrics are settled — now warm up the next one.
    this.preloadNextLyrics();
  },

  // Auto-scroll yields to the user. Any manual scroll gesture (wheel, touch
  // drag, scroll keys, grabbing a scrollbar) over the Lyrics tab stops
  // auto-scroll and shows a Sync button (like Spotify's); the active line is
  // still highlighted meanwhile. Following resumes only when the user presses
  // Sync (or the track changes) — there is no timer. We listen for the input
  // events themselves, NOT 'scroll' — a scroll event can't tell our own smooth
  // scrollIntoView from the user's. Window-level because the page (not just
  // #lyr-body) is what scrolls in the stacked layouts.
  _lyrHeld: false,
  _lyrBound: false,

  _lyrHold(on) {
    this._lyrHeld = on;
    const b = document.getElementById('btn-lyr-sync');
    if (b) { b.hidden = !(on && S.lyricsType === 'synced' && S.lyrics); if (!b.hidden) this._lyrPlaceSync(); }
  },

  // The button is fixed to the bottom of the VIEWPORT (the page itself scrolls
  // in the stacked layouts, so an absolute position ended up at the very end
  // of the lyrics). Horizontally it is centred on the lyrics column.
  _lyrPlaceSync() {
    const b = document.getElementById('btn-lyr-sync'), body = document.getElementById('lyr-body');
    if (!b || !body) return;
    const r = body.getBoundingClientRect();
    b.style.left = (r.left + r.width / 2) + 'px';
  },

  // Centre a lyric line in the part of the lyrics that is actually visible.
  // scrollIntoView({block:'center'}) centres in the whole viewport, but on
  // narrow screens the sticky player panel + tab bar cover the top of it, so
  // the "centred" line landed underneath them. Instead, measure the visible
  // band (below the sticky tabs, above the viewport bottom, clipped to the
  // lyrics box when it scrolls on its own) and scroll by the difference.
  _lyrCenter(el) {
    const body = document.getElementById('lyr-body');
    if (!el || !body) return;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const tabs = document.getElementById('tabs');
    let top = 0, bottom = vh;
    if (tabs) top = Math.max(0, tabs.getBoundingClientRect().bottom);
    const own = body.scrollHeight > body.clientHeight + 1;
    if (own) {
      const r = body.getBoundingClientRect();
      top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
    }
    if (bottom - top < 40) { bottom = vh; top = Math.min(top, vh - 40); }
    const er = el.getBoundingClientRect();
    const delta = (er.top + er.height / 2) - (top + (bottom - top) / 2);
    if (Math.abs(delta) < 2) return;
    if (own) body.scrollBy({ top: delta, behavior: 'smooth' });
    else window.scrollBy({ top: delta, behavior: 'smooth' });
  },

  _lyrResume() {
    this._lyrHold(false);
    const active = document.querySelector('.ll.active');
    if (active) this._lyrCenter(active);
  },

  _lyrBindUserScroll() {
    if (this._lyrBound) return;
    this._lyrBound = true;
    const pane = document.getElementById('pane-lyrics');
    const hold = () => { if (pane && pane.classList.contains('on') && S.lyricsType === 'synced') this._lyrHold(true); };
    const opt = { passive: true, capture: true };
    window.addEventListener('wheel', hold, opt);
    window.addEventListener('touchmove', hold, opt);
    window.addEventListener('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) hold();
    }, opt);
    // Scrollbar drag: the press lands on the root element (page scrollbar)
    // or on #lyr-body's own gutter, to the right of its content box.
    window.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (t === document.documentElement) hold();
      else if (t.id === 'lyr-body' && e.offsetX >= t.clientWidth) hold();
    }, opt);
    document.getElementById('btn-lyr-sync').addEventListener('click', () => this._lyrResume());
    window.addEventListener('resize', () => this._lyrPlaceSync());
  },

  syncLyrics() {
    if (S.lyricsType !== 'synced' || !S.lyrics || !S.player) return;
    this._lyrBindUserScroll();
    const nowMs = S.player.getPositionMs();
    let idx = -1;
    for (let i = 0; i < S.lyrics.length; i++) { if (S.lyrics[i].t <= nowMs) idx = i; else break; }
    if (idx === S._lyrLastIdx) return;
    S._lyrLastIdx = idx;
    document.querySelectorAll('.ll').forEach((el, i) => el.classList.toggle('active', i === idx));
    if (idx >= 0) {
      const active = document.querySelector(`.ll[data-i="${idx}"]`);
      if (active && !this._lyrHeld) this._lyrCenter(active);
    }
  },

  async fetchMeaning() {
    if (!S.current) { toast('Play a track first', 'warn'); return; }
    const modal = document.getElementById('meaning-modal');
    modal.classList.add('show');
    document.getElementById('meaning-title').textContent = S.current.info.title;
    document.getElementById('meaning-sub').textContent = 'Loading…';
    document.getElementById('meaning-body').innerHTML = '';
    try {
      const data = await Backend.meaning(S.current.encoded);
      if (!data || data.loadType === 'empty' || !data.data) {
        document.getElementById('meaning-sub').textContent = 'No information found'; return;
      }
      const d = data.data;
      document.getElementById('meaning-title').textContent = d.title || S.current.info.title;
      document.getElementById('meaning-sub').textContent = `${d.description || ''} · via ${d.provider || '?'}`;
      const paras = Array.isArray(d.paragraphs) ? d.paragraphs : (d.text ? [d.text] : []);
      document.getElementById('meaning-body').innerHTML = paras.map(p => `<p>${esc(p)}</p>`).join('') || '<p>No content available.</p>';
    } catch (e) {
      document.getElementById('meaning-sub').textContent = `Error: ${e.message}`;
    }
  },

  // Library / Search / Queue only keep 100 rows (per list) rendered after you
  // leave them, so coming back never lands on a long, already-expanded list.
  _resetTabWindow(tab) {
    if (tab === 'library') Library.resetWindow();
    else if (tab === 'queue') this.resetQueueWindow();
    else if (tab === 'search') this.resetSearchWindow();
  },

  // Trim the rendered search rows back to the first 100 and re-arm the footer.
  resetSearchWindow() {
    const res = document.getElementById('sres');
    this._sLimit = this._SCHUNK;
    if (!res || !S.searchResults.length || this._sShown === 0) return;
    if (this._sShown > this._SCHUNK) {
      res.querySelectorAll(':scope > .si').forEach((row, k) => { if (k >= this._SCHUNK) row.remove(); });
      this._sShown = this._SCHUNK;
    }
    this._sRender(res);
    res.scrollTop = 0;
  },

  switchTab(name) {
    const prev = S.activeTab;
    if (prev && prev !== name) this._resetTabWindow(prev);
    S.activeTab = name;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  },

  /* ═══════════════════ Chat: participant list ═══════════════════
     Renders the same participant list the header strip shows, but as a
     full list with names — the header strip only has room for a few
     avatar chips. */
  renderChatUsers(list) {
    const wrap = document.getElementById('chat-users-list');
    const count = document.getElementById('chat-users-count');
    if (!wrap) return;
    list = list || [];
    count.textContent = list.length ? `(${list.length})` : '';
    if (!list.length) { wrap.innerHTML = `<div class="cu-empty">No one here yet</div>`; return; }
    wrap.innerHTML = list.map(p => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      return `<div class="cu-item">
        <div class="cu-avatar ${p.isHost ? 'is-host' : ''}">${esc(initial)}</div>
        <div class="cu-meta">
          <div class="cu-name" title="${esc(p.name)}">${esc(p.name)}</div>
          ${p.isHost ? '<div class="cu-tag">HOST</div>' : p.isDj ? '<div class="cu-tag">DJ</div>' : ''}
        </div>
      </div>`;
    }).join('');
  },

  /* ───────── Disc Jockey card ─────────
     The host appoints/removes DJs, kicks and bans with explicit buttons on
     each user's row (no more click-the-row-to-toggle). DJs can drive the
     player and queue exactly like the host (see UI.canControl / Lobby.djs in
     server.py); everyone else sees the same list read-only. Banned users are
     listed at the bottom for the host, each with an Unban button. */
  renderDjCard(list) {
    const wrap = document.getElementById('dj-list');
    if (!wrap) return;
    list = list || S.lobby.participants || [];
    const isHost = S.mode === 'server' && S.lobby.isHost;
    const hint = document.getElementById('dj-hint');
    if (hint) hint.textContent = isHost
      ? 'Use the buttons to make someone a DJ, kick them, or ban them. DJs can control the player and queue.'
      : 'DJs can control the player and queue like the host. Only the host can appoint them.';
    if (!list.length) { wrap.innerHTML = `<div class="cu-empty">No one here yet</div>`; return; }
    let html = list.map(p => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      const me = p.uid === LobbyAPI.userId();
      const canManage = isHost && !p.isHost && !me;
      const tag = p.isHost ? 'HOST' : p.isDj ? 'DJ' : '';
      const acts = canManage ? `<span class="dj-acts">
          <button type="button" class="qa dj-btn" data-act="dj" data-id="${esc(p.uid)}" title="${p.isDj ? 'Remove DJ' : 'Make DJ'}"><span class="material-symbols-outlined">${p.isDj ? 'remove_circle' : 'headphones'}</span>${p.isDj ? 'Remove DJ' : 'Make DJ'}</button>
          <button type="button" class="qa dj-btn" data-act="kick" data-id="${esc(p.uid)}" title="Kick (they can rejoin)"><span class="material-symbols-outlined">logout</span>Kick</button>
          <button type="button" class="qa d dj-btn" data-act="ban" data-id="${esc(p.uid)}" title="Ban (they can't rejoin)"><span class="material-symbols-outlined">block</span>Ban</button>
        </span>` : '';
      return `<div class="dj-item ${p.isDj ? 'is-dj' : ''} ${p.isHost ? 'is-host' : ''}" data-name="${esc(p.name)}">
        <span class="cu-avatar ${p.isHost ? 'is-host' : ''}">${esc(initial)}</span>
        <span class="dj-name">${esc(p.name)}${me ? ' <span class="dj-you">(you)</span>' : ''}</span>
        ${tag ? `<span class="dj-tag">${tag}</span>` : ''}
        ${acts}
      </div>`;
    }).join('');
    const banned = isHost ? (S.lobby.banned || []) : [];
    if (banned.length) {
      html += `<div class="dj-sub">Banned</div>` + banned.map(b => `
        <div class="dj-item is-banned">
          <span class="cu-avatar"><span class="material-symbols-outlined" style="font-size:16px">block</span></span>
          <span class="dj-name">${esc(b.name)}</span>
          <span class="dj-acts"><button type="button" class="qa dj-btn" data-act="unban" data-uid="${esc(b.uid)}"><span class="material-symbols-outlined">undo</span>Unban</button></span>
        </div>`).join('');
    }
    wrap.innerHTML = html;
  },

  /* ═══════════════════ Config tab ═══════════════════
     Merges what used to be the mode-select / standalone-connect /
     server-setup / lobby-select onboarding overlays into one in-app tab,
     since the app now always boots straight into a fresh default lobby
     (see Main.autoStart in main.js) instead of asking up front. */
  _cfgMode: null,

  setConfigMode(mode) {
    this._cfgMode = mode;
    document.querySelectorAll('.cfg-mode-btn').forEach(b => b.classList.toggle('on', b.dataset.cfgmode === mode));
    document.getElementById('cfg-lobby').classList.toggle('on', mode === 'lobby');
    document.getElementById('cfg-standalone').classList.toggle('on', mode === 'standalone');
  },

  renderConfigTab() {
    if (!this._cfgMode) this.setConfigMode(S.mode === 'standalone' ? 'standalone' : 'lobby');
    this.updateServerUrlDisplay();
    this.renderCurrentLobbyConfig();
    this.renderDjCard();
    Sessions.render();
    this.renderUserSettings();
    if (S.mode === 'server') Lobby.refreshPublicList();
    document.getElementById('sa-disconnect-cfg').style.display = (S.mode === 'standalone') ? 'inline-block' : 'none';
  },

  /* ───────── User Settings card ─────────
     Display name + default lobby name live here now, instead of being
     retyped on Join/Create every time (those tabs are gone — lobbies are
     created automatically on startup/leave, see Main.autoStart and
     Lobby.leave). Just two Store-backed (IndexedDB) fields that future lobby
     creations/joins read from. */
  renderUserSettings() {
    const nameInput = document.getElementById('us-display-name');
    const lobbyInput = document.getElementById('us-lobby-name');
    if (!nameInput || !lobbyInput) return;
    if (document.activeElement !== nameInput) nameInput.value = Store.getItem('nl_display_name') || '';
    if (document.activeElement !== lobbyInput) lobbyInput.value = Store.getItem('nl_lobby_name') || '';
  },

  async saveUserSettings() {
    const name = document.getElementById('us-display-name').value.trim();
    const lobbyName = document.getElementById('us-lobby-name').value.trim();
    if (name) Store.setItem('nl_display_name', name);
    if (lobbyName) Store.setItem('nl_lobby_name', lobbyName);

    // Current Lobby no longer has its own name/display-name fields — this
    // is the only place either value is entered, so if we're in a lobby
    // right now, push them live instead of waiting for the next auto-create.
    if (S.mode === 'server' && S.lobby.active) {
      if (name && name !== S.lobby.displayName) await Lobby.rename(name);
      if (S.lobby.isHost && lobbyName) {
        const cur = S.lobby.lastServerState || {};
        if (lobbyName !== cur.name) await Lobby.updateSettings({ name: lobbyName });
      }
    }

    toast('User settings saved', 'success', 1500);
  },

  updateServerUrlDisplay() {
    const el = document.getElementById('cfg-server-url');
    if (el) el.textContent = Backend.serverUrl || window.location.origin;
  },

  renderCurrentLobbyConfig() {
    const inLobby = S.mode === 'server' && S.lobby.active;
    // Lobbies are always auto-created (see Main.autoStart / Lobby.leave), so
    // there's no real "not in a lobby" state worth showing — this tab is
    // just briefly blank the instant before the very first lobby connects.
    document.getElementById('cfg-lobby-form').style.display = 'block';
    if (!inLobby) { document.getElementById('cfg-lobby-code').textContent = '------'; const ce = document.getElementById('cfg-code-edit'); if (ce) ce.style.display = 'none'; return; }

    document.getElementById('cfg-lobby-code').textContent = S.lobby.code;
    const codeEdit = document.getElementById('cfg-code-edit');
    if (codeEdit) codeEdit.style.display = S.lobby.isHost ? 'block' : 'none';

    // Name and display name are no longer edited here — see User Settings
    // above, which is now the single place those live (and pushes changes
    // to the server itself; see saveUserSettings).
    const cur = S.lobby.lastServerState || {};
    const hasPw = !!cur.hasPassword;
    const passEdit = document.getElementById('cfg-pass-edit');
    if (passEdit) passEdit.style.display = S.lobby.isHost ? 'block' : 'none';
    const passStatus = document.getElementById('cfg-pass-status');
    if (passStatus) passStatus.textContent = hasPw ? '🔒 password protected' : '(optional — anyone with the code can join)';
    const passClear = document.getElementById('cfg-pass-clear');
    if (passClear) passClear.disabled = !hasPw;
    const passSet = document.getElementById('cfg-pass-set');
    if (passSet) passSet.textContent = hasPw ? 'Change Password' : 'Set Password';
    document.querySelectorAll('input[name="cfg-vis"]').forEach(r => {
      r.checked = (r.value === 'public') === !!cur.isPublic;
      r.disabled = !S.lobby.isHost;
    });
  },

  async setLobbyPassword(clear) {
    if (!(S.mode === 'server' && S.lobby.active)) return;
    if (!S.lobby.isHost) { toast('Only the host can change the password', 'warn'); return; }
    const input = document.getElementById('cfg-pass-input');
    const pw = clear ? '' : input.value.trim();
    if (!clear && !pw) { toast('Type a password first', 'warn'); input.focus(); return; }
    const ok = await Lobby.updateSettings({ password: pw });
    if (ok) {
      input.value = '';
      toast(clear ? 'Password removed — anyone with the code can join' : 'Password set', 'success', 2000);
      this.renderCurrentLobbyConfig();
    }
  },

  async saveConfigLobby() {
    if (!(S.mode === 'server' && S.lobby.active)) return;
    if (!S.lobby.isHost) { toast('Only the host can change lobby settings', 'warn'); return; }
    const cur = S.lobby.lastServerState || {};
    const isPublic = document.querySelector('input[name="cfg-vis"]:checked').value === 'public';
    if (isPublic === !!cur.isPublic) { toast('Nothing to save', 'info', 1500); return; }
    const ok = await Lobby.updateSettings({ isPublic });
    if (ok) toast('Settings saved', 'success', 1500);
  },

  // Points the app at a different noobplayer server entirely — leaves the
  // current lobby (or disconnects standalone) first since a different
  // server means a wholly different set of lobbies, then boots a fresh
  // default lobby on it, same as first load.
  async switchNoobplayerServer() {
    const mode = document.querySelector('input[name="cfg-srv"]:checked').value;
    let url;
    const pwEl = document.getElementById('cfg-srv-pw');
    if (mode === 'custom') {
      url = document.getElementById('cfg-srv-url').value.trim();
      if (!url) { toast('Enter a server URL', 'warn'); return; }
    }

    // Check the password BEFORE leaving anything, so a typo doesn't cost you
    // your current lobby. Custom: the password field (empty = a saved login, or
    // none needed). Default: this page's own server (window opens if it asks).
    const target = mode === 'custom' ? Auth.normalize(url) : window.location.origin;
    const auth = await Auth.ensure(target, {
      password: mode === 'custom' ? pwEl.value : '',
      askIfNeeded: mode !== 'custom', cancelable: true,
    });
    if (!auth.ok) {
      if (mode === 'custom') {
        toast(auth.error === 'wrong password' ? 'Wrong server password' : 'That server needs a password — enter it below the server URL', 'warn', 4000);
        pwEl.focus();
      }
      return;
    }
    if (mode === 'custom') pwEl.value = '';

    if (S.mode === 'server' && S.lobby.active) {
      await Lobby.leave({ autoRejoin: false });
    } else if (S.mode === 'standalone') {
      Standalone.disconnect();
    }

    if (mode === 'default') Lobby.chooseDefaultServer(); else Lobby.chooseCustomServer(url);
    this.updateServerUrlDisplay();

    const displayName = Store.getItem('nl_display_name') || 'Guest';
    const lobbyName = Store.getItem('nl_lobby_name') || 'New Lobby';
    await Lobby.create(lobbyName, false, displayName);
    this.setConfigMode('lobby');
    this.renderConfigTab();
  },

  setupProgressBar() {
    const bar = document.getElementById('prog-bar');
    function msFromEvent(e) {
      const r = bar.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - r.left, r.width));
      const dur = S.current?.info.length || 0;
      return (x / r.width) * dur;
    }
    bar.addEventListener('mousedown', e => {
      if (!S.current || UI.isLocked()) return;
      S.progDrag = true;
      const ms = msFromEvent(e);
      const pct = Math.min((ms / (S.current.info.length || 1)) * 100, 100);
      document.getElementById('prog-fill').style.width = pct + '%';
      document.getElementById('prog-thumb').style.left = pct + '%';
      document.getElementById('t-cur').textContent = fmt(ms);
    });
    document.addEventListener('mousemove', e => {
      if (!S.progDrag || !S.current) return;
      const ms = msFromEvent(e);
      const pct = Math.min((ms / (S.current.info.length || 1)) * 100, 100);
      document.getElementById('prog-fill').style.width = pct + '%';
      document.getElementById('prog-thumb').style.left = pct + '%';
      document.getElementById('t-cur').textContent = fmt(ms);
    });
    document.addEventListener('mouseup', e => {
      if (!S.progDrag) return;
      S.progDrag = false;
      if (S.current) Engine.seekTo(msFromEvent(e));
    });
    bar.addEventListener('click', e => {
      if (!S.current || UI.isLocked()) return;
      Engine.seekTo(msFromEvent(e));
    });
  },
};