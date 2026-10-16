/**
 * The broadcast.
 *
 * Turns a training run into a continuous king-of-the-hill show: the current
 * champion defends against challengers drawn from the hall of fame. Whenever
 * training writes a better champion, it walks in and takes the belt.
 *
 * A short intermission after every round is not a detail — it is what makes the
 * result readable at a glance.
 */

import { OBS_SIZE, TICK_RATE } from '../engine/constants.js';
import { GameMap, generateMap } from '../engine/map.js';
import type { MapData, Snapshot, WorldEvent } from '../engine/types.js';
import { World } from '../engine/world.js';
import { Rng } from '../engine/rng.js';
import { ScriptedBrain } from '../brain/simple.js';
import { MlpBrain, defaultSizes } from '../brain/mlp.js';
import type { Brain } from '../brain/brain.js';
import { loadChampion, loadHallOfFame } from '../train/checkpoint.js';
import { fromGenome, type Individual } from '../train/individual.js';
import type { Fighter } from '../train/match.js';

export interface ShowcaseOptions {
  /** Round length cap, seconds. Shorter than training matches: this is television. */
  maxSeconds?: number;
  /** Held-out map seeds are fine to reuse here. */
  seed?: number;
  /** How often (in rounds) to check disk for a newly trained champion. */
  refreshEvery?: number;
}

export type Phase = 'fight' | 'intermission';

const CHAMPION_COLOR = '#ff4d6d';
const CHALLENGER_COLOR = '#4dd2ff';

export interface RoundSummary {
  round: number;
  winner: string;
  loser: string;
  defenses: number;
  mapSeed: number;
}

export class Showcase {
  private readonly opts: Required<ShowcaseOptions>;
  private readonly rng: Rng;
  private readonly runDir: string | null;

  private world!: World;
  private map!: GameMap;
  private mapData!: MapData;
  private mapVersion = 0;

  private champion!: Fighter;
  private challenger!: Fighter;
  private championIndividual: Individual | null = null;
  private generation = 0;

  private hallOfFame: Individual[] = [];
  private pendingEvents: WorldEvent[] = [];

  private phase: Phase = 'fight';
  private intermission = 0;
  private round = 1;
  private defenses = 0;
  private scoreboard = { champion: 0, challenger: 0, draws: 0 };
  private recentRounds: RoundSummary[] = [];
  private tickCounter = 0;
  private tps = 0;
  private tpsMark = 0;
  private tpsTicks = 0;

  constructor(runDir: string | null, opts: ShowcaseOptions = {}) {
    this.runDir = runDir;
    this.opts = {
      maxSeconds: opts.maxSeconds ?? 32,
      seed: opts.seed ?? 20240501,
      refreshEvery: opts.refreshEvery ?? 4,
    };
    this.rng = new Rng(this.opts.seed);
    this.loadFromDisk(true);
    this.startRound();
  }

  private loadFromDisk(first: boolean): void {
    if (!this.runDir) {
      if (!this.champion) this.champion = this.randomFighter('Challenger');
      return;
    }
    const best = loadChampion(this.runDir);
    if (best) {
      // Training may have promoted a new genome since we last looked.
      const isNewChampion = !first && !!this.champion && best.genome.name !== this.champion.name;
      const ind = fromGenome(best.genome);
      ind.elo = Number(best.meta.elo ?? ind.elo);
      ind.generation = best.generation;
      this.championIndividual = ind;
      this.generation = best.generation;
      this.champion = {
        brain: ind.brain,
        name: ind.name,
        color: CHAMPION_COLOR,
        id: 0,
        elo: ind.elo,
        generation: ind.generation,
      };
      // Walk the freshly trained champion into the arena, on camera.
      if (isNewChampion) {
        this.pendingEvents.push({
          tick: this.world ? this.world.tick : 0,
          type: 'roundStart',
          text: `NEW CHAMPION · GEN ${best.generation} · ${ind.name}`,
          color: '#ffd166',
        });
      }
    } else if (!this.champion) {
      this.champion = this.randomFighter('Champion');
    }
    this.hallOfFame = loadHallOfFame(this.runDir);
    if (first) {
      this.refreshChallenger();
    }
  }

  private randomFighter(prefix: string): Fighter {
    const sizes = defaultSizes(OBS_SIZE);
    const brain = MlpBrain.random(sizes, this.rng);
    return {
      brain,
      name: `${prefix}-${this.rng.int(100, 999)}`,
      color: CHAMPION_COLOR,
      id: 0,
      elo: 1200,
      generation: 0,
    };
  }

