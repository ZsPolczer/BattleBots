/**
 * The evolutionary loop.
 *
 * Per generation:
 *   1. every genome plays `evalMatches` duels against sampled opponents
 *      (each on its own map seed, so nobody wins on a lucky map),
 *   2. fitness = 50% absolute quality + 50% margin over the opponent,
 *   3. Elo is updated in a batch from the same results,
 *   4. the top genomes survive unchanged, the rest are bred by tournament
 *      selection + uniform crossover + Gaussian mutation,
 *   5. the champion is benchmarked against the scripted baseline and the
 *      best-ever genome on *held-out* maps.
 *
 * Steps 1-3 are the only expensive part and they are a pure function of
 * (population, seeds, generation), which is what makes the whole run resumable.
 */

import { OBS_SIZE } from '../engine/constants.js';
import { Rng, deriveSeed } from '../engine/rng.js';
import { newLineage } from '../engine/names.js';
import { BOT_COLORS } from '../engine/world.js';
import { MlpBrain, defaultSizes } from '../brain/mlp.js';
import { ScriptedBrain } from '../brain/simple.js';
import type { Genome } from '../brain/brain.js';
import { DEFAULT_FITNESS, type FitnessWeights } from './fitness.js';
import { benchmark, eloUpdate, outcomeScore, runMatch, type Fighter } from './match.js';
import { genomeDistance, makeIndividual, fromGenome, type Individual } from './individual.js';
import type { BotStats } from '../engine/types.js';
import * as ckpt from './checkpoint.js';
import { metricsRow, printGen, printGenHeader, type GenMetrics } from './metrics.js';

export interface TrainConfig {
  runId: string;
  seed: number;
  population: number;
  generations: number;
  elite: number;
  tournamentK: number;
  crossoverRate: number;
  mutationRate: number;
  mutationSigma: number;
  hidden: number[];
  evalMatches: number;
  testMatches: number;
  maxTicks: number;
  pickups: boolean;
  hallOfFameSize: number;
  checkpointEvery: number;
  keepCheckpoints: number;
  trainSeedCount: number;
  testSeedCount: number;
  benchmarkScripted: boolean;
  /**
   * Diversity pressure. Each genome gets a bonus for being unusual relative to
   * the rest of the population (subtracting the generation mean keeps it
   * zero-sum, so it cannot inflate fitness across generations). Without this a
   * population converges into a monoculture within ~15 generations and progress
   * stalls.
   */
  /**
   * Probability that a genome is matched against the hand-written baseline
   * instead of another genome. Putting the scripted bot directly into the
   * opponent pool is what turns "beats its peers" into "is actually good":
   * without it, the benchmark is reported but never selected for.
   */
  scriptedShare: number;
  noveltyWeight: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  runId: '',
  seed: 1337,
  population: 60,
  generations: 200,
  elite: 4,
  tournamentK: 3,
  crossoverRate: 0.65,
  mutationRate: 0.1,
  mutationSigma: 0.08,
  hidden: [48, 32],
  evalMatches: 4,
  testMatches: 6,
  maxTicks: 2100,
  pickups: true,
  hallOfFameSize: 12,
  checkpointEvery: 10,
  keepCheckpoints: 6,
  trainSeedCount: 48,
  testSeedCount: 16,
  benchmarkScripted: true,
  scriptedShare: 0.3,
  noveltyWeight: 12,
};

/**
 * Rating anchor for the hand-written baseline. Beating it must move Elo, or the
 * leaderboard (and therefore the broadcast champion) only ever measures
 * intra-population strength.
 */
export const SCRIPTED_ELO = 1300;

interface PendingMatch {
  a: number;
  b: number; // -1 when the opponent is not a population member
  opp: Individual | null;
  scripted: boolean;
  scoreA: number;
  scoreB: number;
  winner: number;
  ticks: number;
  stats: [BotStats, BotStats];
}

type Opponent =
  | { kind: 'pop'; index: number }
  | { kind: 'hof'; ind: Individual }
  | { kind: 'scripted' };

export class Evolver {
  readonly cfg: TrainConfig;
  readonly outDir: string;
  readonly rng: Rng;

  pop: Individual[] = [];
  hallOfFame: Individual[] = [];
  bestEver: Individual | null = null;
  generation = 0;
  history: GenMetrics[] = [];

