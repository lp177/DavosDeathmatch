/* ══════════════════════════════════════════════════════════════
   Rollback netcode (GGPO-style).

   Both peers run the identical deterministic simulation. Neither waits
   for the other: each frame we simulate with the opponent's real input
   if it has arrived, or a prediction (repeat their last input) if it
   hasn't. When a packet turns up and the prediction was wrong, we
   restore the snapshot from that frame and re-simulate forward.

   Re-simulation runs with emit=false so hit sparks, sounds and screen
   shake don't fire twice — the player only ever sees the corrected
   timeline.

   Every packet carries the last REDUNDANCY frames of input, so a
   dropped datagram repairs itself on the next one. That's why the data
   channel is unreliable and unordered.
   ══════════════════════════════════════════════════════════════ */

const MAX_ROLLBACK = 10;     // frames we're willing to rewind
const SNAP_SIZE = 14;        // snapshot ring, > MAX_ROLLBACK
const REDUNDANCY = 8;        // frames of input repeated in each packet
const CHECKSUM_EVERY = 30;

export class Netplay extends EventTarget {
  /**
   * @param {Peer} peer
   * @param {number} localPlayer  0 (host) or 1 (guest)
   * @param {Match} match         already constructed with the shared config
   * @param {number} delay        input delay in frames
   */
  constructor(peer, localPlayer, match, delay = 2) {
    super();
    this.peer = peer;
    this.local = localPlayer;
    this.remotePlayer = 1 - localPlayer;
    this.match = match;
    this.delay = Math.max(0, Math.min(8, delay | 0));

    this.frame = 0;
    this.localInputs = [];     // indexed by absolute frame
    this.remoteInputs = [];
    this.usedRemote = [];      // what we actually simulated with
    this.checksums = [];
    this.snapshots = new Array(SNAP_SIZE).fill(null);

    this.lastConfirmed = -1;   // highest frame with contiguous real remote input
    this.remoteFrame = 0;      // peer's reported input frame
    this.remoteAdvantage = 0;  // how far ahead of confirmed the peer is running
    this.rollbacks = 0;
    this.rollbackWindow = [];
    this.stalls = 0;
    this.ping = null;
    this.desynced = false;
    this.remoteChecksums = new Map();
    this.connected = true;
    this._lastPing = 0;
    this.pendingRollback = null;   // earliest frame needing correction
    this.stalledSince = 0;         // wall-clock ms of the current stall run

    this._onData = (ev) => this._handle(ev.detail);
    this._onClosed = () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    };
    peer.addEventListener('data', this._onData);
    peer.addEventListener('closed', this._onClosed);
  }

  dispose() {
    this.peer.removeEventListener('data', this._onData);
    this.peer.removeEventListener('closed', this._onClosed);
  }

  /* ── Incoming ────────────────────────────────────────── */

  _handle(msg) {
    switch (msg.t) {
      case 'i': this._onInputs(msg); break;
      case 'p': this.peer.send({ t: 'q', ts: msg.ts }); break;
      case 'q': this.ping = performance.now() - msg.ts; break;
      case 'c': this._onChecksum(msg); break;
      case 'bye':
        this.connected = false;
        this.dispatchEvent(new CustomEvent('disconnected', { detail: 'peer left' }));
        break;
      default: break;
    }
  }

  _onInputs(msg) {
    this.remoteFrame = msg.f;
    // How far ahead of its own confirmed inputs the peer is running. Comparing
    // this against our own figure is latency-symmetric: both sides measure the
    // same quantity, so neither needs to estimate the link delay.
    if (msg.a != null) this.remoteAdvantage = msg.a;
    let mispredictedAt = null;
    const base = msg.f - msg.d.length + 1;

    for (let i = 0; i < msg.d.length; i++) {
      const f = base + i;
      if (f < 0) continue;
      if (this.remoteInputs[f] !== undefined) continue;
      this.remoteInputs[f] = msg.d[i];
      // Did we already simulate this frame with a different guess?
      if (f < this.frame && this.usedRemote[f] !== msg.d[i]) {
        if (mispredictedAt === null || f < mispredictedAt) mispredictedAt = f;
      }
    }

    // Advance the confirmed watermark over any newly contiguous run.
    while (this.remoteInputs[this.lastConfirmed + 1] !== undefined) this.lastConfirmed++;

    // Note the correction, but don't re-simulate here. Several packets can
    // land between two frames, and re-simulating inside each network callback
    // means doing the same work repeatedly and blocking the event loop long
    // enough to starve WebRTC's own keepalives. Coalesce instead: the next
    // tick performs exactly one rollback to the earliest bad frame.
    if (mispredictedAt !== null) {
      this.pendingRollback = this.pendingRollback === null
        ? mispredictedAt
        : Math.min(this.pendingRollback, mispredictedAt);
    }
  }

  _onChecksum(msg) {
    // Only record here. Comparing now would race the deferred rollback: an
    // input packet can advance `lastConfirmed` past frames whose corrected
    // checksums have not been recomputed yet, and the stale values would look
    // exactly like a desync. The comparison happens in tick(), after any
    // pending correction has been applied.
    this.remoteChecksums.set(msg.f, msg.h);
  }

  _compareChecksums() {
    if (this.desynced) return;
    for (const [f, h] of this.remoteChecksums) {
      if (f > this.lastConfirmed) continue;
      const mine = this.checksums[f];
      if (mine === undefined) continue;
      this.remoteChecksums.delete(f);
      if (mine !== h) {
        this.desynced = true;
        this.dispatchEvent(new CustomEvent('desync', { detail: { frame: f, mine, theirs: h } }));
        return;
      }
    }
    // Don't let the map grow unbounded if frames never confirm.
    if (this.remoteChecksums.size > 64) this.remoteChecksums.clear();
  }

  /* ── Rollback ────────────────────────────────────────── */

  _snapshot() {
    this.snapshots[this.frame % SNAP_SIZE] = {
      frame: this.frame,
      state: this.match.snapshot(),
    };
  }

  _rollbackTo(frame) {
    const slot = this.snapshots[frame % SNAP_SIZE];
    if (!slot || slot.frame !== frame) {
      // The frame fell out of the ring. Nothing correct left to do; the
      // checksum exchange will surface it if the timelines really diverged.
      return;
    }
    const target = this.frame;
    this.match.restore(slot.state);
    this.frame = frame;

    while (this.frame < target) {
      this._simulateOne(false);
    }
    this.rollbacks++;
    this.rollbackWindow.push(performance.now());
  }

  /** Simulate exactly one frame using the best inputs we have. */
  _simulateOne(emit) {
    const f = this.frame;
    this._snapshot();

    const localWord = this.localInputs[f] ?? 0;
    const remoteWord = this.remoteInputs[f] !== undefined
      ? this.remoteInputs[f]
      : this._predict(f);

    this.usedRemote[f] = remoteWord;

    const inputs = this.local === 0 ? [localWord, remoteWord] : [remoteWord, localWord];
    this.match.step(inputs, emit);
    this.checksums[f] = this.match.checksum();
    this.frame++;
  }

  /** Repeat-last-input prediction: cheap, and right most of the time. */
  _predict(f) {
    for (let i = f - 1; i >= Math.max(0, f - 30); i--) {
      if (this.remoteInputs[i] !== undefined) return this.remoteInputs[i];
    }
    return 0;
  }

  /* ── Outgoing ────────────────────────────────────────── */

  _sendInputs(upto) {
    const d = [];
    for (let f = upto - REDUNDANCY + 1; f <= upto; f++) {
      d.push(f >= 0 ? (this.localInputs[f] ?? 0) : 0);
    }
    this.peer.send({ t: 'i', f: upto, d, a: this.localAdvantage });
  }

  /** Frames we are simulating past the last input we actually know. */
  get localAdvantage() {
    return this.frame - this.lastConfirmed;
  }

  /* ══════════════════════════════════════════════════════
     Called once per 60Hz tick by the game loop.
     @returns {'ok'|'stall'} whether the simulation advanced
     ══════════════════════════════════════════════════════ */
  tick(localWord) {
    if (!this.connected) return 'stall';

    // Apply any correction that arrived since the last tick — one rollback,
    // however many packets turned up.
    if (this.pendingRollback !== null) {
      const target = this.pendingRollback;
      this.pendingRollback = null;
      if (target < this.frame) this._rollbackTo(target);
    }
    // Now that every correction is applied, the stored checksums are
    // authoritative and safe to compare.
    this._compareChecksums();

    // Record and transmit this frame's local input, delayed.
    //
    // Commit exactly once per frame. A stalled tick doesn't advance `frame`,
    // so the next tick would target the same slot again — overwriting a value
    // we have already put on the wire. The peer keeps the first copy it
    // receives and ignores later ones, so the two sides would then simulate
    // that frame with different inputs and desync. Since stalls only happen
    // under latency, this hides completely on a local connection.
    const inputFrame = this.frame + this.delay;
    if (this.localInputs[inputFrame] === undefined) {
      this.localInputs[inputFrame] = localWord;
    }
    this._sendInputs(inputFrame);

    // Periodic ping and checksum exchange.
    const now = performance.now();
    if (now - this._lastPing > 1000) {
      this._lastPing = now;
      this.peer.send({ t: 'p', ts: now });
      if (this.lastConfirmed >= 0 && this.checksums[this.lastConfirmed] !== undefined) {
        this.peer.send({ t: 'c', f: this.lastConfirmed, h: this.checksums[this.lastConfirmed] });
      }
    }

    // Trim the rolling rollback-rate window.
    while (this.rollbackWindow.length && now - this.rollbackWindow[0] > 1000) {
      this.rollbackWindow.shift();
    }

    // Never speculate further than we can rewind.
    if (this.frame - this.lastConfirmed > MAX_ROLLBACK) {
      this.stalls++;
      // A brief stall is normal on a slow link. A stall that never ends means
      // the peer's inputs are gone for good, and freezing on a black screen
      // forever is the worst possible way to tell the player that.
      if (!this.stalledSince) this.stalledSince = now;
      else if (now - this.stalledSince > 6000) {
        this.connected = false;
        this.dispatchEvent(new CustomEvent('disconnected', { detail: 'stalled' }));
      }
      return 'stall';
    }
    this.stalledSince = 0;

    // Frame-advantage smoothing.
    //
    // Comparing our frame against the peer's *reported frame number* looks
    // obvious and is wrong: that number is already stale by one trip time, so
    // on any real connection it reads as a permanent lead and the game stalls
    // itself into lockstep instead of rolling back.
    //
    // Instead both sides measure the same latency-independent quantity — how
    // far each is speculating past its own confirmed inputs — and whoever is
    // further ahead concedes a frame. On a symmetric link nobody stalls.
    const drift = this.localAdvantage - this.remoteAdvantage;
    if (drift > 2 && (this.frame % 6) === 0) {
      this.stalls++;
      return 'stall';
    }

    this._simulateOne(true);
    return 'ok';
  }

  get stats() {
    return {
      ping: this.ping,
      rollbacksPerSec: this.rollbackWindow.length,
      frame: this.frame,
      remoteFrame: this.remoteFrame,
      advantage: this.localAdvantage,
      remoteAdvantage: this.remoteAdvantage,
      confirmed: this.lastConfirmed,
      delay: this.delay,
      stalls: this.stalls,
      desynced: this.desynced,
    };
  }

  bye() {
    this.peer.send({ t: 'bye' });
  }
}
