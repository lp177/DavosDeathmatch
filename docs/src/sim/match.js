/* ══════════════════════════════════════════════════════════════
   Match — the whole simulated world for one fight.

   Owns both fighters, projectiles, the round clock and the RNG. One
   call to step() advances exactly one 60Hz tick given both players'
   command words.

   Everything the presentation layer needs to react to is pushed onto
   `this.events`, which the caller drains. During rollback re-simulation
   the caller passes emit=false so effects and sounds don't replay.
   ══════════════════════════════════════════════════════════════ */

import {
  S, IN, HIT, TICK_HZ, STAGE_HALF_W, PUSH_W, MAX_METER, MAX_HEALTH,
  ROUND_INTRO_FRAMES, ROUND_END_FRAMES, THROW_RANGE, THROW_TECH_WINDOW,
  DIZZY_THRESHOLD, CHIP_DIVISOR, ATTACK_BITS,
  KNOCKOFF_ZONE, KNOCKOFF_PUSH, KNOCKOFF_DAMAGE, KNOCKOFF_FALL, KNOCKOFF_LAND,
  KNOCKOFF_TOTAL,
} from './constants.js';
import {
  createFighter, copyFighter, tickTimers, updateFighter, applyPhysics,
  hurtbox, worldBox, aabb, isAirborne, isCrouching, isAttacking, isStunned,
  movePhase, moveTotal, endMove, knockdown, addMeter, damageScale, startMove,
} from './fighter.js';
import { Rng } from '../core/rng.js';
import { ROSTER } from '../data/roster.js';

let PROJ_ID = 1;

export class Match {
  /**
   * @param {object} cfg
   *   chars      [string, string]  roster ids
   *   stage      string
   *   seed       number            shared RNG seed (must match across peers)
   *   rounds     number            best-of
   *   roundTime  number            seconds, 0 = infinite
   *   hitstopScale number          synced so both peers agree
   *   training   boolean
   */
  constructor(cfg) {
    this.cfg = {
      rounds: 3, roundTime: 99, hitstopScale: 1, training: false,
      stage: 'congress', seed: 12345, ...cfg,
    };
    this.chars = [ROSTER[this.cfg.chars[0]], ROSTER[this.cfg.chars[1]]];
    this.rng = new Rng(this.cfg.seed);

    this.frame = 0;
    this.round = 1;
    this.wins = [0, 0];
    this.needed = Math.ceil(this.cfg.rounds / 2);
    this.events = [];
    this.hitstop = 0;
    this.superFreeze = 0;
    this.superFreezeOwner = -1;
    this.over = false;
    this.result = null;
    this.tier = 0;
    this.maxTier = 1;

    this.fighters = [
      createFighter(0, this.chars[0], -280, 1),
      createFighter(1, this.chars[1], 280, -1),
    ];
    this.projectiles = [];
    this.startRound(1, false);
  }

  /* ── Round lifecycle ──────────────────────────────────── */

