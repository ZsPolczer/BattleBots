# BattleBot — Design Brainstorm

A simulator where agents learn to fight each other, evolve over generations, and put on a
show worth watching on a livestream.

This document is deliberately broad. It is organized so you can steal the MVP from
Section 14 and ignore the rest until later.

---

## 0. The one-sentence pitch

> Thousands of cheap, dumb bots die badly. The survivors breed. On generation 300 they
> start using cover, flanking, and holding angles — and you caught all of it on camera.

Two products in one:
1. **The lab** — a headless, deterministic, fast-forward training loop that runs faster than
   real time and writes checkpoints + stats to disk.
2. **The show** — a pretty, slow, zoomed-in viewer that replays the interesting bits with
   overlays, commentary, and viewer-driven chaos.

If you only build one, build the show. If the show is boring, nothing else matters.

---

## 1. Design principles that actually decide success

**1. Legibility beats fidelity.**
The audience must understand *why* a bot won in under 2 seconds. Big bullets, clear tracer
lines, a visible health bar, and a "last known enemy" marker do more for watchability than
any physics model. Realistic ragdolls are worthless here.

**2. Progression must be visible in the video, not only in the graph.**
A fitness curve going up is *your* dopamine, not the viewer's. What the viewer sees is
"Gen 12 bots walk into walls" vs "Gen 180 bots kite backwards while shooting." Design the
fitness function to produce visible behavioral milestones, and celebrate them on screen.

**3. Determinism is a first-class feature.**
Fixed timestep, seeded RNG, integer or fixed-point where cheap. Chaos in the sim (random
tie-breaks, unordered map iteration, float drift across platforms) ruins fair evaluation
*and* ruins replays. Every kill you ever want to auto-clip must be reproducible from
`(seed, generation, match_index)`.

**4. Separate simulation from rendering. Hard.**
The sim ticks at a fixed rate and knows nothing about drawing. The renderer samples the
sim. This gives you three modes for free:
- `headless` — 10,000s of ticks/sec, no graphics, for training.
- `replay` — read a recorded tick log, scrub, slow-mo, zoom.
- `live` — real-time pretty rendering for the broadcast.

**5. Degenerate strategies are the real enemy.**
Evolution will find every loophole: spin in place so nothing hits you, hug the wall,
shoot a wall forever to farm "shots fired", refuse to move to preserve "survival" reward.
You cannot patch them all. You fight them by **evaluation design** (Section 7) and by
**adversarial pressure** (opponents that punish passivity).

**6. Cheap and many beats clever and few.**
An army of tiny MLPs is more watchable, faster to train, easier to explain, and evolves
faster than a single deep network. Start at ~2 hidden layers x 48 units. Stay small far
longer than feels comfortable.

---

## 2. Two ways to "learn" — pick your religion

The phrase "reinforcement learning over simulated generations" mixes two families. They
have very different engineering costs and very different *vibes* on stream.

### A. Evolutionary / population-based (recommended start)
You keep a population of N bots, run them in matches, score them with a fitness function,
then select/mutate/crossover to form the next generation.

- **Pros:** embarrassingly parallel, trivially checkpointed and resumed, no reward-shaping
  gradient fragility, shows a literal "generations" narrative on screen, dead simple to
  implement, works with any weird action space. You can evolve *anything* — network
  weights, hyperparameters, body shapes, even the fitness function.
- **Cons:** no gradient signal, sample-hungry, plateaus without care.

Concrete flavors, in increasing order of "fun to watch complexity emerge":
| Method | What evolves | Watchability |
|---|---|---|
| Weight GA (fixed topology) | just the weights | low — looks static |
| **NEAT** | weights *and* network topology | high — brains visibly grow |
| **CMA-ES** | distribution over weights | medium, strong optimizer |
| **MAP-Elites / QD** | whole zoo of behaviors | very high — you get a gallery of strategies |
| Co-evolution / predator-prey | both sides at once | high — arms races are drama |

### B. Deep RL / self-play (the "real ML" endgame)
PPO or SAC agents with a replay of experience, plus a **league** of past opponents
(AlphaStar-style) and Elo matchmaking to avoid cyclic collapse.

- **Pros:** reaches genuinely skilled, superhuman-ish play; smooth learning curves;
  the thing people mean by "actual machine learning."
