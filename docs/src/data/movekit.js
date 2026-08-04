/* ══════════════════════════════════════════════════════════════
   Move kit — defaults and templates for building movesets.

   Frame data convention (all values in 60Hz frames):
     startup   frames before the first active frame
     active    frames the hitboxes are live
     recovery  frames after the hitboxes end

   Hitboxes are fighter-relative: +x is "in front of me", +y is up from
   the feet. The simulation mirrors them by facing.
   ══════════════════════════════════════════════════════════════ */

import { IN, HIT } from '../sim/constants.js';

/** Fill in every field the simulation expects. */
export function move(o) {
  return {
    name: 'Attack',
    tier: 'normal',            // 'normal' | 'command' | 'special' | 'super'
    startup: 5, active: 3, recovery: 10,
    damage: 40, chip: 5, stun: 8,
    hitstun: 15, blockstun: 10, hitstop: 7,
    push: { x: 5, y: 0 }, blockPush: 4,
    hitType: HIT.MID,
    meterHit: 26, meterCost: 0,
    cancel: [],
    boxes: [],
    ...o,
  };
}

/** A hitbox live from frame f0 to f1 inclusive. */
export function box(f0, f1, x, y, w, h, extra = {}) {
  return { f0, f1, x, y, w, h, ...extra };
}

/** Convenience: one box covering the whole active window. */
export function activeBox(m, x, y, w, h, extra = {}) {
  return [box(m.startup, m.startup + m.active - 1, x, y, w, h, extra)];
}

/* ══════════════════════════════════════════════════════════════
   Standard normals.

   Every fighter gets the same twelve-button skeleton so the game is
   learnable across the roster, then each character adjusts reach,
   damage and names to fit their gimmick.
   ══════════════════════════════════════════════════════════════ */

