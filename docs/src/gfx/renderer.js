/* ══════════════════════════════════════════════════════════════
   Renderer — composes one frame.

   Order: stage → back particles → afterimages → fighters → projectiles
   → front particles → post-processing → HUD.

   The world is drawn into an offscreen buffer so the post pass can do
   a real RGB split for chromatic aberration on heavy hits without
   paying for it on every ordinary frame.
   ══════════════════════════════════════════════════════════════ */

import { VIEW_W, VIEW_H, FLOOR_SCREEN_Y, S } from '../sim/constants.js';
import { hurtbox, worldBox, movePhase } from '../sim/fighter.js';
import { projBox } from '../sim/match.js';
import { drawFighter, shade, animOf } from './caricature.js';
import { StageRenderer, STAGES, tierOf } from './stage.js';
import { Hud } from './hud.js';
import { settings } from '../core/settings.js';

const TAU = Math.PI * 2;
const TRAIL_LEN = 14;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.world = makeCanvas(VIEW_W, VIEW_H);
    this.wctx = this.world.getContext('2d');
    this.chA = makeCanvas(VIEW_W, VIEW_H);
    this.chB = makeCanvas(VIEW_W, VIEW_H);

    this.stage = new StageRenderer();
    this.hud = new Hud();
    this.clock = 0;
    this.trails = [[], []];
    this.noise = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    // Letterbox: the canvas keeps a fixed 16:9 backing store and CSS
    // scales it, which keeps all gameplay coordinates resolution-free.
    const wrapW = window.innerWidth;
    const wrapH = window.innerHeight;
    const scale = Math.min(wrapW / VIEW_W, wrapH / VIEW_H);
    this.canvas.style.width = Math.floor(VIEW_W * scale) + 'px';
    this.canvas.style.height = Math.floor(VIEW_H * scale) + 'px';

    // Render at device resolution when it costs little.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(VIEW_W * dpr), bh = Math.round(VIEW_H * dpr);
    if (this.canvas.width !== bw) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.dpr = dpr;
  }

  reset(stageId, tier = 0) {
    this.stage.setStage(stageId, tier);
    this.hud.reset();
    this.trails = [[], []];
  }

  /** Switch tiers mid-match, after a knock-off. */
  setTier(stageId, tier) {
    this.stage.setStage(stageId, tier);
    this.trails = [[], []];
  }

  /**
   * @param match  simulation state
   * @param cam    camera
   * @param px     particle system
   * @param juice  effect state
   * @param dt     frames elapsed
   * @param extra  {debug, lines, training}
   */
  draw(match, cam, px, juice, dt, extra = {}) {
    this.clock += dt;
    const w = this.wctx;

    /* ── World ─────────────────────────────────────────── */
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.globalAlpha = 1;
    w.fillStyle = '#05070b';
    w.fillRect(0, 0, VIEW_W, VIEW_H);

    this.stage.draw(w, cam, dt);
    const wind = settings.juice.weather ? this.stage.windAt(this.stage.clock) : 0;

    w.save();
    cam.apply(w);

    // Highlight the ledge only while there's actually somewhere to fall.
    this.stage.drawWalls(w, match.tier < match.maxTier && match.phase === 'fight');
    px.draw(w, -1);
    this.drawTrails(w, match);

    // Fighters: the one further back draws first.
    const order = match.fighters[0].y > match.fighters[1].y ? [1, 0] : [0, 1];
    for (const i of order) {
      const f = match.fighters[i];
      const char = match.chars[i];
      const mv = f.moveId ? char.moves[f.moveId] : null;
      this.drawAura(w, f, char, mv);
      drawFighter(w, f, char, mv, this.clock, { wind });
      this.recordTrail(i, f, char, mv);
    }
    // Reflections, where the ground is wet enough to have them.
    if (this.stage.isWet && settings.juice.weather) {
      for (const i of order) {
        const f = match.fighters[i];
        if (f.y > 120) continue;
        const char = match.chars[i];
        const mv = f.moveId ? char.moves[f.moveId] : null;
        w.save();
        w.translate(0, 6);
        w.scale(1, -1);          // mirrored in the puddle
        drawFighter(w, f, char, mv, this.clock,
                    { wind, alpha: 0.16, noShadow: true });
        w.restore();
      }
    }

    for (const p of match.projectiles) this.drawProjectile(w, p, match);

    if (juice.fatality) this.drawFatality(w, match, juice.fatality);

    px.draw(w, 1);

    if (settings.data.video.showHitboxes || extra.training) this.drawBoxes(w, match);

    w.restore();

    // Weather sits over the world in screen space: it's between the
    // camera and everything else, so it must not move with the camera.
    if (settings.juice.weather) {
      this.stage.drawWetFloor(w, cam);
      this.stage.drawWeather(w, cam, dt);
    }

    /* ── Post ──────────────────────────────────────────── */
    this.post(w, juice, cam);

    /* ── Blit + HUD ────────────────────────────────────── */
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.imageSmoothingEnabled = true;

    if (juice.chroma > 0.02 && settings.juice.chromatic) {
      this.blitChromatic(c, juice.chroma);
    } else {
      c.drawImage(this.world, 0, 0);
    }

    this.hud.update(match, dt);
    this.hud.draw(c, match, juice, cam, extra);

    if (settings.juice.grain) this.grain(c);
  }

  /* ── Aura behind specials/supers ─────────────────────── */
  drawAura(ctx, f, char, mv) {
    const supering = mv && mv.tier === 'super';
    const specialing = mv && mv.tier === 'special';
    const armored = f.armorFrames > 0;
    const invuln = f.invuln > 0;
    if (!supering && !specialing && !armored && !invuln && f.state !== S.DIZZY) return;

    const colour = supering ? '#fff3c4'
      : armored ? '#ffa23d'
      : invuln ? '#8fd0ff'
      : char.look.aura;
    const strength = supering ? 1 : specialing ? 0.5 : 0.7;
    const pulse = 0.72 + 0.28 * Math.sin(this.clock * 0.32);

    ctx.save();
    ctx.translate(f.x, -f.y);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, -90, 8, 0, -90, 150 * strength * pulse);
    g.addColorStop(0, colour + '55');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, -90, 150 * strength * pulse, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (f.state === S.DIZZY) this.drawDizzyStars(ctx, f);
  }

  drawDizzyStars(ctx, f) {
    ctx.save();
    ctx.translate(f.x, -f.y - 210);
    for (let i = 0; i < 4; i++) {
      const a = this.clock * 0.1 + (i / 4) * TAU;
      const x = Math.cos(a) * 40;
      const y = Math.sin(a) * 12;
      const s = 7 + Math.sin(a) * 2.5;
      ctx.fillStyle = '#ffc64d';
      ctx.shadowColor = '#ffc64d';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let p = 0; p < 10; p++) {
        const pa = (p / 10) * TAU - Math.PI / 2;
        const r = p % 2 === 0 ? s : s * 0.45;
        const px = x + Math.cos(pa) * r, py = y + Math.sin(pa) * r;
        p === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /* ── Afterimages ─────────────────────────────────────── */
  recordTrail(i, f, char, mv) {
    const fast = Math.abs(f.vx) > 7 || f.state === S.DASH_F || f.state === S.DASH_B ||
                 (mv && (mv.tier === 'super' || mv.keepMomentum));
    const t = this.trails[i];
    t.push({
      x: f.x, y: f.y, facing: f.facing, state: f.state, stateFrame: f.stateFrame,
      moveId: f.moveId, moveFrame: f.moveFrame, hitstun: f.hitstun, blockstun: f.blockstun,
      vx: f.vx, vy: f.vy, id: f.id, active: fast,
      invuln: f.invuln, armorFrames: f.armorFrames, dizzyLeft: f.dizzyLeft,
    });
    if (t.length > TRAIL_LEN) t.shift();
  }

  drawTrails(ctx, match) {
    if (!settings.juice.afterimages) return;
    for (let i = 0; i < 2; i++) {
      const t = this.trails[i];
      const char = match.chars[i];
      if (!t.length || !t[t.length - 1].active) continue;
      for (let n = 1; n <= 3; n++) {
        const g = t[t.length - 1 - n * 3];
        if (!g) continue;
        // Skip ghosts that haven't travelled — overlapping silhouettes just
        // read as a smear stuck to the character.
        if (Math.abs(g.x - t[t.length - 1].x) < 12 * n) continue;
        const mv = g.moveId ? char.moves[g.moveId] : null;
        drawFighter(ctx, g, char, mv, this.clock, {
          alpha: 0.22 - n * 0.055,
          silhouette: true,
          tint: char.look.aura,
          noShadow: true,
        });
      }
    }
  }

  /* ══════════════════════════════════════════════════════
     Projectiles
     ══════════════════════════════════════════════════════ */
  drawProjectile(ctx, p, match) {
    ctx.save();
    ctx.translate(p.x, -p.y);
    const spin = p.spin ? this.clock * p.spin : 0;
    const wob = p.wobble ? Math.sin(this.clock * 0.3) * p.wobble : 0;
    ctx.translate(0, wob);

    // Shared glow.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, p.w * 1.1);
    g.addColorStop(0, p.color + 'aa');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, p.w * 1.1, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.scale(p.facing, 1);
    ctx.rotate(spin);

    switch (p.kind) {
      case 'card': {
        ctx.fillStyle = '#ffc64d';
        rr(ctx, -28, -19, 56, 38, 5); ctx.fill();
        ctx.strokeStyle = '#fff3c4'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#8a6a12';
        ctx.fillRect(-20, -10, 30, 5);
        ctx.fillRect(-20, 1, 40, 4);
        ctx.fillStyle = '#fff';
        ctx.fillRect(10, -14, 14, 10);
        break;
      }
      case 'wall': {
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fillStyle = '#8a6a12';
        for (let y = -p.h / 2; y < p.h / 2; y += 20) {
          ctx.fillRect(-p.w / 2, y, p.w, 3);
        }
        ctx.strokeStyle = '#fff3c4'; ctx.lineWidth = 3;
        ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fillStyle = '#5a4a10';
        ctx.font = '900 15px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.save(); ctx.scale(p.facing, 1);   // undo the facing mirror, keep y upright
        ctx.fillText('TARIFF', 0, 6);
        ctx.restore();
        break;
      }
      case 'shout': case 'word': {
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#0a2a14';
        ctx.lineWidth = 3;
        ctx.font = `900 ${p.kind === 'shout' ? 30 : 22}px Impact, sans-serif`;
        ctx.textAlign = 'center';
        ctx.save(); ctx.scale(p.facing, 1);   // undo the facing mirror, keep y upright
        const txt = p.kind === 'shout' ? 'HOW DARE YOU' : 'BLAH';
        ctx.strokeText(txt, 0, 8);
        ctx.fillText(txt, 0, 8);
        ctx.restore();
        break;
      }
      case 'missile': {
        ctx.fillStyle = '#c8ccd4';
        ctx.beginPath();
        ctx.moveTo(30, 0); ctx.lineTo(-16, -12); ctx.lineTo(-24, 0); ctx.lineTo(-16, 12);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ff5468';
        ctx.fillRect(-16, -12, 10, 24);
        // Exhaust
        ctx.fillStyle = '#ffb04d';
        ctx.beginPath();
        ctx.moveTo(-24, -7);
        ctx.lineTo(-46 - Math.random() * 18, 0);
        ctx.lineTo(-24, 7);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'dart': {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(24, 0); ctx.lineTo(-20, -6); ctx.lineTo(-20, 6);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'frost': {
        ctx.fillStyle = p.color + 'cc';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + spin;
          ctx.save();
          ctx.rotate(a);
          ctx.fillRect(-3, -p.h / 2, 6, p.h);
          ctx.restore();
        }
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
        break;
      }
      case 'tweet': {
        ctx.fillStyle = '#12151c';
        rr(ctx, -22, -16, 44, 32, 6); ctx.fill();
        ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '900 18px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.save(); ctx.scale(p.facing, 1);   // undo the facing mirror, keep y upright ctx.fillText('X', 0, 6); ctx.restore();
        break;
      }
      case 'peso': {
        ctx.fillStyle = '#7ec8a0';
        rr(ctx, -30, -21, 60, 42, 4); ctx.fill();
        ctx.strokeStyle = '#3f6b53'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#3f6b53';
        ctx.font = '900 22px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.save(); ctx.scale(p.facing, 1);   // undo the facing mirror, keep y upright ctx.fillText('$', 0, 8); ctx.restore();
        break;
      }
      case 'jet': {
        ctx.fillStyle = '#c8d6e5';
        ctx.beginPath();
        ctx.moveTo(48, 0); ctx.lineTo(-20, -10); ctx.lineTo(-40, -4);
        ctx.lineTo(-40, 4); ctx.lineTo(-20, 10);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#7f8b9a';
        ctx.beginPath();
        ctx.moveTo(6, 0); ctx.lineTo(-14, -26); ctx.lineTo(-2, -26);
        ctx.lineTo(14, 0);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#9fd6ff';
        ctx.beginPath();
        ctx.moveTo(-40, -3); ctx.lineTo(-70 - Math.random() * 20, 0); ctx.lineTo(-40, 3);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'carrier': {
        ctx.fillStyle = '#8f9aa8';
        rr(ctx, -75, -20, 150, 34, 6); ctx.fill();
        ctx.fillStyle = '#c8d6e5';
        rr(ctx, -30, -44, 46, 26, 4); ctx.fill();
        ctx.fillStyle = '#20242c';
        for (let i = 0; i < 5; i++) ctx.fillRect(-64 + i * 26, -6, 16, 4);
        ctx.fillStyle = '#ffc64d';
        ctx.beginPath(); ctx.arc(56, -6, 5, 0, TAU); ctx.fill();
        break;
      }
      case 'drone': {
        ctx.fillStyle = '#3a3f4b';
        rr(ctx, -18, -8, 36, 16, 4); ctx.fill();
        ctx.strokeStyle = p.color; ctx.lineWidth = 2.5;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * 12, -6); ctx.lineTo(s * 26, -16);
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(s * 26, -16, 14, 2.5 + Math.sin(this.clock) * 1.5, 0, 0, TAU);
          ctx.stroke();
        }
        ctx.fillStyle = '#ff5468';
        ctx.beginPath(); ctx.arc(0, 4, 3, 0, TAU); ctx.fill();
        break;
      }
      case 'crowd': {
        // A wall of protest silhouettes.
        for (let i = 0; i < 5; i++) {
          const ox = -p.w / 2 + i * (p.w / 5) + 14;
          const bob = Math.sin(this.clock * 0.2 + i) * 5;
          ctx.fillStyle = i % 2 ? shade(p.color, -34) : shade(p.color, -18);
          ctx.beginPath();
          ctx.arc(ox, -p.h * 0.62 + bob, 13, 0, TAU);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(ox - 17, p.h * 0.5);
          ctx.quadraticCurveTo(ox, -p.h * 0.5 + bob, ox + 17, p.h * 0.5);
          ctx.closePath();
          ctx.fill();
          if (i % 2 === 0) {
            ctx.fillStyle = '#f5f2e8';
            ctx.fillRect(ox - 16, -p.h * 0.92 + bob, 34, 22);
          }
        }
        break;
      }
      case 'bolt': {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 30;
        ctx.beginPath();
        ctx.moveTo(0, -p.h / 2);
        let yy = -p.h / 2;
        let xx = 0;
        while (yy < p.h / 2) {
          yy += 26;
          xx = (Math.random() - 0.5) * 30;
          ctx.lineTo(xx, yy);
        }
        ctx.stroke();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 18;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        break;
      }
      case 'vortex': {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 5;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 20;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          const r = 20 + i * 16;
          ctx.ellipse(0, 0, r, r * 1.5, spin + i, 0, TAU * 0.7);
          ctx.stroke();
        }
        break;
      }
      case 'rocket': {
        ctx.fillStyle = '#e8ecf2';
        rr(ctx, -22, -p.h / 2, 44, p.h * 0.8, 20); ctx.fill();
        ctx.fillStyle = '#20242c';
        ctx.fillRect(-22, -p.h * 0.1, 44, 10);
        ctx.fillStyle = '#ffb04d';
        ctx.beginPath();
        ctx.moveTo(-18, p.h * 0.3);
        ctx.lineTo(0, p.h * 0.62 + Math.random() * 30);
        ctx.lineTo(18, p.h * 0.3);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'boom': case 'reset': case 'nuke': {
        const t = p.age / p.life;
        const r = p.w * (0.4 + t * 0.9);
        ctx.globalCompositeOperation = 'lighter';
        const bg = ctx.createRadialGradient(0, 0, 2, 0, 0, r);
        bg.addColorStop(0, '#fff8e0');
        bg.addColorStop(0.4, p.color);
        bg.addColorStop(1, 'transparent');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
        if (p.kind === 'nuke') {
          ctx.fillStyle = p.color + '99';
          ctx.beginPath();
          ctx.arc(0, -r * 1.3, r * 0.8, 0, TAU);
          ctx.fill();
          ctx.fillRect(-r * 0.22, -r * 1.3, r * 0.44, r * 1.4);
        }
        break;
      }
      case 'drain': {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 4;
        ctx.shadowColor = p.color; ctx.shadowBlur = 18;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(0, 0, 12 + i * 10, spin * (i + 1), spin * (i + 1) + 4);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.fill();
        break;
      }
      case 'reform': {
        ctx.fillStyle = p.color + '55';
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3;
        ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fillStyle = '#fff';
        ctx.font = '900 19px Impact, sans-serif';
        ctx.textAlign = 'center';
        ctx.save(); ctx.scale(p.facing, 1);   // undo the facing mirror, keep y upright
        ctx.fillText('64', 0, 6);
        ctx.restore();
        break;
      }
      default: {
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 5, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════
     Fatality: the trophy leaves the loser and ends up overhead.
     ══════════════════════════════════════════════════════ */
  drawFatality(ctx, match, ft) {
    const loser = match.fighters[ft.loser];
    const winner = match.fighters[ft.winner];
    const f = ft.frame;
    if (f < 96) return;                       // nothing pulled out yet

    // 96 → 150: rises out of the body. 150+: held aloft, swaying.
    const t = Math.min(1, (f - 96) / 54);
    const ease = t * t * (3 - 2 * t);
    const sx = loser.x + (winner.x - loser.x) * ease;
    const sy = (loser.y + 100) + (200 - (loser.y + 100)) * ease
             + (f > 150 ? Math.sin(f * 0.08) * 6 : 0);

    ctx.save();
    ctx.translate(sx, -sy);

    // It drips the whole time it's up there.
    ctx.shadowColor = ft.trophy.color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = ft.trophy.color;

    if (ft.trophy.kind === 'organ') {
      if (ft.trophy.label.includes('SPINE')) {
        ctx.fillRect(-4, -46, 8, 92);
        ctx.fillStyle = '#e8e2d4';
        for (let i = -4; i <= 4; i++) {
          ctx.beginPath();
          ctx.ellipse(0, i * 11, 11, 4.6, 0, 0, TAU);
          ctx.fill();
        }
      } else {
        // A heart, beating.
        const pulse = 1 + Math.sin(f * 0.34) * 0.09;
        ctx.scale(pulse, pulse);
        ctx.beginPath();
        ctx.moveTo(0, 18);
        ctx.bezierCurveTo(-26, -4, -14, -26, 0, -12);
        ctx.bezierCurveTo(14, -26, 26, -4, 0, 18);
        ctx.fill();
        ctx.fillStyle = '#5e0a12';
        ctx.fillRect(-3, -24, 6, 12);
      }
    } else {
      // A prop: a plaque with its name, still dripping.
      ctx.fillStyle = ft.trophy.color;
      rr(ctx, -40, -18, 80, 36, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#05070b';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = '#05070b';
      ctx.font = '900 13px Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.trophy.label.replace(/^THE /, ''), 0, 5);
    }

    // Blood running off whatever it is.
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#8e0f1a';
    for (let i = 0; i < 3; i++) {
      const dx = -16 + i * 16;
      const len = 8 + ((f * 0.6 + i * 20) % 26);
      ctx.fillRect(dx, 14, 3, len);
    }
    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════
     Debug boxes
     ══════════════════════════════════════════════════════ */
  drawBoxes(ctx, match) {
    ctx.save();
    ctx.lineWidth = 2;
    for (let i = 0; i < 2; i++) {
      const f = match.fighters[i];
      const hb = worldBox(f, hurtbox(f));
      ctx.strokeStyle = f.invuln > 0 ? '#8fd0ff' : '#4ddb92';
      ctx.fillStyle = (f.invuln > 0 ? '#8fd0ff' : '#4ddb92') + '22';
      ctx.fillRect(hb.x, -hb.y - hb.h, hb.w, hb.h);
      ctx.strokeRect(hb.x, -hb.y - hb.h, hb.w, hb.h);

      // Pushbox
      ctx.strokeStyle = '#ffffff44';
      ctx.strokeRect(f.x - 31, -f.y - 180, 62, 180);

      if (f.moveId) {
        const mv = match.chars[i].moves[f.moveId];
        for (const b of (mv.boxes || [])) {
          if (f.moveFrame < b.f0 || f.moveFrame > b.f1) continue;
          const wb = worldBox(f, b);
          ctx.strokeStyle = '#ff5468';
          ctx.fillStyle = '#ff546833';
          ctx.fillRect(wb.x, -wb.y - wb.h, wb.w, wb.h);
          ctx.strokeRect(wb.x, -wb.y - wb.h, wb.w, wb.h);
        }
      }
    }
    for (const p of match.projectiles) {
      const b = projBox(p);
      ctx.strokeStyle = '#ffc64d';
      ctx.strokeRect(b.x, -b.y - b.h, b.w, b.h);
    }
    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════
     Post-processing
     ══════════════════════════════════════════════════════ */
  post(w, juice, cam) {
    // Speed lines during slow motion / big moments.
    if (juice.vignette > 0.02) {
      const g = w.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.28,
                                       VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.85);
      g.addColorStop(0, 'transparent');
      g.addColorStop(1, `rgba(4,6,10,${0.75 * juice.vignette})`);
      w.fillStyle = g;
      w.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    if (juice.invert > 0.02) {
      w.save();
      w.globalCompositeOperation = 'difference';
      w.globalAlpha = juice.invert;
      w.fillStyle = '#ffffff';
      w.fillRect(0, 0, VIEW_W, VIEW_H);
      w.restore();
    }

    if (juice.flash > 0.01) {
      w.save();
      w.globalCompositeOperation = 'lighter';
      w.globalAlpha = Math.min(1, juice.flash * 0.9);
      w.fillStyle = juice.flashColor;
      w.fillRect(0, 0, VIEW_W, VIEW_H);
      w.restore();
    }
    w.globalAlpha = 1;
    w.globalCompositeOperation = 'source-over';
  }

  /** Real red/cyan split, only paid for when chroma is actually up. */
  blitChromatic(c, amount) {
    const d = amount * 9;
    const a = this.chA.getContext('2d');
    const b = this.chB.getContext('2d');

    a.globalCompositeOperation = 'source-over';
    a.clearRect(0, 0, VIEW_W, VIEW_H);
    a.drawImage(this.world, 0, 0);
    a.globalCompositeOperation = 'multiply';
    a.fillStyle = '#ff0000';
    a.fillRect(0, 0, VIEW_W, VIEW_H);

    b.globalCompositeOperation = 'source-over';
    b.clearRect(0, 0, VIEW_W, VIEW_H);
    b.drawImage(this.world, 0, 0);
    b.globalCompositeOperation = 'multiply';
    b.fillStyle = '#00ffff';
    b.fillRect(0, 0, VIEW_W, VIEW_H);

    c.fillStyle = '#000';
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    c.globalCompositeOperation = 'lighter';
    c.drawImage(this.chA, d, 0);
    c.drawImage(this.chB, -d, 0);
    c.globalCompositeOperation = 'source-over';
  }

  grain(c) {
    if (!this.noise) {
      const n = makeCanvas(160, 160);
      const nc = n.getContext('2d');
      const img = nc.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 90;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      nc.putImageData(img, 0, 0);
      this.noise = n;
      this.noisePattern = c.createPattern(n, 'repeat');
    }
    c.save();
    c.globalAlpha = 0.045;
    c.globalCompositeOperation = 'overlay';
    c.translate((Math.random() * 160) | 0, (Math.random() * 160) | 0);
    c.fillStyle = this.noisePattern;
    c.fillRect(-160, -160, VIEW_W + 320, VIEW_H + 320);
    c.restore();
  }
}

/* ── Helpers ─────────────────────────────────────────── */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
