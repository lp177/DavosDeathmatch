/* ══════════════════════════════════════════════════════════════
   Stages — parallax backdrops, drawn procedurally.

   Every stage has two tiers: the arena you start on, and the place you
   land when somebody knocks you off the edge of it. The lower tier is
   always the same location seen from underneath — the hall's car park,
   the ravine below the terrace — so a knock-off reads as falling
   through the world rather than teleporting to a different one.

   Scenery is declarative: a tier lists the layers it wants and the
   renderer draws them. Adding a stage is a data change, not a new
   drawing routine.
   ══════════════════════════════════════════════════════════════ */

import { VIEW_W, VIEW_H, STAGE_HALF_W, FLOOR_SCREEN_Y } from '../sim/constants.js';
import { shade } from './caricature.js';

const TAU = Math.PI * 2;

export const STAGES = {
  /* ── The Congress Centre: the summit itself ── */
  congress: {
    name: 'Congress Centre',
    // Cold, official, four-on-the-floor. The sound of a keynote.
    music: { root: 55, bpm: 146, mode: 'minor', kit: 'hall', arp: 0 },
    tiers: [
      {
        name: 'Main Hall', where: 'Davos · Switzerland',
        sky: ['#1a2740', '#0d1420'], floor: '#2a2f3d', line: '#3d4457',
        accent: '#4da3ff', scenery: ['ridge', 'hall', 'crowd'],
        wind: 0.15,
      },
      {
        name: 'Loading Bay', where: 'Congress Centre · Level −2',
        sky: ['#15171d', '#08090c'], floor: '#242830', line: '#343943',
        accent: '#ffa23d', scenery: ['pillars', 'crates', 'pipes'],
        weather: 'drip', wind: 0,
      },
    ],
  },

  /* ── The mountain terrace above the town ── */
  alpine: {
    name: 'Alpine Terrace',
    // Wide, airy, slower. Horns over a mountain.
    music: { root: 58, bpm: 132, mode: 'dorian', kit: 'wide', arp: 2 },
    tiers: [
      {
        name: 'Schatzalp Terrace', where: '2,540m',
        sky: ['#2b3f5e', '#16243a'], floor: '#dfe7f0', line: '#b9c6d6',
        accent: '#8fd0ff', scenery: ['ridge', 'pines', 'railing'],
        weather: 'snow', wind: 0.6,
      },
      {
        name: 'The Ravine', where: 'Somewhere below the terrace',
        sky: ['#101a26', '#05090e'], floor: '#c8d4e2', line: '#93a3b6',
        accent: '#6fb4e8', scenery: ['cliffs', 'pines', 'wreck'],
        weather: 'snow', wind: 1.0,
      },
    ],
  },

  /* ── Where the private jets land ── */
  helipad: {
    name: 'Private Terminal',
    // Money music: brash, gold, a little vulgar.
    music: { root: 51, bpm: 152, mode: 'phrygian', kit: 'club', arp: 4 },
    tiers: [
      {
        name: 'Terminal Apron', where: 'Zurich · Gate P',
        sky: ['#3a2a3f', '#160f1c'], floor: '#23262e', line: '#3a3f4b',
        accent: '#ffc64d', scenery: ['skyline', 'jets'],
        wind: 0.4,
      },
      {
        name: 'The Runway', where: 'Below the apron',
        sky: ['#241a2c', '#0b0810'], floor: '#1b1e24', line: '#2e323a',
        accent: '#ff8a5c', scenery: ['skyline', 'runway'],
        weather: 'rain', wind: 0.9,
      },
    ],
  },

  /* ── The town's shopping street during the forum ── */
  promenade: {
    name: 'Davos Promenade',
    // Tinny festive cheer with something wrong underneath.
    music: { root: 60, bpm: 138, mode: 'minor', kit: 'street', arp: 1 },
    tiers: [
      {
        name: 'The Promenade', where: 'Davos Platz',
        sky: ['#1d2438', '#0b0f18'], floor: '#e8edf4', line: '#c2cbd8',
        accent: '#ffd76e', scenery: ['shops', 'lights', 'crowd'],
        weather: 'snow', wind: 0.5,
      },
      {
        name: 'Under the Bridge', where: 'The Landwasser, frozen',
        sky: ['#131a24', '#06090d'], floor: '#cfe0ea', line: '#9db6c6',
        accent: '#7fd3e8', scenery: ['arches', 'ice', 'reeds'],
        weather: 'snow', wind: 0.7,
      },
    ],
  },

  /* ── The very top ── */
  summit: {
    name: 'The Summit',
    // Thin air. Sparse, high, ringing.
    music: { root: 64, bpm: 126, mode: 'lydian', kit: 'wide', arp: 5 },
    tiers: [
      {
        name: 'Cable Car Station', where: 'Jakobshorn · 2,590m',
        sky: ['#3a4a63', '#1a2334'], floor: '#eef4fa', line: '#c3d0de',
        accent: '#bfe4ff', scenery: ['ridge', 'cables', 'pylon'],
        weather: 'snow', wind: 1.1,
      },
      {
        name: 'The Crevasse', where: 'Inside the glacier',
        sky: ['#0d2230', '#040d14'], floor: '#bfe0ea', line: '#84b3c4',
        accent: '#5fd0e8', scenery: ['iceWalls', 'shards'],
        wind: 0.2,
      },
    ],
  },
};

