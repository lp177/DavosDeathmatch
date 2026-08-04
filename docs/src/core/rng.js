/* ══════════════════════════════════════════════════════════════
   Deterministic PRNG (mulberry32).

   The match simulation must never call Math.random(): both peers have
   to roll identical numbers, and rollback has to be able to rewind the
   random stream along with everything else. So the RNG state is a
   single uint32 that gets snapshotted and restored with the rest of
   the world.
   ══════════════════════════════════════════════════════════════ */

export class Rng {
  constructor(seed = 0x2f6e2b1) {
    this.s = seed >>> 0;
  }

  /** Raw uint32. */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  /** Float in [0, 1). */
  float() {
    return this.next() / 4294967296;
  }

  /** Float in [lo, hi). */
  range(lo, hi) {
    return lo + (hi - lo) * this.float();
  }

  /** Integer in [0, n). */
  int(n) {
    return this.next() % n;
  }

  /** True with probability p. */
  chance(p) {
    return this.float() < p;
  }

  /** Uniform pick from an array. */
  pick(arr) {
    return arr[this.next() % arr.length];
  }

  snapshot() { return this.s; }
  restore(s) { this.s = s >>> 0; }
}

/**
 * Non-deterministic RNG for presentation only (particles, camera noise,
 * menu flourishes). Safe to use anywhere OUTSIDE /sim.
 */
export const fxRandom = Math.random;

/** Turn an arbitrary string into a 32-bit seed. Used for room codes. */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
