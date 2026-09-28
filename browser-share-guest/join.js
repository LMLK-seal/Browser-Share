'use strict';

/* Browser Share — Guest page
 * Joins a Host's room over PeerJS and renders what they share:
 *   bookmarks_update / tabs_update / live_info over a DataConnection,
 *   the live tab as a MediaConnection stream.
 * When the Host allows it, mouse / keyboard input is sent back as `control` messages.
 */

const PEER_PREFIX = 'bshare-';
const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);

/* ---------- tiny DOM helpers (no innerHTML: shared data is never parsed as HTML) ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function icon(id, cls) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.setAttribute('viewBox', '0 0 24 24');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
}
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- theme ---------- */
document.querySelectorAll('.themeBtn').forEach(btn => btn.addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('bshare-theme', next); } catch (e) { }
}));

/* ---------- state ---------- */
let peer = null, dc = null, mediaCall = null;
let currentCode = '';
let attempt = 0;               // invalidates callbacks of older connection attempts
let leaving = false;
let everConnected = false;
let retries = 0;
let connectTimer = null, retryTimer = null, pingTimer = null;

let caps = { bookmarks: false, tabs: false, live: false, control: false };
let tabs = null;               // null = not received yet
let bookmarks = null;
let live = { active: false, tabId: null, title: '', url: '' };
let hasStream = false;
let controlOn = false;
let userPickedPane = false;
let currentPane = 'live';

/* ============================================================ JOIN VIEW ============================================================ */
const keys = [...document.querySelectorAll('#keys input')];
const keysBox = $('keys');

const clean = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const getCode = () => keys.map(k => k.value).join('');

function setJoinStatus(text, kind) {
  const el = $('joinStatus');
  el.textContent = text || '';
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}

function fillKeys(code) {
  const chars = clean(code).slice(0, 6);
  keys.forEach((k, i) => { k.value = chars[i] || ''; k.classList.toggle('filled', !!k.value); });
  return chars.length;
}

keys.forEach((input, i) => {
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    const c = clean(input.value).slice(-1);
    input.value = c;
    input.classList.toggle('filled', !!c);
    keysBox.classList.remove('invalid');
    if (c && i < keys.length - 1) keys[i + 1].focus();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !input.value && i > 0) { e.preventDefault(); keys[i - 1].value = ''; keys[i - 1].classList.remove('filled'); keys[i - 1].focus(); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); keys[i - 1].focus(); }
    else if (e.key === 'ArrowRight' && i < keys.length - 1) { e.preventDefault(); keys[i + 1].focus(); }
  });
  input.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    // accept a whole invite link as well as a bare code
    let code = text;
    try { const u = new URL(text.trim()); code = u.searchParams.get('room') || text; } catch (err) { }
    const n = fillKeys(code);
    keys[Math.min(n, 5)].focus();
  });
});

$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = getCode();
  if (code.length !== 6) {
    keysBox.classList.remove('invalid'); void keysBox.offsetWidth; keysBox.classList.add('invalid');
    setJoinStatus('Enter all 6 characters of the code.', 'error');
    (keys.find(k => !k.value) || keys[0]).focus();
    return;
  }
  retries = 0; everConnected = false; leaving = false;
  connect(code, 'fresh');
});

/* ============================================================ CONNECTION ============================================================ */
function teardownPeer() {
  clearTimeout(connectTimer); clearInterval(pingTimer);
  const p = peer, d = dc, m = mediaCall;
  peer = dc = mediaCall = null;
  try { m && m.close(); } catch (e) { }
  try { d && d.close(); } catch (e) { }
  try { p && p.destroy(); } catch (e) { }
}

function setConn(state, text) {
  $('conn').dataset.state = state;
  $('connText').textContent = text;
}

