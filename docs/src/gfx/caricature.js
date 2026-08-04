/* ══════════════════════════════════════════════════════════════
   Caricature renderer — fighters drawn from scratch every frame.

   No sprite sheets. Each fighter is a small skeleton (hips, torso,
   head, two arms, two legs) posed procedurally from the simulation
   state, with limbs solved by two-bone IK so they bend like limbs
   instead of rotating like clock hands.

   Character identity comes from `char.look`: silhouette, palette,
   hair routine and props. The crude, over-egged proportions are the
   point — it's a caricature, not a portrait.

   Authoring convention inside drawFighter: +y is UP, origin at the
   feet, character faces RIGHT. Mirroring and the canvas y-flip are
   handled by the outer transform.
   ══════════════════════════════════════════════════════════════ */

import { S, IN } from '../sim/constants.js';
import { movePhase } from '../sim/fighter.js';

const TAU = Math.PI * 2;

/* Bone lengths (world units). */
const UPPER_ARM = 30, FOREARM = 30;
const THIGH = 40, SHIN = 40;

/* ── Two-bone IK: given anchor A and target B, find the joint. ──
   The joint offset is clamped at both ends. Over-extension is obvious,
   but under-extension matters just as much: when a hand sits close to
   its own shoulder the exact solution folds the elbow out at a right
   angle, which reads as a broken limb flung over the character's head. */
function ik(ax, ay, bx, by, l1, l2, flip) {
  let dx = bx - ax, dy = by - ay;
  let d = Math.sqrt(dx * dx + dy * dy);
  const max = l1 + l2 - 0.01;
  const min = (l1 + l2) * 0.62;
  if (d > max) d = max;
  if (d < min) d = min;
  if (d < 0.01) d = 0.01;
  // Re-normalise the direction to the clamped length.
  const inv = 1 / Math.sqrt(dx * dx + dy * dy || 1);
  dx *= inv; dy *= inv;
  const tx = ax + dx * d, ty = ay + dy * d;
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const hSq = l1 * l1 - a * a;
  const h = hSq > 0 ? Math.sqrt(hSq) : 0;
  const mx = ax + dx * a, my = ay + dy * a;
  return {
    jx: mx + flip * h * -dy,
    jy: my + flip * h * dx,
    ex: tx, ey: ty,
  };
}

/* ── Which animation does this move want? Inferred, no hand-tagging. ── */
export function animOf(mv) {
  if (!mv) return 'idle';
  if (mv.anim) return mv.anim;
  if (mv.isThrow) return 'grab';
  const isKick = mv.input && (mv.input.button & (IN.LK | IN.HK));
  const c0 = mv.curve && mv.curve[0];
  if (c0 && (c0.vy ?? 0) > 8) return 'uppercut';
  if (c0 && Math.abs(c0.vx ?? 0) > 8) return 'rush';
  if (mv.tier === 'super') return 'super';
  const b = mv.boxes && mv.boxes[0];
  if (!b) return 'cast';
  if (b.y < 30) return 'sweep';
  if (b.y > 70 && b.h > 100) return 'uppercut';
  return isKick ? 'kick' : 'punch';
}

/* ══════════════════════════════════════════════════════════════
   Pose builder — returns joint targets in local space.
   `t` is a 0..1 progress through the current action where relevant.
   ══════════════════════════════════════════════════════════════ */
