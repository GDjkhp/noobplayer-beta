'use strict';
/* ═══════════════════════════════════════════
   Main — mode-select flow + global event wiring
═══════════════════════════════════════════ */
const Main = {
  enterApp() {
    showOverlay(null);
    document.getElementById('app').style.display = 'block';
    UI.updatePlayerUI();
    UI.renderQueue();
    UI.updateFilterStatus();
  },
};

document.addEventListener('DOMContentLoaded', () => {
  UI.setupProgressBar();

  /* ───────── Mode select screen ───────── */
  document.getElementById('pick-standalone').addEventListener('click', () => showOverlay('overlay-standalone'));
  document.getElementById('pick-server').addEventListener('click', () => showOverlay('overlay-server-setup'));

  /* ───────── Standalone connect ───────── */
  document.getElementById('sa-back').addEventListener('click', () => showOverlay('overlay-mode'));
  document.getElementById('sa-connect').addEventListener('click', () => Standalone.connect());
  ['sa-host','sa-pass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') Standalone.connect(); });
  });

  /* ───────── Server setup ───────── */
  document.getElementById('srv-back').addEventListener('click', () => showOverlay('overlay-mode'));
  document.querySelectorAll('input[name="srv"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('srv-url').style.display = (r.value === 'custom' && r.checked) ? 'block' : 'none';
    });
  });
  document.getElementById('srv-continue').addEventListener('click', () => {
    const mode = document.querySelector('input[name="srv"]:checked').value;
    if (mode === 'default') {
      Lobby.chooseDefaultServer();
    } else {
      const url = document.getElementById('srv-url').value.trim();
      if (!url) { toast('Enter a server URL', 'warn'); return; }
      Lobby.chooseCustomServer(url);
    }
    document.getElementById('lobby-select-sub').textContent = `Server: ${Backend.serverUrl}`;
    showOverlay('overlay-lobby-select');
    Lobby.refreshPublicList();
  });

  /* ───────── Lobby select (create / join / browse) ───────── */
  document.getElementById('lobby-select-back').addEventListener('click', () => showOverlay('overlay-server-setup'));
  document.querySelectorAll('.lobby-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.lobby-tab').forEach(t => t.classList.toggle('on', t === tab));
      document.querySelectorAll('.lobby-pane').forEach(p => p.classList.toggle('on', p.id === 'ltab-' + tab.dataset.ltab));
      if (tab.dataset.ltab === 'browse') Lobby.refreshPublicList();
    });
  });
  document.getElementById('join-go').addEventListener('click', () => {
    Lobby.join(document.getElementById('join-code').value, document.getElementById('join-name').value.trim());
  });
  document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('join-go').click(); });
  document.getElementById('create-go').addEventListener('click', () => {
    const isPublic = document.querySelector('input[name="vis"]:checked').value === 'public';
    Lobby.create(document.getElementById('create-lobby-name').value.trim(), isPublic, document.getElementById('create-name').value.trim());
  });

  /* ───────── App header (standalone) ───────── */
  document.getElementById('btn-disconnect-sa').addEventListener('click', () => Standalone.disconnect());

  /* ───────── App header (lobby) ───────── */
  document.getElementById('btn-copy-code').addEventListener('click', () => Lobby.copyCode());
  document.getElementById('btn-leave-lobby').addEventListener('click', () => Lobby.leave());
  document.getElementById('btn-mic').addEventListener('click', () => Lobby.toggleMic());

  /* ───────── Playback controls ───────── */
  document.getElementById('btn-play').addEventListener('click', () => Engine.togglePause());
  document.getElementById('btn-next').addEventListener('click', () => Engine.skip());
  document.getElementById('btn-prev').addEventListener('click', () => Engine.prev());
  document.getElementById('btn-stop').addEventListener('click', () => Engine.stop());
  document.getElementById('btn-b10').addEventListener('click', () => {
    if (S.player) Engine.seekTo(S.player.getPositionMs() - 10000);
  });
  document.getElementById('btn-f10').addEventListener('click', () => {
    if (S.player) Engine.seekTo(Math.min(S.current?.info.length || 0, S.player.getPositionMs() + 10000));
  });
  document.getElementById('loop-btn').addEventListener('click', () => Engine.cycleLoop());
  document.getElementById('btn-shuf').addEventListener('click', () => Engine.shuffleQueue());

  document.getElementById('btn-qshuf').addEventListener('click', () => Engine.shuffleQueue());
  document.getElementById('btn-qclr').addEventListener('click', () => {
    if (!S.queue.length) { toast('Queue is already empty', 'warn'); return; }
    Engine.clearQueue();
  });

  document.getElementById('vol-sl').addEventListener('input', function() {
    const v = this.value / 100;
    document.getElementById('vol-lbl').textContent = this.value + '%';
    if (S.player) S.player.setVolume(v);
  });

  /* ───────── Search ───────── */
  document.getElementById('btn-srch').addEventListener('click', () => UI.doSearch());
  document.getElementById('si').addEventListener('keydown', e => { if (e.key === 'Enter') UI.doSearch(); });

  /* ───────── Tabs ───────── */
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    UI.switchTab(b.dataset.tab);
    if (b.dataset.tab === 'chat') document.getElementById('chat-badge').textContent = '';
  }));

  /* ───────── Lyrics ───────── */
  document.getElementById('btn-lyr').addEventListener('click', () => UI.fetchLyrics());

  /* ───────── Filters ───────── */
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      UI.applyPreset(btn.dataset.preset);
      await Engine.applyFilters(PRESETS[btn.dataset.preset]);
      toast(`Filter: ${btn.dataset.preset}`, 'success', 1500);
    });
  });
  [['f-speed','f-speed-v'],['f-pitch','f-pitch-v'],['f-rate','f-rate-v'],
   ['f-edel','f-edel-v'],['f-efb','f-efb-v'],['f-emix','f-emix-v'],['f-rot','f-rot-v']]
    .forEach(([sid,lid]) => document.getElementById(sid).addEventListener('input', () => UI.syncSliderLabel(sid, lid)));
  document.getElementById('btn-apply-flt').addEventListener('click', () => Engine.applyFilters(UI.buildFiltersFromUI()));

  /* ───────── Chapters ───────── */
  document.getElementById('chaps-head').addEventListener('click', () => {
    const list = document.getElementById('chaps-list');
    const arr = document.getElementById('chap-arr');
    list.classList.toggle('open');
    arr.textContent = list.classList.contains('open') ? '▾' : '▸';
  });

  /* ───────── Meaning ───────── */
  document.getElementById('btn-meaning').addEventListener('click', () => UI.fetchMeaning());
  document.getElementById('meaning-close').addEventListener('click', () => document.getElementById('meaning-modal').classList.remove('show'));
  document.getElementById('meaning-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('meaning-modal')) document.getElementById('meaning-modal').classList.remove('show');
  });

  /* ───────── Chat ───────── */
  document.getElementById('chat-send').addEventListener('click', () => Lobby.sendChat());
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') Lobby.sendChat(); });

  /* ───────── Keyboard shortcuts ───────── */
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (document.getElementById('app').style.display === 'none') return;

    const posMs = () => S.player ? S.player.getPositionMs() : 0;
    switch (e.code) {
      case 'Space':      e.preventDefault(); Engine.togglePause(); break;
      case 'ArrowRight': e.shiftKey ? Engine.skip() : Engine.seekTo(posMs() + 5000); break;
      case 'ArrowLeft':  e.shiftKey ? Engine.prev() : Engine.seekTo(posMs() - 5000); break;
      case 'ArrowUp':    e.preventDefault(); { const sl=document.getElementById('vol-sl'); sl.value=Math.min(100,parseInt(sl.value)+5); sl.dispatchEvent(new Event('input')); } break;
      case 'ArrowDown':  e.preventDefault(); { const sl=document.getElementById('vol-sl'); sl.value=Math.max(0,parseInt(sl.value)-5); sl.dispatchEvent(new Event('input')); } break;
      case 'KeyL': Engine.cycleLoop(); break;
      case 'KeyS': Engine.shuffleQueue(); break;
      case 'KeyF': UI.switchTab('search'); document.getElementById('si').focus(); break;
      case 'KeyQ': UI.switchTab('queue'); break;
      case 'KeyY': UI.switchTab('lyrics'); break;
    }
  });

  showOverlay('overlay-mode');
});
