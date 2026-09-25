'use strict';
/* ═══════════════════════════════════════════
   UI — all DOM rendering. Mode-agnostic except where it checks
   S.mode / S.lobby.isHost to lock host-only controls.
═══════════════════════════════════════════ */
const UI = {

  isLocked() { return S.mode === 'server' && !S.lobby.isHost; },

  applyLockState() {
    const locked = this.isLocked();
    const ids = ['btn-prev','btn-b10','btn-play','btn-f10','btn-next','btn-stop','btn-apply-flt'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = locked; });
    document.querySelectorAll('.preset-btn').forEach(b => b.disabled = locked);
    document.querySelectorAll('.flt-slider').forEach(s => s.disabled = locked);
    document.getElementById('prog-bar').classList.toggle('locked', locked);

    // These used to be disabled for the whole of server mode because the
    // lobby had no server-side notion of loop/shuffle/clear at all. It does
    // now (see Lobby.peek_next_track / advance_track in server.py), so they
    // follow the same host rule as every other playback control rather than
    // being switched off for everyone including the host.
    ['btn-shuf','loop-btn','gapless-btn','btn-qshuf','btn-qclr','btn-qsmart','btn-qfair','btn-autoplay']
      .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = locked; });

    document.querySelectorAll('.add-btn.pnow').forEach(b => b.disabled = locked);
    document.getElementById('lock-badge').classList.toggle('show', locked);
    document.getElementById('flt-lock-note').classList.toggle('show', locked);
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

  updateQueueHeader() {
    const count = S.queue.length;
    const totalMs = S.queue.reduce((a, t) => a + (t.info?.length || 0), 0);
    const info = document.getElementById('q-info');
    if (info) {
      info.textContent = count === 0
        ? 'Queue empty'
        : `${count} track${count !== 1 ? 's' : ''} · ${fmt(totalMs)}`;
    }

    const ap = document.getElementById('btn-autoplay');
    if (ap) {
      const pool = S.autoQueueCount || 0;
      const lbls = { enabled: 'Auto: On', partial: 'Auto: ½', disabled: 'Auto: Off' };
      ap.textContent = S.recPending ? 'Auto …' : lbls[S.autoplay] || 'Auto';
      ap.classList.toggle('on', S.autoplay === 'enabled');
      ap.title = {
        enabled:  'Autoplay: keeps the queue going with recommendations when it runs dry',
        partial:  'Autoplay: collecting recommendations for Smart Shuffle, but not auto-queueing them',
        disabled: 'Autoplay: off',
      }[S.autoplay] + (pool ? ` · ${pool} in the pool` : '');
    }
  },

  setBuffering(on) { document.getElementById('buf-ring').classList.toggle('show', on); },

  updatePlayerUI() {
    const t = S.current;
    const img = document.getElementById('art-img');
    const empty = document.getElementById('art-empty');
    document.getElementById('btn-dl').disabled = !t;

    if (t) {
      if (t.info.artworkUrl) {
        img.src = t.info.artworkUrl;
        img.onload = () => img.classList.add('vis');
        img.onerror = () => { img.classList.remove('vis'); empty.style.display = 'flex'; };
        empty.style.display = 'none';
      } else { img.classList.remove('vis'); empty.style.display = 'flex'; }

      const srcMap = { youtube:'YOUTUBE', youtubemusic:'YT MUSIC', soundcloud:'SOUNDCLOUD',
        spotify:'SPOTIFY', deezer:'DEEZER', bandcamp:'BANDCAMP', applemusic:'APPLE MUSIC', yandexmusic:'YANDEX' };
      const src = (t.info.sourceName || '').toLowerCase();
      document.getElementById('info-src-txt').textContent = srcMap[src] || src.toUpperCase() || '— PLAYING —';
      document.getElementById('info-title').textContent = t.info.title;
      document.getElementById('info-title').style.color = 'var(--text)';
      document.getElementById('info-artist').textContent = t.info.author;
      document.getElementById('t-tot').textContent = fmt(t.info.length);
    } else {
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
  openDownloadMenu(anchorEl, track) {
    this.closeDownloadMenu();
    if (!track) { toast('Nothing to download', 'warn'); return; }
    if (!DownloadAPI.available()) { toast('Downloads need a server connection', 'warn'); return; }

    const menu = document.createElement('div');
    menu.className = 'dl-menu';
    menu.innerHTML = `
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
        triggerDownload(DownloadAPI.url(track, btn.dataset.fmt));
        toast(`Downloading "${track.info.title}" — this can take a moment`, 'info', 3000);
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

  renderQueue() {
    const count = S.queue.length;
    document.getElementById('q-badge').textContent = count > 0 ? `(${count})` : '';
    this.updateQueueHeader();
    this.updateLoopButton();

    const el = document.getElementById('ql');
    if (count === 0) {
      el.innerHTML = `<div class="empty"><span class="material-symbols-outlined">queue_music</span><p>Queue is empty</p></div>`;
      this.applyLockState();
      return;
    }
    const locked = this.isLocked();
    const me = S.lobby.clientId;
    el.innerHTML = S.queue.map((t, i) => {
      const thumb = t.info.artworkUrl
        ? `<img class="qi-th" src="${esc(t.info.artworkUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="qi-nth"><span class="material-symbols-outlined">music_note</span></div>`;
      // Anyone can pull a track they added themselves; only the host can
      // pull someone else's. Same rule the server enforces on
      // /queue/remove — this just stops the button lying about it.
      const req = t.requester || null;
      const mine = req && me && req.id === me;
      const auto = req && req.id === '__auto__';
      const canRemove = !locked || mine;
      const chip = req
        ? `<span class="qi-req ${auto ? 'auto' : ''} ${mine ? 'mine' : ''}" title="Added by ${esc(req.name)}">${auto ? '<span class="material-symbols-outlined chip-ico">auto_awesome</span>auto' : esc(req.name)}</span>`
        : '';
      return `<div class="qi" data-qi="${i}" draggable="${locked ? 'false' : 'true'}">
        <span class="qi-drag material-symbols-outlined" title="Drag to reorder">drag_indicator</span>
        <span class="qi-n">${i + 1}</span>${thumb}
        <div class="qi-m">
          <div class="qi-t">${esc(t.info.title)}</div>
          <div class="qi-a">${esc(t.info.author)}${chip}</div>
        </div>
        <div class="qi-bs">
          <button class="qib" data-qa="play" data-qi="${i}" title="Play now" ${locked?'disabled':''}><span class="material-symbols-outlined">play_arrow</span></button>
          <button class="qib" data-qa="up"   data-qi="${i}" title="Move up" ${(locked||i===0)?'disabled':''}><span class="material-symbols-outlined">keyboard_arrow_up</span></button>
          <button class="qib" data-qa="dn"   data-qi="${i}" title="Move down" ${(locked||i===S.queue.length-1)?'disabled':''}><span class="material-symbols-outlined">keyboard_arrow_down</span></button>
          <button class="qib dl" data-qa="dl" data-qi="${i}" title="Download"><span class="material-symbols-outlined">download</span></button>
          <button class="qib del" data-qa="rm" data-qi="${i}" title="${canRemove ? 'Remove' : 'Only the host can remove other people\u2019s tracks'}" ${canRemove?'':'disabled'}><span class="material-symbols-outlined">close</span></button>
        </div>
        <span class="qi-d">${fmt(t.info.length)}</span>
      </div>`;
    }).join('');

    el.querySelectorAll('.qib').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.qi);
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
        else if (a === 'rm') Engine.removeFromQueue(i);
        else if (a === 'dl') UI.openDownloadMenu(btn, S.queue[i]);
      });
    });

    this._wireQueueDragAndDrop(el, locked);
    this.applyLockState();
  },

  // HTML5 drag-and-drop reordering — dragging a queue item onto another
  // one's slot moves it there (Engine.moveQueueItem), which also covers
  // "swapping" two tracks: drag A onto B and A lands where B was.
  _wireQueueDragAndDrop(el, locked) {
    if (locked) return;
    let dragFrom = null;

    el.querySelectorAll('.qi').forEach(item => {
      item.addEventListener('dragstart', e => {
        dragFrom = parseInt(item.dataset.qi);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_) {}
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        el.querySelectorAll('.qi').forEach(x => x.classList.remove('drag-over'));
        dragFrom = null;
      });
      item.addEventListener('dragover', e => {
        if (dragFrom === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const to = parseInt(item.dataset.qi);
        if (dragFrom === null || isNaN(to) || dragFrom === to) return;
        Engine.moveQueueItem(dragFrom, to);
        dragFrom = null;
      });
    });
  },

  async doSearch() {
    const raw = document.getElementById('si').value.trim();
    if (!raw) { toast('Enter a search term or URL', 'warn'); return; }

    const src = document.getElementById('src-sel').value;
    const isUrl = raw.startsWith('http://') || raw.startsWith('https://');
    const id = (isUrl || !src) ? raw : src + raw;

    const res = document.getElementById('sres');
    res.innerHTML = `<div class="empty"><div class="dots"><span></span><span></span><span></span></div><p>Searching…</p></div>`;

    try {
      const data = await Backend.loadtracks(id);
      if (!data || data.loadType === 'empty') { res.innerHTML = `<div class="empty"><p>No results found</p></div>`; return; }
      if (data.loadType === 'error') { res.innerHTML = `<div class="empty"><p>Error: ${esc(data.data?.message || 'Unknown')}</p></div>`; return; }

      let tracks = [];
      let banner = '';
      if (data.loadType === 'playlist') {
        tracks = data.data.tracks;
        banner = `<div style="padding:8px 12px;font-family:var(--fm);font-size:10px;color:var(--muted);border-bottom:1px solid var(--brd);display:flex;align-items:center;gap:10px">
          <span style="color:var(--text);font-weight:600">${esc(data.data.info?.name || 'Playlist')}</span>
          <span>${tracks.length} tracks</span>
          <button class="add-btn" id="btn-add-all" style="opacity:1;margin-left:auto">+ Add All</button>
        </div>`;
      } else if (data.loadType === 'search') {
        tracks = data.data;
      } else if (data.loadType === 'track') {
        tracks = [data.data];
      }

      S.searchResults = tracks;
      if (!tracks.length) { res.innerHTML = `<div class="empty"><p>No results</p></div>`; return; }

      const locked = this.isLocked();
      let html = banner;
      tracks.forEach((t, i) => {
        const thumb = t.info.artworkUrl
          ? `<img class="si-th" src="${esc(t.info.artworkUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="si-nth"><span class="material-symbols-outlined">music_note</span></div>`;
        html += `<div class="si" data-i="${i}">${thumb}
          <div class="si-meta">
            <div class="si-t">${esc(t.info.title)}</div>
            <div class="si-a">${esc(t.info.author)}</div>
          </div>
          <div class="si-acts">
            <button class="add-btn pnow" data-a="play" data-i="${i}" ${locked?'disabled':''}><span class="material-symbols-outlined">play_arrow</span>Play</button>
            <button class="add-btn" data-a="q" data-i="${i}">+ Queue</button>
          </div>
          <span class="si-d">${fmt(t.info.length)}</span>
        </div>`;
      });
      res.innerHTML = html;

      res.querySelectorAll('.add-btn[data-a]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const t = S.searchResults[parseInt(btn.dataset.i)];
          if (!t) return;
          if (btn.dataset.a === 'play') {
            if (S.mode === 'standalone') { S.queue = []; if (S.current) S.history.push(S.current); }
            Engine.playTrack(t); UI.switchTab('queue');
          } else {
            Engine.addToQueue(t);
          }
        });
      });

      const addAll = document.getElementById('btn-add-all');
      if (addAll) addAll.addEventListener('click', async () => {
        addAll.disabled = true;
        const prevLabel = addAll.textContent;
        addAll.textContent = 'Adding…';
        await Engine.addAllToQueue(tracks);
        toast(`Added ${tracks.length} tracks`, 'success');
        UI.switchTab('queue');
        addAll.disabled = false;
        addAll.textContent = prevLabel;
      });
    } catch (e) {
      res.innerHTML = `<div class="empty"><p>Error: ${esc(e.message)}</p></div>`;
      console.error('Search error:', e);
    }
  },

  async fetchLyrics() {
    if (!S.current) { toast('Play a track first', 'warn'); return; }
    document.getElementById('lyr-src-lbl').textContent = 'Loading…';
    document.getElementById('lyr-body').innerHTML = `<div class="empty"><div class="dots"><span></span><span></span><span></span></div><p>Fetching lyrics…</p></div>`;
    try {
      const data = await Backend.loadlyrics(S.current.encoded);
      if (!data || data.loadType === 'empty' || !data.data) {
        S.lyrics = null; S.lyricsType = null;
        document.getElementById('lyr-src-lbl').textContent = 'No lyrics found';
        document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>No lyrics available</p></div>`;
        return;
      }
      const d = data.data;
      document.getElementById('lyr-src-lbl').textContent = `Source: ${d.source || '?'}`;
      if (Array.isArray(d.lines) && d.lines.length > 0) {
        S.lyricsType = 'synced';
        S.lyrics = d.lines.map(l => ({ t: typeof l.startTime === 'number' ? l.startTime : parseFloat(l.startTime || 0), txt: l.line || l.text || '' }));
        document.getElementById('lyr-body').innerHTML =
          S.lyrics.map((l, i) => `<div class="ll" data-i="${i}" data-t="${l.t}">${esc(l.txt) || '<span class="material-symbols-outlined ll-note">music_note</span>'}</div>`).join('');
        document.querySelectorAll('.ll').forEach(el => {
          el.addEventListener('click', () => Engine.seekTo(parseFloat(el.dataset.t)));
        });
      } else if (d.text || d.lyrics) {
        S.lyricsType = 'plain'; S.lyrics = d.text || d.lyrics;
        document.getElementById('lyr-body').innerHTML = `<div class="lp">${esc(S.lyrics)}</div>`;
      } else {
        S.lyrics = null; S.lyricsType = null;
        document.getElementById('lyr-src-lbl').textContent = 'No lyrics found';
        document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>No lyrics available</p></div>`;
      }
    } catch (e) {
      document.getElementById('lyr-src-lbl').textContent = `Error`;
      document.getElementById('lyr-body').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    }
  },

  syncLyrics() {
    if (S.lyricsType !== 'synced' || !S.lyrics || !S.player) return;
    const nowMs = S.player.getPositionMs();
    let idx = -1;
    for (let i = 0; i < S.lyrics.length; i++) { if (S.lyrics[i].t <= nowMs) idx = i; else break; }
    if (idx === S._lyrLastIdx) return;
    S._lyrLastIdx = idx;
    document.querySelectorAll('.ll').forEach((el, i) => el.classList.toggle('active', i === idx));
    if (idx >= 0) {
      const active = document.querySelector(`.ll[data-i="${idx}"]`);
      if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  syncSliderLabel(sliderId, labelId) {
    const v = parseFloat(document.getElementById(sliderId).value);
    document.getElementById(labelId).textContent = Number.isInteger(v) ? v : v.toFixed(2);
  },

  updateFilterStatus() {
    const el = document.getElementById('flt-status');
    const badge = document.getElementById('active-filter-badge');
    const keys = Object.keys(S.filters);
    if (keys.length === 0) {
      el.textContent = 'none'; badge.textContent = ''; badge.classList.remove('show');
    } else {
      el.textContent = JSON.stringify(S.filters, null, 2);
      badge.textContent = keys.join('+').toUpperCase(); badge.classList.add('show');
    }
  },

  buildFiltersFromUI() {
    const filters = {};
    const speed = parseFloat(document.getElementById('f-speed').value);
    const pitch = parseFloat(document.getElementById('f-pitch').value);
    const rate  = parseFloat(document.getElementById('f-rate').value);
    if (speed !== 1.0 || pitch !== 1.0 || rate !== 1.0) {
      filters.timescale = {};
      if (speed !== 1.0) filters.timescale.speed = speed;
      if (pitch !== 1.0) filters.timescale.pitch = pitch;
      if (rate  !== 1.0) filters.timescale.rate = rate;
    }
    const edel = parseFloat(document.getElementById('f-edel').value);
    const efb  = parseFloat(document.getElementById('f-efb').value);
    const emix = parseFloat(document.getElementById('f-emix').value);
    if (edel > 0 || efb > 0 || emix > 0) filters.echo = { delay: edel, feedback: efb, mix: emix };
    const rot = parseFloat(document.getElementById('f-rot').value);
    if (rot > 0) filters.rotation = { rotationHz: rot };
    return filters;
  },

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    S.activePreset = name;

    const ts = preset.timescale || {};
    document.getElementById('f-speed').value = ts.speed || 1.0;
    document.getElementById('f-pitch').value = ts.pitch || 1.0;
    document.getElementById('f-rate').value  = ts.rate  || 1.0;
    this.syncSliderLabel('f-speed', 'f-speed-v');
    this.syncSliderLabel('f-pitch', 'f-pitch-v');
    this.syncSliderLabel('f-rate',  'f-rate-v');

    const echo = preset.echo || {};
    document.getElementById('f-edel').value = echo.delay    || 0;
    document.getElementById('f-efb').value  = echo.feedback || 0;
    document.getElementById('f-emix').value = echo.mix      || 0;
    this.syncSliderLabel('f-edel', 'f-edel-v');
    this.syncSliderLabel('f-efb',  'f-efb-v');
    this.syncSliderLabel('f-emix', 'f-emix-v');

    const rot = preset.rotation?.rotationHz || 0;
    document.getElementById('f-rot').value = rot;
    this.syncSliderLabel('f-rot', 'f-rot-v');

    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  },

  switchTab(name) {
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
          ${p.isHost ? '<div class="cu-tag">HOST</div>' : ''}
        </div>
      </div>`;
    }).join('');
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
    this.renderUserSettings();
    if (S.mode === 'server') Lobby.refreshPublicList();
    document.getElementById('sa-disconnect-cfg').style.display = (S.mode === 'standalone') ? 'inline-block' : 'none';
  },

  /* ───────── User Settings card ─────────
     Display name + default lobby name live here now, instead of being
     retyped on Join/Create every time (those tabs are gone — lobbies are
     created automatically on startup/leave, see Main.autoStart and
     Lobby.leave). Just two localStorage-backed fields that future lobby
     creations/joins read from. */
  renderUserSettings() {
    const nameInput = document.getElementById('us-display-name');
    const lobbyInput = document.getElementById('us-lobby-name');
    if (!nameInput || !lobbyInput) return;
    if (document.activeElement !== nameInput) nameInput.value = localStorage.getItem('nl_display_name') || '';
    if (document.activeElement !== lobbyInput) lobbyInput.value = localStorage.getItem('nl_lobby_name') || '';
  },

  async saveUserSettings() {
    const name = document.getElementById('us-display-name').value.trim();
    const lobbyName = document.getElementById('us-lobby-name').value.trim();
    if (name) localStorage.setItem('nl_display_name', name);
    if (lobbyName) localStorage.setItem('nl_lobby_name', lobbyName);

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

  /* ───────── Lobby card: Public Lobbies / Current Lobby sub-tabs ───────── */
  switchLobbyTab(name) {
    document.querySelectorAll('.lobby-tab').forEach(t => t.classList.toggle('on', t.dataset.ltab === name));
    document.querySelectorAll('.lobby-pane').forEach(p => p.classList.toggle('on', p.id === 'ltab-' + name));
    if (name === 'public') Lobby.refreshPublicList();
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
    if (!inLobby) { document.getElementById('cfg-lobby-code').textContent = '------'; return; }

    document.getElementById('cfg-lobby-code').textContent = S.lobby.code;

    // Name and display name are no longer edited here — see User Settings
    // above, which is now the single place those live (and pushes changes
    // to the server itself; see saveUserSettings).
    const cur = S.lobby.lastServerState || {};
    document.querySelectorAll('input[name="cfg-vis"]').forEach(r => {
      r.checked = (r.value === 'public') === !!cur.isPublic;
      r.disabled = !S.lobby.isHost;
    });
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

  // Points the app at a different Flask server entirely — leaves the
  // current lobby (or disconnects standalone) first since a different
  // server means a wholly different set of lobbies, then boots a fresh
  // default lobby on it, same as first load.
  async switchFlaskServer() {
    const mode = document.querySelector('input[name="cfg-srv"]:checked').value;
    let url;
    if (mode === 'custom') {
      url = document.getElementById('cfg-srv-url').value.trim();
      if (!url) { toast('Enter a server URL', 'warn'); return; }
    }

    if (S.mode === 'server' && S.lobby.active) {
      await Lobby.leave({ autoRejoin: false });
    } else if (S.mode === 'standalone') {
      Standalone.disconnect();
    }

    if (mode === 'default') Lobby.chooseDefaultServer(); else Lobby.chooseCustomServer(url);
    this.updateServerUrlDisplay();

    const displayName = localStorage.getItem('nl_display_name') || 'Guest';
    const lobbyName = localStorage.getItem('nl_lobby_name') || 'New Lobby';
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

const PRESETS = {
  normal: {},
  bassBoost: { equalizer: [{band:0,gain:0.6},{band:1,gain:0.67},{band:2,gain:0.67},{band:3,gain:0.4},{band:4,gain:0.2},{band:5,gain:0.1}] },
  nightcore: { timescale: { speed: 1.3, pitch: 1.3, rate: 1.0 } },
  vaporwave:  { timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 } },
  '8d':       { rotation:  { rotationHz: 0.2 } },
  echo:       { echo: { delay: 500, feedback: 0.35, mix: 0.5 } },
  karaoke:    { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 } },
  chipmunk:   { timescale: { speed: 1.05, pitch: 1.35, rate: 1.25 } },
};