'use strict';
/* ═══════════════════════════════════════════
   About tab — fetches README.md and renders it as markdown, so editing
   only the README changes what this tab shows. Parser: marked, output
   sanitised with DOMPurify (both from the CDN, see index.html). If either
   failed to load, the raw README text is shown instead.
═══════════════════════════════════════════ */
const About = {
  _loaded: false,

  async render(force) {
    const el = document.getElementById('about-body');
    if (!el || (this._loaded && !force)) return;
    try {
      const r = await fetch('README.md', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const md = await r.text();
      if (window.marked && window.DOMPurify) {
        el.innerHTML = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false }));
        // Open README links in a new tab so they don't navigate away from the player.
        el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      } else {
        el.innerHTML = '<pre class="md-raw"></pre>';
        el.firstChild.textContent = md;
      }
      this._loaded = true;
    } catch (e) {
      el.innerHTML = '<div class="empty"><p>Could not load README.md: ' + esc(e.message) + '</p></div>';
    }
  },
};
