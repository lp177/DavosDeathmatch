/* ══════════════════════════════════════════════════════════════
   Particles — a fixed pool of lightweight sprites.

   One flat array, one update loop, one draw loop, no allocation after
   warm-up. Every kind shares the same struct; `kind` selects the draw
   routine. Density scales with the player's particle setting and drops
   automatically under reduced-motion.
   ══════════════════════════════════════════════════════════════ */

import { settings } from '../core/settings.js';

const MAX = 1400;
const TAU = Math.PI * 2;

export class Particles {
  constructor() {
    this.pool = new Array(MAX);
    for (let i = 0; i < MAX; i++) this.pool[i] = { alive: false };
    this.head = 0;
    this.count = 0;
  }

  clear() {
    for (let i = 0; i < MAX; i++) this.pool[i].alive = false;
    this.count = 0;
  }

  _take() {
    // Ring allocation: oldest particle is recycled once the pool is full.
    for (let n = 0; n < MAX; n++) {
      const p = this.pool[this.head];
      this.head = (this.head + 1) % MAX;
      if (!p.alive) { this.count++; return p; }
    }
    const p = this.pool[this.head];
    this.head = (this.head + 1) % MAX;
    return p;
  }

  spawn(cfg) {
    const p = this._take();
    p.alive = true;
    p.kind = cfg.kind ?? 'spark';
    p.x = cfg.x; p.y = cfg.y;
    p.vx = cfg.vx ?? 0; p.vy = cfg.vy ?? 0;
    p.grav = cfg.grav ?? 0;
    p.drag = cfg.drag ?? 1;
    p.life = cfg.life ?? 30;
    p.maxLife = p.life;
    p.size = cfg.size ?? 6;
    p.size0 = p.size;
    p.color = cfg.color ?? '#fff';
    p.color2 = cfg.color2 ?? null;
    p.rot = cfg.rot ?? 0;
    p.spin = cfg.spin ?? 0;
    p.glow = cfg.glow ?? 0;
    p.text = cfg.text ?? null;
    p.font = cfg.font ?? null;
    p.stretch = cfg.stretch ?? 1;
    p.fade = cfg.fade ?? 'out';
    p.grow = cfg.grow ?? 0;
    p.layer = cfg.layer ?? 0;      // <0 behind fighters, >0 in front
    return p;
  }

  update(dt) {
    const pool = this.pool;
    for (let i = 0; i < MAX; i++) {
      const p = pool[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; this.count--; continue; }
      p.vy += p.grav * dt;
      p.vx *= Math.pow(p.drag, dt);
      p.vy *= Math.pow(p.drag, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.grow) p.size = p.size0 * (1 + p.grow * (1 - p.life / p.maxLife));
      // Ground bounce for debris.
      if (p.kind === 'debris' && p.y < 0) {
        p.y = 0;
        p.vy = -p.vy * 0.42;
        p.vx *= 0.7;
        if (Math.abs(p.vy) < 0.6) p.vy = 0;
      }
    }
  }

