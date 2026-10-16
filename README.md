# BattleBot

A simulator where tiny neural networks learn — by evolution, over generations —
to fight each other in procedurally generated 2D arenas, with a broadcast viewer
built for a livestream.

Two halves, one engine:

- **The lab** — a headless, deterministic simulation plus an evolutionary loop.
  Runs at ~600 generations/hour on one core, checkpoints every generation.
- **The show** — a browser viewer that streams live duels with an auto-director
  camera, kill feed, fighter cards, commentary-ready events and a shrinking
  danger zone. Point OBS at it and you have a channel.

Everything is TypeScript, zero runtime dependencies, and the same simulation code
runs the training and the broadcast.

---

## Quick start

```bash
npm install
npm run build

# train and broadcast at the same time (training runs in a worker thread)
npm run show
```

Then open:

| URL | What |
|---|---|
| `http://127.0.0.1:8787` | the live arena |
| `http://127.0.0.1:8787/dashboard` | fitness / Elo / behaviour graphs |

For OBS: add a **Browser Source** at `http://127.0.0.1:8787`, size `1080x1920`
(vertical) or `1920x1080`, and enable "Shutdown source when not visible" off.

### Other entry points

```bash
npm run train                          # headless evolution only
npm run serve                          # broadcast an existing run
npm test                               # determinism + sanity suite
node dist/cli.js bench --run runs/live # score the champion vs the scripted bot
node dist/cli.js help                  # full flag reference
```

Useful flags:

```bash
node dist/cli.js train --population 80 --generations 400 --seed 7 --out runs/exp1
node dist/cli.js show  --port 9000 --speed 2 --round-seconds 24
node dist/cli.js train --resume --out runs/exp1      # continue where it stopped
```

---

## How the bots actually learn

There is no gradient descent here. This is **neuroevolution**: a population of
small MLPs is scored, the best survive, and the rest are bred.

```
each generation:
  1. every genome plays 4 duels against sampled opponents, each on its own map seed
  2. fitness = 50% absolute quality + 50% margin over the opponent
     (+ a zero-sum novelty bonus for being unlike the rest of the population)
  3. Elo is updated in a batch from the same results
  4. top 4 genomes survive unchanged
     the rest = tournament selection -> uniform crossover -> Gaussian mutation
  5. the champion is benchmarked against the scripted bot and the best-ever
     genome on held-out maps it has never trained on
```

**The fitness function is the real product.** It is dense (you get signal from
"I hit them", not just "I won"), relative to the opponent (so scores cannot
inflate forever) and explicitly penalises the three degenerate strategies that
evolution always finds:

| Degenerate strategy | Countermeasure |
|---|---|
| Cowering in the corner | wall-hugging penalty, gated to the first 60% of the round so the shrinking zone doesn't fake it |
| Refusing to engage | passivity penalty + mobility reward |
| Spinning/turtling into a draw | `timePenalty` per tick, winner bonus, opponent-relative scoring |

Other things that matter and are implemented:

- **Elo + Hall of Fame.** The top 12 genomes of all time are kept as opponents and
  keep playing, so the population can't forget how to beat an old strategy and
  the meta can't cycle forever.
- **Novelty pressure.** A zero-sum diversity bonus stops the population
  collapsing into a monoculture (which happens by ~generation 15 otherwise).
- **Self-adaptive mutation.** Mutation rate and step size are themselves genes,
  inherited from the parent and jittered each generation.
- **Held-out maps.** Training and evaluation use separate map seeds. The dashboard
  shows the win rate on the held-out set — that's your honesty check.
- **The scripted baseline.** A hand-written duelist (`ScriptedBrain`) exists purely
  as a quality bar. If 100 generations can't beat twenty lines of heuristics, the
  fitness function is broken.

### What the bot perceives and does

Observation vector, 92 floats: own position/velocity/health/ammo/cooldown/heading,
**16 raycasts** (distance + hit type: wall / enemy / ally), nearest enemy
(relative position, health, line-of-sight, bearing), nearest ally, a decaying
"last seen enemy" memory, nearest pickup, and match progress.

Action, 11 outputs: 8 compass directions + idle (argmax), a continuous turn rate,
and a trigger. Brains think every 2 ticks and hold the action in between.

---

## The broadcast

The `serve`/`show` commands turn a training run into a **king-of-the-hill show**:
the current champion defends against challengers drawn from the Hall of Fame.
When the champion loses, the belt changes hands. Every few rounds, training's new
champion walks in and takes over.

Wired into the viewer:

- **Auto-director camera** — frames the action, zooms to fit, follows damage
  events, respects the closing zone.
- **The shrinking danger zone** — forces engagement, kills stalling, and gives the
  commentary hook "X is outside the zone". It is centred on the midpoint of the
  two (mirrored) spawns, so it is fair for both sides.
