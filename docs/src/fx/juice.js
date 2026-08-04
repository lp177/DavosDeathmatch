/* ══════════════════════════════════════════════════════════════
   Juice — turns simulation events into things you can feel.

   The simulation emits plain facts ("fighter 1 took 84 damage at
   x=120"). Everything expressive lives here: shake, freeze, flash,
   sparks, floating numbers, announcer barks, controller rumble.

   Keeping it in one place means the whole feel of the game can be
   tuned from a single file, and the simulation never has to know that
   presentation exists.
   ══════════════════════════════════════════════════════════════ */

import { settings } from '../core/settings.js';
import { audio } from '../core/audio.js';
import { input } from '../core/input.js';
import { ROSTER } from '../data/roster.js';

const COMBO_WORDS = [
  '', '', 'NICE', 'SOLID', 'BRUTAL', 'DEVASTATING', 'UNDIPLOMATIC',
  'SANCTIONED', 'GEOPOLITICAL', 'REGIME CHANGE', 'ABSOLUTE CARNAGE',
];

/** A line is either "text" or {text, style}. */
function normaliseLine(line, styleOverride = null) {
  if (!line) return { text: null, style: styleOverride };
  if (typeof line === 'string') return { text: line, style: styleOverride };
  return { text: line.text, style: styleOverride ?? line.style ?? null };
}

/** Resolve a character's base voice plus an optional delivery preset. */
function voiceFor(char, style) {
  const v = char.voice || {};
  const base = { pitch: v.pitch ?? 0.6, rate: v.rate ?? 0.95,
                 tremble: v.tremble ?? 0, drift: v.drift ?? 0 };
  const preset = style && v.styles ? v.styles[style] : null;
  return preset ? { ...base, ...preset } : base;
}

export class Juice {
  constructor(camera, particles) {
    this.cam = camera;
    this.px = particles;

    this.flash = 0;
    this.flashColor = '#ffffff';
    this.chroma = 0;
    this.vignette = 0;
    this.invert = 0;

    this.announce = null;          // {text, life, maxLife, big}
    this.combo = [null, null];     // per attacker
    this.quotes = [null, null];    // speech bubbles
    this.superCutIn = null;
    this.hitPause = 0;

    this.meterPulse = [0, 0];
    this.healthPulse = [0, 0];
    this.koActive = false;
  }

  reset() {
    this.flash = 0; this.chroma = 0; this.vignette = 0; this.invert = 0;
    this.announce = null;
    this.combo = [null, null];
    this.quotes = [null, null];
    this.superCutIn = null;
    this.koActive = false;
    this.meterPulse = [0, 0];
    this.healthPulse = [0, 0];
  }

  /* ── Per-frame decay ─────────────────────────────────── */
  update(dt) {
    this.flash = Math.max(0, this.flash - 0.09 * dt);
    this.chroma = Math.max(0, this.chroma - 0.055 * dt);
    this.vignette = Math.max(0, this.vignette - 0.03 * dt);
    this.invert = Math.max(0, this.invert - 0.14 * dt);

    if (this.announce) {
      this.announce.life -= dt;
      if (this.announce.life <= 0) this.announce = null;
    }
    for (let i = 0; i < 2; i++) {
      if (this.combo[i]) {
        this.combo[i].life -= dt;
        this.combo[i].scale += (1 - this.combo[i].scale) * 0.2 * dt;
        if (this.combo[i].life <= 0) this.combo[i] = null;
      }
      if (this.quotes[i]) {
        this.quotes[i].life -= dt;
        if (this.quotes[i].life <= 0) this.quotes[i] = null;
      }
      this.meterPulse[i] = Math.max(0, this.meterPulse[i] - 0.06 * dt);
      this.healthPulse[i] = Math.max(0, this.healthPulse[i] - 0.08 * dt);
    }
    if (this.superCutIn) {
      this.superCutIn.life -= dt;
      if (this.superCutIn.life <= 0) this.superCutIn = null;
    }
  }

  /* ── Event dispatch ──────────────────────────────────── */

