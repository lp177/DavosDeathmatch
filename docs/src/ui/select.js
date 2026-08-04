/* ══════════════════════════════════════════════════════════════
   Character select.

   Driven by the same command words as the fight, so players navigate
   with whatever they rebound their controls to, and a gamepad works
   without any extra code. Mouse and keyboard arrows work too, because
   a menu that only accepts fighting-game inputs is a bad menu.
   ══════════════════════════════════════════════════════════════ */

import { ROSTER, ROSTER_LIST, ROSTER_ORDER, signatureMoves } from '../data/roster.js';
import { drawPortrait, drawThumb } from '../gfx/caricature.js';
import { MOTION_LABEL } from '../sim/motion.js';
import { buttonLabel } from '../data/movekit.js';
import { IN } from '../sim/constants.js';
import { input } from '../core/input.js';
import { audio } from '../core/audio.js';
import { settings } from '../core/settings.js';

const COLS = 4;

export class SelectScreen {
  constructor() {
    this.root = document.getElementById('screen-select');
    this.grid = document.getElementById('roster');
    this.detail = document.getElementById('select-detail');
    this.hint = document.getElementById('select-hint');
    this.timerEl = document.getElementById('select-timer');
    this.slots = [];
    this.active = false;
    this.clock = 0;
    this.onConfirm = null;
    this.onCancel = null;
    this.onLocalPick = null;
    this.thumbCtx = [];
    this.portraits = [
      document.getElementById('p1-portrait').getContext('2d'),
      document.getElementById('p2-portrait').getContext('2d'),
    ];
    this._buildGrid();
  }

  _buildGrid() {
    this.grid.replaceChildren();
    this.thumbCtx = [];
    ROSTER_LIST.forEach((char, i) => {
      const slot = document.createElement('button');
      slot.className = 'slot';
      slot.type = 'button';
      slot.dataset.index = String(i);
      slot.setAttribute('role', 'option');
      slot.setAttribute('aria-label', `${char.name}, ${char.title}`);

      const cv = document.createElement('canvas');
      cv.width = 132; cv.height = 132;
      slot.appendChild(cv);
      slot.appendChild(Object.assign(document.createElement('span'),
        { className: 'slot__tag', textContent: char.short }));

      slot.addEventListener('pointerenter', () => {
        if (!this.active) return;
        const c = this.cursors.find((x) => x.human && !x.locked);
        if (c) { c.index = i; this._refresh(); audio.play('uiHover'); }
      });
      slot.addEventListener('click', () => {
        if (!this.active) return;
        const c = this.cursors.find((x) => x.human && !x.locked);
        if (!c) return;
        c.index = i;
        this._lock(c);
      });

      this.grid.appendChild(slot);
      this.thumbCtx.push(cv.getContext('2d'));
    });
  }

  /**
   * @param {object} opts
   *   mode        'arcade' | 'local' | 'training' | 'online'
   *   localPlayer for online: which side this browser controls
   *   onConfirm   ({chars:[a,b]}) => void
   *   onCancel    () => void
   *   onLocalPick (charId) => void   fired once for online, to tell the peer
   */
  open(opts) {
    this.opts = opts;
    this.active = true;
    this.clock = 0;
    this.remoteReady = false;

    const last = settings.data.last;
    const idx = (id) => Math.max(0, ROSTER_ORDER.indexOf(id));

    // Which cursors exist, and who drives them.
    if (opts.mode === 'local') {
      this.cursors = [
        { player: 0, index: idx(last.p1), locked: false, human: true, pad: 0 },
        { player: 1, index: idx(last.p2), locked: false, human: true, pad: 1 },
      ];
    } else if (opts.mode === 'online') {
      const me = opts.localPlayer;
      this.cursors = [
        { player: me, index: idx(me === 0 ? last.p1 : last.p2), locked: false, human: true, pad: 0 },
      ];
      this.remoteChar = null;
    } else if (opts.mode === 'training') {
      this.cursors = [
        { player: 0, index: idx(last.p1), locked: false, human: true, pad: 0 },
        { player: 1, index: idx(last.p2), locked: false, human: true, pad: 0, waits: true },
      ];
    } else {
      // Arcade: pick yourself, the summit provides an opponent.
      this.cursors = [
        { player: 0, index: idx(last.p1), locked: false, human: true, pad: 0 },
      ];
      this.opponentRoll = null;
    }

    this.picked = [null, null];
    this.root.hidden = false;
    this.timerEl.textContent = '';
    this._updateLabels();
    this._refresh();
    this.grid.focus({ preventScroll: true });
  }

