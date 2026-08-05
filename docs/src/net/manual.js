/* ══════════════════════════════════════════════════════════════
   Serverless direct connect.

   A matchmaking server exists only to hand one browser's connection
   offer to the other. That is a message — and people already have a
   dozen ways to send each other messages.

   So: the host generates an invite code, sends it to their opponent by
   whatever they already use, and pastes back the reply. No server, no
   accounts, nothing to install, and it works from a purely static host
   like GitHub Pages where a WebSocket endpoint simply cannot exist.

   The code is the SDP description with every ICE candidate already
   gathered (that's why we wait for gathering to finish rather than
   trickling), deflated and base64url'd to keep it pasteable.
   ══════════════════════════════════════════════════════════════ */

/**
 * A drop-in stand-in for SignalClient that carries nothing anywhere.
 * Peer talks to it exactly as it would to the real thing; we just take
 * the descriptions out by hand and put the reply back in by hand.
 */
export class ManualSignal extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  /**
   * Peer calls this for the offer/answer and for each ICE candidate.
   * We discard them: by the time a code is exported, gathering is
   * complete and every candidate is already inside the SDP.
   */
  relay(payload) {
    this.sent.push(payload);
  }

  /** Hand Peer something the player pasted in. */
  deliver(payload) {
    this.dispatchEvent(new CustomEvent('message', {
      detail: { t: 'signal', payload },
    }));
  }

  close() { /* nothing to close */ }
}

/**
 * Wait until every ICE candidate has been gathered, so the exported code
 * is self-contained. Bounded, because a blocked STUN server would
 * otherwise leave the player staring at a spinner forever — the host
 * candidates alone are enough for a LAN or a permissive NAT.
 */
export function waitForIce(pc, timeoutMs = 5000, settleMs = 1200) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let count = 0;
    let settle = null;

    const finish = () => { cleanup(); resolve(); };
    const onChange = () => { if (pc.iceGatheringState === 'complete') finish(); };
    // Gathering often keeps going long after the useful candidates are in —
    // a slow or unreachable STUN server will happily burn the whole timeout.
    // Once the candidates stop arriving, we already have what we need.
    const onCandidate = (e) => {
      if (!e.candidate) return finish();
      count++;
      clearTimeout(settle);
      settle = setTimeout(() => { if (count > 0) finish(); }, settleMs);
    };
    const hard = setTimeout(finish, timeoutMs);
    const cleanup = () => {
      clearTimeout(hard);
      clearTimeout(settle);
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/* ── Compact, pasteable encoding ───────────────────────────── */

const MAGIC = 'DDM1';

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * SDP → a code the player can paste into a chat window.
 * Most of an SDP is boilerplate, so it deflates to roughly a quarter of
 * its size, which is the difference between a wall of text and a code.
 */
export async function encodeSignal(kind, description) {
  const payload = JSON.stringify({ k: kind, s: description.sdp });
  const raw = new TextEncoder().encode(payload);
  const packed = await deflate(raw);
  if (packed) return `${MAGIC}z${toBase64Url(packed)}`;
  return `${MAGIC}p${toBase64Url(raw)}`;      // no CompressionStream here
}

export async function decodeSignal(code) {
  const trimmed = String(code).trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(MAGIC)) {
    throw new Error('That does not look like a Davos Deathmatch code.');
  }
  const mode = trimmed[MAGIC.length];
  const body = trimmed.slice(MAGIC.length + 1);
  let bytes;
  try {
    bytes = fromBase64Url(body);
    if (mode === 'z') bytes = await inflate(bytes);
  } catch {
    throw new Error('That code looks damaged — copy the whole thing and try again.');
  }
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('That code looks damaged — copy the whole thing and try again.');
  }
  if (!obj || (obj.k !== 'offer' && obj.k !== 'answer') || typeof obj.s !== 'string') {
    throw new Error('That code is not a valid invite.');
  }
  return { kind: obj.k, sdp: { type: obj.k, sdp: obj.s } };
}
