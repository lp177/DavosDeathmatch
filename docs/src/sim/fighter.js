/* ══════════════════════════════════════════════════════════════
   Fighter — state machine, physics and move execution.

   A fighter is plain mutable data (no closures, no class instances in
   the snapshot path beyond flat fields) so the whole thing can be
   copied cheaply for rollback. See constants.js for the determinism
   contract that governs this file.
   ══════════════════════════════════════════════════════════════ */

import {
  S, IN, HIT, GRAVITY, MAX_FALL, MAX_HEALTH, MAX_METER, WALK_FWD, WALK_BACK,
  JUMP_VY, JUMP_VX, JUMP_SQUAT, DASH_SPEED, DASH_FRAMES, BACKDASH_SPEED,
  BACKDASH_FRAMES, BACKDASH_INVULN, STAGE_HALF_W, PUSH_W, WAKEUP_FRAMES,
  KNOCKDOWN_FRAMES, DIZZY_THRESHOLD, DIZZY_DECAY, DIZZY_FRAMES, ATTACK_BITS,
} from './constants.js';
import { newMotionState, copyMotionState, pushInput, hasMotion, toNumpad } from './motion.js';

/* ── Hurtbox shapes by posture (x is centred on the fighter) ── */
export const HURT = {
  stand:  { x: -40, y: 4,  w: 80, h: 176 },
  crouch: { x: -44, y: 2,  w: 88, h: 116 },
  air:    { x: -38, y: 18, w: 76, h: 146 },
  down:   { x: -58, y: 0,  w: 116, h: 54 },
};

export function createFighter(id, char, x, facing) {
  return {
    id,
    charId: char.id,
    x, y: 0, vx: 0, vy: 0,
    facing,
    state: S.INTRO,
    stateFrame: 0,

    health: char.stats.health,
    maxHealth: char.stats.health,
    meter: 0,
    stun: 0,
    dizzyLeft: 0,

    moveId: null,
    moveFrame: 0,
    hitFlags: 0,          // bitmask: which hitboxes of the current move already connected
    cancelOk: false,      // set when the current move has landed and may be cancelled

    hitstun: 0,
    blockstun: 0,
    hitstop: 0,
    invuln: 0,
    armorHits: 0,
    armorFrames: 0,
    projInvuln: 0,

    comboCount: 0,
    comboDamage: 0,
    comboScale: 0,

    throwTech: 0,
    throwVictim: -1,
    thrownBy: -1,

    inputBuffer: 0,       // buffered attack bits (for late cancels / wake-up reversals)
    bufferAge: 99,

    jumpDir: 0,
    airActionsUsed: 0,
    landingLag: 0,
    blockHeld: false,
    lastBlocked: 0,

    superFreeze: 0,
    guardCrush: 0,

    wins: 0,
    perfectRound: true,
    totalDamage: 0,
    maxCombo: 0,
    hitsLanded: 0,

    motion: newMotionState(),
  };
}

export function copyFighter(f) {
  const c = { ...f };
  c.motion = copyMotionState(f.motion);
  return c;
}

/* ── Small predicates ─────────────────────────────────────── */

export const isAirborne = (f) => f.y > 0.001 || f.state === S.AIR || f.state === S.AIR_ATTACK;
export const isCrouching = (f) => f.state === S.CROUCH || f.state === S.BLOCK_LO;
export const isAttacking = (f) => f.state === S.ATTACK || f.state === S.AIR_ATTACK || f.state === S.THROWING;
export const isBlocking = (f) => f.state === S.BLOCK_HI || f.state === S.BLOCK_LO || f.state === S.BLOCKSTUN;
export const isStunned = (f) =>
  f.state === S.HITSTUN || f.state === S.BLOCKSTUN || f.state === S.KNOCKDOWN ||
  f.state === S.WAKEUP || f.state === S.THROWN || f.state === S.DIZZY;
export const isDead = (f) => f.health <= 0;

export function canAct(f) {
  if (f.hitstop > 0 || f.superFreeze > 0) return false;
  switch (f.state) {
    case S.IDLE: case S.WALK_F: case S.WALK_B: case S.CROUCH:
    case S.BLOCK_HI: case S.BLOCK_LO:
      return true;
    case S.AIR:
      return true;                       // air normals / air specials
    case S.ATTACK: case S.AIR_ATTACK:
      return f.cancelOk;
    default:
      return false;
  }
}