function buildPose(f, char, mv, clock) {
  const h = char.look.height ?? 1;
  const build = char.look.build ?? 'lean';
  const bulk = build === 'heavy' ? 1.22 : build === 'stocky' ? 1.12 : build === 'slim' ? 0.86 : 1;

  const p = {
    h, bulk,
    hipY: 82 * h, lean: 0, squashX: 1, squashY: 1,
    headX: 0, headY: 158 * h, headRot: 0,
    handR: { x: 26, y: 116 * h }, handL: { x: -6, y: 112 * h },
    footR: { x: 16, y: 0 }, footL: { x: -18, y: 0 },
    armFlipR: 1, armFlipL: 1,
    open: 0,          // mouth openness 0..1
    brow: 0,          // -1 worried, +1 angry
    prop: 0,          // prop swing phase
  };

  const bob = Math.sin(clock * 0.09) * 2.2;
  const sway = Math.sin(clock * 0.045) * 1.4;

  switch (f.state) {
    case S.IDLE:
    case S.INTRO:
    case S.ROUND_FREEZE: {
      p.hipY += bob;
      p.headY += bob * 1.2;
      p.headX = sway * 0.6;
      p.handR = { x: 30 + sway, y: (114 + bob) * h };
      p.handL = { x: 2 - sway, y: (104 + bob) * h };
      p.lean = 0.04;
      p.brow = 0.4;
      break;
    }

    case S.WALK_F:
    case S.WALK_B: {
      const dir = f.state === S.WALK_F ? 1 : -1;
      const ph = clock * 0.19 * dir;
      p.hipY += Math.abs(Math.sin(ph)) * 4 - 2;
      p.footR = { x: 16 + Math.sin(ph) * 26, y: Math.max(0, Math.cos(ph) * 16) };
      p.footL = { x: -18 - Math.sin(ph) * 26, y: Math.max(0, -Math.cos(ph) * 16) };
      p.handR = { x: 28 - Math.sin(ph) * 10, y: 112 * h };
      p.handL = { x: 0 + Math.sin(ph) * 10, y: 104 * h };
      p.lean = dir > 0 ? 0.1 : -0.06;
      p.brow = 0.5;
      break;
    }

    case S.CROUCH:
    case S.BLOCK_LO: {
      p.hipY = 44 * h;
      p.headY = 118 * h;
      p.footR = { x: 26, y: 0 };
      p.footL = { x: -26, y: 0 };
      p.lean = 0.16;
      if (f.state === S.BLOCK_LO) {
        p.handR = { x: 16, y: 62 * h };
        p.handL = { x: 6, y: 50 * h };
        p.brow = -0.4;
      } else {
        p.handR = { x: 26, y: 58 * h };
        p.handL = { x: -4, y: 50 * h };
      }
      break;
    }

    case S.BLOCK_HI:
    case S.BLOCKSTUN: {
      const flinch = f.state === S.BLOCKSTUN ? Math.min(1, f.blockstun / 8) * 6 : 0;
      p.lean = -0.14;
      p.hipY -= 3;
      p.headX = -4 - flinch * 0.6;
      p.handR = { x: 14 - flinch, y: 122 * h };
      p.handL = { x: 4 - flinch, y: 104 * h };
      p.armFlipR = -1;
      p.brow = -0.5;
      p.open = 0.15;
      break;
    }

    case S.JUMPSQUAT: {
      p.hipY = 56 * h;
      p.headY = 132 * h;
      p.squashY = 0.88; p.squashX = 1.1;
      p.handR = { x: 10, y: 70 * h };
      p.handL = { x: -14, y: 66 * h };
      break;
    }

    case S.AIR:
    case S.AIR_ATTACK: {
      const rising = f.vy > 0;
      p.hipY = 78 * h;
      p.footR = { x: 20, y: rising ? 26 : 6 };
      p.footL = { x: -14, y: rising ? 6 : 26 };
      p.handR = { x: 22, y: (rising ? 132 : 118) * h };
      p.handL = { x: -14, y: (rising ? 128 : 106) * h };
      p.lean = rising ? -0.12 : 0.14;
      p.squashY = rising ? 1.08 : 0.96;
      p.squashX = rising ? 0.94 : 1.04;
      break;
    }

    case S.LANDING: {
      p.hipY = 62 * h;
      p.headY = 138 * h;
      p.squashY = 0.86; p.squashX = 1.14;
      p.footR = { x: 24, y: 0 }; p.footL = { x: -24, y: 0 };
      break;
    }

    case S.DASH_F: {
      p.lean = 0.34;
      p.hipY = 74 * h;
      p.footR = { x: 34, y: 12 }; p.footL = { x: -30, y: 4 };
      p.handR = { x: 40, y: 108 * h }; p.handL = { x: -22, y: 96 * h };
      break;
    }
    case S.DASH_B: {
      p.lean = -0.26;
      p.hipY = 76 * h;
      p.footR = { x: 30, y: 8 }; p.footL = { x: -20, y: 16 };
      p.handR = { x: 10, y: 122 * h }; p.handL = { x: -26, y: 108 * h };
      break;
    }

    case S.HITSTUN: {
      const k = Math.min(1, f.hitstun / 10);
      p.lean = -0.3 * k;
      p.headX = -12 * k;
      p.headY = (156 - 7 * k) * h;
      p.headRot = -0.28 * k;
      p.hipY -= 5 * k;
      p.handR = { x: 10 - 14 * k, y: (124 + 10 * k) * h };
      p.handL = { x: -18 - 12 * k, y: (110 + 8 * k) * h };
      p.footR = { x: 10 - 8 * k, y: 0 }; p.footL = { x: -26 - 10 * k, y: 0 };
      p.open = 1; p.brow = -1;
      p.squashX = 1 + 0.08 * k; p.squashY = 1 - 0.06 * k;
      break;
    }

    case S.THROWN: {
      p.lean = -1.1;
      p.headY = 146 * h; p.headRot = -0.9;
      p.footR = { x: -30, y: 60 }; p.footL = { x: -40, y: 40 };
      p.handR = { x: -10, y: 130 * h }; p.handL = { x: -30, y: 118 * h };
      p.open = 1; p.brow = -1;
      break;
    }

    case S.KNOCKDOWN:
    case S.KO: {
      const settle = Math.min(1, f.stateFrame / 8);
      p.lean = -1.45 * settle;
      p.hipY = 30 - 14 * settle;
      p.headX = -46 * settle;
      p.headY = (46 - 14 * settle) * h;
      p.headRot = -1.3 * settle;
      p.footR = { x: 44, y: 12 * (1 - settle) + 8 };
      p.footL = { x: 30, y: 4 };
      p.handR = { x: -34, y: 22 }; p.handL = { x: -50, y: 12 };
      p.open = 1; p.brow = -1;
      break;
    }

    case S.WAKEUP: {
      const t = f.stateFrame / 22;
      p.hipY = (26 + 56 * t) * h;
      p.headY = (46 + 112 * t) * h;
      p.headRot = -1.1 * (1 - t);
      p.lean = -1.1 * (1 - t) + 0.1;
      p.footR = { x: 30 - 14 * t, y: 0 }; p.footL = { x: -10 - 8 * t, y: 0 };
      p.handR = { x: -10 + 34 * t, y: (40 + 74 * t) * h };
      p.handL = { x: -30 + 26 * t, y: (26 + 78 * t) * h };
      break;
    }

    case S.DIZZY: {
      const w = Math.sin(clock * 0.14) * 9;
      p.lean = w * 0.02;
      p.headX = w; p.headRot = w * 0.02;
      p.hipY += Math.sin(clock * 0.1) * 3;
      p.handR = { x: 18 + w, y: 96 * h }; p.handL = { x: -20 + w, y: 92 * h };
      p.footR = { x: 20 + w * 0.4, y: 0 }; p.footL = { x: -22 + w * 0.4, y: 0 };
      p.open = 1; p.brow = -0.4;
      break;
    }

    case S.VICTORY: {
      const t = f.stateFrame;
      p.hipY += Math.sin(t * 0.12) * 4;
      p.handR = { x: 22, y: (172 + Math.sin(t * 0.12) * 8) * h };
      p.handL = { x: -22, y: (168 + Math.cos(t * 0.12) * 8) * h };
      p.headY = (162 + Math.sin(t * 0.12) * 3) * h;
      p.open = 0.8; p.brow = 0.6;
      break;
    }

    case S.TAUNT: {
      const t = f.stateFrame * 0.16;
      p.handR = { x: 40 + Math.sin(t) * 12, y: (140 + Math.cos(t) * 10) * h };
      p.handL = { x: -14, y: 100 * h };
      p.headRot = Math.sin(t) * 0.09;
      p.lean = 0.08;
      p.open = 0.9; p.brow = 0.8;
      break;
    }

    case S.ATTACK:
    case S.THROWING: {
      poseAttack(p, f, mv, h);
      break;
    }

    default:
      break;
  }

  if (f.state === S.AIR_ATTACK) poseAttack(p, f, mv, h, true);
  return p;
}

