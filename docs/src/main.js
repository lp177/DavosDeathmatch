/* ══════════════════════════════════════════════════════════════
   Davos Deathmatch — application entry point.

   Owns the screen router, the fixed-timestep loop, and the lifetime of
   a match (offline against the CPU, local versus, or online over
   rollback netplay).

   The loop is deliberately simple: accumulate real time, run whole
   60Hz simulation ticks, then render once with whatever is left over.
   Presentation effects get a fractional dt so they stay smooth on
   high-refresh displays; the simulation never does.
   ══════════════════════════════════════════════════════════════ */

import { TICK_MS, VIEW_W, VIEW_H, MAX_METER, IN } from './sim/constants.js';
import { Match } from './sim/match.js';
import { Ai } from './sim/ai.js';
import { ROSTER, ROSTER_ORDER } from './data/roster.js';
import { STAGE_ORDER, STAGES, tierOf } from './gfx/stage.js';

import { settings } from './core/settings.js';
import { input } from './core/input.js';
import { audio } from './core/audio.js';
import { seedFromString } from './core/rng.js';
import { keyboardLayout } from './core/keyboard.js';

import { Camera } from './fx/camera.js';
import { Particles } from './fx/particles.js';
import { Juice } from './fx/juice.js';
import { Renderer } from './gfx/renderer.js';

import { SignalClient, defaultSignalUrl, signallingHint, probeSignal } from './net/signal.js';
import { ManualSignal, waitForIce, encodeSignal, decodeSignal } from './net/manual.js';
import { TrackerClient } from './net/tracker.js';
import { getIceServers, hasTurn } from './net/ice.js';
import { Peer } from './net/peer.js';
import { Netplay } from './net/netplay.js';

import { installRipples } from './ui/ripple.js';
import { buildSettings, buildHowTo } from './ui/settings-panel.js';
import { SelectScreen } from './ui/select.js';

class App {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    this.camera = new Camera();
    this.particles = new Particles();
    this.juice = new Juice(this.camera, this.particles);
    // Splashes belong to the stage (it knows if the ground is wet) but are
    // triggered by simulation events, which the juice layer owns.
    this.juice.onSplash = (worldX, power) => {
      const p = this.camera.toScreen(worldX, 0);
      this.renderer.stage.splash(p.x, power);
    };
    this.select = new SelectScreen();

    this.screen = 'home';
    this.mode = null;
    this.match = null;
    this.ai = null;
    this.netplay = null;
    this.peer = null;
    this.signal = null;
    this.invite = null;      // the invite link this player arrived on, if any
    this.paused = false;
    this.acc = 0;
    this.lastNow = performance.now();
    this.fpsSamples = [];
    this.pendingOnline = null;

    this.dlgSettings = document.getElementById('dlg-settings');
    this.dlgHowTo = document.getElementById('dlg-howto');

