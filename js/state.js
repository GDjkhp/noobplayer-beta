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
  loopMode: 'none', // 'none' | 'track' | 'queue'  (standalone only — lobby loop is host-driven client-side too)

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