  /** @param {number} layer draw only particles on this layer */
  draw(ctx, layer = 0) {
    const pool = this.pool;
    ctx.save();
    for (let i = 0; i < MAX; i++) {
      const p = pool[i];
      if (!p.alive || p.layer !== layer) continue;
      const t = p.life / p.maxLife;
      const alpha = p.fade === 'none' ? 1 : (p.fade === 'in' ? 1 - t : t);
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      DRAW[p.kind] ? DRAW[p.kind](ctx, p, t) : DRAW.spark(ctx, p, t);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ── Effect recipes ──────────────────────────────────── */

  /** Impact burst. `power` roughly 0.5 (light) … 1.6 (super). */
  hitSpark(x, y, dir, power = 1, color = '#fff3c4') {
    const d = settings.juice.particles;
    if (d <= 0) return;
    const n = Math.round(10 * power * d);
    for (let i = 0; i < n; i++) {
      const a = (Math.random() * 1.5 - 0.75) + (dir > 0 ? 0 : Math.PI);
      const sp = (3 + Math.random() * 11) * power;
      this.spawn({
        kind: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 2,
        grav: -0.42, drag: 0.9,
        life: 12 + Math.random() * 16,
        size: 3 + Math.random() * 4 * power,
        color, glow: 1, stretch: 2.4, layer: 1,
      });
    }
    // Star flash at the point of contact.
    this.spawn({
      kind: 'star', x, y, life: 9 + 5 * power,
      size: 34 * power, color, glow: 1, spin: 0.14, layer: 1,
    });
    this.spawn({
      kind: 'ring', x, y, life: 14, size: 12 * power,
      grow: 4.5, color, layer: 1,
    });
  }

  /** Blocked hit — colder, tighter, more metallic. */
  blockSpark(x, y, dir) {
    const d = settings.juice.particles;
    if (d <= 0) return;
    const n = Math.round(7 * d);
    for (let i = 0; i < n; i++) {
      const a = (Math.random() * 1.1 - 0.55) + (dir > 0 ? Math.PI : 0);
      const sp = 3 + Math.random() * 7;
      this.spawn({
        kind: 'spark', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1.5,
        grav: -0.4, drag: 0.88, life: 9 + Math.random() * 9,
        size: 2 + Math.random() * 3, color: '#bfe4ff', glow: 1, stretch: 2, layer: 1,
      });
    }
    this.spawn({ kind: 'shield', x, y, life: 13, size: 46, color: '#8fd0ff', layer: 1 });
  }

  dust(x, y, amount = 1, color = '#c9c2b4') {
    const d = settings.juice.particles;
    if (d <= 0) return;
    const n = Math.round(7 * amount * d);
    for (let i = 0; i < n; i++) {
      this.spawn({
        kind: 'smoke', x: x + (Math.random() - 0.5) * 40, y: y + Math.random() * 8,
        vx: (Math.random() - 0.5) * 5 * amount, vy: Math.random() * 2.4 + 0.6,
        grav: -0.03, drag: 0.93, life: 18 + Math.random() * 22,
        size: 9 + Math.random() * 16 * amount, color, grow: 1.6, layer: -1,
      });
    }
  }

  debris(x, y, amount, color) {
    const d = settings.juice.particles;
    if (d <= 0) return;
    const n = Math.round(6 * amount * d);
    for (let i = 0; i < n; i++) {
      this.spawn({
        kind: 'debris', x, y,
        vx: (Math.random() - 0.5) * 14 * amount, vy: 4 + Math.random() * 11 * amount,
        grav: -0.62, drag: 0.99, life: 40 + Math.random() * 50,
        size: 3 + Math.random() * 6, color, spin: (Math.random() - 0.5) * 0.4, layer: 1,
      });
    }
  }

  explosion(x, y, size = 1, color = '#ffb04d') {
    const d = settings.juice.particles;
    if (d <= 0) return;
    this.spawn({ kind: 'ring', x, y, life: 22, size: 30 * size, grow: 8, color, layer: 1 });
    this.spawn({ kind: 'flashball', x, y, life: 12, size: 90 * size, color: '#fff8e0', layer: 1 });
    const n = Math.round(20 * size * d);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (2 + Math.random() * 15) * size;
      this.spawn({
        kind: 'ember', x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        grav: -0.34, drag: 0.94, life: 22 + Math.random() * 34,
        size: 4 + Math.random() * 9 * size,
        color: i % 3 === 0 ? '#fff1b8' : color, glow: 1, layer: 1,
      });
    }
    for (let i = 0; i < Math.round(9 * size * d); i++) {
      this.spawn({
        kind: 'smoke', x: x + (Math.random() - 0.5) * 60 * size, y: y + Math.random() * 40,
        vx: (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 3,
        grav: 0.02, drag: 0.95, life: 40 + Math.random() * 40,
        size: 24 + Math.random() * 40 * size, color: '#2b2b30', grow: 2, layer: 1,
      });
    }
  }

  /** Trailing afterimage marker; the renderer draws the actual silhouette. */
  trail(x, y, facing, charId, poseKey, color) {
    if (!settings.juice.afterimages) return;
    this.spawn({
      kind: 'afterimage', x, y, life: 12, size: 1,
      color, layer: -1, rot: facing, text: poseKey, font: charId,
    });
  }

  speedLines(x, y, dir, amount = 1) {
    if (!settings.juice.speedLines) return;
    const n = Math.round(5 * amount);
    for (let i = 0; i < n; i++) {
      this.spawn({
        kind: 'line', x: x - dir * (60 + Math.random() * 200), y: y + (Math.random() - 0.5) * 190,
        vx: -dir * (18 + Math.random() * 16), vy: 0,
        life: 8 + Math.random() * 7, size: 40 + Math.random() * 90,
        color: '#ffffff', layer: 1, stretch: 1,
      });
    }
  }

  floatText(x, y, text, { color = '#fff', size = 30, life = 46, vy = 3.2, font = null,
                          layer = 1, spin = 0 } = {}) {
    this.spawn({
      kind: 'text', x, y, vx: (Math.random() - 0.5) * 1.4, vy,
      grav: -0.09, drag: 0.97, life, size, color, text, font, layer, spin,
    });
  }

  aura(x, y, color, amount = 1) {
    const d = settings.juice.particles;
    if (d <= 0) return;
    for (let i = 0; i < Math.round(3 * amount * d); i++) {
      this.spawn({
        kind: 'ember', x: x + (Math.random() - 0.5) * 90, y: y + Math.random() * 170,
        vx: (Math.random() - 0.5) * 1.6, vy: 2 + Math.random() * 4,
        grav: 0.02, drag: 0.96, life: 20 + Math.random() * 22,
        size: 3 + Math.random() * 6, color, glow: 1, layer: -1,
      });
    }
  }

  confetti(x, y, n = 40) {
    const d = settings.juice.particles;
    const colors = ['#ffc64d', '#4da3ff', '#ff6b8a', '#7ee787', '#ffffff'];
    for (let i = 0; i < Math.round(n * d); i++) {
      this.spawn({
        kind: 'debris', x: x + (Math.random() - 0.5) * 700, y: y + 200 + Math.random() * 260,
        vx: (Math.random() - 0.5) * 4, vy: -(1 + Math.random() * 3),
        grav: -0.06, drag: 0.99, life: 90 + Math.random() * 90,
        size: 5 + Math.random() * 7, color: colors[i % colors.length],
        spin: (Math.random() - 0.5) * 0.5, layer: 1,
      });
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   Draw routines. Canvas is already in world space (y up), so each
   routine flips y locally when drawing text or shapes.
   ══════════════════════════════════════════════════════════════ */

const DRAW = {
  spark(ctx, p) {
    const len = p.size * p.stretch;
    const a = Math.atan2(p.vy, p.vx);
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.rotate(-a);
    if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 12; }
    ctx.fillStyle = p.color;
    ctx.fillRect(-len / 2, -p.size / 2, len, p.size);
    ctx.restore();
  },

  ember(ctx, p) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 14; }
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, p.size / 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  },

  smoke(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.globalAlpha *= 0.5;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, p.size * (1.4 - t * 0.4), 0, TAU);
    ctx.fill();
    ctx.restore();
  },

  debris(ctx, p) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
    ctx.restore();
  },

