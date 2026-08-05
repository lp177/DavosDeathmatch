/* ══════════════════════════════════════════════════════════════
   Settings dialog — builds the four panels from the settings schema.

   Every control writes straight through to `settings`, which persists
   and notifies. There is no apply/cancel step: changes take effect the
   moment you make them, which is what you want when you're dragging a
   volume slider while the music plays.
   ══════════════════════════════════════════════════════════════ */

import { settings, DEFAULTS } from '../core/settings.js';
import { input, keyLabel } from '../core/input.js';
import { audio } from '../core/audio.js';
import { ACTIONS } from '../sim/constants.js';
import { defaultSignalUrl, isStaticHost } from '../net/signal.js';
import { keyboardLayout } from '../core/keyboard.js';
import { STAGES, STAGE_ORDER } from '../gfx/stage.js';

/* ── Control factories ────────────────────────────────── */

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function group(title) {
  const g = el('div', 'group');
  g.appendChild(el('div', 'group__title', title));
  return g;
}

function slider(name, path, { min = 0, max = 1, step = 0.01, format } = {}) {
  const wrap = el('div', 'slider');
  const top = el('div', 'slider__top');
  const label = el('label', 'slider__name', name);
  const val = el('span', 'slider__val');
  top.append(label, val);

  const inp = el('input', 'slider__input');
  inp.type = 'range';
  inp.min = min; inp.max = max; inp.step = step;
  inp.value = settings.get(path);
  const id = 'set-' + path.replace(/\./g, '-');
  inp.id = id;
  label.setAttribute('for', id);

  const fmt = format || ((v) => `${Math.round(v * 100)}%`);
  const paint = () => {
    const v = Number(inp.value);
    val.textContent = fmt(v);
    inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
  };
  paint();

  inp.addEventListener('input', () => {
    settings.set(path, Number(inp.value));
    paint();
  });
  // Audible preview when you let go of a volume slider.
  inp.addEventListener('change', () => {
    if (path.startsWith('audio')) audio.play('uiClick');
  });

  wrap.append(top, inp);
  return wrap;
}

function toggle(name, hint, path) {
  const lab = el('label', 'switch');
  const text = el('div', 'switch__text');
  text.append(el('span', 'switch__name', name));
  if (hint) text.append(el('span', 'switch__hint', hint));

  const boxWrap = el('div', 'switch__box');
  const inp = el('input', 'switch__input');
  inp.type = 'checkbox';
  inp.checked = !!settings.get(path);
  const track = el('span', 'switch__track');
  const thumb = el('span', 'switch__thumb');
  boxWrap.append(inp, track, thumb);

  inp.addEventListener('change', () => {
    settings.set(path, inp.checked);
    audio.play('uiClick');
  });

  lab.append(text, boxWrap);
  return lab;
}

function selectRow(name, path, options) {
  const row = el('div', 'select-row');
  const label = el('label', 'switch__name', name);
  const wrap = el('div', 'select-wrap');
  const sel = el('select', 'select');
  const id = 'set-' + path.replace(/\./g, '-');
  sel.id = id;
  label.setAttribute('for', id);

  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o.value);
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = String(settings.get(path));
  sel.addEventListener('change', () => {
    const raw = sel.value;
    const parsed = raw === 'true' ? true : raw === 'false' ? false
      : (raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw);
    settings.set(path, parsed);
    audio.play('uiClick');
  });

  wrap.appendChild(sel);
  row.append(label, wrap);
  return row;
}

function textRow(name, hint, path, placeholder) {
  const g = el('div', '');
  const field = el('div', 'field');
  const inp = el('input', 'field__input');
  inp.id = 'set-' + path.replace(/\./g, '-');
  inp.placeholder = ' ';
  inp.style.textTransform = 'none';
  inp.style.letterSpacing = 'normal';
  inp.value = settings.get(path) || '';
  const lab = el('label', 'field__label', name);
  lab.setAttribute('for', inp.id);
  field.append(inp, lab, el('div', 'field__bar'));
  g.appendChild(field);
  if (hint) g.appendChild(el('p', 'card__hint', hint));
  inp.addEventListener('change', () => settings.set(path, inp.value.trim()));
  if (placeholder) inp.setAttribute('aria-describedby', inp.id + '-hint');
  return g;
}

/* ── Keybinding grid ──────────────────────────────────── */

