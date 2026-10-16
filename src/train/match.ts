/**
 * Running a single duel. Kept tiny on purpose so training and the broadcast
 * always measure the same thing.
 */

import { MAX_MATCH_TICKS } from '../engine/constants.js';
import { GameMap, generateMap } from '../engine/map.js';
import type { BotStats } from '../engine/types.js';
import { World } from '../engine/world.js';
import type { Brain } from '../brain/brain.js';
import { DEFAULT_FITNESS, rawScore, type FitnessWeights } from './fitness.js';

export interface MatchOptions {
  maxTicks?: number;
  pickups?: boolean;
  fitness?: FitnessWeights;
}

export interface MatchResult {
  winner: number; // 0, 1, or -1 for a draw
  ticks: number;
  stats: [BotStats, BotStats];
  scores: [number, number];
}

const mapCache = new Map<number, GameMap>();

/**
 * Maps are pure functions of their seed and the world never mutates them, so
 * caching turns map generation into a one-off cost per distinct seed.
 */
export function getMap(seed: number): GameMap {
  let m = mapCache.get(seed);
  if (!m) {
    m = generateMap(seed, {
      symmetric: true,
      clutter: 0.035,
      rooms: 5 + (seed % 4),
      botCount: 2,
    });
    mapCache.set(seed, m);
  }
  return m;
}

export function clearMapCache(): void {
  mapCache.clear();
}

export interface Fighter {
  brain: Brain;
  name: string;
  color: string;
  id: number;
  elo: number;
  generation: number;
  team?: number;
}

export function runMatch(a: Fighter, b: Fighter, mapSeed: number, opts: MatchOptions = {}): MatchResult {
  const map = getMap(mapSeed);
  const maxTicks = opts.maxTicks ?? MAX_MATCH_TICKS;
  const world = new World(
    map,
    [
      { brain: a.brain, name: a.name, color: a.color, id: 0, elo: a.elo, generation: a.generation },
      { brain: b.brain, name: b.name, color: b.color, id: 1, elo: b.elo, generation: b.generation },
    ],
    { maxTicks, pickups: opts.pickups ?? true },
  );

  let guard = 0;
  while (!world.over && guard++ <= maxTicks + 2) {
    world.step();
  }

  const w = opts.fitness ?? DEFAULT_FITNESS;
  const s0 = rawScore(world.bots[0].stats, world.tick, maxTicks, world.winner === 0, w);
  const s1 = rawScore(world.bots[1].stats, world.tick, maxTicks, world.winner === 1, w);

  return {
    winner: world.winner,
    ticks: world.tick,
    stats: [world.bots[0].stats, world.bots[1].stats],
    scores: [s0, s1],
  };
}

export interface BenchResult {
  winRate: number;
  draws: number;
  losses: number;
  matches: number;
}

/** Deterministic head-to-head used for held-out generalization measurements. */
export function benchmark(
  challenger: Fighter,
  incumbent: Fighter,
  seeds: number[],
  opts: MatchOptions = {},
): BenchResult {
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const seed of seeds) {
    const r = runMatch(challenger, incumbent, seed, opts);
    if (r.winner === 0) wins++;
    else if (r.winner === -1) draws++;
    else losses++;
  }
  return { winRate: wins / Math.max(1, seeds.length), draws, losses, matches: seeds.length };
}

/** Elo update for a single result. Scale of 400 is the usual chess convention. */
export function eloUpdate(
  eloA: number,
  eloB: number,
  scoreA: number,
  k = 24,
): { a: number; b: number } {
  const expectedA = 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    a: eloA + k * (scoreA - expectedA),
    b: eloB + k * (scoreB - expectedB),
  };
}

export function outcomeScore(winner: number, selfIndex: number): number {
  if (winner === -1) return 0.5;
  return winner === selfIndex ? 1 : 0;
}
