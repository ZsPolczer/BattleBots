/**
 * The world: deterministic 2D arena combat.
 *
 * Contract: `new World(...).step()` repeated N times produces an identical
 * sequence of states for identical inputs. No `Math.random`, no `Date.now`, no
 * iteration over unordered collections. This is what makes replays, fair
 * evaluation and highlight clipping possible.
 */

import {
  BOT_ACCEL,
  BOT_MAX_HEALTH,
  BOT_RADIUS,
  BOT_SPEED,
  BOT_TURN_RATE,
  BULLET_DAMAGE,
  BULLET_LIFE,
  BULLET_RADIUS,
  BULLET_SPEED,
  DECISION_INTERVAL,
  DT,
  FIRE_COOLDOWN,
  MAG_SIZE,
  MAX_MATCH_TICKS,
  MEMORY_MAX_AGE,
  OBS_ALLY,
  OBS_ENEMY,
  OBS_MEMORY,
  OBS_PICKUP,
  OBS_RAYS,
  OBS_SIZE,
  OBS_TIME,
  OBS_ZONE,
  PICKUP_AMMO,
  PICKUP_HEAL,
  PICKUP_RADIUS,
  PICKUP_RESPAWN,
  RAY_COUNT,
  RAY_RANGE,
  REL_RANGE,
  RELOAD_TIME,
  SPREAD,
  TICK_RATE,
  WALL_HUG_DIST,
  WALL_HUG_SPEED,
  WALL_HUG_WINDOW,
  WORLD_H,
  WORLD_W,
  ZONE_DPS,
  ZONE_GRACE_FRACTION,
  ZONE_MIN_RADIUS,
  ZONE_START_FRACTION,
} from './constants.js';
import { GameMap, distanceToWall, hasLineOfSight, nearestOpenPoint, raycastTiles } from './map.js';
import { Rng } from './rng.js';
import type { Brain } from '../brain/brain.js';
import {
  makeAction,
  makeStats,
  resetAction,
  type Action,
  type BotSnapshot,
  type BotStats,
  type BulletSnapshot,
  type PickupSnapshot,
  type Snapshot,
  type WorldEvent,
} from './types.js';

export const BOT_COLORS = [
  '#ff4d6d',
  '#4dd2ff',
  '#ffd166',
  '#8aff80',
  '#c77dff',
  '#ff9f1c',
  '#00e5b0',
  '#f15bb5',
];

/** Movement direction table; index 8 means "idle". */
const DIR_VEC: Array<[number, number]> = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

export interface BotSpec {
  brain: Brain;
  name: string;
  id: number;
  elo?: number;
  generation?: number;
  team?: number;
  color?: string;
}

export class Bot {
  readonly id: number;
  readonly team: number;
  readonly brain: Brain;
  name: string;
  color: string;
  generation: number;
  elo: number;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  angle = 0;

  health = BOT_MAX_HEALTH;
  ammo = MAG_SIZE;
  cooldown = 0;
  reloadTimer = 0;
  alive = true;

  readonly action: Action = makeAction();
  readonly obs = new Float32Array(OBS_SIZE);
  readonly stats: BotStats = makeStats();

  memX = 0;
  memY = 0;
  memAge = MEMORY_MAX_AGE + 1;
  hitFlash = 0;
  danger = false;

  // Cached, refreshed every few ticks because they are relatively expensive.
  losClear = false;
  wallDistance = 0;

  constructor(spec: BotSpec) {
    this.id = spec.id;
    this.team = spec.team ?? 0;
    this.brain = spec.brain;
    this.name = spec.name;
    this.color = spec.color ?? BOT_COLORS[spec.id % BOT_COLORS.length];
    this.elo = spec.elo ?? 1200;
    this.generation = spec.generation ?? 0;
  }

  get healthFraction(): number {
    return Math.max(0, this.health) / BOT_MAX_HEALTH;
  }
}

interface Bullet {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  owner: Bot;
  ownerIndex: number;
  life: number;
}

interface Pickup {
  x: number;
  y: number;
  type: number; // 0 = health, 1 = ammo
  active: boolean;
  respawnAt: number;
}

