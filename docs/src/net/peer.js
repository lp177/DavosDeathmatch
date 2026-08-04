/* ══════════════════════════════════════════════════════════════
   WebRTC peer connection.

   Game traffic runs over an unreliable, unordered DataChannel — the
   correct choice for a rollback fighting game. Dropping a packet is
   fine because every packet carries the last several frames of input,
   so a gap is repaired by the next one to arrive. Waiting for a
   retransmission, by contrast, would stall the whole simulation.
   ══════════════════════════════════════════════════════════════ */

const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class Peer extends EventTarget {
  /**
   * @param {SignalClient} signal
   * @param {boolean} initiator  the host creates the offer and the channel
   */
  constructor(signal, initiator, iceServers = DEFAULT_ICE) {
    super();
    this.signal = signal;
    this.initiator = initiator;
    this.pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    this.channel = null;
    this.open = false;
    this._pendingCandidates = [];
    this._remoteSet = false;

    this.pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.signal.relay({ kind: 'ice', candidate: e.candidate.toJSON() });
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      this.dispatchEvent(new CustomEvent('pcstate', { detail: s }));
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this.open = false;
        this.dispatchEvent(new CustomEvent('closed', { detail: s }));
      }
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

  close() {
    this.signal.removeEventListener('message', this._onSignal);
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.open = false;
  }

  waitOpen(ms = 25000) {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Could not establish a direct connection. '
          + 'One of you may be behind a restrictive NAT or firewall.'));
      }, ms);
      const onOpen = () => { cleanup(); resolve(); };
      const onClosed = () => { cleanup(); reject(new Error('Peer connection failed.')); };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('open', onOpen);
        this.removeEventListener('closed', onClosed);
      };
      this.addEventListener('open', onOpen);
      this.addEventListener('closed', onClosed);
    });
  }
}
