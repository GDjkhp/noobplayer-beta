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
    es: null,          // EventSource
    pc: null,           // RTCPeerConnection
    micStream: null,
    micEnabled: false,
    lastServerState: null,
  },
};
