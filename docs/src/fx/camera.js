/* ══════════════════════════════════════════════════════════════
   Camera — framing, trauma shake, zoom punch, slow motion.

   Trauma-based shake (Squirrel Eiserloh's model): impacts add "trauma",
   the actual offset is trauma², and trauma decays linearly. Squaring
   makes small residual trauma nearly invisible while big hits still
   rattle the screen, which reads much better than shake that fades
   linearly to zero.

   Presentation only — never part of the simulation.
   ══════════════════════════════════════════════════════════════ */

import { VIEW_W, VIEW_H, STAGE_HALF_W, FLOOR_SCREEN_Y } from '../sim/constants.js';
import { settings } from '../core/settings.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.targetZoom = 1;
    this.zoomVel = 0;
    this.rot = 0;

    this.trauma = 0;
    this.traumaRot = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.seed = 1234;

    this.slowmo = 1;        // time scale 0..1
    this.slowmoLeft = 0;

    this.impulseX = 0;
    this.impulseY = 0;
  }

  reset() {
    this.x = 0; this.y = 0;
    this.zoom = 1; this.targetZoom = 1; this.zoomVel = 0;
    this.trauma = 0; this.traumaRot = 0; this.rot = 0;
    this.slowmo = 1; this.slowmoLeft = 0;
    this.impulseX = 0; this.impulseY = 0;
  }

  /** Add shake. `amount` 0..1; 0.35 is a solid heavy hit. */
  shake(amount, rotational = 0.5) {
    const mult = settings.juice.shake;
    this.trauma = Math.min(1, this.trauma + amount * mult);
    this.traumaRot = Math.min(1, this.traumaRot + amount * rotational * mult);
  }

  /** Directional kick, e.g. away from a heavy blow. */
  impulse(x, y) {
    const mult = settings.juice.shake;
    this.impulseX += x * mult;
    this.impulseY += y * mult;
  }

  /** Snap the zoom in and let it spring back. */
  punchZoom(amount) {
    const mult = settings.juice.zoom;
    this.targetZoom += amount * mult;
  }

  /** Enter slow motion for `frames`, running at `scale` speed. */
  slow(frames, scale = 0.25) {
    this.slowmoLeft = Math.max(this.slowmoLeft, frames);
    this.slowmo = Math.min(this.slowmo, scale);
  }

  _rand() {
    // Small xorshift — presentation only, no determinism requirement,
    // but keeping it local avoids stalling on Math.random in hot loops.
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  }

  /**
   * @param {number} dt   frames elapsed (1 at 60fps)
   * @param {object} focus {x, y, spread} world-space framing target
   */
  update(dt, focus) {
    /* — Framing — */
    if (focus) {
      const spread = focus.spread ?? 0;
      // Sit close in so fighters fill a proper share of the screen, and pull
      // back as they separate. At the minimum the whole stage width fits.
      const wanted = Math.max(1.0, Math.min(1.9, 2.0 - spread / 640));
      this.targetZoom += (wanted - this.targetZoom) * 0.06 * dt;

      const tx = focus.x;
      const ty = focus.y ?? 0;
      this.x += (tx - this.x) * 0.11 * dt;
      this.y += (ty - this.y) * 0.07 * dt;
    }

    /* — Zoom spring — */
    const k = 0.16, damp = 0.72;
    this.zoomVel += (this.targetZoom - this.zoom) * k * dt;
    this.zoomVel *= Math.pow(damp, dt);
    this.zoom += this.zoomVel * dt;
    // Ease a punch-in back out toward the framing value.
    this.targetZoom += (1.5 - this.targetZoom) * 0.02 * dt;
    this.zoom = Math.max(0.9, Math.min(2.6, this.zoom));

    /* — Shake — */
    this.trauma = Math.max(0, this.trauma - 0.035 * dt);
    this.traumaRot = Math.max(0, this.traumaRot - 0.04 * dt);
    const s = this.trauma * this.trauma;
    const sr = this.traumaRot * this.traumaRot;
    this.shakeX = this._rand() * 34 * s;
    this.shakeY = this._rand() * 26 * s;
    this.rot = this._rand() * 0.035 * sr;

    this.impulseX *= Math.pow(0.8, dt);
    this.impulseY *= Math.pow(0.8, dt);

    /* — Slow motion — */
    if (this.slowmoLeft > 0) {
      this.slowmoLeft -= dt;
      if (this.slowmoLeft <= 0) this.slowmo = 1;
      else this.slowmo += (1 - this.slowmo) * 0.008 * dt;   // gently recover
    }

    /* — Keep the view inside the stage — */
    const halfView = (VIEW_W / 2) / this.zoom;
    const limit = STAGE_HALF_W - halfView;
    if (limit > 0) this.x = Math.max(-limit, Math.min(limit, this.x));
    else this.x = 0;
    this.y = Math.max(-40, Math.min(190, this.y));
  }

  /** Apply the camera transform to a 2D context. */
  apply(ctx) {
    const cx = VIEW_W / 2;
    const cy = FLOOR_SCREEN_Y;
    ctx.translate(cx + this.shakeX + this.impulseX, cy + this.shakeY + this.impulseY);
    ctx.rotate(this.rot);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, this.y);
  }

  /** World → screen, for placing DOM/HUD elements over the action. */
  toScreen(wx, wy) {
    return {
      x: VIEW_W / 2 + (wx - this.x) * this.zoom + this.shakeX,
      y: FLOOR_SCREEN_Y - wy * this.zoom + this.shakeY,
    };
  }
}