function connect(code, mode) {
  teardownPeer();
  clearTimeout(retryTimer);
  currentCode = code;
  const mine = ++attempt;

  if (mode === 'fresh') {
    setJoinStatus('Connecting to room ' + code + '…', 'busy');
    $('joinBtn').disabled = true;
  }

  const fail = msg => {
    if (mine !== attempt) return;
    teardownPeer();
    if (mode === 'retry' && retries < 5 && !leaving) {
      retries++;
      setConn('reconnecting', 'Reconnecting…');
      retryTimer = setTimeout(() => connect(code, 'retry'), 1500 + retries * 1000);
      return;
    }
    exitSession(msg);
  };

  connectTimer = setTimeout(() => fail('Could not reach that room. Check the code, and make sure your friend is still sharing.'), 20000);

  const p = new Peer({ debug: 0 });
  peer = p;

  p.on('open', () => {
    if (mine !== attempt) return;
    const conn = p.connect(PEER_PREFIX + code, { reliable: true });
    dc = conn;

    conn.on('open', () => {
      if (mine !== attempt) return;
      clearTimeout(connectTimer);
      everConnected = true; retries = 0;
      showSession(code);
      setConn('connected', 'Connected');
      conn.send({ type: 'ready' });
      startPing();
    });
    conn.on('data', data => { if (mine === attempt) onHostMessage(data); });
    conn.on('close', () => {
      if (mine !== attempt || leaving) return;
      if (everConnected) { mode = 'retry'; fail('Lost the connection to your friend.'); }
      else fail('Could not reach that room. Check the code and try again.');
    });
    conn.on('error', () => { if (mine === attempt && !everConnected) fail('Could not connect to that room. Try again.'); });
  });

  // the live tab arrives as an incoming call
  p.on('call', call => {
    if (mine !== attempt) return;
    mediaCall = call;
    call.answer();
    call.on('stream', attachStream);
    call.on('close', detachStream);
  });

  p.on('error', err => {
    if (mine !== attempt) return;
    if (err.type === 'peer-unavailable') return fail('No room with that code. Check it and try again. The room closes when your friend stops sharing.');
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      if (!everConnected) return fail('Could not reach the connection server. Check your internet connection and try again.');
      return;   // already connected peer-to-peer: keep going
    }
    if (!everConnected) fail('Something went wrong (' + err.type + '). Try again.');
  });
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (dc && dc.open) try { dc.send({ type: 'ping', t: performance.now() }); } catch (e) { }
  }, 3000);
}

function exitSession(message) {
  leaving = true;
  clearTimeout(retryTimer);
  teardownPeer();
  setControl(false, true);
  detachStream();
  tabs = null; bookmarks = null;
  caps = { bookmarks: false, tabs: false, live: false, control: false };
  live = { active: false, tabId: null, title: '', url: '' };
  userPickedPane = false;
  $('viewSession').hidden = true;
  $('viewJoin').hidden = false;
  $('joinBtn').disabled = false;
  setJoinStatus(message || '', message ? 'error' : '');
  try { history.replaceState(null, '', location.pathname); } catch (e) { }
  keys[0].focus();
}

$('leaveBtn').addEventListener('click', () => exitSession(''));

function showSession(code) {
  $('roomCode').textContent = code;
  $('viewJoin').hidden = true;
  $('viewSession').hidden = false;
  $('joinBtn').disabled = false;
  setJoinStatus('');
  window.scrollTo(0, 0);
  renderAll();
}

