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

/**
 * The public instance, used when the game is served from somewhere that
 * cannot host a WebSocket endpoint — GitHub Pages being the obvious case.
 * Override it in Settings → Match → Signalling server to use your own.
 */
export const PUBLIC_SIGNAL_URL = 'wss://lp177.fr/davos/signal';

export function defaultSignalUrl() {
  const configured = settings.data.net.signalUrl?.trim();
  if (configured) {
    // Accept http(s) URLs too and upgrade the scheme for convenience.
    return configured
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
  }
  // Nowhere to auto-detect from: use the public instance.
  if (window.location.protocol === 'file:' || isStaticHost()) return PUBLIC_SIGNAL_URL;

  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // Relative to the directory the game is served from, not the site root, so
  // a deployment under /davos/ finds /davos/signal rather than /signal.
  const dir = loc.pathname.replace(/[^/]*$/, '');
  return `${proto}//${loc.host}${dir}signal`;
}

export function isStaticHost() {
  return STATIC_HOSTS.test(window.location.hostname);
}

export function signallingHint() {
  return null;   // there is always somewhere to connect now
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
    this._beat = null;
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
        // Write something periodically even when there is nothing to say. A
        // lobby is idle by nature — the host opens a room and goes off to
        // paste the link into a chat — and an idle TCP entry is exactly what
        // NAT tables and proxies reclaim, telling neither end. This keeps the
        // path warm, and when it has already gone it makes the failure
        // surface here instead of leaving the guest waiting on a socket that
        // will never speak again. Servers that don't know 'ping' ignore it,
        // so this works against any build.
        this._beat = setInterval(() => this.send({ t: 'ping' }), 20000);
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
        this._stopBeat();
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

  /** @param {string|null} code  ask for a specific code back after a reconnect */
  host(code = null) { this.send(code ? { t: 'host', code } : { t: 'host' }); }
  join(code) { this.send({ t: 'join', code: String(code).toUpperCase().trim() }); }
  relay(payload) { this.send({ t: 'signal', payload }); }

  _stopBeat() {
    clearInterval(this._beat);
    this._beat = null;
  }

  close() {
    this._stopBeat();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  /**
   * Await one message matching a predicate.
   *
   * Pass ms = Infinity to wait indefinitely. An open lobby has no natural
   * deadline: the host may leave it up while they go and find someone to
   * play, and a timer that quietly closes the room turns a link they sent
   * into a dead one. The room lasts as long as the page is open, and only a
   * closed socket ends the wait.
   */
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
      const timer = Number.isFinite(ms)
        ? setTimeout(() => { cleanup(); reject(new Error('Timed out.')); }, ms)
        : null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeEventListener('message', onMsg);
        this.removeEventListener('closed', onClosed);
      };
      this.addEventListener('message', onMsg);
      this.addEventListener('closed', onClosed);
    });
  }
}