export const STAGE_ORDER = ['congress', 'alpine', 'helipad', 'promenade', 'summit'];

export function tierOf(stageId, tier) {
  const s = STAGES[stageId] || STAGES.congress;
  return s.tiers[Math.min(tier, s.tiers.length - 1)];
}

export class StageRenderer {
  constructor() {
    this.id = null;
    this.tier = 0;
    this.far = null;
    this.clock = 0;
    this.wind = 0;
    this.gust = 0;
    this.crowdSeed = [];
    this.motes = [];
  }

  setStage(id, tier = 0) {
    if (this.id === id && this.tier === tier) return;
    this.id = id;
    this.tier = tier;
    this.far = null;

    // Deterministic-looking but presentation-only scatter for crowds and
    // weather, so a stage looks the same each time you visit it.
    let s = 987654321 + tier * 7919;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    this.crowdSeed = [];
    for (let i = 0; i < 130; i++) {
      this.crowdSeed.push({
        x: -STAGE_HALF_W - 200 + rnd() * (STAGE_HALF_W * 2 + 400),
        row: Math.floor(rnd() * 4), hue: rnd(),
        phase: rnd() * TAU, speed: 0.5 + rnd() * 0.9,
      });
    }
    this.motes = [];
    for (let i = 0; i < 160; i++) {
      this.motes.push({ x: rnd(), y: rnd(), s: 0.4 + rnd() * 1.4, p: rnd() * TAU });
    }
  }

  get cfg() { return tierOf(this.id, this.tier); }

  /** Wind strength right now, for cloth and scenery elsewhere. */
  windAt(clock) {
    const base = this.cfg.wind ?? 0;
    return base * (0.55 + 0.45 * Math.sin(clock * 0.011)) + this.gust;
  }

  _buildFar(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const t = this.cfg;

    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, t.sky[0]);
    g.addColorStop(1, t.sky[1]);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    if (t.scenery.includes('ridge') || t.scenery.includes('cliffs')) {
      const range = (baseY, height, colour, step, seed) => {
        c.fillStyle = colour;
        c.beginPath();
        c.moveTo(0, h);
        let sx = seed;
        for (let x = 0; x <= w + step; x += step) {
          sx = (sx * 16807) % 2147483647;
          c.lineTo(x, baseY - (sx / 2147483647) * height);
        }
        c.lineTo(w, h);
        c.closePath();
        c.fill();
      };
      range(h * 0.55, h * 0.28, shade(t.sky[0], 8), 74, 12345);
      range(h * 0.66, h * 0.22, shade(t.sky[1], 12), 52, 98765);
      c.globalAlpha = 0.5;
      range(h * 0.56, h * 0.12, '#dbe7f5', 74, 12345);
      c.globalAlpha = 1;
    }

    if (t.scenery.includes('skyline')) {
      for (let i = 0; i < 60; i++) {
        const x = (i * 137.5) % w;
        const bh = 40 + ((i * 61) % 170);
        c.fillStyle = shade(t.sky[1], 6 + (i % 3) * 3);
        c.fillRect(x, h * 0.62 - bh, 34, bh + 20);
        c.fillStyle = t.accent + '22';
        for (let y = 0; y < bh; y += 14) {
          if ((i + y) % 3 === 0) c.fillRect(x + 6, h * 0.62 - bh + y + 4, 5, 6);
        }
      }
    }