- **Cons:** 10x the infra, GPU or big CPU farm, reward hacking hell, needs a fast
  vectorized env, and the on-screen story is less obvious (no neat generations).

### C. The honest recommendation
Build the engine once, then support **pluggable brains** behind one interface:

```ts
interface Brain {
  act(obs: Float32Array): Float32Array;      // obs -> action
  genome(): unknown;                          // serialize for saving
  load(g: unknown): void;
  mutate(rate: number): Brain;
  crossover?(other: Brain): Brain;
}
```

Ship `RandomBrain` -> `ScriptedBrain` (hand-written, gives you a quality bar) ->
`FixedGA` -> `NEAT` -> optionally PPO. Evolution is your "season 1." Deep RL is the
"season 4" upgrade once the show has an audience and you know what looks good.

---

## 3. Simulation core

### 3.1 Loop
```
while running:
  for tick in 0..TICK_RATE:
    for each arena in parallel:
      collect obs for each bot
      brains decide actions          // can be batched: one matmul for ALL bots
      apply actions, integrate physics
      resolve collisions, bullets, damage, deaths
  emit snapshot to renderer / replay log
```
**Batch the brains.** If all bots share a topology, stack their observations into one
matrix `[N_bots, obs_dim]` and do a single forward pass per tick. This is often a 10-100x
speedup in JS/Python and is mandatory for scaling to thousands of bots.

### 3.2 Time model
- Fixed `dt` (e.g. `1/60 s`). Never variable dt. Ever.
- "Thinking" can run slower than physics (e.g. brains act every 3 ticks) — cuts cost and
  makes behavior more human/readable. Tunable per generation, another evolvable gene.
- Training can run N physics ticks per render frame, or pure headless.

### 3.3 Space & physics (keep it dumb)
- 2D top-down. No gravity, no rotation inertia unless you want tank-feel.
- Bots = circles (cheap circle-circle collision) or AABBs.
- Walls = AABB segments; bullets = raycast or short-lived fast-moving points.
- **Bullets:** raycast against walls and bots each tick is both cheaper and more accurate
  than step-physics for tiny fast projectiles. Or model them as 2-3 substeps.
- Optional: destructible tiles (a wall has HP; shooting it carves cover — creates dramatic
  evolving terrain and emergent digging behavior).
- Optional: hazards — lava, spikes, crushing pistons, a slowly shrinking arena.

### 3.4 Observability / sensors (what the bot sees)
Feed a flat normalized `Float32Array`. Keep it small; every extra input is a dimension
evolution must explore.

Baseline obs vector (~40-80 dims):
- self: pos(x,y) normalized, vel(x,y), health, ammo/energy, cooldown, heading sin/cos
- **raycasts**: K rays (e.g. 16) in a fan out to a max range, returning
  `[hit_distance, hit_type(wall/ally/enemy/nothing), hit_health]`. This is the single most
  important sensor. It gives you wall-following and aiming for free.
- nearest enemy: relative vector, distance, its health, whether visible
- nearest pickup: relative vector, distance, type
- team info: nearest ally relative vector, health
- small memory: last-seen enemy relative vector + age (or a GRU/recurrent unit for real
  memory — a big skill jump and a great "they learned to remember!" stream moment)

### 3.5 Actions
- **Discrete grid** (easiest to evolve & explain): `{idle, N, NE, E, SE, S, SW, W, NW}` x
  `{no fire, fire}` = 18 actions. One-hot or small integer output.
- **Continuous** (better kiting/skill): `thrust ∈ [-1,1]^2`, `aim_angle ∈ [-pi,pi]`,
  `fire ∈ [0,1]`, `dash ∈ [0,1]`.
- **Hybrid** (my favorite): move in 8 directions (discrete, readable), but aim is a
  *continuous* relative angle the net outputs, and firing is binary. Aim is where skill
  lives; movement being discrete keeps behavior legible on screen.
- Rotate-then-move bodies make kiting emerge naturally (you must turn to aim, so
  circling strafes appear). Fixed-turret bodies are simpler but produce less drama.

---

## 4. Map generation

**Goal:** diversity for generalization, fairness for evaluation.

- **Algorithm:** grid-based rooms & corridors. Start with a rectangular grid, carve rooms
  (random rects + BSP dungeon), connect with corridors, sprinkle pillars.
  Cheap and reliable.
