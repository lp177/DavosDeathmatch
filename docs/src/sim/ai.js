/* ══════════════════════════════════════════════════════════════
   CPU opponent.

   The AI is just another input source: it looks at the world and
   returns a command word, exactly like a keyboard would. That keeps it
   completely outside the simulation, and means anything it can do, a
   player can do too.

   Motion inputs are played back as a scripted queue of command words,
   so the CPU has to actually draw a quarter-circle like everyone else.
   ══════════════════════════════════════════════════════════════ */

import { IN, S, MAX_METER } from './constants.js';
import { isAirborne, isAttacking, isStunned, movePhase } from './fighter.js';
import { Rng } from '../core/rng.js';

export const DIFFICULTY = {
  tourist:  { react: 22, aggro: 0.34, block: 0.35, antiAir: 0.22, special: 0.16, super: 0.3, punish: 0.2, tech: 0.15 },
  normal:   { react: 12, aggro: 0.56, block: 0.62, antiAir: 0.5,  special: 0.34, super: 0.6, punish: 0.45, tech: 0.35 },
  delegate: { react: 7,  aggro: 0.74, block: 0.8,  antiAir: 0.72, special: 0.5,  super: 0.85, punish: 0.7, tech: 0.55 },
  chairman: { react: 3,  aggro: 0.9,  block: 0.93, antiAir: 0.9,  special: 0.68, super: 1.0, punish: 0.9, tech: 0.78 },
};

/* Direction helpers, written facing-right and mirrored on emit. */
const D = { N: 0, F: 1, B: 2, D: 4, U: 8, DF: 5, DB: 6, UF: 9, UB: 10 };

function pack(dirMask, facing, button = 0) {
  let w = button;
  const right = facing > 0 ? IN.RIGHT : IN.LEFT;
  const left = facing > 0 ? IN.LEFT : IN.RIGHT;
  if (dirMask & D.F) w |= right;
  if (dirMask & D.B) w |= left;
  if (dirMask & D.D) w |= IN.DOWN;
  if (dirMask & D.U) w |= IN.UP;
  return w;
}

/** Frame-by-frame recipes for each motion. */
const SCRIPTS = {
  qcf:   [D.D, D.D, D.DF, D.F],
  qcb:   [D.D, D.D, D.DB, D.B],
  dp:    [D.F, D.N, D.D, D.DF],
  rdp:   [D.B, D.N, D.D, D.DB],
  hcf:   [D.B, D.DB, D.D, D.DF, D.F],
  hcb:   [D.F, D.DF, D.D, D.DB, D.B],
  dd:    [D.D, D.N, D.D],
  qcfx2: [D.D, D.DF, D.F, D.D, D.DF, D.F],
  qcbx2: [D.D, D.DB, D.B, D.D, D.DB, D.B],
  none:  [],
};

export class Ai {
  constructor(playerIndex, char, difficulty = 'normal', seed = 7) {
    this.me = playerIndex;
    this.char = char;
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.rng = new Rng(seed);
    this.queue = [];         // pending command words
    this.think = 0;          // frames until the next decision
    this.intent = 'neutral';
    this.intentLeft = 0;
    this.chargeFrames = 0;
    this.lastState = -1;

    // Precompute which specials this character actually has.
    this.specials = Object.entries(char.moves)
      .filter(([, m]) => m.tier === 'special')
      .map(([id, m]) => ({ id, m }));
    this.superMove = Object.entries(char.moves)
      .find(([, m]) => m.tier === 'super');
    this.antiAir = this.specials.find((s) => s.m.input.motion === 'dp') || null;
    this.projectile = this.specials.find((s) => s.m.spawns && s.m.input.motion === 'qcf') || null;
    this.rush = this.specials.find((s) => s.m.keepMomentum) || null;
    this.grab = this.specials.find((s) => s.m.isThrow) || null;
  }

