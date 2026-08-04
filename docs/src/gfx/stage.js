/* ══════════════════════════════════════════════════════════════
   Stages — parallax backdrops drawn procedurally.

   Three layers scroll at different rates against the camera. The far
   layers are static, so they're rendered once into an offscreen canvas
   and blitted; only the crowd and foreground animate per frame.
   ══════════════════════════════════════════════════════════════ */

import { VIEW_W, VIEW_H, STAGE_HALF_W, FLOOR_SCREEN_Y } from '../sim/constants.js';
import { shade } from './caricature.js';

const TAU = Math.PI * 2;

export const STAGES = {
  congress: {
    name: 'Congress Centre',
    where: 'Davos, Switzerland',
    sky: ['#1a2740', '#0d1420'],
    floor: '#2a2f3d',
    floorLine: '#3d4457',
    accent: '#4da3ff',
    crowd: true,
    music: { root: 55, bpm: 146 },
  },
  alpine: {
    name: 'Alpine Terrace',
    where: '2,540m — Schatzalp',
    sky: ['#2b3f5e', '#16243a'],
    floor: '#dfe7f0',
    floorLine: '#b9c6d6',
    accent: '#8fd0ff',
    snow: true,
    music: { root: 58, bpm: 138 },
  },
  helipad: {
    name: 'Private Terminal',
    where: 'Zurich Airport, Gate P',
    sky: ['#3a2a3f', '#160f1c'],
    floor: '#23262e',
    floorLine: '#3a3f4b',
    accent: '#ffc64d',
    jets: true,
    music: { root: 51, bpm: 152 },
  },
};

export const STAGE_ORDER = ['congress', 'alpine', 'helipad'];

export class StageRenderer {
  constructor() {
    this.id = null;
    this.far = null;      // cached offscreen layer
    this.clock = 0;
    this.crowdSeed = [];
  }

