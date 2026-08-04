/* ══════════════════════════════════════════════════════════════
   Audio — everything is synthesised at runtime. No asset files.

   Three buses hang off a master compressor:
     sfx       — impacts, whooshes, projectiles, UI
     music     — a procedurally sequenced loop, scheduled with lookahead
     announcer — SpeechSynthesis for "ROUND ONE… FIGHT!" and voice lines

   A short procedurally-generated impulse response gives the stage a
   convolution reverb, which is most of what makes hits sound big.
   ══════════════════════════════════════════════════════════════ */

import { settings } from './settings.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.noiseBuf = null;
    this.music = null;
    this._voiceCache = null;
    this._lastSpoke = 0;
  }

  /* ── Lifecycle ─────────────────────────────────────────── */

  /** Must be called from a user gesture (autoplay policy). */
  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;                 // no WebAudio: game still runs, silently
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.22;

    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeImpulse(1.9, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.22;

    this.sfxBus.connect(this.comp);
    this.sfxBus.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this.noiseBuf = this._makeNoise(2);
    this.applyVolumes();
    settings.onChange(() => this.applyVolumes());

    // Browsers suspend the context when the tab is hidden; mirror that
    // for an explicit "mute when unfocused" preference too.
    window.addEventListener('blur', () => {
      if (settings.data.audio.muteOnBlur) this.master.gain.value = 0;
    });
    window.addEventListener('focus', () => this.applyVolumes());

    this.ready = true;
    this.music = new MusicEngine(this);
  }

  applyVolumes() {
    if (!this.ctx) return;
    const a = settings.data.audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.master, t, 0.02);
    this.sfxBus.gain.setTargetAtTime(a.sfx, t, 0.02);
    this.musicBus.gain.setTargetAtTime(a.music, t, 0.05);
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  /* ── Buffer helpers ────────────────────────────────────── */

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Exponentially-decaying noise = a serviceable room reverb. */
  _makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  /* ── Primitive voices ──────────────────────────────────── */

  _noise(dest, { start = 0, dur = 0.2, gain = 0.4, type = 'bandpass',
                 freq = 1200, q = 1, sweepTo = null, curve = 'exp' } = {}) {
    const ctx = this.ctx;
    const t0 = this.t + start;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;

    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    filt.Q.value = q;
    if (sweepTo != null) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.2));
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.linearRampToValueAtTime(0, t0 + dur);

    src.connect(filt); filt.connect(g); g.connect(dest || this.sfxBus);
    src.start(t0); src.stop(t0 + dur + 0.05);
    return g;
  }

  _tone(dest, { start = 0, dur = 0.2, gain = 0.3, type = 'sine',
                freq = 220, to = null, detune = 0, curve = 'exp' } = {}) {
    const ctx = this.ctx;
    const t0 = this.t + start;
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(freq, t0);
    if (to != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.01, dur * 0.25));
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.linearRampToValueAtTime(0, t0 + dur);

    o.connect(g); g.connect(dest || this.sfxBus);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return g;
  }

  /**
   * Stereo placement from world x so hits land on the correct side.
   * @param {number} pan -1..1
   */
  _panned(pan = 0) {
    if (!this.ctx.createStereoPanner) return this.sfxBus;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.sfxBus);
    return p;
  }

  /* ── The sound library ─────────────────────────────────── */

  play(name, opts = {}) {
    if (!this.ready) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    const dest = this._panned(opts.pan ?? 0);
    try {
      fn(this, dest, opts);
    } catch {
      /* An oscillator failing must never break the frame. */
    }
  }

  /* ── Announcer / voice lines via OS speech synthesis ───── */

  /**
   * Speak a line with a delivery, not just a pitch.
   *
   * A flat text-to-speech read makes every character sound like a train
   * announcement, which kills the joke. Two things fix that:
   *
   *   `|` in the text marks a beat. Each fragment becomes its own
   *   utterance, and the gap between utterances gives a real pause — the
   *   difference between "how dare you" and "How. Dare. You."
   *
   *   `tremble` walks the pitch and rate slightly between fragments, so a
   *   furious or tearful line wavers instead of running level.
   */
  speak(text, { pitch = 0.55, rate = 0.95, volume = 1, force = false,
                tremble = 0, drift = 0 } = {}) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const vol = settings.data.audio.announcer * settings.data.audio.master * volume;
    if (vol <= 0.01) return;

    // Don't let voice lines pile up during a long combo.
    const now = performance.now();
    if (!force && now - this._lastSpoke < 420) return;
    this._lastSpoke = now;
    if (force) synth.cancel();

    if (!this._voiceCache) this._voiceCache = synth.getVoices();
    const voice = this._voiceCache.find((x) => /en[-_](US|GB)/i.test(x.lang));

    const parts = String(text).split('|').map((s) => s.trim()).filter(Boolean);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      // Alternate the wobble so consecutive beats push against each other,
      // and let `drift` bend the whole line (rising anger, sinking grief).
      const wob = tremble ? (i % 2 === 0 ? tremble : -tremble * 0.65) : 0;
      const through = parts.length > 1 ? i / (parts.length - 1) : 0;
      u.pitch = clamp(pitch + wob + drift * through, 0, 2);
      // Land the last beat slower — that's where the weight goes.
      u.rate = clamp(rate * (i === parts.length - 1 ? 0.88 : 1), 0.1, 10);
      u.volume = Math.min(1, vol);
      try {
        if (voice) u.voice = voice;
        synth.speak(u);
      } catch {
        // Speech is decorative: a backgrounded tab, a missing voice list or a
        // hostile shim must never take the frame down with it.
      }
    });
  }

  stopSpeech() {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }
}

