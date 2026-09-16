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
  // Shape: { track, filters, chunks:[Uint8Array], reader, done, error, ctrl }
  preload: null,

  // Filters
  filters: {},
  activePreset: 'normal',

  // Lyrics
  lyrics: null, lyricsType: null, _lyrLastIdx: -1,

  // Chapters
  chapters: [],

  // UI
  searchResults: [], activeTab: 'search', progDrag: false,

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
    pc: null,           // RTCPeerConnection
    micStream: null,
    micEnabled: false,
    lastServerState: null,
    relayGen: 0,        // last-seen LobbyRelay generation — bump means the server started a fresh Opus/Ogg session
  },
};