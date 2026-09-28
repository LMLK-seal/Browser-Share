'use strict';

/*
 * Background service worker.
 *  - keeps the sharing state (persisted in storage.session so it survives worker restarts)
 *  - reads bookmarks + tabs and pushes them to the offscreen peer
 *  - applies remote-control input from the guest through chrome.debugger
 */

const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_SHARE = { bookmarks: true, tabs: true, live: false, control: true };

function freshState() {
  return {
    status: 'idle',            // idle | starting | waiting | connected | error
    code: null,
    viewers: 0,
    error: null,
    share: { ...DEFAULT_SHARE },
    live: { active: false, tabId: null, title: '', url: '' },
    controlTabId: null         // tab the debugger is attached to
  };
}

let state = freshState();

const ready = (async () => {
  const [{ state: saved }, { share }] = await Promise.all([
    chrome.storage.session.get('state'),
    chrome.storage.local.get('share')
  ]);
  if (saved) state = { ...freshState(), ...saved };
  if (share) state.share = { ...DEFAULT_SHARE, ...share };
  updateBadge();
})();

/* ---------- state + badge ---------- */

const isSharing = () => state.status === 'waiting' || state.status === 'connected';

async function persist() {
  await chrome.storage.session.set({ state });
  updateBadge();
  chrome.runtime.sendMessage({ target: 'popup', type: 'state', state }).catch(() => {});
}

function updateBadge() {
  const on = isSharing();
  chrome.action.setBadgeText({ text: on ? (state.viewers > 0 ? String(state.viewers) : 'ON') : '' });
  chrome.action.setBadgeBackgroundColor({ color: state.viewers > 0 ? '#FF5B4A' : '#3D3DFF' });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  chrome.action.setTitle({
    title: on ? `Browser Share — room ${state.code}${state.viewers ? ` (${state.viewers} watching)` : ''}` : 'Browser Share'
  });
}

/* ---------- offscreen document ---------- */

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WEB_RTC', 'USER_MEDIA'],
    justification: 'Keeps the peer-to-peer room connection and the captured tab stream alive while sharing.'
  });
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (e) { }
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

function tellGuests(message, peerId) {
  if (!isSharing()) return;
  toOffscreen({ type: 'send', message, peerId }).catch(() => {});
}

/* ---------- data snapshots ---------- */

function trimNode(node) {
  const out = { id: node.id, title: node.title || '' };
  if (node.url) out.url = node.url; else out.children = (node.children || []).map(trimNode);
  if (node.dateAdded) out.dateAdded = node.dateAdded;
  return out;
}

function cleanFavicon(url) {
  if (!url || url.length > 4000) return '';
  return /^(https?:|data:image\/)/.test(url) ? url : '';
}

async function sendBookmarks(peerId) {
  const tree = await chrome.bookmarks.getTree();
  tellGuests({ type: 'bookmarks_update', payload: tree.map(trimNode) }, peerId);
}

async function sendTabs(peerId) {
  const tabs = await chrome.tabs.query({});
  tellGuests({
    type: 'tabs_update',
    payload: tabs.map(t => ({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || '',
      url: t.url || t.pendingUrl || '',
      favIconUrl: cleanFavicon(t.favIconUrl),
      active: !!t.active,
      pinned: !!t.pinned,
      audible: !!t.audible
    }))
  }, peerId);
}

function sendLiveInfo(peerId) {
  const l = state.live;
  tellGuests({ type: 'live_info', active: l.active, tabId: l.tabId, title: l.title, url: l.url }, peerId);
}

async function sendSnapshot(peerId) {
  if (!isSharing()) return;
  if (state.share.bookmarks) await sendBookmarks(peerId);
  if (state.share.tabs) await sendTabs(peerId);
  sendLiveInfo(peerId);
}

/* ---------- live listeners (debounced) ---------- */

const timers = {};
function debounce(key, fn, ms) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(async () => {
    await ready;
    if (isSharing() && state.viewers > 0) fn();
  }, ms);
}

const scheduleBookmarks = () => debounce('bm', () => state.share.bookmarks && sendBookmarks(), 400);
const scheduleTabs = () => debounce('tabs', () => state.share.tabs && sendTabs(), 350);

['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']
  .forEach(evt => chrome.bookmarks[evt] && chrome.bookmarks[evt].addListener(scheduleBookmarks));