  handle(events, match) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const fn = this['on' + e.type[0].toUpperCase() + e.type.slice(1)];
      if (fn) fn.call(this, e, match);
    }
  }

  pan(x) {
    return Math.max(-0.85, Math.min(0.85, x / 900));
  }

  /* — Impacts — */

  onHit(e, match) {
    const j = settings.juice;
    const heavy = e.heavy || e.damage >= 90;
    const power = Math.min(1.8, 0.45 + e.damage / 110);

    // Sparks fly away from the attacker.
    this.px.hitSpark(e.x, e.y, e.dir, power,
      e.counter ? '#ff9a4d' : (heavy ? '#fff0b0' : '#ffffff'));
    this.px.debris(e.x, e.y, power * 0.6, '#d9c9a0');

    this.cam.shake(heavy ? 0.34 * power : 0.15 * power, heavy ? 0.8 : 0.3);
    this.cam.impulse(e.dir * (heavy ? 9 : 3.5), 0);
    if (heavy) this.cam.punchZoom(0.045);

    this.flash = Math.min(1, this.flash + (heavy ? 0.34 : 0.13) * j.flash);
    this.flashColor = e.counter ? '#ffd9a0' : '#ffffff';
    if (j.chromatic && heavy) this.chroma = Math.min(1, this.chroma + 0.5);

    audio.play(heavy ? 'hitHeavy' : 'hitLight', { pan: this.pan(e.x) });
    input.rumble(e.fighter, heavy ? 0.85 : 0.35, heavy ? 130 : 70);

    // Floating damage number, bigger and hotter as the combo grows.
    const combo = e.combo || 1;
    this.px.floatText(e.x + (Math.random() - 0.5) * 26, e.y + 26, String(e.damage), {
      color: e.counter ? '#ff9a4d' : (combo > 4 ? '#ffc64d' : '#ffffff'),
      size: 24 + Math.min(22, combo * 2.4) + (heavy ? 8 : 0),
      vy: 3.4, life: 42,
    });

    if (e.counter) {
      this.px.floatText(e.x, e.y + 74, 'COUNTER', { color: '#ff9a4d', size: 26, life: 40 });
      this.cam.shake(0.22, 1);
    }

    if (combo >= 2) this.showCombo(e.attacker, combo, match);
    this.healthPulse[e.fighter] = 1;

    if (e.moveName && combo <= 1) {
      this.px.floatText(e.x, e.y + 108, e.moveName.toUpperCase(), {
        color: '#a7b0c0', size: 17, life: 34, vy: 2.2,
      });
    }
  }

  onBlock(e) {
    this.px.blockSpark(e.x, e.y, e.dir ?? 1);
    this.cam.shake(0.07, 0.2);
    this.flash = Math.min(1, this.flash + 0.05 * settings.juice.flash);
    input.rumble(e.fighter, 0.2, 45);
    this.px.floatText(e.x, e.y + 40, 'BLOCK', { color: '#8fd0ff', size: 18, life: 26, vy: 2.4 });
  }

  onArmorHit(e) {
    this.px.hitSpark(e.x, e.y, 1, 0.7, '#ffb04d');
    this.px.floatText(e.x, e.y + 46, 'ARMOR', { color: '#ffa23d', size: 21, life: 32 });
    this.cam.shake(0.16, 0.4);
  }

  onWhiffInvuln(e) {
    this.px.floatText(e.x, e.y + 40, 'MISS', { color: '#6d7789', size: 18, life: 24 });
  }

  onTechThrow(e) {
    this.px.hitSpark(e.x, e.y, 1, 1.1, '#8fd0ff');
    this.px.floatText(e.x, e.y + 60, 'TECH!', { color: '#8fd0ff', size: 30, life: 40 });
    this.cam.shake(0.2, 0.5);
    this.flash = Math.min(1, this.flash + 0.2);
  }

  onClash(e) {
    this.px.hitSpark(e.x, e.y, 1, 1.2, '#ffe08a');
    this.px.spawn({ kind: 'ring', x: e.x, y: e.y, life: 18, size: 20, grow: 6,
                    color: '#ffe08a', layer: 1 });
    this.cam.shake(0.16, 0.6);
    audio.play('parry', { pan: this.pan(e.x) });
  }

  onExplosion(e) {
    this.px.explosion(e.x, e.y + 60, e.size ?? 1, e.color ?? '#ffb04d');
    this.cam.shake(0.5 * (e.size ?? 1), 1);
    this.cam.punchZoom(0.07);
    this.flash = Math.min(1, this.flash + 0.5 * settings.juice.flash);
    this.flashColor = '#ffd9a0';
    this.chroma = settings.juice.chromatic ? 1 : 0;
  }

  onMeterSteal(e) {
    this.px.floatText(e.x, e.y + 80, '−METER', { color: '#b98fff', size: 20, life: 40 });
    for (let i = 0; i < 10; i++) {
      this.px.spawn({
        kind: 'ember', x: e.x + (Math.random() - 0.5) * 60, y: e.y + Math.random() * 60,
        vx: (Math.random() - 0.5) * 4, vy: 3 + Math.random() * 4,
        grav: 0.04, drag: 0.95, life: 26, size: 4 + Math.random() * 4,
        color: '#b98fff', glow: 1, layer: 1,
      });
    }
    this.meterPulse[e.to] = 1;
  }

  /* — Movement — */

  onLand(e) {
    this.px.dust(e.x, 0, e.hard ? 1.6 : 0.8);
    if (e.hard) this.cam.shake(0.1, 0.15);
    audio.play('land', { pan: this.pan(e.x), hard: e.hard });
  }

  onSfx(e) {
    audio.play(e.name, { pan: this.pan(e.x), ...e });
  }

  onTaunt(e, match) {
    const char = ROSTER[match.chars[e.fighter].id];
    const line = char.taunts[Math.floor(Math.random() * char.taunts.length)];
    this.showQuote(e.fighter, line, match);
    this.px.floatText(e.x, e.y + 210, '💬', { color: '#ffc64d', size: 30, life: 40 });
  }

  onQuote(e, match) {
    this.showQuote(e.fighter, e.text, match, 96, false, e.style ?? null);
  }

  onMoveStart(e, match) {
    const mv = e.move;
    if (mv.sfx) audio.play(mv.sfx, { pan: this.pan(e.x), heavy: mv.sfxHeavy });
    else if (mv.tier === 'normal') audio.play('whoosh', { pan: this.pan(e.x), heavy: mv.sfxHeavy });

    if (mv.tier === 'special' || mv.tier === 'super') {
      this.px.aura(e.x, e.y, ROSTER[match.chars[e.fighter].id].look.aura, 1.4);
    }
    if (mv.keepMomentum) this.px.speedLines(e.x, e.y + 100, match.fighters[e.fighter].facing, 1.4);
  }

  onSuperFlash(e, match) {
    const char = ROSTER[match.chars[e.fighter].id];
    this.flash = 1;
    this.flashColor = char.look.aura;
    this.invert = 0.85;
    this.chroma = settings.juice.chromatic ? 1 : 0;
    this.vignette = 1;
    this.cam.shake(0.55, 0.4);
    this.cam.punchZoom(0.16);
    this.cam.slow(46, 0.35);
    audio.play('superFlash', { pan: 0 });
    audio.play('riser', { dur: 1.1 });

    this.superCutIn = {
      fighter: e.fighter, charId: char.id, life: 62, maxLife: 62,
      name: e.move.name, color: char.look.aura,
    };
    this.showQuote(e.fighter, e.move.quote || char.taunts[0], match, 110, true,
                   e.move.voiceStyle ?? null);
    this.px.aura(e.x, e.y, char.look.aura, 6);
  }

  /* — Round flow — */

  onAnnounce(e) {
    this.announce = { text: e.text, life: e.big ? 92 : 78, maxLife: e.big ? 92 : 78, big: !!e.big };
    if (e.big) {
      this.cam.punchZoom(0.1);
      this.cam.shake(0.2, 0.2);
      this.flash = Math.min(1, this.flash + 0.3 * settings.juice.flash);
    }
    audio.speak(e.text, { pitch: 0.35, rate: e.big ? 0.85 : 0.95, force: true });
  }

  onRoundStart() {
    this.reset();
    this.cam.reset();
    this.px.clear();
  }

  onTimeLow() {
    audio.play('timeLow');
    this.announce = { text: 'HURRY UP', life: 60, maxLife: 60, big: false };
  }

  onKo(e, match) {
    this.koActive = true;
    this.cam.slow(110, 0.16);
    this.cam.shake(0.9, 1);
    this.cam.punchZoom(0.22);
    this.flash = 1;
    this.flashColor = '#ffffff';
    this.chroma = settings.juice.chromatic ? 1 : 0;
    this.vignette = 1;
    this.announce = { text: 'K.O.', life: 150, maxLife: 150, big: true };
    this.px.explosion(e.x, e.y + 90, 1.5, '#ff5468');
    this.px.debris(e.x, e.y + 60, 2.4, '#ffffff');
    audio.play('ko', { pan: this.pan(e.x) });
    audio.speak('K O!', { pitch: 0.3, rate: 0.8, force: true });
    input.rumble(0, 1, 400);
    input.rumble(1, 1, 400);
  }

  onDraw() {
    this.announce = { text: 'DRAW', life: 130, maxLife: 130, big: true };
    audio.play('bell');
  }

  onRoundOver(e, match) {
    if (e.perfect) {
      setTimeout(() => {
        this.announce = { text: 'PERFECT', life: 110, maxLife: 110, big: true };
        audio.speak('Perfect!', { pitch: 0.35, force: true });
      }, 900);
    }
    this.px.confetti(match.fighters[e.winner].x, 0, 26);
  }

  onVictoryPose(e, match) {
    const char = ROSTER[match.chars[e.fighter].id];
    const line = char.winQuotes[Math.floor(Math.random() * char.winQuotes.length)];
    this.showQuote(e.fighter, line, match, 150);
    this.px.confetti(match.fighters[e.fighter].x, 0, 40);
  }

  onMatchOver() {
    this.cam.slow(140, 0.3);
  }

  onMeterFull(e) {
    audio.play('meterFull');
    this.meterPulse[e.fighter] = 1;
  }

  onDizzyIncoming(e, match) {
    const f = match.fighters[e.fighter];
    this.px.floatText(f.x, f.y + 220, 'DIZZY', { color: '#ffc64d', size: 26, life: 46 });
  }

  onProjSpawn(e) {
    const p = e.proj;
    this.px.aura(p.x, p.y - 30, p.color, 0.6);
  }

  onProjGone(e) {
    const p = e.proj;
    if (p.exploded) return;
    this.px.hitSpark(p.x, p.y, p.vx > 0 ? 1 : -1, 0.5, p.color);
  }

  /* ── Helpers ─────────────────────────────────────────── */

  showCombo(attacker, count, match) {
    const dmg = match.fighters[1 - attacker].comboDamage;
    this.combo[attacker] = {
      count, damage: dmg, life: 90, scale: 1.9,
      word: COMBO_WORDS[Math.min(count, COMBO_WORDS.length - 1)],
    };
    if (count === 5 || count === 8 || count === 12) {
      this.cam.punchZoom(0.05);
    }
  }

  /**
   * Show a line and speak it in the character's voice.
   * `line` may be a plain string or {text, style}; `style` selects one of
   * the character's delivery presets (rage, grief, …).
   */
  showQuote(fighter, line, match, life = 96, big = false, styleOverride = null) {
    const { text, style } = normaliseLine(line, styleOverride);
    if (!text) return;

    // The `|` marks are beats for the speech engine, not punctuation the
    // player should read in the bubble.
    this.quotes[fighter] = {
      text: text.replace(/\s*\|\s*/g, ' '),
      life, maxLife: life, big,
    };

    const char = ROSTER[match.chars[fighter].id];
    audio.speak(text, { ...voiceFor(char, style), force: big });
  }
}
