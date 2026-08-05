/* ══════════════════════════════════════════════════════════════
   Signalling client.

   The signalling server exists only to introduce two browsers to each
   other: it relays SDP offers/answers and ICE candidates, then gets out
   of the way. No game traffic ever passes through it.

   Because GitHub Pages (and any static host) can't run a WebSocket
   server, the URL is configurable in Settings → Network. When the page
   is served by the bundled Node server, same-origin is auto-detected.
   ══════════════════════════════════════════════════════════════ */

import { settings } from '../core/settings.js';

/** Hosts that definitely cannot serve the signalling endpoint. */
const STATIC_HOSTS = /(\.github\.io|\.pages\.dev|\.netlify\.app|\.vercel\.app)$/i;

export function defaultSignalUrl() {
  const configured = settings.data.net.signalUrl?.trim();
  if (configured) {
    // Accept http(s) URLs too and upgrade the scheme for convenience.
    return configured
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
  }
  const loc = window.location;
  if (loc.protocol === 'file:') return null;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/signal`;
}

export function isStaticHost() {
  return STATIC_HOSTS.test(window.location.hostname);
}

export function signallingHint() {
  if (settings.data.net.signalUrl?.trim()) return null;
  if (isStaticHost()) {
    return 'This page is served from a static host, which cannot run the matchmaking '
         + 'server. Run `node server/server.js` somewhere reachable and paste its '
         + 'address into Settings → Network → Signalling server.';
  }
  if (window.location.protocol === 'file:') {
    return 'Opened directly from disk. Run `node server/server.js` and load the game '
         + 'over http://localhost:8080 for online play.';
  }
  return null;
}

/**
 * Is there actually a matchmaking server at this address?
 *
 * Worth knowing before drawing the lobby: without this the UI has to offer
 * every option at once and let the player discover by failure which half of
 * it works. A two-second probe buys a screen that only shows what can work.
 */
export function probeSignal(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.addEventListener('open', () => done(true));
    ws.addEventListener('error', () => done(false));
    ws.addEventListener('close', () => done(false));
  });
}

export class SignalClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url || defaultSignalUrl();
    this.ws = null;
    this.code = null;
    this.role = null;      // 'host' | 'guest'
    this.state = 'idle';
  }

  _set(state, detail) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.url) {
        reject(new Error('No signalling server configured.'));
        return;
      }
      this._set('connecting');
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(new Error('Invalid signalling address: ' + this.url));
        return;
      }
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already dead */ }
        reject(new Error('Timed out reaching the matchmaking server.'));
      }, 8000);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._set('connected');
        resolve();
      });

      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Could not reach the matchmaking server.'));
      });

      ws.addEventListener('close', () => {
        this._set('closed');
        this.dispatchEvent(new CustomEvent('closed'));
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
        if (msg.t === 'hosted') { this.code = msg.code; this.role = 'host'; }
        if (msg.t === 'joined') { this.code = msg.code; this.role = 'guest'; }
      });
    });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  host() { this.send({ t: 'host' }); }
  join(code) { this.send({ t: 'join', code: String(code).toUpperCase().trim() }); }
  relay(payload) { this.send({ t: 'signal', payload }); }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  /** Await one message matching a predicate, with a timeout. */
  once(pred, ms = 20000) {
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (pred(ev.detail)) {
          cleanup();
          resolve(ev.detail);
        } else if (ev.detail.t === 'error') {
          cleanup();
          reject(new Error(ev.detail.msg || 'Matchmaking error'));
        }
      };
      const onClosed = () => { cleanup(); reject(new Error('Connection closed.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out.')); }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('message', onMsg);
        this.removeEventListener('closed', onClosed);
      };
      this.addEventListener('message', onMsg);
      this.addEventListener('closed', onClosed);
    });
  }
}