    this._wireUi();
    this._installDialogFallback();
    requestAnimationFrame((t) => this._frame(t));
  }

  /* ══════════════════════════════════════════════════════
     Screen routing
     ══════════════════════════════════════════════════════ */

  show(name) {
    const prev = this.screen;
    this.screen = name;
    for (const s of document.querySelectorAll('.screen')) {
      s.hidden = s.dataset.screen !== name;
    }
    if (name !== 'select') this.select.close();
    else this.select.root.hidden = false;

    if (name === 'home' || name === 'select' || name === 'online') {
      audio.music?.setIntensity(0.45);
      if (!audio.music?.playing) audio.music?.start({ bpm: 128, root: 55 });
    }
    // Focus the first control so keyboard users land somewhere sensible.
    if (name !== 'select') {
      const first = document.querySelector(`[data-screen="${name}"] .btn`);
      if (first && prev !== name) setTimeout(() => first.focus({ preventScroll: true }), 30);
    }
  }

  _wireUi() {
    installRipples(document);
    buildSettings();
    buildHowTo();

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.dataset.action;
      if (act !== 'copy-code') audio.play('uiClick');
      this._action(act, btn);
    });

    // Hover chirp on menu buttons.
    document.addEventListener('pointerenter', (e) => {
      if (e.target.closest?.('.btn')) audio.play('uiHover');
    }, true);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this._onEscape(e);
      if (e.code === 'F1') { e.preventDefault(); this.dlgHowTo.showModal(); }
    });

    // Rebuild the how-to text when bindings — or the keyboard layout — change.
    settings.onChange(() => buildHowTo());
    keyboardLayout.onChange(() => buildHowTo());
  }

  _action(act, btn) {
    switch (act) {
      case 'arcade':    this._toSelect('arcade'); break;
      case 'local-vs':  this._toSelect('local'); break;
      case 'training':  this._toSelect('training'); break;
      case 'online-vs': this._toOnline(); break;

      case 'settings':  this.dlgSettings.showModal(); break;
      case 'howto':     this.dlgHowTo.showModal(); break;

      case 'back':
      case 'to-home':   this._quitToHome(); break;
      case 'to-select': this._toSelect(this.mode === 'online' ? 'arcade' : (this.mode || 'arcade')); break;

      case 'rematch':   this._rematch(); break;
      case 'resume':    this._setPaused(false); break;
      case 'quit':      this._quitToHome(); break;

      case 'net-host':  this._hostGame(); break;
      case 'net-join':  this._joinGame(); break;
      case 'copy-code': this._copyCode(btn); break;

      case 'direct-host':   this._directHost(); break;
      case 'direct-join':   this._directJoin(); break;
      case 'direct-mode':   this._netStep('choose'); break;
      case 'rooms-mode':    this._netStep('rooms'); break;
      case 'lobby-back':    this._lobbyRestart(); break;
      case 'invite-retry':  this._retryInvite(); break;
      case 'invite-abandon': this._abandonInvite(); break;
      case 'close-room':    this._lobbyRestart(); break;
      case 'direct-reply':  this._directReply(); break;
      case 'direct-accept': this._directAccept(); break;
      case 'copy-offer':      this._copyBox('direct-offer', btn); break;
      case 'copy-offer-link': this._copyBox('direct-offer-link', btn); break;
      case 'copy-auto-link':  this._copyBox('auto-link', btn); break;
      case 'copy-answer':     this._copyBox('direct-answer', btn); break;
      case 'copy-room-link':  this._copyText(this._roomLink(), btn); break;
      default: break;
    }
  }

  _onEscape(e) {
    if (this.dlgSettings.open || this.dlgHowTo.open) return;   // dialog handles it
    if (this.screen === 'match') {
      e.preventDefault();
      if (this.mode === 'online') return;    // pausing a netplay match isn't a thing
      this._setPaused(!this.paused);
    } else if (this.screen === 'select' || this.screen === 'online') {
      e.preventDefault();
      this._quitToHome();
    }
  }

  /** `<dialog closedby>` isn't in Safari yet; add click-outside dismissal. */
  _installDialogFallback() {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    for (const dlg of document.querySelectorAll('dialog[closedby="any"]')) {
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right &&
                       e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) dlg.close();
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     Match lifecycle
     ══════════════════════════════════════════════════════ */

  _toSelect(mode) {
    this._teardownNet();
    // Only local versus needs the two binding sets kept apart.
    input.solo = mode !== 'local';
    this.show('select');
    this.select.open({
      mode,
      onConfirm: ({ chars }) => this._startMatch({ mode, chars }),
    });
  }

  _startMatch({ mode, chars, stage, seed, cfgOverride, localPlayer }) {
    this.mode = mode;
    input.solo = mode !== 'local';
    this.select.close();

    const stageId = stage ||
      settings.data.last.stage === 'random' || !STAGES[settings.data.last.stage]
        ? STAGE_ORDER[Math.floor(Math.random() * STAGE_ORDER.length)]
        : settings.data.last.stage;
    const s = settings.data.match;
    const cfg = cfgOverride || {
      chars,
      stage: stageId,
      seed: seed ?? (Date.now() & 0x7fffffff),
      rounds: mode === 'training' ? 1 : s.rounds,
      roundTime: mode === 'training' ? 0 : s.roundTime,
      // Online forces a neutral hit-stop scale: it feeds the simulation, so
      // both peers must agree on it or they desync.
      hitstopScale: mode === 'online' ? 1 : settings.data.video.hitstop,
      training: mode === 'training',
    };
    this.cfg = cfg;
    this.match = new Match(cfg);

    this.renderer.reset(cfg.stage, 0);
    this.camera.reset();
    this.particles.clear();
    this.juice.reset();
    this.paused = false;
    this.acc = 0;

    this.ai = null;
    if (mode === 'arcade' || mode === 'training') {
      this.ai = new Ai(1, ROSTER[cfg.chars[1]], s.difficulty, cfg.seed ^ 0x5f3a);
    }

    if (mode === 'online') {
      this.localPlayer = localPlayer;
      this.netplay = new Netplay(this.peer, localPlayer, this.match, s.inputDelay);
      // requestAnimationFrame stops in a hidden tab. Offline that's fine —
      // the game just pauses — but online it strands the opponent, who keeps
      // predicting inputs that never arrive. Keep the simulation ticking from
      // a timer whenever the page isn't visible.
      clearInterval(this._bgTimer);
      this._bgTimer = setInterval(() => this._backgroundTick(), 16);
      this.netplay.addEventListener('desync', () => {
        this._netStatus('error', 'Desync detected — the match cannot continue.');
        this._endOnline('Desync detected. The two simulations diverged.');
      });
      this.netplay.addEventListener('disconnected', (e) => {
        this._endOnline(e.detail === 'stalled'
          ? 'Lost sync with your opponent — their game stopped responding.'
          : 'Your opponent disconnected.');
      });
      for (const early of (this._earlyNetMessages || [])) this.netplay._handle(early);
      this._earlyNetMessages = null;
    }

    // Music belongs to the place, not the fighter — a stage should sound
    // like where it is.
    const st = STAGES[cfg.stage] || STAGES.congress;
    audio.music?.start({ ...st.music });
    audio.music?.setIntensity(0.7);

    this.show('match');
    this.canvas.focus?.();
  }

  _rematch() {
    if (this.mode === 'online') {
      // A clean rematch needs a fresh handshake; send both back to the lobby.
      this._quitToHome();
      return;
    }
    this._startMatch({ mode: this.mode, chars: this.cfg.chars, stage: this.cfg.stage });
  }

  _quitToHome() {
    this._teardownNet();
    this.invite = null;   // leaving the lobby ends the invitation too
    this.match = null;
    this.ai = null;
    this.paused = false;
    audio.stopSpeech();
    audio.music?.setIntensity(0.45);
    this.show('home');
  }

  _setPaused(on) {
    this.paused = on;
    document.getElementById('screen-pause').hidden = !on;
    if (on) audio.music?.setIntensity(0.25);
    else audio.music?.setIntensity(0.8);
  }

  _showResults() {
    const r = this.match.result;
    const winner = ROSTER[this.cfg.chars[r.winner]];
    const loser = ROSTER[this.cfg.chars[1 - r.winner]];
    const wf = this.match.fighters[r.winner];

    document.getElementById('results-title').textContent =
      wf.health >= wf.maxHealth ? 'FLAWLESS' : 'K.O.';
    document.getElementById('results-winner').innerHTML =
      `<b>${winner.name}</b> ${winner.flag} defeats ${loser.name} ${loser.flag}`;

    const stats = document.getElementById('results-stats');
    stats.replaceChildren();
    const add = (label, value) => {
      const d = document.createElement('div');
      d.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
      stats.appendChild(d);
    };
    add('Rounds', `${r.wins[0]} – ${r.wins[1]}`);
    add('Damage dealt', Math.round(wf.totalDamage));
    add('Best combo', wf.maxCombo || 1);
    add('Hits landed', wf.hitsLanded);
    add('Health left', `${Math.round((wf.health / wf.maxHealth) * 100)}%`);

    // Online has no meaningful "change delegate" without renegotiating.
    document.querySelector('[data-action="to-select"]').hidden = this.mode === 'online';
    document.querySelector('[data-action="rematch"]').textContent =
      this.mode === 'online' ? 'Back to Lobby' : 'Rematch';

    this.show('results');
    audio.music?.setIntensity(0.4);
    this.particles.confetti(0, 0, 60);
  }

  /* ══════════════════════════════════════════════════════
     Online
     ══════════════════════════════════════════════════════ */

  /** Show exactly one stage of the lobby. */
  _netStep(name) {
    for (const el of document.querySelectorAll('#screen-online .lobby-step')) {
      el.hidden = el.dataset.step !== name;
    }
    this.netStep = name;
  }

  /** Hide the room code and everything that only makes sense beside it. */
  _resetRoomUi() {
    for (const id of ['roomcode', 'copy-room-link', 'room-open-hint', 'close-room']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  }

  _lobbyRestart() {
    // Closing the signalling socket is what actually ends the room: the server
    // keeps it alive for exactly as long as the host is connected.
    this._teardownNet();
    this._resetRoomUi();
    // Reaching the ordinary lobby is a deliberate choice to stop following the
    // invite, so stop treating failures here as invite failures.
    this.invite = null;
    document.getElementById('rooms-mode').hidden = !this.hasSignalling;
    this._netStep('choose');
    this._netStatus('idle', 'Not connected');
  }

  async _toOnline() {
    this._teardownNet();
    this.show('online');
    this._resetRoomUi();

    // Find out what's actually possible before offering anything. Showing a
    // room-code form that cannot work — and a direct-connect panel next to
    // it — is how you lose someone before they've played.
    this._netStep('probe');
    this._netStatus('working', 'Looking for a matchmaking server…');
    this._ensureIce();          // warm the cache; connecting shouldn't wait on it

    // Probe briefly, but never sit waiting on something that cannot answer:
    // a same-origin guess on a static host is known-dead before we try it.
    const url = defaultSignalUrl();
    // Long enough for an intercontinental WebSocket handshake — too short
    // and distant players get silently demoted to the direct-only lobby.
    this.hasSignalling = await probeSignal(url, 4500);

    this._netStat('ns-signal', this.hasSignalling ? url : 'none — direct only');

    // Lead with the direct invite whether or not a matchmaking server answered.
    // It needs the least from the network — no server has to stay reachable to
    // both players for the length of a lobby — and it is the path that has
    // actually been connecting people. Room codes stay one click away for
    // anyone who prefers them.
    document.getElementById('rooms-mode').hidden = !this.hasSignalling;
    this._netStep('choose');
    this._netStatus('idle', 'Ready. Send your opponent a link.');
    return this.hasSignalling;
  }

  _netStatus(state, text) {
    const box = document.getElementById('netstatus');
    box.querySelector('.netstatus__dot').dataset.state = state;
    box.querySelector('.netstatus__text').textContent = text;
  }

  _netStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /**
   * Returns the client it created. Callers must hold on to THAT object rather
   * than re-reading this.signal after an await: a second attempt (a retry, a
   * reclaim, an impatient second click) replaces this.signal, and a suspended
   * first attempt would then resume onto the new socket — signalling into a
   * room it never joined, with a peer that never hears it.
   */
  async _connectSignal() {
    this.signal?.close();          // never leak the previous socket
    const signal = new SignalClient();
    this.signal = signal;
    this._netStatus('working', 'Reaching the matchmaking server…');
    await signal.connect();
    this._netStat('ns-signal', 'connected');
    return signal;
  }

  /**
   * Build the Peer for an attempt, retiring any previous one first.
   *
   * Without this a failed or superseded attempt leaves a live Peer behind, and
   * its 'closed' event later tears down the match that eventually worked.
   */
  _newPeer(initiator, signal) {
    this.peer?.close();
    this.peer = new Peer(signal, initiator, this.iceServers);
    this._watchPeer();
    return this.peer;
  }

  async _hostGame(reclaim = null) {
    const epoch = (this._netEpoch = (this._netEpoch || 0) + 1);
    try {
      await this._ensureIce();
      const signal = await this._connectSignal();
      if (this._netEpoch !== epoch) { signal.close(); return; }
      signal.host(reclaim);
      const { code } = await signal.once((m) => m.t === 'hosted');

      document.getElementById('roomcode').hidden = false;
      document.getElementById('roomcode-value').textContent = code;
      document.getElementById('copy-room-link').hidden = false;
      document.getElementById('room-open-hint').hidden = false;
      document.getElementById('close-room').hidden = false;
      this._netStatus('working', 'Room open — waiting for an opponent…');

      try {
        // No deadline: the room stays open for as long as this page is.
        await signal.once((m) => m.t === 'peer-joined', Infinity);
      } catch (err) {
        // The wait is long by design, and the link is already in someone's
        // chat window. If the socket died rather than the player giving up,
        // reconnect and ask for the same code back instead of ending the
        // wait — otherwise the link they sent points at nothing.
        if (/closed/i.test(err.message || '') && this.netStep === 'rooms'
            && this._netEpoch === epoch) {
          this._netStatus('working', 'Reconnecting — your room code still works…');
          this._hostGame(code);
          return;
        }
        throw err;
      }
      this._netStatus('working', 'Opponent found. Connecting directly…');

      // Refresh the relay credentials NOW, not when the room was opened. The
      // wait above is unbounded by design, so the credentials fetched back
      // then may have expired — and if that first fetch happened to fail, the
      // host would otherwise spend the room's whole life on STUN only while
      // the guest quietly has TURN. Two peers on the same network still find
      // each other that way, which is exactly why this survives local testing
      // and fails between countries.
      await this._ensureIce();
      if (this._netEpoch !== epoch) { signal.close(); return; }

      const peer = this._newPeer(true, signal);
      await peer.start();
      await peer.waitOpen();
      if (this.peer !== peer) return;      // superseded while connecting

      this._netStatus('ok', 'Connected. Choose your delegate.');
      this._netStat('ns-peer', 'connected (host)');
      this._reportRoute();
      this._onlineSelect(0, seedFromString(code));
    } catch (err) {
      if (this._netEpoch !== epoch) return;   // torn down on purpose
      this._netFailed(err, 'host');
    }
  }

  async _joinGame() {
    const field = document.getElementById('join-code');
    const code = field.value.trim().toUpperCase();
    if (code.length !== 6) {
      this._netStatus('error', 'Room codes are six characters long.');
      audio.play('uiError');
      field.focus();
      return;
    }
    // Same epoch discipline as the host: a second attempt must not be able to
    // resume the first one's awaits onto its socket.
    const epoch = (this._netEpoch = (this._netEpoch || 0) + 1);
    try {
      await this._ensureIce();
      const signal = await this._connectSignal();
      if (this._netEpoch !== epoch) { signal.close(); return; }
      signal.join(code);
      await signal.once((m) => m.t === 'joined');
      this._netStatus('working', 'Room found. Connecting directly…');

      const peer = this._newPeer(false, signal);
      await peer.waitOpen();
      if (this.peer !== peer) return;      // superseded while connecting

      this._netStatus('ok', 'Connected. Choose your delegate.');
      this._netStat('ns-peer', 'connected (guest)');
      this._reportRoute();
      this._onlineSelect(1, seedFromString(code));
    } catch (err) {
      if (this._netEpoch !== epoch) return;
      this._netFailed(err, 'join');
    }
  }

  /**
   * Explain a matchmaking failure in terms of what the player can do.
   * "Could not reach the server" is true and useless; the reason it can't
   * be reached is almost always that there isn't one, which has a fix.
   */
  /**
   * The invite couldn't be honoured. Offer to try it again — the host may
   * simply be a few seconds behind — and make abandoning it a deliberate,
   * clearly-labelled second choice rather than the default.
   */
  _inviteFailed(reason) {
    const code = this.invite?.value || '';
    document.getElementById('invite-failed-lead').textContent = reason;
    document.getElementById('invite-failed-code').textContent =
      this.invite?.kind === 'room' ? code : 'the invitation';
    this._netStep('invite-failed');
    this._netStatus('error', reason);
    audio.play('uiError');
  }

  _retryInvite() {
    if (!this.invite) { this._lobbyRestart(); return; }
    this._openInvite(this.invite).catch(() =>
      this._inviteFailed('That invitation still cannot be reached.'));
  }

  /** Deliberately give up on the invite and use the lobby normally. */
  _abandonInvite() {
    this.invite = null;
    clearInvite();
    this._lobbyRestart();
  }

  _netFailed(err, what) {
    audio.play('uiError');
    const url = defaultSignalUrl();
    const noServer = /reach|timed out|Invalid signalling|No signalling/i.test(err.message || '');
    // An invited player gets the invite-specific recovery screen, never the
    // generic lobby: the generic one leads straight to a second empty room.
    if (this.invite) {
      this._inviteFailed(noServer
        ? 'Could not reach the matchmaking server to join that room.'
        : (err.message || 'That invitation could not be opened.'));
      return;
    }
    if (noServer) {
      this.hasSignalling = false;
      this._netStatus('error',
        'That matchmaking server is unreachable — connecting directly instead.');
      this._netStep('choose');
      document.getElementById('choose-lead').textContent =
        'The matchmaking server could not be reached. Send your opponent a link '
        + 'instead — the two browsers will connect to each other directly.';
    } else {
      this._netStatus('error', err.message || `Could not ${what} a match.`);
    }
  }

  /* ── Shareable invite links ──────────────────────────── */

  /**
   * Invites travel in the URL fragment rather than the query string: a
   * fragment is never sent to the server, which matters when the code is
   * a connection offer, and it survives on any static host.
   */
  _link(kind, value) {
    const base = location.origin + location.pathname;
    return `${base}#${kind}=${encodeURIComponent(value)}`;
  }

  _roomLink() {
    return this._link('r', document.getElementById('roomcode-value').textContent.trim());
  }

  /**
   * Act on an invite the player arrived with.
   *
   * Everything here exists to protect one property: a player who followed an
   * invite link must never quietly end up somewhere that isn't their friend's
   * room. The failure that motivated it is subtle — the guest is dropped into
   * the ordinary lobby, whose most obvious button is "Create Room", so they
   * take it and sit alone with a brand-new code while the host waits in the
   * original room. Both people see a plausible screen and neither sees the bug.
   */
  async _openInvite(invite) {
    this.invite = invite;
    await this._toOnline();
    if (invite.kind === 'auto') {
      if (await this._autoJoin(invite.value)) return;
      this._inviteFailed('That invitation has expired, or the host has closed it.');
      return;
    }
    if (invite.kind === 'room') {
      document.getElementById('join-code').value = invite.value;
      this._netStep('invited');
      document.getElementById('invited-text').textContent =
        `Joining room ${invite.value}…`;
      this._netStatus('working', 'Joining the room you were invited to…');
      await this._joinGame();
      return;
    }
    // A direct-connect invite: answer it straight away, so the player's only
    // job is to send the reply code back. They never see the paste step.
    document.getElementById('direct-offer-in').value = invite.value;
    this._netStep('guest-reply');
    this._netStatus('working', 'Answering the invitation…');
    await this._directReply();
  }

  /* ── Serverless direct connect ───────────────────────── */

  /**
   * Make sure we have ICE servers — including a TURN relay — before
   * building any peer connection. Cached, so this is free after the first
   * call, and it never throws: STUN-only still connects for most players.
   */
  async _ensureIce() {
    const servers = await getIceServers();
    // Only ever upgrade: a STUN-only result must not replace one with a relay.
    if (!this.iceServers || hasTurn(servers) || !hasTurn(this.iceServers)) {
      this.iceServers = servers;
    }
    this._netStat('ns-relay', hasTurn(this.iceServers) ? 'TURN available' : 'STUN only');
    return this.iceServers;
  }

  /**
   * Build a Peer with no signalling server behind it.
   * Tearing down first clears any half-finished attempt, but the tracker we
   * are mid-way through using has to survive that — it is the thing that
   * will carry this peer's offer.
   */
  _directPeer(initiator, keepTracker = false) {
    const tracker = keepTracker ? this.tracker : null;
    if (keepTracker) this.tracker = null;      // hide it from the teardown
    this._teardownNet();
    if (keepTracker) this.tracker = tracker;
    this.manual = new ManualSignal();
    this.peer = new Peer(this.manual, initiator, this.iceServers);
    this._watchPeer();
    return this.peer;
  }

  /**
   * Host with automatic matchmaking. The invite link carries a room code;
   * a public tracker introduces the two browsers, so whoever opens the
   * link first is simply accepted — nothing to paste back.
   *
   * Falls through to the manual exchange if no tracker answers, because
   * that path depends on somebody else's infrastructure and this one
   * doesn't.
   */
  async _directHost() {
    this._netStep('host-auto');
    await this._ensureIce();
    const linkBox = document.getElementById('auto-link');
    linkBox.value = '';
    this._netStatus('working', 'Setting up matchmaking…');

    const code = this._newRoomCode();
    this.tracker = new TrackerClient(code);
    const up = await this.tracker.connect();
    if (!up) {
      this.tracker.close();
      this.tracker = null;
      this._netStatus('working', 'Matchmaking unavailable — swapping codes by hand instead.');
      return this._directHostManual();
    }

    try {
      const peer = this._directPeer(true, true);
      await peer.start();
      await waitForIce(peer.pc);

      linkBox.value = this._link('t', code);
      this._netStatus('ok', 'Invitation ready. Send the link.');
      this.tracker.publishOffer({ type: 'offer', sdp: peer.pc.localDescription.sdp });

      // First answer wins; later ones are ignored.
      this.tracker.addEventListener('answer', (ev) => {
        if (this._answered) return;
        this._answered = true;
        document.getElementById('auto-wait').textContent = 'Opponent found. Connecting…';
        this.manual.deliver({ kind: 'answer', sdp: ev.detail.answer });
      }, { once: false });

      // Open-ended: the invitation stays live until this page closes.
      peer.waitOpen(Infinity)
        .then(() => { this.tracker?.close(); this.tracker = null; this._directConnected(0); })
        .catch(() => { /* surfaced by the peer close handler */ });
    } catch (err) {
      this._netStatus('error', err.message || 'Could not create an invitation.');
      audio.play('uiError');
    }
  }

  _newRoomCode() {
    const A = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 8; i++) c += A[Math.floor(Math.random() * A.length)];
    return c;
  }

  /** Join a room code automatically. Returns false if no tracker answers. */
  async _autoJoin(code) {
    this._netStep('guest-auto');
    await this._ensureIce();
    this._netStatus('working', 'Finding your opponent…');
    this.tracker = new TrackerClient(code);
    if (!(await this.tracker.connect())) {
      this.tracker.close(); this.tracker = null;
      return false;
    }
    this.tracker.seek();
    try {
      // Keep looking for as long as they leave the page open. The host
      // re-advertises every few seconds, so an invitation opened long before
      // the host was ready still finds them; giving up after half a minute
      // only ever punishes the patient.
      const waited = document.getElementById('guest-auto-text');
      let seconds = 0;
      this._seekTimer = setInterval(() => {
        seconds += 5;
        waited.textContent = seconds < 20
          ? 'Finding your opponent…'
          : `Still waiting for your opponent (${seconds}s) — they may not have opened the game yet.`;
      }, 5000);
      const { offer, offerId, fromPeer } = await this.tracker.once('offer', Infinity)
        .finally(() => { clearInterval(this._seekTimer); this._seekTimer = null; });
      document.getElementById('guest-auto-text').textContent = 'Opponent found. Connecting…';
      const peer = this._directPeer(false, true);
      this.manual.deliver({ kind: 'offer', sdp: offer });
      await this._waitFor(() => peer.pc.localDescription, 8000, 'Could not answer.');
      await waitForIce(peer.pc);
      this.tracker.sendAnswer({ type: 'answer', sdp: peer.pc.localDescription.sdp },
                              offerId, fromPeer);
      peer.waitOpen(60000)
        .then(() => { this.tracker?.close(); this.tracker = null; this._directConnected(1); })
        .catch(() => this._netStatus('error', 'Could not reach your opponent.'));
      return true;
    } catch {
      this.tracker.close(); this.tracker = null;
      this._netStatus('error', 'That invitation has expired or the host has gone.');
      return false;
    }
  }

  async _directHostManual() {
    this._netStep('host-share');
    await this._ensureIce();
    const box = document.getElementById('direct-offer');
    const linkBox = document.getElementById('direct-offer-link');
    box.value = '';
    linkBox.value = '';
    linkBox.placeholder = 'Creating your invitation…';
    this._netStatus('working', 'Creating your invitation…');
    try {
      const peer = this._directPeer(true);
      await peer.start();
      await waitForIce(peer.pc);
      const code = await encodeSignal('offer', peer.pc.localDescription);
      box.value = code;
      document.getElementById('direct-offer-link').value = this._link('i', code);
      this._netStatus('working', 'Send that link, then paste their reply below.');
      // Connection completes the moment their answer is applied. No deadline:
      // the invitation is good until this page closes.
      peer.waitOpen(Infinity)
        .then(() => this._directConnected(0))
        .catch(() => { /* surfaced by the peer close handler */ });
    } catch (err) {
      linkBox.placeholder = 'Could not create an invitation.';
      this._netStatus('error', err.message || 'Could not create an invitation.');
      audio.play('uiError');
    }
  }

  _directJoin() {
    this._netStep('guest-paste');
    this._netStatus('idle', 'Paste the invite you were sent.');
  }

  async _directReply() {
    const input = document.getElementById('direct-offer-in').value;
    if (!input.trim()) {
      this._netStatus('error', 'Paste the invite code first.');
      audio.play('uiError');
      return;
    }
    try {
      const { sdp } = await decodeSignal(input);
      await this._ensureIce();
      this._netStatus('working', 'Building your reply…');
      const peer = this._directPeer(false);
      this.manual.deliver({ kind: 'offer', sdp });
      // Peer answers asynchronously; wait for the description to exist.
      await this._waitFor(() => peer.pc.localDescription, 8000,
        'Could not answer that invite.');
      await waitForIce(peer.pc);

      const code = await encodeSignal('answer', peer.pc.localDescription);
      this._netStep('guest-reply');
      document.getElementById('direct-answer').value = code;
      this._netStatus('working', 'Send that reply back and wait for them to connect.');

      peer.waitOpen(Infinity)
        .then(() => this._directConnected(1))
        .catch(() => { /* surfaced by the peer close handler */ });
    } catch (err) {
      this._netStatus('error', err.message || 'That invite could not be read.');
      audio.play('uiError');
    }
  }

  async _directAccept() {
    const input = document.getElementById('direct-answer-in').value;
    if (!input.trim()) {
      this._netStatus('error', 'Paste their reply code first.');
      audio.play('uiError');
      return;
    }
    try {
      const { sdp } = await decodeSignal(input);
      this._netStatus('working', 'Connecting…');
      this.manual.deliver({ kind: 'answer', sdp });
    } catch (err) {
      this._netStatus('error', err.message || 'That reply could not be read.');
      audio.play('uiError');
    }
  }

  /** Note whether we ended up direct or relayed, once ICE has settled. */
  async _reportRoute() {
    setTimeout(async () => {
      const r = await this.peer?.routeType?.();
      if (!r) return;
      this._route = r;
      this._netStat('ns-relay', r === 'relay'
        ? 'relayed through TURN' : `direct (${r})`);
    }, 1500);
  }

  _directConnected(localPlayer) {
    this._netStatus('ok', 'Connected. Choose your delegate.');
    this._netStat('ns-peer', `direct (${localPlayer === 0 ? 'host' : 'guest'})`);
    this._reportRoute();
    this._netStat('ns-signal', 'none — direct connection');
    audio.play('uiConfirm');
    // Host picks the seed; the guest adopts whatever arrives with `go`.
    this._onlineSelect(localPlayer, (Date.now() & 0x7fffffff) >>> 0);
  }

  /** Poll a condition without busy-waiting the main thread. */
  _waitFor(fn, ms, message) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        if (fn()) return resolve();
        if (performance.now() - started > ms) return reject(new Error(message));
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  async _copyText(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      audio.play('uiConfirm');
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch {
      audio.play('uiError');
    }
  }

  async _copyBox(id, btn) {
    const el = document.getElementById(id);
    if (!el.value) return;
    try {
      await navigator.clipboard.writeText(el.value);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      audio.play('uiConfirm');
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch {
      el.select();
      audio.play('uiError');
    }
  }

  _watchPeer() {
    // Every listener checks that it still speaks for the current attempt. A
    // Peer from an abandoned attempt stays alive until GC and still fires
    // 'closed' — which, unguarded, ends the match that finally worked.
    const peer = this.peer;
    const current = () => this.peer === peer;

    peer.addEventListener('closed', () => {
      if (!current()) return;
      if (this.screen === 'match') this._endOnline('Connection lost.');
      else this._netStatus('error', 'Connection lost.');
    });
    peer.addEventListener('data', (ev) => {
      if (current()) this._onPeerMessage(ev.detail);
    });
    peer.addEventListener('unstable', (ev) => {
      if (!current() || !this.juice) return;
      this.juice.announce = ev.detail
        ? { text: 'RECONNECTING', life: 600, maxLife: 600, big: false }
        : null;
    });
    peer.addEventListener('pcstate', (ev) => {
      if (current()) this._netStat('ns-peer', ev.detail);
    });
  }

  _onlineSelect(localPlayer, seed) {
    // The invite has done its job; from here a reload should start clean
    // rather than try to re-join a room this player is already inside.
    this.invite = null;
    clearInvite();
    input.solo = true;      // one person at this keyboard
    this.pendingOnline = { localPlayer, seed, picks: [null, null] };
    this.show('select');
    this.select.open({
      mode: 'online',
      localPlayer,
      onLocalPick: (charId) => {
        this.pendingOnline.picks[localPlayer] = charId;
        this.peer.send({ t: 'pick', char: charId });
        this._tryStartOnline();
      },
      onConfirm: () => { /* start is driven by the host's `go` message */ },
    });
  }

  _onPeerMessage(msg) {
    // Input and checksum packets can arrive before the Netplay session has
    // been constructed. Dropping them strands the peer forever: it keeps
    // waiting on inputs for frames it will never be sent again, and both
    // sides deadlock. Hold them and replay them once the session exists.
    if (msg.t === 'i' || msg.t === 'c') {
      if (!this.netplay) {
        (this._earlyNetMessages ??= []).push(msg);
      }
      return;
    }
    if (msg.t === 'pick') {
      const p = this.pendingOnline;
      if (!p) return;
      p.picks[1 - p.localPlayer] = msg.char;
      this.select.setRemotePick(msg.char);
      this._tryStartOnline();
    } else if (msg.t === 'go') {
      // Guest: adopt the host's configuration verbatim.
      const p = this.pendingOnline;
      if (!p || p.localPlayer === 0) return;
      this._startMatch({
        mode: 'online',
        localPlayer: 1,
        cfgOverride: msg.cfg,
        chars: msg.cfg.chars,
      });
    }
  }

  _tryStartOnline() {
    const p = this.pendingOnline;
    if (!p || !p.picks[0] || !p.picks[1]) return;
    if (p.localPlayer !== 0) return;      // only the host decides

    const cfg = {
      chars: [p.picks[0], p.picks[1]],
      stage: STAGE_ORDER[p.seed % STAGE_ORDER.length],
      seed: p.seed,
      rounds: settings.data.match.rounds,
      roundTime: settings.data.match.roundTime,
      hitstopScale: 1,
      training: false,
    };
    this.peer.send({ t: 'go', cfg });
    // Start immediately. The host must have its session listening before the
    // guest — which receives `go` at least one trip later — can send anything.
    this._startMatch({ mode: 'online', localPlayer: 0, cfgOverride: cfg, chars: cfg.chars });
  }

  _endOnline(reason) {
    this._teardownNet();
    this.match = null;
    this.show('online');
    this._netStatus('error', reason);
    audio.play('uiError');
  }

  _teardownNet() {
    // Anything still waiting on the old connection must not act on its death:
    // to a pending await, "the player closed the room" and "the network
    // dropped" arrive as the identical rejection. Bumping the epoch lets the
    // waiter tell them apart — without it, closing a room silently re-opens it.
    this._netEpoch = (this._netEpoch || 0) + 1;
    clearInterval(this._bgTimer);
    this._bgTimer = null;
    clearInterval(this._seekTimer);
    this._seekTimer = null;
    try { this.netplay?.bye(); } catch { /* already gone */ }
    this.netplay?.dispose();
    this.netplay = null;
    this.peer?.close();
    this.peer = null;
    this.signal?.close();
    this.signal = null;
    this.tracker?.close();
    this.tracker = null;
    this._answered = false;
    this.manual = null;
    this.pendingOnline = null;
  }

  async _copyCode(btn) {
    const code = document.getElementById('roomcode-value').textContent;
    try {
      await navigator.clipboard.writeText(code);
      const old = btn.textContent;
      btn.textContent = 'Copied';
      audio.play('uiConfirm');
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch {
      audio.play('uiError');
    }
  }

  /* ══════════════════════════════════════════════════════
     Loop
     ══════════════════════════════════════════════════════ */

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));

    let elapsed = now - this.lastNow;
    this.lastNow = now;
    if (elapsed > 220) elapsed = 220;       // tab was backgrounded; don't fast-forward
    if (elapsed < 0) elapsed = 0;

    this.fpsSamples.push(elapsed);
    if (this.fpsSamples.length > 60) this.fpsSamples.shift();

    // Slow motion is a local flourish; online must run at real speed or
    // the two peers drift apart.
    const timeScale = this.mode === 'online' ? 1 : this.camera.slowmo;
    // Two clocks: dtFrames drives the world (and slows with it), dtReal drives
    // anything whose duration is a promise to the player — how long slow motion
    // lasts, how long a finisher takes.
    const dtReal = Math.min(4, elapsed / TICK_MS);
    const dtFrames = Math.min(4, (elapsed / TICK_MS) * timeScale);
    this.dtReal = dtReal;

    if (this.screen === 'match' && this.match && !this.paused) {
      this.acc += elapsed * timeScale;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 5) {
        this._tick();
        this.acc -= TICK_MS;
        steps++;
      }
      if (steps === 5) this.acc = 0;        // we're behind; drop the backlog
    } else if (this.screen === 'select') {
      this.select.update(dtFrames);
    }

    this._render(dtFrames);
  }

  /**
   * Advance the simulation while the tab is hidden, so an online opponent
   * never has to wait on our window manager. Shares the accumulator and
   * clock with the animation loop, so exactly one of the two drives time.
   */
  _backgroundTick() {
    if (!document.hidden) return;
    if (this.mode !== 'online' || this.screen !== 'match' || !this.match) return;

    const now = performance.now();
    let elapsed = now - this.lastNow;
    this.lastNow = now;
    if (elapsed > 220) elapsed = 220;
    if (elapsed < 0) elapsed = 0;

    this.acc += elapsed;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 5) {
      this._tick();
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps === 5) this.acc = 0;
  }

  _tick() {
    const m = this.match;
    if (!m) return;

    if (this.mode === 'online') {
      if (!this.netplay) return;
      const word = input.poll(0);
      this.netplay.tick(word);
    } else {
      const i0 = input.poll(0);
      const i1 = this.mode === 'local' ? input.poll(1) : (this.ai ? this.ai.update(m) : 0);
      m.step([i0, i1], true);
    }

    this.juice.handle(m.events, m);

    // Falling to a lower tier swaps the scenery and darkens the music.
    for (const e of m.events) {
      if (e.type === 'tierChange') {
        this.renderer.setTier(this.cfg.stage, e.tier);
        const st = STAGES[this.cfg.stage] || STAGES.congress;
        audio.music?.start({ ...st.music, root: st.music.root - 5, bpm: st.music.bpm - 4 });
      }
    }

    if (this.cfg?.training) {
      for (const f of m.fighters) {
        if (f.health < f.maxHealth * 0.02) f.health = f.maxHealth;
        f.meter = MAX_METER;
      }
    }

    // Music rises as somebody gets close to losing.
    const low = Math.min(m.fighters[0].health / m.fighters[0].maxHealth,
                         m.fighters[1].health / m.fighters[1].maxHealth);
    audio.music?.setIntensity(low < 0.3 ? 1.2 : low < 0.6 ? 0.95 : 0.75);

    // Let the finisher play out before the results screen takes over.
    if (m.over && m.phase === 'matchend' && m.phaseFrame > 150 &&
        !this.juice.fatalityRunning) {
      this._showResults();
    }
  }

  _render(dt) {
    const m = this.match;
    this.juice.update(dt);
    if (m) this.juice.updateFatality(this.dtReal ?? dt, m);
    this.particles.update(dt);

    if (m) {
      const [a, b] = m.fighters;
      const spread = Math.abs(a.x - b.x);
      this.camera.update(dt, {
        x: (a.x + b.x) / 2,
        y: Math.max(0, (a.y + b.y) / 2 - 40) * 0.35,
        spread,
      }, this.dtReal ?? dt);
      this.renderer.draw(m, this.camera, this.particles, this.juice, dt, {
        debug: settings.data.video.showFps,
        training: this.cfg?.training,
        lines: this._debugLines(),
      });
    } else {
      // Idle attract backdrop behind the menus.
      this.camera.update(dt, null, this.dtReal ?? dt);
      const ctx = this.renderer.ctx;
      this.renderer.stage.setStage('congress');
      const w = this.renderer.wctx;
      w.setTransform(1, 0, 0, 1, 0, 0);
      w.fillStyle = '#05070b';
      w.fillRect(0, 0, VIEW_W, VIEW_H);
      this.renderer.stage.draw(w, this.camera, dt);
      w.save();
      this.camera.apply(w);
      this.particles.draw(w, -1);
      this.particles.draw(w, 1);
      w.restore();
      ctx.setTransform(this.renderer.dpr, 0, 0, this.renderer.dpr, 0, 0);
      ctx.drawImage(this.renderer.world, 0, 0);
    }
  }

  _debugLines() {
    if (!settings.data.video.showFps) return null;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / (this.fpsSamples.length || 1);
    const lines = [
      `fps        ${(1000 / avg).toFixed(0)}  (${avg.toFixed(1)} ms)`,
      `particles  ${this.particles.count}`,
      `frame      ${this.match ? this.match.frame : 0}`,
    ];
    if (this.netplay) {
      const s = this.netplay.stats;
      if (this._route) lines.push(`route      ${this._route}`);
      lines.push(
        `ping       ${s.ping != null ? s.ping.toFixed(0) + ' ms' : '—'}`,
        `rollback/s ${s.rollbacksPerSec}`,
        `advantage  ${s.advantage}`,
        `delay      ${s.delay}f`,
      );
      if (s.desynced) lines.push('!DESYNC');
    }
    return lines;
  }
}

