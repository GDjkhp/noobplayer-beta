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
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'err' : type === 'success' ? 'ok' : type === 'warn' ? 'warn' : ''}`;
  el.textContent = msg;
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