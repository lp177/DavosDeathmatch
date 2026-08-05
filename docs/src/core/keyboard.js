/* ══════════════════════════════════════════════════════════════
   Keyboard layout awareness.

   Bindings are stored as KeyboardEvent.code — a PHYSICAL key position,
   not the letter printed on it. That is the right choice, and it means
   the game already works on every layout without rebinding: the key an
   AZERTY player calls "Z" is physically where QWERTY prints "W", so it
   reports code "KeyW" and the WASD diamond is the ZQSD diamond.

   What does NOT work automatically is the *labels*. Telling a French
   player to press "W" when the keycap under their finger says "Z" is
   just wrong, and rebinding to code "KeyZ" to fix the text would move
   the control to the bottom-left key AZERTY prints as "W" — breaking
   the thing it was meant to fix.

   So this module answers one question: what does this physical key
   actually say on *your* keyboard? Everything else stays as it is.
   ══════════════════════════════════════════════════════════════ */

import { settings } from './settings.js';

/* Physical code → printed character, for layouts we can name.
   Only the keys that actually differ are listed; anything absent falls
   through to the QWERTY label. */
const LAYOUTS = {
  qwerty: {},

  // French / Belgian AZERTY.
  azerty: {
    KeyA: 'Q', KeyQ: 'A',
    KeyW: 'Z', KeyZ: 'W',
    KeyM: ',', Semicolon: 'M',
    Comma: ';', Period: ':', Slash: '!',
    BracketLeft: '^', BracketRight: '$',
    Quote: 'ù', Backquote: '²',
    Minus: ')', Equal: '=',
    Digit1: '&', Digit2: 'é', Digit3: '"', Digit4: "'", Digit5: '(',
    Digit6: '-', Digit7: 'è', Digit8: '_', Digit9: 'ç', Digit0: 'à',
  },

  // German / Swiss QWERTZ — only Y and Z trade places.
  qwertz: {
    KeyY: 'Z', KeyZ: 'Y',
  },
};

class KeyboardLayout {
  constructor() {
    /** 'qwerty' | 'azerty' | 'qwertz' | 'unknown' */
    this.detected = 'unknown';
    /** Live code → printed character, when the browser will tell us. */
    this.map = null;
    this._subs = new Set();
  }

  /** The layout actually in use: an explicit choice wins over detection. */
  get active() {
    const forced = settings.data.controls?.layout ?? 'auto';
    if (forced !== 'auto') return forced;
    return this.detected === 'unknown' ? 'qwerty' : this.detected;
  }

  get isAuto() {
    return (settings.data.controls?.layout ?? 'auto') === 'auto';
  }

  /**
   * Ask the browser what this keyboard prints.
   *
   * navigator.keyboard is Chromium-only and needs a secure context. When
   * it isn't there we simply don't guess — a wrong guess is worse than a
   * neutral default, and the settings screen offers a manual override.
   */
  async detect() {
    try {
      if (!navigator.keyboard?.getLayoutMap) return this.detected;
      // Don't let a hanging promise delay the boot sequence.
      this.map = await Promise.race([
        navigator.keyboard.getLayoutMap(),
        new Promise((r) => setTimeout(() => r(null), 1200)),
      ]);
      if (!this.map) return this.detected;

      const at = (code) => (this.map.get(code) || '').toLowerCase();
      if (at('KeyQ') === 'a' && at('KeyW') === 'z') this.detected = 'azerty';
      else if (at('KeyY') === 'z' && at('KeyZ') === 'y') this.detected = 'qwertz';
      else if (at('KeyQ') === 'q' && at('KeyW') === 'w') this.detected = 'qwerty';
    } catch {
      // Permission policy or an unsupported browser. Stay neutral.
    }
    this._emit();
    return this.detected;
  }

  /**
   * What is printed on the physical key `code`, as best we can tell.
   * Returns null when we have nothing better than the QWERTY name.
   */
  printed(code) {
    // A live map from the browser beats any table we could ship — it also
    // covers layouts we've never heard of.
    if (this.isAuto && this.map) {
      const ch = this.map.get(code);
      if (ch && ch.length <= 2) return ch.toUpperCase();
    }
    const table = LAYOUTS[this.active];
    return table && table[code] ? table[code] : null;
  }

  /** Human-readable name for the settings screen. */
  get label() {
    const names = { qwerty: 'QWERTY', azerty: 'AZERTY', qwertz: 'QWERTZ' };
    if (!this.isAuto) return names[this.active] || 'QWERTY';
    if (this.detected === 'unknown') return 'QWERTY (not detected)';
    return `${names[this.detected]} (detected)`;
  }

  onChange(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit() {
    for (const fn of this._subs) fn(this.active);
  }
}

export const keyboardLayout = new KeyboardLayout();