/** Attack posing: ramp out on startup, extend on active, retract on recovery. */
function poseAttack(p, f, mv, h, air = false) {
  if (!mv) return;
  const phase = movePhase(mv, f.moveFrame);
  const anim = animOf(mv);

  // 0 → 1 → 0 extension envelope across the move.
  let e;
  if (phase === 'startup') e = Math.min(1, (f.moveFrame / Math.max(1, mv.startup)) * 0.55);
  else if (phase === 'active') e = 1;
  else {
    const r = (f.moveFrame - mv.startup - mv.active) / Math.max(1, mv.recovery);
    e = Math.max(0, 1 - r * 1.3);
  }
  // Anticipation: wind up slightly backwards before the strike.
  const wind = phase === 'startup' ? Math.sin((f.moveFrame / Math.max(1, mv.startup)) * Math.PI) * 0.4 : 0;

  p.brow = 1;
  p.open = phase === 'active' ? 0.9 : 0.3;

  switch (anim) {
    case 'punch':
      p.handR = { x: -14 * wind + 88 * e, y: (118 - 4 * e) * h };
      p.handL = { x: -10 - 8 * e, y: 106 * h };
      p.lean = 0.1 + 0.16 * e - wind * 0.1;
      p.hipY -= 2 * e;
      p.footR = { x: 22 + 16 * e, y: 0 };
      p.footL = { x: -22 - 6 * e, y: 0 };
      break;

    case 'kick':
      p.footR = { x: 26 + 74 * e, y: (52 + 44 * e) * h };
      p.footL = { x: -12, y: 0 };
      p.hipY = (78 - 6 * e) * h;
      p.lean = -0.16 * e;
      p.handR = { x: 4 - 18 * e, y: 118 * h };
      p.handL = { x: -20 - 14 * e, y: 96 * h };
      break;

    case 'sweep':
      p.hipY = (40 - 8 * e) * h;
      p.headY = (114 - 8 * e) * h;
      p.footR = { x: 26 + 84 * e, y: 6 };
      p.footL = { x: -20, y: 0 };
      p.lean = 0.24;
      p.handR = { x: -16, y: 34 * h }; p.handL = { x: -34, y: 24 * h };
      break;

    case 'uppercut':
      p.handR = { x: 26 + 20 * e, y: (110 + 92 * e) * h };
      p.handL = { x: -18, y: 92 * h };
      p.lean = -0.24 * e;
      p.hipY = (82 + 10 * e) * h;
      p.footR = { x: 16, y: 10 * e }; p.footL = { x: -20, y: 22 * e };
      p.squashY = 1 + 0.1 * e; p.squashX = 1 - 0.06 * e;
      break;

    case 'rush':
      p.lean = 0.42;
      p.hipY = (72) * h;
      p.handR = { x: 60 + 24 * e, y: 108 * h };
      p.handL = { x: -30, y: 92 * h };
      p.footR = { x: 30, y: 16 }; p.footL = { x: -34, y: 6 };
      break;

    case 'grab':
      p.handR = { x: 40 + 44 * e, y: 122 * h };
      p.handL = { x: 26 + 40 * e, y: 104 * h };
      p.lean = 0.2 * e;
      p.footR = { x: 24 + 10 * e, y: 0 };
      break;

    case 'cast':
      p.handR = { x: 40 + 40 * e, y: (118 + 10 * e) * h };
      p.handL = { x: 18 + 24 * e, y: (106 + 6 * e) * h };
      p.lean = 0.06 + 0.1 * e;
      p.footR = { x: 24 + 8 * e, y: 0 }; p.footL = { x: -24, y: 0 };
      p.prop = e;
      break;

    case 'super':
      p.handR = { x: 30 + 56 * e, y: (128 + 30 * e) * h };
      p.handL = { x: -6 + 40 * e, y: (118 + 26 * e) * h };
      p.lean = -0.1 - 0.12 * e;
      p.hipY -= 4 * e;
      p.squashY = 1 + 0.08 * e;
      p.open = 1; p.brow = 1;
      p.prop = e;
      break;

    default:
      p.handR = { x: 40 + 40 * e, y: 118 * h };
      break;
  }

  if (air) {
    p.footL = { x: -16, y: 22 };
    if (anim !== 'kick') p.footR = { x: 18, y: 16 };
  }
}

