/* ══════════════════════════════════════════════════════════════
   Automatic matchmaking with no server of our own.

   Public WebTorrent trackers exist to introduce two browsers that are
   interested in the same thing. They speak a small WebSocket protocol,
   need no account, and are already deployed all over the internet — so
   we borrow one. Both peers derive the same "info hash" from the room
   code, announce it, and the tracker passes the connection offer across.

   That turns an invite link into a single click: whoever opens it first
   is accepted and the fight starts. No codes to paste back.

   This is the only part of the game that depends on infrastructure we
   do not control, so it is strictly an accelerator: if no tracker
   answers, the caller falls back to the manual exchange, which always
   works.
   ══════════════════════════════════════════════════════════════ */

// Public trackers, tried in parallel. Ones that die stay in the list only
// as long as they are useful — tracker.files.fm was dropped when its TLS
// certificate expired, which turns every attempt into console noise.
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
];

// How often the host re-advertises. A tracker hands each offer to exactly
// one peer, so an offer that nobody claimed is simply gone — the host has to
// keep putting a fresh one up, and a joiner should not have to wait long for
// the next one.
const ANNOUNCE_EVERY = 4000;

/** Twenty characters, identical on both peers, derived from the room code. */
export function infoHashFor(code) {
  const out = [];
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < 20; i++) {
    for (const ch of `DDM${code}#${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(String.fromCharCode(97 + (h % 26)));
  }
  return out.join('');
}

function randomId() {
  let s = '';
  for (let i = 0; i < 20; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
}

/**
 * A thin client for the tracker's WebSocket announce protocol.
 * Emits 'offer'  {offer, offerId, fromPeer}
 *       'answer' {answer, offerId}
 */
export class TrackerClient extends EventTarget {
  constructor(code) {
    super();
    this.code = code;
    this.infoHash = infoHashFor(code);
    this.peerId = randomId();
    this.sockets = [];
    this.timer = null;
    this.closed = false;
    this.pending = null;      // the offer we are advertising
    this._started = new WeakSet();
  }

  /** Connect to whichever trackers answer. Resolves once at least one does. */
  connect(timeoutMs = 6000) {
    return new Promise((resolve) => {
      let settled = false;
      let open = 0;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => done(open > 0), timeoutMs);

      for (const url of TRACKERS) {
        let ws;
        try { ws = new WebSocket(url); } catch { continue; }
        this.sockets.push(ws);

        ws.addEventListener('open', () => {
          open++;
          // Resolve on the first one; the others join in as they arrive.
          clearTimeout(timer);
          setTimeout(() => done(true), 150);
          this._announce(ws);
        });
        ws.addEventListener('message', (ev) => this._onMessage(ev));
        ws.addEventListener('error', () => { /* try the next tracker */ });
        ws.addEventListener('close', () => {
          this.sockets = this.sockets.filter((s) => s !== ws);
          if (!this.closed && this.sockets.length === 0) {
            this.dispatchEvent(new CustomEvent('lost'));
          }
        });
      }
      if (!this.sockets.length) done(false);
    });
  }

  get connected() {
    return this.sockets.some((s) => s.readyState === WebSocket.OPEN);
  }

  _send(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* socket died mid-send */ }
    }
  }

  _announce(ws) {
    const msg = {
      action: 'announce',
      info_hash: this.infoHash,
      peer_id: this.peerId,
      // Asking for peers even when we have no offer keeps us in the swarm,
      // which is what makes a host's offer reach us.
      numwant: this.pending ? 1 : 1,
      uploaded: 0, downloaded: 0, left: 0,
    };
    // 'started' announces a NEW join. Repeating it on every keep-alive makes
    // a tracker treat one peer as a stream of arrivals.
    if (!this._started.has(ws)) {
      msg.event = 'started';
      this._started.add(ws);
    }
    if (this.pending) {
      msg.offers = [{ offer_id: this.pending.offerId, offer: this.pending.offer }];
    }
    this._send(ws, msg);
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || msg.info_hash !== this.infoHash) return;
    if (msg.peer_id === this.peerId) return;         // our own announce echoed

    if (msg.offer && msg.offer_id) {
      this.dispatchEvent(new CustomEvent('offer', {
        detail: { offer: msg.offer, offerId: msg.offer_id, fromPeer: msg.peer_id },
      }));
    } else if (msg.answer && msg.offer_id) {
      this.dispatchEvent(new CustomEvent('answer', {
        detail: { answer: msg.answer, offerId: msg.offer_id, fromPeer: msg.peer_id },
      }));
    }
  }

  /**
   * Advertise a connection offer and keep re-advertising it, so somebody
   * opening the link ten minutes later still finds it.
   */
  publishOffer(offer) {
    this.pending = { offer, offerId: randomId() };
    for (const ws of this.sockets) this._announce(ws);
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.closed) return;
      // A fresh id each time; trackers hand each offer to one peer only.
      this.pending.offerId = randomId();
      for (const ws of this.sockets) this._announce(ws);
    }, ANNOUNCE_EVERY);
  }

  /** Reply to somebody else's offer. */
  sendAnswer(answer, offerId, toPeer) {
    const msg = {
      action: 'announce',
      info_hash: this.infoHash,
      peer_id: this.peerId,
      to_peer_id: toPeer,
      answer,
      offer_id: offerId,
    };
    for (const ws of this.sockets) this._send(ws, msg);
  }

  /** Announce with no offer, which is how a joiner asks to be given one. */
  seek() {
    this.pending = null;
    for (const ws of this.sockets) this._announce(ws);
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.closed) return;
      for (const ws of this.sockets) this._announce(ws);
    }, 2500);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const ws of this.sockets) {
      try { ws.close(); } catch { /* already gone */ }
    }
    this.sockets = [];
  }

  /** Await one event. Pass Infinity to wait for as long as the page is open. */
  once(name, ms) {
    return new Promise((resolve, reject) => {
      const on = (e) => { cleanup(); resolve(e.detail); };
      const timer = Number.isFinite(ms)
        ? setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms)
        : null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeEventListener(name, on);
      };
      this.addEventListener(name, on);
    });
  }
}
