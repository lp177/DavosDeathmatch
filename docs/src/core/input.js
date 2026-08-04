/* ══════════════════════════════════════════════════════════════
   Input — raw device state → a 16-bit command word per player.

   This module is deliberately the ONLY place that touches the DOM for
   gameplay input. Everything downstream (simulation, netplay, replay,
   AI) consumes the packed word, which makes those layers trivially
   deterministic and serialisable.
   ══════════════════════════════════════════════════════════════ */

import { IN, ACTIONS } from '../sim/constants.js';
import { settings } from './settings.js';

/** Keys we swallow so the page never scrolls or scrubs during a match. */
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Tab', 'Enter', 'Backspace',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
]);

/* Gamepad → action, using the Standard Gamepad mapping. */
const PAD_BUTTONS = {
  0: 'lk',    // A / cross
  1: 'hk',    // B / circle
  2: 'lp',    // X / square
  3: 'hp',    // Y / triangle
  4: 'taunt', // LB
  5: 'super', // RB
  6: 'lp',    // LT — doubles up so triggers aren't dead
  7: 'hp',    // RT
  9: 'start',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
const PAD_DEADZONE = 0.42;

class InputManager {
  constructor() {
    /** Physical keys currently held, by KeyboardEvent.code. */
    this.held = new Set();
    /** Keys pressed since the last consumeEdges() — for menu navigation. */
    this.pressedEdge = new Set();
    /** When set, keydown is routed here instead of the game (rebinding UI). */
    this.captureFn = null;
    /** Latest polled word per player, for UI readouts. */
    this.last = [0, 0];
    this.padsSeen = [false, false];

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    // Held keys would otherwise stick forever if focus is lost mid-press.
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('contextmenu', (e) => {
      if (e.target.tagName === 'CANVAS') e.preventDefault();
    });
  }

  _onKeyDown(e) {
    if (this.captureFn) {
      e.preventDefault();
      const fn = this.captureFn;
      this.captureFn = null;
      fn(e.code, e);
      return;
    }
    // Never hijack keys while the player is typing in a field.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (SWALLOW.has(e.code) || this._isBound(e.code)) e.preventDefault();
    if (!e.repeat) {
      this.held.add(e.code);
      this.pressedEdge.add(e.code);
    }
  }

  _onKeyUp(e) {
    this.held.delete(e.code);
  }

  _isBound(code) {
    const k = settings.data.keys;
    for (const side of ['p1', 'p2']) {
      for (const action of Object.keys(k[side])) {
        if (k[side][action] === code) return true;
      }
    }
    return false;
  }

  /** Ask for the next key press; used by the keybinding dialog. */
  captureNextKey() {
    return new Promise((resolve) => {
      this.captureFn = (code, e) => resolve({ code, key: e.key });
    });
  }

  cancelCapture() {
    this.captureFn = null;
  }

  /**
   * Build the command word for a player this frame.
   * @param {number} player 0 or 1
   */
  poll(player) {
    const binds = settings.data.keys[player === 0 ? 'p1' : 'p2'];
    let word = 0;

    for (const { id, bit } of ACTIONS) {
      if (this.held.has(binds[id])) word |= bit;
    }
    word |= this._pollPad(player);

    // Opposite directions cancel — mirrors real arcade SOCD handling and
    // stops "hold both to be unhittable" nonsense.
    if ((word & IN.LEFT) && (word & IN.RIGHT)) word &= ~(IN.LEFT | IN.RIGHT);
    if ((word & IN.UP) && (word & IN.DOWN)) word &= ~IN.UP;

    this.last[player] = word;
    return word;
  }

  _pollPad(player) {
    if (!navigator.getGamepads) return 0;
    const pads = navigator.getGamepads();
    const pad = pads[player];
    if (!pad) { this.padsSeen[player] = false; return 0; }
    this.padsSeen[player] = true;

    let word = 0;
    for (const [idx, action] of Object.entries(PAD_BUTTONS)) {
      const b = pad.buttons[idx];
      if (b && (b.pressed || b.value > 0.5)) {
        const found = ACTIONS.find((a) => a.id === action);
        if (found) word |= found.bit;
      }
    }
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    if (ax < -PAD_DEADZONE) word |= IN.LEFT;
    if (ax > PAD_DEADZONE) word |= IN.RIGHT;
    if (ay < -PAD_DEADZONE) word |= IN.UP;
    if (ay > PAD_DEADZONE) word |= IN.DOWN;
    return word;
  }

  /** Haptics for hits — silently no-ops on pads/browsers without support. */
  rumble(player, strength = 0.5, ms = 90) {
    if (!navigator.getGamepads) return;
    const pad = navigator.getGamepads()[player];
    const act = pad?.vibrationActuator;
    if (!act?.playEffect) return;
    act.playEffect('dual-rumble', {
      startDelay: 0,
      duration: ms,
      weakMagnitude: Math.min(1, strength),
      strongMagnitude: Math.min(1, strength * 0.85),
    }).catch(() => { /* pad disconnected mid-effect */ });
  }

  /** Was this key pressed since the last call? Menu-only helper. */
  takeEdge(code) {
    if (this.pressedEdge.has(code)) {
      this.pressedEdge.delete(code);
      return true;
    }
    return false;
  }

  clearEdges() {
    this.pressedEdge.clear();
  }

  isHeld(code) {
    return this.held.has(code);
  }
}

export const input = new InputManager();

/* ── Pretty key names for the settings UI ── */
const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', Enter: 'Enter', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Tab: 'Tab', CapsLock: 'Caps', Escape: 'Esc',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num ×',
  NumpadDivide: 'Num ÷', NumpadDecimal: 'Num .', NumpadEnter: 'Num ⏎',
};

export function keyLabel(code) {
  if (!code) return '—';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('F') && code.length <= 3) return code;
  return code;
}