/* ══════════════════════════════════════════════════════════════
   Drawing
   ══════════════════════════════════════════════════════════════ */

/**
 * @param ctx    canvas 2D context, already in world space (y down)
 * @param f      fighter sim state
 * @param char   roster entry
 * @param mv     active move or null
 * @param clock  free-running frame counter for idle animation
 * @param opts   {ghost, tint, alpha, silhouette}
 */
export function drawFighter(ctx, f, char, mv, clock, opts = {}) {
  const look = char.look;
  const pose = buildPose(f, char, mv, clock + f.id * 37);

  ctx.save();
  ctx.translate(f.x, -f.y);
  ctx.scale(f.facing, 1);
  ctx.scale(pose.squashX, pose.squashY);
  ctx.globalAlpha = opts.alpha ?? 1;

  if (opts.silhouette) {
    ctx.fillStyle = opts.tint || '#fff';
    ctx.strokeStyle = opts.tint || '#fff';
  }

  const flat = opts.silhouette ? (opts.tint || '#fff') : null;
  const col = (c) => flat || c;

  /* — Ground shadow (drawn unscaled by squash for stability) — */
  if (!opts.silhouette && !opts.noShadow) {
    ctx.save();
    ctx.scale(1 / pose.squashX, 1 / pose.squashY);
    const airFade = Math.max(0.16, 1 - f.y / 320);
    ctx.globalAlpha = 0.42 * airFade * (opts.alpha ?? 1);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, f.y, 44 * airFade * pose.bulk, 11 * airFade, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = opts.alpha ?? 1;
  }

  const hipY = -pose.hipY;
  const shoulderY = hipY - 56 * pose.h;
  const lean = pose.lean;

  // Torso axis, tilted by lean about the hips.
  const cosL = Math.cos(lean), sinL = Math.sin(lean);
  const rot = (x, y) => ({
    x: (x) * cosL - (y - hipY) * sinL,
    y: (x) * sinL + (y - hipY) * cosL + hipY,
  });

  const shoulderR = rot(14 * pose.bulk, shoulderY);
  const shoulderL = rot(-16 * pose.bulk, shoulderY);
  const neck = rot(0, shoulderY - 6);
  const headP = rot(pose.headX, -pose.headY);

  /* — Legs (behind torso) — */
  drawLimb(ctx, 0 - 12, hipY, pose.footL.x, -pose.footL.y, THIGH * pose.h, SHIN * pose.h, -1,
           col(shade(look.suit, -24)), 15 * pose.bulk, col('#15171d'));
  drawLimb(ctx, 0 + 10, hipY, pose.footR.x, -pose.footR.y, THIGH * pose.h, SHIN * pose.h, -1,
           col(shade(look.suit, 8)), 16 * pose.bulk, col('#22262f'));

  /* — Back arm — */
  drawLimb(ctx, shoulderL.x, shoulderL.y, pose.handL.x, -pose.handL.y,
           UPPER_ARM * pose.h, FOREARM * pose.h, pose.armFlipL,
           col(shade(look.suit, -26)), 12 * pose.bulk, col(shade(look.skin, -12)), true);

  /* — Torso — */
  drawTorso(ctx, hipY, shoulderY, lean, look, pose, col, opts);

  /* — Head — */
  ctx.save();
  ctx.translate(headP.x, headP.y);
  ctx.rotate(lean * 0.5 + pose.headRot);
  drawHead(ctx, look, pose, col, opts, clock, char);
  ctx.restore();

  /* — Front arm (over the torso) — */
  drawLimb(ctx, shoulderR.x, shoulderR.y, pose.handR.x, -pose.handR.y,
           UPPER_ARM * pose.h, FOREARM * pose.h, pose.armFlipR,
           col(shade(look.suit, 20)), 13 * pose.bulk, col(look.skin), true);

  /* — Props held in the front hand — */
  if (!opts.silhouette && look.props?.length) {
    drawProps(ctx, look, pose, f, mv, clock);
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

/* ── Limb: two capsules solved by IK, with a hand/foot cap ── */
function drawLimb(ctx, ax, ay, bx, by, l1, l2, flip, color, w, capColor, isArm = false) {
  const j = ik(ax, ay, bx, by, l1, l2, flip);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(j.jx, j.jy);
  ctx.lineTo(j.ex, j.ey);
  ctx.stroke();

  ctx.fillStyle = capColor;
  ctx.beginPath();
  if (isArm) {
    ctx.arc(j.ex, j.ey, w * 0.62, 0, TAU);
  } else {
    // Shoe: a squat rounded box pointing forward.
    ctx.ellipse(j.ex + w * 0.3, j.ey + 2, w * 0.86, w * 0.46, 0, 0, TAU);
  }
  ctx.fill();
}

function drawTorso(ctx, hipY, shoulderY, lean, look, pose, col, opts) {
  const b = pose.bulk;
  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(lean);
  ctx.translate(0, -hipY);

  const topW = 27 * b, botW = 22 * b;
  const chest = shoulderY;

  // Jacket
  ctx.fillStyle = col(look.suit);
  ctx.beginPath();
  ctx.moveTo(-topW, chest);
  ctx.quadraticCurveTo(-topW - 5 * b, (chest + hipY) / 2, -botW, hipY + 4);
  ctx.lineTo(botW, hipY + 4);
  ctx.quadraticCurveTo(topW + 5 * b, (chest + hipY) / 2, topW, chest);
  ctx.quadraticCurveTo(0, chest - 9, -topW, chest);
  ctx.closePath();
  ctx.fill();

  if (!opts.silhouette) {
    // Shirt V
    ctx.fillStyle = look.shirt;
    ctx.beginPath();
    ctx.moveTo(-8 * b, chest - 2);
    ctx.lineTo(8 * b, chest - 2);
    ctx.lineTo(3 * b, chest + 40);
    ctx.lineTo(-3 * b, chest + 40);
    ctx.closePath();
    ctx.fill();

    // Lapels
    ctx.fillStyle = shade(look.suitAccent || look.suit, -10);
    ctx.beginPath();
    ctx.moveTo(-topW + 1, chest);
    ctx.lineTo(-2, chest + 46);
    ctx.lineTo(-11 * b, chest + 8);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(topW - 1, chest);
    ctx.lineTo(2, chest + 46);
    ctx.lineTo(11 * b, chest + 8);
    ctx.closePath();
    ctx.fill();

    // Tie — length is a characterisation choice, not an accident.
    if (look.tie) {
      const len = 52 * (look.tieLength || 1);
      ctx.fillStyle = look.tie;
      ctx.beginPath();
      ctx.moveTo(-5, chest + 2);
      ctx.lineTo(5, chest + 2);
      ctx.lineTo(3.2, chest + 12);
      ctx.lineTo(6.5, chest + len);
      ctx.lineTo(0, chest + len + 8);
      ctx.lineTo(-6.5, chest + len);
      ctx.lineTo(-3.2, chest + 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(look.tie, 22);
      ctx.beginPath();
      ctx.moveTo(-5, chest + 2); ctx.lineTo(5, chest + 2);
      ctx.lineTo(3.4, chest + 11); ctx.lineTo(-3.4, chest + 11);
      ctx.closePath();
      ctx.fill();
    }

    if (look.props?.includes('medals')) {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = ['#ffc64d', '#ff5468', '#8fd0ff'][i];
        ctx.beginPath();
        ctx.arc(-12 * b + i * 7, chest + 16, 3.4, 0, TAU);
        ctx.fill();
      }
    }
    if (look.props?.includes('lanyard')) {
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-9 * b, chest + 1);
      ctx.quadraticCurveTo(0, chest + 34, 9 * b, chest + 1);
      ctx.stroke();
      ctx.fillStyle = '#e6e9ef';
      ctx.fillRect(-6, chest + 30, 12, 15);
    }
    if (look.props?.includes('xbadge')) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 16px Impact, sans-serif';
      ctx.save();
      ctx.scale(1, -1);
      ctx.textAlign = 'center';
      ctx.fillText('X', 0, -(chest + 30));
      ctx.restore();
    }
  }
  ctx.restore();
}