export function standardNormals(f = {}) {
  const R = f.reach ?? 1;        // reach multiplier
  const D = f.power ?? 1;        // damage multiplier
  const N = f.names ?? {};
  const w = (base) => Math.round(base * R);

  const mk = (id, cfg, bx) => {
    const m = move(cfg);
    m.boxes = bx(m);
    return [id, m];
  };

  return Object.fromEntries([
    /* ── Standing ── */
    mk('lp', {
      name: N.lp ?? 'Jab', tier: 'normal',
      input: { motion: 'none', button: IN.LP, stance: 'stand' },
      startup: 4, active: 3, recovery: 7,
      damage: Math.round(28 * D), stun: 5, hitstun: 13, blockstun: 9, hitstop: 5,
      push: { x: 4 }, meterHit: 16,
      cancel: ['normal', 'command', 'special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 40, 118, w(78), 34)),

    mk('hp', {
      name: N.hp ?? 'Straight', tier: 'normal',
      input: { motion: 'none', button: IN.HP, stance: 'stand' },
      startup: 9, active: 4, recovery: 17,
      damage: Math.round(86 * D), stun: 14, hitstun: 20, blockstun: 13, hitstop: 10,
      push: { x: 8 }, blockPush: 7, meterHit: 32,
      cancel: ['special', 'super'],
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 44, 110, w(106), 46)),

    mk('lk', {
      name: N.lk ?? 'Quick Kick', tier: 'normal',
      input: { motion: 'none', button: IN.LK, stance: 'stand' },
      startup: 5, active: 3, recovery: 9,
      damage: Math.round(32 * D), stun: 6, hitstun: 14, blockstun: 9, hitstop: 6,
      push: { x: 5 }, meterHit: 18,
      cancel: ['normal', 'command', 'special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 44, 72, w(88), 36)),

    mk('hk', {
      name: N.hk ?? 'Roundhouse', tier: 'normal',
      input: { motion: 'none', button: IN.HK, stance: 'stand' },
      startup: 12, active: 4, recovery: 20,
      damage: Math.round(96 * D), stun: 16, hitstun: 22, blockstun: 14, hitstop: 11,
      push: { x: 11, y: 6 }, blockPush: 8, meterHit: 34,
      cancel: ['special', 'super'], knockdown: false,
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 46, 92, w(120), 54)),

    /* ── Crouching ── */
    mk('clp', {
      name: N.clp ?? 'Low Jab', tier: 'normal',
      input: { motion: 'none', button: IN.LP, stance: 'crouch' },
      startup: 4, active: 2, recovery: 7,
      damage: Math.round(24 * D), stun: 4, hitstun: 12, blockstun: 8, hitstop: 5,
      push: { x: 3 }, meterHit: 14,
      cancel: ['normal', 'command', 'special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 38, 76, w(74), 32)),

    mk('chp', {
      name: N.chp ?? 'Uppercut', tier: 'normal',
      input: { motion: 'none', button: IN.HP, stance: 'crouch' },
      startup: 8, active: 4, recovery: 20,
      damage: Math.round(78 * D), stun: 13, hitstun: 24, blockstun: 12, hitstop: 10,
      push: { x: 3, y: 15 }, meterHit: 30,
      cancel: ['special', 'super'], launcher: true,
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 34, 58, w(84), 96)),

    mk('clk', {
      name: N.clk ?? 'Toe Poke', tier: 'normal',
      input: { motion: 'none', button: IN.LK, stance: 'crouch' },
      startup: 5, active: 2, recovery: 8,
      damage: Math.round(26 * D), stun: 4, hitstun: 12, blockstun: 8, hitstop: 5,
      push: { x: 3 }, hitType: HIT.LOW, meterHit: 14,
      cancel: ['normal', 'command', 'special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 38, 12, w(82), 30)),

    mk('chk', {
      name: N.chk ?? 'Sweep', tier: 'normal',
      input: { motion: 'none', button: IN.HK, stance: 'crouch' },
      startup: 9, active: 4, recovery: 24,
      damage: Math.round(72 * D), stun: 12, hitstun: 18, blockstun: 13, hitstop: 10,
      push: { x: 8 }, hitType: HIT.LOW, knockdown: true, meterHit: 28,
      cancel: ['super'],
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 42, 6, w(116), 34)),

    /* ── Air ── */
    mk('jlp', {
      name: N.jlp ?? 'Air Jab', tier: 'normal',
      input: { motion: 'none', button: IN.LP, stance: 'air' },
      startup: 4, active: 6, recovery: 8,
      damage: Math.round(34 * D), stun: 6, hitstun: 14, blockstun: 9, hitstop: 6,
      push: { x: 4 }, hitType: HIT.OVERHEAD, meterHit: 18,
      cancel: ['special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 32, 56, w(78), 46)),

    mk('jhp', {
      name: N.jhp ?? 'Air Smash', tier: 'normal',
      input: { motion: 'none', button: IN.HP, stance: 'air' },
      startup: 7, active: 7, recovery: 10,
      damage: Math.round(88 * D), stun: 14, hitstun: 20, blockstun: 13, hitstop: 10,
      push: { x: 7 }, hitType: HIT.OVERHEAD, meterHit: 30,
      cancel: ['special', 'super'],
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 34, 34, w(96), 64)),

    mk('jlk', {
      name: N.jlk ?? 'Air Kick', tier: 'normal',
      input: { motion: 'none', button: IN.LK, stance: 'air' },
      startup: 5, active: 8, recovery: 8,
      damage: Math.round(36 * D), stun: 6, hitstun: 15, blockstun: 9, hitstop: 6,
      push: { x: 5 }, hitType: HIT.OVERHEAD, meterHit: 18,
      cancel: ['special', 'super'],
      sfx: 'whoosh',
    }, (m) => activeBox(m, 34, 26, w(86), 52)),

    mk('jhk', {
      name: N.jhk ?? 'Air Drop', tier: 'normal',
      input: { motion: 'none', button: IN.HK, stance: 'air' },
      startup: 9, active: 8, recovery: 12,
      damage: Math.round(94 * D), stun: 15, hitstun: 22, blockstun: 14, hitstop: 11,
      push: { x: 8, y: 4 }, hitType: HIT.OVERHEAD, meterHit: 32,
      cancel: ['super'],
      sfx: 'whoosh', sfxHeavy: true,
    }, (m) => activeBox(m, 30, 8, w(96), 72)),

    /* ── Universal throw: forward + Heavy Punch, up close ── */
    mk('throw', {
      name: N.throw ?? 'Networking Grab', tier: 'command',
      input: { motion: 'none', button: IN.HP, stance: 'stand' },
      isThrow: true, range: 98,
      startup: 3, active: 2, recovery: 22,
      damage: Math.round(120 * D), stun: 20, hitstun: 30, hitstop: 14,
      push: { x: 11, y: 12 }, hitType: HIT.THROW, meterHit: 30,
      knockdown: true,
      requiresForward: true,
      sfx: 'throwGrab',
    }, (m) => [box(m.startup, m.startup + m.active - 1, 20, 40, 84, 120)]),
  ]);
}

/* Motion-input display helpers used by the move list UI. */
export const BTN_NAME = {
  [IN.LP]: 'LP', [IN.HP]: 'HP', [IN.LK]: 'LK', [IN.HK]: 'HK', [IN.SUPER]: 'SUPER',
};

export function buttonLabel(bits) {
  const parts = [];
  for (const b of [IN.LP, IN.HP, IN.LK, IN.HK, IN.SUPER]) {
    if (bits & b) parts.push(BTN_NAME[b]);
  }
  return parts.join('/');
}