export interface WorldOptions {
  maxTicks?: number;
  pickups?: boolean;
  destructible?: boolean;
  /** Ticks between decisions; the chosen action is held in between. */
  decideEvery?: number;
}

export class World {
  readonly map: GameMap;
  readonly bots: Bot[];
  readonly rng: Rng;
  readonly maxTicks: number;

  bullets: Bullet[] = [];
  pickups: Pickup[] = [];
  tick = 0;
  over = false;
  winner = -1;

  /** Shrinking safe zone. */
  zoneX: number;
  zoneY: number;
  zoneR: number;
  private readonly zoneR0: number;
  private readonly zoneR1: number;

  private events: WorldEvent[] = [];
  private readonly usePickups: boolean;
  private readonly decideEvery: number;

  constructor(map: GameMap, specs: BotSpec[], opts: WorldOptions = {}) {
    this.map = map;
    this.rng = new Rng((map.seed ^ 0x2545f491) >>> 0);
    this.maxTicks = opts.maxTicks ?? MAX_MATCH_TICKS;
    this.usePickups = opts.pickups ?? true;
    this.decideEvery = Math.max(1, opts.decideEvery ?? DECISION_INTERVAL);

    // Free-for-all by default: each slot is its own team unless the caller
    // groups them explicitly (team battles pass a shared team index).
    const grouped: BotSpec[] = specs.map((s, i) => ({ ...s, team: s.team ?? i }));
    this.bots = grouped.map((s) => new Bot(s));
    for (let i = 0; i < this.bots.length; i++) {
      const spawn = map.spawns[i % map.spawns.length];
      const b = this.bots[i];
      b.x = spawn.x;
      b.y = spawn.y;
      // Face the centre of the arena so early bots at least look purposeful.
      b.angle = Math.atan2(map.height / 2 - b.y, map.width / 2 - b.x);
    }

    if (this.usePickups) {
      const count = 2 + (map.seed % 3);
      for (let i = 0; i < count; i++) {
        const p = this.randomPickupSpot();
        this.pickups.push({ x: p.x, y: p.y, type: i % 2, active: true, respawnAt: 0 });
      }
    }

    // The zone closes on the midpoint of the spawns, which is exactly the map
    // centre when the arena and the spawns are mirrored — so neither bot is
    // favoured by the shrink. It must snap to walkable ground, or the last
    // circle can end up inside a wall and nobody can reach safety, which
    // silently rewards camping instead of fighting.
    let sumX = 0;
    let sumY = 0;
    for (const b of this.bots) {
      sumX += b.x;
      sumY += b.y;
    }
    const focus = nearestOpenPoint(map, sumX / this.bots.length, sumY / this.bots.length);
    this.zoneX = focus.x;
    this.zoneY = focus.y;
    this.zoneR0 = ZONE_START_FRACTION * Math.hypot(map.width, map.height);
    this.zoneR1 = ZONE_MIN_RADIUS;
    this.zoneR = this.zoneR0;

    this.events.push({ tick: 0, type: 'roundStart', x: 0, y: 0 });
  }

  // ---------------------------------------------------------------- stepping

  step(): void {
    if (this.over) return;
    this.tick++;

    this.think();
    this.applyIntents();
    this.integrateMovement();
    this.separateBots();
    this.updateBullets();
    if (this.usePickups) this.updatePickups();
    this.updateZone();
    this.postUpdate();
    this.checkEnd();
  }

  private think(): void {
    const decide = this.tick % this.decideEvery === 0;
    for (const b of this.bots) {
      if (!b.alive) {
        resetAction(b.action);
        continue;
      }
      // Refresh expensive derived senses only every few ticks.
      if (this.tick % 3 === 1) {
        b.wallDistance = distanceToWall(this.map, b.x, b.y, WALL_HUG_DIST * 2);
      }
      if (!decide) continue;
      this.observe(b);
      resetAction(b.action);
      b.brain.act(b.obs, b.action);
    }
  }