- **Better:** cellular automata caves or "random walk" for organic shapes.
- **Symmetric variants:** mirror the map 180deg / 4-fold so no spawn is favored. Essential
  for fair head-to-head evaluation.
- **Spawn selection:** farthest-point sampling or mirrored points, never spawn bots in
  line-of-sight of each other at t=0 (instant kills at spawn = noisy fitness).
- **Difficulty knobs:** cover density, corridor width, open-area vs maze, wall HP,
  number of pickups. 
- **Curriculum:** start with open arenas (easy to learn aiming), progressively add cover
  and mazes as generations pass (or let map complexity be a scheduling parameter).
- **Generalization test set:** hold out a few fixed maps, never trained on. If the bot wins
  only on the training maps, it memorized geometry, not tactics. This is your honesty check
  and a great on-screen stat ("Training vs Unseen Map win rate").
- **Seeded:** `mapFromSeed(s)` must be pure. Enables infinite maps, shareable seeds, and
  "viewers pick the seed" as an interaction.

---

## 5. Weapons & combat

Start with exactly one weapon. Add more only when the audience asks.

Baseline: **Machine gun** — hitscan or fast projectile, spread, cooldown, damage, ammo or
energy, slight knockback. Knockback is criminally underrated: it makes hits readable and
creates emergent spacing behavior.

Weapon ideas as evolvable components (a bot *is* its loadout gene):
| Weapon | Character | Emergent behavior |
|---|---|---|
| MG | sustained, forgiving | brawling |
| Shotgun | burst, close range | rush-down, corner ambush |
| Sniper | slow, high damage, tracer | hold angles, long-range duels |
| Laser | instant, low damage, no ammo | constant pressure |
| Rocket | slow projectile, splash, self-damage | zoning, splash prediction |
| Melee/blade | zero range, high damage | charge + bait cooldown |
| Mines | area denial | territorial play, traps |
| Shield/EMP | utility | counterplay, mind games |

Other combat mechanics worth considering:
- **Damage types & resistances** — evolves rock-paper-scissors, but risks cycling. Add
  only with a league/hall-of-fame to prevent it.
- **Pickups:** health, ammo, damage boost, speed boost. Adds a second objective, which
  immediately makes bots prioritize and contest — great emergent drama.
- **Energy/dash:** limited dash creates dodging and mind-games; very watchable.
- **Overheat / reload:** forces rhythm into fights instead of constant fire.
- **Friendly fire:** hugely changes team play. Off = cooperation is easier to evolve.
- **Fog of war:** vision limited to rays + memory -> the classic "hunt the last guy"
  endgame, which is *terrible* to watch if it drags. Solve with a shrinking arena or a
  reveal-after-N-seconds timer.

---

## 6. Learning engine specifics

### 6.1 Population & matchmaking
- Population `N` (start 50-100, scale later).
- **Round-robin** within a generation for small N; **sampled random pairings** for large N.
- **Co-evolution agents:** each bot is a brain; matches are 1v1 (then 2v2, free-for-all).
- **Hall of Fame:** keep the top K genomes of all time as opponents. Prevents regressing
  and prevents cyclic strategy collapse (rock-paper-scissors loops).
- **Elo / TrueSkill:** maintain a rating per genome. Use it for matchmaking, for a
  leaderboard overlay, and as a *secondary* fitness. Elo is also just good television.
- **Fixed evaluation seeds:** all genomes in a generation play the same K maps with the
  same spawns. Otherwise evolution is measuring luck, not skill.

### 6.2 Selection & variation
- Selection: tournament (k=3..7) is the workhorse; truncation is simplest; roulette is
  noisy. Speciation (NEAT) if using NEAT.
- Elitism: copy the top 1-5 genomes unchanged so progress never regresses.
- Mutation: Gaussian weights perturbation with a per-gene or global sigma; small
  probability of "big" mutation for exploration; bias-weight and activation-function
  mutations in NEAT.
- Crossover: uniform or per-neuron crossover. Optional — mutation-only often works fine
  and is less code.
- **Evolvable hyperparameters** alongside weights: mutation rate, hidden size, ticks
  between decisions, weapon preference, aggression bias. Let the algorithm tune itself.

### 6.3 The reward/fitness function — the actual hard part
Fitness must be **dense enough to learn from** but **not gameable**. Start simple, add a
term only when you see a problem.