    if (t.scenery.includes('iceWalls')) {
      // Towering blue ice, lit from somewhere above.
      for (let i = 0; i < 26; i++) {
        const x = (i * 91) % (w + 90) - 45;
        const iw = 40 + ((i * 53) % 90);
        const grad = c.createLinearGradient(x, 0, x + iw, h);
        grad.addColorStop(0, shade(t.accent, -52 + (i % 3) * 8));
        grad.addColorStop(1, shade(t.sky[1], 4));
        c.fillStyle = grad;
        c.beginPath();
        c.moveTo(x, h);
        c.lineTo(x + iw * 0.3, h * (0.1 + (i % 4) * 0.06));
        c.lineTo(x + iw, h);
        c.closePath();
        c.fill();
      }
    }

    const vg = c.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.5, h * 0.95);
    vg.addColorStop(0, 'transparent');
    vg.addColorStop(1, '#00000088');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);
    return cv;
  }

  draw(ctx, cam, dt) {
    this.clock += dt;
    this.gust = Math.max(0, this.gust - 0.02 * dt);
    const t = this.cfg;
    const w = VIEW_W, h = VIEW_H;
    if (!this.far) this.far = this._buildFar(w, h);

    const p1 = -cam.x * 0.06;
    ctx.save();
    ctx.translate(p1 % w, 0);
    ctx.drawImage(this.far, 0, 0);
    ctx.drawImage(this.far, p1 % w > 0 ? -w : w, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(-cam.x * 0.24, 0);
    this._drawMid(ctx, t);
    ctx.restore();

    if (t.scenery.includes('crowd')) {
      ctx.save();
      ctx.translate(-cam.x * 0.42, 0);
      this._drawCrowd(ctx);
      ctx.restore();
    }

    this._drawFloor(ctx, cam, t);
  }

  /* ── Mid-ground scenery, one routine per declared layer ── */
  _drawMid(ctx, t) {
    const y = FLOOR_SCREEN_Y;
    const wind = this.windAt(this.clock);
    for (const layer of t.scenery) {
      switch (layer) {
        case 'hall': this._hall(ctx, t, y); break;
        case 'pines': this._pines(ctx, t, y, wind); break;
        case 'railing': this._railing(ctx, y); break;
        case 'jets': this._jets(ctx, t, y); break;
        case 'runway': this._runway(ctx, t, y); break;
        case 'pillars': this._pillars(ctx, t, y); break;
        case 'crates': this._crates(ctx, t, y); break;
        case 'pipes': this._pipes(ctx, t, y); break;
        case 'shops': this._shops(ctx, t, y); break;
        case 'lights': this._lights(ctx, t, y, wind); break;
        case 'arches': this._arches(ctx, t, y); break;
        case 'reeds': this._reeds(ctx, t, y, wind); break;
        case 'cables': this._cables(ctx, t, y, wind); break;
        case 'pylon': this._pylon(ctx, t, y); break;
        case 'wreck': this._wreck(ctx, t, y); break;
        case 'shards': this._shards(ctx, t, y); break;
        case 'ice': this._iceField(ctx, t, y); break;
        default: break;
      }
    }
  }

  _hall(ctx, t, y) {
    ctx.fillStyle = shade(t.sky[1], 6);
    ctx.fillRect(-VIEW_W, y - 330, VIEW_W * 3, 330);
    ctx.strokeStyle = t.accent + '55';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, y - 190, 84, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, y - 190, 58, 0, TAU); ctx.stroke();
    ctx.fillStyle = t.accent + '22';
    ctx.font = '700 26px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ANNUAL MEETING', 0, y - 100);
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      ctx.fillStyle = i % 2 ? '#1d2b45' : '#22314e';
      ctx.fillRect(i * 300 - 34, y - 330, 68, 190);
      ctx.fillStyle = t.accent + '33';
      ctx.fillRect(i * 300 - 24, y - 300, 48, 8);
      ctx.fillRect(i * 300 - 24, y - 280, 34, 6);
    }
  }

  _pines(ctx, t, y, wind) {
    for (let i = -7; i <= 7; i++) {
      const x = i * 230 + 60;
      const sway = Math.sin(this.clock * 0.02 + i) * 6 * wind;
      ctx.fillStyle = '#1c3a2c';
      for (let s = 0; s < 3; s++) {
        const ty = y - 100 - s * 44;
        const tw = 58 - s * 14;
        const lean = sway * (s + 1) * 0.4;
        ctx.beginPath();
        ctx.moveTo(x + lean, ty - 62);
        ctx.lineTo(x - tw, ty); ctx.lineTo(x + tw, ty);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  _railing(ctx, y) {
    ctx.strokeStyle = '#5c4a38';
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(-VIEW_W, y - 76); ctx.lineTo(VIEW_W * 2, y - 76); ctx.stroke();
    for (let x = -VIEW_W; x < VIEW_W * 2; x += 56) {
      ctx.beginPath(); ctx.moveTo(x, y - 76); ctx.lineTo(x, y - 8); ctx.stroke();
    }
  }

  _jets(ctx, t, y) {
    for (let i = -2; i <= 2; i++) {
      const x = i * 520;
      ctx.fillStyle = '#c8ccd4';
      ctx.beginPath(); ctx.ellipse(x, y - 120, 150, 26, 0, 0, TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 60, y - 132); ctx.lineTo(x + 120, y - 200);
      ctx.lineTo(x + 134, y - 200); ctx.lineTo(x + 106, y - 130);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8fd0ff';
      ctx.fillRect(x - 110, y - 128, 130, 7);
      ctx.fillStyle = '#ffc64d';
      ctx.beginPath(); ctx.arc(x - 130, y - 118, 5, 0, TAU); ctx.fill();
    }
  }

  _runway(ctx, t, y) {
    // Approach lights receding into the dark.
    for (let i = -8; i <= 8; i++) {
      const on = (Math.floor(this.clock * 0.06) + i) % 4 === 0;
      ctx.fillStyle = on ? '#ffe9a8' : '#4a3f2a';
      ctx.beginPath(); ctx.arc(i * 170, y - 60, 7, 0, TAU); ctx.fill();
      if (on) { ctx.shadowColor = '#ffe9a8'; ctx.shadowBlur = 22; ctx.fill(); ctx.shadowBlur = 0; }
    }
    ctx.fillStyle = shade(t.sky[1], 5);
    ctx.fillRect(-VIEW_W, y - 44, VIEW_W * 3, 44);
  }

  _pillars(ctx, t, y) {
    ctx.fillStyle = shade(t.sky[0], 7);
    ctx.fillRect(-VIEW_W, y - 320, VIEW_W * 3, 320);
    for (let i = -4; i <= 4; i++) {
      const x = i * 240;
      ctx.fillStyle = shade(t.floor, -12);
      ctx.fillRect(x - 30, y - 300, 60, 300);
      ctx.fillStyle = shade(t.floor, 6);
      ctx.fillRect(x - 30, y - 300, 12, 300);
      ctx.fillStyle = t.accent + '33';
      ctx.fillRect(x - 30, y - 120, 60, 9);
    }
    // Strip lights on the ceiling.
    for (let i = -5; i <= 5; i++) {
      ctx.fillStyle = '#ffe9a8aa';
      ctx.fillRect(i * 200 - 46, y - 314, 92, 7);
    }
  }

  _crates(ctx, t, y) {
    for (let i = -3; i <= 3; i++) {
      const x = i * 310 + 90;
      const n = 1 + ((i + 4) % 3);
      for (let s = 0; s < n; s++) {
        ctx.fillStyle = s % 2 ? '#5c4a32' : '#6b5738';
        ctx.fillRect(x, y - 46 - s * 44, 76, 44);
        ctx.strokeStyle = '#3a2f20'; ctx.lineWidth = 2;
        ctx.strokeRect(x, y - 46 - s * 44, 76, 44);
      }
    }
  }

  _pipes(ctx, t, y) {
    for (let i = 0; i < 3; i++) {
      const py = y - 250 + i * 34;
      ctx.strokeStyle = i % 2 ? '#4a4f58' : '#3c414a';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(-VIEW_W, py); ctx.lineTo(VIEW_W * 2, py);
      ctx.stroke();
      ctx.fillStyle = '#2b2f36';
      for (let x = -VIEW_W; x < VIEW_W * 2; x += 180) ctx.fillRect(x, py - 9, 14, 18);
    }
  }

  _shops(ctx, t, y) {
    for (let i = -4; i <= 4; i++) {
      const x = i * 280;
      const hgt = 190 + ((i * 47) % 90);
      ctx.fillStyle = shade(t.sky[0], 5 + (i % 3) * 4);
      ctx.fillRect(x - 120, y - hgt, 240, hgt);
      // Lit windows.
      for (let r = 0; r < 3; r++) {
        for (let c2 = 0; c2 < 4; c2++) {
          const lit = ((i * 7 + r * 3 + c2) % 5) < 3;
          ctx.fillStyle = lit ? '#ffdf9e' : '#20252e';
          ctx.fillRect(x - 96 + c2 * 52, y - hgt + 28 + r * 46, 34, 30);
        }
      }
      // Awning.
      ctx.fillStyle = i % 2 ? '#8d2c2c' : '#2c5a8d';
      ctx.fillRect(x - 122, y - 74, 244, 16);
    }
  }

  _lights(ctx, t, y, wind) {
    // Festoon lights strung across the street, swinging in the wind.
    ctx.strokeStyle = '#3a3f4b';
    ctx.lineWidth = 2;
    for (let span = -3; span <= 3; span++) {
      const x0 = span * 400 - 200, x1 = span * 400 + 200;
      const sag = 46 + Math.sin(this.clock * 0.02 + span) * 6 * wind;
      ctx.beginPath();
      ctx.moveTo(x0, y - 250);
      ctx.quadraticCurveTo((x0 + x1) / 2, y - 250 + sag, x1, y - 250);
      ctx.stroke();
      for (let b = 1; b < 8; b++) {
        const tt = b / 8;
        const bx = x0 + (x1 - x0) * tt;
        const by = y - 250 + sag * 2 * tt * (1 - tt) * 2;
        ctx.fillStyle = ['#ffd76e', '#ff8a8a', '#8fd0ff'][b % 3];
        ctx.beginPath(); ctx.arc(bx, by + 8, 4.5, 0, TAU); ctx.fill();
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
      }
    }
  }

  _arches(ctx, t, y) {
    // The viaduct overhead.
    ctx.fillStyle = shade(t.sky[0], 9);
    ctx.fillRect(-VIEW_W, y - 340, VIEW_W * 3, 90);
    for (let i = -3; i <= 3; i++) {
      const x = i * 300;
      ctx.fillStyle = shade(t.sky[0], 6);
      ctx.beginPath();
      ctx.moveTo(x - 70, y - 250);
      ctx.arc(x, y - 250, 70, Math.PI, 0);
      ctx.lineTo(x + 70, y - 250);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 96, y - 250, 26, 250);
    }
  }

  _reeds(ctx, t, y, wind) {
    ctx.strokeStyle = '#5f6b4a';
    ctx.lineWidth = 3;
    for (let i = -18; i <= 18; i++) {
      const x = i * 70 + ((i * 37) % 40);
      const hgt = 40 + ((i * 53) % 50);
      const bend = Math.sin(this.clock * 0.035 + i * 0.7) * 16 * wind;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + bend * 0.4, y - hgt * 0.6, x + bend, y - hgt);
      ctx.stroke();
    }
  }

  _cables(ctx, t, y, wind) {
    const sway = Math.sin(this.clock * 0.014) * 10 * wind;
    ctx.strokeStyle = '#2b2f36';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-VIEW_W, y - 300 - 40);
    ctx.quadraticCurveTo(0, y - 300 + 40 + sway, VIEW_W * 2, y - 300 - 60);
    ctx.stroke();
    // A car creeping along it.
    const t2 = (this.clock * 0.0009) % 1;
    const cx = -VIEW_W + t2 * VIEW_W * 3;
    const cy = y - 300 + 40 * (1 - Math.abs(t2 * 2 - 1)) + sway * 0.5;
    ctx.fillStyle = '#b03030';
    ctx.fillRect(cx - 26, cy + 6, 52, 34);
    ctx.fillStyle = '#8fd0ff';
    ctx.fillRect(cx - 18, cy + 12, 36, 14);
    ctx.strokeStyle = '#2b2f36'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy - 6); ctx.stroke();
  }

  _pylon(ctx, t, y) {
    ctx.strokeStyle = '#4a4f58';
    ctx.lineWidth = 7;
    const x = 320;
    ctx.beginPath();
    ctx.moveTo(x - 46, y); ctx.lineTo(x - 12, y - 300);
    ctx.moveTo(x + 46, y); ctx.lineTo(x + 12, y - 300);
    ctx.stroke();
    ctx.lineWidth = 4;
    for (let i = 0; i < 7; i++) {
      const yy = y - 30 - i * 40;
      const spread = 44 - i * 4.6;
      ctx.beginPath();
      ctx.moveTo(x - spread, yy); ctx.lineTo(x + spread, yy);
      ctx.stroke();
    }
  }

  _wreck(ctx, t, y) {
    // A cable car that didn't make it, half-buried.
    ctx.save();
    ctx.translate(-360, y - 20);
    ctx.rotate(-0.32);
    ctx.fillStyle = '#7a2f2f';
    ctx.fillRect(-70, -58, 140, 62);
    ctx.fillStyle = '#2b3a44';
    ctx.fillRect(-56, -48, 44, 30);
    ctx.fillRect(6, -48, 44, 30);
    ctx.restore();
  }

  _shards(ctx, t, y) {
    for (let i = -6; i <= 6; i++) {
      const x = i * 190 + ((i * 61) % 70);
      const hgt = 60 + ((i * 43) % 120);
      ctx.fillStyle = shade(t.accent, -40 + (i % 3) * 10) + 'cc';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 24, y - hgt);
      ctx.lineTo(x + 48, y);
      ctx.closePath();
      ctx.fill();
    }
  }

  _iceField(ctx, t, y) {
    ctx.strokeStyle = t.accent + '44';
    ctx.lineWidth = 2;
    for (let i = -10; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 140, y - 10);
      ctx.lineTo(i * 140 + 60, y - 40 - ((i * 31) % 40));
      ctx.stroke();
    }
  }

  _drawCrowd(ctx) {
    const y = FLOOR_SCREEN_Y;
    for (const p of this.crowdSeed) {
      const bob = Math.sin(this.clock * 0.05 * p.speed + p.phase) * 3;
      const ry = y - 44 - p.row * 22 + bob;
      const dark = 0.24 + p.row * 0.06;
      ctx.fillStyle = `rgba(${18 + p.hue * 40 | 0}, ${22 + p.hue * 34 | 0}, ${34 + p.hue * 44 | 0}, ${1 - dark})`;
      ctx.beginPath(); ctx.arc(p.x, ry - 15, 8, 0, TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x - 11, ry + 16);
      ctx.quadraticCurveTo(p.x, ry - 10, p.x + 11, ry + 16);
      ctx.closePath(); ctx.fill();
      if (p.hue > 0.93) {
        ctx.fillStyle = '#bfe4ff88';
        ctx.fillRect(p.x + 6, ry - 6, 4, 6);
      }
    }
  }

  _drawFloor(ctx, cam, t) {
    const y = FLOOR_SCREEN_Y;
    const h = VIEW_H - y;
    const g = ctx.createLinearGradient(0, y, 0, VIEW_H);
    g.addColorStop(0, t.floor);
    g.addColorStop(1, shade(t.floor, -22));
    ctx.fillStyle = g;
    ctx.fillRect(0, y, VIEW_W, h + 4);

    ctx.strokeStyle = t.line;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    const off = (-cam.x * cam.zoom) % 120;
    for (let i = -2; i < 14; i++) {
      const x = i * 120 + off;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + (x - VIEW_W / 2) * 0.5, VIEW_H);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const ly = y + (h * i * i) / 20;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(VIEW_W, ly); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = shade(t.floor, 16);
    ctx.fillRect(0, y - 2, VIEW_W, 3);
  }

  /** Corner walls. On the upper tier they're a ledge you can be thrown off. */
  drawWalls(ctx, canFall) {
    const t = this.cfg;
    for (const side of [-1, 1]) {
      const x = side * STAGE_HALF_W;
      const g = ctx.createLinearGradient(x - side * 120, 0, x, 0);
      g.addColorStop(0, 'transparent');
      g.addColorStop(1, (canFall ? '#ff5468' : t.accent) + '30');
      ctx.fillStyle = g;
      ctx.fillRect(side > 0 ? x - 120 : x, -420, 120, 420);
      ctx.fillStyle = (canFall ? '#ff5468' : t.accent) + '66';
      ctx.fillRect(x - (side > 0 ? 4 : 0), -420, 4, 420);
      if (canFall) {
        // A drop, not a wall: show the edge crumbling away below.
        ctx.fillStyle = '#05070b';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + side * 90, 0);
        ctx.lineTo(x + side * 90, -30);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}