/* ══════════════════════════════════════════════════════════════
   Sound definitions. Each receives (engine, destination, options).
   ══════════════════════════════════════════════════════════════ */
const SOUNDS = {
  /* — Movement — */
  whoosh: (a, d, o) => {
    const h = o.heavy ? 1 : 0;
    a._noise(d, { dur: 0.16 + h * 0.08, gain: 0.16 + h * 0.12, type: 'bandpass',
                  freq: 900 + h * 300, sweepTo: 240, q: 1.4 });
  },
  jump: (a, d) => {
    a._noise(d, { dur: 0.13, gain: 0.11, type: 'highpass', freq: 500, sweepTo: 2400 });
    a._tone(d, { dur: 0.15, gain: 0.1, type: 'sine', freq: 180, to: 420 });
  },
  land: (a, d, o) => {
    a._tone(d, { dur: 0.14, gain: 0.24 * (o.hard ? 1.6 : 1), type: 'sine', freq: 120, to: 45 });
    a._noise(d, { dur: 0.2, gain: 0.14, type: 'lowpass', freq: 900, sweepTo: 180 });
  },
  dash: (a, d) => {
    a._noise(d, { dur: 0.22, gain: 0.15, type: 'bandpass', freq: 380, sweepTo: 1500, q: 2.2 });
  },

  /* — Impacts — */
  hitLight: (a, d) => {
    a._tone(d, { dur: 0.1, gain: 0.34, type: 'triangle', freq: 340, to: 110 });
    a._noise(d, { dur: 0.09, gain: 0.3, type: 'bandpass', freq: 2100, sweepTo: 600, q: 1.1 });
  },
  hitHeavy: (a, d) => {
    a._tone(d, { dur: 0.26, gain: 0.5, type: 'sine', freq: 190, to: 42 });
    a._tone(d, { dur: 0.12, gain: 0.3, type: 'square', freq: 150, to: 60 });
    a._noise(d, { dur: 0.2, gain: 0.42, type: 'bandpass', freq: 1500, sweepTo: 260, q: .8 });
  },
  hitCrush: (a, d) => {
    a._tone(d, { dur: 0.42, gain: 0.6, type: 'sine', freq: 140, to: 30 });
    a._noise(d, { dur: 0.36, gain: 0.5, type: 'lowpass', freq: 2600, sweepTo: 140 });
    a._noise(d, { start: 0.02, dur: 0.5, gain: 0.2, type: 'bandpass', freq: 420, q: .6 });
  },
  block: (a, d) => {
    a._noise(d, { dur: 0.1, gain: 0.3, type: 'bandpass', freq: 3400, sweepTo: 1600, q: 5 });
    a._tone(d, { dur: 0.07, gain: 0.16, type: 'square', freq: 760, to: 420 });
  },
  parry: (a, d) => {
    a._tone(d, { dur: 0.5, gain: 0.3, type: 'sine', freq: 1400, to: 2600 });
    a._noise(d, { dur: 0.25, gain: 0.2, type: 'highpass', freq: 2600, sweepTo: 7000 });
  },
  whiff: (a, d) => {
    a._noise(d, { dur: 0.18, gain: 0.1, type: 'bandpass', freq: 700, sweepTo: 200, q: 2 });
  },
  throwGrab: (a, d) => {
    a._noise(d, { dur: 0.09, gain: 0.24, type: 'lowpass', freq: 1400 });
    a._tone(d, { dur: 0.3, gain: 0.3, type: 'sine', freq: 260, to: 70 });
  },

  /* — Projectiles & specials — */
  fireball: (a, d) => {
    a._noise(d, { dur: 0.45, gain: 0.2, type: 'bandpass', freq: 500, sweepTo: 1700, q: 3 });
    a._tone(d, { dur: 0.4, gain: 0.16, type: 'sawtooth', freq: 90, to: 240 });
  },
  coinToss: (a, d) => {
    a._tone(d, { dur: 0.5, gain: 0.2, type: 'sine', freq: 1660, to: 2400 });
    a._tone(d, { start: 0.03, dur: 0.45, gain: 0.14, type: 'sine', freq: 2490, to: 3200, detune: 7 });
  },
  missile: (a, d) => {
    a._noise(d, { dur: 0.7, gain: 0.2, type: 'bandpass', freq: 340, sweepTo: 900, q: 4 });
    a._tone(d, { dur: 0.7, gain: 0.12, type: 'sawtooth', freq: 120, to: 300 });
  },
  chainsaw: (a, d, o) => {
    const dur = o.dur ?? 0.6;
    const ctx = a.ctx, t0 = a.t;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 92;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 34;
    const lfoG = ctx.createGain(); lfoG.gain.value = 46;
    const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 900; filt.Q.value = 3.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
    g.gain.setValueAtTime(0.3, t0 + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    lfo.connect(lfoG); lfoG.connect(o1.frequency);
    o1.connect(filt); filt.connect(g); g.connect(d);
    o1.start(t0); lfo.start(t0); o1.stop(t0 + dur + 0.05); lfo.stop(t0 + dur + 0.05);
  },
  freeze: (a, d) => {
    a._noise(d, { dur: 0.6, gain: 0.18, type: 'highpass', freq: 3000, sweepTo: 8000 });
    a._tone(d, { dur: 0.6, gain: 0.12, type: 'sine', freq: 2200, to: 700 });
  },
  gavel: (a, d) => {
    a._tone(d, { dur: 0.3, gain: 0.4, type: 'triangle', freq: 420, to: 90 });
    a._noise(d, { dur: 0.22, gain: 0.3, type: 'bandpass', freq: 1100, sweepTo: 300, q: 1.5 });
  },
  explosion: (a, d, o) => {
    const s = o.size ?? 1;
    a._noise(d, { dur: 0.9 * s, gain: 0.5, type: 'lowpass', freq: 3800, sweepTo: 90 });
    a._tone(d, { dur: 0.8 * s, gain: 0.55, type: 'sine', freq: 130, to: 26 });
    a._tone(d, { start: 0.01, dur: 0.5 * s, gain: 0.3, type: 'square', freq: 70, to: 20 });
  },
  riser: (a, d, o) => {
    const dur = o.dur ?? 0.9;
    a._noise(d, { dur, gain: 0.22, type: 'bandpass', freq: 300, sweepTo: 6000, q: 2.5 });
    a._tone(d, { dur, gain: 0.16, type: 'sawtooth', freq: 110, to: 880 });
  },
  superFlash: (a, d) => {
    a._tone(d, { dur: 0.14, gain: 0.5, type: 'square', freq: 1200, to: 90 });
    a._noise(d, { dur: 0.5, gain: 0.34, type: 'lowpass', freq: 6000, sweepTo: 200 });
    a._tone(d, { start: 0.06, dur: 0.9, gain: 0.28, type: 'sawtooth', freq: 60, to: 30 });
  },
  meterFull: (a, d) => {
    [523, 659, 784, 1047].forEach((f, i) =>
      a._tone(d, { start: i * 0.055, dur: 0.3, gain: 0.13, type: 'triangle', freq: f }));
  },

  /* — Round flow — */
  ko: (a, d) => {
    a._tone(d, { dur: 1.5, gain: 0.6, type: 'sine', freq: 160, to: 22 });
    a._noise(d, { dur: 1.3, gain: 0.42, type: 'lowpass', freq: 5000, sweepTo: 70 });
    a._tone(d, { start: 0.05, dur: 1.1, gain: 0.28, type: 'sawtooth', freq: 80, to: 24 });
  },
  bell: (a, d) => {
    [880, 1320, 1760].forEach((f, i) =>
      a._tone(d, { dur: 1.4, gain: 0.14 / (i + 1), type: 'sine', freq: f, to: f * 0.98 }));
  },
  crowd: (a, d, o) => {
    a._noise(d, { dur: o.dur ?? 1.6, gain: 0.13, type: 'bandpass', freq: 1000, q: 0.7, curve: 'lin' });
  },
  timeLow: (a, d) => {
    a._tone(d, { dur: 0.12, gain: 0.2, type: 'square', freq: 1400 });
  },

  /* — UI — */
  uiHover:   (a, d) => a._tone(d, { dur: 0.05, gain: 0.06, type: 'sine', freq: 700 }),
  uiClick:   (a, d) => { a._tone(d, { dur: 0.07, gain: 0.13, type: 'triangle', freq: 620, to: 900 });
                         a._noise(d, { dur: 0.04, gain: 0.07, type: 'highpass', freq: 3000 }); },
  uiConfirm: (a, d) => { a._tone(d, { dur: 0.1, gain: 0.14, type: 'triangle', freq: 660 });
                         a._tone(d, { start: 0.07, dur: 0.18, gain: 0.14, type: 'triangle', freq: 990 }); },
  uiCancel:  (a, d) => { a._tone(d, { dur: 0.12, gain: 0.13, type: 'triangle', freq: 420, to: 220 }); },
  uiError:   (a, d) => { a._tone(d, { dur: 0.2, gain: 0.16, type: 'square', freq: 180, to: 120 }); },
};

/* ══════════════════════════════════════════════════════════════
   Music — a small step sequencer with lookahead scheduling.
   Each stage picks a key and a pattern set; intensity rises when a
   round is close, which is cheap drama.
   ══════════════════════════════════════════════════════════════ */

const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];