Baseline:
```
fitness =
    + 10.0 * (kills)
    +  0.6 * (damage_dealt)          // dense, main learning signal
    -  0.8 * (damage_taken)
    +  2.0 * (round_win ? 1 : 0)
    +  0.1 * (survival_ticks_normalized)
    +  0.05 * shots_hit / shots_fired (accuracy)
    -  0.0005 * ticks              // gentle time pressure
```
Anti-degeneracy terms (add these; you will need them):
- **-wall_hug_penalty** — integrate "distance to nearest wall while moving" or penalize
  time spent inside a wall-adjacent band.
- **-idle/turtle penalty** — reward *net displacement per time window*, or require a
  minimum average speed.
- **-spin penalty** — track angular distance traveled vs. displacement? Better: penalize
  *low incoming damage while also dealing zero damage* (i.e. reward participation).
- **accuracy is a ratio — guard against divide-by-zero and against "shoot nothing":**
  count shots fired but require a minimum number of engagements, else the accuracy term is
  zero (not 1.0).
- **Fitness capping** per match to stop a single lucky match from dominating.
- **Opponent-normalized fitness** — score relative to your opponent's score, not absolute.
  This is the single best defense against fitness inflation across generations.

**Critical:** normalize fitness per generation (z-score or min-max) before selection, so
evolution compares within a cohort, not across drift.

### 6.4 Evaluation noise
- Run each genome on **K distinct maps** (K >= 4) and average. Single-map scores are noise.
- Consider **multiple opponents** per genome per generation, not just one.
- Log the standard deviation — if within-genome variance > between-genome variance, your
  evaluation is too noisy and evolution will stall. This is the #1 silent failure.

### 6.5 Deterioration prevention
- Keep hall-of-fame opponents to avoid "forgetting" how to beat earlier strategies.
- Occasionally inject fresh random genomes ("immigrants") to keep diversity.
- Track and report diversity — pairwise genome distance or behavior distance. If it
  collapses to zero, you have a monoculture and progress stops.

### 6.6 Checkpointing & persistence
Save everything; disk is free and streams are long.

```
runs/
  2024-06-01T12-00_battlebot/
    config.json                 # full reproducibility: seed, hyperparams, git sha
    generation_0000.json         # { genomes, fitness[], elo[], stats{} }
    generation_0001.json
    ...
    best_genome.json            # current champion
    halloffame.json             # top-K all-time genomes
    metrics.parquet / .csv      # one row per genome per generation, flat
    replays/
      gen0042_match007.rec      # tick log for highlights
      gen0042_bestmoment.gif
    tensorboard/                # if Python/PyTorch
```
- **Genome format:** plain JSON for small MLPs (human-readable, diffable, shareable);
  `.npy`/binary for big ones. Include a `schema_version`.
- **Replay format:** record only observations + actions + seeds, not raster frames —
  re-simulate to render. Tiny files, perfect scrubbing. (This only works because the sim
  is deterministic. See Section 1.3.)
- **Resume:** training must survive a crash / laptop lid close. Save every generation.
- **Data for graphs:** append one row per genome per generation to a flat file. Never
  parse a thousand JSONs to draw one chart.

---

## 7. Metrics, graphs, dashboards

Graphs are for you and for the serious viewers; the stream needs the *conclusions*
("Accuracy up 3x this generation") more than the plot. Do both.

Metrics worth tracking per generation:
- best / mean / median / worst fitness (always plot median — mean lies)
- fitness standard deviation (evaluation noise)
- Elo of champion, Elo distribution
- win rate vs. hall-of-fame bots
- train-map win rate vs. **held-out** win rate (generalization gap)
- average kills, damage dealt/taken, accuracy, survival time, distance traveled
- average match length (are fights getting faster or more tentative?)
- **behavior metrics** for the story: time spent near walls, time spent moving,
  average engagement distance, shots per kill
- **diversity**: mean pairwise genome distance; number of distinct behavior clusters
- kills per minute of *viewer time* — the entertainment KPI

Visualizations:
- Fitness over generations (best band + median line + min/max shading)
- Elo over time, champion highlighted
- Behavior-space heatmap (**MAP-Elites style grid:** aggression vs. range, colored by
  fitness) — this is a gorgeous, very shareable image and naturally shows strategy diversity
