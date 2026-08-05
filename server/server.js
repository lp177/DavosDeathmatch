#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   Davos Deathmatch — static host + WebRTC signalling.

   Zero dependencies: the WebSocket handshake and framing (RFC 6455)
   are implemented directly against Node's http server, so there is
   nothing to install and nothing to build.

   Two jobs:
     1. Serve docs/ over HTTP (the same files GitHub Pages serves).
     2. Introduce two browsers to each other at /signal, relaying SDP
        and ICE. Game traffic never touches this process.

   Usage:  node server/server.js [--port 8080] [--host 0.0.0.0]
   ══════════════════════════════════════════════════════════════ */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ══════════════════════════════════════════════════════════════
   TURN credentials.

   STUN only tells a peer its own public address. When both players sit
   behind symmetric or carrier-grade NAT there is no direct path at all,
   and the connection needs a relay. coturn's shared-secret scheme lets
   us mint short-lived credentials without storing users: the username
   is an expiry timestamp and the password is its HMAC.

   Configured entirely by environment, and absent by default — the
   server is useful without a relay, it just can't rescue the hardest
   networks. The secret is never read from, or written to, the repo.
   ══════════════════════════════════════════════════════════════ */
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
const TURN_TTL = Number(process.env.TURN_TTL || 7200);

const STUN_URLS = (process.env.STUN_URLS ||
  'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',').map((u) => u.trim()).filter(Boolean);

function iceServers() {
  const servers = [{ urls: STUN_URLS }];
  if (TURN_SECRET && TURN_URLS.length) {
    // coturn REST scheme: username is the expiry, credential its HMAC-SHA1.
    // coturn accepts "<expiry>:<name>". Giving each player a distinct name
    // makes user-quota bound ONE player's allocations instead of everyone
    // sharing a single identity and starving each other.
    const who = crypto.randomBytes(6).toString('hex');
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${who}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET)
      .update(username).digest('base64');
    servers.push({ urls: TURN_URLS, username, credential });
  }
  return { ttl: TURN_TTL, iceServers: servers };
}

/* ── Arguments ─────────────────────────────────────────── */
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argOf('--port', process.env.PORT || 8080));
const HOST = argOf('--host', process.env.HOST || '0.0.0.0');
const ROOT = path.resolve(__dirname, '..', 'docs');

/* ── Static file serving ───────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/**
 * Hand out ICE servers. Open to any origin on purpose: this is a public
 * game, the credentials expire, and coturn's own quotas bound the damage.
 * Locking it to one origin would only break self-hosted copies, which is
 * exactly the case that most needs a relay.
 */
function serveIce(req, res) {
  const body = JSON.stringify(iceServers());
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // Resolve inside ROOT and refuse anything that escapes it.
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The game is edited live during development; don't cache it.
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try { return new URL(req.url, 'http://localhost').pathname; } catch { return ''; }
  })();

  if (req.method === 'OPTIONS' && pathname === '/ice') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Max-Age': '86400',
    }).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  if (pathname === '/ice') {
    serveIce(req, res);
    return;
  }
  serveStatic(req, res);
});

/* ══════════════════════════════════════════════════════════════
   Minimal RFC 6455 WebSocket server
   ══════════════════════════════════════════════════════════════ */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Every open WebSocket, so the keepalive sweep can reach them. */
const live = new Set();

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    this.fragments = [];
    this.fragmentOp = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
    socket.setTimeout(0);
    socket.setNoDelay(true);
    live.add(this);
  }

  /** Keep the connection warm. A lobby is idle by nature — the host opens a
   *  room and then goes off to paste the link into a chat app — and an idle
   *  TCP connection is exactly what NAT tables and middleboxes reclaim. The
   *  room would then vanish silently, and the link already sent would be dead
   *  on arrival with nothing to explain why. */
  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  _die() {
    if (this.closed) return;
    this.closed = true;
    live.delete(this);
    this.onClose?.();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Guard against a client streaming garbage at us.
    if (this.buffer.length > 1 << 20) { this.close(1009); return; }

    while (!this.closed) {
      const frame = this._readFrame();
      if (!frame) break;
      this._dispatch(frame);
    }
  }

  _readFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > 1_000_000n) { this.close(1009); return null; }
      len = Number(big); off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;

    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buffer = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _dispatch(frame) {
    switch (frame.opcode) {
      case 0x0: // continuation
        this.fragments.push(frame.payload);
        if (frame.fin) this._complete();
        break;
      case 0x1: // text
      case 0x2: // binary
        this.fragmentOp = frame.opcode;
        this.fragments = [frame.payload];
        if (frame.fin) this._complete();
        break;
      case 0x8: // close
        this.close(1000);
        break;
      case 0x9: // ping
        this._send(0xa, frame.payload);
        break;
      case 0xa: // pong
        break;
      default:
        this.close(1002);
    }
  }

  _complete() {
    const data = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOp === 0x1) this.onMessage?.(data.toString('utf8'));
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._die();
    }
  }

  sendJson(obj) {
    this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(code, 0);
    this._send(0x8, buf);
    this.closed = true;
    try { this.socket.end(); } catch { /* already gone */ }
    this.onClose?.();
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/signal') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  if (head?.length) socket.unshift(head);
  handleClient(new WsConnection(socket));
});