- **Juice** — tracers, hit bursts, damage rings, muzzle flashes, screen shake,
  death explosions, reload arcs.
- **Story furniture** — generation counter, kill feed, fighter cards with Elo and
  health, round-result banner, series score, defence count, tick-rate readout.
- **Names and lineages** — bots are `Fyr-356`, `Vex-9`, not `agent_0042`. New
  genomes inherit their parent's surname, so rivalries are visible.

Server-sent events, not WebSockets: the broadcast is one-way, SSE is built into
Node's `http` module, and it survives OBS browser sources with no dependencies.

---

## Determinism

The simulation is a pure function of `(map seed, genome weights)`.

- Fixed timestep, seeded mulberry32 RNG, no `Math.random`, no `Date.now`, no
  iteration over unordered collections.
- Maps are generated from a seed and never mutated, so they are cached; a match is
  reproducible from its seed and two genomes.

`npm test` asserts this. If it ever fails, replays, highlight clipping and fair
evaluation are all lies. Run it after any engine change.

---

## Layout

```
src/
  engine/
    constants.ts     every tunable number in one place
    rng.ts           seeded RNG (mulberry32) + seed derivation
    names.ts         lineage surnames and bot naming
    map.ts           procedural arenas (rooms, corridors, mirroring,
                     connectivity repair, mirrored spawns, "main street")
    world.ts         the simulation: sensing, movement, bullets, damage,
                     pickups, the shrinking zone, snapshots, events
    types.ts         shared types + the network snapshot protocol
  brain/
    brain.ts         the Brain interface (swap evolution for RL later)
    mlp.ts           small MLP, crossover, mutation, genome (de)serialisation
    simple.ts        RandomBrain + ScriptedBrain (the quality bar)
  train/
    fitness.ts       the fitness function and its anti-degeneracy terms
    match.ts         one duel, map cache, Elo, benchmarks
    individual.ts    a population member + its record
    evolve.ts        selection, reproduction, novelty, Elo, the generation loop
    checkpoint.ts    population / champion / Hall of Fame / CSV persistence
    metrics.ts       per-generation stats, terminal tables, sparklines
    worker.ts        runs the loop off the main thread for `show`
  server/
    showcase.ts      king-of-the-hill matchmaking + broadcast pacing
    server.ts        static files, SSE stream, the 60Hz simulation loop
  runs.ts            discovery of runs/ directories
  cli.ts             command line
  test/determinism.ts
web/
  index.html viewer.js style.css     the live arena
  dashboard.html dashboard.js        the graphs
```

### What gets written to disk

```
runs/<timestamp>_seed<seed>/
  config.json          exact reproducibility (seed, hyperparameters)
  state.json           latest generation + rolling history (the dashboard reads this)
  metrics.csv          one row per generation, flat
  best.json            the current champion — written every generation
  halloffame.json      the top genomes of all time
  gen/gen_000010.json.gz   full population checkpoints (rolling window)
```

Checkpoints are gzipped and pruned to the newest 6; the champion is written every
generation, so a crash costs minutes, not hours. `--resume` continues from the
newest checkpoint.

---

## Tuning guide

Everything lives in `src/engine/constants.ts` and `src/train/evolve.ts`.

| Want | Change |
|---|---|
| Faster training | `--eval-matches 2`, smaller `--population`, or a smaller `--hidden` |
| Smarter bots | run longer. Elo climbs slowly and honestly; there is no shortcut |
| More aggressive fights | raise `damageDealt`, lower `survival`, shrink `ZONE_GRACE_FRACTION` |
| Less corner-camping | raise `wallHug`, `passivity`, or the `mobility` weight |
| More strategic variety | raise `noveltyWeight` and `hallOfFameSize` |
| Shorter, punchier rounds | `--max-ticks 1500 --round-seconds 22` |
| More chaos on stream | `--speed 2`, or add a mutator to `ZONE_DPS` |

---

## Where this goes next

The brainstorm document (`docs/BRAINSTORM.md`) has the full map. The highest-value
next steps, in order:

1. **Viewer interaction.** `tiktok-live-connector` / Twitch IRC into an event bus,
   with chat voting on the next mutator and gifts spawning pickups. Route all of it
   into a separate *sandbox* world so the ranked population stays clean.
2. **Commentary.** TTS reading templated lines, or an LLM grounded in the match
   stats ("Vex-9 has not landed a shot in four rounds"). Highest entertainment
   value per line of code.
3. **Automatic highlight export.** Round results are already reproducible from
   `(seed, genomes)`, so clips can be rendered offline without screen capture.
4. **NEAT or MAP-Elites** for behavioural variety, behind the existing `Brain`
   interface.
5. **2v2 team battles** — shared fitness plus a small individual bonus.
6. **PPO self-play** — the `Brain` interface exists precisely so the show can
   survive swapping evolution for gradient-based RL without a rewrite.

## License

MIT.