  private applyIntents(): void {
    for (const b of this.bots) {
      if (!b.alive) continue;

      if (b.reloadTimer > 0) {
        b.reloadTimer -= DT;
        if (b.reloadTimer <= 0) {
          b.reloadTimer = 0;
          b.ammo = MAG_SIZE;
        }
      }
      if (b.cooldown > 0) b.cooldown -= DT;

      b.angle += b.action.turn * BOT_TURN_RATE * DT;
      if (b.angle > Math.PI) b.angle -= Math.PI * 2;
      else if (b.angle < -Math.PI) b.angle += Math.PI * 2;

      const dir = b.action.move >= 0 && b.action.move < 8 ? DIR_VEC[b.action.move] : null;
      const tvx = dir ? dir[0] * BOT_SPEED : 0;
      const tvy = dir ? dir[1] * BOT_SPEED : 0;
      const k = Math.min(1, BOT_ACCEL * DT);
      b.vx += (tvx - b.vx) * k;
      b.vy += (tvy - b.vy) * k;

      if (b.action.fire > 0 && b.cooldown <= 0 && b.ammo > 0 && b.reloadTimer <= 0) {
        this.spawnBullet(b);
      }
    }
  }

  private spawnBullet(b: Bot): void {
    const spread = (this.rng.next() - 0.5) * 2 * SPREAD;
    const a = b.angle + spread;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const muzzle = BOT_RADIUS + 3;
    const x = b.x + dx * muzzle;
    const y = b.y + dy * muzzle;
    this.bullets.push({
      x,
      y,
      px: x,
      py: y,
      vx: dx * BULLET_SPEED,
      vy: dy * BULLET_SPEED,
      owner: b,
      ownerIndex: this.bots.indexOf(b),
      life: BULLET_LIFE,
    });
    b.ammo--;
    b.cooldown = FIRE_COOLDOWN;
    b.stats.shotsFired++;
    if (b.ammo <= 0) b.reloadTimer = RELOAD_TIME;
    this.events.push({ tick: this.tick, type: 'shot', actor: b.id, x, y, color: b.color });
  }

  private integrateMovement(): void {
    for (const b of this.bots) {
      if (!b.alive) continue;
      const ox = b.x;
      const oy = b.y;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      resolveCircleTiles(this.map, b);
      b.stats.distance += Math.hypot(b.x - ox, b.y - oy);

      const speed = Math.hypot(b.vx, b.vy);
      if (speed > WALL_HUG_SPEED * BOT_SPEED) b.stats.moveTicks++;
      // Only count hugging while there is still somewhere else to go. Once the
      // zone has closed in, being near a wall is unavoidable, not cowardice.
      if (
        this.tick < this.maxTicks * WALL_HUG_WINDOW &&
        b.wallDistance < WALL_HUG_DIST &&
        speed < WALL_HUG_SPEED * BOT_SPEED
      ) {
        b.stats.wallHugTicks++;
      }
      b.stats.ticksAlive++;
    }
  }

  private separateBots(): void {
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const a = bots[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < bots.length; j++) {
        const b = bots[j];
        if (!b.alive) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = BOT_RADIUS * 2;
        if (d >= min) continue;
        if (d < 1e-6) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (min - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        resolveCircleTiles(this.map, a);
        resolveCircleTiles(this.map, b);
      }
    }
  }

