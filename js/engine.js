'use strict';
/* ═══════════════════════════════════════════
   Engine — playback control.

   Standalone mode: public methods act directly on the local player.
   Server mode: public methods (for the host) send REST control calls to
   the lobby; the actual local audio is driven uniformly for EVERYONE
   (host included) by Lobby.onState() calling Engine._localSync(), so
   there is a single source of truth and no double-triggering.
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
      resp = await Backend.openStream(encodedTrack, positionMs, filters);
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
            if (gen === S.playGen) {
              S.player.scheduleEnd(() => { if (gen === S.playGen) Engine._onTrackEnd(); });
            }
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

  _onTrackEnd() {
    if (S.mode === 'server') {
      // Only the host's client reports track-end to the server, which
      // then advances the authoritative queue and broadcasts the new state.
      if (S.lobby.isHost) Lobby.reportTrackEnd();
      return;
    }
    // Standalone: handle locally
    if (S.loopMode === 'track' && S.current) { this._localPlay(S.current, 0, S.filters); return; }
    if (S.loopMode === 'queue' && S.current) S.queue.push(S.current);
    if (S.current) { if (S.history.length > 80) S.history.shift(); S.history.push(S.current); }
    if (S.queue.length > 0) {
      const next = S.queue.shift();
      S.history.push(S.current);
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
      try { await LobbyAPI.control(S.lobby.code, 'play', { clientId: S.lobby.clientId, track }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
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
      try { await LobbyAPI.control(S.lobby.code, action, { clientId: S.lobby.clientId }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
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
      try { await LobbyAPI.control(S.lobby.code, 'skip', { clientId: S.lobby.clientId }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
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
      try { await LobbyAPI.control(S.lobby.code, 'skip', { clientId: S.lobby.clientId }); } catch (_) {}
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
      try { await LobbyAPI.control(S.lobby.code, 'seek', { clientId: S.lobby.clientId, positionMs: posMs }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (!S.current) return;
    await this._startPCMStream(S.current.encoded, posMs, S.filters);
    UI.startPosTimer();
  },

  async addToQueue(track) {
    if (S.mode === 'server') {
      try { await LobbyAPI.control(S.lobby.code, 'queue/add', { clientId: S.lobby.clientId, track }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    S.queue.push(track);
    if (!S.current) { const t = S.queue.shift(); this.playTrack(t); }
    else { UI.renderQueue(); toast(`+ ${track.info.title}`, 'success', 2000); }
  },

  async removeFromQueue(i) {
    if (S.mode === 'server') {
      try { await LobbyAPI.control(S.lobby.code, 'queue/remove', { clientId: S.lobby.clientId, index: i }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    S.queue.splice(i, 1); UI.renderQueue();
  },

  async shuffleQueue() {
    if (S.mode === 'server') { toast('Shuffle is a standalone-only feature for now', 'warn'); return; }
    for (let i = S.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
    }
    UI.renderQueue(); toast('🔀 Queue shuffled', 'info', 1500);
  },

  async clearQueue() {
    if (S.mode === 'server') { toast('Clearing the shared queue isn\u2019t available yet — remove tracks individually', 'warn'); return; }
    S.queue = []; UI.renderQueue(); toast('Queue cleared', 'info', 1500);
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
  },

  async applyFilters(filters) {
    S.filters = filters;
    UI.updateFilterStatus();
    if (S.mode === 'server') {
      if (!S.lobby.isHost) { toast('Only the host can change filters', 'warn'); return; }
      try { await LobbyAPI.control(S.lobby.code, 'filters', { clientId: S.lobby.clientId, filters }); }
      catch (e) { toast(`Error: ${e.message}`, 'error'); }
      return;
    }
    if (!S.current) { toast('Filters saved — will apply on next track', 'info'); return; }
    const pos = S.player ? S.player.getPositionMs() : 0;
    toast('Applying filters — re-streaming…', 'info');
    await this._startPCMStream(S.current.encoded, Math.round(pos), filters);
    UI.startPosTimer();
  },

  /* ───────── called by Lobby.onState() to sync local audio to server-authoritative state ───────── */
  async _localSync(remoteTrack, remotePaused, remotePositionMs, remoteFilters) {
    const sameTrack = S.current && remoteTrack && S.current.encoded === remoteTrack.encoded;
    const filtersChanged = JSON.stringify(remoteFilters || {}) !== JSON.stringify(S.filters || {});
    S.filters = remoteFilters || {};
    UI.updateFilterStatus();

    if (!remoteTrack) {
      if (S.current) { this._stopLocal(); S.current = null; UI.updatePlayerUI(); }
      return;
    }

    if (!sameTrack) {
      S.current = remoteTrack;
      await this._localPlay(remoteTrack, remotePositionMs, S.filters);
      if (remotePaused && S.player) S.player.pause();
      UI.updatePlayPauseIcons(); UI.updateEQ();
      return;
    }

    if (filtersChanged) {
      await this._startPCMStream(remoteTrack.encoded, remotePositionMs, S.filters);
      UI.startPosTimer();
      if (remotePaused && S.player) S.player.pause();
      UI.updatePlayPauseIcons(); UI.updateEQ();
      return;
    }

    // Same track, same filters — reconcile pause state and drift
    if (S.player) {
      const localPaused = S.player.isPaused;
      if (remotePaused && !localPaused) S.player.pause();
      if (!remotePaused && localPaused) {
        await S.player.resume();
        // Re-anchor to remote position to correct any drift accumulated while paused
        const localMs = S.player.getPositionMs();
        if (Math.abs(localMs - remotePositionMs) > 1500) {
          await this._startPCMStream(remoteTrack.encoded, remotePositionMs, S.filters);
          UI.startPosTimer();
        }
      } else if (!remotePaused && !localPaused) {
        const localMs = S.player.getPositionMs();
        if (Math.abs(localMs - remotePositionMs) > 2500) {
          await this._startPCMStream(remoteTrack.encoded, remotePositionMs, S.filters);
          UI.startPosTimer();
        }
      }
    }
    UI.updatePlayPauseIcons(); UI.updateEQ();
  },
};
