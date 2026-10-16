/**
 * Determinism tests.
 *
 * If this file ever fails, replays, highlight clipping and fair evaluation are
 * all lies. Run it after any change to the engine.
 */

import { OBS_SIZE } from '../engine/constants.js';
import { generateMap } from '../engine/map.js';
import { World } from '../engine/world.js';
import { MlpBrain, defaultSizes } from '../brain/mlp.js';
import { Rng } from '../engine/rng.js';
import { ScriptedBrain } from '../brain/simple.js';
import { runMatch } from '../train/match.js';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function runWorlds(seed: number, ticks: number, brains: () => [MlpBrain, MlpBrain]) {
  const map = generateMap(seed, { symmetric: true });
  const [bA, bB] = brains();
  const w = new World(
    map,
    [
      { brain: bA, name: 'A', color: '#fff', id: 0 },
      { brain: bB, name: 'B', color: '#000', id: 1 },
    ],
    { maxTicks: ticks },
  );
  const trail: number[] = [];
  for (let i = 0; i < ticks && !w.over; i++) {
    w.step();
    trail.push(w.bots[0].x, w.bots[0].y, w.bots[1].x, w.bots[1].y, w.bots[0].health, w.bots[1].health);
  }
  return { trail, over: w.over, winner: w.winner, tick: w.tick };
}

function main(): void {
  console.log('determinism');
  const rng = new Rng(99);
  const sizes = defaultSizes(OBS_SIZE);
  const weightsA = MlpBrain.random(sizes, rng).weights.slice();
  const weightsB = MlpBrain.random(sizes, rng).weights.slice();

  const a = runWorlds(12345, 900, () => [
    new MlpBrain(sizes, weightsA.slice()),
    new MlpBrain(sizes, weightsB.slice()),
  ]);
  const b = runWorlds(12345, 900, () => [
    new MlpBrain(sizes, weightsA.slice()),
    new MlpBrain(sizes, weightsB.slice()),
  ]);
  check('identical runs produce identical trajectories', eqTrail(a.trail, b.trail));
  check('identical runs end at the same tick', a.tick === b.tick && a.winner === b.winner);

  const c = runWorlds(54321, 900, () => [
    new MlpBrain(sizes, weightsA.slice()),
    new MlpBrain(sizes, weightsB.slice()),
  ]);
  check('different map seed diverges', !eqTrail(a.trail, c.trail));

  console.log('genome round-trip');
  const brain = MlpBrain.random(sizes, new Rng(7));
  const genome = brain.toGenome({ id: 1, name: 'X-1', elo: 1200, generation: 0 });
  const restored = MlpBrain.fromGenome(JSON.parse(JSON.stringify(genome)));
  check('weights survive JSON round-trip', eqFloats(brain.weights, restored.weights));

  console.log('match reproducibility');
  const mBrainA = MlpBrain.random(sizes, new Rng(3));
  const mBrainB = MlpBrain.random(sizes, new Rng(4));
  const fighterA = { brain: mBrainA.clone(), name: 'A', color: '#fff', id: 0, elo: 1200, generation: 0 };
  const fighterB = { brain: mBrainB.clone(), name: 'B', color: '#000', id: 1, elo: 1200, generation: 0 };
  const r1 = runMatch(fighterA, fighterB, 777);
  const r2 = runMatch(fighterA, fighterB, 777);
  check('same match twice is identical', r1.ticks === r2.ticks && r1.winner === r2.winner);
  check('damage is conserved-ish', r1.stats[0].damageDealt >= 0 && r1.stats[1].damageDealt >= 0);

  console.log('scripted baseline');
  const scriptedA = new ScriptedBrain(1);
  const scriptedB = new ScriptedBrain(1);
  const sr = runMatch(
    { brain: scriptedA, name: 'S1', color: '#fff', id: 0, elo: 1200, generation: 0 },
    { brain: scriptedB, name: 'S2', color: '#000', id: 1, elo: 1200, generation: 0 },
    4242,
    { maxTicks: 2700 },
  );
  check('scripted bots actually fight', sr.stats[0].shotsFired > 10 && sr.stats[1].shotsFired > 10, JSON.stringify({ a: sr.stats[0].shotsFired, b: sr.stats[1].shotsFired }));
  check('scripted bots land hits', sr.stats[0].damageDealt + sr.stats[1].damageDealt > 20, `damage=${sr.stats[0].damageDealt + sr.stats[1].damageDealt}`);
  check('a round always resolves', sr.winner === 0 || sr.winner === 1 || sr.winner === -1);

  console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
  if (failures > 0) process.exit(1);
}

function eqTrail(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

function eqFloats(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

main();