  private updateBullets(): void {
    const bullets = this.bullets;
    let write = 0;
    for (let i = 0; i < bullets.length; i++) {
      const bl = bullets[i];
      bl.life -= DT;
      if (bl.life <= 0) continue;

      bl.px = bl.x;
      bl.py = bl.y;
      const dx = bl.vx * DT;
      const dy = bl.vy * DT;
      const segLen = Math.hypot(dx, dy) || 1e-6;
      const invLen = 1 / segLen;

      const wallDist = raycastTiles(this.map, bl.x, bl.y, dx * invLen, dy * invLen, segLen);
      const wallT = wallDist * invLen;

      let bestT = 1;
      let hitBot: Bot | null = null;
      for (const b of this.bots) {
        if (!b.alive || b === bl.owner) continue;
        const t = segmentCircle(bl.x, bl.y, bl.x + dx, bl.y + dy, b.x, b.y, BOT_RADIUS + BULLET_RADIUS);
        if (t >= 0 && t < bestT) {
          bestT = t;
          hitBot = b;
        }
      }

      if (wallT < bestT) {
        // Wall eats the bullet first: small spark, bullet dies.
        this.events.push({
          tick: this.tick,
          type: 'hit',
          x: bl.x + dx * wallT,
          y: bl.y + dy * wallT,
        });
        continue;
      }
      if (hitBot) {
        this.applyDamage(hitBot, BULLET_DAMAGE, bl.owner);
        continue;
      }

      bl.x += dx;
      bl.y += dy;
      bullets[write++] = bl;
    }
    bullets.length = write;
  }

  private applyDamage(target: Bot, amount: number, source: Bot | null): void {
    if (!target.alive) return;
    target.health -= amount;
    target.stats.damageTaken += amount;
    target.hitFlash = 0.14;
    if (source && source !== target) {
      source.stats.damageDealt += amount;
      source.stats.shotsHit++;
    }
    this.events.push({
      tick: this.tick,
      type: 'hit',
      actor: source?.id,
      target: target.id,
      x: target.x,
      y: target.y,
      color: source?.color,
    });

    if (target.health <= 0) {
      target.health = 0;
      this.applyLethal(target, source && source !== target ? source : null, 'a bullet');
    }
  }

  private updatePickups(): void {
    for (const p of this.pickups) {
      if (!p.active) {
        if (this.tick >= p.respawnAt) {
          const spot = this.randomPickupSpot();
          p.x = spot.x;
          p.y = spot.y;
          p.type = this.rng.int(0, 1);
          p.active = true;
        }
        continue;
      }
      for (const b of this.bots) {
        if (!b.alive) continue;
        if (Math.hypot(b.x - p.x, b.y - p.y) > PICKUP_RADIUS + BOT_RADIUS) continue;
        if (p.type === 0) b.health = Math.min(BOT_MAX_HEALTH, b.health + PICKUP_HEAL);
        else b.ammo = MAG_SIZE;
        b.stats.pickups++;
        p.active = false;
        p.respawnAt = this.tick + Math.floor(PICKUP_RESPAWN * TICK_RATE);
        this.events.push({ tick: this.tick, type: 'pickup', actor: b.id, x: p.x, y: p.y, color: b.color });
        break;
      }
    }
  }

  private updateZone(): void {
    const grace = this.maxTicks * ZONE_GRACE_FRACTION;
    if (this.tick > grace) {
      const k = Math.min(1, (this.tick - grace) / Math.max(1, this.maxTicks - grace));
      this.zoneR = this.zoneR0 + (this.zoneR1 - this.zoneR0) * k;
    }

    for (const b of this.bots) {
      if (!b.alive) continue;
      const outside = Math.hypot(b.x - this.zoneX, b.y - this.zoneY) > this.zoneR;
      if (outside !== b.danger) {
        b.danger = outside;
        this.events.push({
          tick: this.tick,
          type: 'hit',
          target: b.id,
          x: b.x,
          y: b.y,
          color: '#ff2d2d',
          text: outside ? `${b.name} is outside the zone` : `${b.name} is back inside`,
        });
      }
      if (outside) {
        b.health -= ZONE_DPS * DT;
        b.stats.damageTaken += ZONE_DPS * DT;
        b.hitFlash = Math.max(b.hitFlash, 0.08);
        if (b.health <= 0) {
          b.health = 0;
          this.applyLethal(b, null, 'the zone');
        }
      }
    }
  }

  /** Shared death bookkeeping. `source` may be null (zone, self-damage). */
  private applyLethal(target: Bot, source: Bot | null, cause: string): void {
    if (!target.alive) return;
    target.alive = false;
    if (source && source !== target) source.stats.kills++;
    this.events.push({
      tick: this.tick,
      type: 'kill',
      actor: source?.id,
      target: target.id,
      x: target.x,
      y: target.y,
      color: source?.color,
      text: source ? `${source.name} eliminated ${target.name}` : `${target.name} was killed by ${cause}`,
    });
    this.events.push({
      tick: this.tick,
      type: 'death',
      target: target.id,
      x: target.x,
      y: target.y,
      color: target.color,
    });
  }

