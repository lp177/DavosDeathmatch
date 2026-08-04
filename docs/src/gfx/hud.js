/* ══════════════════════════════════════════════════════════════
   HUD — health, meter, timer, combo, announcer, speech bubbles.

   Drawn in screen space (outside the camera transform) so it never
   shakes with the world. The "ghost" health bar — a yellow trail that
   drains toward the real value a beat later — is doing most of the
   work in communicating how much a combo just cost you.
   ══════════════════════════════════════════════════════════════ */

import { VIEW_W, VIEW_H, MAX_METER, DIZZY_THRESHOLD, S } from '../sim/constants.js';
import { ROSTER } from '../data/roster.js';
import { drawThumb, shade } from './caricature.js';
import { settings } from '../core/settings.js';

const TAU = Math.PI * 2;

export class Hud {
  constructor() {
    this.ghost = [1, 1];
    this.ghostDelay = [0, 0];
    this.shown = [1, 1];
    this.meterShown = [0, 0];
    this.thumbs = {};
    this.clock = 0;
  }

  reset() {
    this.ghost = [1, 1];
    this.ghostDelay = [0, 0];
    this.shown = [1, 1];
  }

  _thumb(charId) {
    if (!this.thumbs[charId]) {
      const cv = document.createElement('canvas');
      cv.width = 68; cv.height = 68;
      drawThumb(cv.getContext('2d'), ROSTER[charId], 68, 68, 0);
      this.thumbs[charId] = cv;
    }
    return this.thumbs[charId];
  }

  update(match, dt) {
    this.clock += dt;
    for (let i = 0; i < 2; i++) {
      const f = match.fighters[i];
      const pct = Math.max(0, f.health) / f.maxHealth;
      // Instant red bar, delayed yellow trail.
      this.shown[i] += (pct - this.shown[i]) * 0.5 * dt;
      if (pct < this.ghost[i] - 0.0001) {
        this.ghostDelay[i] = Math.max(this.ghostDelay[i], 24);
      }
      if (this.ghostDelay[i] > 0) this.ghostDelay[i] -= dt;
      else this.ghost[i] += (pct - this.ghost[i]) * 0.09 * dt;
      if (pct > this.ghost[i]) this.ghost[i] = pct;

      this.meterShown[i] += (f.meter / MAX_METER - this.meterShown[i]) * 0.22 * dt;
    }
  }

  draw(ctx, match, juice, cam, extra = {}) {
    this.drawHealth(ctx, match, juice, 0);
    this.drawHealth(ctx, match, juice, 1);
    this.drawTimer(ctx, match);
    this.drawMeter(ctx, match, juice, 0);
    this.drawMeter(ctx, match, juice, 1);
    this.drawCombo(ctx, juice, 0);
    this.drawCombo(ctx, juice, 1);
    this.drawQuotes(ctx, match, juice, cam);
    this.drawSuperCutIn(ctx, juice);
    this.drawAnnounce(ctx, juice);
    if (extra.debug) this.drawDebug(ctx, extra);
  }