export function hurtbox(f) {
  if (f.state === S.KNOCKDOWN || f.state === S.WAKEUP) return HURT.down;
  if (isAirborne(f)) return HURT.air;
  if (isCrouching(f)) return HURT.crouch;
  return HURT.stand;
}

/** World-space AABB for a fighter-relative box, mirrored by facing. */
export function worldBox(f, box) {
  const x = f.facing > 0 ? f.x + box.x : f.x - box.x - box.w;
  return { x, y: f.y + box.y, w: box.w, h: box.h };
}

export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ── Move phase helpers ───────────────────────────────────── */

export function movePhase(move, frame) {
  if (frame < move.startup) return 'startup';
  if (frame < move.startup + move.active) return 'active';
  return 'recovery';
}

export function moveTotal(move) {
  return move.startup + move.active + move.recovery;
}

/* ══════════════════════════════════════════════════════════════
   Per-frame update. Split into stages so the match loop can
   interleave them correctly across both fighters.
   ══════════════════════════════════════════════════════════════ */

/** Stage 1 — tick timers and record this frame's input. */
export function tickTimers(f, word) {
  pushInput(f.motion, word, f.facing);

  if (f.hitstop > 0) { f.hitstop--; return; }
  if (f.superFreeze > 0) { f.superFreeze--; return; }

  if (f.invuln > 0) f.invuln--;
  if (f.projInvuln > 0) f.projInvuln--;
  if (f.armorFrames > 0) { f.armorFrames--; if (f.armorFrames === 0) f.armorHits = 0; }
  if (f.throwTech > 0) f.throwTech--;
  if (f.landingLag > 0) f.landingLag--;
  if (f.bufferAge < 99) f.bufferAge++;
  if (f.bufferAge > 9) f.inputBuffer = 0;

  // Stun bleeds off while not being hit, so pressure has to be sustained.
  if (f.hitstun === 0 && f.state !== S.DIZZY && f.stun > 0) {
    f.stun -= DIZZY_DECAY;
    if (f.stun < 0) f.stun = 0;
  }
  if (f.comboCount > 0 && f.hitstun === 0 && f.state !== S.THROWN) {
    f.comboCount = 0;
    f.comboDamage = 0;
    f.comboScale = 0;
  }
}

/**
 * Stage 2 — read intent and drive the state machine.
 * `opp` is only used for facing and proximity checks.
 */