  private postUpdate(): void {
    for (const b of this.bots) {
      if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - DT);
      if (b.memAge < 1000) b.memAge += DT;
    }
  }

  private checkEnd(): void {
    let aliveCount = 0;
    let lastAlive = -1;
    for (let i = 0; i < this.bots.length; i++) {
      if (this.bots[i].alive) {
        aliveCount++;
        lastAlive = i;
      }
    }
    if (aliveCount <= 1) {
      this.over = true;
      this.winner = aliveCount === 1 ? lastAlive : -1;
      this.emitRoundEnd();
      return;
    }
    if (this.tick >= this.maxTicks) {
      this.over = true;
      this.winner = this.decideOnPoints();
      this.emitRoundEnd();
    }
  }

  /** At time-out the healthier bot wins; ties broken by damage dealt, then draw. */
  private decideOnPoints(): number {
    const [a, b] = this.bots;
    if (!a || !b) return -1;
    const ha = a.alive ? a.healthFraction : -1;
    const hb = b.alive ? b.healthFraction : -1;
    if (Math.abs(ha - hb) > 0.02) return ha > hb ? 0 : 1;
    if (Math.abs(a.stats.damageDealt - b.stats.damageDealt) > 1) {
      return a.stats.damageDealt > b.stats.damageDealt ? 0 : 1;
    }
    return -1;
  }

  private emitRoundEnd(): void {
    const text =
      this.winner >= 0 ? `${this.bots[this.winner].name} wins the round` : 'Draw';
    this.events.push({ tick: this.tick, type: 'roundEnd', x: 0, y: 0, text });
  }

  private randomPickupSpot(): { x: number; y: number } {
    for (let attempt = 0; attempt < 64; attempt++) {
      const tx = this.rng.int(2, this.map.gw - 3);
      const ty = this.rng.int(2, this.map.gh - 3);
      if (this.map.solidAt(tx, ty)) continue;
      const x = (tx + 0.5) * this.map.tile;
      const y = (ty + 0.5) * this.map.tile;
      if (this.map.spawns.some((s) => Math.hypot(s.x - x, s.y - y) < 120)) continue;
      return { x, y };
    }
    return { x: this.map.width / 2, y: this.map.height / 2 };
  }

  // ------------------------------------------------------------ observation

  private observe(b: Bot): void {
    const o = b.obs;
    o.fill(0);

    o[0] = b.x / WORLD_W;
    o[1] = b.y / WORLD_H;
    o[2] = b.vx / BOT_SPEED;
    o[3] = b.vy / BOT_SPEED;
    o[4] = b.health / BOT_MAX_HEALTH;
    o[5] = b.ammo / MAG_SIZE;
    o[6] = clamp01(b.cooldown / FIRE_COOLDOWN);
    o[7] = Math.sin(b.angle);
    o[8] = Math.cos(b.angle);

    // --- raycast fan (the single most important sensor) -------------------
    const step = (Math.PI * 2) / RAY_COUNT;
    let oi = OBS_RAYS;
    for (let i = 0; i < RAY_COUNT; i++) {
      const a = b.angle + i * step;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let dist = raycastTiles(this.map, b.x, b.y, dx, dy, RAY_RANGE);
      let isWall = 0;
      let isEnemy = 0;
      let isAlly = 0;
      for (const other of this.bots) {
        if (other === b || !other.alive) continue;
        const t = rayCircle(b.x, b.y, dx, dy, other.x, other.y, BOT_RADIUS);
        if (t >= 0 && t < dist) {
          dist = t;
          if (other.team === b.team) isAlly = 1;
          else isEnemy = 1;
        }
      }
      if (isEnemy === 0 && isAlly === 0) isWall = dist < RAY_RANGE ? 1 : 0;
      o[oi++] = Math.min(1, dist / RAY_RANGE);
      o[oi++] = isWall;
      o[oi++] = isEnemy;
      o[oi++] = isAlly;
    }

    // --- nearest friend and foe ------------------------------------------
    let enemy: Bot | null = null;
    let enemyDist = Infinity;
    let ally: Bot | null = null;
    let allyDist = Infinity;
    for (const other of this.bots) {
      if (other === b || !other.alive) continue;
      const d = Math.hypot(other.x - b.x, other.y - b.y);
      if (other.team === b.team) {
        if (d < allyDist) {
          allyDist = d;
          ally = other;
        }
      } else if (d < enemyDist) {
        enemyDist = d;
        enemy = other;
      }
    }

    let eo = OBS_ENEMY;
    // Refresh line of sight lazily; it changes slowly and raycasts are the
    // expensive part of the tick.
    if (enemy && this.tick % 3 === 0) {
      b.losClear = hasLineOfSight(this.map, b.x, b.y, enemy.x, enemy.y);
    }
    if (enemy) {
      const relx = enemy.x - b.x;
      const rely = enemy.y - b.y;
      const bearing = wrapAngle(Math.atan2(rely, relx) - b.angle);
      o[eo++] = clampUnit(relx / REL_RANGE);
      o[eo++] = clampUnit(rely / REL_RANGE);
      o[eo++] = clamp01(enemyDist / REL_RANGE);
      o[eo++] = enemy.health / BOT_MAX_HEALTH;
      o[eo++] = b.losClear ? 1 : 0;
      o[eo++] = bearing / Math.PI;
      if (b.losClear) {
        b.memX = enemy.x;
        b.memY = enemy.y;
        b.memAge = 0;
        // Dense shaping signal: "I had a shot". Without this, early random
        // populations land almost no damage and selection has nothing to grip.
        if (Math.abs(bearing) < 0.35 && enemyDist < RAY_RANGE + 60) {
          b.stats.shotOpportunityTicks += DECISION_INTERVAL;
        }
      }
    } else {
      eo += 6;
    }

    let ao = OBS_ALLY;
    if (ally) {
      o[ao++] = clampUnit((ally.x - b.x) / REL_RANGE);
      o[ao++] = clampUnit((ally.y - b.y) / REL_RANGE);
      o[ao++] = clamp01(allyDist / REL_RANGE);
      o[ao++] = ally.health / BOT_MAX_HEALTH;
    } else {
      ao += 4;
    }

    let mo = OBS_MEMORY;
    if (b.memAge < MEMORY_MAX_AGE) {
      o[mo++] = clampUnit((b.memX - b.x) / REL_RANGE);
      o[mo++] = clampUnit((b.memY - b.y) / REL_RANGE);
      o[mo++] = b.memAge / MEMORY_MAX_AGE;
    } else {
      o[mo++] = 0;
      o[mo++] = 0;
      o[mo++] = 1;
    }

    let po = OBS_PICKUP;
    let bestPickup: Pickup | null = null;
    let bestPickupDist = Infinity;
    for (const p of this.pickups) {
      if (!p.active) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < bestPickupDist) {
        bestPickupDist = d;
        bestPickup = p;
      }
    }
    if (bestPickup) {
      o[po++] = clampUnit((bestPickup.x - b.x) / REL_RANGE);
      o[po++] = clampUnit((bestPickup.y - b.y) / REL_RANGE);
      o[po++] = clamp01(bestPickupDist / REL_RANGE);
      o[po++] = bestPickup.type === 0 ? 1 : 0;
      o[po++] = bestPickup.type === 1 ? 1 : 0;
    } else {
      po += 5;
    }

    o[OBS_TIME] = clamp01(this.tick / this.maxTicks);

    // --- safe zone --------------------------------------------------------
    // This must be in the observation, not just painted on screen: a baseline
    // that cannot see the zone dies to it, and evolution then "wins" by
    // outlasting rather than out-fighting, which is not a strategy, it is an
    // information asymmetry.
    const toZoneX = this.zoneX - b.x;
    const toZoneY = this.zoneY - b.y;
    const zoneDist = Math.hypot(toZoneX, toZoneY);
    o[OBS_ZONE] = clampUnit(toZoneX / REL_RANGE);
    o[OBS_ZONE + 1] = clampUnit(toZoneY / REL_RANGE);
    o[OBS_ZONE + 2] = clamp((zoneDist - this.zoneR) / REL_RANGE, -1.5, 1.5);
  }

  // ------------------------------------------------------------- inspection

  drainEvents(): WorldEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  snapshot(info: Partial<Snapshot['info']> = {}): Snapshot {
    const bots: BotSnapshot[] = this.bots.map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      x: round2(b.x),
      y: round2(b.y),
      angle: round3(b.angle),
      health: Math.max(0, Math.round(b.health)),
      maxHealth: BOT_MAX_HEALTH,
      alive: b.alive,
      elo: Math.round(b.elo),
      generation: b.generation,
      reloading: b.reloadTimer > 0,
      ammo: b.ammo,
      hitFlash: round2(b.hitFlash),
      kills: b.stats.kills,
      danger: b.danger,
    }));

    const bullets: BulletSnapshot[] = this.bullets.map((bl) => ({
      x: round2(bl.x),
      y: round2(bl.y),
      px: round2(bl.px),
      py: round2(bl.py),
      owner: bl.ownerIndex,
    }));

    const pickups: PickupSnapshot[] = this.pickups
      .filter((p) => p.active)
      .map((p) => ({ x: round2(p.x), y: round2(p.y), type: p.type }));

    return {
      bots,
      bullets,
      pickups,
      events: [],
      zone: { x: round2(this.zoneX), y: round2(this.zoneY), r: round2(this.zoneR) },
      info: {
        generation: 0,
        round: 0,
        tick: this.tick,
        elapsed: round2(this.tick * DT),
        maxElapsed: round2(this.maxTicks * DT),
        mapSeed: this.map.seed,
        champion: { name: '', elo: 0, generation: 0 },
        challenger: { name: '', elo: 0, generation: 0 },
        scoreboard: { champion: 0, challenger: 0, draws: 0 },
        ticksPerSecond: 0,
        ...info,
      },
    };
  }
}

