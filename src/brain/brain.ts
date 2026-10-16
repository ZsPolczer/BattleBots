import type { Action } from '../engine/types.js';

/**
 * A brain is anything that maps an observation vector to an action.
 *
 * Keeping evolution, scripted opponents, and (later) a PyTorch policy behind one
 * interface is what lets the show survive a change of learning algorithm.
 */
export interface Brain {
  readonly kind: string;
  /** Observation -> action. Must write into `out` and must not allocate. */
  act(obs: Float32Array, out: Action): void;
  clone(): Brain;
}

/** Serializable description of an evolved brain. */
export interface Genome {
  v: 1;
  sizes: number[];
  weights: number[];
  mutationRate: number;
  mutationSigma: number;
  id: number;
  name: string;
  elo: number;
  generation: number;
  parent?: string;
}
