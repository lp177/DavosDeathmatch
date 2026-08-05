/* ══════════════════════════════════════════════════════════════
   WebRTC peer connection.

   Game traffic runs over an unreliable, unordered DataChannel — the
   correct choice for a rollback fighting game. Dropping a packet is
   fine because every packet carries the last several frames of input,
   so a gap is repaired by the next one to arrive. Waiting for a
   retransmission, by contrast, would stall the whole simulation.
   ══════════════════════════════════════════════════════════════ */

import { STUN_ONLY } from './ice.js';

/** How long to let ICE recover on its own before forcing a restart. */
const RECOVER_AFTER_MS = 4000;
/** And how long after that before the match is genuinely lost. */
const GIVE_UP_MS = 12000;

export class Peer extends EventTarget {
  /**
   * @param {SignalClient} signal
   * @param {boolean} initiator  the host creates the offer and the channel
   */
  constructor(signal, initiator, iceServers = STUN_ONLY) {
    super();
    this.signal = signal;
    this.initiator = initiator;
    // No candidate pre-gathering. It buys a few milliseconds of setup and
    // costs a multiple of the relay's scarcest resource: every pooled
    // transport opens its own TURN allocation, against a small port range
    // and a per-user quota.
    this.pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 0 });
    this.channel = null;
    this.open = false;
    this._pendingCandidates = [];
    this._remoteSet = false;

    this.pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.signal.relay({ kind: 'ice', candidate: e.candidate.toJSON() });
    });

    /*
     * 'disconnected' is NOT fatal. The spec defines it as a transient state:
     * the ICE agent keeps running consent checks and usually recovers within
     * seconds, only becoming 'failed' after the ~30s consent timeout. Treating
     * it as terminal tears down a match that a moment of packet loss would
     * have survived — which is precisely what happens on a long-haul relayed
     * connection, the case TURN exists to serve.
     */
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      this.dispatchEvent(new CustomEvent('pcstate', { detail: s }));

      if (s === 'failed' || s === 'closed') {
        this._clearRecovery();
        this.open = false;
        this.dispatchEvent(new CustomEvent('closed', { detail: s }));
        return;
      }

      if (s === 'disconnected') {
        this.dispatchEvent(new CustomEvent('unstable', { detail: true }));
        this._clearRecovery();
        // Give it a few seconds to come back on its own, then force new
        // candidates, then finally admit defeat.
        this._recoverTimer = setTimeout(() => {
          if (this.pc.connectionState !== 'disconnected') return;
          try { this.pc.restartIce?.(); } catch { /* older browsers */ }
          this._giveUpTimer = setTimeout(() => {
            const st = this.pc.connectionState;
            if (st === 'disconnected' || st === 'failed') {
              this.open = false;
              this.dispatchEvent(new CustomEvent('closed', { detail: 'timeout' }));
            }
          }, GIVE_UP_MS);
        }, RECOVER_AFTER_MS);
        return;
      }

      if (s === 'connected') {
        this._clearRecovery();
        this.dispatchEvent(new CustomEvent('unstable', { detail: false }));
      }
    });

    // restartIce() asks for renegotiation; only the offerer may drive it.
    this.pc.addEventListener('negotiationneeded', async () => {
      if (!this.initiator || this.pc.signalingState !== 'stable') return;
      try {
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        this.signal.relay({ kind: 'offer', sdp: this.pc.localDescription.toJSON() });
      } catch { /* the manual paths have no live channel to renegotiate over */ }
    });

    if (initiator) {
      this._setupChannel(this.pc.createDataChannel('game', {
        ordered: false,
        maxRetransmits: 0,
      }));
    } else {
      this.pc.addEventListener('datachannel', (e) => this._setupChannel(e.channel));
    }

    this._onSignal = (ev) => this._handleSignal(ev.detail);
    this.signal.addEventListener('message', this._onSignal);
  }

  _setupChannel(ch) {
    this.channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.addEventListener('open', () => {
      this.open = true;
      this.dispatchEvent(new CustomEvent('open'));
    });
    ch.addEventListener('close', () => {
      this.open = false;
      this.dispatchEvent(new CustomEvent('closed', { detail: 'channel' }));
    });
    ch.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.dispatchEvent(new CustomEvent('data', { detail: msg }));
    });
  }

  async start() {
    if (!this.initiator) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signal.relay({ kind: 'offer', sdp: this.pc.localDescription.toJSON() });
  }

  async _handleSignal(msg) {
    if (msg.t !== 'signal' || !msg.payload) return;
    const p = msg.payload;
    try {
      if (p.kind === 'offer' && !this.initiator) {
        // Also covers an ICE restart mid-match, not just the first handshake.

        await this.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        this._remoteSet = true;
        await this._drainCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal.relay({ kind: 'answer', sdp: this.pc.localDescription.toJSON() });
      } else if (p.kind === 'answer' && this.initiator) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        this._remoteSet = true;
        await this._drainCandidates();
      } else if (p.kind === 'ice') {
        // Candidates can arrive before the description; queue them.
        if (!this._remoteSet) this._pendingCandidates.push(p.candidate);
        else await this.pc.addIceCandidate(new RTCIceCandidate(p.candidate));
      }
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  async _drainCandidates() {
    for (const c of this._pendingCandidates) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* stale */ }
    }
    this._pendingCandidates.length = 0;
  }

  send(obj) {
    if (this.channel?.readyState === 'open') {
      try { this.channel.send(JSON.stringify(obj)); } catch { /* buffer full */ }
    }
  }

  /** Round-trip time in ms, from the active ICE candidate pair. */
  async rtt() {
    if (!this.pc.getStats) return null;
    try {
      const stats = await this.pc.getStats();
      let best = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' &&
            r.currentRoundTripTime != null) {
          best = r.currentRoundTripTime * 1000;
        }
      });
      return best;
    } catch {
      return null;
    }
  }

  /**
   * How the connection is actually carried: 'host' (same network),
   * 'srflx'/'prflx' (direct through NAT) or 'relay' (via TURN). Worth
   * surfacing — "it works but it's relayed" is a different situation
   * from "it works directly".
   */
  async routeType() {
    if (!this.pc.getStats) return null;
    try {
      const stats = await this.pc.getStats();
      const byId = new Map();
      const pairs = [];
      let selectedId = null;
      stats.forEach((r) => {
        byId.set(r.id, r);
        if (r.type === 'candidate-pair') pairs.push(r);
        // Chrome names the winning pair on the transport; Firefox flags the
        // pair itself. Take whichever is offered rather than guessing.
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          selectedId = r.selectedCandidatePairId;
        }
      });
      const pair = (selectedId && byId.get(selectedId))
        || pairs.find((p) => p.selected)
        || pairs.find((p) => p.nominated && p.state === 'succeeded')
        || pairs.find((p) => p.state === 'succeeded');
      if (!pair) return null;
      const l = byId.get(pair.localCandidateId);
      const r = byId.get(pair.remoteCandidateId);
      // Either end being a relay means the traffic is relayed.
      if (l?.candidateType === 'relay' || r?.candidateType === 'relay') return 'relay';
      return l?.candidateType || r?.candidateType || null;
    } catch {
      return null;
    }
  }

  _clearRecovery() {
    clearTimeout(this._recoverTimer);
    clearTimeout(this._giveUpTimer);
    this._recoverTimer = this._giveUpTimer = null;
  }

  close() {
    this._clearRecovery();
    this.signal.removeEventListener('message', this._onSignal);
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.open = false;
  }

  /**
   * @param {number} ms  Infinity to wait open-endedly, which is what an
   *   invitation that hasn't been opened yet needs: nobody is failing to
   *   connect, there is simply nobody there yet, and a deadline would retire
   *   a link that is still perfectly good.
   */
  waitOpen(ms = 25000) {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(ms) ? setTimeout(() => {
        cleanup();
        reject(new Error('Could not establish a direct connection. '
          + 'One of you may be behind a restrictive NAT or firewall.'));
      }, ms) : null;
      const onOpen = () => { cleanup(); resolve(); };
      const onClosed = () => { cleanup(); reject(new Error('Peer connection failed.')); };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeEventListener('open', onOpen);
        this.removeEventListener('closed', onClosed);
      };
      this.addEventListener('open', onOpen);
      this.addEventListener('closed', onClosed);
    });
  }
}