chrome.tabs.onCreated.addListener(scheduleTabs);
chrome.tabs.onMoved.addListener(scheduleTabs);
chrome.tabs.onActivated.addListener(scheduleTabs);
chrome.tabs.onAttached.addListener(scheduleTabs);
chrome.tabs.onDetached.addListener(scheduleTabs);
chrome.tabs.onRemoved.addListener(async tabId => {
  scheduleTabs();
  await ready;
  if (state.live.tabId === tabId && state.live.active) {
    // the capture track ends on its own; make sure state follows
    state.live = { active: false, tabId: null, title: '', url: '' };
    await detachDebugger();
    await persist();
    sendLiveInfo();
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if ('title' in change || 'url' in change || 'favIconUrl' in change || 'audible' in change || 'pinned' in change || change.status === 'complete') {
    scheduleTabs();
  }
  await ready;
  if (state.live.active && state.live.tabId === tabId && (change.title || change.url)) {
    state.live.title = tab.title || state.live.title;
    state.live.url = tab.url || state.live.url;
    await persist();
    sendLiveInfo();
  }
});

/* ---------- sharing lifecycle ---------- */

async function startSharing() {
  if (state.status === 'starting' || isSharing()) return;
  state.status = 'starting';
  state.error = null;
  state.viewers = 0;
  state.code = null;
  await persist();
  try {
    await ensureOffscreen();
    await toOffscreen({ type: 'start', share: state.share });
  } catch (e) {
    state.status = 'error';
    state.error = 'Could not start the sharing engine: ' + (e.message || e);
    await persist();
  }
}

async function stopSharing() {
  await detachDebugger();
  try { await toOffscreen({ type: 'stop' }); } catch (e) { }
  const share = state.share;
  state = freshState();
  state.share = share;
  await persist();
  setTimeout(closeOffscreen, 400);
}

async function setShare(share) {
  const before = state.share;
  state.share = { ...before, ...share };
  await chrome.storage.local.set({ share: state.share });
  await persist();
  if (!isSharing()) return;

  toOffscreen({ type: 'settings', share: state.share }).catch(() => {});
  if (state.share.bookmarks && !before.bookmarks) await sendBookmarks();
  if (state.share.tabs && !before.tabs) await sendTabs();
  if (!state.share.live && before.live) await liveStop();
  if (!state.share.control && before.control) {
    await detachDebugger();
    tellGuests({ type: 'control_status', active: false, reason: 'disabled' });
  }
}

async function liveStart({ streamId, tabId, title, url }) {
  if (!isSharing() && state.status !== 'starting') throw new Error('Start sharing first.');
  await ensureOffscreen();
  await detachDebugger();
  const res = await toOffscreen({ type: 'live_start', streamId });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start the live view.');
  state.live = { active: true, tabId, title: title || '', url: url || '' };
  await persist();
  sendLiveInfo();
}

async function liveStop() {
  await detachDebugger();
  try { await toOffscreen({ type: 'live_stop' }); } catch (e) { }
  state.live = { active: false, tabId: null, title: '', url: '' };
  await persist();
  sendLiveInfo();
}

/* ---------- remote control (chrome.debugger) ---------- */

const dbg = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
let viewportCache = null;
let ctlQueue = Promise.resolve();
let ctlPending = 0;
let lastControlError = 0;

chrome.debugger.onDetach.addListener(async (source, reason) => {
  await ready;
  if (source.tabId !== state.controlTabId) return;
  state.controlTabId = null;
  viewportCache = null;
  await persist();
  tellGuests({ type: 'control_status', active: false, reason });
});

async function ensureAttached(tabId) {
  if (state.controlTabId === tabId) return;
  await detachDebugger();
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message || '')) throw e;
  }
  state.controlTabId = tabId;
  await persist();
  tellGuests({ type: 'control_status', active: true });
}

async function detachDebugger() {
  const tabId = state.controlTabId;
  if (tabId == null) return;
  state.controlTabId = null;
  viewportCache = null;
  try { await chrome.debugger.detach({ tabId }); } catch (e) { }
}

async function viewport(tabId) {
  const now = Date.now();
  if (viewportCache && viewportCache.tabId === tabId && now - viewportCache.t < 1500) return viewportCache;
  const m = await dbg(tabId, 'Page.getLayoutMetrics');
  const v = m.cssVisualViewport || m.visualViewport || m.cssLayoutViewport;
  viewportCache = { tabId, t: now, w: v.clientWidth, h: v.clientHeight };
  return viewportCache;
}

const BUTTONS = ['left', 'middle', 'right'];
const EDIT_COMMANDS = { a: 'selectAll', z: 'undo', y: 'redo' };