function bindGrid(refresh) {
  const grid = el('div', 'binds');
  grid.append(
    el('div', 'binds__head', 'Action'),
    el('div', 'binds__head', 'Player 1'),
    el('div', 'binds__head', 'Player 2'),
  );

  const used = { p1: new Map(), p2: new Map() };
  for (const side of ['p1', 'p2']) {
    for (const a of ACTIONS) {
      const code = settings.data.keys[side][a.id];
      used[side].set(code, (used[side].get(code) || 0) + 1);
    }
  }

  for (const action of ACTIONS) {
    grid.appendChild(el('div', 'binds__name', action.label));
    for (const side of ['p1', 'p2']) {
      const code = settings.data.keys[side][action.id];
      const key = el('button', 'keycap', keyLabel(code));
      key.type = 'button';
      key.setAttribute('aria-label', `${action.label}, player ${side === 'p1' ? 1 : 2}: ${keyLabel(code)}. Activate to rebind.`);
      if (used[side].get(code) > 1) key.classList.add('keycap--conflict');
      key.addEventListener('click', () => rebind(side, action, key, refresh));
      grid.appendChild(key);
    }
  }
  return grid;
}

async function rebind(side, action, keyEl, refresh) {
  const dlg = document.getElementById('dlg-bind');
  document.getElementById('bind-what').textContent =
    `${action.label} — Player ${side === 'p1' ? 1 : 2}`;
  keyEl.dataset.listening = 'true';
  dlg.showModal();
  audio.play('uiClick');

  const { code } = await input.captureNextKey();
  dlg.close();
  delete keyEl.dataset.listening;

  if (code === 'Escape') { audio.play('uiCancel'); return; }
  if (code === 'Backspace') {
    settings.set(`keys.${side}.${action.id}`, '');
    audio.play('uiCancel');
    refresh();
    return;
  }
  // Free the key from any other action on the same side.
  const binds = settings.data.keys[side];
  for (const other of Object.keys(binds)) {
    if (other !== action.id && binds[other] === code) {
      settings.set(`keys.${side}.${other}`, '');
    }
  }
  settings.set(`keys.${side}.${action.id}`, code);
  audio.play('uiConfirm');
  refresh();
}

/* ══════════════════════════════════════════════════════════════
   Panel construction
   ══════════════════════════════════════════════════════════════ */