- Win-rate matrix between top genomes (who beats whom) — reveals rock-paper-scissors cycles
- "Skill heatmap" on the map: where bots die, where they spend time, where kills happen
- Match-length and fight-duration histograms over generations

Tooling: keep it boring. Write CSV/JSON, plot with matplotlib/plotly for offline, and a
small live web dashboard (one HTML page + a `/metrics` JSON endpoint, or just Grafana if
you want zero code). A live web dashboard makes a great picture-in-picture on stream.

---

## 8. Nothing is watchable without presentation

This is where most hobby ML projects die, so budget real time for it.

**Camera & pacing**
- Vertical 9:16 framing. The arena must be legible on a phone.
- Camera modes: fixed full-arena (tactical view) + auto-follow (cinematic) + zoom-to-action
  when damage is traded. Cut between them on a schedule or on events.
- **Auto-director:** a small heuristic that picks the most interesting thing happening
  (recent damage, last two bots alive, a kill about to happen) and cuts to it. This is the
  secret to zero-effort streams.
- Slow-motion on the last kill; replay it once from a different zoom, then cut back.
- Time-lapse of a whole round for the "watch it in 5 seconds" loop.

**Story overlays (the actual TikTok/Twitch sauce)**
- Big persistent: `GENERATION 137` and a win-streak / round counter.
- Leaderboard ticker with bot names and Elo, sliding like a sports channel.
- **Kill feed** in a corner (top-right), like an FPS.
- **MVP / highlight card** after each round: name, damage, accuracy, a one-line "story."
- Bot **names and colors**: never render "agent_0042." Name them. Give lineages surnames
  (`Vex-9`, son of `Vex-7`). Colors per lineage so viewers track families.
- **Personality cards**: derived from behavior metrics — "The Camper", "The Berserker",
  "The Sniper", "The Wall-Hugger (RIP)". Assign archetypes by clustering behavior vectors
  and it becomes a *narrative machine*.
- **Screen shake, hit flashes, tracer lines, blood-free particle pops.** Juice sells it.
- **Commentary:** TTS (e.g. a local neural TTS) reading templated lines. Even better: an
  LLM generating trash talk from the stats — "Vex-9 has not landed a shot in four rounds
  and it is, frankly, not looking great." This is the single highest-leverage entertainment
  feature per line of code.
- **Bar/plot race** of Elo over the season — like those population races, but for bots.
- **"Evolution of a bot"** segment: replay gen 1, 50, 200, 500 side by side.

**A concrete 60-second loop to optimize for**
1. 0-5s: "GENERATION 137 — can anyone beat Vex-9?" (hook)
2. 5-15s: fast-forward of the round-robin, kill feed popping
3. 15-40s: the best 1v1 in slow-ish motion with commentary
4. 40-55s: stats card + chunk of the fitness graph ("it learned to aim")
5. 55-60s: tease + CTA ("chat: should I buff shotguns?")

Design the system so this loop can be **generated automatically** and posted without you
touching it. That's the actual product.

---

## 9. Watchability features that also improve learning

Fun and learning are not opposed. Many "show" features are also strong curriculum:
- **Kill cam / slow-mo** — no learning effect, pure retention.
- **Shrinking arena / sudden death** — fixes stalling, teaches urgency.
- **Pickups** — creates contested objectives, teaches prioritization.
- **Team battles** — teaches cooperation, big drama. Start 1v1, then 2v2 with shared
  fitness + a small individual bonus.
- **Tournament brackets** — turns noisy evaluation into a clean narrative and gives every
  generation a "winner" to crown. Take the top 8 of a generation, run a bracket, crown a
  champion. Cheap to implement, huge payoff.