/* ── Head: skull, features, then hair on top ── */
function drawHead(ctx, look, pose, col, opts, clock, char) {
  const r = 27 * (look.headScale ?? 1);

  // Skull
  ctx.fillStyle = col(look.skin);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.9, r, 0, 0, TAU);
  ctx.fill();
  // Jaw
  ctx.beginPath();
  ctx.ellipse(2, r * 0.42, r * 0.72, r * 0.6, 0, 0, TAU);
  ctx.fill();
  // Neck
  ctx.fillStyle = col(shade(look.skin, -16));
  ctx.fillRect(-7, r * 0.7, 14, 12);

  if (opts.silhouette) { drawHair(ctx, look, r, col, clock); return; }

  // Cheeks / tan line
  if (look.blush) {
    ctx.globalAlpha *= 0.55;
    ctx.fillStyle = look.blush;
    ctx.beginPath(); ctx.ellipse(-11, 5, 7, 5, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(13, 5, 7, 5, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha /= 0.55;
  }

  // Eyes — a facing-right head shows both, the far one smaller.
  const squint = look.squint ?? 0;
  const brow = pose.brow;
  const eyeH = 4.2 * (1 - squint * 0.5) * (brow > 0.5 ? 0.72 : 1);
  ctx.fillStyle = '#f7f7f7';
  ctx.beginPath(); ctx.ellipse(7, -3, 5.4, eyeH, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-6, -3, 4.4, eyeH * 0.9, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#181c22';
  ctx.beginPath(); ctx.arc(8.6, -3, 2.3, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(-4.8, -3, 2, 0, TAU); ctx.fill();

  // Brows carry most of the expression.
  ctx.strokeStyle = shade(look.hair, -30);
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  const bl = brow * 4;
  ctx.beginPath();
  ctx.moveTo(2.4, -10 - bl * 0.4); ctx.lineTo(12.5, -9 + bl);
  ctx.moveTo(-10.4, -9 + bl * 0.7); ctx.lineTo(-2.2, -10.5 - bl * 0.3);
  ctx.stroke();

  // Nose
  ctx.strokeStyle = shade(look.skin, -28);
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(9, -1); ctx.quadraticCurveTo(15, 5, 8.5, 7);
  ctx.stroke();

  // Mouth
  const open = pose.open;
  ctx.fillStyle = '#5a1f24';
  ctx.strokeStyle = '#5a1f24';
  ctx.lineWidth = 2.6;
  if (open > 0.25) {
    ctx.beginPath();
    ctx.ellipse(4, 14, 6.5 + open * 2, 3 + open * 6, 0, 0, TAU);
    ctx.fill();
    if (open > 0.6) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-1.5, 11 + open * 1.5, 11, 2.6);
    }
  } else {
    ctx.beginPath();
    if (look.mouth === 'purse') {
      ctx.ellipse(4, 14, 5, 2.6, 0, 0, TAU);
      ctx.fill();
    } else {
      ctx.moveTo(-2, 14);
      ctx.quadraticCurveTo(4, 14 + (brow > 0 ? -2.4 : 3), 11, 13.5);
      ctx.stroke();
    }
  }

  if (look.props?.includes('glasses')) {
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(7.4, -3, 7.4, 0, TAU);
    ctx.arc(-6, -3, 6.4, 0, TAU);
    ctx.moveTo(0.4, -3); ctx.lineTo(-0.2, -3);
    ctx.moveTo(14.8, -4); ctx.lineTo(20, -7);
    ctx.stroke();
  }

  drawHair(ctx, look, r, col, clock);
}

function drawHair(ctx, look, r, col, clock) {
  const c = col(look.hair);
  ctx.fillStyle = c;
  switch (look.hairStyle) {
    case 'swoop':
      // The architecture: a forward-cantilevered wave.
      ctx.beginPath();
      ctx.moveTo(-r * 0.95, -r * 0.34);
      ctx.quadraticCurveTo(-r * 1.15, -r * 1.35, r * 0.1, -r * 1.22);
      ctx.quadraticCurveTo(r * 1.5, -r * 1.15, r * 1.34, -r * 0.28);
      ctx.quadraticCurveTo(r * 0.9, -r * 0.72, r * 0.2, -r * 0.62);
      ctx.quadraticCurveTo(-r * 0.5, -r * 0.5, -r * 0.95, -r * 0.34);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(c, 16);
      ctx.beginPath();
      ctx.moveTo(r * 0.1, -r * 1.16);
      ctx.quadraticCurveTo(r * 1.2, -r * 1.05, r * 1.2, -r * 0.44);
      ctx.quadraticCurveTo(r * 0.8, -r * 0.86, r * 0.1, -r * 0.86);
      ctx.closePath();
      ctx.fill();
      break;

    case 'braids': {
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.5, r * 0.98, r * 0.72, 0, Math.PI, TAU);
      ctx.fill();
      ctx.fillRect(-r * 0.98, -r * 0.55, r * 1.96, r * 0.35);
      const sway = Math.sin(clock * 0.07) * 3;
      for (const side of [-1, 1]) {
        ctx.strokeStyle = side > 0 ? c : shade(c, -18);
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(side * r * 0.92, -r * 0.24);
        // Curve outward, clear of the jaw — otherwise the near braid reads
        // as a beard from this three-quarter angle.
        ctx.quadraticCurveTo(side * r * 1.5 + sway, r * 0.5, side * r * 1.34 + sway, r * 1.42);
        ctx.stroke();
        ctx.fillStyle = '#e8543f';
        ctx.beginPath();
        ctx.arc(side * r * 1.34 + sway, r * 1.48, 3.4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = c;
      }
      break;
    }

    case 'crop':
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.46, r * 0.97, r * 0.78, 0, Math.PI, TAU);
      ctx.fill();
      ctx.fillRect(-r * 0.97, -r * 0.5, r * 1.94, r * 0.3);
      // Shaved sides.
      ctx.fillStyle = shade(c, -14);
      ctx.fillRect(-r * 0.97, -r * 0.28, r * 1.94, r * 0.2);
      break;

    case 'comb':
      ctx.beginPath();
      ctx.moveTo(-r * 0.96, -r * 0.3);
      ctx.quadraticCurveTo(-r * 0.6, -r * 1.2, r * 0.3, -r * 1.08);
      ctx.quadraticCurveTo(r * 1.05, -r * 0.98, r * 1.0, -r * 0.32);
      ctx.quadraticCurveTo(r * 0.4, -r * 0.62, -r * 0.96, -r * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = shade(c, -22);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.5 + i * 8, -r * 0.95);
        ctx.lineTo(-r * 0.2 + i * 8, -r * 0.4);
        ctx.stroke();
      }
      break;

    case 'side':
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.42, r * 0.95, r * 0.66, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, -r * 0.5);
      ctx.quadraticCurveTo(0, -r * 1.02, r * 0.95, -r * 0.42);
      ctx.lineTo(r * 0.95, -r * 0.2);
      ctx.quadraticCurveTo(0, -r * 0.7, -r * 0.9, -r * 0.24);
      ctx.closePath();
      ctx.fill();
      break;

    case 'mane': {
      // Volume, sideburns, and a life of its own.
      const w = Math.sin(clock * 0.08) * 2.4;
      ctx.beginPath();
      ctx.moveTo(-r * 1.0, r * 0.34);
      ctx.quadraticCurveTo(-r * 1.5 - w, -r * 1.0, -r * 0.3, -r * 1.28);
      ctx.quadraticCurveTo(r * 0.7, -r * 1.44 + w, r * 1.18, -r * 0.66);
      ctx.quadraticCurveTo(r * 1.36, r * 0.08, r * 0.94, r * 0.28);
      ctx.quadraticCurveTo(r * 0.6, -r * 0.5, -r * 0.1, -r * 0.5);
      ctx.quadraticCurveTo(-r * 0.72, -r * 0.42, -r * 1.0, r * 0.34);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-r * 1.0, -r * 0.2, r * 0.34, r * 0.9);
      break;
    }

    case 'bald':
      // A fringe of grey clinging to the sides.
      ctx.strokeStyle = c;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, -r * 0.16, r * 0.92, Math.PI * 0.86, Math.PI * 0.14, true);
      ctx.stroke();
      ctx.fillStyle = shade(look.skin, 12);
      ctx.beginPath();
      ctx.ellipse(1, -r * 0.5, r * 0.6, r * 0.34, 0, 0, TAU);
      ctx.fill();
      break;

    default:
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.4, r * 0.95, r * 0.7, 0, Math.PI, TAU);
      ctx.fill();
  }

  if (look.props?.includes('cap')) {
    ctx.fillStyle = '#d21f3c';
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.7, r * 1.0, r * 0.6, 0, Math.PI, TAU);
    ctx.fill();
    ctx.fillRect(r * 0.2, -r * 0.78, r * 1.3, r * 0.2);
  }
}