export function buildSettings() {
  const dlg = document.getElementById('dlg-settings');
  const panel = (name) => dlg.querySelector(`[data-panel="${name}"]`);

  const render = () => {
    /* — Audio — */
    const a = panel('audio');
    a.replaceChildren();
    const ag = group('Volume');
    ag.append(
      slider('Master', 'audio.master'),
      slider('Sound effects', 'audio.sfx'),
      slider('Music', 'audio.music'),
      slider('Announcer & voices', 'audio.announcer'),
    );
    a.appendChild(ag);
    const ag2 = group('Behaviour');
    ag2.append(toggle('Mute when unfocused', 'Silence the game when you switch tabs',
                      'audio.muteOnBlur'));
    a.appendChild(ag2);
    const note = el('p', 'card__hint',
      'Every sound in the game is synthesised in the browser — there are no audio files. '
      + 'Announcer and character voices use your system\'s speech engine.');
    a.appendChild(note);

    /* — Controls — */
    const c = panel('controls');
    c.replaceChildren();
    const cg = group('Keyboard');
    cg.appendChild(el('p', 'card__hint',
      'Playing on your own? In Arcade, Training and Online, Player 1 answers to '
      + 'BOTH sets at once — so the numpad works without changing anything here. '
      + 'Local Versus keeps the two sets separate, one per player.'));
    cg.appendChild(bindGrid(render));
    c.appendChild(cg);
    const cg2 = group('Gamepads');
    cg2.appendChild(el('p', 'card__hint',
      'Controllers are detected automatically: pad 1 drives Player 1, pad 2 drives '
      + 'Player 2. Face buttons map to LP/HP/LK/HK, right bumper is Super, left bumper '
      + 'is Taunt. Rumble fires on hits if your pad supports it.'));
    c.appendChild(cg2);
    const lg = group('Keyboard layout');
    lg.append(
      selectRow('Layout', 'controls.layout', [
        { value: 'auto', label: `Detect automatically — ${keyboardLayout.label}` },
        { value: 'qwerty', label: 'QWERTY' },
        { value: 'azerty', label: 'AZERTY (ZQSD)' },
        { value: 'qwertz', label: 'QWERTZ' },
      ]),
      el('p', 'card__hint',
        'This only changes what the keys are CALLED here. Bindings are stored as '
        + 'physical key positions, so the movement diamond is already ZQSD on an '
        + 'AZERTY keyboard and WASD on QWERTY — the same three keys under the same '
        + 'three fingers, whatever your keycaps say.'),
    );
    c.appendChild(lg);

    const cg3 = group('Reset');
    const rb = el('button', 'btn btn--ghost btn--sm', 'Restore default bindings');
    rb.type = 'button';
    rb.addEventListener('click', () => {
      settings.resetSection('keys');
      audio.play('uiConfirm');
      render();
    });
    cg3.appendChild(rb);
    c.appendChild(cg3);

    /* — Presentation — */
    const v = panel('video');
    v.replaceChildren();
    const vg = group('Game feel');
    vg.append(
      slider('Screen shake', 'video.shake', { min: 0, max: 2, step: 0.05 }),
      slider('Hit stop', 'video.hitstop', { min: 0.4, max: 1.6, step: 0.05,
        format: (x) => `${x.toFixed(2)}×` }),
      slider('Impact flash', 'video.flash', { min: 0, max: 1.5, step: 0.05 }),
      slider('Particle density', 'video.particles', { min: 0, max: 1.5, step: 0.05 }),
    );
    v.appendChild(vg);
    const vg2 = group('Effects');
    vg2.append(
      toggle('Chromatic aberration', 'RGB split on heavy impacts', 'video.chromatic'),
      toggle('Speed lines', 'Motion streaks on rushing moves', 'video.speedLines'),
      toggle('Weather', 'Rain, snow, wind and wet ground', 'video.weather'),
      toggle('Afterimages', 'Ghost trails on dashes and supers', 'video.afterimages'),
      toggle('Film grain', 'Subtle noise over the whole frame', 'video.grain'),
    );
    v.appendChild(vg2);
    const vg25 = group('Violence');
    vg25.append(
      slider('Blood', 'video.blood', { min: 0, max: 1.5, step: 0.05 }),
      toggle('Fatalities', 'Finishing move on the final knockout', 'video.fatalities'),
      el('p', 'card__hint',
        'Set blood to zero for a bloodless fight. Fatalities can be turned off '
        + 'separately — the match simply ends at the knockout.'),
    );
    v.appendChild(vg25);

    const vg3 = group('Accessibility');
    vg3.append(
      selectRow('Motion', 'video.motion', [
        { value: 'auto', label: 'Follow system setting' },
        { value: 'full', label: 'Full motion' },
        { value: 'reduced', label: 'Reduced motion' },
      ]),
      el('p', 'card__hint',
        'Reduced motion removes screen shake, camera punch, trails and grain, and '
        + 'softens impact flashes. Hit stop is kept because it carries gameplay '
        + 'information rather than decoration.'),
    );
    v.appendChild(vg3);
    const vg4 = group('Debug');
    vg4.append(
      toggle('Show hitboxes', 'Draw attack and hurt boxes', 'video.showHitboxes'),
      toggle('Show performance', 'Frame time and netplay statistics', 'video.showFps'),
    );
    v.appendChild(vg4);

    /* — Match — */
    const m = panel('match');
    m.replaceChildren();
    const mg = group('Rules');
    mg.append(
      selectRow('Rounds', 'match.rounds', [
        { value: 1, label: 'Single round' },
        { value: 3, label: 'Best of 3' },
        { value: 5, label: 'Best of 5' },
      ]),
      selectRow('Round time', 'match.roundTime', [
        { value: 30, label: '30 seconds' },
        { value: 60, label: '60 seconds' },
        { value: 99, label: '99 seconds' },
        { value: 0, label: 'No limit' },
      ]),
      selectRow('Stage', 'last.stage', [
        { value: 'random', label: 'Random' },
        ...STAGE_ORDER.map((id) => ({ value: id, label: STAGES[id].name })),
      ]),
      el('p', 'card__hint',
        'Every stage has a lower level. Knock a cornered opponent off the edge '
        + 'with a heavy blow and the fight continues down there — at a cost to them.'),
      selectRow('CPU difficulty', 'match.difficulty', [
        { value: 'tourist', label: 'Tourist' },
        { value: 'normal', label: 'Delegate' },
        { value: 'delegate', label: 'Head of State' },
        { value: 'chairman', label: 'Chairman' },
      ]),
    );
    m.appendChild(mg);

    const ng = group('Network');
    ng.append(
      selectRow('Input delay', 'match.inputDelay', [
        { value: 0, label: '0 frames — pure rollback' },
        { value: 1, label: '1 frame' },
        { value: 2, label: '2 frames (recommended)' },
        { value: 3, label: '3 frames' },
        { value: 4, label: '4 frames — smoothest' },
      ]),
      el('p', 'card__hint',
        'More delay means fewer rollbacks and a smoother picture, at the cost of '
        + 'slightly less responsive controls. The host\'s setting is used for both players.'),
      textRow('Signalling server', null, 'net.signalUrl'),
      el('p', 'card__hint', signalHint()),
    );
    m.appendChild(ng);
  };

  /* — Tabs — */
  const tabs = dlg.querySelectorAll('.tab');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((o) => {
        const on = o === t;
        o.setAttribute('aria-selected', String(on));
        dlg.querySelector(`[data-panel="${o.dataset.tab}"]`).hidden = !on;
      });
      audio.play('uiClick');
    });
    // Roving arrow-key navigation across the tab strip.
    t.addEventListener('keydown', (e) => {
      const list = [...tabs];
      const i = list.indexOf(t);
      let next = null;
      if (e.key === 'ArrowRight') next = list[(i + 1) % list.length];
      if (e.key === 'ArrowLeft') next = list[(i - 1 + list.length) % list.length];
      if (next) { e.preventDefault(); next.focus(); next.click(); }
    });
  });

  dlg.querySelector('[data-action="reset-settings"]').addEventListener('click', () => {
    settings.reset();
    audio.play('uiConfirm');
    render();
  });

  render();
  return { render };
}