export function updateFighter(f, opp, char, ctx) {
  if (f.hitstop > 0 || f.superFreeze > 0) return;

  const word = f.motion.hist[0];
  const prev = f.motion.hist[1];
  const pressed = word & ~prev;
  const dir = toNumpad(word, f.facing);
  const back = dir === 4 || dir === 1 || dir === 7;
  const down = dir === 2 || dir === 1 || dir === 3;
  const up = dir === 8 || dir === 7 || dir === 9;
  const fwd = dir === 6 || dir === 3 || dir === 9;

  // Buffer attack presses so inputs made a few frames early still come out.
  if (pressed & ATTACK_BITS) {
    f.inputBuffer = pressed & ATTACK_BITS;
    f.bufferAge = 0;
  }

  /* ── Stun / recovery states ───────────────────────────── */
  if (f.state === S.HITSTUN) {
    f.hitstun--;
    if (f.hitstun <= 0) {
      if (isAirborne(f)) { f.state = S.AIR; }
      else if (f.stun >= DIZZY_THRESHOLD) { enterDizzy(f); }
      else { f.state = S.IDLE; f.stateFrame = 0; }
    }
    applyPhysics(f);
    return;
  }
  if (f.state === S.BLOCKSTUN) {
    f.blockstun--;
    if (f.blockstun <= 0) { f.state = down ? S.BLOCK_LO : S.BLOCK_HI; f.stateFrame = 0; }
    applyPhysics(f);
    return;
  }
  if (f.state === S.THROWN) {
    f.stateFrame++;
    applyPhysics(f);
    if (f.y <= 0 && f.stateFrame > 4) { knockdown(f); }
    return;
  }
  if (f.state === S.KNOCKDOWN) {
    f.stateFrame++;
    f.vx *= 0.82;
    applyPhysics(f);
    if (f.stateFrame >= KNOCKDOWN_FRAMES) { f.state = S.WAKEUP; f.stateFrame = 0; f.invuln = 4; }
    return;
  }
  if (f.state === S.WAKEUP) {
    f.stateFrame++;
    f.vx *= 0.7;
    applyPhysics(f);
    if (f.stateFrame >= WAKEUP_FRAMES) {
      f.state = S.IDLE; f.stateFrame = 0;
      // A buffered reversal on wake-up is a fighting-game staple.
      if (f.inputBuffer) tryAttack(f, opp, char, ctx, f.inputBuffer);
    }
    return;
  }
  if (f.state === S.DIZZY) {
    f.dizzyLeft--;
    f.stateFrame++;
    // Mashing shortens the dizzy — gives the player something to do.
    if (pressed & (ATTACK_BITS | IN.LEFT | IN.RIGHT)) f.dizzyLeft -= 3;
    f.vx *= 0.8;
    applyPhysics(f);
    if (f.dizzyLeft <= 0) { f.state = S.IDLE; f.stateFrame = 0; f.stun = 0; f.invuln = 12; }
    return;
  }
  if (f.state === S.KO || f.state === S.VICTORY || f.state === S.INTRO ||
      f.state === S.ROUND_FREEZE) {
    f.stateFrame++;
    f.vx *= 0.9;
    applyPhysics(f);
    return;
  }

  /* ── Attacks in progress ──────────────────────────────── */
  if (f.state === S.ATTACK || f.state === S.AIR_ATTACK || f.state === S.THROWING) {
    const move = char.moves[f.moveId];
    // Velocity is applied for the frame we are about to run, then the
    // counter advances. Doing it the other way round would silently skip
    // every `{f: 0}` curve entry — which is most uppercuts and rushes.
    applyMoveVelocity(f, move);
    f.moveFrame++;

    // Cancel windows: land a hit, then buffer the follow-up.
    if (f.cancelOk && f.inputBuffer) {
      if (tryAttack(f, opp, char, ctx, f.inputBuffer, move)) return;
    }
    if (f.moveFrame >= moveTotal(move)) {
      endMove(f);
    }
    applyPhysics(f);
    return;
  }

  /* ── Dashes ───────────────────────────────────────────── */
  if (f.state === S.DASH_F || f.state === S.DASH_B) {
    f.stateFrame++;
    const len = f.state === S.DASH_F ? DASH_FRAMES : BACKDASH_FRAMES;
    // Dashes can be cancelled into attacks after a few frames.
    if (f.stateFrame > 4 && f.inputBuffer && tryAttack(f, opp, char, ctx, f.inputBuffer)) return;
    if (f.stateFrame >= len) { f.state = S.IDLE; f.stateFrame = 0; f.vx = 0; }
    applyPhysics(f);
    return;
  }

  /* ── Jump squat ───────────────────────────────────────── */
  if (f.state === S.JUMPSQUAT) {
    f.stateFrame++;
    if (f.stateFrame >= JUMP_SQUAT) {
      f.state = S.AIR;
      f.stateFrame = 0;
      f.vy = JUMP_VY * (char.stats.jump ?? 1);
      f.vx = f.jumpDir * JUMP_VX;
      f.airActionsUsed = 0;
      ctx.sfx('jump', f);
    }
    applyPhysics(f);
    return;
  }

  /* ── Landing recovery ─────────────────────────────────── */
  if (f.state === S.LANDING) {
    f.stateFrame++;
    f.vx *= 0.6;
    if (f.stateFrame >= 3) { f.state = S.IDLE; f.stateFrame = 0; }
    applyPhysics(f);
    return;
  }

  /* ── Airborne ─────────────────────────────────────────── */
  if (f.state === S.AIR) {
    f.stateFrame++;
    if (f.inputBuffer && tryAttack(f, opp, char, ctx, f.inputBuffer)) return;
    applyPhysics(f);
    if (f.y <= 0) landFighter(f, ctx);
    return;
  }

  /* ── Grounded neutral ─────────────────────────────────── */

  // Specials and normals first — they take priority over movement.
  if (f.inputBuffer && tryAttack(f, opp, char, ctx, f.inputBuffer)) return;

  // Jump.
  if (up) {
    f.state = S.JUMPSQUAT;
    f.stateFrame = 0;
    f.jumpDir = fwd ? f.facing : (back ? -f.facing : 0);
    applyPhysics(f);
    return;
  }

  // Dash: double-tap forward / back.
  if (detectDoubleTap(f, true)) {
    f.state = S.DASH_F; f.stateFrame = 0; f.vx = f.facing * DASH_SPEED;
    ctx.sfx('dash', f);
    applyPhysics(f);
    return;
  }
  if (detectDoubleTap(f, false)) {
    f.state = S.DASH_B; f.stateFrame = 0; f.vx = f.facing * BACKDASH_SPEED;
    f.invuln = Math.max(f.invuln, BACKDASH_INVULN);
    ctx.sfx('dash', f);
    applyPhysics(f);
    return;
  }

  // Taunt — pure juice, small meter gain, punishable.
  if ((pressed & IN.TAUNT) && !down) {
    f.state = S.TAUNT; f.stateFrame = 0;
    f.meter = Math.min(MAX_METER, f.meter + 40);
    ctx.taunt(f);
  }
  if (f.state === S.TAUNT) {
    f.stateFrame++;
    f.vx *= 0.7;
    if (f.stateFrame > 44 || (pressed & ATTACK_BITS)) { f.state = S.IDLE; f.stateFrame = 0; }
    applyPhysics(f);
    return;
  }

  // Crouch / block / walk.
  const threatened = opp && isAttacking(opp);
  if (down) {
    f.state = (back && threatened) ? S.BLOCK_LO : S.CROUCH;
    f.vx = 0;
  } else if (back) {
    f.state = threatened ? S.BLOCK_HI : S.WALK_B;
    f.vx = -f.facing * WALK_BACK * (char.stats.speed ?? 1);
    if (f.state === S.BLOCK_HI) f.vx = 0;
  } else if (fwd) {
    f.state = S.WALK_F;
    f.vx = f.facing * WALK_FWD * (char.stats.speed ?? 1);
  } else {
    f.state = S.IDLE;
    f.vx *= 0.6;
  }
  f.blockHeld = back;
  f.stateFrame++;
  applyPhysics(f);
}