/* ══════════════════════════════════════════════════════════════
   Room brokering
   ══════════════════════════════════════════════════════════════ */

/** Unambiguous alphabet: no O/0, I/1, S/5 to read out loud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
const rooms = new Map();      // code -> { host, guest, created }

function newCode() {
  let code;
  do {
    code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  } while (rooms.has(code));
  return code;
}

function partnerOf(conn) {
  const room = rooms.get(conn.room);
  if (!room) return null;
  return room.host === conn ? room.guest : room.host;
}

function leaveRoom(conn) {
  const room = rooms.get(conn.room);
  if (!room) return;
  const other = partnerOf(conn);
  if (other) other.sendJson({ t: 'peer-left' });
  rooms.delete(conn.room);
  conn.room = null;
}

function handleClient(conn) {
  conn.room = null;

  conn.onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== 'object' || msg === null) return;

    switch (msg.t) {
      case 'host': {
        if (conn.room) leaveRoom(conn);
        // A host whose socket dropped may ask for its old code back. The link
        // is already in a chat window somewhere by then, so minting a new code
        // would quietly invalidate the only thing the guest has. Only grant it
        // if nobody else holds that code.
        const wanted = String(msg.code || '').toUpperCase().trim();
        const reclaim = /^[A-Z0-9]{6}$/.test(wanted) && !rooms.has(wanted);
        const code = reclaim ? wanted : newCode();
        rooms.set(code, { host: conn, guest: null, created: Date.now() });
        conn.room = code;
        conn.sendJson({ t: 'hosted', code });
        log(`room ${code} ${reclaim ? 'reclaimed' : 'opened'}`);
        break;
      }

      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          conn.sendJson({ t: 'error', msg: 'No room with that code.' });
          return;
        }
        if (room.guest) {
          conn.sendJson({ t: 'error', msg: 'That room is already full.' });
          return;
        }
        if (room.host === conn) {
          conn.sendJson({ t: 'error', msg: 'You cannot join your own room.' });
          return;
        }
        room.guest = conn;
        conn.room = code;
        conn.sendJson({ t: 'joined', code });
        room.host.sendJson({ t: 'peer-joined' });
        log(`room ${code} paired`);
        break;
      }

      case 'signal': {
        const other = partnerOf(conn);
        if (other) other.sendJson({ t: 'signal', payload: msg.payload });
        break;
      }

      case 'leave':
        leaveRoom(conn);
        break;

      default:
        break;
    }
  };

  conn.onClose = () => leaveRoom(conn);
}

/* Keep idle lobbies alive. Well under the 60s that most NAT tables and
   proxies use for an idle TCP entry. */
setInterval(() => {
  for (const conn of live) {
    try { conn.ping(); } catch { /* it will be reaped by its own error handler */ }
  }
}, 25_000).unref();

/* Drop rooms whose host has actually gone.
 *
 * Deliberately not a time limit. A room is a page someone has open, and it
 * lasts exactly as long as that page does — expiring one on a timer would
 * invalidate an invite link that is sitting unread in a chat, which is the
 * normal case, not an edge case. The keepalive above is what makes this safe:
 * a host that closed its laptop is detected as a dead socket rather than
 * lingering, so the map stays bounded by the number of live connections. */
setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.host || room.host.closed) {
      room.guest?.sendJson({ t: 'peer-left' });
      rooms.delete(code);
      log(`room ${code} closed (host gone)`);
    }
  }
}, 30_000).unref();

function log(msg) {
  process.stdout.write(`[davos] ${msg}\n`);
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  log(`serving ${path.relative(process.cwd(), ROOT) || '.'} on http://${shown}:${PORT}`);
  log(`signalling on ws://${shown}:${PORT}/signal`);
  log(TURN_SECRET && TURN_URLS.length
    ? `TURN relay offered at /ice (${TURN_URLS.length} url(s), ttl ${TURN_TTL}s)`
    : 'no TURN configured — set TURN_SECRET and TURN_URLS to add a relay');
  log('press Ctrl+C to stop');
});

process.on('SIGINT', () => {
  log('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
