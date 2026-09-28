'use strict';

const $ = id => document.getElementById(id);
const send = (type, extra) => chrome.runtime.sendMessage({ target: 'background', type, ...extra });

let state = null;
let busy = false;

/* ---------- toast ---------- */
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- rendering ---------- */
const AVATAR_COLORS = ['#3D3DFF', '#FF5B4A', '#12A46B', '#B45CFF', '#E8920C'];

function renderTiles(code) {
  const wrap = $('tiles');
  if (wrap.dataset.code === code) return;
  wrap.dataset.code = code;
  wrap.replaceChildren();
  [...(code || '')].forEach((ch, i) => {
    if (i === 3) { const g = document.createElement('span'); g.className = 'gap'; wrap.append(g); }
    const t = document.createElement('div');
    t.className = 'tile';
    t.textContent = ch;
    wrap.append(t);
  });
}

function render() {
  if (!state) return;
  const st = state.status;
  const sharing = st === 'waiting' || st === 'connected';
  document.body.classList.toggle('sharing', sharing);

  // status pill
  const pill = $('pill');
  pill.dataset.state = st === 'starting' ? 'waiting' : st;
  $('pillText').textContent =
    st === 'connected' ? `${state.viewers} watching` :
    st === 'waiting' ? 'Waiting for a friend' :
    st === 'starting' ? 'Starting…' :
    st === 'error' ? 'Problem' : 'Not sharing';

  // which main view
  $('viewIdle').hidden = st !== 'idle';
  $('viewStarting').hidden = st !== 'starting';
  $('viewError').hidden = st !== 'error';
  $('viewSharing').hidden = !sharing;
  $('stopWrap').hidden = !sharing;
  if (st === 'error') $('errorText').textContent = state.error || 'Something went wrong. Try again.';

  if (sharing) {
    renderTiles(state.code);

    // viewers
    const n = state.viewers;
    const av = $('avatars');
    av.replaceChildren();
    for (let i = 0; i < Math.min(n, 4); i++) {
      const s = document.createElement('span');
      s.style.background = AVATAR_COLORS[i % AVATAR_COLORS.length];
      s.textContent = String(i + 1);
      av.append(s);
    }
    const vt = $('viewersText');
    vt.replaceChildren();
    if (n === 0) vt.textContent = 'Waiting for your friend to join';
    else { const b = document.createElement('b'); b.textContent = String(n); vt.append(b, n === 1 ? ' person is watching' : ' people are watching'); }

    // live card
    const live = state.live && state.live.active;
    $('liveCard').hidden = !live;
    if (live) {
      $('liveTitle').textContent = state.live.title || 'Sharing a tab';
      $('liveUrl').textContent = state.live.url || '';
    }
  }

  // toggles
  const s = state.share || {};
  $('tgBookmarks').checked = !!s.bookmarks;
  $('tgTabs').checked = !!s.tabs;
  $('tgLive').checked = !!s.live;
  $('tgControl').checked = !!s.control;
  $('rowControl').style.opacity = s.live ? '1' : '.55';
  $('controlNote').hidden = !(s.live && s.control);
  $('linkHint').hidden = !(sharing && !$('guestUrl').value.trim());
}

/* ---------- live tab capture ---------- */
async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('Could not find the tab you are on.');
  if (!/^(https?|file):/i.test(tab.url || '')) {
    throw new Error('Chrome does not allow sharing internal pages. Switch to a normal website tab first.');
  }
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const res = await send('live_start', { streamId, tabId: tab.id, title: tab.title || '', url: tab.url || '' });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start the live view.');
}

async function tryCapture() {
  try {
    await captureActiveTab();
    return true;
  } catch (e) {
    toast(e.message || 'Could not start the live view.');
    await send('set_share', { share: { live: false } });
    return false;
  }
}

/* ---------- actions ---------- */
async function startSharing() {
  if (busy) return;
  busy = true;
  try {
    await send('start');
    if (state && state.share.live) await tryCapture();
  } finally { busy = false; }
}

async function onToggle(key, checked) {
  await send('set_share', { share: { [key]: checked } });
  if (key === 'live' && checked && state && (state.status === 'waiting' || state.status === 'connected' || state.status === 'starting')) {
    await tryCapture();
  }
}

function inviteLink() {
  const base = $('guestUrl').value.trim();
  if (!/^https?:\/\//i.test(base)) return null;
  try {
    const u = new URL(base);
    u.searchParams.set('room', state.code);
    return u.toString();
  } catch (e) { return null; }
}

async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch (e) { toast('Could not copy. Select the code and copy it manually.'); }
}

/* ---------- wiring ---------- */
$('btnStart').addEventListener('click', startSharing);
$('btnRetry').addEventListener('click', startSharing);
$('btnStop').addEventListener('click', () => send('stop'));
$('btnRetarget').addEventListener('click', async () => {
  try { await captureActiveTab(); toast('Now sharing this tab'); }
  catch (e) { toast(e.message); }
});

$('btnCopyCode').addEventListener('click', () => state && state.code && copy(state.code, 'Room code copied'));
$('btnCopyLink').addEventListener('click', () => {
  const link = state && state.code ? inviteLink() : null;
  if (!link) {
    $('settings').hidden = false;
    $('btnSettings').setAttribute('aria-expanded', 'true');
    $('guestUrl').focus();
    toast('Add your Guest page address first');
    return;
  }
  copy(link, 'Invite link copied');
});

[['tgBookmarks', 'bookmarks'], ['tgTabs', 'tabs'], ['tgLive', 'live'], ['tgControl', 'control']]
  .forEach(([id, key]) => $(id).addEventListener('change', e => onToggle(key, e.target.checked)));

$('btnSettings').addEventListener('click', () => {
  const box = $('settings');
  box.hidden = !box.hidden;
  $('btnSettings').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) $('guestUrl').focus();
});

let saveTimer;
$('guestUrl').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ guestUrl: $('guestUrl').value.trim() }), 250);
  render();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.target === 'popup' && msg.type === 'state') { state = msg.state; render(); }
});

(async function init() {
  const [{ guestUrl }, res] = await Promise.all([
    chrome.storage.local.get('guestUrl'),
    send('get_state')
  ]);
  $('guestUrl').value = guestUrl || '';
  if (res && res.state) { state = res.state; render(); }
})();