/* ── Movement plumbing ────────────────────────────────────── */

function detectDoubleTap(f, forward) {
  const d = f.motion.dirs;
  const want = forward ? 6 : 4;
  // Pattern: tap → release → tap, all inside ~14 frames.
  if (d[0] !== want && !(forward ? (d[0] === 3 || d[0] === 9) : (d[0] === 1 || d[0] === 7))) return false;
  if (d[1] === d[0]) return false;   // must be the first frame of the second tap
  let sawNeutral = false;
  for (let i = 1; i < 14; i++) {
    const cur = d[i];
    const isWant = cur === want;
    if (!isWant && !sawNeutral) { sawNeutral = true; continue; }
    if (isWant && sawNeutral) return true;
    if (isWant && !sawNeutral) return false;
  }
  return false;
}

function applyMoveVelocity(f, move) {
  if (!move.curve) return;
  for (let i = 0; i < move.curve.length; i++) {
    const c = move.curve[i];
    if (f.moveFrame === c.f) {
      if (c.vx != null) f.vx = f.facing * c.vx;
      if (c.vy != null) f.vy = c.vy;
      if (c.grav != null) f.noGravity = c.grav === 0;
    }
  }
}

export function applyPhysics(f) {
  const air = f.y > 0.001 || f.vy > 0;
  if (air && !f.noGravity) {
    f.vy += GRAVITY;
    if (f.vy < MAX_FALL) f.vy = MAX_FALL;
  }
  f.x += f.vx;
  f.y += f.vy;

  if (f.y <= 0) {
    f.y = 0;
    if (f.vy < 0) f.vy = 0;
  }
  if (!air) f.vx *= 0.9;

  const limit = STAGE_HALF_W - PUSH_W;
  if (f.x < -limit) { f.x = -limit; if (f.vx < 0) f.vx = 0; }
  if (f.x > limit) { f.x = limit; if (f.vx > 0) f.vx = 0; }
}

function landFighter(f, ctx) {
  f.y = 0;
  f.vy = 0;
  f.noGravity = false;
  f.state = S.LANDING;
  f.stateFrame = 0;
  f.airActionsUsed = 0;
  ctx.land(f);
}

export function endMove(f) {
  f.moveId = null;
  f.moveFrame = 0;
  f.hitFlags = 0;
  f.cancelOk = false;
  f.noGravity = false;
  f.inputBuffer = 0;
  if (f.y > 0.001) { f.state = S.AIR; }
  else { f.state = S.IDLE; f.vy = 0; }
  f.stateFrame = 0;
}

export function knockdown(f) {
  f.state = S.KNOCKDOWN;
  f.stateFrame = 0;
  f.vy = 0;
  f.y = 0;
  f.hitstun = 0;
  f.moveId = null;
}

function enterDizzy(f) {
  f.state = S.DIZZY;
  f.stateFrame = 0;
  f.dizzyLeft = DIZZY_FRAMES;
  f.stun = 0;
  f.moveId = null;
}