  private readonly trainSeeds: number[];
  private readonly testSeeds: number[];
  private readonly fit: FitnessWeights = DEFAULT_FITNESS;
  private readonly csv: ckpt.CsvWriter;
  private readonly surnameCounters = new Map<string, number>();
  private nextId = 1;
  private lastPrint = 0;
  private startedAt = 0;
  private lastAvgTicks = 0;

  constructor(cfg: TrainConfig, outDir: string) {
    this.cfg = cfg;
    this.outDir = outDir;
    this.rng = new Rng(cfg.seed);
    this.trainSeeds = Array.from({ length: cfg.trainSeedCount }, (_, i) =>
      deriveSeed(cfg.seed, i + 1),
    );
    this.testSeeds = Array.from({ length: cfg.testSeedCount }, (_, i) =>
      deriveSeed(cfg.seed ^ 0x1234abcd, i + 0x1000),
    );
    ckpt.ensureDir(outDir);
    this.csv = new ckpt.CsvWriter(`${outDir}/metrics.csv`);
    ckpt.writeJson(`${outDir}/config.json`, cfg);
  }

  // ------------------------------------------------------------- setup

  initPopulation(): void {
    const sizes = defaultSizes(OBS_SIZE, this.cfg.hidden);
    for (let i = 0; i < this.cfg.population; i++) {
      const lineage = newLineage(this.rng);
      this.pop.push(
        makeIndividual({
          brain: MlpBrain.random(sizes, this.rng, this.cfg.mutationRate, this.cfg.mutationSigma),
          id: this.nextId++,
          name: this.nextName(lineage.surname),
          surname: lineage.surname,
          generation: 0,
        }),
      );
    }
  }

  /** Resume from the newest population checkpoint, if one exists. */
  resume(): boolean {
    const popFile = ckpt.latestPopulationFile(this.outDir);
    if (!popFile) return false;
    const data = ckpt.readJsonGz<{ generation: number; genomes: Genome[] }>(popFile);
    if (!data) return false;
    this.pop = data.genomes.map((g) => fromGenome(g));
    this.generation = data.generation;
    this.nextId = Math.max(...this.pop.map((p) => p.id)) + 1;
    for (const p of this.pop) {
      const n = Number(p.name.split('-')[1] ?? 1);
      const cur = this.surnameCounters.get(p.surname) ?? 0;
      if (n > cur) this.surnameCounters.set(p.surname, n);
    }
    this.hallOfFame = ckpt.loadHallOfFame(this.outDir);
    return true;
  }

  private nextName(surname: string): string {
    const n = (this.surnameCounters.get(surname) ?? 0) + 1;
    this.surnameCounters.set(surname, n);
    return `${surname}-${n}`;
  }

  private fighter(ind: Individual): Fighter {
    return {
      brain: ind.brain,
      name: ind.name,
      color: BOT_COLORS[ind.id % BOT_COLORS.length],
      id: ind.id,
      elo: ind.elo,
      generation: ind.generation,
    };
  }

  // ------------------------------------------------------- evaluation

  private scriptedFighter(): Fighter {
    return {
      brain: new ScriptedBrain(this.rng.int(1, 0x7fffffff)),
      name: 'SCRIPTED',
      color: '#888888',
      id: 98,
      elo: 1300,
      generation: 0,
    };
  }

  private pickOpponents(i: number): Opponent[] {
    const n = this.pop.length;
    const out: Opponent[] = [];
    const used = new Set<number>([i]);
    const want = Math.max(1, Math.min(this.cfg.evalMatches, Math.max(1, n - 1)));

    if (this.cfg.scriptedShare > 0 && this.rng.chance(this.cfg.scriptedShare)) {
      out.push({ kind: 'scripted' });
    }

    let guard = 0;
    while (out.length < want && guard++ < 400) {
      if (this.hallOfFame.length > 0 && this.rng.chance(0.3)) {
        out.push({
          kind: 'hof',
          ind: this.hallOfFame[this.rng.int(0, this.hallOfFame.length - 1)],
        });
        continue;
      }
      const j = this.rng.int(0, n - 1);
      if (used.has(j)) continue;
      used.add(j);
      out.push({ kind: 'pop', index: j });
    }
    return out;
  }