/* ══════════════════════════════════════════════════════════════
   Boot — WebAudio needs a user gesture, so the game waits behind a
   single button. That gesture also unlocks speech synthesis.
   ══════════════════════════════════════════════════════════════ */

const bootEl = document.getElementById('boot');
const bootBtn = document.getElementById('boot-btn');

async function boot() {
  bootBtn.disabled = true;
  await audio.start();
  input.attach();
  // Work out what this keyboard actually prints before drawing any key
  // labels, so an AZERTY player is told to press Z rather than W.
  await keyboardLayout.detect();

  bootEl.classList.add('boot--fading');
  setTimeout(() => { bootEl.hidden = true; }, 420);

  const app = new App();
  window.__davos = app;          // handy in the console; harmless in production
  app.show('home');
  audio.music?.start({ bpm: 128, root: 55 });
  audio.music?.setIntensity(0.45);

  // Arrived on an invite link? Go straight to it. Read it again rather than
  // trusting the value from page load — a newer link may have arrived while
  // the boot gate was still up.
  const invite = readInvite() || pendingInvite;
  if (invite) {
    try {
      await app._openInvite(invite);
    } catch {
      app._netStatus('error', 'That invitation could not be read. Ask for a fresh one.');
    }
  }
}

/* Read the invite before anything else: the boot gate needs to know whether
   this player was invited.

   The fragment deliberately STAYS in the address bar until the invite has
   actually been used. Clearing it on read looks tidy and quietly breaks the
   feature: a reload — which is what an in-app browser does when it hands a
   link to the real one, and what anyone does when a page seems stuck — then
   loses the invitation for good. The player lands in the ordinary lobby,
   presses the big "Create Room" button, and ends up alone in a new room while
   their friend is still waiting in the old one.

   A room code is idempotent, so replaying it is exactly right. A one-shot
   direct offer isn't, but replaying a spent one fails with a clear message,
   which still beats silently discarding the only thing that could connect
   these two people. */
