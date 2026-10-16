/**
 * Bot naming. Nobody watches "agent_0042" — give them surnames so lineages and
 * family rivalries show up on the leaderboard.
 */

import type { Rng } from './rng.js';

const ROOTS = [
  'Vex', 'Zar', 'Kro', 'Nyx', 'Rho', 'Tal', 'Syn', 'Vor', 'Mal', 'Ix',
  'Quo', 'Dra', 'Bel', 'Fen', 'Osk', 'Lum', 'Gre', 'Hax', 'Sil', 'Tor',
  'Aza', 'Bri', 'Cyn', 'Dun', 'Eph', 'Fyr', 'Gor', 'Hal', 'Iri', 'Jax',
  'Kai', 'Lyr', 'Mor', 'Nex', 'Ory', 'Pyr', 'Ren', 'Syr', 'Tuv', 'Wra',
];

const TITLES = ['', '', '', ' the Swift', ' the Wall', ' the Patient', ' the Loud', ' the Lucky'];

/**
 * A lineage is identified by an integer seed. Members of a lineage share a
 * surname and are numbered in birth order.
 */
export interface Lineage {
  surname: string;
  nextIndex: number;
}

export function newLineage(rng: Rng): Lineage {
  return { surname: rng.pick(ROOTS), nextIndex: rng.int(1, 9) };
}

export function nameFor(lineage: Lineage, rng: Rng): string {
  const n = lineage.nextIndex++;
  const title = rng.chance(0.12) ? rng.pick(TITLES) : '';
  return `${lineage.surname}-${n}${title}`;
}
