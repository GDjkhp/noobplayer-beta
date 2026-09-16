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
    return null;
  },

  // Shared by both the gapless splice and the (fallback) hard-cut path —
  // mutates queue/history/loop state exactly once for whatever track just
  // finished, and returns whatever should play next (or null if nothing
  // should). Keeping this as one function means the two paths can never
  // disagree about what "next" means.
  _advanceQueueState(finishedTrack) {
    if (S.loopMode === 'track') return finishedTrack;
    if (finishedTrack) {
      if (S.history.length > 80) S.history.shift();
      S.history.push(finishedTrack);
    }
    if (S.loopMode === 'queue' && finishedTrack) S.queue.push(finishedTrack);
    if (S.queue.length > 0) return S.queue.shift();
    return null;
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
    if (S.queue.length === 0) { if (S.current) this.stop(); else toast('Queue is empty', 'warn'); return; }
    if (S.current) S.history.push(S.current);
    const next = S.queue.shift();
    await this._localPlay(next, 0, S.filters);
  },

  async prev() {
    if (S.mode === 'server') { toast('Previous track is not available in lobby mode', 'warn'); return; }
    if (S.history.length === 0) { toast('No previous track', 'warn'); return; }
    if (S.current) S.queue.unshift(S.current);
    const prev = S.history.pop();
    await this._localPlay(prev, 0, S.filters);
  },

  async stop() {
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can stop playback', 'warn'); return; }
      try {
        const r = await LobbyAPI.control(S.lobby.code, 'skip', { clientId: S.lobby.clientId });
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
    S.queue.push(track);
    if (!S.current) { const t = S.queue.shift(); this.playTrack(t); }
    else { UI.renderQueue(); toast(`+ ${track.info.title}`, 'success', 2000); this._ensurePreload(); }
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
    if (S.mode === 'server') { toast('Shuffle is a standalone-only feature for now', 'warn'); return; }
    for (let i = S.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
    }
    UI.renderQueue(); toast('🔀 Queue shuffled', 'info', 1500);
    this._ensurePreload();
  },

  async clearQueue() {
    if (S.mode === 'server') { toast('Clearing the shared queue isn\u2019t available yet — remove tracks individually', 'warn'); return; }
    S.queue = []; UI.renderQueue(); toast('Queue cleared', 'info', 1500);
    this._ensurePreload();
  },

  cycleLoop() {
    if (S.mode === 'server') { toast('Loop mode is a standalone-only feature for now', 'warn'); return; }
    const modes = ['none', 'track', 'queue'], lbls = ['OFF', '🔂 ONE', '🔁 ALL'];
    const i = modes.indexOf(S.loopMode);
    S.loopMode = modes[(i + 1) % 3];
    const btn = document.getElementById('loop-btn');
    btn.textContent = lbls[(i + 1) % 3];
    btn.classList.toggle('on', S.loopMode !== 'none');
    toast(`Loop: ${S.loopMode.toUpperCase()}`, 'info', 1500);
    this._ensurePreload();
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

    const trackChanged = !S.current || !state.currentTrack || S.current.encoded !== state.currentTrack.encoded;
    const genChanged = S.lobby.relayGen !== state.relayGen;
    S.lobby.relayGen = state.relayGen;

    if (!state.currentTrack) {
      S.current = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
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