  private evaluateGeneration(): void {
    const pop = this.pop;
    const n = pop.length;
    const matches: PendingMatch[] = [];

    for (let i = 0; i < n; i++) {
      const ind = pop[i];
      ind.fitness = 0;
      ind.wins = 0;
      ind.losses = 0;
      ind.draws = 0;
      ind.matches = 0;
      ind.avgAccuracy = 0;
      ind.avgDamage = 0;
      ind.avgKills = 0;
      ind.avgWallHug = 0;
      ind.avgSurvival = 0;

      const opponents = this.pickOpponents(i);
      const self = this.fighter(ind);

      for (let m = 0; m < opponents.length; m++) {
        const opp = opponents[m];
        let bIndex = -1;
        let oppInd: Individual | null = null;
        let scripted = false;
        let opponentFighter: Fighter;
        if (opp.kind === 'pop') {
          bIndex = opp.index;
          opponentFighter = this.fighter(pop[opp.index]);
        } else if (opp.kind === 'hof') {
          oppInd = opp.ind;
          opponentFighter = this.fighter(opp.ind);
        } else {
          scripted = true;
          opponentFighter = this.scriptedFighter();
        }

        const seed = this.trainSeeds[(i * 31 + m * 17 + this.generation * 7) % this.trainSeeds.length];
        const res = runMatch(self, opponentFighter, seed, {
          maxTicks: this.cfg.maxTicks,
          pickups: this.cfg.pickups,
          fitness: this.fit,
        });
        matches.push({
          a: i,
          b: bIndex,
          opp: oppInd,
          scripted,
          scoreA: res.scores[0],
          scoreB: res.scores[1],
          winner: res.winner,
          ticks: res.ticks,
          stats: res.stats,
        });
      }
    }

    const { abs, rel } = this.fit;
    let totalTicks = 0;

    // --- fitness + behaviour aggregation ---------------------------------
    for (const m of matches) {
      totalTicks += m.ticks;
      const A = pop[m.a];
      const B = m.scripted ? null : (m.opp ?? pop[m.b]);
      A.fitness += abs * m.scoreA + rel * (m.scoreA - m.scoreB);
      A.matches++;
      if (m.winner === 0) A.wins++;
      else if (m.winner === 1) A.losses++;
      else A.draws++;

      const sa = m.stats[0];
      A.avgAccuracy += sa.shotsFired >= 5 ? sa.shotsHit / sa.shotsFired : 0;
      A.avgDamage += sa.damageDealt;
      A.avgKills += sa.kills;
      A.avgWallHug += sa.wallHugTicks / Math.max(1, sa.ticksAlive);
      A.avgSurvival += sa.ticksAlive / this.cfg.maxTicks;

      if (B) {
        B.fitness += abs * m.scoreB + rel * (m.scoreB - m.scoreA);
        B.matches++;
        if (m.winner === 1) B.wins++;
        else if (m.winner === 0) B.losses++;
        else B.draws++;
        const sb = m.stats[1];
        B.avgAccuracy += sb.shotsFired >= 5 ? sb.shotsHit / sb.shotsFired : 0;
        B.avgDamage += sb.damageDealt;
        B.avgKills += sb.kills;
        B.avgWallHug += sb.wallHugTicks / Math.max(1, sb.ticksAlive);
        B.avgSurvival += sb.ticksAlive / this.cfg.maxTicks;
      }
    }

    this.lastAvgTicks = matches.length > 0 ? totalTicks / matches.length : 0;

    for (const ind of pop) {
      const c = Math.max(1, ind.matches);
      ind.fitness /= c;
      ind.avgAccuracy /= c;
      ind.avgDamage /= c;
      ind.avgKills /= c;
      ind.avgWallHug /= c;
      ind.avgSurvival /= c;
    }
    for (const h of this.hallOfFame) {
      const c = Math.max(1, h.matches);
      if (h.matches > 0) {
        h.fitness /= c;
        h.avgAccuracy /= c;
        h.avgDamage /= c;
        h.avgKills /= c;
        h.avgWallHug /= c;
        h.avgSurvival /= c;
      }
    }

    this.applyNovelty();

    // --- Elo batch ---------------------------------------------------------
    // The scripted baseline is a fixed rating anchor. Without it, beating the
    // hand-written bot earns nothing, Elo only measures intra-population
    // strength, and the "champion" becomes whoever camps best against its
    // peers rather than whoever actually fights well.
    const eloA = pop.map((p) => p.elo);
    const eloHof = this.hallOfFame.map((h) => h.elo);
    const nextA = eloA.slice();
    const nextHof = eloHof.slice();
    for (const m of matches) {
      const outcome = outcomeScore(m.winner, 0);
      if (m.scripted) {
        nextA[m.a] = eloUpdate(nextA[m.a], SCRIPTED_ELO, outcome).a;
        continue;
      }
      if (m.opp) {
        const hi = this.hallOfFame.indexOf(m.opp);
        if (hi >= 0) {
          const out = eloUpdate(nextA[m.a], nextHof[hi], outcome);
          nextA[m.a] = out.a;
          nextHof[hi] = out.b;
        }
      } else if (m.b >= 0) {
        const out = eloUpdate(eloA[m.a], eloA[m.b], outcome);
        nextA[m.a] = out.a;
        nextA[m.b] = out.b;
      }
    }
    for (let i = 0; i < pop.length; i++) pop[i].elo = nextA[i];
    for (let i = 0; i < this.hallOfFame.length; i++) this.hallOfFame[i].elo = nextHof[i];
  }

