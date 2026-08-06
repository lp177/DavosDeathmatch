/* ══════════════════════════════════════════════════════════════
   Input — raw device state → a 16-bit command word per player.

   This module is deliberately the ONLY place that touches the DOM for
   gameplay input. Everything downstream (simulation, netplay, replay,
   AI) consumes the packed word, which makes those layers trivially
   deterministic and serialisable.
   ══════════════════════════════════════════════════════════════ */

import { IN, ACTIONS } from '../sim/constants.js';
import { settings } from './settings.js';
import { keyboardLayout } from './keyboard.js';

/** Keys we swallow so the page never scrolls or scrubs during a match. */
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Tab', 'Enter', 'Backspace',
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
]);

/* Gamepad → action, using the Standard Gamepad mapping.
   Positions, not printed letters: button 0 is always the BOTTOM face button,
   whatever its keycap says (A on Xbox, B on Nintendo, ✕ on PlayStation). */
const PAD_BUTTONS = {
  0: 'lk',    // bottom face
  1: 'hk',    // right face
  2: 'lp',    // left face
  3: 'hp',    // top face
  4: 'taunt', // left bumper
  5: 'super', // right bumper
  6: 'lp',    // left trigger — doubles up so triggers aren't dead
  7: 'hp',    // right trigger
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
/** Start/Options — pause, handled as an edge rather than a simulation bit. */
const PAD_START = 9;
const PAD_DEADZONE = 0.42;

/* Which printed labels this pad uses. Only the names differ; the physical
   positions above are identical, so nothing about play changes. */
export function padVendor(id = '') {
  const s = String(id).toLowerCase();
  if (/054c|playstation|dualshock|dualsense/.test(s)) return 'playstation';
  if (/057e|nintendo|switch|joy-?con|pro controller/.test(s)) return 'nintendo';
  return 'xbox';
}

export const PAD_LABELS = {
  xbox:        { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 9: 'Menu' },
  playstation: { 0: '✕', 1: '○', 2: '□', 3: '△', 4: 'L1', 5: 'R1', 9: 'Options' },
  nintendo:    { 0: 'B', 1: 'A', 2: 'Y', 3: 'X', 4: 'L',  5: 'R',  9: '+' },
};

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
    /**
     * Which controller drives which player: slot -> gamepad.index.
     *
     * NOT the same thing as an index into navigator.getGamepads(). That array
     * is keyed by the browser's own gamepad.index, which is sparse and is
     * never renumbered — unplug the first pad and reconnect it and it can
     * reappear at index 2, leaving slot 0 null for the rest of the session.
     * Reading pads[player] therefore hands Player 2 nothing, which is exactly
     * what two people sharing one computer would hit.
     */
    this.padSlots = [null, null];
    this.padsSeen = [false, false];
    /** Every connected pad, for the settings screen. */
    this.padList = [];
    /** Newly-pressed pad buttons this frame, per player — menu navigation. */
    this._padPrev = [0, 0];
    this._padPrevMenu = 0;
    this._lastSync = 0;
    /**
     * True whenever only one person is at the keyboard (arcade, training,
     * online). Player 1 then answers to BOTH binding sets and both gamepads,
     * so you can use the numpad or F/G/V/B, arrows or WASD, whichever your
     * hands reach for — without rebinding anything. Local versus turns this
     * off, because there the two sets have to stay separate.
     */
    this.solo = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    // Connection events are a hint, not the source of truth: they only fire
    // while the page has focus, so a pad woken up during a menu — or one
    // already connected before the tab opened — can be missed entirely.
    // syncPads() reconciles from scratch every frame; these just make the
    // settings screen react instantly.
    window.addEventListener('gamepadconnected', () => this.syncPads());
    window.addEventListener('gamepaddisconnected', () => this.syncPads());
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
    const el = document.activeElement;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Enter and Space are how a focused button is pressed. Swallowing them
    // here cancels the browser's own activation, which quietly makes every
    // menu mouse-only for anyone navigating by keyboard — the buttons take
    // focus, show a focus ring, and then do nothing when you press them.
    const pressesFocused =
      (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')
      && (tag === 'BUTTON' || tag === 'A' || el?.getAttribute?.('role') === 'button');

    if (!pressesFocused && (SWALLOW.has(e.code) || this._isBound(e.code))) {
      e.preventDefault();
    }
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
    this._syncPadsSoon();
    // Solo: player one answers to both halves of the keyboard and both pads.
    const merged = this.solo && player === 0;
    const sides = merged ? ['p1', 'p2'] : [player === 0 ? 'p1' : 'p2'];

    let word = 0;
    for (const side of sides) {
      const binds = settings.data.keys[side];
      for (const { id, bit } of ACTIONS) {
        if (this.held.has(binds[id])) word |= bit;
      }
    }
    word |= this._pollPad(player);
    if (merged) word |= this._pollPad(1);

    // Opposite directions cancel — mirrors real arcade SOCD handling and
    // stops "hold both to be unhittable" nonsense.
    if ((word & IN.LEFT) && (word & IN.RIGHT)) word &= ~(IN.LEFT | IN.RIGHT);
    if ((word & IN.UP) && (word & IN.DOWN)) word &= ~IN.UP;

    this.last[player] = word;
    return word;
  }

  /* ── Controller slots ────────────────────────────────── */

  /** Connected pads, in the browser's index order. */
  _livePads() {
    if (!navigator.getGamepads) return [];
    const out = [];
    for (const p of navigator.getGamepads()) if (p && p.connected) out.push(p);
    return out;
  }

  /**
   * Reconcile slot -> gamepad.index. Cheap, and safe to call every frame.
   * Free slots are filled in connection order, so the first controller
   * plugged in is Player 1 — and a pad that disappears releases its slot
   * rather than leaving the player dead.
   */
  syncPads() {
    const live = this._livePads();
    const byIndex = new Map(live.map((p) => [p.index, p]));

    for (let s = 0; s < 2; s++) {
      if (this.padSlots[s] !== null && !byIndex.has(this.padSlots[s])) {
        this.padSlots[s] = null;
      }
    }
    for (const p of live) {
      if (this.padSlots.includes(p.index)) continue;
      const free = this.padSlots.indexOf(null);
      if (free === -1) break;          // more pads than players; extras idle
      this.padSlots[free] = p.index;
    }

    this.padList = live;
    this.padsSeen = [this.padSlots[0] !== null, this.padSlots[1] !== null];
    return live;
  }

  /**
   * Throttled sync for the hot path. Reassignment does not need 60Hz — but
   * padFor() re-reads the live pad on every poll, so button latency is
   * unaffected. This only keeps the slot map honest, and doing it twice a
   * frame allocated an array and a Map each time for nothing.
   */
  _syncPadsSoon() {
    const now = performance.now();
    if (now - (this._lastSync || 0) < 100) return;
    this._lastSync = now;
    this.syncPads();
  }

  /** The controller driving a player, or null. */
  padFor(player) {
    const idx = this.padSlots[player];
    if (idx === null || !navigator.getGamepads) return null;
    const pad = navigator.getGamepads()[idx];
    return pad && pad.connected ? pad : null;
  }

  /** Hand the two players each other's controller. */
  swapPads() {
    this.padSlots = [this.padSlots[1], this.padSlots[0]];
  }

  /** Point a specific controller at a player, displacing whatever was there. */
  assignPad(gamepadIndex, player) {
    const other = 1 - player;
    if (this.padSlots[other] === gamepadIndex) {
      this.padSlots[other] = this.padSlots[player];
    }
    this.padSlots[player] = gamepadIndex;
  }

  /** Is anything on this pad being pressed? Used to identify it on screen. */
  padActivity(gamepadIndex) {
    const pad = this._livePads().find((p) => p.index === gamepadIndex);
    if (!pad) return false;
    if (pad.buttons.some((b) => b && (b.pressed || b.value > 0.5))) return true;
    return pad.axes.some((a) => Math.abs(a) > PAD_DEADZONE);
  }

  _pollPad(player) {
    const pad = this.padFor(player);
    if (!pad) return 0;

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
    const pad = this.padFor(player);
    const act = pad?.vibrationActuator;
    if (!act?.playEffect) return;
    act.playEffect('dual-rumble', {
      startDelay: 0,
      duration: ms,
      weakMagnitude: Math.min(1, strength),
      strongMagnitude: Math.min(1, strength * 0.85),
    }).catch(() => { /* pad disconnected mid-effect */ });
  }

  /**
   * Newly-pressed buttons across BOTH controllers, as a command word.
   *
   * Menus are shared: either player should be able to drive the roster or
   * start the fight. Consumed by the caller, so each press acts once.
   */
  takePadMenu() {
    this.syncPads();
    let now = 0;
    for (let pl = 0; pl < 2; pl++) {
      now |= this._pollPad(pl);
      const pad = this.padFor(pl);
      const start = pad?.buttons?.[PAD_START];
      if (start && (start.pressed || start.value > 0.5)) now |= IN.START;
    }
    const edge = now & ~this._padPrevMenu;
    this._padPrevMenu = now;
    return edge;
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
  // Bindings are physical positions, so the printed letter depends on the
  // player's layout: the same key is "W" on QWERTY and "Z" on AZERTY.
  const printed = keyboardLayout.printed(code);
  if (printed) return printed;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('F') && code.length <= 3) return code;
  return code;
}