/* ============================================================ HOST MESSAGES ============================================================ */
function onHostMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'hello':
    case 'caps': {
      const first = m.type === 'hello';
      caps = { bookmarks: !!(m.caps && m.caps.bookmarks), tabs: !!(m.caps && m.caps.tabs), live: !!(m.caps && m.caps.live), control: !!(m.caps && m.caps.control) };
      if (first && !userPickedPane) showPane(caps.live ? 'live' : caps.tabs ? 'tabs' : caps.bookmarks ? 'bookmarks' : 'live');
      if (!caps.live) detachStream();
      if (!(caps.control && caps.live) && controlOn) setControl(false, true);
      renderAll();
      break;
    }
    case 'bookmarks_update': bookmarks = Array.isArray(m.payload) ? m.payload : []; renderBookmarks(); break;
    case 'tabs_update': tabs = Array.isArray(m.payload) ? m.payload : []; renderTabs(); updateAddress(); break;
    case 'live_info': live = { active: !!m.active, tabId: m.tabId, title: m.title || '', url: m.url || '' }; updateAddress(); updateStage(); renderTabs(); break;
    case 'control_status':
      if (m.error) { toast(m.error); setControl(false, true); }
      else if (m.active === false && controlOn) {
        if (m.reason === 'canceled_by_user') toast('Your friend closed control from Chrome.');
        else if (m.reason === 'disabled') toast('Your friend turned off remote control.');
        if (m.reason === 'canceled_by_user' || m.reason === 'disabled') setControl(false, true);
      }
      break;
    case 'pong': {
      const rtt = Math.round(performance.now() - m.t);
      setConn(rtt > 350 ? 'slow' : 'connected', 'Connected (' + rtt + ' ms)');
      break;
    }
    case 'bye': exitSession('Your friend stopped sharing.'); break;
  }
}

function renderAll() {
  const setOff = (id, off) => { $(id).dataset.off = off ? 'true' : 'false'; };
  setOff('tabLive', !caps.live); setOff('tabTabs', !caps.tabs); setOff('tabBookmarks', !caps.bookmarks);
  $('controlBtn').disabled = !(caps.control && caps.live && hasStream);
  updateNavButtons();
  updateStage();
  updateAddress();
  renderTabs();
  renderBookmarks();
}