  /** Queue the inputs needed to perform `moveId`. */
  perform(moveId, facing) {
    const mv = this.char.moves[moveId];
    if (!mv || !mv.input) return;
    const script = SCRIPTS[mv.input.motion] || [];
    const btn = firstButton(mv.input.button);
    for (let i = 0; i < script.length; i++) {
      const last = i === script.length - 1;
      // Hold each direction two frames so the buffer definitely sees it.
      this.queue.push(pack(script[i], facing, last ? btn : 0));
      if (!last) this.queue.push(pack(script[i], facing, 0));
      else this.queue.push(pack(script[i], facing, btn));
    }
    if (script.length === 0) {
      const stanceDir = mv.input.stance === 'crouch' ? D.D : D.N;
      this.queue.push(pack(stanceDir, facing, btn));
      this.queue.push(pack(stanceDir, facing, btn));
    }
    this.queue.push(0);
  }

  /** Queue a plain normal, optionally crouching. */
  press(button, facing, crouch = false, frames = 2) {
    for (let i = 0; i < frames; i++) this.queue.push(pack(crouch ? D.D : D.N, facing, button));
    this.queue.push(pack(crouch ? D.D : D.N, facing, 0));
  }

  hold(dirMask, facing, frames) {
    for (let i = 0; i < frames; i++) this.queue.push(pack(dirMask, facing, 0));
  }