function signalHint() {
  const auto = defaultSignalUrl();
  if (settings.data.net.signalUrl?.trim()) {
    return 'Using your configured server. Clear the field to auto-detect again.';
  }
  if (isStaticHost()) {
    return 'This page is on a static host, which cannot run matchmaking. Run '
         + '`node server/server.js` on a machine both players can reach and paste its '
         + 'ws:// or wss:// address here.';
  }
  return `Auto-detected: ${auto || 'unavailable — serve the game over http to play online'}`;
}

/* ── How-to-play content ──────────────────────────────── */

export function buildHowTo() {
  const body = document.getElementById('howto-body');
  const p1 = settings.data.keys.p1;
  const k = (id) => keyLabel(p1[id]);

  body.innerHTML = `
    <div class="howto">
      <div class="howto__grid">
        <section>
          <h3>Playing on your own</h3>
          <p>In Arcade, Training and Online, <b>both</b> control sets drive your
          fighter at once — WASD or the arrow keys, F/G/V/B or the numpad.
          Use whichever your hands reach for; nothing needs rebinding.</p>
          <p>Local Versus keeps them separate, one set per player.</p>
        </section>

        <section>
          <h3>Player 1 defaults</h3>
          <dl>
            <dt>${k('left')} ${k('down')} ${k('right')}</dt><dd>Move, crouch</dd>
            <dt>${k('up')}</dt><dd>Jump</dd>
            <dt>Hold back</dt><dd>Block</dd>
            <dt>${k('lp')} / ${k('hp')}</dt><dd>Light / Heavy punch</dd>
            <dt>${k('lk')} / ${k('hk')}</dt><dd>Light / Heavy kick</dd>
            <dt>${k('super')}</dt><dd>Super (needs a full bar)</dd>
            <dt>${k('taunt')}</dt><dd>Taunt</dd>
          </dl>
        </section>

        <section>
          <h3>Motions</h3>
          <dl>
            <dt>↓↘→ + P</dt><dd>Quarter-circle forward</dd>
            <dt>↓↙← + P</dt><dd>Quarter-circle back</dd>
            <dt>→↓↘ + P</dt><dd>Dragon punch — invincible anti-air</dd>
            <dt>←↙↓↘→ + K</dt><dd>Half-circle — usually a command grab</dd>
            <dt>[←] →</dt><dd>Charge: hold back, then forward</dd>
            <dt>↓↘→ ×2</dt><dd>Super</dd>
          </dl>
        </section>

        <section>
          <h3>System</h3>
          <p><b>Blocking</b> — hold away from your opponent. Crouch-block stops lows,
          stand-block stops overheads. You cannot block in the air.</p>
          <p><b>Throws</b> — forward + Heavy Punch up close. Mash a punch as you're
          grabbed to tech out; command grabs cannot be teched.</p>
          <p><b>Combos</b> — light attacks cancel into other normals and into specials.
          Damage scales down the longer the combo runs.</p>
        </section>

        <section>
          <h3>Meter &amp; stun</h3>
          <p>The bar at the bottom fills as you deal and take damage. A full bar buys
          one Super.</p>
          <p>Getting hit also builds <b>stun</b>. Fill it and you're dizzy and helpless
          for a couple of seconds — mash to recover faster.</p>
          <p><b>Counter hits</b> land when you strike an opponent during their startup
          frames, for extra damage and hitstun.</p>
        </section>

        <section>
          <h3>Online</h3>
          <p>Multiplayer uses peer-to-peer rollback netcode. Both browsers run the same
          simulation and correct themselves when a prediction turns out wrong, so play
          stays responsive over an imperfect connection.</p>
          <p>Host a room, share the six-character code, and your opponent joins with it.</p>
        </section>

        <section>
          <h3>Satire notice</h3>
          <p>Every fighter is a caricature of a public figure, built from things they
          have publicly said or done. It is comedy and political commentary, not a
          documentary, and certainly not an endorsement of anybody.</p>
        </section>
      </div>
    </div>`;
}