/* ============================================================ PANES ============================================================ */
function showPane(name, byUser) {
  if (byUser) userPickedPane = true;
  currentPane = name;
  document.querySelectorAll('.paneNav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pane === name)));
  $('paneLive').hidden = name !== 'live';
  $('paneTabs').hidden = name !== 'tabs';
  $('paneBookmarks').hidden = name !== 'bookmarks';
}
document.querySelectorAll('.paneNav button').forEach(b => b.addEventListener('click', () => showPane(b.dataset.pane, true)));

/* ============================================================ LIVE VIEW ============================================================ */
const video = $('video');
const stage = $('stage');

/* ---------- sound ---------- */
let wantMuted = false;
try { wantMuted = localStorage.getItem('bshare-muted') === '1'; } catch (e) { }
let hasAudio = false;
let unlockArmed = false;

function paintSound() {
  const btn = $('soundBtn');
  btn.hidden = !hasAudio;
  const off = video.muted;
  $('soundUse').setAttribute('href', off ? '#i-mute' : '#i-sound');
  btn.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
  btn.title = off ? 'Unmute' : 'Mute';
}
function armUnlock() {
  // Browsers may refuse to start sound before the page has been interacted with. Unmute on the first click/key.
  if (unlockArmed) return;
  unlockArmed = true;
  const go = e => {
    document.removeEventListener('pointerdown', go, true);
    document.removeEventListener('keydown', go, true);
    unlockArmed = false;
    if (e && e.target && e.target.closest && e.target.closest('#soundBtn')) return;   // the button toggles it itself
    if (!wantMuted && hasStream) { video.muted = false; video.play().catch(() => {}); paintSound(); }
  };
  document.addEventListener('pointerdown', go, true);
  document.addEventListener('keydown', go, true);
}
function startPlayback() {
  video.muted = wantMuted;
  video.play().then(paintSound).catch(() => {
    // autoplay with sound was blocked: start silent, then unmute on first interaction
    video.muted = true;
    video.play().catch(() => {});
    paintSound();
    if (hasAudio && !wantMuted) { toast('Click anywhere to turn on sound.'); armUnlock(); }
  });
}
$('soundBtn').addEventListener('click', () => {
  video.muted = !video.muted;
  wantMuted = video.muted;
  try { localStorage.setItem('bshare-muted', wantMuted ? '1' : '0'); } catch (e) { }
  if (!video.muted) video.play().catch(() => {});
  paintSound();
});

function attachStream(stream) {
  hasStream = true;
  hasAudio = stream.getAudioTracks().length > 0;
  video.srcObject = stream;
  video.dataset.live = 'true';
  startPlayback();
  if (!userPickedPane) showPane('live');
  renderAllLight();
}
function detachStream() {
  hasStream = false;
  hasAudio = false;
  paintSound();
  video.srcObject = null;
  delete video.dataset.live;
  $('stageMeta').hidden = true;
  if (controlOn) setControl(false, true);
  renderAllLight();
}
function renderAllLight() {
  $('controlBtn').disabled = !(caps.control && caps.live && hasStream);
  updateStage(); updateAddress(); updateNavButtons();
}
video.addEventListener('loadedmetadata', showMeta);
video.addEventListener('resize', showMeta);
function showMeta() {
  if (!video.videoWidth) return;
  const m = $('stageMeta');
  m.textContent = video.videoWidth + ' × ' + video.videoHeight;
  m.hidden = false;
}

function updateStage() {
  const empty = $('stageEmpty');
  empty.hidden = hasStream;
  if (hasStream) return;
  if (!caps.live) {
    $('emptyTitle').textContent = 'No live tab right now';
    $('emptyText').textContent = 'Your friend hasn\'t turned on live tab view. You can still look through their tabs and bookmarks.';
  } else {
    $('emptyTitle').textContent = 'Connecting to their tab…';
    $('emptyText').textContent = 'The video should appear in a few seconds.';
  }
}

function prettyUrl(url) {
  try { const u = new URL(url); return u.host + (u.pathname === '/' ? '' : u.pathname) + u.search; }
  catch (e) { return url || ''; }
}

function updateAddress() {
  const liveTab = live.active && tabs ? tabs.find(t => t.id === live.tabId) : null;
  const url = (liveTab && liveTab.url) || live.url;
  const title = (liveTab && liveTab.title) || live.title;
  const on = live.active && hasStream;
  $('addressText').textContent = on ? (prettyUrl(url) || title || 'Shared tab') : 'Nothing shared yet';
  $('address').title = on ? [title, url].filter(Boolean).join('\n') : '';
  $('liveChip').hidden = !on;
}

/* ---------- remote control ---------- */
function send(msg) { try { if (dc && dc.open) dc.send(msg); } catch (e) { } }
const sendControl = event => send({ type: 'control', event });

function updateNavButtons() {
  ['navBack', 'navForward', 'navReload'].forEach(id => { $(id).disabled = !controlOn; });
}

function setControl(on, silent) {
  if (on && !(caps.control && caps.live && hasStream)) { toast('Your friend hasn\'t allowed control.'); return; }
  if (controlOn === on) return;
  controlOn = on;
  const btn = $('controlBtn');
  btn.setAttribute('aria-pressed', String(on));
  $('controlLabel').textContent = on ? 'Release control' : 'Take control';
  stage.classList.toggle('controlling', on);
  updateNavButtons();
  const hint = $('stageHint');
  clearTimeout(hint._t);
  hint.hidden = !on;
  if (on) {
    showPane('live', true);
    stage.focus({ preventScroll: true });
    hint._t = setTimeout(() => { hint.hidden = true; }, 5000);
  } else if (!silent) {
    sendControl({ kind: 'release' });
  }
  renderTabs(); renderBookmarks();
}

$('controlBtn').addEventListener('click', () => setControl(!controlOn));
$('navBack').addEventListener('click', () => sendControl({ kind: 'nav', action: 'back' }));
$('navForward').addEventListener('click', () => sendControl({ kind: 'nav', action: 'forward' }));
$('navReload').addEventListener('click', () => sendControl({ kind: 'nav', action: 'reload' }));
$('fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => toast('Full screen is not available here.'));
});

function videoRect() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !r.width || !r.height) return null;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, hh = vh * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hh) / 2, width: w, height: hh };
}
function point(e, clampIt) {
  const r = videoRect();
  if (!r) return null;
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!inside && !clampIt) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

let moveRaf = 0, lastMove = null;
stage.addEventListener('mousemove', e => {
  if (!controlOn) return;
  const p = point(e);
  if (!p) return;
  lastMove = { ...p, buttons: e.buttons, mods: mods(e) };
  if (!moveRaf) moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    if (lastMove) sendControl({ kind: 'mouse', action: 'move', ...lastMove });
  });
});

