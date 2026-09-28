'use strict';

/*
 * Offscreen document — owns the PeerJS peer.
 * MV3 service workers cannot use WebRTC, so the peer lives here.
 * The background worker feeds it data (bookmarks / tabs) and tab-capture stream ids,
 * and this page reports status + guest input events back to the background worker.
 */

const PEER_PREFIX = 'bshare-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const MAX_ID_RETRIES = 6;

let peer = null;
let code = null;
let share = { bookmarks: true, tabs: true, live: false, control: true };
let stream = null;                 // MediaStream of the captured tab (video + audio)
let audioCtx = null;               // routes the tab's audio back to the Host's speakers
let destroyed = true;
let idRetries = 0;
const conns = new Map();           // guest peerId -> { dc, call }

/* ---------- helpers ---------- */

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function toBackground(msg) {
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

function report(status, error) {
  toBackground({ type: 'peer_status', status, code, viewers: conns.size, error: error || null });
}

function caps() {
  return {
    bookmarks: !!share.bookmarks,
    tabs: !!share.tabs,
    live: !!share.live && !!stream,
    control: !!share.control && !!stream
  };
}

function safeSend(dc, message) {
  try { if (dc && dc.open) dc.send(message); } catch (e) { /* connection closing */ }
}

function sendToOne(peerId, message) {
  const entry = conns.get(peerId);
  if (entry) safeSend(entry.dc, message);
}

function sendToAll(message) {
  for (const { dc } of conns.values()) safeSend(dc, message);
}

/* ---------- peer lifecycle ---------- */

function startPeer() {
  teardown(false);
  destroyed = false;
  idRetries = 0;
  openWithNewCode();
}

function openWithNewCode() {
  code = makeCode();
  const p = new Peer(PEER_PREFIX + code, { debug: 0 });
  peer = p;

  p.on('open', () => {
    if (peer !== p) return;
    report('waiting');
  });

  p.on('connection', dc => setupDataConnection(dc));

  // Guests never send us media; refuse stray calls.
  p.on('call', call => { try { call.close(); } catch (e) { } });

  p.on('disconnected', () => {
    if (destroyed || peer !== p) return;
    // Lost the signalling server. Existing P2P connections keep working; reconnect for new guests.
    setTimeout(() => { try { if (!destroyed && peer === p && p.disconnected) p.reconnect(); } catch (e) { } }, 1500);
  });

  p.on('error', err => {
    if (peer !== p) return;
    if (err.type === 'unavailable-id' && idRetries < MAX_ID_RETRIES) {
      idRetries++;
      try { p.destroy(); } catch (e) { }
      openWithNewCode();
      return;
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
      // Recoverable while already sharing; fatal only before the room opened.
      if (!p.open) report('error', 'Could not reach the PeerJS signalling server. Check your internet connection and try again.');
      return;
    }
    if (err.type === 'unavailable-id') {
      report('error', 'Could not reserve a room code. Try again.');
      return;
    }
    // Other errors (peer-unavailable, webrtc, ...) concern individual connections.
    console.warn('[browser-share] peer error:', err.type, err.message);
  });
}

function teardown(announce) {
  destroyed = true;
  if (announce) sendToAll({ type: 'bye' });
  stopLive(false);
  const p = peer;
  peer = null;
  const doClose = () => {
    for (const { dc, call } of conns.values()) {
      try { call && call.close(); } catch (e) { }
      try { dc && dc.close(); } catch (e) { }
    }
    conns.clear();
    try { p && p.destroy(); } catch (e) { }
  };
  if (announce && conns.size) setTimeout(doClose, 120); else doClose();
}

/* ---------- guests ---------- */

function setupDataConnection(dc) {
  dc.on('open', () => {
    const old = conns.get(dc.peer);
    if (old && old.dc !== dc) { try { old.dc.close(); } catch (e) { } }
    conns.set(dc.peer, { dc, call: null });
    safeSend(dc, { type: 'hello', v: 1, caps: caps() });
    report('connected');
    if (stream) callGuest(dc.peer);
  });

  dc.on('data', data => handleGuestMessage(dc, data));

  const gone = () => {
    const entry = conns.get(dc.peer);
    if (!entry || entry.dc !== dc) return;
    try { entry.call && entry.call.close(); } catch (e) { }
    conns.delete(dc.peer);
    if (!destroyed) report(conns.size ? 'connected' : 'waiting');
  };
  dc.on('close', gone);
  dc.on('error', gone);
}

function handleGuestMessage(dc, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ready':
    case 'request_refresh':
      toBackground({ type: 'guest_ready', peerId: dc.peer });
      if (stream && !(conns.get(dc.peer) || {}).call) callGuest(dc.peer);
      break;
    case 'ping':
      safeSend(dc, { type: 'pong', t: msg.t });
      break;
    case 'control':
      if (share.control && stream && msg.event) toBackground({ type: 'control_event', event: msg.event });
      break;
  }
}

