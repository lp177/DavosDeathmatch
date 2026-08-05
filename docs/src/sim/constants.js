/* ══════════════════════════════════════════════════════════════
   Simulation constants.

   DETERMINISM CONTRACT — read before touching anything in /sim:
   The simulation must produce bit-identical results on both peers,
   otherwise rollback netplay desyncs. Therefore, inside /sim:

     • Use only +  -  *  /  and comparisons on Numbers.
       These are exactly specified by IEEE-754 and agree across engines.
     • NEVER use Math.sin/cos/tan/pow/exp/log — implementations differ
       between engines and even between CPU vendors.
     • NEVER use Math.random() — use the seeded Rng passed into the match.
     • NEVER read Date.now(), performance.now() or any DOM state.
     • Iterate arrays in a fixed order. No Set/Map iteration order reliance
       on insertion of non-deterministic values.

   Presentation code (/fx, /gfx) is free to do whatever it likes — it is
   never part of the simulation and is skipped entirely during rollback
   re-simulation.
   ══════════════════════════════════════════════════════════════ */

/** Simulation ticks per second. Fixed forever; netcode depends on it. */
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

/* ── World geometry (world units; 1 unit == 1 canvas px at zoom 1) ── */
export const VIEW_W = 1280;
export const VIEW_H = 720;
// Stage width is chosen so that two cornered fighters still fit on screen at
// the camera's minimum zoom — that lets the default zoom sit much closer in,
// which is what makes the fighters read at a proper arcade scale.
export const STAGE_HALF_W = 700;       // stage spans [-700, +700]
export const GROUND_Y = 0;             // sim y is "height above floor", +y is up
export const FLOOR_SCREEN_Y = 610;     // where the floor sits on the canvas

/* ── Physics ── */
export const GRAVITY = -1.08;          // units per frame²
export const MAX_FALL = -26;
export const PUSH_W = 62;              // pushbox half-width... (full width = 2*this)
export const AIR_DRAG = 0.995;

/* ── Fight tuning ── */
export const MAX_HEALTH = 1000;
export const MAX_METER = 1000;
export const METER_PER_SUPER = 1000;
export const CHIP_DIVISOR = 8;         // blocked hits deal damage/8
export const THROW_RANGE = 96;
export const THROW_TECH_WINDOW = 7;    // frames to tech a throw
export const COMBO_SCALING = [1, 1, 0.9, 0.8, 0.72, 0.65, 0.58, 0.52, 0.46, 0.4, 0.35, 0.3];
export const MIN_SCALING = 0.22;
export const PUSHBACK_DECAY = 0.86;
export const WAKEUP_FRAMES = 22;
export const KNOCKDOWN_FRAMES = 26;
export const DIZZY_THRESHOLD = 90;     // stun points before dizzy
// Bleed-off rate is the whole balance of the stun system: too fast and
// dizzy never happens, too slow and every exchange ends in one. 0.22/frame
// (~13 per second) means sustained pressure stuns, but a couple of stray
// hits never will.
export const DIZZY_DECAY = 0.22;
export const DIZZY_FRAMES = 130;

/* ── Movement ── */
export const WALK_FWD = 3.5;
export const WALK_BACK = 2.75;
export const DASH_SPEED = 9.2;
export const DASH_FRAMES = 13;
export const BACKDASH_SPEED = -8.4;
export const BACKDASH_FRAMES = 15;
export const BACKDASH_INVULN = 6;
export const JUMP_VY = 20.2;
export const JUMP_VX = 6.4;
export const JUMP_SQUAT = 3;           // frames of prejump (throw/hit vulnerable)

/* ── Fighter states ── */
export const S = {
  IDLE:       0,
  WALK_F:     1,
  WALK_B:     2,
  CROUCH:     3,
  JUMPSQUAT:  4,
  AIR:        5,
  LANDING:    6,
  ATTACK:     7,
  BLOCK_HI:   8,
  BLOCK_LO:   9,
  HITSTUN:    10,
  BLOCKSTUN:  11,
  KNOCKDOWN:  12,
  WAKEUP:     13,
  DASH_F:     14,
  DASH_B:     15,
  THROWN:     16,
  THROWING:   17,
  DIZZY:      18,
  KO:         19,
  INTRO:      20,
  VICTORY:    21,
  ROUND_FREEZE: 22,
  AIR_ATTACK: 23,
  TAUNT:      24,
  FALLING:    25,   // thrown off the edge, on the way down
  DROPPING:   26,   // following them down, under control
};

/** Human-readable names, for the training-mode state readout. */
export const S_NAME = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));

/* ── Input bit flags. One 16-bit word per player per frame. ── */
export const IN = {
  UP:    1 << 0,
  DOWN:  1 << 1,
  LEFT:  1 << 2,
  RIGHT: 1 << 3,
  LP:    1 << 4,   // light punch
  HP:    1 << 5,   // heavy punch
  LK:    1 << 6,   // light kick
  HK:    1 << 7,   // heavy kick
  SUPER: 1 << 8,   // one-button super (needs full meter)
  TAUNT: 1 << 9,
  START: 1 << 10,
};

export const ATTACK_BITS = IN.LP | IN.HP | IN.LK | IN.HK | IN.SUPER;

/** Actions the player can rebind, in the order shown in the settings UI. */
export const ACTIONS = [
  { id: 'up',    label: 'Up / Jump',     bit: IN.UP },
  { id: 'down',  label: 'Down / Crouch', bit: IN.DOWN },
  { id: 'left',  label: 'Left',          bit: IN.LEFT },
  { id: 'right', label: 'Right',         bit: IN.RIGHT },
  { id: 'lp',    label: 'Light Punch',   bit: IN.LP },
  { id: 'hp',    label: 'Heavy Punch',   bit: IN.HP },
  { id: 'lk',    label: 'Light Kick',    bit: IN.LK },
  { id: 'hk',    label: 'Heavy Kick',    bit: IN.HK },
  { id: 'super', label: 'Super',         bit: IN.SUPER },
  { id: 'taunt', label: 'Taunt',         bit: IN.TAUNT },
];

/* ── Hit categories ── */
export const HIT = {
  HIGH:     'high',      // blockable standing only
  MID:      'mid',       // blockable either way
  LOW:      'low',       // blockable crouching only
  OVERHEAD: 'overhead',  // blockable standing only, hits crouchers
  THROW:    'throw',     // unblockable, techable
  UNBLOCK:  'unblock',   // unblockable
};

/* ── Stage transitions ──
   A hard enough hit near the edge throws the loser off it and down to the
   tier below. Deliberately hard to do by accident: it has to be a real
   blow, landing while they're already cornered and travelling outward. */
export const KNOCKOFF_ZONE = 190;     // how close to the edge counts as cornered
export const KNOCKOFF_PUSH = 9;       // minimum horizontal knockback
export const KNOCKOFF_DAMAGE = 110;   // extra damage from the fall
export const KNOCKOFF_FALL = 46;      // frames of falling
export const KNOCKOFF_LAND = 34;      // frames before the winner drops in
export const KNOCKOFF_TOTAL = 108;    // whole sequence

/* ── Round flow ── */
export const ROUND_INTRO_FRAMES = 150;
export const ROUND_FIGHT_FLASH = 60;
export const ROUND_END_FRAMES = 190;
export const KO_SLOWMO_FRAMES = 110;