/* ══════════════════════════════════════════════════════════════
   Move selection

   Priority: super → specials (most complex motion first) → command
   normals → plain normals. First match whose motion, button, stance,
   meter and cancel rules are all satisfied wins.
   ══════════════════════════════════════════════════════════════ */

export function tryAttack(f, opp, char, ctx, buttons, fromMove = null) {
  const airborne = isAirborne(f);
  // Stance comes from what the player is holding right now, not from the
  // state machine. On the frame a move ends the state is briefly IDLE, so
  // reading state here would hand you a standing normal while you are very
  // clearly holding down.
  const d = toNumpad(f.motion.hist[0], f.facing);
  const crouching = d === 1 || d === 2 || d === 3;
  const stance = airborne ? 'air' : (crouching ? 'crouch' : 'stand');

  for (let i = 0; i < char.order.length; i++) {
    const id = char.order[i];
    const mv = char.moves[id];
    if (!mv.input) continue;
    const need = mv.input;

    if (!(buttons & need.button)) continue;
    if (need.stance && need.stance !== stance) continue;
    if (!need.stance && need.airOk !== true && airborne) continue;
    if (need.airOnly && !airborne) continue;
    if (mv.meterCost && f.meter < mv.meterCost) continue;

    // The dedicated Super button IS the input — pressing it should fire the
    // super on its own, without also drawing the motion. Supers are still
    // available the traditional way (double quarter-circle + punch) for
    // players who want to buffer them out of a combo.
    const superShortcut = mv.tier === 'super' && (buttons & IN.SUPER) !== 0;
    if (!superShortcut &&
        need.motion && need.motion !== 'none' &&
        !hasMotion(f.motion, need.motion)) continue;

    // Command throws only come out when you're holding forward AND in
    // range — otherwise the button falls through to the normal, which is
    // what players expect from every fighting game ever made.
    if (mv.requiresForward) {
      const d = toNumpad(f.motion.hist[0], f.facing);
      if (d !== 6 && d !== 3 && d !== 9) continue;
      // Out of range, fall through to the normal rather than whiffing a
      // throw — the range here matches the one tryThrow will apply.
      if (!opp || Math.abs(opp.x - f.x) > (mv.range ?? 98)) continue;
    }

    // Cancel legality: what may this move be cancelled from?
    if (fromMove) {
      const allowed = fromMove.cancel || [];
      if (!allowed.includes(mv.tier)) continue;
      if (mv.tier === fromMove.tier && mv.tier === 'normal') continue;
    }
    // Air actions are limited so you can't chain five air specials.
    if (airborne && mv.tier !== 'normal') {
      if (f.airActionsUsed >= 1) continue;
      f.airActionsUsed++;
    }

    startMove(f, char, id, ctx);
    return true;
  }
  return false;
}

export function startMove(f, char, id, ctx) {
  const mv = char.moves[id];
  f.moveId = id;
  f.moveFrame = 0;
  f.hitFlags = 0;
  f.cancelOk = false;
  f.inputBuffer = 0;
  f.bufferAge = 99;
  f.state = mv.isThrow ? S.THROWING : (isAirborne(f) ? S.AIR_ATTACK : S.ATTACK);
  f.stateFrame = 0;

  if (mv.meterCost) f.meter -= mv.meterCost;
  if (mv.invuln) f.invuln = Math.max(f.invuln, mv.invuln);
  if (mv.projInvuln) f.projInvuln = Math.max(f.projInvuln, mv.projInvuln);
  if (mv.armor) { f.armorHits = mv.armor.hits; f.armorFrames = mv.armor.frames; }
  if (mv.freeze) f.superFreeze = 0;   // the attacker acts; opponents are frozen by the match
  if (!isAirborne(f) && !mv.keepMomentum) f.vx = 0;

  ctx.moveStart(f, mv);
}

/* ── Meter ───────────────────────────────────────────────── */

export function addMeter(f, amount) {
  f.meter += amount;
  if (f.meter > MAX_METER) f.meter = MAX_METER;
  if (f.meter < 0) f.meter = 0;
}

/* ── Damage application ──────────────────────────────────── */

export function damageScale(f) {
  const idx = f.comboCount;
  const table = [1, 1, 0.9, 0.8, 0.72, 0.65, 0.58, 0.52, 0.46, 0.4, 0.35, 0.3];
  return idx < table.length ? table[idx] : 0.22;
}

export { MAX_HEALTH, MAX_METER, HIT };
