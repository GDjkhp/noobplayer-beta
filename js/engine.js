'use strict';
/* ═══════════════════════════════════════════
   Engine — playback control.

   Standalone mode: public methods act directly on the local PCMPlayer,
   fed by this client's own PCM fetch from NodeLink. Gapless playback
   works by predicting whatever track will play next (from the queue /
   loop mode), prefetching its PCM in the background while the current
   track is still playing, and — when the current track's stream runs
   out — splicing the prefetched bytes straight onto the SAME AudioContext
   timeline instead of tearing the player down and starting fresh. See
   `_ensurePreload` / `_spliceGapless` below.

   Server mode: public methods (for the host) send REST control calls to
   the lobby; actual audio comes from ONE server-side Opus/Ogg relay per
   lobby (see server.py's LobbyRelay), and every client — host included —
   is just an <audio> element pointed at it (see AudioElPlayer). There's
   no local PCM stream, no drift correction, and no per-client NodeLink
   fetch: Lobby.onState() calling Engine._lobbySync() just keeps that
   <audio> element (and the reused PCMPlayer-shaped UI hooks) in sync
   with the server's authoritative state. Gapless preloading + stitching
   for that mode happens server-side (LobbyRelay.ensure_preload /
   _pump_track in server.py) — the relay keeps muxing into the SAME
   Opus/Ogg session across the track boundary, so relayGen doesn't bump
   and the client's <audio> element never has to reconnect.
═══════════════════════════════════════════ */
const Engine = {

  /* ───────── low-level: actually fetch + play PCM locally ───────── */
  async _localPlay(track, positionMs = 0, filters = {}) {
    S.current = track;
    S.lyrics = null; S.lyricsType = null; S._lyrLastIdx = -1;
    S.chapters = [];

    UI.updatePlayerUI();
    UI.setBuffering(true);

    await this._startPCMStream(track.encoded, positionMs, filters);
    UI.renderQueue();
    UI.fetchChapters(track.encoded);
    this._ensurePreload();
    // Fire-and-forget: keeps the recommendation pool topped up off whatever
    // is playing now, the way the bot's queue_on_start() calls get_rekt().
    this._populateRecommendations(track);
  },

  async _startPCMStream(encodedTrack, positionMs, filters) {
    const gen = ++S.playGen;
    if (S.fetchCtrl) { S.fetchCtrl.abort(); S.fetchCtrl = null; }
    if (S.trackEndTimer) { clearTimeout(S.trackEndTimer); S.trackEndTimer = null; }

    const vol = document.getElementById('vol-sl').value / 100;
    if (!S.player) S.player = new PCMPlayer();
    await S.player.init(vol);
    S.player.seekOffsetMs = positionMs;

    const ctrl = new AbortController();
    S.fetchCtrl = ctrl;
    UI.setBuffering(true);

    let resp;
    try {
      resp = await Backend.openStream(encodedTrack, positionMs, filters, ctrl.signal);
    } catch (e) {
      if (e.name === 'AbortError') return;
      UI.setBuffering(false);
      if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
        document.getElementById('cors-note').classList.add('show');
      }
      toast(`Stream error: ${e.message}`, 'error', 6000);
      return;
    }

    if (!resp.ok) {
      UI.setBuffering(false);
      const errText = await resp.text().catch(() => '');
      toast(`Stream error ${resp.status}: ${errText}`, 'error', 6000);
      if (resp.status === 404 || resp.status === 503) {
        toast('Check enableLoadStreamEndpoint in NodeLink config.js', 'warn', 8000);
      }
      return;
    }

    const reader = resp.body.getReader();
    let firstChunk = true;

    (async () => {
      try {
        while (true) {
          if (gen !== S.playGen) break;
          const { done, value } = await reader.read();
          if (done) {
            if (gen === S.playGen) this._handleStreamExhausted(gen);
            break;
          }
          if (gen !== S.playGen) break;
          S.player.feed(value);
          if (firstChunk) {
            firstChunk = false;
            UI.setBuffering(false);
            UI.startPosTimer();
            UI.updatePlayPauseIcons();
            UI.updateEQ();
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError' && gen === S.playGen) {
          console.warn('PCM pump error:', e.message);
        }
      }
    })();
  },

  /* ───────── gapless preload / splice ─────────
     Everything below is standalone-mode only. Lobby mode's equivalent
     lives server-side in server.py (LobbyRelay). */

  // Mirrors the exact same rule LobbyRelay._predict_next_track() and
  // _advance_for_gapless() use, so the track we preload is always the
  // track that will actually play next. Recomputed on every queue
  // mutation (add/remove/move/shuffle/clear) and loop-mode change.
  _computeNextTrack() {
    if (S.mode === 'server') return null;
    if (S.loopMode === 'track' && S.current) return S.current;
    if (S.queue.length > 0) return S.queue[0];
    if (S.loopMode === 'queue' && S.current) return S.current; // wraps to itself once the queue drains
    return this._nextAutoTrack();
  },

  // Shared by both the gapless splice and the (fallback) hard-cut path —
  // mutates queue/history/loop state exactly once for whatever track just
  // finished, and returns whatever should play next (or null if nothing
  // should). Keeping this as one function means the two paths can never
  // disagree about what "next" means.
  _advanceQueueState(finishedTrack, { skipTrackLoop = false } = {}) {
    // The `finishedTrack` guard matters: with repeat-one set but nothing
    // currently playing (first track of a session, or right after a stop),
    // there is nothing to repeat — falling through to the queue is what
    // _computeNextTrack predicts, and the two have to agree or the gapless
    // preload buffers a track that never plays. Lobby.advance_track() in
    // server.py carries the same guard for the same reason.
    if (S.loopMode === 'track' && finishedTrack && !skipTrackLoop) return finishedTrack;
    if (finishedTrack) {
      if (S.history.length > 80) S.history.shift();
      S.history.push(finishedTrack);
    }
    if (S.loopMode === 'queue' && finishedTrack) S.queue.push(finishedTrack);
    if (S.queue.length === 0) this._drainAutoQueue();
    if (S.queue.length > 0) return S.queue.shift();
    return null;
  },

  /* ───────── recommendations / autoplay (standalone) ─────────
     Lobby mode's equivalent lives server-side (populate_recommendations /
     Lobby.drain_auto_queue in server.py) so every client sees the same
     picks; this is the same algorithm run locally for standalone mode.

     Both are ports of the Discord bot's get_rekt(): when a track starts,
     ask the node for tracks like it, drop anything already played or
     queued, shuffle, and park the rest in a side pool. Autoplay drains
     that pool when the queue runs dry; Smart Shuffle empties it into the
     queue on demand. */

  _trackId(t) {
    if (!t) return null;
    return t.info?.identifier || t.encoded || null;
  },

  _selfRequester() {
    const name = (S.mode === 'server' && S.lobby.displayName)
      || localStorage.getItem('nl_display_name') || 'You';
    return { id: S.lobby.clientId || 'local', name };
  },

  _playedIds() { return new Set(S.history.map(t => this._trackId(t)).filter(Boolean)); },
  _queuedIds() {
    const ids = S.queue.map(t => this._trackId(t));
    ids.push(this._trackId(S.current));
    return new Set(ids.filter(Boolean));
  },

  // Non-mutating counterpart of _drainAutoQueue — _computeNextTrack needs
  // to know what autoplay WOULD pick without actually picking it.
  _nextAutoTrack() {
    if (S.autoplay !== 'enabled' || !S.autoQueue.length) return null;
    const played = this._playedIds(), queued = this._queuedIds();
    return S.autoQueue.find(t => {
      const id = this._trackId(t);
      return !played.has(id) && !queued.has(id);
    }) || null;
  },

  _drainAutoQueue() {
    if (S.autoplay !== 'enabled' || !S.autoQueue.length) return 0;
    const played = this._playedIds();
    const queued = this._queuedIds();
    let moved = 0;
    for (const t of S.autoQueue) {
      const id = this._trackId(t);
      if (id && (played.has(id) || queued.has(id))) continue;
      queued.add(id);
      S.queue.push(t);
      moved++;
    }
    S.autoQueue = [];
    S.autoQueueCount = 0;
    return moved;
  },

  // The identifier to hand loadtracks to get tracks like this one, or null
  // if the source has no recommendation support. Mirrors lava-lyra's
  // Node.get_recommendations(): YouTube uses its RD… radio playlist, the
  // rest use their plugin's *rec: search prefix.
  _recommendationQuery(track) {
    const info = track?.info || {};
    const source = (info.sourceName || '').toLowerCase().replace(/\s/g, '');
    const id = info.identifier;
    if (!id) return null;
    if (['youtube', 'youtubemusic', 'ytmusic', 'youtube_music'].includes(source)) {
      return `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
    }
    const prefix = { spotify: 'sprec', deezer: 'dzrec', tidal: 'tdrec', jiosaavn: 'jsrec' }[source];
    if (prefix) return `${prefix}:${id}`;
    // SoundCloud/Bandcamp/direct URLs have no recommendation API — searching
    // the artist keeps autoplay alive, just with looser picks.
    if (info.author) return `ytmsearch:${info.author}`;
    return null;
  },

  async _populateRecommendations(seedTrack) {
    if (S.mode === 'server') return 0;   // the server owns this in lobby mode
    if (S.autoplay === 'disabled' || S.recPending) return 0;
    const seed = seedTrack || S.current;
    const query = this._recommendationQuery(seed);
    if (!query) return 0;

    S.recPending = true;
    UI.updateQueueHeader();
    try {
      const data = await Backend.loadtracks(query);
      let tracks = [];
      if (data?.loadType === 'playlist') tracks = data.data?.tracks || [];
      else if (data?.loadType === 'search') tracks = data.data || [];
      else if (data?.loadType === 'track') tracks = data.data ? [data.data] : [];
      tracks = tracks.filter(t => t && t.encoded);

      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }

      const played = this._playedIds(), queued = this._queuedIds();
      const have = new Set(S.autoQueue.map(t => this._trackId(t)));
      let added = 0;
      for (const t of tracks) {
        if (S.autoQueue.length >= 60) break;
        const id = this._trackId(t);
        if (played.has(id) || queued.has(id) || have.has(id)) continue;
        have.add(id);
        t.requester = t.requester || { id: '__auto__', name: 'Autoplay' };
        S.autoQueue.push(t);
        added++;
      }
      S.autoQueueCount = S.autoQueue.length;
      this._ensurePreload();   // autoplay may have just gained a "next track"
      return added;
    } catch (e) {
      console.warn('recommendation fetch failed:', e.message);
      return 0;
    } finally {
      S.recPending = false;
      UI.updateQueueHeader();
    }
  },

  // Call after ANY change that could affect what plays next: queue add /
  // remove / move / shuffle / clear, loop-mode cycling, or a track
  // actually starting. Cheap no-op if the prediction hasn't changed.
  _ensurePreload() {
    if (S.mode === 'server') return;
    const next = this._computeNextTrack();
    const wantKey = next ? next.encoded + '|' + JSON.stringify(S.filters) : null;
    const haveKey = S.preload ? S.preload.track.encoded + '|' + JSON.stringify(S.preload.filters) : null;
    if (wantKey === haveKey) return;
    this._cancelPreload();
    if (!next) return;
    this._startPreload(next);
  },

  _cancelPreload() {
    if (S.preload) { try { S.preload.ctrl.abort(); } catch (_) {} S.preload = null; }
  },

  _startPreload(track) {
    const ctrl = new AbortController();
    const pre = { track, filters: { ...S.filters }, chunks: [], reader: null, done: false, error: null, ctrl };
    S.preload = pre;
    (async () => {
      try {
        const resp = await Backend.openStream(track.encoded, 0, pre.filters, ctrl.signal);
        if (S.preload !== pre) return; // superseded while we were connecting
        if (!resp.ok) { pre.error = `HTTP ${resp.status}`; pre.done = true; return; }
        pre.reader = resp.body.getReader();
        while (true) {
          if (S.preload !== pre) return;
          const { done, value } = await pre.reader.read();
          if (done) { pre.done = true; return; }
          if (S.preload !== pre) return;
          pre.chunks.push(value);
        }
      } catch (e) {
        if (e.name !== 'AbortError') { pre.error = e.message; pre.done = true; }
      }
    })();
  },

  // The current track's PCM stream has been fully received (network-side
  // — its audio may still be several seconds from actually finishing
  // playback, since PCMPlayer schedules ahead). If the predicted next
  // track is already preloading (or fully preloaded), splice it directly
  // onto the timeline now — the exact wall-clock moment doesn't matter
  // because PCMPlayer schedules by its own internal `nextTime`, not real
  // time, so this is still sample-accurate whenever it happens to run.
  // Otherwise fall back to the old behavior: wait for the audio to
  // actually finish, then hard-cut to the next track.
  _handleStreamExhausted(gen) {
    if (gen !== S.playGen) return;
    const next = this._computeNextTrack();
    const pre = S.preload;
    if (next && pre && pre.track.encoded === next.encoded && !pre.error
        && JSON.stringify(pre.filters) === JSON.stringify(S.filters)) {
      this._spliceGapless(pre);
    } else {
      S.player.scheduleEnd(() => { if (gen === S.playGen) this._onTrackEnd(); });
    }
  },

  _spliceGapless(pre) {
    const finished = S.current;
    const next = this._advanceQueueState(finished);

    // Safety net: if bookkeeping disagrees with what we preloaded
    // (shouldn't normally happen — _ensurePreload uses the same rule as
    // _advanceQueueState), don't play the wrong audio: fall back to a
    // fresh hard-cut instead.
    if (!next || next.encoded !== pre.track.encoded) {
      this._cancelPreload();
      if (next) this._localPlay(next, 0, S.filters);
      else {
        if (S.posTimer) { clearInterval(S.posTimer); S.posTimer = null; }
        S.current = null;
        UI.updatePlayerUI(); UI.renderQueue();
        toast('Queue finished', 'info', 2000);
      }
      return;
    }

    const gen = ++S.playGen;
    if (S.trackEndTimer) { clearTimeout(S.trackEndTimer); S.trackEndTimer = null; }

    S.current = next;
    S.lyrics = null; S.lyricsType = null; S._lyrLastIdx = -1;
    S.chapters = [];
    S.preload = null; // this track is live now, not "the preload" anymore
    S.player.markTrackBoundary(0);

    UI.updatePlayerUI();
    UI.renderQueue();
    UI.fetchChapters(next.encoded);
    UI.updatePlayPauseIcons();
    UI.updateEQ();

    // Feed whatever already arrived while it was preloading, in order —
    // this is what makes the transition instant instead of waiting on a
    // fresh network round trip.
    for (const chunk of pre.chunks) {
      if (gen !== S.playGen) return;
      S.player.feed(chunk);
    }

    if (pre.done) {
      this._handleStreamExhausted(gen);
    } else {
      (async () => {
        try {
          while (true) {
            if (gen !== S.playGen) return;
            const { done, value } = await pre.reader.read();
            if (done) break;
            if (gen !== S.playGen) return;
            S.player.feed(value);
          }
        } catch (e) {
          if (e.name !== 'AbortError') console.warn('gapless pump error:', e.message);
          return;
        }
        if (gen === S.playGen) this._handleStreamExhausted(gen);
      })();
    }

    this._ensurePreload(); // start prefetching whatever comes after THIS track
  },

  _onTrackEnd() {
    // Lobby (server) mode never reaches this — it doesn't run a local PCM
    // stream anymore (see _lobbySync below), so nothing calls _onTrackEnd
    // for it. Track-end there is detected server-side by the relay itself
    // and auto-advances the queue without any client's involvement.
    // Standalone mode only gets here when there was no usable preload to
    // splice in gaplessly (see _handleStreamExhausted) — e.g. the very
    // first track of a session, or a queue change too close to the end.
    const next = this._advanceQueueState(S.current);
    if (next) {
      this._localPlay(next, 0, S.filters);
    } else {
      if (S.posTimer) { clearInterval(S.posTimer); S.posTimer = null; }
      S.current = null;
      UI.updatePlayerUI(); UI.renderQueue();
      toast('Queue finished', 'info', 2000);
    }
  },

  _stopLocal() {
    S.playGen++;
    this._cancelPreload();
    if (S.fetchCtrl) { S.fetchCtrl.abort(); S.fetchCtrl = null; }
    if (S.trackEndTimer) { clearTimeout(S.trackEndTimer); S.trackEndTimer = null; }
    if (S.posTimer) { clearInterval(S.posTimer); S.posTimer = null; }
    if (S.player) { S.player.destroy(); S.player = null; }
    UI.setBuffering(false);
  },

  /* ───────── public API used by UI event handlers ───────── */

  async playTrack(track) {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change tracks', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'play', { clientId: S.lobby.clientId, track });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    S.current = track;
    await this._localPlay(track, 0, S.filters);
    toast(`▶  ${track.info.title}`, 'success', 2000);
  },

  async togglePause() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host controls playback', 'warn'); return; }
      if (!S.current) { toast('Queue is empty', 'warn'); return; }
      const action = (S.player && !S.player.isPaused) ? 'pause' : 'resume';
      try {
        const r = await LobbyAPI.control(S.lobby.code, action, { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (!S.current) {
      if (S.queue.length > 0) this.playTrack(S.queue.shift());
      else toast('Add tracks first', 'warn');
      return;
    }
    if (!S.player) return;
    if (S.player.isPaused) await S.player.resume(); else S.player.pause();
    UI.updatePlayPauseIcons(); UI.updateEQ();
  },

  async skip() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can skip', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'skip', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    // Route through the same advance rule the natural track end uses, so
    // "repeat all" still re-queues the skipped track and autoplay still
    // tops up an empty queue. skipTrackLoop: pressing next under "repeat
    // one" should move on rather than replay forever.
    const next = this._advanceQueueState(S.current, { skipTrackLoop: true });
    if (!next) { if (S.current) this.stop(); else toast('Queue is empty', 'warn'); return; }
    await this._localPlay(next, 0, S.filters);
  },

  async prev() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change tracks', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'prev', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
      } catch (e) { toast(e.message === 'no previous track' ? 'No previous track' : `Error: ${e.message}`, 'warn'); }
      return;
    }
    if (S.history.length === 0) { toast('No previous track', 'warn'); return; }
    if (S.current) S.queue.unshift(S.current);
    const prev = S.history.pop();
    await this._localPlay(prev, 0, S.filters);
  },

  async stop() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can stop playback', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'stop', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    this._stopLocal();
    S.current = null; S.queue = [];
    UI.updatePlayerUI(); UI.renderQueue();
  },

  async seekTo(posMs) {
    posMs = Math.max(0, posMs);
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can seek', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'seek', { clientId: S.lobby.clientId, positionMs: posMs });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (!S.current) return;
    await this._startPCMStream(S.current.encoded, posMs, S.filters);
    UI.startPosTimer();
    this._ensurePreload();
  },

  async addToQueue(track) {
    if (S.mode === 'server') {
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/add', { clientId: S.lobby.clientId, track });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    track.requester = track.requester || this._selfRequester();
    S.queue.push(track);
    if (!S.current) { const t = S.queue.shift(); this.playTrack(t); }
    else { UI.renderQueue(); toast(`+ ${track.info.title}`, 'success', 2000); this._ensurePreload(); }
  },

  // Bulk variant of addToQueue — used by "+ Add All" on a playlist result.
  // In lobby mode this fires ONE request (queue/add_bulk) instead of one
  // per track, letting the server do the current-track/queue split and
  // broadcast once. In standalone mode there's no network call either way
  // (it's all local state), so this just loops addToQueue for that case.
  async addAllToQueue(tracks) {
    if (!tracks || !tracks.length) return;
    if (S.mode === 'server') {
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/add_bulk', { clientId: S.lobby.clientId, tracks });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    for (const t of tracks) await this.addToQueue(t);
  },

  async removeFromQueue(i) {
    if (S.mode === 'server') {
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/remove', { clientId: S.lobby.clientId, index: i });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    S.queue.splice(i, 1); UI.renderQueue();
    this._ensurePreload();
  },

  // Moves the queue item at `from` to `to` — backs both the ↑/↓ buttons
  // (adjacent moves) and drag-and-drop reordering (arbitrary moves, i.e.
  // "swap tracks" by dropping one onto another's slot).
  async moveQueueItem(from, to) {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can reorder the queue', 'warn'); return; }
      if (from === to) return;
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/move', { clientId: S.lobby.clientId, fromIndex: from, toIndex: to });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (from === to || from < 0 || from >= S.queue.length || to < 0 || to >= S.queue.length) return;
    const [item] = S.queue.splice(from, 1);
    S.queue.splice(to, 0, item);
    UI.renderQueue();
    this._ensurePreload();
  },

  async shuffleQueue() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can shuffle the queue', 'warn'); return; }
      if (!S.queue.length) { toast('Queue is empty', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/shuffle', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
        toast('🔀 Queue shuffled', 'info', 1500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    for (let i = S.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
    }
    UI.renderQueue(); toast('🔀 Queue shuffled', 'info', 1500);
    this._ensurePreload();
  },

  // Smart Shuffle — pull recommendations based on what's playing into the
  // queue, then shuffle the whole thing so they interleave with what people
  // actually picked instead of piling up at the end. Same command the bot
  // exposes as `smart`.
  async smartShuffle(count = 20) {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can run Smart Shuffle', 'warn'); return; }
      if (!S.current) { toast('Play something first — recommendations come from the current track', 'warn'); return; }
      toast('Finding tracks like this one…', 'info', 2000);
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/smart', { clientId: S.lobby.clientId, count });
        Lobby.applyControlResult(r);
        toast(r.added ? `🔀 Smart Shuffle · +${r.added} tracks` : 'No new recommendations found', r.added ? 'success' : 'warn', 2500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }

    if (!S.current) { toast('Play something first — recommendations come from the current track', 'warn'); return; }
    if (S.autoQueue.length < count) {
      toast('Finding tracks like this one…', 'info', 2000);
      await this._populateRecommendations();
    }

    const played = this._playedIds(), queued = this._queuedIds();
    const added = [], leftover = [];
    for (const t of S.autoQueue) {
      const id = this._trackId(t);
      if (added.length < count && !played.has(id) && !queued.has(id)) { queued.add(id); added.push(t); }
      else leftover.push(t);
    }
    S.autoQueue = leftover;
    S.autoQueueCount = leftover.length;
    S.queue.push(...added);
    for (let i = S.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
    }
    UI.renderQueue();
    this._ensurePreload();
    toast(added.length ? `🔀 Smart Shuffle · +${added.length} tracks` : 'No new recommendations found',
          added.length ? 'success' : 'warn', 2500);
  },

  // Fair Queue — round-robin the queue between whoever added each track so
  // one person's 40-track playlist doesn't bury everyone else. The rotation
  // deliberately starts on someone OTHER than whoever's track is playing.
  async fairQueue() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can rebalance the queue', 'warn'); return; }
      if (!S.queue.length) { toast('Queue is empty', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/fair', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
        toast(r.changed ? '⚖️ Queue rebalanced' : 'Queue is already fair — only one person has tracks in it',
              r.changed ? 'success' : 'info', 2500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }

    // Standalone has a single requester by definition, so there's nothing to
    // alternate between. Say so plainly rather than pretending it did work.
    if (!S.queue.length) { toast('Queue is empty', 'warn'); return; }
    const keys = [...new Set(S.queue.map(t => t.requester?.id || '__unknown__'))];
    if (keys.length <= 1) { toast('Fair Queue needs tracks from more than one person — join a lobby to use it', 'info', 4000); return; }

    const byRequester = new Map();
    const order = [];
    for (const t of S.queue) {
      const k = t.requester?.id || '__unknown__';
      if (!byRequester.has(k)) { byRequester.set(k, []); order.push(k); }
      byRequester.get(k).push(t);
    }
    const currentKey = S.current?.requester?.id || '__unknown__';
    if (order.includes(currentKey)) { order.splice(order.indexOf(currentKey), 1); order.push(currentKey); }

    const out = [];
    const rounds = Math.max(...[...byRequester.values()].map(v => v.length));
    for (let r = 0; r < rounds; r++) {
      for (const k of order) {
        const list = byRequester.get(k);
        if (r < list.length) out.push(list[r]);
      }
    }
    S.queue = out;
    UI.renderQueue();
    this._ensurePreload();
    toast('⚖️ Queue rebalanced', 'success', 2000);
  },

  async clearQueue() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can clear the queue', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'queue/clear', { clientId: S.lobby.clientId });
        Lobby.applyControlResult(r);
        toast(`Queue cleared (${r.removed} removed)`, 'info', 1500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    S.queue = []; UI.renderQueue(); toast('Queue cleared', 'info', 1500);
    this._ensurePreload();
  },

  async cycleLoop() {
    const modes = ['none', 'track', 'queue'];
    const next = modes[(modes.indexOf(S.loopMode) + 1) % 3];

    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change loop mode', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'loop', { clientId: S.lobby.clientId, mode: next });
        Lobby.applyControlResult(r);   // loopMode comes back in the state, UI follows
        toast(`Loop: ${next.toUpperCase()}`, 'info', 1500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }

    S.loopMode = next;
    UI.updateLoopButton();
    toast(`Loop: ${next.toUpperCase()}`, 'info', 1500);
    this._ensurePreload();
  },

  // Autoplay: 'enabled' keeps the queue topped up with recommendations when
  // it runs dry, 'partial' still collects them (so Smart Shuffle works) but
  // never auto-queues, 'disabled' does neither.
  async cycleAutoplay() {
    const modes = ['enabled', 'partial', 'disabled'];
    const next = modes[(modes.indexOf(S.autoplay) + 1) % 3];

    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change autoplay', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'autoplay', { clientId: S.lobby.clientId, mode: next });
        Lobby.applyControlResult(r);
        toast(`Autoplay: ${next}`, 'info', 1500);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }

    S.autoplay = next;
    if (next === 'disabled') { S.autoQueue = []; S.autoQueueCount = 0; }
    else this._populateRecommendations();
    UI.updateQueueHeader();
    this._ensurePreload();
    toast(`Autoplay: ${next}`, 'info', 1500);
  },

  async applyFilters(filters) {
    S.filters = filters;
    UI.updateFilterStatus();
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change filters', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'filters', { clientId: S.lobby.clientId, filters });
        Lobby.applyControlResult(r);
      } catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (!S.current) {
      toast('Filters saved — will apply on next track', 'info');
      this._ensurePreload();
      return;
    }
    const pos = S.player ? S.player.getPositionMs() : 0;
    toast('Applying filters — re-streaming…', 'info');
    await this._startPCMStream(S.current.encoded, Math.round(pos), filters);
    UI.startPosTimer();
    // Filters apply queue-wide, so the preload (fetched with the OLD
    // filters) is now stale — restart it so the next gapless splice
    // actually sounds right instead of reverting mid-transition.
    this._ensurePreload();
  },

  /* ───────── called by Lobby.onState() to drive the shared <audio> element off server-authoritative state ─────────
     Lobby mode no longer runs a local PCM stream at all — the server
     transcodes the track to Opus/Ogg once and relays it to everyone, so
     the client here is just pointing an <audio> element at that relay
     and reflecting play/pause. There's no drift correction because
     there's nothing to drift: the server IS the single source of the
     actual audio bytes, not just a position number every client has to
     independently chase with its own PCM fetch.

     Gapless note: `trackChanged` and `genChanged` are tracked
     separately on purpose. A gapless server-side advance (current track
     ends naturally and LobbyRelay stitches the next one into the SAME
     Opus/Ogg session — see server.py) changes `currentTrack` WITHOUT
     bumping `relayGen`, so trackChanged fires (UI/chapters update) but
     genChanged doesn't (the <audio> element just keeps playing the same
     underlying stream, uninterrupted). The element only ever reconnects
     for a genuinely fresh encode session (explicit play/skip/seek/filter
     change). */
  async _lobbySync(state) {
    const audio = document.getElementById('lobby-audio');
    if (!S.player) S.player = new AudioElPlayer(audio);

    S.filters = state.filters || {};
    UI.updateFilterStatus();

    // Loop mode, autoplay and the recommendation pool are the SERVER's in
    // lobby mode — the host mutates them through the control endpoints and
    // every client just mirrors whatever comes back, so the loop button and
    // autoplay chip read the same on every screen in the room.
    S.loopMode = state.loopMode || 'none';
    S.autoplay = state.autoplay || 'enabled';
    S.autoQueueCount = state.autoQueueCount || 0;
    UI.updateLoopButton();
    UI.updateQueueHeader();

    const trackChanged = !S.current || !state.currentTrack || S.current.encoded !== state.currentTrack.encoded;
    const genChanged = S.lobby.relayGen !== state.relayGen;
    S.lobby.relayGen = state.relayGen;

    if (!state.currentTrack) {
      // Nothing queued right now — but the relay deliberately keeps this
      // SAME /live connection alive rather than tearing the session down
      // (it feeds silence frames instead; see the idle wait in server.py's
      // LobbyRelay._run). So don't touch audio.src here.
      //
      // Killing it used to be exactly what caused a queue's last track (or
      // a lobby's only track) to cut off abruptly a moment before it
      // actually finished: whatever audio the element still had sitting in
      // its own playback buffer got thrown away the instant this update
      // arrived, rather than being allowed to finish playing out. Leaving
      // the element alone lets that buffered tail play through, then it
      // just keeps quietly consuming silence until resume_or_start() (a
      // play, queue add, or "previous" on the server) hands it real audio
      // again — same connection, no reconnect either way.
      S.current = null;
      S.player.setAnchor(state.positionMs, true);  // freeze position reporting; don't touch audio.paused
      if (S.posTimer) { clearInterval(S.posTimer); S.posTimer = null; }
      UI.updatePlayerUI();
      return;
    }

    if (trackChanged) {
      S.lyrics = null; S.lyricsType = null; S._lyrLastIdx = -1;
      S.chapters = [];
      UI.fetchChapters(state.currentTrack.encoded);
    }
    S.current = state.currentTrack;

    if (genChanged) {
      // A fresh encode session started server-side (new track, seek, or
      // filter change) — old connection would only serve stale/ended
      // bytes, so point the element at a new one. This is the only time
      // lobby playback "reconnects"; pause/resume never do, and neither
      // does a gapless natural advance (see note above).
      UI.setBuffering(true);
      audio.src = LobbyAPI.liveUrl(S.lobby.code, state.relayGen);
      audio.load();
      const cleanup = () => { audio.removeEventListener('playing', onReady); audio.removeEventListener('error', onError); };
      const onReady = () => { UI.setBuffering(false); cleanup(); };
      const onError = () => { UI.setBuffering(false); cleanup(); toast('Playback stream error — will retry on the next update', 'warn', 4000); };
      audio.addEventListener('playing', onReady);
      audio.addEventListener('error', onError);
    }

    S.player.setAnchor(state.positionMs, state.paused);
    if (state.paused) S.player.pause();
    else { try { await S.player.resume(); } catch (_) {} }

    UI.updatePlayerUI();
    if (trackChanged) UI.renderQueue();
    UI.startPosTimer();
  },
};