  close() {
    this.active = false;
    this.root.hidden = true;
  }

  /** The peer told us what they chose. */
  setRemotePick(charId) {
    if (this.opts?.mode !== 'online') return;
    const other = 1 - this.opts.localPlayer;
    this.picked[other] = charId;
    this.remoteReady = true;
    this._refresh();
    this._maybeFinish();
  }

  _updateLabels() {
    const mode = this.opts.mode;
    const l1 = document.getElementById('p1-label');
    const l2 = document.getElementById('p2-label');
    if (mode === 'online') {
      const me = this.opts.localPlayer;
      l1.textContent = me === 0 ? 'You' : 'Opponent';
      l2.textContent = me === 1 ? 'You' : 'Opponent';
      this.hint.textContent = 'Choose your delegate. Waiting for your opponent to choose theirs.';
    } else if (mode === 'local') {
      l1.textContent = 'Player 1';
      l2.textContent = 'Player 2';
      this.hint.textContent = 'Both players choose. Move with your direction keys, confirm with Light Punch.';
    } else if (mode === 'training') {
      l1.textContent = 'You';
      l2.textContent = 'Dummy';
      this.hint.textContent = 'Choose your fighter, then choose the training dummy.';
    } else {
      l1.textContent = 'You';
      l2.textContent = 'Opponent';
      this.hint.textContent = 'Choose your delegate. Confirm with Light Punch. Escape to go back.';
    }
  }

  /* ── Per-frame ────────────────────────────────────────── */

  update(dt) {
    if (!this.active) return;
    this.clock += dt;

    for (const c of this.cursors) {
      if (c.locked) continue;
      if (c.waits && !this.cursors[0].locked) continue;   // training: second pick waits
      this._handleCursor(c, dt);
    }

    // Arcade opponent reveal: a short slot-machine spin.
    if (this.opponentRoll !== null && this.opponentRoll !== undefined) {
      this.opponentRoll -= dt;
      if (this.opponentRoll > 0) {
        if (Math.floor(this.opponentRoll) % 4 === 0) {
          this.picked[1] = ROSTER_ORDER[Math.floor(Math.random() * ROSTER_ORDER.length)];
          audio.play('uiHover');
        }
      } else {
        this.opponentRoll = null;
        audio.play('uiConfirm');
        this._maybeFinish(true);
      }
    }

    this._drawPortraits();
    this._drawThumbs();
  }

  _handleCursor(c, dt) {
    const word = input.poll(c.pad);
    const prev = c._prev ?? 0;
    c._prev = word;
    const pressed = word & ~prev;

    let moved = false;
    if (pressed & IN.RIGHT) { c.index = (c.index + 1) % ROSTER_LIST.length; moved = true; }
    if (pressed & IN.LEFT) { c.index = (c.index - 1 + ROSTER_LIST.length) % ROSTER_LIST.length; moved = true; }
    if (pressed & IN.DOWN) { c.index = (c.index + COLS) % ROSTER_LIST.length; moved = true; }
    if (pressed & IN.UP) { c.index = (c.index - COLS + ROSTER_LIST.length) % ROSTER_LIST.length; moved = true; }

    // Arrow keys and Enter always work, whatever the bindings are.
    if (input.takeEdge('ArrowRight')) { c.index = (c.index + 1) % ROSTER_LIST.length; moved = true; }
    if (input.takeEdge('ArrowLeft')) { c.index = (c.index - 1 + ROSTER_LIST.length) % ROSTER_LIST.length; moved = true; }
    if (input.takeEdge('ArrowDown')) { c.index = (c.index + COLS) % ROSTER_LIST.length; moved = true; }
    if (input.takeEdge('ArrowUp')) { c.index = (c.index - COLS + ROSTER_LIST.length) % ROSTER_LIST.length; moved = true; }

    if (moved) { audio.play('uiHover'); this._refresh(); }

    const confirm = (pressed & (IN.LP | IN.HP | IN.LK | IN.HK)) || input.takeEdge('Enter');
    if (confirm) this._lock(c);
  }

