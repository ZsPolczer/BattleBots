/**
 * The fitness function is the actual product. Every loophole evolution finds
 * lives here.
 *
 * Design rules:
 *  - dense (a bot must get signal from "I hit them") not sparse (only "I won"),
 *  - relative (comparing to the opponent) so scores can't inflate forever,
 *  - penalised for the classic degenerate strategies: wall-hugging, turtling,
 *    and never engaging at all.
 */

import { BOT_MAX_HEALTH, MAX_MATCH_TICKS, WALL_HUG_WINDOW } from '../engine/constants.js';
import type { BotStats } from '../engine/types.js';

export interface FitnessWeights {
  /** How much of the match score is absolute vs. relative-to-opponent. */
  abs: number;
  rel: number;
  damageDealt: number;
  damageTaken: number;
  kill: number;
  win: number;
  accuracy: number;
  /** Reward for keeping the enemy in the firing arc with line of sight. */
  aim: number;
  survival: number;
  mobility: number;
  timePenalty: number;
  wallHug: number;
  passivity: number;
  /** damage below this is considered "did not engage" */
  passiveThreshold: number;
}

export const DEFAULT_FITNESS: FitnessWeights = {
  abs: 0.5,
  rel: 0.5,
  damageDealt: 1.0,
  damageTaken: 0.6,
  kill: 12,
  win: 25,
  accuracy: 8,
  aim: 9,
  survival: 2,
  mobility: 5,
  timePenalty: 0.0004,
  wallHug: 16,
  passivity: 6,
  passiveThreshold: 5,
};

/** Absolute (non-relative) quality of one bot's performance in one match. */
export function rawScore(
  stats: BotStats,
  ticks: number,
  maxTicks: number,
  won: boolean,
  w: FitnessWeights = DEFAULT_FITNESS,
): number {
  const accuracy = stats.shotsFired >= 10 ? stats.shotsHit / stats.shotsFired : 0;
  const survival = stats.ticksAlive / maxTicks;
  // Wall-hugging is only meaningfully bad while there is space to move.
  const hugWindow = Math.min(stats.ticksAlive, maxTicks * WALL_HUG_WINDOW);
  const wallHug = stats.wallHugTicks / Math.max(1, hugWindow);
  const mobility = stats.moveTicks / Math.max(1, stats.ticksAlive);
  const aimDuty = stats.shotOpportunityTicks / Math.max(1, stats.ticksAlive);
  const passive = stats.damageDealt < w.passiveThreshold ? 1 : 0;

  let s = 0;
  s += stats.damageDealt * w.damageDealt;
  s -= stats.damageTaken * w.damageTaken;
  s += stats.kills * w.kill;
  if (won) s += w.win;
  s += accuracy * w.accuracy;
  s += aimDuty * w.aim;
  s += survival * w.survival;
  s += mobility * w.mobility;
  s -= wallHug * w.wallHug;
  s -= passive * w.passivity;
  s -= ticks * w.timePenalty;
  return s;
}

/** Human-readable behaviour fingerprint, used for the broadcast and for insight. */
export interface Behavior {
  accuracy: number;
  aggression: number;
  mobility: number;
  wallHug: number;
  avgHealthLeft: number;
}

export function behaviorOf(stats: BotStats): Behavior {
  const shots = Math.max(1, stats.shotsFired);
  const ticks = Math.max(1, stats.ticksAlive);
  return {
    accuracy: stats.shotsHit / shots,
    aggression: stats.damageDealt / BOT_MAX_HEALTH,
    mobility: stats.moveTicks / ticks,
    wallHug: stats.wallHugTicks / ticks,
    avgHealthLeft: 0,
  };
}