async function applyControl(ev) {
  await ready;
  if (!state.share.control || !state.live.active || state.live.tabId == null) return;
  const tabId = state.live.tabId;

  if (ev.kind === 'release') { await detachDebugger(); await persist(); tellGuests({ type: 'control_status', active: false, reason: 'released' }); return; }

  if (ev.kind === 'nav') {
    if (ev.action === 'back') return chrome.tabs.goBack(tabId).catch(() => {});
    if (ev.action === 'forward') return chrome.tabs.goForward(tabId).catch(() => {});
    if (ev.action === 'reload') return chrome.tabs.reload(tabId);
    if (ev.action === 'url' && /^https?:\/\//i.test(ev.url || '')) return chrome.tabs.update(tabId, { url: ev.url });
    return;
  }

  await ensureAttached(tabId);

  switch (ev.kind) {
    case 'mouse': {
      const vp = await viewport(tabId);
      const x = Math.max(0, Math.min(1, +ev.x || 0)) * vp.w;
      const y = Math.max(0, Math.min(1, +ev.y || 0)) * vp.h;
      const modifiers = ev.mods | 0;
      if (ev.action === 'wheel') {
        return dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: +ev.dx || 0, deltaY: +ev.dy || 0, modifiers });
      }
      const type = ev.action === 'down' ? 'mousePressed' : ev.action === 'up' ? 'mouseReleased' : 'mouseMoved';
      return dbg(tabId, 'Input.dispatchMouseEvent', {
        type, x, y, modifiers,
        button: type === 'mouseMoved' ? 'none' : (BUTTONS[ev.button | 0] || 'left'),
        buttons: ev.buttons | 0,
        clickCount: type === 'mouseMoved' ? 0 : Math.max(1, ev.clicks | 0)
      });
    }

    case 'key': {
      const mods = ev.mods | 0;
      const base = {
        key: String(ev.key || ''), code: String(ev.code || ''),
        windowsVirtualKeyCode: ev.keyCode | 0, nativeVirtualKeyCode: ev.keyCode | 0, modifiers: mods
      };
      if (ev.action === 'up') return dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      const isChar = base.key.length === 1 && !(mods & 6);       // no ctrl / meta
      const text = base.key === 'Enter' ? '\r' : (isChar ? base.key : undefined);
      const params = { type: text ? 'keyDown' : 'rawKeyDown', ...base };
      if (text) { params.text = text; params.unmodifiedText = text; }
      const cmd = (mods & 6) && EDIT_COMMANDS[base.key.toLowerCase()];
      if (cmd) params.commands = [cmd];
      return dbg(tabId, 'Input.dispatchKeyEvent', params);
    }

    case 'text':
      if (typeof ev.text === 'string' && ev.text.length < 20000) return dbg(tabId, 'Input.insertText', { text: ev.text });
      return;
  }
}

function enqueueControl(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.kind === 'mouse' && ev.action === 'move' && ctlPending > 4) return;   // drop stale pointer moves
  ctlPending++;
  ctlQueue = ctlQueue
    .then(() => applyControl(ev))
    .catch(e => {
      const now = Date.now();
      if (now - lastControlError < 4000) return;
      lastControlError = now;
      let msg = (e && e.message) || 'Control failed';
      if (/cannot attach|not allowed|chrome:\/\/|extensions gallery|Cannot access/i.test(msg)) {
        msg = 'Chrome does not allow control of this page (internal pages and the Web Store are off limits).';
      }
      tellGuests({ type: 'control_status', active: false, error: msg });
    })
    .finally(() => { ctlPending--; });
}

/* ---------- message router ---------- */

async function handle(msg) {
  await ready;
  switch (msg.type) {
    case 'get_state': return { ok: true, state };
    case 'start': await startSharing(); return { ok: true };
    case 'stop': await stopSharing(); return { ok: true };
    case 'set_share': await setShare(msg.share || {}); return { ok: true };
    case 'live_start': await liveStart(msg); return { ok: true };
    case 'live_stop': await liveStop(); return { ok: true };

    // from the offscreen peer
    case 'peer_status':
      if (state.status === 'idle' && msg.status === 'idle') return { ok: true };
      state.status = msg.status;
      state.code = msg.code || state.code;
      state.viewers = msg.viewers | 0;
      state.error = msg.error || null;
      if (msg.status === 'error') state.live = { active: false, tabId: null, title: '', url: '' };
      await persist();
      return { ok: true };

    case 'live_status':
      if (!msg.active && state.live.active) {
        state.live = { active: false, tabId: null, title: '', url: '' };
        await detachDebugger();
        await persist();
        sendLiveInfo();
      }
      return { ok: true };

    case 'guest_ready': await sendSnapshot(msg.peerId); return { ok: true };
    case 'control_event': enqueueControl(msg.event); return { ok: true };
  }
  return { ok: false, error: 'unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return;
  handle(msg).then(sendResponse, e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => { updateBadge(); });
