/**
 * Training worker.
 *
 * Runs the evolutionary loop off the main thread so the broadcast keeps a
 * smooth 60Hz while evolution churns in the background. This is the same
 * decoupling the design calls for: the lab and the show never block each other.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { Evolver, type TrainConfig } from './evolve.js';

interface WorkerInput {
  cfg: TrainConfig;
  outDir: string;
  resume: boolean;
}

const input = workerData as WorkerInput;
const evolver = new Evolver(input.cfg, input.outDir);
if (input.resume && evolver.resume()) {
  console.log(`resumed from generation ${evolver.generation}`);
}
evolver
  .run((m) => {
    parentPort?.postMessage({
      type: 'gen',
      generation: m.generation,
      bestElo: m.bestElo,
      winVsScripted: m.winVsScripted,
      best: m.best,
    });
  })
  .then((history) => {
    parentPort?.postMessage({ type: 'done', history });
  })
  .catch((err) => {
    parentPort?.postMessage({ type: 'error', message: String(err?.stack ?? err) });
    process.exitCode = 1;
  });
