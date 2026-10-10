'use strict';
/* ═══════════════════════════════════════════
   Sessions + Heal

   Sessions — the "Saved Sessions" card. A snapshot of a lobby (code, name,
   settings, queue, history, smart pool, current track + position) lives in localStorage,
   one per lobby code; saving again with the same code overwrites it. Lobbies
   with no current track, queue, history or smart pool are never saved. The host's
   browser autosaves when:
     • the server goes away (Heal.begin),
     • the host leaves the lobby as its last member,
     • the host closes / navigates away from the page.

   Heal — the infinite reconnect loop. It runs when the server dies or a
   saved session is loaded, and never gives up on its own (only Cancel,
   a deliberate leave, or an error that can't be fixed by retrying ends it):
     heal mode: POST /rejoin (same identity). If the lobby is gone and this
                client was the host, POST /restore from the snapshot.
                Guests keep retrying until the host brings the lobby back.
     load mode: leave the current lobby, then POST /restore until it works.
═══════════════════════════════════════════ */
const Sessions = {
  KEY: 'nl_sessions',
  MAX: 20,

  /* ───────── storage (localStorage can throw or be full) ───────── */
  _read() {
    try {
      const v = JSON.parse(localStorage.getItem(this.KEY) || '{}');
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (_) { return {}; }
  },
  _write(all) {
    // Trim to the newest MAX entries, then retry once with fewer if the quota is hit.
    let entries = Object.values(all).sort((a, b) => b.savedAt - a.savedAt).slice(0, this.MAX);
    for (let tries = 0; tries < 6; tries++) {
      const out = {};
      entries.forEach(e => { out[e.code] = e; });
      try { localStorage.setItem(this.KEY, JSON.stringify(out)); return true; }
      catch (_) { entries = entries.slice(0, Math.max(1, Math.floor(entries.length / 2))); }
    }
    return false;
  },

  list() { return Object.values(this._read()).sort((a, b) => b.savedAt - a.savedAt); },
  get(code) { return this._read()[code] || null; },

  remove(code) {
    const all = this._read();
    delete all[code];
    this._write(all);
    this.render();
  },

  /* ───────── snapshot ───────── */
  snapshot(reason) {
    if (S.mode !== 'server' || !S.lobby.active || !S.lobby.code) return null;
    const st = S.lobby.lastServerState;
    if (!st) return null;
    let pos = Number(st.positionMs) || 0;
    if (st.currentTrack && !st.paused && S.lobby.lastStateAt) pos += Date.now() - S.lobby.lastStateAt;
    return {
      code: S.lobby.code,
      name: st.name || 'Untitled Lobby',
      isPublic: !!st.isPublic,
      // The password lives only in the host's own browser; restore needs it to protect the rebuilt lobby.
      password: S.lobby.isHost ? (S.lobby.password || '') : '',
      hasPassword: !!st.hasPassword,
      displayName: S.lobby.displayName || localStorage.getItem('nl_display_name') || 'Guest',
      loopMode: st.loopMode,
      autoplay: st.autoplay,
      gapless: st.gapless,
      fair: st.fair,
      currentTrack: st.currentTrack || null,
      positionMs: Math.max(0, Math.round(pos)),
      queue: st.queue || [],
      // History contents are host-synced from the server (Lobby._syncHistory).
      history: S.lobby.history || [],
      smart: S.lobby.smart || [],
      // Server-side counts, so emptiness checks work before history has synced.
      historyCount: Number(st.historyCount) || 0,
      autoQueueCount: Number(st.autoQueueCount) || 0,
      savedAt: Date.now(),
      reason: reason || 'manual',
    };
  },

  // A lobby with no current track, queue, history or smart pool has nothing
  // worth restoring — never persist it.
  _isEmpty(snap) {
    if (!snap) return true;
    return !snap.currentTrack
      && !(snap.queue && snap.queue.length)
      && !(snap.history && snap.history.length)
      && !snap.historyCount
      && !(snap.smart && snap.smart.length)
      && !snap.autoQueueCount;
  },

  _store(snap) {
    if (!snap || this._isEmpty(snap)) return false;
    const all = this._read();
    all[snap.code] = snap;            // same code → overwritten
    const ok = this._write(all);
    this.render();
    return ok;
  },

  // Manual save (button). Host only: guests don't own the lobby's state.
  save() {
    if (!(S.mode === 'server' && S.lobby.active)) { toast('Join a lobby first', 'warn'); return; }
    if (!S.lobby.isHost) { toast('Only the host can save the session', 'warn'); return; }
    const snap = this.snapshot('manual');
    if (!snap || this._isEmpty(snap)) { toast('Nothing to save yet', 'warn'); return; }
    const ok = this._store(snap);
    if (ok) toast(`Saved session ${snap.code}`, 'success', 2200);
    else toast("Couldn't save — browser storage is full or blocked", 'error');
  },

  autosave(reason) {
    try {
      if (S.mode === 'server' && S.lobby.active && S.lobby.isHost) this._store(this.snapshot(reason));
    } catch (_) {}
  },

  // Host leaving (or closing the page) while nobody else is in the lobby.
  autosaveIfLastHost(reason) {
    try {
      if (!(S.mode === 'server' && S.lobby.active && S.lobby.isHost)) return;
      if ((S.lobby.participants || []).length > 1) return;
      this._store(this.snapshot(reason));
    } catch (_) {}
  },

  // True when the host is closing a lobby that has something worth restoring
  // (used by main.js's 'beforeunload' confirmation).
  shouldConfirmClose() {
    try {
      if (!(S.mode === 'server' && S.lobby.active && S.lobby.isHost)) return false;
      return !this._isEmpty(this.snapshot('page-closed'));
    } catch (_) { return false; }
  },

  load(code) {
    const snap = this.get(code);
    if (!snap) { toast('That saved session is gone', 'warn'); this.render(); return; }
    if (S.mode === 'server' && S.lobby.active && S.lobby.code === code) {
      toast("That lobby is already running — you're in it", 'info', 2500); return;
    }
    Heal.load(snap);
  },

  /* ───────── card UI ───────── */
  _reasonText: { manual: 'saved by you', 'server-down': 'server went down', 'host-left': 'host left',
                 'page-closed': 'page closed' },

  render() {
    const el = document.getElementById('sessions-list');
    const saveBtn = document.getElementById('sessions-save');
    if (saveBtn) saveBtn.disabled = !(S.mode === 'server' && S.lobby.active && S.lobby.isHost);
    if (!el) return;
    const items = this.list();
    if (!items.length) { el.innerHTML = `<div class="cu-empty">No saved sessions yet</div>`; return; }
    el.innerHTML = items.map(s => {
      const t = s.currentTrack;
      const title = t && (t.info?.title || t.title) ? (t.info?.title || t.title) : null;
      const n = (s.queue || []).length;
      const meta = [title ? esc(title) : 'nothing playing', `${n} queued`,
                    new Date(s.savedAt).toLocaleString(), this._reasonText[s.reason] || ''].filter(Boolean).join(' · ');
      return `<div class="ss-item" data-code="${esc(s.code)}">
        <div class="ss-info">
          <span class="ss-name">${esc(s.name)} <span class="cu-tag">${esc(s.code)}</span>${s.hasPassword || s.password ? ' <span class="material-symbols-outlined pl-lock" title="Password protected">lock</span>' : ''}</span>
          <span class="ss-meta">${meta}</span>
        </div>
        <button class="qa ss-load">Load</button>
        <button class="qa ss-del" title="Delete">✕</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.ss-item').forEach(row => {
      const code = row.dataset.code;
      row.querySelector('.ss-load').addEventListener('click', () => this.load(code));
      row.querySelector('.ss-del').addEventListener('click', () => this.remove(code));
    });
  },
};

const Heal = {
  active: false,
  mode: null,            // 'heal' | 'load'
  _run: 0,               // bumps on every begin/stop so stale loops exit
  _busy: false,
  _snap: null,
  _wasHost: false,
  _attempt: 0,

  /* ───────── banner ───────── */
  _banner(text) {
    let el = document.getElementById('heal-banner');
    if (!el) return;
    el.style.display = text ? 'flex' : 'none';
    const msg = document.getElementById('heal-msg');
    if (msg && text) msg.textContent = text;
  },

  /* ───────── server died / audio died / lobby vanished ───────── */
  begin(reason) {
    if (this.active) return;
    if (!(S.mode === 'server' && S.lobby.active)) return;
    this.active = true; this.mode = 'heal';
    this._wasHost = !!S.lobby.isHost;
    this._attempt = 0;
    // Host's browser holds the only copy of the lobby once the server is gone.
    this._snap = null;
    if (this._wasHost) {
      Sessions.autosave('server-down');
      this._snap = Sessions.snapshot('server-down');
    }
    this._banner(`Reconnecting — ${reason}…`);
    this._loop(++this._run);
  },

  // A 'state' push arrived: the server is talking to us again.
  noteAlive() {
    if (!this.active || this.mode !== 'heal' || this._busy) return;
    if (S.player && S.player.connected) this.stop(true);   // otherwise the loop rebuilds the audio
  },

  stop(recovered) {
    const was = this.active;
    this.active = false; this.mode = null; this._busy = false; this._snap = null;
    this._run++;
    this._banner('');
    if (was && recovered) toast('Reconnected', 'success', 2000);
  },

  // Banner "Cancel" button.
  async cancel() {
    const mode = this.mode;
    this.stop(false);
    if (mode === 'heal') {
      await Lobby.leave({ noAutosave: true });                 // already saved at begin()
    } else if (mode === 'load' && !S.lobby.active) {
      await Lobby.leave({ noAutosave: true });                 // fall back to a fresh default lobby
    }
  },

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); },
  _backoff() {
    const base = Math.min(800 * Math.pow(1.5, this._attempt), 8000);
    return base + Math.random() * 400;
  },
  _retryable(e) {
    if (e && e.nonRetryable) return false;
    return !(e && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 408 && e.status !== 429 && e.status !== 409);
  },

  /* ───────── heal loop ───────── */
  async _loop(run) {
    await this._delay(900);   // give socket.io's own reconnect a moment first
    while (this.active && this._run === run) {
      this._busy = true;
      try {
        const name = S.lobby.displayName || localStorage.getItem('nl_display_name') || 'Guest';
        let r;
        try {
          r = await LobbyAPI.rejoin(S.lobby.code, S.lobby.clientId, name, S.lobby.password);
        } catch (e) {
          const gone = e.status === 404 || e.reason === 'not_found';
          if (!(gone && this._wasHost && this._snap)) throw e;
          this._banner('Server is back — restoring your lobby…');
          try {
            r = await LobbyAPI.restore(this._snap, S.lobby.clientId, name, false);
          } catch (e2) {
            if (e2.reason !== 'code_in_use') throw e2;
            r = await LobbyAPI.restore(this._snap, S.lobby.clientId, name, true);
          }
        }
        if (this._run !== run) return;
        await Lobby._resume(r);
        if (this._run !== run) return;
        this._busy = false;
        this.stop(false);
        toast(r.restored ? `Lobby restored${r.codeChanged ? ` as ${r.code} (your old code was taken)` : ''} — paused where it left off`
                         : 'Reconnected', 'success', 3500);
        return;
      } catch (e) {
        this._busy = false;
        if (this._run !== run) return;
        if (e && e.nonRetryable) {
          toast(`Couldn't reconnect: ${e.message}`, 'error', 6000);
          this.stop(false);
          return;
        }
        if (e && e.reason === 'banned') {
          toast('You are banned from this lobby', 'error', 6000);
          this.cancel(); return;
        }
        if (e && (e.reason === 'password_required' || e.reason === 'wrong_password')) {
          // The lobby came back (or was rebuilt) with a password we don't have.
          const pw = prompt(`Lobby ${S.lobby.code} needs a password to reconnect:`);
          if (pw) { S.lobby.password = pw; continue; }
          toast('Reconnect cancelled — no password given', 'warn', 4000);
          this.cancel(); return;
        }
        this._attempt++;
        const waiting = (e.status === 404 || e.reason === 'not_found') && !this._wasHost;
        this._banner(waiting ? 'Waiting for the host to bring the lobby back…'
                             : `Reconnecting… (attempt ${this._attempt + 1})`);
      }
      await this._delay(this._backoff());
    }
  },

  /* ───────── load a saved session ───────── */
  async load(snap) {
    if (this.active) this.stop(false);
    if (S.mode === 'standalone') { toast('Disconnect standalone mode first', 'warn'); return; }
    this.active = true; this.mode = 'load'; this._attempt = 0;
    const run = ++this._run;
    this._banner(`Loading ${snap.code}…`);

    const name = localStorage.getItem('nl_display_name') || snap.displayName || 'Guest';
    try {
      if (S.mode === 'server' && S.lobby.active) await Lobby.leave({ autoRejoin: false });
    } catch (_) {}
    if (this._run !== run) return;

    const clientId = (crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(16).slice(2).padEnd(32, '0')))
      .replace(/-/g, '').slice(0, 32);
    let allowNew = false;

    while (this.active && this._run === run) {
      try {
        const r = await LobbyAPI.restore(snap, clientId, name, allowNew);
        if (this._run !== run) return;
        Lobby._enterLobby(r.code, r.clientId, r.token, true, name, r.state, snap.password || '');
        this.stop(false);
        toast(r.codeChanged ? `Loaded as ${r.code} (${snap.code} was in use)` : `Loaded session ${r.code} — paused where it left off`,
              'success', 3500);
        return;
      } catch (e) {
        if (this._run !== run) return;
        if (e.reason === 'code_in_use' && !allowNew) {
          if (confirm(`Lobby code ${snap.code} is running right now. Load this session under a new code instead?`)) {
            allowNew = true; continue;
          }
          this.cancel(); return;
        }
        if (!this._retryable(e) || e.reason === 'bad_snapshot') {
          toast(`Couldn't load session: ${e.message}`, 'error', 6000);
          this.cancel(); return;
        }
        this._attempt++;
        this._banner(`Waiting for the server… (attempt ${this._attempt})`);
      }
      await this._delay(this._backoff());
    }
  },
};