  private refreshChallenger(): void {
    // Occasionally wheel out the hand-written baseline as a "boss fight".
    if (this.hallOfFame.length === 0 && this.rng.chance(0.18)) {
      this.challenger = {
        brain: new ScriptedBrain(this.rng.int(1, 9999)),
        name: 'SCRIPTED',
        color: CHALLENGER_COLOR,
        id: 1,
        elo: 1300,
        generation: 0,
      };
      return;
    }
    const pool = this.hallOfFame.filter((h) => h.name !== this.champion.name);
    if (pool.length > 0) {
      const pick = pool[this.rng.int(0, Math.min(pool.length, 8) - 1)];
      this.challenger = {
        brain: pick.brain,
        name: pick.name,
        color: CHALLENGER_COLOR,
        id: 1,
        elo: pick.elo,
        generation: pick.generation,
      };
      return;
    }
    const fresh = this.randomFighter('Rookie');
    fresh.color = CHALLENGER_COLOR;
    fresh.id = 1;
    this.challenger = fresh;
  }

  private startRound(): void {
    const seed = this.rng.int(1, 0x7fffffff);
    this.map = generateMap(seed, { symmetric: true, clutter: 0.07, rooms: 5 + (seed % 4) });
    this.mapData = this.map.toData();
    this.mapVersion++;
    this.world = new World(
      this.map,
      [
        {
          brain: this.champion.brain,
          name: this.champion.name,
          color: CHAMPION_COLOR,
          id: 0,
          elo: this.champion.elo,
          generation: this.champion.generation,
        },
        {
          brain: this.challenger.brain,
          name: this.challenger.name,
          color: CHALLENGER_COLOR,
          id: 1,
          elo: this.challenger.elo,
          generation: this.challenger.generation,
        },
      ],
      { maxTicks: Math.floor(this.opts.maxSeconds * TICK_RATE) },
    );
    this.phase = 'fight';
    this.pendingEvents.push({ tick: 0, type: 'roundStart', text: `Round ${this.round}` });
  }

  private endRound(): void {
    const winner = this.world.winner;
    let winnerName = 'Draw';
    let loserName = '';
    if (winner === 0) {
      this.scoreboard.champion++;
      this.defenses++;
      winnerName = this.champion.name;
      loserName = this.challenger.name;
    } else if (winner === 1) {
      this.scoreboard.challenger++;
      winnerName = this.challenger.name;
      loserName = this.champion.name;
      // King of the hill: the belt changes hands.
      const oldChampion = this.champion;
      this.champion = { ...this.challenger };
      this.challenger = oldChampion;
      this.defenses = 0;
    } else {
      this.scoreboard.draws++;
      winnerName = 'Draw';
      loserName = `${this.champion.name} / ${this.challenger.name}`;
    }
    this.recentRounds.unshift({
      round: this.round,
      winner: winnerName,
      loser: loserName,
      defenses: this.defenses,
      mapSeed: this.map.seed,
    });
    this.recentRounds = this.recentRounds.slice(0, 6);
    this.phase = 'intermission';
    this.intermission = Math.floor(2.6 * TICK_RATE);
    this.pendingEvents.push({
      tick: this.world.tick,
      type: 'roundEnd',
      text: winnerName === 'Draw' ? 'Draw' : `${winnerName} wins`,
      color: winner === 1 ? CHALLENGER_COLOR : CHAMPION_COLOR,
    });
  }

  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      if (this.phase === 'fight') {
        this.world.step();
        this.tickCounter++;
        this.tpsTicks++;
        const evs = this.world.drainEvents();
        for (const e of evs) this.pendingEvents.push(e);
        if (this.world.over) this.endRound();
      } else {
        this.intermission--;
        if (this.intermission <= 0) {
          this.round++;
          if (this.round % this.opts.refreshEvery === 0) this.loadFromDisk(false);
          this.refreshChallenger();
          this.startRound();
        }
      }
    }
    const now = Date.now();
    if (now - this.tpsMark > 1000) {
      this.tps = (this.tpsTicks * 1000) / (now - this.tpsMark);
      this.tpsMark = now;
      this.tpsTicks = 0;
    }
  }

  currentMapVersion(): number {
    return this.mapVersion;
  }

  mapDataFor(): MapData {
    return this.mapData;
  }

  snapshot(): Snapshot {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const snap = this.world.snapshot({
      generation: this.generation,
      round: this.round,
      mapSeed: this.map.seed,
      mapVersion: this.mapVersion,
      phase: this.phase,
      defenses: this.defenses,
      champion: {
        name: this.champion.name,
        elo: Math.round(this.champion.elo),
        generation: this.champion.generation,
      },
      challenger: {
        name: this.challenger.name,
        elo: Math.round(this.challenger.elo),
        generation: this.challenger.generation,
      },
      scoreboard: { ...this.scoreboard },
      ticksPerSecond: Math.round(this.tps),
    });
    snap.events = events;
    return snap;
  }
}