let dragging = false;
stage.addEventListener('mousedown', e => {
  if (!controlOn) return;
  const p = point(e);
  if (!p) return;
  e.preventDefault();
  stage.focus({ preventScroll: true });
  dragging = true;
  sendControl({ kind: 'mouse', action: 'down', ...p, button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
});
window.addEventListener('mouseup', e => {
  if (!controlOn || !dragging) return;
  dragging = false;
  const p = point(e, true);
  if (p) sendControl({ kind: 'mouse', action: 'up', ...p, button: e.button, buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
});
stage.addEventListener('contextmenu', e => { if (controlOn) e.preventDefault(); });

let wheelAcc = null, wheelRaf = 0;
stage.addEventListener('wheel', e => {
  if (!controlOn) return;
  const p = point(e);
  if (!p) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  if (!wheelAcc) wheelAcc = { dx: 0, dy: 0 };
  wheelAcc.dx += e.deltaX * k; wheelAcc.dy += e.deltaY * k; wheelAcc.p = p; wheelAcc.mods = mods(e);
  if (!wheelRaf) wheelRaf = requestAnimationFrame(() => {
    wheelRaf = 0;
    const w = wheelAcc; wheelAcc = null;
    if (w) sendControl({ kind: 'mouse', action: 'wheel', ...w.p, dx: w.dx, dy: w.dy, mods: w.mods });
  });
}, { passive: false });

stage.addEventListener('keydown', e => {
  if (!controlOn || e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;      // handled by the paste event
  e.preventDefault();
  sendControl({ kind: 'key', action: 'down', key: e.key, code: e.code, keyCode: e.keyCode, mods: mods(e) });
});
stage.addEventListener('keyup', e => {
  if (!controlOn || e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
  e.preventDefault();
  sendControl({ kind: 'key', action: 'up', key: e.key, code: e.code, keyCode: e.keyCode, mods: mods(e) });
});
document.addEventListener('paste', e => {
  if (!controlOn || document.activeElement !== stage) return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (text) { e.preventDefault(); sendControl({ kind: 'text', text }); }
});

// touch: one finger drags to scroll, a quick tap clicks
let touch = null;
stage.addEventListener('touchstart', e => {
  if (!controlOn || e.touches.length !== 1) { touch = null; return; }
  const t = e.touches[0];
  touch = { sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, t0: Date.now(), moved: false };
}, { passive: true });
stage.addEventListener('touchmove', e => {
  if (!controlOn || !touch || e.touches.length !== 1) return;
  const t = e.touches[0];
  if (Math.hypot(t.clientX - touch.sx, t.clientY - touch.sy) > 8) touch.moved = true;
  if (!touch.moved) return;
  e.preventDefault();
  const p = point({ clientX: t.clientX, clientY: t.clientY });
  if (p) sendControl({ kind: 'mouse', action: 'wheel', ...p, dx: touch.lx - t.clientX, dy: touch.ly - t.clientY, mods: 0 });
  touch.lx = t.clientX; touch.ly = t.clientY;
}, { passive: false });
stage.addEventListener('touchend', () => {
  if (!controlOn || !touch) return;
  if (!touch.moved && Date.now() - touch.t0 < 500) {
    const p = point({ clientX: touch.sx, clientY: touch.sy });
    if (p) {
      sendControl({ kind: 'mouse', action: 'move', ...p, buttons: 0, mods: 0 });
      sendControl({ kind: 'mouse', action: 'down', ...p, button: 0, buttons: 1, clicks: 1, mods: 0 });
      sendControl({ kind: 'mouse', action: 'up', ...p, button: 0, buttons: 0, clicks: 1, mods: 0 });
    }
  }
  touch = null;
});

/* ============================================================ SHARED RENDER PIECES ============================================================ */
function hueOf(s) { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) % 360; return n; }

function favicon(url, favIconUrl) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { }
  const wrap = h('span', { class: 'fav' });
  wrap.style.setProperty('--h', hueOf(host || 'x'));
  wrap.textContent = (host.replace(/^www\./, '')[0] || '•');
  const src = favIconUrl || (host ? 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host) : '');
  if (src) {
    const img = new Image();
    img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.onload = () => { wrap.textContent = ''; wrap.append(img); };
    img.src = src;
  }
  return wrap;
}

function emptyState(iconId, title, text) {
  return h('div', { class: 'empty' }, icon(iconId), h('h3', null, title), h('p', null, text));
}

function openOnHostButton(url) {
  if (!(controlOn && /^https?:\/\//i.test(url))) return null;
  return h('button', {
    class: 'iconBtn onHost', type: 'button', title: 'Open on your friend\'s shared tab', 'aria-label': 'Open on your friend\'s shared tab',
    onclick: () => { sendControl({ kind: 'nav', action: 'url', url }); toast('Sent to your friend\'s shared tab'); showPane('live', true); }
  }, icon('i-send'));
}

function linkRow({ url, title, sub, favIconUrl, badges }) {
  const web = /^https?:\/\//i.test(url || '');
  const text = h('span', { class: 'itemText' }, h('span', { class: 'itemTitle' }, title || url || 'Untitled'), h('span', { class: 'itemSub' }, sub || prettyUrl(url)));
  const main = web
    ? h('a', { class: 'itemMain', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open in a new tab on your device' }, favicon(url, favIconUrl), text)
    : h('div', { class: 'itemMain plain', title: 'Internal browser page (cannot be opened from here)' }, favicon(url, favIconUrl), text);
  return h('div', { class: 'item' }, main, badges && badges.length ? h('span', { class: 'badges' }, badges) : null, openOnHostButton(url));
}

/* ============================================================ TABS ============================================================ */
$('tabsSearch').addEventListener('input', () => renderTabs());

function renderTabs() {
  const list = $('tabsList');
  list.replaceChildren();
  $('countTabs').textContent = caps.tabs && tabs && tabs.length ? String(tabs.length) : '';
  if (!caps.tabs) { list.append(emptyState('i-tabs', 'Tabs aren\'t shared', 'Your friend has turned off open-tab sharing.')); return; }
  if (!tabs) { list.append(emptyState('i-tabs', 'Loading tabs…', 'Their list will appear in a moment.')); return; }

  const q = $('tabsSearch').value.trim().toLowerCase();
  const shown = tabs.filter(t => !q || (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q));
  if (!shown.length) { list.append(emptyState('i-search', q ? 'No tabs match' : 'No open tabs', q ? 'Try a different word.' : 'Your friend has no tabs open.')); return; }

  const byWindow = new Map();
  shown.forEach(t => { if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []); byWindow.get(t.windowId).push(t); });
  const multi = byWindow.size > 1;
  let n = 0;
  for (const group of byWindow.values()) {
    n++;
    group.sort((a, b) => a.index - b.index);
    if (multi) list.append(h('div', { class: 'groupHead' }, 'Window ' + n + ' (' + group.length + (group.length === 1 ? ' tab)' : ' tabs)')));
    group.forEach(t => {
      const badges = [];
      if (live.active && live.tabId === t.id) badges.push(h('span', { class: 'badge live' }, 'Shown live'));
      else if (t.active) badges.push(h('span', { class: 'badge' }, 'Current'));
      if (t.pinned) badges.push(h('span', { class: 'mini', title: 'Pinned' }, icon('i-pin')));
      if (t.audible) badges.push(h('span', { class: 'mini', title: 'Playing sound' }, icon('i-sound')));
      list.append(linkRow({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, badges }));
    });
  }
}

/* ============================================================ BOOKMARKS ============================================================ */
$('bmSearch').addEventListener('input', () => renderBookmarks());
$('bmExpand').addEventListener('click', () => {
  const list = $('bmList');
  for (let i = 0; i < 60; i++) {
    const closed = [...list.querySelectorAll('details:not([open])')];
    if (!closed.length) break;
    closed.forEach(d => { d.open = true; if (d._ensure) d._ensure(); });
  }
});
$('bmCollapse').addEventListener('click', () => $('bmList').querySelectorAll('details').forEach(d => { d.open = false; }));

function countLeaves(node) {
  if (node.url) return 1;
  let n = 0;
  for (const c of node.children || []) n += countLeaves(c);
  return n;
}

function bookmarkRoots() {
  if (!bookmarks || !bookmarks.length) return [];
  const root = bookmarks[0];
  return !root.url && root.children && bookmarks.length === 1 && !root.title ? root.children : bookmarks;
}

function collectLeaves(node, path, out, q) {
  if (node.url) {
    if (!q || (node.title || '').toLowerCase().includes(q) || node.url.toLowerCase().includes(q)) out.push({ node, path });
    return;
  }
  const next = node.title ? path.concat(node.title) : path;
  for (const c of node.children || []) collectLeaves(c, next, out, q);
}

function folderEl(node, openNow) {
  const total = countLeaves(node);
  const kids = h('div', { class: 'kids' });
  const summary = h('summary', null,
    icon('i-chevron', 'chev'), h('span', { class: 'folder' }, icon('i-folder')),
    h('span', { class: 'fname' }, node.title || 'Untitled folder'), h('span', { class: 'fcount' }, String(total)));
  const d = h('details', null, summary, kids);
  let built = false;
  d._ensure = () => {
    if (built) return;
    built = true;
    const children = node.children || [];
    if (!children.length) kids.append(h('div', { class: 'empty-folder' }, 'This folder is empty.'));
    for (const c of children) {
      kids.append(c.url
        ? linkRow({ url: c.url, title: c.title })
        : folderEl(c, false));
    }
  };
  d.addEventListener('toggle', () => { if (d.open) d._ensure(); });
  if (openNow) { d.open = true; d._ensure(); }
  return d;
}

const BM_SEARCH_LIMIT = 300;

function renderBookmarks() {
  const list = $('bmList');
  list.replaceChildren();
  const roots = bookmarkRoots();
  const total = roots.reduce((n, r) => n + countLeaves(r), 0);
  $('countBookmarks').textContent = caps.bookmarks && bookmarks && total ? String(total) : '';
  $('bmTools').hidden = !(caps.bookmarks && bookmarks && total);
  if (!caps.bookmarks) { list.append(emptyState('i-bookmark', 'Bookmarks aren\'t shared', 'Your friend has turned off bookmark sharing.')); return; }
  if (!bookmarks) { list.append(emptyState('i-bookmark', 'Loading bookmarks…', 'Their bookmarks will appear in a moment.')); return; }
  if (!total) { list.append(emptyState('i-bookmark', 'No bookmarks', 'Your friend has no saved bookmarks.')); return; }

  const q = $('bmSearch').value.trim().toLowerCase();
  if (q) {
    const hits = [];
    roots.forEach(r => collectLeaves(r, [], hits, q));
    $('bmTools').hidden = true;
    if (!hits.length) { list.append(emptyState('i-search', 'No bookmarks match', 'Try a different word.')); return; }
    hits.slice(0, BM_SEARCH_LIMIT).forEach(({ node, path }) =>
      list.append(linkRow({ url: node.url, title: node.title, sub: path.join(' / ') || prettyUrl(node.url) })));
    if (hits.length > BM_SEARCH_LIMIT) list.append(h('div', { class: 'more' }, 'Showing the first ' + BM_SEARCH_LIMIT + ' of ' + hits.length + ' matches. Type more to narrow it down.'));
    return;
  }

  roots.forEach(r => { if (r.children && r.children.length) list.append(folderEl(r, true)); });
}

/* ============================================================ BOOT ============================================================ */
(function boot() {
  let code = '';
  try {
    const p = new URLSearchParams(location.search);
    code = p.get('room') || (location.hash.startsWith('#') ? location.hash.slice(1) : '');
  } catch (e) { }
  const n = fillKeys(code);
  if (n === 6) { connect(getCode(), 'fresh'); return; }
  (keys[Math.min(n, 5)]).focus();
})();
