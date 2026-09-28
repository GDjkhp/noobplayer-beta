'use strict';
/* ═══════════════════════════════════════════
   Shared state — used by both standalone.js and lobby.js
═══════════════════════════════════════════ */
const S = {
  mode: null, // 'standalone' | 'server'

  // Track / queue
  current: null,
  queue: [],
  history: [],
  loopMode: 'none', // 'none' | 'track' | 'queue'
  // In lobby mode loopMode/autoplay/autoQueueCount are MIRRORS of the
  // server's authoritative values (see Lobby._applyState) — the host changes
  // them through the REST control endpoints and everyone's copy follows.
  // In standalone mode this client owns them outright.
  autoplay: 'enabled',   // 'enabled' | 'partial' | 'disabled'
  autoQueue: [],         // recommendation pool (standalone only — lobby keeps its own server-side)
  autoQueueCount: 0,     // size of that pool, whichever side owns it
  recPending: false,     // a recommendation fetch is in flight

  // Gapless preload/splice. In lobby mode this MIRRORS the server's
  // authoritative Lobby.gapless (see Engine._lobbySync) — the host
  // changes it through the same /gapless control endpoint as loop mode
  // and autoplay, same pattern as the block above. In standalone mode
  // this client owns it outright, persisted in localStorage under
  // 'nl_gapless' so the choice survives a reload. Defaults ON either
  // way — toggle off via the player's Gapless button (see
  // UI.updateGaplessButton / Engine.toggleGapless).
  gaplessEnabled: true,

  // Fair Queue is an ON/OFF state, default ON. While on, the lobby server
  // re-balances the queue between whoever added each track after every
  // queue operation (add, remove, move, shuffle…). Lobby mode only — this
  // MIRRORS Lobby.fair (see Engine._lobbySync); standalone has a single
  // requester, so there's nothing to alternate and it does nothing there.
  fairEnabled: true,

  // PCM engine
  player: null,
  fetchCtrl: null,
  playGen: 0,
  trackEndTimer: null,
  posTimer: null,

  // Gapless preload (standalone mode only — lobby mode preloads
  // server-side, see server.py's LobbyRelay). Holds whatever track is
  // predicted to play next based on the current queue/loop state, plus
  // however much of its PCM has already been fetched ahead of time.
  // Shape: { track, chunks:[Uint8Array], reader, done, error, ctrl }
  preload: null,

  // Lyrics
  // lyricsFetchedFor holds the encoded track lyrics were last fetched (or
  // attempted) for, so UI.updatePlayerUI can auto-trigger a fetch on every
  // track change without re-fetching on every unrelated re-render (queue
  // updates, lobby state syncs that didn't change the track, etc).
  lyrics: null, lyricsType: null, _lyrLastIdx: -1, lyricsFetchedFor: null,

  // UI
  searchResults: [], activeTab: 'config', progDrag: false,

  // Skins — look-and-feel customisation (see skins.js). `active` is the
  // skin currently painted onto the page, `mine` are the ones saved in this
  // browser's localStorage, `gallery` is the last fetched public list.
  skins: {
    active: null,
    activeId: null,
    draft: null,
    mine: [],
    gallery: [],
    gallerySort: 'new',
    editingId: null,
  },

  // Visualizer — user-written canvas visualizers (see visualizer.js).
  // `active` is what's mounted in the sandbox right now, `mine` are the
  // ones saved in this browser, `gallery` is the last fetched public list.
  viz: {
    active: null,
    draft: null,
    mine: [],
    gallery: [],
    gallerySort: 'new',
  },

  // Lobby (server mode only)
  lobby: {
    active: false,
    code: null,
    clientId: null,
    token: null,
    isHost: false,
    displayName: '',
    participants: [],
    socket: null,       // Socket.IO client
    // No `hls`/transport handle here anymore — the WebTransport session
    // and its audio scheduler both live inside S.player (a
    // WebTransportPlayer, see webtransport-player.js /
    // Lobby._connectMedia), destroyed the same way for every mode via
    // S.player.destroy().
    lastServerState: null,
    relayGen: 0,        // last-seen LobbyRelay generation — bumps on a hard cut (skip/seek); the relay's PCM stream itself keeps flowing across this, nothing client-side needs to react to it anymore
  },
};