  startRound(n, emit = true) {
    this.round = n;
    this.phase = 'intro';
    this.phaseFrame = 0;
    this.timer = this.cfg.roundTime > 0 ? this.cfg.roundTime * TICK_HZ : -1;
    this.projectiles.length = 0;
    this.announcedFight = false;
    this.lowTimeWarned = false;

    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const c = this.chars[i];
      f.x = i === 0 ? -280 : 280;
      f.y = 0; f.vx = 0; f.vy = 0;
      f.facing = i === 0 ? 1 : -1;
      f.health = c.stats.health;
      f.maxHealth = c.stats.health;
      f.stun = 0;
      f.dizzyLeft = 0;
      f.state = S.INTRO;
      f.stateFrame = 0;
      f.moveId = null;
      f.moveFrame = 0;
      f.hitFlags = 0;
      f.hitstun = 0; f.blockstun = 0; f.hitstop = 0;
      f.invuln = 0; f.projInvuln = 0; f.armorHits = 0; f.armorFrames = 0;
      f.comboCount = 0; f.comboDamage = 0;
      f.perfectRound = true;
      f.noGravity = false;
      // Meter carries between rounds — rewards a strong round.
      f.meter = Math.min(MAX_METER, f.meter);
    }
    if (emit) this.emit({ type: 'roundStart', round: n });
  }

  /* ── Snapshot / restore for rollback ──────────────────── */

  snapshot() {
    return {
      frame: this.frame,
      round: this.round,
      wins: this.wins.slice(),
      phase: this.phase,
      phaseFrame: this.phaseFrame,
      timer: this.timer,
      hitstop: this.hitstop,
      superFreeze: this.superFreeze,
      superFreezeOwner: this.superFreezeOwner,
      over: this.over,
      result: this.result,
      tier: this.tier,
      announcedFight: this.announcedFight,
      lowTimeWarned: this.lowTimeWarned,
      rng: this.rng.snapshot(),
      fighters: [copyFighter(this.fighters[0]), copyFighter(this.fighters[1])],
      projectiles: this.projectiles.map((p) => ({ ...p })),
    };
  }

  restore(s) {
    this.frame = s.frame;
    this.round = s.round;
    this.wins = s.wins.slice();
    this.phase = s.phase;
    this.phaseFrame = s.phaseFrame;
    this.timer = s.timer;
    this.hitstop = s.hitstop;
    this.superFreeze = s.superFreeze;
    this.superFreezeOwner = s.superFreezeOwner;
    this.over = s.over;
    this.result = s.result;
    this.tier = s.tier;
    this.announcedFight = s.announcedFight;
    this.lowTimeWarned = s.lowTimeWarned;
    this.rng.restore(s.rng);
    this.fighters = [copyFighter(s.fighters[0]), copyFighter(s.fighters[1])];
    this.projectiles = s.projectiles.map((p) => ({ ...p }));
  }

  /** Cheap rolling checksum, compared with the peer to catch desyncs. */
  checksum() {
    let h = 2166136261;
    const mix = (v) => {
      h ^= (v | 0);
      h = Math.imul(h, 16777619);
    };
    for (const f of this.fighters) {
      mix(Math.round(f.x * 16)); mix(Math.round(f.y * 16));
      mix(Math.round(f.vx * 16)); mix(Math.round(f.vy * 16));
      mix(f.state); mix(f.stateFrame); mix(Math.round(f.health));
      mix(Math.round(f.meter)); mix(f.hitstun); mix(f.blockstun);
      mix(f.moveFrame); mix(f.hitFlags); mix(f.facing);
    }
    mix(this.projectiles.length);
    for (const p of this.projectiles) {
      mix(Math.round(p.x * 8)); mix(Math.round(p.y * 8)); mix(p.life);
    }
    mix(this.frame); mix(this.timer | 0); mix(this.tier); mix(this.rng.snapshot());
    return h >>> 0;
  }

  /* ── Event plumbing ───────────────────────────────────── */

  emit(ev) {
    if (this._emit) this.events.push(ev);
  }

  _ctx() {
    const self = this;
    return {
      sfx: (name, f, opts) => self.emit({ type: 'sfx', name, x: f.x, y: f.y, ...opts }),
      land: (f) => self.emit({ type: 'land', x: f.x, y: 0, hard: f.vy < -16 }),
      taunt: (f) => self.emit({ type: 'taunt', fighter: f.id, x: f.x, y: f.y }),
      moveStart: (f, mv) => {
        self.emit({ type: 'moveStart', fighter: f.id, move: mv, x: f.x, y: f.y });
        if (mv.freeze) {
          self.superFreeze = mv.freeze;
          self.superFreezeOwner = f.id;
          self.emit({ type: 'superFlash', fighter: f.id, move: mv, x: f.x, y: f.y });
        }
      },
      spawn: (f, spec) => self.spawnProjectile(f, spec),
    };
  }

  /* ══════════════════════════════════════════════════════
     One simulation tick.
     @param {number[]} inputs  [p0Word, p1Word]
     @param {boolean} emit     false while re-simulating a rollback
     ══════════════════════════════════════════════════════ */
  step(inputs, emit = true) {
    this._emit = emit;
    this.events.length = 0;
    const ctx = this._ctx();
    const [f0, f1] = this.fighters;

    /* — Global freezes — */
    if (this.hitstop > 0) {
      this.hitstop--;
      // Inputs still feed the motion buffer during hit-stop so players can
      // buffer their combo continuation, exactly like a real fighting game.
      tickTimers(f0, inputs[0]);
      tickTimers(f1, inputs[1]);
      this.frame++;
      return;
    }
    if (this.superFreeze > 0) {
      this.superFreeze--;
      tickTimers(f0, inputs[0]);
      tickTimers(f1, inputs[1]);
      const owner = this.fighters[this.superFreezeOwner];
      if (owner) { owner.hitstop = 0; owner.superFreeze = 0; }
      if (this.superFreeze === 0) this.superFreezeOwner = -1;
      this.frame++;
      return;
    }

    /* — Phase machine — */
    this.phaseFrame++;
    if (this.phase === 'intro') {
      this.stepIntro();
    } else if (this.phase === 'fight') {
      this.stepFight(inputs, ctx);
    } else if (this.phase === 'ko') {
      this.stepKo(inputs, ctx);
    } else if (this.phase === 'roundend') {
      this.stepRoundEnd();
    } else if (this.phase === 'matchend') {
      this.stepMatchEnd();
    } else if (this.phase === 'knockoff') {
      this.stepKnockoff(inputs, ctx);
    }

    this.frame++;
  }

  stepIntro() {
    const done = this.phaseFrame >= ROUND_INTRO_FRAMES;
    if (this.phaseFrame === 30) {
      this.emit({ type: 'announce', text: roundName(this.round), big: false });
    }
    // Pre-fight trash talk, first round only — one line each, taking turns.
    // Derived from the seed rather than the RNG so it costs no simulation
    // state and can't drift across a rollback.
    if (this.round === 1) {
      const first = this.cfg.seed & 1;
      if (this.phaseFrame === 62) this.emit({ type: 'trashTalk', fighter: first });
      if (this.phaseFrame === 112) this.emit({ type: 'trashTalk', fighter: 1 - first });
    }
    if (done) {
      this.phase = 'fight';
      this.phaseFrame = 0;
      for (const f of this.fighters) { f.state = S.IDLE; f.stateFrame = 0; }
      this.emit({ type: 'announce', text: 'FIGHT!', big: true });
      this.emit({ type: 'sfx', name: 'bell', x: 0, y: 0 });
      this.announcedFight = true;
    } else {
      for (const f of this.fighters) { f.stateFrame++; applyPhysics(f); }
    }
  }

  stepFight(inputs, ctx) {
    const [f0, f1] = this.fighters;

    tickTimers(f0, inputs[0]);
    tickTimers(f1, inputs[1]);

    updateFighter(f0, f1, this.chars[0], ctx);
    updateFighter(f1, f0, this.chars[1], ctx);

    this.updateFacing();
    this.pushApart();
    this.updateProjectiles(ctx);
    this.resolveCombat(ctx);
    this.spawnScheduled(ctx);

    /* — Clock — */
    if (this.timer > 0) {
      this.timer--;
      const secs = Math.ceil(this.timer / TICK_HZ);
      if (secs <= 10 && !this.lowTimeWarned) {
        this.lowTimeWarned = true;
        this.emit({ type: 'timeLow' });
      }
      if (this.timer === 0) this.endRoundByTime();
    }

    /* — KO check — */
    for (let i = 0; i < 2; i++) {
      if (this.fighters[i].health <= 0 && this.phase === 'fight') {
        this.beginKo(1 - i);
        break;
      }
    }
  }

  beginKo(winner) {
    this.phase = 'ko';
    this.phaseFrame = 0;
    this.koWinner = winner;
    const loser = this.fighters[1 - winner];
    loser.health = 0;
    loser.state = S.KO;
    loser.stateFrame = 0;
    loser.moveId = null;
    loser.vy = Math.max(loser.vy, 9);
    loser.vx = -loser.facing * 5;
    this.fighters[winner].perfectRound = this.fighters[winner].health >= this.fighters[winner].maxHealth;
    this.hitstop = 22;
    this.emit({ type: 'ko', winner, x: loser.x, y: loser.y });
  }

  stepKo(inputs, ctx) {
    const [f0, f1] = this.fighters;
    tickTimers(f0, inputs[0]);
    tickTimers(f1, inputs[1]);
    for (const f of this.fighters) {
      if (f.state === S.KO) { f.stateFrame++; applyPhysics(f); if (f.y <= 0) { f.y = 0; f.vy = 0; f.vx *= 0.8; } }
      else { f.stateFrame++; f.vx *= 0.85; applyPhysics(f); }
    }
    this.updateProjectiles(ctx);

    if (this.phaseFrame === 60) {
      const w = this.fighters[this.koWinner];
      w.state = S.VICTORY;
      w.stateFrame = 0;
      this.emit({ type: 'victoryPose', fighter: w.id });
    }
    if (this.phaseFrame >= 120) this.awardRound(this.koWinner);
  }

  endRoundByTime() {
    const [a, b] = this.fighters;
    const pa = a.health / a.maxHealth;
    const pb = b.health / b.maxHealth;
    this.emit({ type: 'announce', text: 'TIME UP', big: true });
    if (Math.abs(pa - pb) < 0.001) {
      this.phase = 'roundend';
      this.phaseFrame = 0;
      this.drawRound = true;
      this.wins[0] += 0; this.wins[1] += 0;
      this.emit({ type: 'draw' });
    } else {
      this.beginKo(pa > pb ? 0 : 1);
    }
  }

  awardRound(winner) {
    this.wins[winner]++;
    const w = this.fighters[winner];
    const perfect = w.health >= w.maxHealth;
    this.emit({
      type: 'roundOver', winner, perfect,
      wins: this.wins.slice(), round: this.round,
    });
    if (this.wins[winner] >= this.needed) {
      this.phase = 'matchend';
      this.phaseFrame = 0;
      this.over = true;
      this.result = { winner, wins: this.wins.slice(), rounds: this.round };
      this.emit({ type: 'matchOver', winner, result: this.result });
    } else {
      this.phase = 'roundend';
      this.phaseFrame = 0;
    }
  }

  stepRoundEnd() {
    for (const f of this.fighters) { f.stateFrame++; f.vx *= 0.9; applyPhysics(f); }
    if (this.phaseFrame >= ROUND_END_FRAMES) this.startRound(this.round + 1);
  }

  stepMatchEnd() {
    for (const f of this.fighters) { f.stateFrame++; f.vx *= 0.9; applyPhysics(f); }
  }

  /* ── Facing, pushboxes ────────────────────────────────── */

  updateFacing() {
    const [a, b] = this.fighters;
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const o = this.fighters[1 - i];
      // Facing only flips while genuinely neutral, so combos don't reverse.
      const free = f.state === S.IDLE || f.state === S.WALK_F || f.state === S.WALK_B ||
                   f.state === S.CROUCH || f.state === S.WAKEUP;
      if (!free) continue;
      const want = o.x >= f.x ? 1 : -1;
      if (want !== f.facing && Math.abs(o.x - f.x) > 8) f.facing = want;
    }
  }

  pushApart() {
    const [a, b] = this.fighters;
    if (a.state === S.KO || b.state === S.KO) return;
    const dx = b.x - a.x;
    const dist = dx < 0 ? -dx : dx;
    const minDist = PUSH_W;
    if (dist >= minDist) return;
    // Airborne fighters get pushed less; the grounded one holds ground.
    const overlap = (minDist - dist) * 0.5;
    const dir = dx >= 0 ? 1 : -1;
    const aAir = isAirborne(a), bAir = isAirborne(b);
    let aPush = overlap, bPush = overlap;
    if (aAir && !bAir) { aPush = overlap * 1.6; bPush = overlap * 0.35; }
    if (bAir && !aAir) { bPush = overlap * 1.6; aPush = overlap * 0.35; }
    a.x -= dir * aPush;
    b.x += dir * bPush;

    const limit = STAGE_HALF_W - PUSH_W;
    // If one is cornered, the other absorbs the full push instead.
    if (a.x < -limit) { const d = -limit - a.x; a.x = -limit; b.x += d; }
    if (b.x < -limit) { const d = -limit - b.x; b.x = -limit; a.x += d; }
    if (a.x > limit) { const d = a.x - limit; a.x = limit; b.x -= d; }
    if (b.x > limit) { const d = b.x - limit; b.x = limit; a.x -= d; }
  }

  /* ── Projectiles ──────────────────────────────────────── */

  spawnProjectile(f, spec) {
    // `aim: true` measures the spawn from the OPPONENT instead of the owner.
    //
    // Anything that falls out of the sky has to land where the target actually
    // is. Offsetting from the caster means the strike only connects at one
    // exact spacing — at every other distance it lands on empty floor and the
    // move reads as doing nothing at all, which is precisely how Macron's
    // super behaved: a light show at fixed range, harmless the rest of the time.
    const origin = spec.aim ? this.fighters[1 - f.id].x : f.x;
    const p = {
      id: PROJ_ID++,
      owner: f.id,
      kind: spec.kind || 'orb',
      x: origin + f.facing * (spec.x ?? 60),
      y: f.y + (spec.y ?? 100),
      vx: f.facing * (spec.vx ?? 9),
      vy: spec.vy ?? 0,
      grav: spec.grav ?? 0,
      w: spec.w ?? 54, h: spec.h ?? 46,
      life: spec.life ?? 120,
      age: 0,
      damage: spec.damage ?? 60,
      chip: spec.chip ?? 8,
      hitstun: spec.hitstun ?? 16,
      blockstun: spec.blockstun ?? 12,
      hitstop: spec.hitstop ?? 8,
      push: spec.push ?? { x: 6, y: 0 },
      hitType: spec.hitType ?? HIT.MID,
      stun: spec.stun ?? 6,
      hp: spec.hp ?? 1,
      pierce: spec.pierce ?? false,
      homing: spec.homing ?? 0,
      facing: f.facing,
      color: spec.color ?? '#ffc64d',
      scale: spec.scale ?? 1,
      spin: spec.spin ?? 0,
      wobble: spec.wobble ?? 0,
      hitOnce: spec.hitOnce !== false,
      hitList: 0,
      // Multi-hit projectiles need a cooldown, otherwise they connect on
      // every single overlapping frame and delete a health bar instantly.
      hitEvery: spec.hitEvery ?? 9,
      lastHit: -999,
      knockdown: spec.knockdown ?? false,
      drainsMeter: spec.drainsMeter ?? 0,
      explodeOnLand: spec.explodeOnLand ?? false,
      explode: spec.explode ?? null,
      sfx: spec.sfx ?? null,
      quote: spec.quote ?? null,
    };
    this.projectiles.push(p);
    this.emit({ type: 'projSpawn', proj: p });
    if (p.sfx) this.emit({ type: 'sfx', name: p.sfx, x: p.x, y: p.y });
    return p;
  }

  updateProjectiles(ctx) {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age++;
      if (p.homing) {
        const target = this.fighters[1 - p.owner];
        const ty = target.y + 80;
        p.vy += (ty > p.y ? 1 : -1) * p.homing;
      }
      p.vy += p.grav;
      p.x += p.vx;
      p.y += p.vy;

      let dead = false;
      if (p.age >= p.life) dead = true;
      if (p.x < -STAGE_HALF_W - 160 || p.x > STAGE_HALF_W + 160) dead = true;
      if (p.y < 0) {
        if (p.explodeOnLand) {
          this.detonate(p);
          dead = true;
        } else if (p.grav !== 0) {
          dead = true;
        }
      }
      if (dead) {
        if (!p.exploded) this.emit({ type: 'projGone', proj: p });
        list.splice(i, 1);
      }
    }

    // Projectile clash: opposing shots trade hit points.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.owner === b.owner) continue;
        if (!aabb(projBox(a), projBox(b))) continue;
        a.hp--; b.hp--;
        this.emit({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        this.hitstop = Math.max(this.hitstop, 4);
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hp <= 0) {
        this.emit({ type: 'projGone', proj: list[i] });
        list.splice(i, 1);
      }
    }
  }

  detonate(p) {
    p.exploded = true;
    const spec = p.explode || {};
    this.emit({ type: 'explosion', x: p.x, y: Math.max(0, p.y), size: spec.size ?? 1, color: p.color });
    this.emit({ type: 'sfx', name: 'explosion', x: p.x, y: p.y, size: spec.size ?? 1 });
    const blast = {
      x: p.x - (spec.radius ?? 110),
      y: 0,
      w: (spec.radius ?? 110) * 2,
      h: spec.height ?? 190,
    };
    const target = this.fighters[1 - p.owner];
    if (aabb(blast, worldBox(target, hurtbox(target)))) {
      this.applyHit(this.fighters[p.owner], target, {
        damage: spec.damage ?? p.damage,
        chip: spec.chip ?? 14,
        hitstun: 24, blockstun: 16, hitstop: 12,
        push: { x: 11, y: 8 }, hitType: HIT.MID, stun: 14,
        name: 'blast', knockdown: true,
      }, p.x, 90);
    }
  }

  /* ── Combat resolution ────────────────────────────────── */

  resolveCombat(ctx) {
    for (let i = 0; i < 2; i++) {
      const atk = this.fighters[i];
      const def = this.fighters[1 - i];
      if (!atk.moveId) continue;
      if (atk.hitstop > 0) continue;
      const mv = this.chars[i].moves[atk.moveId];
      if (!mv.boxes) continue;

      for (let b = 0; b < mv.boxes.length; b++) {
        const box = mv.boxes[b];
        if (atk.moveFrame < box.f0 || atk.moveFrame > box.f1) continue;
        const bit = 1 << b;
        if (atk.hitFlags & bit) continue;

        if (mv.isThrow) {
          if (this.tryThrow(atk, def, mv, box)) { atk.hitFlags |= bit; }
          continue;
        }

        const hb = worldBox(atk, box);
        const target = worldBox(def, hurtbox(def));
        if (!aabb(hb, target)) continue;

        atk.hitFlags |= bit;
        const cx = (Math.max(hb.x, target.x) + Math.min(hb.x + hb.w, target.x + target.w)) / 2;
        const cy = (Math.max(hb.y, target.y) + Math.min(hb.y + hb.h, target.y + target.h)) / 2;
        this.applyHit(atk, def, { ...mv, ...box }, cx, cy);
      }
    }

    // Projectiles vs fighters.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const def = this.fighters[1 - p.owner];
      const flag = 1 << def.id;
      if (p.hitOnce && (p.hitList & flag)) continue;
      if (!p.hitOnce && this.frame - p.lastHit < p.hitEvery) continue;
      if (def.projInvuln > 0 || def.invuln > 0) continue;
      if (def.state === S.KO) continue;
      if (!aabb(projBox(p), worldBox(def, hurtbox(def)))) continue;

      p.hitList |= flag;
      p.lastHit = this.frame;
      this.applyHit(this.fighters[p.owner], def, {
        damage: p.damage, chip: p.chip, hitstun: p.hitstun, blockstun: p.blockstun,
        hitstop: p.hitstop, push: p.push, hitType: p.hitType, stun: p.stun,
        name: p.kind, isProjectile: true, knockdown: p.knockdown,
        drainsMeter: p.drainsMeter,
      }, p.x, p.y + p.h / 2);

      if (!p.pierce) {
        p.hp--;
        if (p.hp <= 0) {
          if (p.explode) this.detonate(p);
          this.emit({ type: 'projGone', proj: p });
          this.projectiles.splice(i, 1);
        }
      }
    }
  }

  tryThrow(atk, def, mv, box) {
    const dist = Math.abs(def.x - atk.x);
    if (dist > (mv.range ?? THROW_RANGE)) return false;
    if (isAirborne(def) && !mv.airThrow) return false;
    if (def.invuln > 0) return false;
    if (isStunned(def) && def.state !== S.BLOCK_HI && def.state !== S.BLOCK_LO &&
        def.state !== S.BLOCKSTUN) return false;
    if (def.state === S.KO) return false;

    // Tech window: the victim mashing a punch escapes a normal throw.
    const techPressed = (def.motion.hist[0] | def.motion.hist[1] | def.motion.hist[2]) &
                        (IN.LP | IN.HP);
    if (!mv.unbreakable && techPressed && !isAttacking(def)) {
      atk.vx = -atk.facing * 7;
      def.vx = atk.facing * 7;
      atk.hitstop = 14; def.hitstop = 14;
      this.hitstop = 14;
      endMove(atk);
      this.emit({ type: 'techThrow', x: (atk.x + def.x) / 2, y: 110 });
      this.emit({ type: 'sfx', name: 'parry', x: atk.x, y: 110 });
      return true;
    }

    this.applyHit(atk, def, { ...mv, ...box, unblockable: true, isThrowHit: true },
                  (atk.x + def.x) / 2, def.y + 100);
    if (mv.quote) this.emit({ type: 'quote', fighter: atk.id, text: mv.quote, style: mv.voiceStyle });
    return true;
  }

  /**
   * The single funnel for all damage. Handles blocking, armor, scaling,
   * knockback, meter, stun and every hit-related event.
   */
  applyHit(atk, def, mv, cx, cy) {
    if (def.state === S.KO || this.phase !== 'fight') return;
    if (def.invuln > 0 && !mv.isThrowHit) {
      this.emit({ type: 'whiffInvuln', x: cx, y: cy });
      return;
    }

    const hitType = mv.hitType ?? HIT.MID;
    const unblockable = mv.unblockable || hitType === HIT.THROW || hitType === HIT.UNBLOCK;
    const blocked = !unblockable && this.canBlock(def, hitType);

    /* — Meter theft (Schwab's whole deal) — */
    if (mv.drainsMeter) {
      const stolen = Math.min(def.meter, mv.drainsMeter * (blocked ? 0.5 : 1));
      if (stolen > 0) {
        def.meter -= stolen;
        addMeter(atk, stolen * 0.6);
        this.emit({ type: 'meterSteal', from: def.id, to: atk.id, amount: stolen, x: cx, y: cy });
      }
    }

    /* — Armor: eat the hit, keep going — */
    if (!blocked && def.armorHits > 0 && !mv.isThrowHit && !mv.breakArmor) {
      def.armorHits--;
      const armorDmg = Math.round((mv.damage ?? 40) * 0.35);
      def.health -= armorDmg;
      def.totalDamage += 0;
      atk.hitstop = 8; def.hitstop = 8;
      this.hitstop = Math.max(this.hitstop, this.scaleStop(8));
      addMeter(atk, 12);
      this.emit({ type: 'armorHit', x: cx, y: cy, fighter: def.id });
      this.emit({ type: 'sfx', name: 'block', x: cx, y: cy });
      if (def.health <= 0) def.health = 1;   // armor never kills outright
      return;
    }

    const scale = Math.max(0.22, damageScale(def));
    let dmg = Math.round((mv.damage ?? 40) * (blocked ? 0 : scale));
    let chip = blocked ? Math.max(1, Math.round((mv.chip ?? (mv.damage ?? 40) / CHIP_DIVISOR))) : 0;

    /* — Counter hit: struck during an opponent's startup — */
    let counter = false;
    if (!blocked && isAttacking(def) && def.moveId) {
      const dmv = this.chars[def.id].moves[def.moveId];
      if (movePhase(dmv, def.moveFrame) === 'startup') {
        counter = true;
        dmg = Math.round(dmg * 1.25);
      }
    }

    if (blocked) {
      def.health -= chip;
      def.blockstun = mv.blockstun ?? 12;
      def.state = S.BLOCKSTUN;
      def.stateFrame = 0;
      def.guardCrush += 1;
      def.vx = atk.facing * (mv.blockPush ?? 5);
      atk.hitstop = this.scaleStop(Math.max(4, (mv.hitstop ?? 8) - 3));
      def.hitstop = atk.hitstop;
      this.hitstop = Math.max(this.hitstop, atk.hitstop);
      addMeter(atk, mv.meterHit ? mv.meterHit * 0.4 : 10);
      addMeter(def, 14);
      def.lastBlocked = this.frame;
      this.emit({
        type: 'block', x: cx, y: cy, fighter: def.id, attacker: atk.id,
        low: hitType === HIT.LOW, chip,
      });
      this.emit({ type: 'sfx', name: 'block', x: cx, y: cy });
      if (def.health <= 0) def.health = 1;   // chip damage never finishes a round
      return;
    }

    /* — Clean hit — */
    def.health -= dmg;
    def.stun += mv.stun ?? 8;
    def.comboCount++;
    def.comboDamage += dmg;
    atk.hitsLanded++;
    atk.totalDamage += dmg;
    if (def.comboCount > atk.maxCombo) atk.maxCombo = def.comboCount;
    def.perfectRound = false;
    atk.cancelOk = true;

    const stop = this.scaleStop(mv.hitstop ?? 8);
    atk.hitstop = stop;
    def.hitstop = stop;
    this.hitstop = Math.max(this.hitstop, stop);

    const push = mv.push ?? { x: 6, y: 0 };
    const launched = (push.y ?? 0) > 0;
    def.vx = atk.facing * push.x;
    if (launched) {
      def.vy = push.y;
      def.y = Math.max(def.y, 1);
      def.noGravity = false;
    }
    def.hitstun = (mv.hitstun ?? 14) + (counter ? 4 : 0);
    def.state = S.HITSTUN;
    def.stateFrame = 0;
    def.moveId = null;
    def.moveFrame = 0;
    def.blockstun = 0;

    addMeter(atk, mv.meterHit ?? 26);
    addMeter(def, 12);

    const wasFull = atk.meter >= MAX_METER;
    if (wasFull && atk.meter - (mv.meterHit ?? 26) < MAX_METER) {
      this.emit({ type: 'meterFull', fighter: atk.id });
    }

    this.emit({
      type: 'hit', x: cx, y: cy,
      attacker: atk.id, fighter: def.id,
      damage: dmg, counter,
      heavy: (mv.damage ?? 40) >= 90,
      combo: def.comboCount,
      dir: atk.facing,
      hitType,
      moveName: mv.name,
      isProjectile: !!mv.isProjectile,
    });

    if (def.stun >= DIZZY_THRESHOLD && !isAirborne(def) && def.health > 0) {
      this.emit({ type: 'dizzyIncoming', fighter: def.id });
    }

    // First time this round they drop into the danger zone.
    const before = (def.health + dmg) / def.maxHealth;
    const after = def.health / def.maxHealth;
    if (before >= 0.3 && after < 0.3 && after > 0) {
      this.emit({ type: 'lowHealth', fighter: def.id });
    }

    if (mv.knockdown || mv.isThrowHit) {
      if (mv.isThrowHit) {
        def.state = S.THROWN;
        def.stateFrame = 0;
        def.vy = Math.max(6, push.y || 10);
        def.vx = atk.facing * (push.x || 9);
        def.hitstun = 30;
      } else if (!isAirborne(def)) {
        knockdown(def);
      }
    }

    if (mv.quote && this.rng.chance(0.7)) {
      this.emit({ type: 'quote', fighter: atk.id, text: mv.quote, style: mv.voiceStyle });
    }

    this.maybeKnockoff(atk, def, push);
  }

  /**
   * Did that blow put them over the edge?
   *
   * Three conditions, all required, so it never happens by accident: there
   * has to be somewhere to fall to, they have to already be cornered, and
   * the hit has to be genuinely heavy and pushing them outward.
   */
  maybeKnockoff(atk, def, push) {
    if (this.tier >= this.maxTier) return;
    if (this.phase !== 'fight') return;
    if (def.health <= 0) return;
    const edge = STAGE_HALF_W - PUSH_W;
    const cornered = Math.abs(def.x) > edge - KNOCKOFF_ZONE;
    const outward = (def.x > 0 && atk.facing > 0) || (def.x < 0 && atk.facing < 0);
    const hard = (push.x ?? 0) >= KNOCKOFF_PUSH;
    if (!cornered || !outward || !hard) return;

    this.phase = 'knockoff';
    this.phaseFrame = 0;
    this.koffVictim = def.id;
    this.koffDir = def.x > 0 ? 1 : -1;
    def.state = S.FALLING;
    def.stateFrame = 0;
    def.moveId = null;
    def.hitstun = KNOCKOFF_FALL;
    def.hitstop = 0;
    def.vx = this.koffDir * 9;
    def.vy = 7;
    atk.hitstop = 0;
    this.hitstop = 0;
    this.emit({ type: 'knockoff', victim: def.id, dir: this.koffDir, x: def.x, y: def.y });
  }

  /**
   * The fall, the landing, and the winner following them down. Purely a
   * scripted sequence — neither player has control until it resolves.
   */
  stepKnockoff(inputs, ctx) {
    const victim = this.fighters[this.koffVictim];
    const chaser = this.fighters[1 - this.koffVictim];
    tickTimers(victim, inputs[this.koffVictim]);
    tickTimers(chaser, inputs[1 - this.koffVictim]);

    const f = this.phaseFrame;

    if (f < KNOCKOFF_FALL) {
      // Out past the edge and down out of frame.
      victim.x += this.koffDir * 6;
      victim.y -= 14;
      victim.stateFrame++;
      chaser.stateFrame++;
      chaser.vx *= 0.85;
      applyPhysics(chaser);
      return;
    }

    if (f === KNOCKOFF_FALL) {
      // Land on the tier below, and pay for it.
      this.tier++;
      victim.health -= KNOCKOFF_DAMAGE;
      victim.totalDamage += 0;
      victim.stun += 26;
      chaser.totalDamage += KNOCKOFF_DAMAGE;
      victim.x = this.koffDir * (STAGE_HALF_W - PUSH_W - 60);
      victim.y = 0; victim.vx = 0; victim.vy = 0;
      knockdown(victim);
      // The winner is still up top for a moment.
      chaser.x = this.koffDir * (STAGE_HALF_W - PUSH_W - 300);
      chaser.y = 0; chaser.vx = 0; chaser.vy = 0;
      chaser.state = S.IDLE; chaser.stateFrame = 0;
      this.emit({
        type: 'tierChange', tier: this.tier, victim: this.koffVictim,
        damage: KNOCKOFF_DAMAGE, x: victim.x,
      });
      if (victim.health <= 0) { this.beginKo(1 - this.koffVictim); return; }
      return;
    }

    if (f === KNOCKOFF_FALL + KNOCKOFF_LAND) {
      // The winner drops in after them, unhurt — they chose to jump.
      chaser.state = S.DROPPING;
      chaser.stateFrame = 0;
      chaser.y = 340;
      chaser.vy = -4;
      chaser.x = victim.x - this.koffDir * 230;
      this.emit({ type: 'chaseDrop', fighter: chaser.id, x: chaser.x });
    }

    if (f > KNOCKOFF_FALL) {
      victim.stateFrame++;
      victim.vx *= 0.86;
      applyPhysics(victim);
      if (chaser.state === S.DROPPING) {
        chaser.vy -= 1.4;
        chaser.y += chaser.vy;
        if (chaser.y <= 0) {
          chaser.y = 0; chaser.vy = 0;
          chaser.state = S.LANDING; chaser.stateFrame = 0;
          this.emit({ type: 'land', x: chaser.x, y: 0, hard: true });
        }
      } else {
        chaser.stateFrame++;
        applyPhysics(chaser);
      }
    }

    if (f >= KNOCKOFF_TOTAL) {
      this.phase = 'fight';
      this.phaseFrame = 0;
      this.updateFacing();
    }
  }

  canBlock(def, hitType) {
    if (isAirborne(def)) return false;             // no air blocking, by design
    if (isAttacking(def)) return false;
    if (def.state === S.HITSTUN || def.state === S.KNOCKDOWN ||
        def.state === S.WAKEUP || def.state === S.DIZZY || def.state === S.THROWN) return false;
    if (def.state === S.DASH_F) return false;
    if (!def.blockHeld && def.state !== S.BLOCKSTUN && def.state !== S.BLOCK_HI &&
        def.state !== S.BLOCK_LO) return false;

    const low = isCrouching(def) || def.state === S.BLOCK_LO ||
                (def.state === S.BLOCKSTUN && def.motion.dirs[0] === 1) ||
                (def.motion.dirs[0] === 1 || def.motion.dirs[0] === 2 || def.motion.dirs[0] === 3);
    if (hitType === HIT.LOW) return low;
    if (hitType === HIT.HIGH || hitType === HIT.OVERHEAD) return !low;
    return true;
  }

  scaleStop(frames) {
    const s = Math.round(frames * this.cfg.hitstopScale);
    return s < 1 ? 1 : s;
  }

  /** Moves declare projectile spawns on a given frame; fire them here. */
  spawnScheduled(ctx) {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      if (!f.moveId || f.hitstop > 0) continue;
      const mv = this.chars[i].moves[f.moveId];
      if (!mv.spawns) continue;
      for (const s of mv.spawns) {
        if (f.moveFrame === s.f) {
          if (s.count) {
            for (let n = 0; n < s.count; n++) {
              this.spawnProjectile(f, { ...s, y: (s.y ?? 100) + n * (s.stackY ?? 0),
                                        vx: (s.vx ?? 9) + n * (s.stackVx ?? 0) });
            }
          } else {
            this.spawnProjectile(f, s);
          }
        }
      }
    }
  }

  /* ── Convenience for renderer / AI ────────────────────── */

  get seconds() {
    return this.timer < 0 ? Infinity : Math.ceil(this.timer / TICK_HZ);
  }

  activeMove(i) {
    const f = this.fighters[i];
    return f.moveId ? this.chars[i].moves[f.moveId] : null;
  }
}

export function projBox(p) {
  return { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
}

function roundName(n) {
  return ['ROUND ONE', 'ROUND TWO', 'FINAL ROUND', 'ROUND FOUR', 'ROUND FIVE'][n - 1] || `ROUND ${n}`;
}