// ------------------------------------------------------------------ geometry

export function rayCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const mx = ox - cx;
  const my = oy - cy;
  const b = mx * dx + my * dy;
  const c = mx * mx + my * my - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

export function segmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  if (t1 < 0 && t2 > 1) return 0;
  return -1;
}

/** Push a circle out of any solid tiles it overlaps. */
export function resolveCircleTiles(map: GameMap, b: { x: number; y: number }): void {
  const r = BOT_RADIUS;
  const tile = map.tile;
  for (let iter = 0; iter < 3; iter++) {
    const minTx = Math.floor((b.x - r) / tile);
    const maxTx = Math.floor((b.x + r) / tile);
    const minTy = Math.floor((b.y - r) / tile);
    const maxTy = Math.floor((b.y + r) / tile);
    let moved = false;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (!map.solidAt(tx, ty)) continue;
        const left = tx * tile;
        const top = ty * tile;
        const right = left + tile;
        const bottom = top + tile;
        const nx = clamp(b.x, left, right);
        const ny = clamp(b.y, top, bottom);
        const dx = b.x - nx;
        const dy = b.y - ny;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = r - d;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        } else {
          const dl = b.x - left;
          const dr = right - b.x;
          const dt = b.y - top;
          const db = bottom - b.y;
          const m = Math.min(dl, dr, dt, db);
          if (m === dl) b.x = left - r;
          else if (m === dr) b.x = right + r;
          else if (m === dt) b.y = top - r;
          else b.y = bottom + r;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  b.x = clamp(b.x, r, map.width - r);
  b.y = clamp(b.y, r, map.height - r);
}

// -------------------------------------------------------------------- utils

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampUnit(v: number): number {
  return v < -1.5 ? -1.5 : v > 1.5 ? 1.5 : v;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