/* ── Held props ── */
function drawProps(ctx, look, pose, f, mv, clock) {
  const hx = pose.handR.x, hy = -pose.handR.y;

  if (look.props.includes('chainsaw')) {
    const revving = mv && (animOf(mv) === 'cast' || animOf(mv) === 'super' ||
                           (mv.sfx === 'chainsaw'));
    const jitter = revving ? Math.sin(clock * 1.9) * 2.2 : 0;
    ctx.save();
    ctx.translate(hx, hy + jitter);
    ctx.rotate(-0.25 + pose.prop * -0.35);
    // Body
    ctx.fillStyle = '#ff7a18';
    roundRect(ctx, -14, -11, 34, 22, 5);
    ctx.fill();
    ctx.fillStyle = '#20242c';
    roundRect(ctx, -18, -6, 12, 12, 3);
    ctx.fill();
    // Bar
    ctx.fillStyle = '#c8ccd4';
    roundRect(ctx, 18, -6, 58, 12, 6);
    ctx.fill();
    // Teeth
    ctx.fillStyle = '#8b9099';
    for (let i = 0; i < 9; i++) {
      const o = revving ? (clock * 2.4 + i * 7) % 63 : i * 7;
      ctx.fillRect(20 + o, -8.5, 3.4, 3);
      ctx.fillRect(20 + o, 5.5, 3.4, 3);
    }
    ctx.restore();
  }

  if (look.props.includes('placard')) {
    ctx.save();
    // Offset forward so the sign sits beside the head rather than over it.
    ctx.translate(hx + 22, hy - 4);
    ctx.rotate(-0.34 + Math.sin(clock * 0.06) * 0.06 + pose.prop * -0.5);
    ctx.strokeStyle = '#8a6136';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -54); ctx.stroke();
    ctx.fillStyle = '#f5f2e8';
    roundRect(ctx, -30, -96, 60, 44, 3);
    ctx.fill();
    ctx.strokeStyle = '#20242c';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1f6b3a';
    for (let i = 0; i < 3; i++) ctx.fillRect(-22, -88 + i * 12, 44 - i * 9, 5);
    ctx.restore();
  }
}

