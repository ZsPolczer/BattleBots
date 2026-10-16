/**
 * Non-evolved reference brains.
 *
 * `ScriptedBrain` exists to be a quality bar: if a hundred generations of
 * evolution cannot beat a twenty-line heuristic, the fitness function is broken,
 * not the population.
 */

import {
  BOT_TURN_RATE,
  DECISION_INTERVAL,
  DT,
  OBS_ENEMY,
  OBS_RAYS,
  OBS_SELF,
  OBS_ZONE,
  RAY_COUNT,
  REL_RANGE,
  WORLD_H,
  WORLD_W,
  ZONE_COMFORT,
} from '../engine/constants.js';
import type { Action } from '../engine/types.js';
import { Rng } from '../engine/rng.js';
import type { Brain } from './brain.js';

export class RandomBrain implements Brain {
  readonly kind = 'random';
  private readonly rng: Rng;
  private readonly seed0: number;
  private move = 8;
  private turn = 0;
  private fire = 0;
  private counter = 0;

  constructor(seed: number) {
    // Local RNG so random brains stay reproducible and never touch the world RNG.
    this.seed0 = seed >>> 0;
    this.rng = new Rng(this.seed0);
  }

  clone(): RandomBrain {
    return new RandomBrain((this.seed0 ^ 0x9e3779b9) >>> 0);
  }

  act(_obs: Float32Array, out: Action): void {
    if (this.counter++ % 18 === 0) {
      this.move = Math.floor(this.rng.next() * 9);
      this.turn = this.rng.next() * 2 - 1;
      this.fire = this.rng.next() < 0.45 ? 1 : 0;
    } else if (this.counter % 18 === 6) {
      // Keep turning for a while so it looks like a dumb agent, not noise.
      this.turn *= 0.6;
    }
    out.move = this.move;
    out.turn = this.turn;
    out.fire = this.fire;
  }
}

const DIRS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Hand-written duelist: close to a preferred range, strafe, shoot when the
 * target is roughly in front.
 *
 * It steers around walls using the same raycast fan the evolved brains get,
 * because a baseline that jams into a corner is not a baseline — it is a bug
 * that makes evolution look smarter than it is.
 */
export class ScriptedBrain implements Brain {
  readonly kind = 'scripted';
  private strafeSign = 1;
  private strafeTimer = 0;
  private stuckTicks = 0;
  private escapeTimer = 0;
  private escapeDir = 0;
  private lastX = -1;
  private lastY = -1;

  constructor(private readonly seed = 1) {}

  clone(): ScriptedBrain {
    return new ScriptedBrain(this.seed);
  }

  act(obs: Float32Array, out: Action): void {
    const ex = obs[OBS_ENEMY] * REL_RANGE;
    const ey = obs[OBS_ENEMY + 1] * REL_RANGE;
    const dist = obs[OBS_ENEMY + 2] * REL_RANGE;
    const visible = obs[OBS_ENEMY + 4] > 0.5;

    const selfAngle = Math.atan2(obs[OBS_SELF + 7], obs[OBS_SELF + 8]);
    const ownHealth = obs[OBS_SELF + 4];
    const ammo = obs[OBS_SELF + 5] * 30;
    const reloading = obs[OBS_SELF + 6] > 0.99;

    const hasTarget = ex !== 0 || ey !== 0;
    const toEnemy = Math.atan2(ey, ex);

    // Aim. The chosen turn is held for DECISION_INTERVAL ticks, so divide by it.
    const diff = wrapAngle(toEnemy - selfAngle);
    out.turn = Math.max(-1, Math.min(1, diff / (BOT_TURN_RATE * DT * DECISION_INTERVAL)));

    // Desired heading: get back in the zone first, then approach/retreat/circle.
    const zoneRelX = obs[OBS_ZONE] * REL_RANGE;
    const zoneRelY = obs[OBS_ZONE + 1] * REL_RANGE;
    const zoneEdge = obs[OBS_ZONE + 2] * REL_RANGE; // > 0 means outside
    const preferred = ownHealth < 0.4 ? 300 : 210;
    let desired: number;
    if (zoneEdge > -ZONE_COMFORT) {
      // Run for the safe zone; shooting while running is fine but not the goal.
      desired = Math.atan2(zoneRelY, zoneRelX);
    } else if (!visible && hasTarget) {
      desired = toEnemy;
    } else if (dist > preferred + 40) {
      desired = toEnemy;
    } else if (dist < preferred - 60) {
      desired = toEnemy + Math.PI;
    } else {
      if (this.strafeTimer-- <= 0) {
        this.strafeTimer = 50 + ((this.seed * 31) % 70);
        this.strafeSign *= -1;
      }
      desired = toEnemy + (Math.PI / 2) * this.strafeSign;
    }

    // Pick the compass direction that best balances "toward the goal" with
    // "not into a wall", scored against the raycast fan.
    let bestDir = 8;
    let bestScore = -Infinity;
    for (let d = 0; d < 8; d++) {
      const ang = (d * Math.PI) / 4;
      const align = Math.cos(ang - desired);
      const clearance = rayClearance(obs, selfAngle, ang);
      const score = align * 1.0 + clearance * 1.7;
      if (score > bestScore) {
        bestScore = score;
        bestDir = d;
      }
    }

    // Local greedy steering cannot escape a dead end. Detect "I am pushing but
    // not actually moving" from the position delta (velocity lies — it is the
    // *intended* velocity and stays non-zero while pressed against a wall) and
    // commit to a rotating escape direction for a while.
    const selfX = obs[0] * WORLD_W;
    const selfY = obs[1] * WORLD_H;
    const moved = this.lastX < 0 ? 99 : Math.hypot(selfX - this.lastX, selfY - this.lastY);
    this.lastX = selfX;
    this.lastY = selfY;

    if (this.escapeTimer > 0) {
      this.escapeTimer--;
      bestDir = this.escapeDir;
    } else {
      if (bestDir !== 8 && moved < 0.9) this.stuckTicks++;
      else this.stuckTicks = Math.max(0, this.stuckTicks - 3);
      if (this.stuckTicks > 25) {
        this.stuckTicks = 0;
        this.escapeTimer = 90;
        // +3 is coprime with 8, so repeated escapes sweep every direction.
        this.escapeDir = (this.escapeDir + 3) % 8;
        bestDir = this.escapeDir;
      }
    }
    out.move = bestDir;

    out.fire = visible && dist < 360 && Math.abs(diff) < 0.28 && ammo > 0 && !reloading ? 1 : 0;
  }
}

/**
 * Worst-case clearance (0..1) over the rays closest to `worldAngle`. Sampling
 * three neighbouring rays keeps the bot from clipping corners.
 */
function rayClearance(obs: Float32Array, selfAngle: number, worldAngle: number): number {
  const step = (Math.PI * 2) / RAY_COUNT;
  const base = Math.round(wrapAngle(worldAngle - selfAngle) / step);
  let worst = 1;
  for (let k = -1; k <= 1; k++) {
    const idx = (((base + k) % RAY_COUNT) + RAY_COUNT) % RAY_COUNT;
    const dist = obs[OBS_RAYS + idx * 4];
    const blocked = obs[OBS_RAYS + idx * 4 + 1];
    // A wall dead ahead is worse than empty space at the same distance.
    const value = blocked > 0.5 ? dist * 0.6 : dist;
    if (value < worst) worst = value;
  }
  return worst;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export { DIRS };
