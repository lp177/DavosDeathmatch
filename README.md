# Davos Deathmatch

A satirical 2D fighting game set at the World Economic Forum. Eight delegates,
one Congress Centre, no rules. Runs in the browser with **no build step and no
dependencies** — the whole game is hand-written ES modules, and every sound,
sprite and animation is generated at runtime.

**[▶ Play it here](https://lp177.github.io/DavosDeathmatch/)**

---

## The roster

Every special move is drawn from something the figure actually said or did —
the joke only lands if the source is recognisable.

| Fighter | Style | Signature moves |
| --- | --- | --- |
| **Donald Trump** 🇺🇸 | The Dealmaker — heavy, slow, unignorable | Gold Card · Tariff Wall · Covfefe Uppercut · Grab 'Em · **Liberation of Hormuz** |
| **Greta Thunberg** 🇸🇪 | The Climate Striker — fast rushdown, huge stun | How Dare You · Blah Blah Blah · Shame On You · School Strike · **Global Climate Strike** |
| **Kim Jong Un** 🇰🇵 | The Rocket Man — zoner, controls space with ordnance | Missile Test · The Button · Supreme Ascension · Military Parade · **Glorious Nuclear Test** |
| **Vladimir Putin** 🇷🇺 | The Judoka — grappler, punishes impatience | Judo Throw · Gas Cutoff · Shirtless Bear Rush · Polonium Dart · **Special Military Operation** |
| **Emmanuel Macron** 🇫🇷 | Jupiter — technical, counter-based | En Même Temps · Article 49.3 · Jupiterian Ascent · Pension Reform · **Descent from Olympus** |
| **Elon Musk** 🇿🇦 | The Disruptor — mobility, teleport, rockets | Tweet Storm · Cybertruck Charge · Falcon Boost · Rebrand · **Mars Colonisation** |
| **Javier Milei** 🇦🇷 | The Chainsaw — relentless multi-hit pressure | ¡AFUERA! · Peso Devaluation · Anarcho-Capitalist Rise · Chainsaw Dash · **Shock Therapy** |
| **Klaus Schwab** 🇨🇭 | The Host — steals meter, resets the board | You Will Own Nothing · The Great Reset · Stakeholder Slam · Davos Vortex · **Fourth Industrial Revolution** |

> **Satire notice.** Every fighter is a caricature of a public figure in their
> public capacity, built from things they have publicly said or done. This is
> comedy and political commentary — not a documentary, not an endorsement, and
> not a claim about anyone's private life.

## Modes

- **Arcade** — pick your delegate, the summit provides an opponent.
- **Local Versus** — two players, one keyboard.
- **Multiplayer Versus** — online peer-to-peer with rollback netcode.
- **Training** — infinite health, full meter, hitbox display.

## Controls

**Playing on your own?** In Arcade, Training and Online, *both* control sets
drive your fighter at once — WASD or the arrows, F/G/V/B or the numpad. Use
whichever your hands reach for; nothing needs rebinding. Local Versus keeps
them separate, one set per player.

**On AZERTY?** The table below is QWERTY naming. Bindings are stored as
physical key positions, so the movement diamond is **ZQSD** on AZERTY and WASD
on QWERTY — the same keys under the same fingers. The game detects your layout
and labels everything accordingly; override it in Settings → Controls if the
detection is wrong or your browser doesn't support it.

Everything is rebindable in Settings → Controls. Gamepads are detected
automatically (pad 1 → P1, pad 2 → P2, either one in solo) with rumble on hits.

| | Player 1 | Player 2 |
| --- | --- | --- |
| Move / crouch / jump | `W` `A` `S` `D` | Arrow keys |
| Light / Heavy Punch | `F` / `G` | `Num 4` / `Num 5` |
| Light / Heavy Kick | `V` / `B` | `Num 1` / `Num 2` |
| Super | `H` | `Num 6` |
| Taunt | `T` | `Num 3` |

Hold **away** from your opponent to block. Crouch-block stops lows,
stand-block stops overheads, and you cannot block in the air.

**Motions:** `↓↘→` quarter-circle · `→↓↘` dragon punch (invincible anti-air) ·
`←↙↓↘→` half-circle (command grabs) · `[←] →` charge · `↓↘→ ↓↘→` super.

## Running it locally

The game itself needs nothing but a static file server, because ES modules
can't be loaded from `file://`. The bundled server also provides matchmaking
for online play, and has **zero dependencies** — the WebSocket handshake and
framing are implemented directly against Node's `http` module.

```sh
node server/server.js            # http://localhost:8080
node server/server.js --port 9000 --host 0.0.0.0
```

Requires Node 18+. No `npm install`, no build, no bundler.

## Online play

Multiplayer is peer-to-peer over a WebRTC data channel using **rollback
netcode**. Both browsers run the identical deterministic simulation; neither
waits for the other. Each frame is simulated with the opponent's real input if
it has arrived, or a prediction if it hasn't — and when a prediction turns out
wrong, the state is rewound and re-simulated. Corrections are invisible: the
re-simulation runs with effects suppressed, so hit sparks and sounds never
replay.

The signalling server only introduces the two browsers to each other. Once
they're connected, **no game traffic passes through it**.

### Two ways to connect

Press **Create Room**, send the link, and one click puts your opponent in the
fight. A matchmaking server runs at `wss://lp177.fr/davos/signal` and is used
by default when the game is served from somewhere that can't host one; point
**Settings → Match → Signalling server** at your own to use that instead.

If that server is unreachable, the lobby falls back to **Invite a friend**,
which introduces the two browsers through a public WebTorrent tracker — same
one-click experience, no server of ours involved. Failing that, a manual code
exchange that depends on nothing but the two of you.

Run your own with `node server/server.js` — it serves the game and answers
`/signal` from the same origin, so it is auto-detected with no configuration.

### When there is no direct route

Two players on ordinary home connections can usually reach each other directly
once STUN has told each its public address. Symmetric NAT, carrier-grade NAT and
corporate firewalls defeat that entirely — ICE runs out of candidate pairs and
the browser reports *"ICE failed, add a TURN server"*.

So the server also hands out short-lived credentials for a **TURN relay** at
`/ice`, and the game fetches them before every connection. Traffic then goes
through the relay instead of directly, which costs latency but works from
anywhere. `node server/server.js` offers a relay when given `TURN_SECRET` and
`TURN_URLS`; without them it serves STUN only and says so at startup.

The connection details panel reports which route was actually taken — direct or
relayed — because "it works but it's relayed" is worth knowing.

Direct connect is what makes online work from **GitHub Pages**, which is
static-only and can't host a WebSocket endpoint. It's under *"No matchmaking
server?"* in the multiplayer lobby.

> Both paths need a route between the two machines. On a restrictive
> symmetric NAT, peer-to-peer can fail regardless — that would need a TURN
> relay, which this project deliberately doesn't ship.

## Design notes

**Everything is generated at runtime.** There are no image or audio files in
this repository. Fighters are drawn each frame as small skeletons posed
procedurally and solved with two-bone IK. Sound is synthesised with WebAudio —
impacts, projectiles, UI, and a live step-sequenced soundtrack that rises in
intensity as a round gets close. Announcer and character voices use the
browser's speech engine, with per-character delivery: pitch, rate, and a
`|`-delimited beat system so a furious line lands as *"How. Dare. You."*
rather than a flat read.

**The simulation is deterministic and isolated.** Everything under
`docs/src/sim/` uses only `+ - * /`, a seeded PRNG, and no DOM access — no
`Math.sin`, no `Date.now()`, no `Math.random()`. That's what makes rollback
possible: the whole world can be snapshotted, rewound, and replayed to a
bit-identical result. `docs/src/fx/` and `docs/src/gfx/` are presentation only
and are skipped entirely during re-simulation.

**Game feel lives in one file.** The simulation emits plain facts ("fighter 1
took 84 damage at x=120"). `docs/src/fx/juice.js` turns those into screen
shake, hit-stop, freeze frames, chromatic aberration, particles, floating
damage numbers, combo counters, super cut-ins and controller rumble — so the
entire feel of the game can be retuned from one place.

**Accessibility.** Reduced motion is honoured (and overridable): it removes
shake, camera punch, trails and grain, and softens impact flashes, while
keeping hit-stop because that carries gameplay information rather than
decoration. All controls are keyboard-accessible with visible focus, and
ripples have a keyboard-activated equivalent.

## Layout

```text
docs/                  ← GitHub Pages root; this IS the game, no build step
  index.html
  styles/              design tokens, Material-inspired controls, screens
  src/
    core/              loop timing, seeded RNG, settings, input, audio
    sim/               deterministic fight simulation (no DOM, no Math.random)
    data/              roster, movesets, frame data
    fx/                camera, particles, the juice layer
    gfx/               caricature renderer, stages, HUD
    net/               rollback netcode, WebRTC peer, signalling client
    ui/                screens, settings panels, ripples
server/
  server.js            static host + WebSocket signalling, zero dependencies
```

## Testing

The simulation has no DOM dependencies, so it runs headless in Node. The
browser and netplay suites drive real Chrome over the DevTools Protocol —
including two live peers connected over WebRTC with injected latency, which is
how the rollback path and its checksum agreement are verified.

## Licence

MIT for the code. The satire is offered in the spirit of a political cartoon.