  ring(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(1, 7 * t);
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, p.size, 0, TAU);
    ctx.stroke();
    ctx.restore();
  },

  flashball(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
    g.addColorStop(0, p.color);
    g.addColorStop(0.5, p.color + '80');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, p.size, 0, TAU);
    ctx.fill();
    ctx.restore();
  },

  star(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 22;
    const r = p.size * (0.4 + t * 0.8);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const rad = i % 2 === 0 ? r : r * 0.34;
      const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  shield(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 4;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(0, 0, p.size * (1.3 - t * 0.4), -0.9, 0.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, p.size * (1.05 - t * 0.3), -0.7, 0.7);
    ctx.stroke();
    ctx.restore();
  },

  line(ctx, p) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.globalAlpha *= 0.55;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(p.size, 0);
    ctx.stroke();
    ctx.restore();
  },

  text(ctx, p, t) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    ctx.rotate(p.rot);
    const pop = t > 0.86 ? 1 + (t - 0.86) * 3.4 : 1;
    ctx.scale(pop, pop);
    ctx.font = p.font || `900 ${p.size}px Impact, "Arial Black", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(3, p.size * 0.16);
    ctx.strokeStyle = '#0a0c10';
    ctx.lineJoin = 'round';
    ctx.strokeText(p.text, 0, 0);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  },

  // The renderer swaps in a real silhouette; this is the fallback.
  afterimage(ctx, p, t) {
    ctx.save();
    ctx.globalAlpha *= t * 0.35;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 30, -p.y - 170, 60, 170);
    ctx.restore();
  },
};

export { DRAW };
