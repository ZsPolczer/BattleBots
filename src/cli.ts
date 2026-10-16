#!/usr/bin/env node
/**
 * BattleBot CLI.
 *
 *   battlebot train    headless evolution, writes runs/<id>/
 *   battlebot serve    broadcast a run as a king-of-the-hill stream
 *   battlebot show     both at once: train in a worker, broadcast on the main thread
 *   battlebot bench    score a run's champion against the scripted baseline
 *   battlebot test     determinism / sanity suite
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRAIN_CONFIG, Evolver, type TrainConfig } from './train/evolve.js';
import { printSummary, type GenMetrics } from './train/metrics.js';
import { startServer } from './server/server.js';
import { ensureDir, loadChampion, loadHallOfFame } from './train/checkpoint.js';
import { fromGenome } from './train/individual.js';
import { runMatch, type Fighter } from './train/match.js';
import { ScriptedBrain } from './brain/simple.js';
import { newRunId, resolveRunDir, runsRoot } from './runs.js';
import { OBS_SIZE } from './engine/constants.js';
import { deriveSeed } from './engine/rng.js';
type Flags = Map<string, string | boolean>;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = new Map();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function num(flags: Flags, key: string, def: number): number {
  const v = flags.get(key);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(flags: Flags, key: string, def: string): string {
  const v = flags.get(key);
  return typeof v === 'string' ? v : def;
}

function bool(flags: Flags, key: string, def = false): boolean {
  const v = flags.get(key);
  if (v === undefined) return def;
  return v !== 'false' && v !== '0';
}

function buildConfig(flags: Flags, runId: string): TrainConfig {
  const hidden = str(flags, 'hidden', '48,32')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    ...DEFAULT_TRAIN_CONFIG,
    runId,
    seed: num(flags, 'seed', DEFAULT_TRAIN_CONFIG.seed),
    population: num(flags, 'population', DEFAULT_TRAIN_CONFIG.population),
    generations: num(flags, 'generations', DEFAULT_TRAIN_CONFIG.generations),
    elite: num(flags, 'elite', DEFAULT_TRAIN_CONFIG.elite),
    tournamentK: num(flags, 'tournament', DEFAULT_TRAIN_CONFIG.tournamentK),
    crossoverRate: num(flags, 'crossover', DEFAULT_TRAIN_CONFIG.crossoverRate),
    mutationRate: num(flags, 'mutation-rate', DEFAULT_TRAIN_CONFIG.mutationRate),
    mutationSigma: num(flags, 'mutation-sigma', DEFAULT_TRAIN_CONFIG.mutationSigma),
    hidden: hidden.length > 0 ? hidden : DEFAULT_TRAIN_CONFIG.hidden,
    evalMatches: num(flags, 'eval-matches', DEFAULT_TRAIN_CONFIG.evalMatches),
    testMatches: num(flags, 'test-matches', DEFAULT_TRAIN_CONFIG.testMatches),
    maxTicks: num(flags, 'max-ticks', DEFAULT_TRAIN_CONFIG.maxTicks),
    pickups: !flags.has('no-pickups'),
    hallOfFameSize: num(flags, 'hall-of-fame', DEFAULT_TRAIN_CONFIG.hallOfFameSize),
    checkpointEvery: num(flags, 'checkpoint-every', DEFAULT_TRAIN_CONFIG.checkpointEvery),
    keepCheckpoints: num(flags, 'keep-checkpoints', DEFAULT_TRAIN_CONFIG.keepCheckpoints),
    trainSeedCount: num(flags, 'train-seeds', DEFAULT_TRAIN_CONFIG.trainSeedCount),
    testSeedCount: num(flags, 'test-seeds', DEFAULT_TRAIN_CONFIG.testSeedCount),
    benchmarkScripted: !flags.has('no-benchmark'),
  };
}

function makeOutDir(flags: Flags, cfg: TrainConfig): string {
  const explicit = str(flags, 'out', '');
  if (explicit) return path.resolve(process.cwd(), explicit);
  const dir = path.join(runsRoot(), newRunId(cfg.seed));
  ensureDir(dir);
  return dir;
}

async function cmdTrain(flags: Flags): Promise<void> {
  const runId = newRunId(num(flags, 'seed', DEFAULT_TRAIN_CONFIG.seed));
  const cfg = buildConfig(flags, runId);
  const outDir = makeOutDir(flags, cfg);
  console.log(`run directory: ${outDir}`);

  const evolver = new Evolver(cfg, outDir);
  if (bool(flags, 'resume') && evolver.resume()) {
    console.log(`resumed from generation ${evolver.generation}`);
  }
  const history = await evolver.run();
  printSummary(history);
}

function cmdServe(flags: Flags): void {
  const run = str(flags, 'run', '');
  const runDir = resolveRunDir(run || undefined);
  if (!runDir) {
    console.log('no run found in runs/ — broadcasting random genomes.');
    console.log('start one with:  npm run train');
  }
  const server = startServer({
    port: num(flags, 'port', 8787),
    host: str(flags, 'host', '127.0.0.1'),
    speed: num(flags, 'speed', 1),
    runDir,
    maxSeconds: num(flags, 'round-seconds', 32),
  });
  const shutdown = () => {
    console.log('\nshutting down');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdShow(flags: Flags): void {
  const seed = num(flags, 'seed', DEFAULT_TRAIN_CONFIG.seed);
  const runId = newRunId(seed);
  const cfg = buildConfig(flags, runId);
  const outDir = makeOutDir(flags, cfg);

  const server = startServer({
    port: num(flags, 'port', 8787),
    host: str(flags, 'host', '127.0.0.1'),
    speed: num(flags, 'speed', 1),
    runDir: outDir,
    maxSeconds: num(flags, 'round-seconds', 32),
  });

  const workerPath = fileURLToPath(new URL('./train/worker.js', import.meta.url));
  const worker = new Worker(workerPath, {
    workerData: { cfg, outDir, resume: bool(flags, 'resume') },
  });
  let history: GenMetrics[] = [];
  worker.on('message', (msg: { type: string; history?: GenMetrics[]; message?: string }) => {
    if (msg.type === 'done' && msg.history) {
      history = msg.history;
      printSummary(history);
      console.log('\ntraining finished. the broadcast keeps running on the current champion.');
      console.log('press Ctrl+C to stop.');
    } else if (msg.type === 'error') {
      console.error('training worker failed:\n' + msg.message);
    }
  });
  worker.on('error', (err) => console.error('worker error', err));
  worker.unref();

  const shutdown = () => {
    console.log('\nshutting down');
    void worker.terminate();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdBench(flags: Flags): void {
  const runDir = resolveRunDir(str(flags, 'run', '') || undefined);
  if (!runDir) {
    console.error('no run found — train something first');
    process.exit(1);
  }
  const champion = loadChampion(runDir);
  if (!champion) {
    console.error(`no champion in ${runDir}`);
    process.exit(1);
  }
  const ind = fromGenome(champion.genome);
  const tests = num(flags, 'matches', 30);
  const maxTicks = num(flags, 'max-ticks', 2100);
  const seeds = Array.from({ length: tests }, (_, i) => deriveSeed(31337, i + 1));
  const hof = loadHallOfFame(runDir);

  // Who to fight: the scripted baseline (default), or a named hall-of-famer.
  const vs = str(flags, 'vs', 'scripted');
  let makeOpponent: () => Fighter;
  let opponentName: string;
  if (vs === 'scripted' || vs === 'ai') {
    opponentName = 'ScriptedBrain (hand-written baseline)';
    makeOpponent = () => ({
      brain: new ScriptedBrain(7),
      name: 'Scripted',
      color: '#888888',
      id: 1,
      elo: 1200,
      generation: 0,
    });
  } else {
    const target = hof.find((h) => h.name.toLowerCase() === vs.toLowerCase()) ?? hof[0];
    if (!target) {
      console.error(`no opponent called "${vs}" in the hall of fame`);
      process.exit(1);
    }
    opponentName = `${target.name} (elo ${Math.round(target.elo)}, gen ${target.generation})`;
    makeOpponent = () => ({
      brain: target.brain,
      name: target.name,
      color: '#888888',
      id: 1,
      elo: target.elo,
      generation: target.generation,
    });
  }

  const challenger: Fighter = {
    brain: ind.brain,
    name: ind.name,
    color: '#ff4d6d',
    id: 0,
    elo: ind.elo,
    generation: champion.generation,
  };

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let dmgDealt = 0;
  let dmgTaken = 0;
  let shots = 0;
  let hits = 0;
  let ticks = 0;
  let byKill = 0;
  let byTimeout = 0;

  for (const seed of seeds) {
    const r = runMatch(challenger, makeOpponent(), seed, { maxTicks });
    if (r.winner === 0) wins++;
    else if (r.winner === 1) losses++;
    else draws++;
    const s = r.stats[0];
    dmgDealt += s.damageDealt;
    dmgTaken += s.damageTaken;
    shots += s.shotsFired;
    hits += s.shotsHit;
    ticks += r.ticks;
    if (r.ticks >= maxTicks) byTimeout++;
    else byKill++;
  }

  const n = seeds.length;
  const f1 = (v: number) => v.toFixed(1);
  console.log('');
  console.log(`champion   ${ind.name}  (gen ${champion.generation}, elo ${Math.round(ind.elo)})`);
  console.log(
    `network    obs ${ind.brain.sizes[0]} -> hidden [${ind.brain.sizes.slice(1, -1)}] -> ${ind.brain.sizes[ind.brain.sizes.length - 1]} outputs, ${ind.brain.weightCount} weights`,
  );
  console.log(`opponent   ${opponentName}`);
  console.log('');
  console.log(
    `record     ${wins}W ${losses}L ${draws}D   win rate ${((wins / n) * 100).toFixed(1)}%  (n=${n})`,
  );
  console.log(`damage     dealt ${f1(dmgDealt / n)}   taken ${f1(dmgTaken / n)}`);
  console.log(`accuracy   ${((hits / Math.max(1, shots)) * 100).toFixed(1)}%  (${hits}/${shots} shots)`);
  console.log(`rounds     ${(ticks / n).toFixed(0)} ticks (${(ticks / n / 60).toFixed(1)}s) average`);
  console.log(`endings    ${byKill} by kill, ${byTimeout} on time`);
  console.log('');
}

function usage(): void {
  console.log(`battlebot — evolving 2D duelists

  battlebot train [options]        evolve a population, write runs/<id>/
  battlebot serve [options]        broadcast a run as a live stream
  battlebot show  [options]        train in a worker + broadcast at the same time
  battlebot bench [options]        score a champion against a reference opponent

training options
  --population N     genomes per generation            (60)
  --generations N    how many generations to run       (200)
  --seed N           master seed                       (1337)
  --out DIR          run directory                     (runs/<timestamp>)
  --resume           continue the newest checkpoint in --out
  --hidden 48,32     hidden layer sizes
  --eval-matches N   duels per genome per generation   (4)
  --elite N          genomes copied unchanged          (4)
  --tournament N     tournament selection size         (4)
  --crossover F      crossover probability             (0.65)
  --mutation-rate F  per-weight mutation probability   (0.12)
  --mutation-sigma F Gaussian mutation step size       (0.22)
  --max-ticks N      round length cap in ticks         (2700, 45s)
  --no-pickups       disable health/ammo pickups
  --no-benchmark     skip the vs-scripted benchmark

broadcast options
  --port N           http port                         (8787)
  --host ADDR        bind address                      (127.0.0.1)
  --speed F          simulation speed multiplier       (1)
  --run DIR          run to broadcast                  (newest in runs/)
  --round-seconds N  round length cap in seconds       (32)

bench options
  --run DIR          run to inspect                   (newest in runs/)
  --vs NAME          'scripted' (default) or a hall-of-fame bot's name
  --matches N        how many held-out maps to play    (30)

open http://127.0.0.1:8787 for the stream and /dashboard for the graphs.`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  switch (cmd) {
    case 'train':
      await cmdTrain(flags);
      break;
    case 'serve':
      cmdServe(flags);
      break;
    case 'show':
      cmdShow(flags);
      break;
    case 'bench':
      cmdBench(flags);
      break;
    case 'test':
      await import('./test/determinism.js');
      break;
    case 'version':
      console.log('battlebot 0.1.0');
      break;
    case 'help':
    default:
      usage();
      break;
  }
}

void main();
