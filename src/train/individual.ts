import type { Genome } from '../brain/brain.js';
import { MlpBrain } from '../brain/mlp.js';

/** One member of the population: a brain plus its competitive record. */
export interface Individual {
  brain: MlpBrain;
  id: number;
  name: string;
  surname: string;
  elo: number;
  generation: number;
  parent?: string;
  fitness: number;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
  /** running averages of behaviour, for the broadcast overlays */
  avgAccuracy: number;
  avgDamage: number;
  avgKills: number;
  avgWallHug: number;
  avgSurvival: number;
}

export function makeIndividual(init: {
  brain: MlpBrain;
  id: number;
  name: string;
  surname: string;
  generation: number;
  parent?: string;
  elo?: number;
}): Individual {
  return {
    brain: init.brain,
    id: init.id,
    name: init.name,
    surname: init.surname,
    elo: init.elo ?? 1200,
    generation: init.generation,
    parent: init.parent,
    fitness: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    matches: 0,
    avgAccuracy: 0,
    avgDamage: 0,
    avgKills: 0,
    avgWallHug: 0,
    avgSurvival: 0,
  };
}

export function toGenome(ind: Individual): Genome {
  return ind.brain.toGenome({
    id: ind.id,
    name: ind.name,
    elo: ind.elo,
    generation: ind.generation,
    parent: ind.parent,
  });
}

export function fromGenome(g: Genome, surname?: string): Individual {
  const brain = MlpBrain.fromGenome(g);
  return makeIndividual({
    brain,
    id: g.id,
    name: g.name,
    surname: surname ?? g.name.split('-')[0] ?? 'Bot',
    generation: g.generation,
    parent: g.parent,
    elo: g.elo,
  });
}

/** Weight-space distance, used as a crude diversity metric. */
export function genomeDistance(a: MlpBrain, b: MlpBrain): number {
  if (a.weights.length !== b.weights.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.weights.length; i++) {
    const d = a.weights[i] - b.weights[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.weights.length);
}