  /* ── Health ──────────────────────────────────────────── */
  drawHealth(ctx, match, juice, i) {
    const f = match.fighters[i];
    const char = ROSTER[match.chars[i].id];
    const right = i === 1;
    const W = 470, H = 26;
    const pad = 26;
    const x = right ? VIEW_W - pad - W : pad;
    const y = 30;
    const dir = right ? -1 : 1;

    ctx.save();

    // Frame
    ctx.fillStyle = '#0a0c10cc';
    skew(ctx, x - 4, y - 4, W + 8, H + 8, dir);
    ctx.fill();

    // Empty track
    ctx.fillStyle = '#2a3040';
    skew(ctx, x, y, W, H, dir);
    ctx.fill();

    const barAt = (pct) => {
      const w = W * Math.max(0, Math.min(1, pct));
      return right ? { bx: x + W - w, bw: w } : { bx: x, bw: w };
    };

    // Ghost (delayed damage)
    const g = barAt(this.ghost[i]);
    ctx.fillStyle = '#ffc64d';
    skew(ctx, g.bx, y, g.bw, H, dir);
    ctx.fill();

    // Live health, colour shifting as it empties
    const pct = this.shown[i];
    const b = barAt(pct);
    const grad = ctx.createLinearGradient(0, y, 0, y + H);
    const hot = pct < 0.28;
    const pulse = hot ? 0.5 + 0.5 * Math.sin(this.clock * 0.22) : 0;
    grad.addColorStop(0, hot ? shade('#ff5468', 22 * pulse) : (pct < 0.55 ? '#ffa23d' : '#4ddb92'));
    grad.addColorStop(1, hot ? '#b22b3c' : (pct < 0.55 ? '#c46f16' : '#2a9e66'));
    ctx.fillStyle = grad;
    skew(ctx, b.bx, y, b.bw, H, dir);
    ctx.fill();

    // Impact flash
    if (juice.healthPulse[i] > 0) {
      ctx.globalAlpha = juice.healthPulse[i] * 0.55;
      ctx.fillStyle = '#fff';
      skew(ctx, b.bx, y, b.bw, H, dir);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Gloss
    ctx.fillStyle = '#ffffff18';
    skew(ctx, x, y, W, H * 0.42, dir);
    ctx.fill();

    // Border
    ctx.strokeStyle = i === 0 ? '#4da3ff' : '#ff6b8a';
    ctx.lineWidth = 2;
    skew(ctx, x, y, W, H, dir);
    ctx.stroke();

    /* — Portrait + name — */
    const px = right ? x + W - 62 : x + 2;
    const thumb = this._thumb(char.id);
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, y + H + 8, 60, 60);
    ctx.clip();
    ctx.drawImage(thumb, px, y + H + 8, 60, 60);
    ctx.restore();
    ctx.strokeStyle = i === 0 ? '#4da3ff' : '#ff6b8a';
    ctx.lineWidth = 2;
    ctx.strokeRect(px, y + H + 8, 60, 60);

    ctx.font = '800 21px Impact, "Arial Black", sans-serif';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillStyle = '#eef2f8';
    ctx.textBaseline = 'top';
    const nx = right ? px - 12 : px + 72;
    ctx.fillText(char.short + '  ' + char.flag, nx, y + H + 12);
    ctx.font = '600 12px Inter, sans-serif';
    ctx.fillStyle = '#a7b0c0';
    ctx.fillText(char.title, nx, y + H + 36);

    /* — Round pips — */
    const needed = match.needed;
    for (let r = 0; r < needed; r++) {
      const cx = right ? x + W - 12 - r * 24 : x + 12 + r * 24;
      const won = match.wins[i] > r;
      ctx.beginPath();
      ctx.arc(cx, y - 18, 8, 0, TAU);
      ctx.fillStyle = won ? '#ffc64d' : '#2a3040';
      ctx.fill();
      ctx.strokeStyle = won ? '#fff0b8' : '#4a5468';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (won) {
        ctx.shadowColor = '#ffc64d';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    /* — Stun meter — */
    if (f.stun > 1) {
      const sw = W * 0.5;
      const sx = right ? x + W - sw : x;
      const sp = Math.min(1, f.stun / DIZZY_THRESHOLD);
      ctx.fillStyle = '#0a0c10aa';
      ctx.fillRect(sx, y + H + 2, sw, 5);
      ctx.fillStyle = sp > 0.8 ? '#ff5468' : '#ffc64d';
      const fw = sw * sp;
      ctx.fillRect(right ? sx + sw - fw : sx, y + H + 2, fw, 5);
    }

    ctx.restore();
  }

  /* ── Timer ───────────────────────────────────────────── */
  drawTimer(ctx, match) {
    const cx = VIEW_W / 2, cy = 56;
    const secs = match.timer < 0 ? '∞' : Math.ceil(match.timer / 60);
    const low = match.timer >= 0 && match.timer < 600;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 44, 0, TAU);
    ctx.fillStyle = '#0a0c10dd';
    ctx.fill();
    ctx.strokeStyle = low ? '#ff5468' : '#4a5468';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (match.timer > 0 && match.cfg.roundTime > 0) {
      const p = match.timer / (match.cfg.roundTime * 60);
      ctx.beginPath();
      ctx.arc(cx, cy, 44, -Math.PI / 2, -Math.PI / 2 + TAU * p);
      ctx.strokeStyle = low ? '#ff5468' : '#ffc64d';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.font = '900 40px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const scale = low ? 1 + 0.08 * Math.abs(Math.sin(this.clock * 0.2)) : 1;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.fillStyle = low ? '#ff5468' : '#eef2f8';
    if (low) { ctx.shadowColor = '#ff5468'; ctx.shadowBlur = 18; }
    ctx.fillText(String(secs), 0, 2);
    ctx.restore();

    // Round label
    ctx.save();
    ctx.font = '700 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#6d7789';
    ctx.fillText(`ROUND ${match.round}`, cx, cy + 60);
    ctx.restore();
  }

  /* ── Super meter ─────────────────────────────────────── */
  drawMeter(ctx, match, juice, i) {
    const right = i === 1;
    const W = 300, H = 20;
    const x = right ? VIEW_W - 26 - W : 26;
    const y = VIEW_H - 44;
    const pct = Math.max(0, Math.min(1, this.meterShown[i]));
    const full = match.fighters[i].meter >= MAX_METER;
    const char = ROSTER[match.chars[i].id];

    ctx.save();
    ctx.fillStyle = '#0a0c10cc';
    ctx.fillRect(x - 3, y - 3, W + 6, H + 6);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(x, y, W, H);

    const w = W * pct;
    const bx = right ? x + W - w : x;
    const g = ctx.createLinearGradient(bx, 0, bx + w, 0);
    if (full) {
      const t = 0.5 + 0.5 * Math.sin(this.clock * 0.3);
      g.addColorStop(0, shade('#ffc64d', 12 * t));
      g.addColorStop(0.5, '#fff3c4');
      g.addColorStop(1, shade(char.look.aura, 10 * t));
    } else {
      g.addColorStop(0, char.look.aura);
      g.addColorStop(1, shade(char.look.aura, 24));
    }
    ctx.fillStyle = g;
    ctx.fillRect(bx, y, w, H);

    if (full) {
      ctx.shadowColor = '#ffc64d';
      ctx.shadowBlur = 20 + 10 * Math.sin(this.clock * 0.3);
      ctx.fillRect(bx, y, w, H);
      ctx.shadowBlur = 0;
    }
    if (juice.meterPulse[i] > 0) {
      ctx.globalAlpha = juice.meterPulse[i] * 0.6;
      ctx.fillStyle = '#fff';
      ctx.fillRect(bx, y, w, H);
      ctx.globalAlpha = 1;
    }

    // Segment ticks
    ctx.strokeStyle = '#0a0c1099';
    ctx.lineWidth = 2;
    for (let s = 1; s < 4; s++) {
      ctx.beginPath();
      ctx.moveTo(x + (W / 4) * s, y);
      ctx.lineTo(x + (W / 4) * s, y + H);
      ctx.stroke();
    }
    ctx.strokeStyle = full ? '#ffc64d' : '#4a5468';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, W, H);

    ctx.font = '900 13px Impact, sans-serif';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = full ? '#ffc64d' : '#6d7789';
    ctx.fillText(full ? 'SUPER READY' : 'SUPER', right ? x + W : x, y - 6);
    ctx.restore();
  }

  /* ── Combo counter ───────────────────────────────────── */
  drawCombo(ctx, juice, i) {
    const c = juice.combo[i];
    if (!c || c.count < 2) return;
    const right = i === 1;
    const x = right ? VIEW_W - 120 : 120;
    const y = 210;
    const fade = Math.min(1, c.life / 20);

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.scale(c.scale, c.scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = '900 62px Impact, "Arial Black", sans-serif';
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#0a0c10';
    ctx.lineJoin = 'round';
    ctx.strokeText(String(c.count), 0, 0);
    const g = ctx.createLinearGradient(0, -34, 0, 34);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(1, '#ffa23d');
    ctx.fillStyle = g;
    ctx.fillText(String(c.count), 0, 0);

    ctx.font = '900 18px Impact, sans-serif';
    ctx.strokeText('HIT COMBO', 0, 38);
    ctx.fillStyle = '#eef2f8';
    ctx.fillText('HIT COMBO', 0, 38);

    if (c.word) {
      ctx.font = '900 15px Impact, sans-serif';
      ctx.strokeText(c.word, 0, 60);
      ctx.fillStyle = '#ffc64d';
      ctx.fillText(c.word, 0, 60);
    }
    ctx.font = '700 13px Inter, sans-serif';
    ctx.fillStyle = '#a7b0c0';
    ctx.fillText(`${c.damage} dmg`, 0, 80);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ── Speech bubbles ──────────────────────────────────── */
  drawQuotes(ctx, match, juice, cam) {
    for (let i = 0; i < 2; i++) {
      const q = juice.quotes[i];
      if (!q) continue;
      const f = match.fighters[i];
      const p = cam.toScreen(f.x, f.y + 230);
      const fade = Math.min(1, q.life / 16);
      const pop = q.life > q.maxLife - 6 ? (q.maxLife - q.life) / 6 : 1;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, Math.max(96, p.y));
      ctx.scale(pop, pop);

      ctx.font = q.big ? '800 21px Inter, sans-serif' : '700 17px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lines = wrap(ctx, q.text, 380);
      const lh = q.big ? 26 : 21;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 32;
      const h = lines.length * lh + 20;

      ctx.fillStyle = '#0d1119ee';
      ctx.strokeStyle = i === 0 ? '#4da3ff' : '#ff6b8a';
      ctx.lineWidth = 2.5;
      bubble(ctx, -w / 2, -h, w, h, 12);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#eef2f8';
      lines.forEach((l, n) => ctx.fillText(l, 0, -h + 14 + n * lh));
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* ── Super cut-in ────────────────────────────────────── */
  drawSuperCutIn(ctx, juice) {
    const s = juice.superCutIn;
    if (!s) return;
    const t = 1 - s.life / s.maxLife;
    // Slide in, hold, slide out.
    let off;
    if (t < 0.16) off = (1 - t / 0.16) ** 2;
    else if (t > 0.8) off = ((t - 0.8) / 0.2) ** 2;
    else off = 0;

    const right = s.fighter === 1;
    const w = 320, h = 340;
    const x = right ? VIEW_W - w - 40 + off * (w + 60) : 40 - off * (w + 60);
    const y = VIEW_H / 2 - h / 2;

    ctx.save();
    ctx.globalAlpha = 1 - off * 0.5;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + 24, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - 24, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.clip();

    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, shade(s.color, -50));
    g.addColorStop(1, '#05070b');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    // Speed lines behind the portrait.
    ctx.strokeStyle = s.color + '55';
    ctx.lineWidth = 3;
    for (let i = 0; i < 16; i++) {
      const ly = y + i * 22 + (juice.superCutIn.life * 3) % 22;
      ctx.beginPath();
      ctx.moveTo(x, ly);
      ctx.lineTo(x + w, ly - 30);
      ctx.stroke();
    }

    const thumb = this._thumb(s.charId);
    ctx.drawImage(thumb, x + w / 2 - 130, y + 30, 260, 260);
    ctx.restore();

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + 24, y); ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - 24, y + h); ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.stroke();

    ctx.font = '900 26px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#05070b';
    ctx.lineJoin = 'round';
    ctx.strokeText(s.name.toUpperCase(), x + w / 2, y + h - 22);
    ctx.fillStyle = '#fff3c4';
    ctx.fillText(s.name.toUpperCase(), x + w / 2, y + h - 22);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ── Announcer ───────────────────────────────────────── */
  drawAnnounce(ctx, juice) {
    const a = juice.announce;
    if (!a) return;
    const t = 1 - a.life / a.maxLife;
    const pop = t < 0.13 ? 0.4 + (t / 0.13) * 0.72 : 1 + Math.sin(t * 3) * 0.02;
    const fade = a.life < 16 ? a.life / 16 : 1;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(VIEW_W / 2, VIEW_H * 0.36);
    ctx.scale(pop, pop);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const size = a.big ? 96 : 56;
    ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;

    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = '#05070b';
    ctx.lineJoin = 'round';
    ctx.strokeText(a.text, 0, 0);

    const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#ffc64d');
    g.addColorStop(1, '#c4791a');
    ctx.fillStyle = g;
    ctx.shadowColor = '#ffc64daa';
    ctx.shadowBlur = 24;
    ctx.fillText(a.text, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ── Debug / netplay overlay ─────────────────────────── */
  drawDebug(ctx, extra) {
    const lines = extra.lines || [];
    ctx.save();
    ctx.font = '600 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const w = 232, h = lines.length * 16 + 14;
    ctx.fillStyle = '#05070bcc';
    ctx.fillRect(VIEW_W - w - 12, VIEW_H - h - 12, w, h);
    ctx.strokeStyle = '#ffffff1a';
    ctx.strokeRect(VIEW_W - w - 12, VIEW_H - h - 12, w, h);
    lines.forEach((l, i) => {
      ctx.fillStyle = l.startsWith('!') ? '#ff5468' : '#8fd0ff';
      ctx.fillText(l.replace(/^!/, ''), VIEW_W - w - 2, VIEW_H - h - 4 + i * 16);
    });
    ctx.restore();
  }
}

/* ── Shape helpers ────────────────────────────────────── */

/** Slanted bar, because straight rectangles look like a spreadsheet. */
function skew(ctx, x, y, w, h, dir) {
  const s = 10;
  ctx.beginPath();
  if (dir > 0) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - s, y + h);
    ctx.lineTo(x, y + h);
  } else {
    ctx.moveTo(x + s, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
  }
  ctx.closePath();
}

function bubble(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.lineTo(x + w / 2 + 9, y + h);
  ctx.lineTo(x + w / 2, y + h + 12);
  ctx.lineTo(x + w / 2 - 9, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = wd;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}