/* ── Utilities ────────────────────────────────────────── */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Lighten (positive) or darken (negative) a #rrggbb colour by percent. */
export function shade(hex, pct) {
  if (!hex || hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * pct);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + amt);
  const g = clamp(((n >> 8) & 0xff) + amt);
  const b = clamp((n & 0xff) + amt);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/** Standalone portrait for menus — head and shoulders, no simulation. */
export function drawPortrait(ctx, char, w, h, clock = 0, opts = {}) {
  const look = char.look;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(look.aura, -62));
  g.addColorStop(1, '#0a0c10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Radial spotlight behind the head.
  const rg = ctx.createRadialGradient(w / 2, h * 0.4, 4, w / 2, h * 0.4, w * 0.7);
  rg.addColorStop(0, look.aura + '44');
  rg.addColorStop(1, 'transparent');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);

  const s = Math.min(w / 190, h / 230) * (opts.scale ?? 1);
  ctx.translate(w / 2, h * 0.94);
  ctx.scale(s, s);

  const bob = Math.sin(clock * 0.05) * 2;
  const pose = {
    h: look.height ?? 1, bulk: look.build === 'heavy' ? 1.22
        : look.build === 'stocky' ? 1.12 : look.build === 'slim' ? 0.86 : 1,
    hipY: 40, headX: 0, headY: 116, headRot: Math.sin(clock * 0.03) * 0.04,
    handR: { x: 34, y: 76 }, handL: { x: -34, y: 74 },
    footR: { x: 16, y: 0 }, footL: { x: -18, y: 0 },
    lean: 0, squashX: 1, squashY: 1, armFlipR: 1, armFlipL: 1,
    open: 0, brow: 0.5, prop: 0,
  };

  ctx.save();
  ctx.translate(0, bob);
  const hipY = -pose.hipY, shoulderY = hipY - 52;
  drawLimb(ctx, -16, shoulderY, pose.handL.x, -pose.handL.y, UPPER_ARM, FOREARM, 1,
           shade(look.suit, -14), 12 * pose.bulk, look.skin, true);
  drawTorso(ctx, hipY, shoulderY, 0, look, pose, (c) => c, {});
  ctx.save();
  ctx.translate(pose.headX, -pose.headY);
  ctx.rotate(pose.headRot);
  drawHead(ctx, look, pose, (c) => c, {}, clock, char);
  ctx.restore();
  drawLimb(ctx, 14, shoulderY, pose.handR.x, -pose.handR.y, UPPER_ARM, FOREARM, 1,
           look.suit, 13 * pose.bulk, look.skin, true);
  if (look.props?.length) drawProps(ctx, look, pose, { x: 0 }, null, clock);
  ctx.restore();

  ctx.restore();
}

/** Tiny bust for the roster grid. */
export function drawThumb(ctx, char, w, h, clock = 0) {
  const look = char.look;
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(look.aura, -58));
  g.addColorStop(1, '#0d1016');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w / 2, h * 0.78);
  const s = Math.min(w, h) / 96;
  ctx.scale(s, s);
  const pose = {
    h: 1, bulk: 1, hipY: 0, headX: 0, headY: 30, headRot: 0,
    handR: { x: 0, y: 0 }, handL: { x: 0, y: 0 },
    footR: { x: 0, y: 0 }, footL: { x: 0, y: 0 },
    lean: 0, squashX: 1, squashY: 1, open: 0, brow: 0.5, prop: 0,
  };
  // Shoulders
  ctx.fillStyle = look.suit;
  ctx.beginPath();
  ctx.moveTo(-30, 6);
  ctx.quadraticCurveTo(-26, -12, 0, -14);
  ctx.quadraticCurveTo(26, -12, 30, 6);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.translate(0, -30);
  drawHead(ctx, look, pose, (c) => c, {}, clock, char);
  ctx.restore();
  ctx.restore();
}