  /** One command word for this frame. */
  update(match) {
    const me = match.fighters[this.me];
    const opp = match.fighters[1 - this.me];
    const facing = me.facing;

    if (match.phase !== 'fight') { this.queue.length = 0; return 0; }
    // Mash out of a dizzy.
    if (me.state === S.DIZZY) {
      return (match.frame % 4 < 2) ? IN.LP : IN.RIGHT;
    }
    if (me.state === S.KO || me.state === S.VICTORY) return 0;

    // Reactive guard. Without this the CPU is almost always partway through
    // a queued string and never gets a chance to block anything — abandoning
    // the plan to put the guard up is exactly what a human would do.
    const oppStarting = opp.moveId && !isStunned(opp);
    if (this.queue.length && !isAttacking(me) && oppStarting &&
        Math.abs(opp.x - me.x) < 230 && this.rng.chance(this.cfg.block * 0.4)) {
      this.queue.length = 0;
      this.intent = 'block';
      this.intentLeft = 14 + this.rng.int(12);
      this.think = 3;
      return pack(D.DB, facing);
    }

    if (this.queue.length) return this.queue.shift();

    if (this.think > 0) { this.think--; return this.idleWord(match, me, opp, facing); }
    this.think = Math.max(1, Math.round(this.cfg.react * (0.6 + this.rng.float() * 0.8)));

    const dist = Math.abs(opp.x - me.x);
    const oppAir = isAirborne(opp);
    const oppAttacking = isAttacking(opp);
    const meCornered = Math.abs(me.x) > 1000;

    /* — 1. Anti-air — */
    if (oppAir && dist < 240 && opp.y > 40 && opp.vy < 6 &&
        this.rng.chance(this.cfg.antiAir)) {
      if (this.antiAir && me.meter > 0) { this.perform(this.antiAir.id, facing); return 0; }
      this.press(IN.HP, facing, true);
      return 0;
    }

    /* — 2. Punish a whiffed or recovering move — */
    if (opp.moveId && dist < 190 && this.rng.chance(this.cfg.punish)) {
      const omv = match.chars[1 - this.me].moves[opp.moveId];
      if (omv && movePhase(omv, opp.moveFrame) === 'recovery') {
        if (me.meter >= MAX_METER && this.superMove && this.rng.chance(this.cfg.super)) {
          this.perform(this.superMove[0], facing);
        } else if (this.antiAir) {
          this.perform(this.antiAir.id, facing);
        } else {
          this.press(IN.HP, facing);
        }
        return 0;
      }
    }

    /* — 3. Block incoming pressure — */
    if (oppAttacking && dist < 210 && this.rng.chance(this.cfg.block)) {
      this.intent = 'block';
      this.intentLeft = 16 + this.rng.int(14);
      return pack(D.DB, facing);
    }

    /* — 4. Finish with a super when it's lethal — */
    if (me.meter >= MAX_METER && this.superMove && dist < 260 &&
        this.rng.chance(this.cfg.super * 0.4)) {
      this.perform(this.superMove[0], facing);
      return 0;
    }

    /* — 5. Range-based game plan —
       Thresholds are tuned to actual reach: heavy normals hit out to
       roughly 170 units, so "close" has to mean close. Anything further
       is spent closing the gap, not dancing. */
    if (dist > 470) {
      if (this.projectile && this.rng.chance(this.cfg.special * 0.7)) {
        this.perform(this.projectile.id, facing);
        return 0;
      }
      if (this.rush && this.rng.chance(this.cfg.aggro * 0.35)) {
        this.perform(this.rush.id, facing);
        return 0;
      }
      this.intent = 'approach';
      this.intentLeft = 24 + this.rng.int(26);
      return pack(D.F, facing);
    }

    if (dist > 185) {
      const roll = this.rng.float();
      // Mostly walk in. Standing at mid range trading nothing is the
      // single most common way for a CPU to look broken.
      if (roll < 0.52 + this.cfg.aggro * 0.25) {
        this.intent = 'approach';
        this.intentLeft = 16 + this.rng.int(16);
        return pack(D.F, facing);
      }
      if (roll < 0.74 && this.projectile) {
        this.perform(this.projectile.id, facing);
        return 0;
      }
      if (roll < 0.84) {
        // Jump in with an attack on the way down.
        this.hold(D.UF, facing, 3);
        for (let i = 0; i < 14; i++) this.queue.push(pack(D.F, facing));
        this.press(IN.HK, facing);
        return 0;
      }
      if (roll < 0.92 && this.rush) {
        this.perform(this.rush.id, facing);
        return 0;
      }
      this.intent = 'space';
      this.intentLeft = 8 + this.rng.int(12);
      return pack(meCornered ? D.F : D.B, facing);
    }

    /* — 6. Close range: this is where the CPU should be swinging — */
    const roll = this.rng.float();
    if (roll < 0.1 && this.grab && dist < 100) {
      this.perform(this.grab.id, facing);
      return 0;
    }
    if (roll < 0.16 && dist < 94) {
      // Normal throw: forward + heavy punch.
      this.queue.push(pack(D.F, facing, IN.HP));
      this.queue.push(pack(D.F, facing, IN.HP));
      this.queue.push(0);
      return 0;
    }
    if (roll < 0.16 + this.cfg.special * 0.42 && this.specials.length) {
      const s = this.specials[this.rng.int(this.specials.length)];
      this.perform(s.id, facing);
      return 0;
    }
    if (roll < 0.88) {
      // A short blockstring: light → light → heavy, walking in slightly so
      // pushback doesn't drift the CPU out of its own range.
      this.press(IN.LP, facing, this.rng.chance(0.4));
      this.press(IN.LK, facing, this.rng.chance(0.5));
      if (this.rng.chance(this.cfg.aggro)) {
        this.press(this.rng.chance(0.5) ? IN.HP : IN.HK, facing, this.rng.chance(0.3));
      }
      this.hold(D.F, facing, 4);
      return 0;
    }
    if (roll < 0.95) {
      this.press(IN.HK, facing, true);   // sweep
      return 0;
    }
    this.intent = 'space';
    this.intentLeft = 8 + this.rng.int(10);
    return pack(D.B, facing);
  }

  /** What to hold between decisions. */
  idleWord(match, me, opp, facing) {
    if (this.intentLeft > 0) {
      this.intentLeft--;
      switch (this.intent) {
        case 'approach': return pack(D.F, facing);
        case 'space':    return pack(D.B, facing);
        case 'block':    return pack(isAirborne(opp) ? D.B : D.DB, facing);
        default:         return 0;
      }
    }
    // Default posture. Holding back only guards while the opponent is
    // actually swinging; the rest of the time it just walks away, so it's
    // reserved for when there's something to guard against.
    const threat = isAttacking(opp) || Math.abs(opp.x - me.x) < 200;
    if (threat) return this.rng.chance(this.cfg.block) ? pack(D.B, facing) : 0;
    return 0;
  }
}

function firstButton(bits) {
  for (const b of [IN.HP, IN.LP, IN.HK, IN.LK, IN.SUPER]) {
    if (bits & b) return b;
  }
  return IN.LP;
}