- **Mutators per generation** — every N generations, change a rule (low gravity? double
  damage? fog of war?). Forces generalization and keeps chat engaged ("this week: melee
  only").
- **Boss bot** — the hall-of-fame champion vs. a wave of newbies. Great spectacle, real
  test of generalization.

---

## 10. Viewer interaction — the TikTok/Twitch layer

This is what turns a project into a channel. Design it as an **event bus**, not as
hard-coded chaos.

### 10.1 Architecture
```
TikTok/Twitch chat  -->  ChatAdapter  -->  EventQueue  -->  SandboxWorld
   (gifts, comments)      (normalize)      (rate-limit)     (applies effects)
```
- **Adapters:** `TikTokLiveAdapter` (the `tiktok-live-connector` Node lib, or TikFinity
  as a no-code bridge), `TwitchAdapter` (IRC / EventSub), `FakeAdapter` for testing.
- Never let chat touch the *ranked* population. Route it into a separate
  **"Playground / Sandbox"** world, or apply it as a *cosmetic* mutator to a broadcast-only
  match. Otherwise your training data becomes a measure of chat chaos.
- **Rate limits, queues, and cooldowns** are mandatory. One whale spamming 5000 gifts will
  nuke the sim and the vibes. Bucket actions: at most 1 event per N seconds, weighted by
  gift tier.
- **Voting windows:** "next generation's mutator: A) double ammo B) fog of war C) melee
  only" with a 30s window. Low effort for viewers, high engagement, and it makes them feel
  ownership.

### 10.2 Interaction ideas, cheapest first
| Idea | Effort | Notes |
|---|---|---|
| Chat votes on next mutator | low | Big engagement per line of code |
| `!name Vex-9` names a bot | low | Ownership -> viewers return |
| Chat picks which match to watch next | low | The auto-director asks |
| Predict-the-winner before a round | low | Points/leaderboard |
| Gift spawns a health pack | low | Visible, satisfying |
| Gift drops a hazard / airdrop | low | Spectacle |
| Gift summons a **guest bot** from a template | medium | Viewer's name on a bot |
| "Adopt a lineage" — follow a family tree over generations | medium | Needs names/lineage tracking |
| Chat bets on the outcome, fake currency, seasonal leaderboard | medium | Recurring viewers |
| Chat collectively tunes **one** hyperparameter (mutation rate) | medium | Educational, risky/fun |
| Viewer-supplied genome via a share link (paste weights) | medium | Genuinely cool, niche |
| "Chaos hour": all ranked matches get viewer mutators | high | Sweeps, big spikes |

### 10.3 On-stream "the bots know you're watching"
Small bits of personality go a long way:
- Bots occasionally emit a chat bubble with a templated taunt based on context (low HP ->
  "I'm fine."; missing 40 shots -> "I'm just warming up.").
- LLM-generated post-match interview with the winner, grounded in its stats so it doesn't
  hallucinate nonsense.
- Viewer names appear as "crowd" particles in the background.

### 10.4 Safety and sanity
- Keep everything abstract — colored circles/blobs, no gore, no realistic humans.
- Chat moderation is part of the product; have a blocklist and a mod account from day one.
- Have a **panic button** that mutes input and reverts to the unmodified sim.
- Prefer "viewers change conditions" over "viewers control a bot directly" — direct control
  in a live sim is latency hell and turns the show into a bad game.

---

## 11. Tech stack options

### Option 1 — TypeScript everywhere (recommended for an entertainment-first build)
- **Sim core:** TS, shared between Node (training) and browser (viewer).
- **Training:** Node `worker_threads`, one worker per arena batch. Small MLPs are fast in
  plain TS; no GPU needed for fixed-topology GA.
- **Viewer:** HTML5 Canvas 2D for simple shapes, PixiJS/WebGL if you want thousands of
  particles and CRT-style effects. Vertical layout is trivial.
- **Streaming:** OBS browser source -> your viewer URL. Overlays and the game are the same
  page, or two browser sources composited.
- **Chat:** `tiktok-live-connector` / `twitch` npm packages, straight into the sim's event bus.
- **Pros:** one language, one engine, zero platform drift, trivial OBS integration,
  deterministic replays for free. **This is the fastest path from zero to a watchable show.**
- **Cons:** weaker deep-RL ecosystem; you'd hand-roll or FFI for PPO.

### Option 2 — Python for brains, TS/web for the show
- **Sim core (fast):** Rust or C++ with a Python binding (PyO3 / pybind11), or just
  vectorized NumPy for a simple 2D world.
- **Brains:** PyTorch, Stable-Baselines3 (PPO), NEAT-Python / neat-python, CMA-ES.
- **Viewer:** headless train -> export genomes -> TS viewer loads `best_genome.json` and
  replays.
- **Pros:** the real ML toolbox; real RL possible.
- **Cons:** two engines = drift, must keep the Python and TS physics in *exact* sync, or
  you can't trust replays. Mitigate by having the TS viewer just replay a recorded tick log
  rather than re-simulating.

### Option 3 — Godot / Unity for the show
- Pretty fast to a good-looking 2D scene, strong juice/particles/camera tooling.
- Some awkwardness for headless mass training (though Godot has a headless mode).
- Good if you care more about visuals than about the training loop.

### My pick
**Option 1 for the MVP** (browser-based, TS, Canvas/WebGL, OBS browser source), with the
Brain interface designed so that Option 2 can be bolted on later for PPO. Keep the sim
engine separate from the brain so you can swap "evolution" for "PyTorch policy" without
rewriting the show.

---

## 12. Performance notes

- **Batch inference.** One matmul for all bots, not a loop of per-bot calls. This is the
  biggest single win.
- **Typed arrays everywhere.** `Float32Array` for obs/weights, avoid object allocation in
  the hot loop. No GC in the tick function.
- **Spatial hashing** for collisions/bullet queries once N gets large; until ~200 bots,
  brute force is fine.
- **Object pooling** for bullets and particles.
- **Fixed allocations:** preallocate per-arena buffers, reuse across generations.
- **Parallelism:** arenas are independent -> Web Workers / worker_threads, one arena batch
  per core. Near-linear scaling.
- **Adaptive thinking rate:** cheap bots (or early generations) can think every 5 ticks.
- **Measure:** headless ticks/sec is your primary engineering KPI. Report it on screen —
  "2.3M ticks/sec" is a flex and it explains the pace to viewers.

---

## 13. Failure modes to expect (and pre-empt)

1. **Everything collapses to a monoculture.** Cause: too-strong selection, too-small
   population, no diversity pressure. Fix: larger N, novelty/QD, immigrants, lower
   selection pressure.
2. **Evolution stalls with a flat line.** Cause: evaluation noise > signal. Fix: more maps
   & seeds per genome, opponent-normalized fitness, z-score within generation.
3. **Fitness goes up but gameplay gets worse.** Cause: reward hacking (wall-hugging,
   spinning, farming). Fix: behavior penalties, relative scoring, and *watch the replays* —
   never trust the number alone.
4. **Cyclic meta (A beats B beats C beats A).** Cause: co-evolution without memory.
   Fix: hall of fame, Elo-weighted matchmaking, league play.
5. **Bots memorize maps.** Cause: too few training maps. Fix: procedural maps per
   generation, held-out test set, report the generalization gap.
6. **Fights get slow and tentious.** Cause: survival reward too high, time penalty too low.
   Fix: shrink the arena, add sudden death, raise time pressure, reward damage.
7. **The stream is boring even though training works.** Cause: no presentation, camera on
   the wrong thing, no story. Fix: auto-director, speed-up, commentary, names, brackets.
8. **Sim drifts from replay.** Cause: non-determinism (float non-associativity across
   platforms, `Math.random`, iteration order). Fix: seeded RNG, fixed timestep, replay the
   *tick log* rather than re-simulating across platforms, or use the exact same runtime.
9. **Chat destroys the run.** Cause: unbounded input. Fix: sandbox world + rate limits +
   panic button.

---

## 14. MVP roadmap (boring, in order, each step is shippable)

**Phase 0 — The world (a weekend)**
- Deterministic 2D sim: 2 circles, walls, one bullet type, fixed dt, seeded RNG.
- Headless runner + a Canvas renderer. `RandomBrain`. Watch bots wander and die.
- Success test: same seed => identical replay, twice.

**Phase 1 — A quality bar (a weekend)**
- `ScriptedBrain`: hand-written "move toward enemy, shoot when in range, retreat when low."
- This is your baseline. If evolution can't beat it by gen 50, your fitness is broken.

**Phase 2 — Evolution (a week)**
- Fixed-topology GA: `Float32Array` weights, one MLP, tournament selection, Gaussian
  mutation, elitism.
- Dense fitness: damage dealt/taken, kills, win, accuracy, time pressure.
- Save every generation (genomes + flat metrics CSV). Resume from checkpoint.
- Graphs: fitness band + median over generations. Elo.
- Success test: median fitness visibly rises over ~100 generations and bots stop walking
  into walls.

**Phase 3 — Make it a show (a week)**
- Vertical layout, juice (tracers, hit flashes, screen shake), kill feed, generation
  counter, leaderboard, bot names/colors.
- Auto-director camera + slow-mo on final kill + auto-replay.
- Per-generation tournament bracket, champion card.
- One-click highlight export (GIF/MP4) of the best moment.
- Success test: show a 60-second clip to someone and have them say "wait, what?"

**Phase 4 — Go live (a week)**
- OBS browser source, 24/7 loop, auto-restart on crash, auto-posting clips.
- Chat integration: votes on mutators, `!name`, gift -> health pack. Sandbox world.
- TTS / LLM commentary lines.
- Success test: the stream can run unattended for 8 hours without dying or drifting.

**Phase 5 — Depth (ongoing)**
- NEAT or MAP-Elites for behavioral variety; hall of fame + Elo league.
- Team battles (2v2), pickups, second weapon, destructuring walls.
- Recurrent memory (GRU) — the "they remember where you went" moment.
- Optional: swap evolution for PPO self-play once the pipeline is proven.

**Phase 6 — The meta-game**
- Viewer lineages ("adopt a bot"), seasonal resets with records, betting with fake
  currency, "viewers vs. evolution" chaos hours.

---

## 15. Extra ideas, ranked by (fun / effort)

- **Bot trash talk via templates** — tiny effort, huge personality.
- **Shrinking arena** — tiny effort, fixes stalling, adds urgency.
- **Tournament bracket per generation** — small effort, gives every gen a story.
- **Sleeping/streaming off-hours evolution** — run 8 hours of training overnight, broadcast
  the recap in the morning. You wake up to new behavior. Great content.
- **"Evolve the arena too"** — co-evolve maps against bots (adversarial map generation). A
  map that no bot can win is useless; a map that only the champion can win is gold.
- **Evolve body shape** — radius, speed, HP, weapon as genes. Same code, more emergent
  roles (tanks, glass cannons, scouts).
- **Lineage tree visualization** — a big evolutionary tree with champions highlighted.
  Beautiful, very shareable.
- **Behavior clustering + archetype naming** — k-means on behavior metrics, auto-label
  clusters. Instant narration.
- **Cross-filter: viewers can breed two of their favorite champions** and spawn the child.
- **Betting/prediction with a persistent leaderboard** — recurring-viewer retention.
- **Seasonal resets with hall-of-fame records** — creates "records" that generate content.
- **"Bot autopsy"** — after a match, a UI breakdown of what the loser did wrong. Genuinely
  educational and great for longer-form content.
- **Fitness function visible on screen** — let chat argue about the rules. Meta-drama.
- **The "mutation cam"** — visually show which weights changed after a mutation (heatmap of
  the network). Niche but there's a real audience for "see the brain."
- **Speedrun mode** — how few generations to beat the scripted baseline? A leaderboard for
  hyperparameters. Makes a fun recurring segment.

---

## 16. Open questions to decide before writing too much code

1. **Evolution or deep RL?** (Recommend evolution first, Brain interface for both.)
2. **Browser-first or native?** (Recommend browser-first for streaming ergonomics.)
3. **Head-to-head 1v1 or free-for-all?** (Recommend 1v1 -> 2v2 later; free-for-all is
   chaotic and hard to evaluate.)
4. **How much viewer power?** (Recommend: conditions, not direct control; sandbox only.)
5. **How many bots on screen for the stream?** (Recommend: 2-8 for drama, thousands for
   timelapse flexes.)
6. **What is "winning" for the channel?** Retention loop length? Clips? A ranked ladder of
   bots people adopt? Pick one and design toward it.
7. **Naming/art direction?** Colored geometric blobs with strong silhouettes and lineage
   colors. Abstract = safe, cheap, readable, and stream-friendly.

---

## 17. If I had to write the first 300 lines today

1. `engine/` — `World`, `Bot`, `Bullet`, `Map.gen(seed)`, `step(dt)`. Pure functions, no DOM.
2. `brain/` — `Brain` interface, `RandomBrain`, `MLPBrain` (one hidden layer, forward in
   `Float32Array`), `mutate()`.
3. `train/` — population loop, `evaluate(genome, seed)` -> fitness, selection, checkpoint.
4. `render/` — Canvas draw of a `World` snapshot, with interpolation between ticks.
5. `main.ts` — a mode switch: `--train N` (headless, fast) vs `--watch` (render the current
   champion live).

Everything else in this document hangs off that skeleton.