class MusicEngine {
  constructor(engine) {
    this.e = engine;
    this.playing = false;
    this.bpm = 148;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.root = 55;          // A1
    this.intensity = 0.6;
    this.pattern = 0;
  }

  start(opts = {}) {
    if (!this.e.ready) return;
    this.bpm = opts.bpm ?? 148;
    this.root = opts.root ?? 55;
    this.pattern = opts.pattern ?? 0;
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.e.t + 0.08;
    this.timer = setInterval(() => this._schedule(), 25);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  setIntensity(v) { this.intensity = Math.max(0, Math.min(1.4, v)); }

  _schedule() {
    if (!this.playing) return;
    const stepDur = 60 / this.bpm / 4;      // 16th notes
    while (this.nextTime < this.e.t + 0.12) {
      this._playStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % 64;
    }
  }

  _note(semi) {
    // Equal temperament. Math.pow is fine here — music is not simulation.
    return this.root * Math.pow(2, semi / 12);
  }

  _playStep(step, t, dur) {
    const a = this.e;
    const bus = a.musicBus;
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const I = this.intensity;

    // Kick — four on the floor with a syncopated pickup.
    if (s16 % 4 === 0 || s16 === 14) {
      this._env(bus, t, { type: 'sine', f0: 150, f1: 42, dur: 0.19, gain: 0.5 * I });
      this._noiseHit(bus, t, 0.03, 0.16 * I, 'lowpass', 240);
    }
    // Snare/clap on the backbeat.
    if (s16 === 4 || s16 === 12) {
      this._noiseHit(bus, t, 0.13, 0.2 * I, 'bandpass', 1900);
      this._env(bus, t, { type: 'triangle', f0: 320, f1: 180, dur: 0.08, gain: 0.1 * I });
    }
    // Hats.
    if (s16 % 2 === 1) {
      this._noiseHit(bus, t, 0.032, 0.07 * I, 'highpass', 8200);
    }
    // Bass — root/fifth pulse, dropping to the relative sixth every 4th bar.
    if (s16 % 2 === 0) {
      const seq = [0, 0, 7, 0, 0, 0, 10, 0, 0, 0, 7, 0, 3, 3, 5, 5];
      const semi = seq[s16] + (bar % 4 === 3 ? -4 : 0);
      this._env(bus, t, { type: 'sawtooth', f0: this._note(semi), f1: this._note(semi),
                          dur: dur * 1.7, gain: 0.15 * I, filter: 420 + 500 * I });
    }
    // Arp — only once the fight heats up.
    if (I > 0.75 && s16 % 2 === 1) {
      const deg = SCALE_MINOR[(step + this.pattern) % 7];
      this._env(bus, t, { type: 'square', f0: this._note(deg + 24), f1: this._note(deg + 24),
                          dur: dur * 1.2, gain: 0.05 * (I - 0.6), filter: 2600 });
    }
    // Bar-line stab.
    if (s16 === 0 && bar % 2 === 0) {
      this._env(bus, t, { type: 'sawtooth', f0: this._note(12), f1: this._note(12),
                          dur: 0.3, gain: 0.07 * I, filter: 1400 });
    }
  }

  _env(dest, t, { type, f0, f1, dur, gain, filter }) {
    const ctx = this.e.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);

    let node = o;
    if (filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.value = filter;
      bq.Q.value = 4;
      o.connect(bq);
      node = bq;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.03);
  }

  _noiseHit(dest, t, dur, gain, type, freq) {
    const ctx = this.e.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.e.noiseBuf;
    src.loop = true;
    const bq = ctx.createBiquadFilter();
    bq.type = type; bq.frequency.value = freq; bq.Q.value = 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bq); bq.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.02);
  }
}

export const audio = new AudioEngine();