  /**
   * Behavioural diversity pressure: reward genomes that are unlike the rest of
   * the population. This is the cheapest cure for the monoculture collapse that
   * otherwise stops evolution after a couple of dozen generations.
   */
  private applyNovelty(): void {
    const weight = this.cfg.noveltyWeight;
    if (!weight || weight <= 0) return;
    const n = this.pop.length;
    if (n < 3) return;
    const samples = 5;
    const dists = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < samples; k++) {
        let j = this.rng.int(0, n - 1);
        if (j === i) j = (j + 1) % n;
        sum += genomeDistance(this.pop[i].brain, this.pop[j].brain);
      }
      dists[i] = sum / samples;
    }
    const mean = dists.reduce((a, b) => a + b, 0) / n;
    for (let i = 0; i < n; i++) {
      this.pop[i].fitness += weight * (dists[i] - mean);
    }
  }

  // ---------------------------------------------------------- selection

  private champion(): Individual {
    let best = this.pop[0];
    for (const ind of this.pop) {
      if (ind.elo > best.elo) best = ind;
    }
    return best;
  }

  private updateHallOfFame(): void {
    const candidates = [...this.hallOfFame, ...this.pop];
    const seen = new Map<string, Individual>();
    for (const c of candidates) {
      const prev = seen.get(c.name);
      if (!prev || c.elo > prev.elo) seen.set(c.name, c);
    }
    const sorted = [...seen.values()].sort((a, b) => b.elo - a.elo);
    this.hallOfFame = sorted.slice(0, this.cfg.hallOfFameSize);
    // Keep behaviour averages sane for reused entries.
    for (const h of this.hallOfFame) h.matches = 0;
  }

  private tournament(): Individual {
    let best: Individual | null = null;
    for (let i = 0; i < this.cfg.tournamentK; i++) {
      const c = this.pop[this.rng.int(0, this.pop.length - 1)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best!;
  }

  private reproduce(): void {
    const sorted = [...this.pop].sort((a, b) => b.fitness - a.fitness);
    const next: Individual[] = [];
    const elites = Math.min(this.cfg.elite, sorted.length);
    for (let i = 0; i < elites; i++) next.push(sorted[i]);

    while (next.length < this.cfg.population) {
      const parentA = this.tournament();
      let childBrain: MlpBrain;
      if (this.rng.chance(this.cfg.crossoverRate)) {
        const second = this.tournament();
        childBrain = MlpBrain.crossover(parentA.brain, second.brain, this.rng);
      } else {
        childBrain = parentA.brain.clone();
      }
      // Self-adaptive mutation: the step size evolves along with the weights.
      childBrain.mutationRate = clamp(
        parentA.brain.mutationRate * Math.exp(this.rng.gauss() * 0.25),
        0.01,
        0.6,
      );
      childBrain.mutationSigma = clamp(
        parentA.brain.mutationSigma * Math.exp(this.rng.gauss() * 0.25),
        0.005,
        0.4,
      );
      childBrain.mutate(this.rng);

      next.push(
        makeIndividual({
          brain: childBrain,
          id: this.nextId++,
          name: this.nextName(parentA.surname),
          surname: parentA.surname,
          generation: this.generation,
          parent: parentA.name,
          elo: parentA.elo,
        }),
      );
    }
    this.pop = next;
  }

  // ------------------------------------------------------------ metrics

  private diversity(): number {
    const n = this.pop.length;
    if (n < 2) return 0;
    const pairs = Math.min(180, (n * (n - 1)) / 2);
    let sum = 0;
    for (let i = 0; i < pairs; i++) {
      const a = this.rng.int(0, n - 1);
      let b = this.rng.int(0, n - 1);
      if (b === a) b = (b + 1) % n;
      sum += genomeDistance(this.pop[a].brain, this.pop[b].brain);
    }
    return sum / pairs;
  }

  private compileMetrics(elapsedMs: number): GenMetrics {
    const fits = this.pop.map((p) => p.fitness).sort((a, b) => a - b);
    const n = fits.length;
    const mean = fits.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 === 1 ? fits[(n - 1) / 2] : (fits[n / 2 - 1] + fits[n / 2]) / 2;
    const variance = fits.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const elos = this.pop.map((p) => p.elo);
    const champ = this.champion();

    const matches = this.pop.reduce((a, p) => a + p.matches, 0);
    const wAvg = (sel: (p: Individual) => number) =>
      this.pop.reduce((a, p) => a + sel(p) * p.matches, 0) / Math.max(1, matches);

    return {
      generation: this.generation,
      best: fits[n - 1],
      mean,
      median,
      worst: fits[0],
      std: Math.sqrt(variance),
      diversity: this.diversity(),
      bestElo: champ.elo,
      meanElo: elos.reduce((a, b) => a + b, 0) / n,
      accuracy: wAvg((p) => p.avgAccuracy),
      kills: wAvg((p) => p.avgKills),
      damage: wAvg((p) => p.avgDamage),
      ticks: this.lastAvgTicks,
      wallHug: wAvg((p) => p.avgWallHug),
      mobility: wAvg((p) => p.avgSurvival),
      winVsScripted: NaN,
      winVsBest: NaN,
      weights: champ.brain.weightCount,
      elapsedMs,
      gensPerHour: elapsedMs > 0 ? 3600000 / elapsedMs : 0,
    };
  }

  private benchmarkChampion(): { vsScripted: number; vsBest: number } {
    const champ = this.champion();
    let vsScripted = NaN;
    if (this.cfg.benchmarkScripted) {
      const scripted: Fighter = {
        brain: new ScriptedBrain(7),
        name: 'Scripted',
        color: '#888888',
        id: 99,
        elo: 1200,
        generation: 0,
      };
      vsScripted = benchmark(this.fighter(champ), scripted, this.testSeeds, {
        maxTicks: this.cfg.maxTicks,
        pickups: this.cfg.pickups,
      }).winRate;
    }
    let vsBest = NaN;
    if (this.bestEver && this.bestEver !== champ) {
      vsBest = benchmark(this.fighter(champ), this.fighter(this.bestEver), this.testSeeds, {
        maxTicks: this.cfg.maxTicks,
        pickups: this.cfg.pickups,
      }).winRate;
    }
    return { vsScripted, vsBest };
  }

  // --------------------------------------------------------------- loop

  async run(onGeneration?: (m: GenMetrics) => void): Promise<GenMetrics[]> {
    this.startedAt = Date.now();
    if (this.pop.length === 0) this.initPopulation();
    printGenHeader();

    for (let g = this.generation + 1; g <= this.cfg.generations; g++) {
      const t0 = Date.now();
      this.generation = g;
      this.evaluateGeneration();

      const bench = this.benchmarkChampion();
      const metrics = this.compileMetrics(Date.now() - t0);
      metrics.winVsScripted = bench.vsScripted;
      metrics.winVsBest = bench.vsBest;
      this.history.push(metrics);

      const champ = this.champion();
      if (!this.bestEver || champ.elo > this.bestEver.elo) this.bestEver = champ;
      this.updateHallOfFame();
      this.pop.forEach((p) => (p.generation = g));

      ckpt.saveChampion(this.outDir, champ, g);
      ckpt.saveHallOfFame(this.outDir, this.hallOfFame);
      if (g % this.cfg.checkpointEvery === 0) {
        ckpt.savePopulation(this.outDir, g, this.pop);
        ckpt.prunePopulationDir(this.outDir, this.cfg.keepCheckpoints);
      }
      this.csv.append(metricsRow(metrics));
      ckpt.writeJson(`${this.outDir}/state.json`, {
        generation: g,
        population: this.cfg.population,
        generations: this.cfg.generations,
        bestElo: Math.round(champ.elo),
        champion: champ.name,
        history: this.history.slice(-240),
        updatedAt: Date.now(),
      });

      printGen(metrics);
      onGeneration?.(metrics);
      this.reproduce();

      await yieldToEventLoop();
    }
    return this.history;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