  _lock(c) {
    c.locked = true;
    const char = ROSTER_LIST[c.index];
    this.picked[c.player] = char.id;
    settings.set(c.player === 0 ? 'last.p1' : 'last.p2', char.id);
    audio.play('uiConfirm');
    audio.speak(char.short, { pitch: 0.4, rate: 0.95, force: true });

    const slot = this.grid.children[c.index];
    slot.dataset.locked = `p${c.player + 1}`;
    setTimeout(() => { delete slot.dataset.locked; }, 400);

    this._refresh();

    if (this.opts.mode === 'online') {
      this.opts.onLocalPick?.(char.id);
      this.hint.textContent = this.remoteReady
        ? 'Both delegates confirmed. Starting…'
        : 'Locked in. Waiting for your opponent…';
      this._maybeFinish();
      return;
    }
    if (this.opts.mode === 'arcade') {
      this.opponentRoll = 40;
      this.hint.textContent = 'Selecting your opponent…';
      return;
    }
    if (this.opts.mode === 'training' && c.player === 0) {
      this.hint.textContent = 'Now choose the training dummy.';
      return;
    }
    this._maybeFinish();
  }

  _maybeFinish(force = false) {
    const ready = this.picked[0] && this.picked[1];
    if (!ready && !force) return;
    if (!ready) return;
    if (this.opts.mode !== 'online' && this.cursors.some((c) => c.human && !c.locked && !c.waits)) return;
    setTimeout(() => {
      if (!this.active) return;
      this.onDone?.();
      this.opts.onConfirm({ chars: [this.picked[0], this.picked[1]] });
    }, 420);
  }

  /* ── Painting ─────────────────────────────────────────── */

  _refresh() {
    // Cursor highlight rings.
    [...this.grid.children].forEach((slot, i) => {
      const tags = [];
      for (const c of this.cursors) {
        if (c.index === i) tags.push(`p${c.player + 1}`);
      }
      if (tags.length) slot.dataset.cursor = tags.join(' ');
      else delete slot.dataset.cursor;
      slot.setAttribute('aria-selected', String(tags.length > 0));
    });

    // Names under the portraits.
    for (let p = 0; p < 2; p++) {
      const cur = this.cursors.find((c) => c.player === p);
      let char = null;
      if (this.picked[p]) char = ROSTER[this.picked[p]];
      else if (cur) char = ROSTER_LIST[cur.index];
      document.getElementById(`p${p + 1}-name`).textContent = char ? char.short : '—';
      document.getElementById(`p${p + 1}-title`).textContent = char ? char.title : '';
    }

    // Move list for whichever cursor is still choosing.
    const focus = this.cursors.find((c) => !c.locked) || this.cursors[0];
    const char = ROSTER_LIST[focus.index];
    this.detail.replaceChildren();
    const head = document.createElement('div');
    head.innerHTML = `<div class="detail__name">${char.name} ${char.flag}</div>`
                   + `<div class="detail__tag">${char.tagline}</div>`;
    this.detail.appendChild(head);

    const moves = document.createElement('div');
    moves.className = 'detail__moves';
    for (const mv of signatureMoves(char)) {
      const chip = document.createElement('span');
      chip.className = 'move-chip' + (mv.tier === 'super' ? ' move-chip--super' : '');
      const motion = MOTION_LABEL[mv.input.motion] || '';
      chip.innerHTML = `<b>${mv.name}</b><code>${motion} ${buttonLabel(mv.input.button)}</code>`;
      moves.appendChild(chip);
    }
    this.detail.appendChild(moves);
  }

  _drawPortraits() {
    for (let p = 0; p < 2; p++) {
      const cur = this.cursors.find((c) => c.player === p);
      let char = null;
      if (this.picked[p]) char = ROSTER[this.picked[p]];
      else if (cur) char = ROSTER_LIST[cur.index];
      const ctx = this.portraits[p];
      if (!char) {
        ctx.fillStyle = '#12151c';
        ctx.fillRect(0, 0, 320, 380);
        continue;
      }
      drawPortrait(ctx, char, 320, 380, this.clock + p * 20);
    }
  }

  _drawThumbs() {
    // Only repaint the thumbnails a few times a second; they barely move.
    if (Math.floor(this.clock) % 3 !== 0) return;
    ROSTER_LIST.forEach((char, i) => {
      drawThumb(this.thumbCtx[i], char, 132, 132, this.clock * 0.5 + i * 11);
    });
  }
}
