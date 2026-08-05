/* ══════════════════════════════════════════════════════════════
   ICE configuration — how the two browsers find a path to each other.

   STUN alone only tells a peer its own public address. That is enough
   when at least one side's NAT will accept an unsolicited packet from
   the other, which covers most home connections talking to each other
   — and, misleadingly, always covers two tabs on the same machine.

   It is not enough for symmetric NAT, carrier-grade NAT, or a corporate
   firewall. There the only remaining option is a TURN relay: a server
   both peers can reach outbound, which forwards their traffic. Without
   one, ICE exhausts its candidate pairs and gives up — which is exactly
   what "ICE failed, add a TURN server" means.

   Credentials are short-lived and minted per request by the server, so
   they are fetched rather than baked in, and re-fetched before expiry.
   ══════════════════════════════════════════════════════════════ */

import { settings } from '../core/settings.js';

/** Public STUN, always included: a direct path beats a relayed one. */
export const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Issues ephemeral TURN credentials. This is the game's own endpoint on its
 * own server (see server/server.js), which answers any origin — a self-hosted
 * or local copy is exactly the case that most needs a relay, so locking it to
 * one origin would break the people it is meant to help.
 * Override in Settings → Match → TURN credentials.
 */
export const DEFAULT_ICE_URL = 'https://lp177.fr/davos/ice';

let cache = null;      // { url, servers, expires }
let inflight = null;   // shared promise, so concurrent callers agree

/**
 * ICE servers for a new connection: STUN plus a TURN relay when one can
 * be obtained. Falls back to STUN-only rather than failing — that still
 * connects for most players, and a broken fetch shouldn't block a match
 * that would have worked anyway.
 */
export async function getIceServers({ timeoutMs = 4000 } = {}) {
  const url = settings.data.net.iceUrl?.trim() || DEFAULT_ICE_URL;
  if (cache && cache.url === url && cache.expires > Date.now()) return cache.servers;
  // Share one request between concurrent callers. Otherwise a warm-up fetch
  // and a real one race, and whichever loses can overwrite a good TURN result
  // with the STUN-only fallback.
  if (inflight) return inflight;

  inflight = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`ice endpoint returned ${res.status}`);
      // The timer must stay armed across the body read: fetch() resolves on
      // headers, so a server that answers 200 and then stalls the body would
      // otherwise hang here forever, with the abort already cancelled.
      const body = await res.json();
      const list = Array.isArray(body?.iceServers) ? body.iceServers.filter(isUsable) : [];
      if (!list.length) throw new Error('ice endpoint returned no usable servers');

      const servers = [...STUN_ONLY, ...list];
      // Re-fetch well before the credentials expire: a match can outlast them,
      // but an RTCPeerConnection only reads them once, at construction.
      const ttlSeconds = Math.min(Number(body.ttl) || 600, 3600);
      cache = { url, servers, expires: Date.now() + ttlSeconds * 1000 * 0.8 };
      return servers;
    } catch {
      return STUN_ONLY;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

function isUsable(s) {
  if (!s || !s.urls) return false;
  const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
  return urls.some((u) => typeof u === 'string' && /^(stun|turns?):/i.test(u));
}

/** Did we actually get a relay, or only STUN? For the diagnostics panel. */
export function hasTurn(servers) {
  return (servers || []).some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => /^turns?:/i.test(String(u)));
  });
}

/** Forget any cached credentials — used when the endpoint changes. */
export function resetIceCache() {
  cache = null;
  inflight = null;
}