/* ---------- live tab stream ---------- */

function callGuest(peerId) {
  const entry = conns.get(peerId);
  if (!entry || !stream || !peer) return;
  try { entry.call && entry.call.close(); } catch (e) { }
  const call = peer.call(peerId, stream);
  if (!call) return;
  entry.call = call;
  call.on('close', () => { if (entry.call === call) entry.call = null; });
  call.on('error', () => { if (entry.call === call) entry.call = null; });

  // Raise the video bitrate ceiling once the connection is up (crisper text).
  const pc = call.peerConnection;
  if (pc) {
    const tune = () => {
      if (pc.connectionState !== 'connected') return;
      pc.getSenders().forEach(sender => {
        if (!sender.track || sender.track.kind !== 'video') return;
        try {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 6000000;
          params.degradationPreference = 'maintain-resolution';
          sender.setParameters(params).catch(() => {});
        } catch (e) { }
      });
    };
    pc.addEventListener('connectionstatechange', tune);
    tune();
  }
}

async function startLive(streamId) {
  stopLive(false);
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: { mandatory: { ...source, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } }
  });
  stream = media;

  // Capturing a tab's audio silences it for the Host. Play it back locally so the Host still hears it.
  if (media.getAudioTracks().length) {
    try {
      audioCtx = new AudioContext();
      audioCtx.createMediaStreamSource(media).connect(audioCtx.destination);
      audioCtx.resume().catch(() => {});
    } catch (e) { console.warn('[browser-share] local audio passthrough failed', e); }
  }

  const track = media.getVideoTracks()[0];
  try { track.contentHint = 'detail'; } catch (e) { }
  track.addEventListener('ended', () => {
    if (stream !== media) return;
    stopLive(true);
  });
  for (const id of conns.keys()) callGuest(id);
  sendToAll({ type: 'caps', caps: caps() });
}

function stopLive(notify) {
  const had = !!stream;
  if (stream) {
    stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { } });
    stream = null;
  }
  if (audioCtx) { try { audioCtx.close(); } catch (e) { } audioCtx = null; }
  for (const entry of conns.values()) {
    try { entry.call && entry.call.close(); } catch (e) { }
    entry.call = null;
  }
  if (had && notify) {
    toBackground({ type: 'live_status', active: false });
    sendToAll({ type: 'caps', caps: caps() });
  }
}

/* ---------- messages from the background worker ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  (async () => {
    switch (msg.type) {
      case 'start':
        share = { ...share, ...(msg.share || {}) };
        startPeer();
        return { ok: true };

      case 'stop':
        teardown(true);
        report('idle');
        return { ok: true };

      case 'settings':
        share = { ...share, ...(msg.share || {}) };
        sendToAll({ type: 'caps', caps: caps() });
        return { ok: true };

      case 'send':
        if (msg.peerId) sendToOne(msg.peerId, msg.message); else sendToAll(msg.message);
        return { ok: true };

      case 'live_start':
        try {
          await startLive(msg.streamId);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e && e.message) || 'Could not capture the tab.' };
        }

      case 'live_stop':
        stopLive(false);
        sendToAll({ type: 'caps', caps: caps() });
        return { ok: true };

      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse);

  return true;
});