function readInvite() {
  const hash = location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const room = params.get('r');
  const offer = params.get('i');
  const auto = params.get('t');
  if (!room && !offer && !auto) return null;
  if (auto) return { kind: 'auto', value: auto };
  return room ? { kind: 'room', value: room } : { kind: 'offer', value: offer };
}

const pendingInvite = readInvite();

/** Drop the invite from the URL — once it has served its purpose. */
function clearInvite() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

if (pendingInvite) {
  document.getElementById('boot-btn').textContent = 'Accept the Invitation';
  document.querySelector('.boot__hint').textContent =
    pendingInvite.kind === 'room'
      ? 'You have been challenged. Continue to join the room.'
      : 'You have been challenged. Continue to answer the invitation.';
}

bootBtn.addEventListener('click', boot, { once: true });
bootBtn.focus();

/* A second invite arriving in a tab that is already open.
 *
 * This is the common case, not an exotic one: the first attempt didn't work,
 * the host sends a fresh link, and the browser raises the tab that already has
 * the game in it. Two URLs that differ only after the '#' are the same
 * document, so nothing reloads and no script runs — the invitation lands in
 * the address bar and is silently ignored. The player waits, concludes it is
 * broken, and starts a room of their own. */
window.addEventListener('hashchange', () => {
  const invite = readInvite();
  if (!invite) return;
  const app = window.__davos;
  if (!app) {                       // still on the boot gate: take it from there
    document.getElementById('boot-btn').textContent = 'Accept the Invitation';
    return;
  }
  if (app.screen === 'match') app._quitToHome();
  app._openInvite(invite).catch(() =>
    app._netStatus('error', 'That invitation could not be read. Ask for a fresh one.'));
});

// Warm up the speech voice list; some browsers populate it asynchronously.
if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    audio._voiceCache = window.speechSynthesis.getVoices();
  });
}
