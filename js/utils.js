'use strict';

function fmt(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`
    : `${m}:${String(s % 60).padStart(2,'0')}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'info', dur = 3500) {
  const cls = type === 'error' ? 'err' : type === 'success' ? 'ok' : type === 'warn' ? 'warn' : '';
  const icon = type === 'error' ? 'error' : type === 'success' ? 'check_circle' : type === 'warn' ? 'warning' : 'info';
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.innerHTML = `<span class="material-symbols-outlined toast-ico">${icon}</span><span class="toast-msg">${esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), dur);
}

function uid() {
  return 'xxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// Navigates to a URL that responds with Content-Disposition: attachment —
// the browser treats that as a download rather than a page load, so a
// plain synthetic-click-on-an-<a> is all that's needed (no fetch/blob
// juggling required).
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ═══════════════════════════════════════════
   MediaKeepAlive — registers the page as a "media player" with the
   browser/OS by mirroring the app's play/pause state onto a silent
   <audio> element.

   The app plays through Web Audio (AudioContext), which browsers don't
   treat as real media playback — with no media element, the Media Session
   (and headphone / media-key routing) doesn't exist at all. So a silent
   looping clip stands in for the real audio:
     - app playing  → element playing  → OS shows "playing", the hardware
                                         key sends `pause`
     - app paused   → element PAUSED   → the session stays alive (like a
                                         paused YouTube tab) and the
                                         hardware key sends `play`
   It must mirror the state rather than keep playing while paused: the
   browser picks play-vs-pause for the key from the ELEMENT's state, so a
   still-playing element made every key press arrive as `pause`.
═══════════════════════════════════════════ */
const MediaKeepAlive = {
  el: null,

  _build() {
    // 30s of 16-bit mono 8 kHz near-silence (±1 LSB dither, so it isn't
    // pure digital zero) as a WAV, generated in place — no asset to ship.
    // Long enough that browsers don't ignore it as a too-short clip.
    const sr = 8000, n = sr * 30, bytes = new Uint8Array(44 + n * 2);
    const dv = new DataView(bytes.buffer);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, (Math.random() < 0.5 ? -1 : 1), true);
    const el = document.createElement('audio');
    el.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    el.loop = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  },

  // loaded  = a track is loaded (playing OR paused) — keeps the session.
  // playing = the app is actually playing right now. Idempotent.
  sync(loaded, playing) {
    if (!loaded) {
      if (this.el && !this.el.paused) this.el.pause();
      return;
    }
    if (!this.el) this.el = this._build();
    if (playing) {
      if (this.el.paused) this.el.play().catch(() => { /* needs a user gesture first — retried on the next sync */ });
    } else if (!this.el.paused) {
      this.el.pause();
    }
  },
};