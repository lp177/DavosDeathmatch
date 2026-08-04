/* ══════════════════════════════════════════════════════════════
   Motion inputs — quarter-circles, dragon punches, charges.

   Works on the packed command words the fighter has seen, converted
   to facing-relative numpad notation:

        7 8 9        4 = back      6 = forward
        4 5 6        2 = down      8 = up
        1 2 3        5 = neutral

   Everything here is pure arithmetic over integers, so it is safe to
   re-run during rollback. Patterns are matched backwards from the most
   recent frame with a frame budget, which is what gives players the
   usual "sloppy input still works" leniency.
   ══════════════════════════════════════════════════════════════ */

import { IN } from './constants.js';

export const HIST_LEN = 48;

/** Fresh per-fighter motion state. */
export function newMotionState() {
  return {
    hist: new Array(HIST_LEN).fill(0),   // index 0 = this frame
    dirs: new Array(HIST_LEN).fill(5),
    chargeB: 0,      // frames held back-ish
    chargeD: 0,      // frames held down-ish
    chargeBRel: 99,  // frames since back charge was released
    chargeDRel: 99,
  };
}

export function copyMotionState(m) {
  return {
    hist: m.hist.slice(),
    dirs: m.dirs.slice(),
    chargeB: m.chargeB,
    chargeD: m.chargeD,
    chargeBRel: m.chargeBRel,
    chargeDRel: m.chargeDRel,
  };
}

/** Convert a command word to facing-relative numpad notation. */
export function toNumpad(word, facing) {
  const fwd = facing > 0 ? IN.RIGHT : IN.LEFT;
  const back = facing > 0 ? IN.LEFT : IN.RIGHT;
  const f = (word & fwd) !== 0;
  const b = (word & back) !== 0;
  const u = (word & IN.UP) !== 0;
  const d = (word & IN.DOWN) !== 0;

  if (u && f) return 9;
  if (u && b) return 7;
  if (d && f) return 3;
  if (d && b) return 1;
  if (u) return 8;
  if (d) return 2;
  if (f) return 6;
  if (b) return 4;
  return 5;
}

/** Advance the buffer by one frame. Call once per fighter per tick. */
export function pushInput(m, word, facing) {
  m.hist.pop();
  m.hist.unshift(word);
  const dir = toNumpad(word, facing);
  m.dirs.pop();
  m.dirs.unshift(dir);

  // Charge tracking: holding back or down banks charge; letting go starts
  // a short grace window during which the charge move is still available.
  const backish = dir === 4 || dir === 1 || dir === 7;
  const downish = dir === 2 || dir === 1 || dir === 3;

  if (backish) {
    m.chargeB = m.chargeB < 255 ? m.chargeB + 1 : 255;
    m.chargeBRel = 0;
  } else {
    if (m.chargeBRel < 99) m.chargeBRel++;
    if (m.chargeBRel > 11) m.chargeB = 0;
  }

  if (downish) {
    m.chargeD = m.chargeD < 255 ? m.chargeD + 1 : 255;
    m.chargeDRel = 0;
  } else {
    if (m.chargeDRel < 99) m.chargeDRel++;
    if (m.chargeDRel > 11) m.chargeD = 0;
  }
}

/** Buttons that went down this frame. */
export function pressedBits(m) {
  return m.hist[0] & ~m.hist[1];
}

export function heldBits(m) {
  return m.hist[0];
}

/*  Pattern format: an array of steps, each step a list of acceptable
    numpad directions. Matched newest-first, so patterns are written in
    the order the player performs them. Allowing the "shortcut" direction
    inside a step is what lets 2→6 count as a quarter-circle.            */
const P = {
  qcf:   [[[2], [3, 6], [6]]],
  qcb:   [[[2], [1, 4], [4]]],
  dp:    [[[6], [2], [3]], [[6], [2], [6]], [[3], [2], [3]], [[6], [3], [2], [3]]],
  rdp:   [[[4], [2], [1]], [[4], [2], [4]], [[1], [2], [1]]],
  hcf:   [[[4], [1, 2], [2], [3, 6], [6]]],
  hcb:   [[[6], [3, 2], [2], [1, 4], [4]]],
  dd:    [[[2], [5, 4, 6], [2]]],
  qcfx2: [[[2], [3, 6], [6], [2], [3, 6], [6]], [[2], [6], [2], [6]]],
  qcbx2: [[[2], [1, 4], [4], [2], [1, 4], [4]], [[2], [4], [2], [4]]],
};

const WINDOW = {
  qcf: 15, qcb: 15, dp: 18, rdp: 18, hcf: 26, hcb: 26,
  dd: 20, qcfx2: 34, qcbx2: 34,
};

function matchPattern(dirs, steps, window) {
  let si = steps.length - 1;
  let i = 0;
  while (i < window && i < dirs.length) {
    if (steps[si].includes(dirs[i])) {
      si--;
      if (si < 0) return true;
    }
    i++;
  }
  return false;
}

/**
 * Does the buffer currently contain `name`?
 * Charge motions are handled specially because they are stateful.
 */
export function hasMotion(m, name) {
  switch (name) {
    case 'none':
      return true;
    case 'charge_bf':   // hold back, then forward
      return m.chargeB >= 38 && (m.dirs[0] === 6 || m.dirs[0] === 3 || m.dirs[0] === 9);
    case 'charge_du':   // hold down, then up
      return m.chargeD >= 38 && (m.dirs[0] === 8 || m.dirs[0] === 7 || m.dirs[0] === 9);
    default: {
      const variants = P[name];
      if (!variants) return false;
      const w = WINDOW[name] ?? 16;
      for (let v = 0; v < variants.length; v++) {
        if (matchPattern(m.dirs, variants[v], w)) return true;
      }
      return false;
    }
  }
}

/** Human-readable input string for the move list. */
export const MOTION_LABEL = {
  none: '',
  qcf: '↓↘→', qcb: '↓↙←',
  dp: '→↓↘', rdp: '←↓↙',
  hcf: '←↙↓↘→', hcb: '→↘↓↙←',
  dd: '↓↓',
  qcfx2: '↓↘→↓↘→', qcbx2: '↓↙←↓↙←',
  charge_bf: '[←] →', charge_du: '[↓] ↑',
};

export const BUTTON_LABEL = {
  [IN.LP]: 'LP', [IN.HP]: 'HP', [IN.LK]: 'LK', [IN.HK]: 'HK', [IN.SUPER]: 'SUPER',
};
