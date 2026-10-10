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

/* ═══════════════════════════════════════════
   Marquee — any single-line text that doesn't fit its box scrolls instead of
   being cut off with "…". Track titles/artists, queue and search rows, lobby
   and session names, debug cards/tables, key bindings and so on.

   How it works: elements matching SELECTORS keep their normal CSS clipping.
   When their content is wider than the box, the content is moved into a
   single <span class="mq-in"> and the element gets `.mq`; style.css slides
   that span with `transform: translateX()` (compositor-only, so the
   animation never causes layout). The distance / duration / phase are custom
   properties on the element.

   Why a wrapper instead of animating text-indent: text-indent is a LAYOUT
   property, so every animation frame re-laid-out the text, and the
   measurements below (which decide whether the element overflows at all)
   could change under the animation's feet — it would flip between "overflows"
   and "fits", dropping/re-adding `.mq` and restarting the animation, which
   looked like fast back-and-forth flickering. A transform never changes the
   measured width, so the decision is stable.

   Many render functions rewrite innerHTML/textContent, which throws the
   wrapper away; the next scan (same frame, via the MutationObserver) puts it
   back. The animation phase is derived from the global clock, so a re-wrapped
   element lands exactly where it was instead of restarting from the left.

   Re-measures (debounced) whenever the DOM changes, the window resizes, or a
   tab is shown, plus a slow timer for anything that only becomes visible later.
   Users with prefers-reduced-motion keep the ellipsis (see style.css).
═══════════════════════════════════════════ */
const Marquee = {
  SELECTORS: [
    '#info-title', '#info-artist',                    // now playing
    '.si-t', '.si-a',                                 // search results
    '.qi-t', '.qi-a',                                 // queue
    '.pl-np',                                         // public lobby list: now playing
    '.cu-name', '.dj-name',                           // participants / Disc Jockey
    '.ss-name', '.ss-meta',                           // saved sessions
    '.viz-active-name',                               // visualizer name
    '.bnd-btn', '#vk-preview',                        // key bindings, virtual keyboard
    '.dbg-card-v', '.dbg-table td.dbg-mono',          // debug tab cards + tables
    '.dbg-list-row > span:not(.dbg-mono)',            // debug tab lists (smart queue, history, events)
    '[data-marquee]',                                 // opt-in for anything else
  ].join(','),

  _raf: 0,
  _range: null,
  _reduce: null,

  init() {
    if (this._started) return;
    this._started = true;
    this._range = document.createRange();
    this._reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const schedule = () => this.schedule();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('click', () => setTimeout(schedule, 60), true);   // tab switches reveal panes
    document.addEventListener('visibilitychange', schedule);
    if (this._reduce.addEventListener) this._reduce.addEventListener('change', schedule);
    setInterval(() => { if (!document.hidden) schedule(); }, 1500);
    schedule();
  },

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.scan(); });
  },

  _inner(el) { return el.querySelector(':scope > .mq-in'); },

  _wrap(el) {
    const span = document.createElement('span');
    span.className = 'mq-in';
    while (el.firstChild) span.appendChild(el.firstChild);
    el.appendChild(span);
  },

  _unwrap(el) {
    const span = this._inner(el);
    if (!span) return;
    while (span.firstChild) el.insertBefore(span.firstChild, span);
    span.remove();
  },

  scan() {
    const reduce = this._reduce && this._reduce.matches;
    const els = document.querySelectorAll(this.SELECTORS);
    const reads = [];
    // Read everything first, then write, so we cause one layout, not hundreds.
    for (const el of els) {
      const box = el.clientWidth;
      if (!box) { reads.push([el, null]); continue; }   // hidden / not laid out — leave as-is
      const cs = getComputedStyle(el);
      const avail = box - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      this._range.selectNodeContents(el);
      const w = this._range.getBoundingClientRect().width;   // same with or without the wrapper; unaffected by the transform
      reads.push([el, w - avail]);
    }
    const now = performance.now() / 1000;
    for (const [el, over] of reads) {
      if (over === null) continue;
      const inner = this._inner(el);
      // Enter above 1px of overflow; once running, stay until it truly fits.
      const want = !reduce && (over > 1 || (inner && over > 0));
      if (want) {
        const dist = Math.ceil(over) + 2;
        const changed = !el._mq || Math.abs(el._mq - dist) > 1;
        if (changed) {
          el._mq = dist;
          el._mqT = Math.max(4, dist / 28 + 2.5);
          el.style.setProperty('--mq-d', dist + 'px');
          el.style.setProperty('--mq-t', el._mqT.toFixed(2) + 's');
        }
        if (changed || !inner) {
          // Phase comes from the global clock (a full back-and-forth is 2×duration), so a
          // freshly (re)created wrapper picks up exactly where the last one was.
          el.style.setProperty('--mq-dl', '-' + (now % (2 * el._mqT)).toFixed(3) + 's');
        }
        if (!inner) this._wrap(el);
        if (!el.classList.contains('mq')) el.classList.add('mq');
      } else if (inner || el._mq || el.classList.contains('mq')) {
        el._mq = 0; el._mqT = 0;
        this._unwrap(el);
        el.classList.remove('mq');
        el.style.removeProperty('--mq-d');
        el.style.removeProperty('--mq-t');
        el.style.removeProperty('--mq-dl');
      }
    }
  },
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Marquee.init());
else Marquee.init();