/* ══════════════════════════════════════════════════════════════
   Settings — persisted preferences with change notification.

   Stored in localStorage as one JSON blob. Unknown/missing keys fall
   back to defaults on load, so adding options later never breaks an
   existing player's saved config.
   ══════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'davos-deathmatch.settings.v1';

export const DEFAULTS = {
  audio: {
    master: 0.8,
    sfx: 0.95,
    music: 0.45,
    announcer: 1.0,
    muteOnBlur: true,
  },
  video: {
    shake: 1.0,          // 0..2 multiplier on screen shake
    hitstop: 1.0,        // 0..1.5 multiplier on freeze frames
    flash: 1.0,          // 0..1 impact flash strength
    particles: 1.0,      // 0..1.5 particle density
    chromatic: true,     // chromatic aberration on heavy hits
    speedLines: true,
    grain: true,
    afterimages: true,
    blood: 1.0,          // 0 = none, 1 = normal, 1.5 = Mortal-Kombat-grade
    fatalities: true,    // finisher on the last knockout
    showFps: false,
    showHitboxes: false,
    motion: 'auto',      // 'auto' | 'full' | 'reduced'
  },
  match: {
    rounds: 3,           // best of N (first to ceil(N/2))
    roundTime: 99,       // seconds, 0 = infinite
    difficulty: 'normal',// 'tourist' | 'normal' | 'delegate' | 'chairman'
    inputDelay: 2,       // netplay input delay in frames
  },
  // Two comfortable clusters, split left/right so two people can share one
  // keyboard without fighting over it in local versus.
  //
  // On your own, you aren't limited to Player 1's half: every solo mode
  // accepts BOTH sets at once (see InputManager.solo), so the numpad works
  // just as well as F/G/V/B without rebinding anything.
  keys: {
    p1: {
      up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
      lp: 'KeyF', hp: 'KeyG', lk: 'KeyV', hk: 'KeyB',
      super: 'KeyH', taunt: 'KeyT',
    },
    p2: {
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
      lp: 'Numpad4', hp: 'Numpad5', lk: 'Numpad1', hk: 'Numpad2',
      super: 'Numpad6', taunt: 'Numpad3',
    },
  },
  controls: {
    // Which letters this keyboard prints. Only affects what the UI *says*:
    // bindings are physical key positions and work on any layout regardless.
    layout: 'auto',      // 'auto' | 'qwerty' | 'azerty' | 'qwertz'
  },
  net: {
    signalUrl: '',       // blank => auto-detect (same origin)
  },
  last: {
    p1: 'trump',
    p2: 'greta',
    stage: 'random',
  },
};

function deepMerge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return base;
  }
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in override)) continue;
    const b = base[key];
    const o = override[key];
    out[key] = (b && typeof b === 'object' && !Array.isArray(b)) ? deepMerge(b, o) : o;
  }
  return out;
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

class Settings {
  constructor() {
    this.data = clone(DEFAULTS);
    this._subs = new Set();
    this.load();

    // Track the OS-level preference so `motion: 'auto'` stays live.
    this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._mq.addEventListener('change', () => this.emit());
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.data = deepMerge(clone(DEFAULTS), JSON.parse(raw));
    } catch {
      // Corrupt or unavailable storage (private mode, quota). Defaults are fine.
      this.data = clone(DEFAULTS);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* Storage unavailable — settings simply won't persist this session. */
    }
  }

  /** Read via dotted path: settings.get('audio.master') */
  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data);
  }

  /** Write via dotted path, persist, and notify. */
  set(path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const target = parts.reduce((o, k) => (o[k] ??= {}), this.data);
    if (target[last] === value) return;
    target[last] = value;
    this.save();
    this.emit();
  }

  reset() {
    this.data = clone(DEFAULTS);
    this.save();
    this.emit();
  }

  resetSection(section) {
    this.data[section] = clone(DEFAULTS[section]);
    this.save();
    this.emit();
  }

  /** True when animation should be dialled down (OS pref or explicit choice). */
  get reducedMotion() {
    const m = this.data.video.motion;
    if (m === 'reduced') return true;
    if (m === 'full') return false;
    return this._mq ? this._mq.matches : false;
  }

  /** Effective juice multipliers, already accounting for reduced motion. */
  get juice() {
    const v = this.data.video;
    const r = this.reducedMotion;
    return {
      shake:      r ? 0 : v.shake,
      hitstop:    v.hitstop,               // hit-stop is gameplay feel, not motion
      flash:      r ? Math.min(v.flash, 0.25) : v.flash,
      particles:  r ? v.particles * 0.35 : v.particles,
      chromatic:  r ? false : v.chromatic,
      speedLines: r ? false : v.speedLines,
      grain:      r ? false : v.grain,
      afterimages: r ? false : v.afterimages,
      zoom:       r ? 0.15 : 1,
      // Blood is content, not motion — reduced motion shouldn't silently
      // censor it, only calm the way it moves.
      blood:      v.blood,
      fatalities: v.fatalities,
    };
  }

  onChange(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  emit() {
    for (const fn of this._subs) fn(this.data);
  }
}

export const settings = new Settings();