  setStage(id) {
    if (this.id === id) return;
    this.id = id;
    this.far = null;
    this.crowdSeed = [];
    // Deterministic-looking but presentation-only crowd layout.
    let s = 987654321;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 130; i++) {
      this.crowdSeed.push({
        x: -STAGE_HALF_W - 200 + rnd() * (STAGE_HALF_W * 2 + 400),
        row: Math.floor(rnd() * 4),
        hue: rnd(),
        phase: rnd() * TAU,
        speed: 0.5 + rnd() * 0.9,
      });
    }
  }

  _buildFar(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const s = STAGES[this.id];

    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, s.sky[0]);
    g.addColorStop(1, s.sky[1]);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    if (this.id === 'alpine' || this.id === 'congress') {
      // Mountain silhouettes, two ranges.
      const range = (baseY, height, colour, step, seed) => {
        c.fillStyle = colour;
        c.beginPath();
        c.moveTo(0, h);
        let sx = seed;
        for (let x = 0; x <= w + step; x += step) {
          sx = (sx * 16807) % 2147483647;
          const n = (sx / 2147483647);
          c.lineTo(x, baseY - n * height);
        }
        c.lineTo(w, h);
        c.closePath();
        c.fill();
      };
      range(h * 0.55, h * 0.28, shade(s.sky[0], 8), 74, 12345);
      range(h * 0.66, h * 0.22, shade(s.sky[1], 12), 52, 98765);
      // Snow caps.
      c.globalAlpha = 0.55;
      range(h * 0.56, h * 0.12, '#dbe7f5', 74, 12345);
      c.globalAlpha = 1;
    }

    if (this.id === 'helipad') {
      // City glow on the horizon.
      for (let i = 0; i < 60; i++) {
        const x = (i * 137.5) % w;
        const bh = 40 + ((i * 61) % 170);
        c.fillStyle = shade(s.sky[1], 6 + (i % 3) * 3);
        c.fillRect(x, h * 0.62 - bh, 34, bh + 20);
        c.fillStyle = '#ffc64d22';
        for (let y = 0; y < bh; y += 14) {
          if ((i + y) % 3 === 0) c.fillRect(x + 6, h * 0.62 - bh + y + 4, 5, 6);
        }
      }
    }

    // Vignette so the fighters always read against it.
    const vg = c.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.5, h * 0.95);
    vg.addColorStop(0, 'transparent');
    vg.addColorStop(1, '#00000088');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);

    return cv;
  }

  /**
   * @param ctx    screen-space context (no camera transform)
   * @param cam    camera, for parallax offsets
   */
  draw(ctx, cam, dt) {
    this.clock += dt;
    const s = STAGES[this.id] || STAGES.congress;
    const w = VIEW_W, h = VIEW_H;

    if (!this.far) this.far = this._buildFar(w, h);

    /* — Far layer: slowest parallax — */
    const p1 = -cam.x * 0.06;
    ctx.save();
    ctx.translate(p1 % w, 0);
    ctx.drawImage(this.far, 0, 0);
    ctx.drawImage(this.far, p1 % w > 0 ? -w : w, 0);
    ctx.restore();

    /* — Mid layer — */
    ctx.save();
    ctx.translate(-cam.x * 0.24, 0);
    this._drawMid(ctx, s, w, h);
    ctx.restore();

    /* — Crowd — */
    if (s.crowd) {
      ctx.save();
      ctx.translate(-cam.x * 0.42, 0);
      this._drawCrowd(ctx, s);
      ctx.restore();
    }

    /* — Weather — */
    if (s.snow) this._drawSnow(ctx, cam, w, h);

    /* — Floor — */
    this._drawFloor(ctx, cam, s);
  }

  _drawMid(ctx, s, w, h) {
    const y = FLOOR_SCREEN_Y;
    if (this.id === 'congress') {
      // Conference hall: back wall, WEF-ish ring logo, banners.
      ctx.fillStyle = shade(s.sky[1], 6);
      ctx.fillRect(-w, y - 330, w * 3, 330);
      ctx.strokeStyle = s.accent + '55';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, y - 190, 84, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, y - 190, 58, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = s.accent + '22';
      ctx.font = '700 26px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ANNUAL MEETING', 0, y - 100);
      // Banners
      for (let i = -3; i <= 3; i++) {
        if (i === 0) continue;
        ctx.fillStyle = i % 2 ? '#1d2b45' : '#22314e';
        ctx.fillRect(i * 300 - 34, y - 330, 68, 190);
        ctx.fillStyle = s.accent + '33';
        ctx.fillRect(i * 300 - 24, y - 300, 48, 8);
        ctx.fillRect(i * 300 - 24, y - 280, 34, 6);
      }
    } else if (this.id === 'alpine') {
      // Chalet railings and pine trees.
      ctx.strokeStyle = '#5c4a38';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(-w, y - 76); ctx.lineTo(w * 2, y - 76);
      ctx.stroke();
      for (let x = -w; x < w * 2; x += 56) {
        ctx.beginPath(); ctx.moveTo(x, y - 76); ctx.lineTo(x, y - 8); ctx.stroke();
      }
      for (let i = -6; i <= 6; i++) {
        const x = i * 230 + 60;
        ctx.fillStyle = '#1c3a2c';
        for (let t = 0; t < 3; t++) {
          const ty = y - 100 - t * 44;
          const tw = 58 - t * 14;
          ctx.beginPath();
          ctx.moveTo(x, ty - 62); ctx.lineTo(x - tw, ty); ctx.lineTo(x + tw, ty);
          ctx.closePath(); ctx.fill();
        }
      }
    } else {
      // Hangar with parked jets.
      ctx.fillStyle = shade(s.sky[1], 8);
      ctx.fillRect(-w, y - 250, w * 3, 250);
      for (let i = -2; i <= 2; i++) {
        const x = i * 520;
        ctx.fillStyle = '#c8ccd4';
        ctx.beginPath();
        ctx.ellipse(x, y - 120, 150, 26, 0, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + 60, y - 132); ctx.lineTo(x + 120, y - 200); ctx.lineTo(x + 134, y - 200);
        ctx.lineTo(x + 106, y - 130);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#8fd0ff';
        ctx.fillRect(x - 110, y - 128, 130, 7);
        ctx.fillStyle = '#ffc64d';
        ctx.beginPath();
        ctx.arc(x - 130, y - 118, 5, 0, TAU);
        ctx.fill();
      }
    }
  }

  _drawCrowd(ctx, s) {
    const y = FLOOR_SCREEN_Y;
    for (const p of this.crowdSeed) {
      const bob = Math.sin(this.clock * 0.05 * p.speed + p.phase) * 3;
      const ry = y - 44 - p.row * 22 + bob;
      const dark = 0.24 + p.row * 0.06;
      ctx.fillStyle = `rgba(${18 + p.hue * 40 | 0}, ${22 + p.hue * 34 | 0}, ${34 + p.hue * 44 | 0}, ${1 - dark})`;
      ctx.beginPath();
      ctx.arc(p.x, ry - 15, 8, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x - 11, ry + 16);
      ctx.quadraticCurveTo(p.x, ry - 10, p.x + 11, ry + 16);
      ctx.closePath();
      ctx.fill();
      // Occasional phone screen in the dark.
      if (p.hue > 0.93) {
        ctx.fillStyle = '#bfe4ff88';
        ctx.fillRect(p.x + 6, ry - 6, 4, 6);
      }
    }
  }

  _drawSnow(ctx, cam, w, h) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 90; i++) {
      const seed = i * 97.13;
      const speed = 0.5 + (i % 5) * 0.22;
      const x = ((seed * 13 + this.clock * speed * 0.6 - cam.x * 0.3) % (w + 60)) - 30;
      const y = ((seed * 31 + this.clock * speed * 1.6) % (h + 40)) - 20;
      const r = 1 + (i % 3) * 0.9;
      ctx.globalAlpha = 0.25 + (i % 4) * 0.14;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _drawFloor(ctx, cam, s) {
    const y = FLOOR_SCREEN_Y;
    const h = VIEW_H - y;
    const g = ctx.createLinearGradient(0, y, 0, VIEW_H);
    g.addColorStop(0, s.floor);
    g.addColorStop(1, shade(s.floor, -22));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, VIEW_W, h + 4);

    // Perspective lines running with the camera.
    ctx.strokeStyle = s.floorLine;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    const off = (-cam.x * cam.zoom) % 120;
    for (let i = -2; i < 14; i++) {
      const x = i * 120 + off;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (x - VIEW_W / 2) * 0.5, VIEW_H);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const ly = y + (h * i * i) / 20;
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(VIEW_W, ly);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Front edge highlight.
    ctx.fillStyle = shade(s.floor, 16);
    ctx.fillRect(0, y - 2, VIEW_W, 3);
  }

  /** Corner walls, drawn in world space so they line up with the pushbox limit. */
  drawWalls(ctx) {
    const s = STAGES[this.id] || STAGES.congress;
    for (const side of [-1, 1]) {
      const x = side * STAGE_HALF_W;
      const g = ctx.createLinearGradient(x - side * 120, 0, x, 0);
      g.addColorStop(0, 'transparent');
      g.addColorStop(1, s.accent + '30');
      ctx.fillStyle = g;
      ctx.fillRect(side > 0 ? x - 120 : x, -420, 120, 420);
      ctx.fillStyle = s.accent + '55';
      ctx.fillRect(x - (side > 0 ? 4 : 0), -420, 4, 420);
    }
  }
}
