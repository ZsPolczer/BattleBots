/**
 * Procedural arenas on a uniform tile grid.
 *
 * A tile grid (rather than arbitrary wall rectangles) buys us three things:
 *  - DDA raycasting that is fast enough to give every bot 16 rays per tick,
 *  - trivial collision resolution,
 *  - destructible walls later, for free.
 */

import { GRID_H, GRID_W, TILE, WORLD_H, WORLD_W } from './constants.js';
import { Rng, deriveSeed } from './rng.js';
import type { MapData } from './types.js';

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;
export const TILE_DESTRUCTIBLE = 2;

export interface MapOptions {
  gw?: number;
  gh?: number;
  /** mirror the left half onto the right half so no spawn is favoured */
  symmetric?: boolean;
  /** 0..1, roughly how much furniture to scatter */
  clutter?: number;
  rooms?: number;
  destructible?: boolean;
  botCount?: number;
}

export class GameMap {
  readonly gw: number;
  readonly gh: number;
  readonly tile: number;
  readonly tiles: Uint8Array;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly spawns: Array<{ x: number; y: number }>;

  constructor(
    gw: number,
    gh: number,
    tile: number,
    tiles: Uint8Array,
    seed: number,
    spawns: Array<{ x: number; y: number }>,
  ) {
    this.gw = gw;
    this.gh = gh;
    this.tile = tile;
    this.tiles = tiles;
    this.seed = seed;
    this.width = gw * tile;
    this.height = gh * tile;
    this.spawns = spawns;
  }

  /** Solid for the purposes of movement / raycasts. */
  solidAt(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.gw || ty >= this.gh) return true;
    return this.tiles[ty * this.gw + tx] !== TILE_FLOOR;
  }

  solidWorld(x: number, y: number): boolean {
    return this.solidAt(Math.floor(x / this.tile), Math.floor(y / this.tile));
  }

  toData(): MapData {
    return {
      seed: this.seed,
      gw: this.gw,
      gh: this.gh,
      tile: this.tile,
      tiles: Buffer.from(this.tiles).toString('base64'),
      spawns: this.spawns.map((s) => ({ x: s.x, y: s.y })),
    };
  }
}

/**
 * Amanatides & Woo grid traversal. Returns the distance to the first solid tile
 * along the ray, or `maxDist` if nothing was hit.
 */
export function raycastTiles(
  map: GameMap,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  maxDist: number,
): number {
  const tile = map.tile;
  let tx = Math.floor(x0 / tile);
  let ty = Math.floor(y0 / tile);
  if (map.solidAt(tx, ty)) return 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const invDx = dx !== 0 ? 1 / dx : Infinity;
  const invDy = dy !== 0 ? 1 / dy : Infinity;
  const tDeltaX = dx !== 0 ? Math.abs(tile * invDx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(tile * invDy) : Infinity;

  let tMaxX = dx !== 0 ? ((stepX > 0 ? (tx + 1) * tile : tx * tile) - x0) * invDx : Infinity;
  let tMaxY = dy !== 0 ? ((stepY > 0 ? (ty + 1) * tile : ty * tile) - y0) * invDy : Infinity;

  let t = 0;
  let guard = 0;
  while (guard++ < 1024) {
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tx += stepX;
      tMaxX += tDeltaX;
    } else {
      t = tMaxY;
      ty += stepY;
      tMaxY += tDeltaY;
    }
    if (t > maxDist) return maxDist;
    if (t < 0) continue; // numeric edge case when starting exactly on a boundary
    if (map.solidAt(tx, ty)) return t;
  }
  return maxDist;
}

/** True if there is an unobstructed line between the two points. */
export function hasLineOfSight(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const hit = raycastTiles(map, x0, y0, dx / d, dy / d, d - 1);
  return hit >= d - 1;
}

/** Distance from a point to the nearest solid tile surface (approximate, tile-quantised). */
export function distanceToWall(map: GameMap, x: number, y: number, maxSearch = 120): number {
  const tile = map.tile;
  const r = Math.ceil(maxSearch / tile);
  const ctx = Math.floor(x / tile);
  const cty = Math.floor(y / tile);
  if (map.solidAt(ctx, cty)) return 0;
  let best = maxSearch;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!map.solidAt(ctx + dx, cty + dy)) continue;
      const nx = Math.max(ctx * tile, Math.min(x, (ctx + dx) * tile + tile));
      const ny = Math.max(cty * tile, Math.min(y, (cty + dy) * tile + tile));
      const d = Math.hypot(x - nx, y - ny);
      if (d < best) best = d;
    }
  }
  return best;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Generate an arena: fill everything with wall, carve rooms, connect them with
 * corridors, then scatter some cover. Mirrored horizontally if `symmetric`.
 */
export function generateMap(seed: number, opts: MapOptions = {}): GameMap {
  const gw = opts.gw ?? GRID_W;
  const gh = opts.gh ?? GRID_H;
  const tile = TILE;
  const rng = new Rng(seed);
  const tiles = new Uint8Array(gw * gh).fill(TILE_WALL);

  const carveRect = (r: Rect) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x <= 0 || y <= 0 || x >= gw - 1 || y >= gh - 1) continue;
        tiles[y * gw + x] = TILE_FLOOR;
      }
    }
  };

  const carveCorridor = (ax: number, ay: number, bx: number, by: number, width: number) => {
    const half = Math.floor(width / 2);
    const loX = Math.min(ax, bx);
    const hiX = Math.max(ax, bx);
    for (let x = loX; x <= hiX; x++) {
      for (let w = -half; w <= half; w++) {
        const y = ay + w;
        if (x > 0 && y > 0 && x < gw - 1 && y < gh - 1) tiles[y * gw + x] = TILE_FLOOR;
      }
    }
    const loY = Math.min(ay, by);
    const hiY = Math.max(ay, by);
    for (let y = loY; y <= hiY; y++) {
      for (let w = -half; w <= half; w++) {
        const x = bx + w;
        if (x > 0 && y > 0 && x < gw - 1 && y < gh - 1) tiles[y * gw + x] = TILE_FLOOR;
      }
    }
  };

  const halfW = opts.symmetric ? Math.floor(gw / 2) : gw;
  const roomCount = opts.rooms ?? rng.int(6, 10);
  const rooms: Rect[] = [];

  for (let attempt = 0; attempt < roomCount * 14 && rooms.length < roomCount; attempt++) {
    const w = rng.int(4, 9);
    const h = rng.int(4, 9);
    // In symmetric mode the left half must be able to reach the mirror seam,
    // otherwise mirroring leaves a solid wall band down the middle.
    const maxX = (opts.symmetric ? halfW : gw) - w;
    const x = rng.int(1, Math.max(1, maxX));
    const y = rng.int(1, gh - h - 2);
    if (x < 1 || y < 1) continue;
    const r: Rect = { x, y, w, h };
    const overlaps = rooms.some(
      (o) => x < o.x + o.w + 2 && x + w + 2 > o.x && y < o.y + o.h + 2 && y + h + 2 > o.y,
    );
    if (overlaps) continue;
    rooms.push(r);
    carveRect(r);
  }

  if (rooms.length === 0) {
    carveRect({ x: 2, y: 2, w: gw - 4, h: gh - 4 });
    rooms.push({ x: 2, y: 2, w: gw - 4, h: gh - 4 });
  }

  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1];
    const b = rooms[i];
    carveCorridor(
      Math.floor(a.x + a.w / 2),
      Math.floor(a.y + a.h / 2),
      Math.floor(b.x + b.w / 2),
      Math.floor(b.y + b.h / 2),
      rng.int(1, 2) === 1 ? 1 : 2,
    );
  }
  // A couple of extra loops make the arena feel less like a tree and more like a map.
  for (let i = 0; i < 2 && rooms.length > 2; i++) {
    const a = rng.pick(rooms);
    const b = rng.pick(rooms);
    carveCorridor(
      Math.floor(a.x + a.w / 2),
      Math.floor(a.y + a.h / 2),
      Math.floor(b.x + b.w / 2),
      Math.floor(b.y + b.h / 2),
      1,
    );
  }

  // Scatter cover: small pillars and short walls.
  const clutter = opts.clutter ?? 0.035;
  const clutterCount = Math.floor(gw * gh * clutter);
  for (let i = 0; i < clutterCount; i++) {
    const x = rng.int(2, Math.max(2, halfW - 2));
    const y = rng.int(2, gh - 3);
    if (tiles[y * gw + x] !== TILE_FLOOR) continue;
    const w = rng.chance(0.6) ? 1 : rng.int(2, 3);
    const h = rng.chance(0.6) ? 1 : rng.int(2, 3);
    for (let yy = y; yy < y + h && yy < gh - 1; yy++) {
      for (let xx = x; xx < x + w && xx < halfW; xx++) {
        if (tiles[yy * gw + xx] === TILE_FLOOR) {
          tiles[yy * gw + xx] = opts.destructible && rng.chance(0.5) ? TILE_DESTRUCTIBLE : TILE_WALL;
        }
      }
    }
  }

  // Mirror.
  if (opts.symmetric) {
    const half = Math.floor(gw / 2);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < half; x++) {
        tiles[y * gw + (gw - 1 - x)] = tiles[y * gw + x];
      }
    }
  }

  // Guarantee the arena is one connected space. Without this, mirrored maps and
  // aggressive clutter occasionally seal a bot into a pocket, which shows up as
  // "evolution learned to stand still" and is really a level-design bug.
  ensureConnectivity(gw, gh, tiles);

  // A full-width "main street" does two jobs: it makes the mirrored halves
  // connected by something wider than a one-tile tunnel, and it gives the
  // broadcast a long sightline where fights actually start.
  const streetY = rng.int(3, Math.max(4, gh - 6));
  const streetH = rng.chance(0.5) ? 1 : 2;
  for (let y = streetY; y < streetY + streetH && y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) tiles[y * gw + x] = TILE_FLOOR;
  }

  const map = new GameMap(gw, gh, tile, tiles, seed, []);
  const spawns = pickSpawns(map, rng, opts.botCount ?? 2, opts.symmetric ?? false);
  return new GameMap(gw, gh, tile, tiles, seed, spawns);
}

/** Nearest walkable point to (x, y), spiralling outward over tiles. */
export function nearestOpenPoint(
  map: GameMap,
  x: number,
  y: number,
  maxTiles = 24,
): { x: number; y: number } {
  const ctx = Math.floor(x / map.tile);
  const cty = Math.floor(y / map.tile);
  const toPoint = (tx: number, ty: number) => ({
    x: (tx + 0.5) * map.tile,
    y: (ty + 0.5) * map.tile,
  });
  if (!map.solidAt(ctx, cty)) return { x, y };
  for (let r = 1; r <= maxTiles; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // only the ring, not the filled square
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = ctx + dx;
        const ty = cty + dy;
        if (tx < 1 || ty < 1 || tx >= map.gw - 1 || ty >= map.gh - 1) continue;
        if (map.solidAt(tx, ty)) continue;
        return toPoint(tx, ty);
      }
    }
  }
  return { x, y };
}

/**
 * Flood fill the open tiles and tunnel between disconnected regions so the map
 * is always fully traversable.
 */
function ensureConnectivity(gw: number, gh: number, tiles: Uint8Array): void {
  const inside = (x: number, y: number) => x > 0 && y > 0 && x < gw - 1 && y < gh - 1;
  const open = (x: number, y: number) => inside(x, y) && tiles[y * gw + x] === TILE_FLOOR;

  const label = new Int32Array(gw * gh).fill(-1);
  const components: number[][] = [];
  const stack: number[] = [];

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const start = y * gw + x;
      if (label[start] !== -1 || !open(x, y)) continue;
      const id = components.length;
      const cells: number[] = [];
      label[start] = id;
      stack.push(start);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        cells.push(cur);
        const cx = cur % gw;
        const cy = (cur / gw) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (!open(nx, ny)) continue;
          const ni = ny * gw + nx;
          if (label[ni] !== -1) continue;
          label[ni] = id;
          stack.push(ni);
        }
      }
      components.push(cells);
    }
  }

  if (components.length <= 1) return;
  components.sort((a, b) => b.length - a.length);
  const target = components[0];

  for (let i = 1; i < components.length; i++) {
    const from = components[i][0];
    const ax = from % gw;
    const ay = (from / gw) | 0;
    let best = target[0];
    let bestDist = Infinity;
    for (const t of target) {
      const tx = t % gw;
      const ty = (t / gw) | 0;
      const d = Math.abs(tx - ax) + Math.abs(ty - ay);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    const bx = best % gw;
    const by = (best / gw) | 0;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    for (let x = x0; x <= x1; x++) {
      if (inside(x, ay)) tiles[ay * gw + x] = TILE_FLOOR;
    }
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    for (let y = y0; y <= y1; y++) {
      if (inside(bx, y)) tiles[y * gw + bx] = TILE_FLOOR;
    }
    // Everything carved here is now part of the target region for later passes.
    for (let x = x0; x <= x1; x++) if (inside(x, ay)) target.push(ay * gw + x);
    for (let y = y0; y <= y1; y++) if (inside(bx, y)) target.push(y * gw + bx);
  }
}

/**
 * Farthest-point sampling over open tiles, preferring spawns without line of
 * sight. Falls back to progressively looser clearance so a bot can never be
 * placed inside geometry — a spawn inside a wall looks exactly like "the AI is
 * broken" on stream and is a nightmare to debug from the outside.
 */
function pickSpawns(
  map: GameMap,
  rng: Rng,
  count: number,
  symmetric: boolean,
): Array<{ x: number; y: number }> {
  const tile = map.tile;
  let candidates: Array<{ x: number; y: number }> = [];

  for (const clear of [1, 0]) {
    candidates = [];
    for (let ty = clear; ty < map.gh - clear; ty++) {
      for (let tx = clear; tx < map.gw - clear; tx++) {
        let ok = true;
        for (let dy = -clear; dy <= clear && ok; dy++) {
          for (let dx = -clear; dx <= clear; dx++) {
            if (map.solidAt(tx + dx, ty + dy)) {
              ok = false;
              break;
            }
          }
        }
        if (ok) candidates.push({ x: (tx + 0.5) * tile, y: (ty + 0.5) * tile });
      }
    }
    if (candidates.length >= count) break;
  }

  if (candidates.length === 0) {
    // Should be unreachable thanks to ensureConnectivity, but never ship a
    // crash just because a map generator had a bad day.
    return Array.from({ length: count }, (_, i) => ({
      x: map.width * (0.25 + 0.5 * (i / Math.max(1, count - 1))),
      y: map.height / 2,
    }));
  }

  const spawns: Array<{ x: number; y: number }> = [candidates[rng.int(0, candidates.length - 1)]];

  // Two-player symmetric arenas get mirrored spawns. The arena is mirrored about
  // the vertical axis, so the reflection must be too — a 180-degree rotation
  // would land on tiles the mirror never touched (the "main street" is carved
  // after mirroring).
  if (symmetric && count === 2) {
    const first = spawns[0];
    const mirrored = { x: map.width - first.x, y: first.y };
    if (!map.solidWorld(mirrored.x, mirrored.y)) {
      return [first, mirrored];
    }
  }

  while (spawns.length < count) {
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    const sampleCount = Math.min(candidates.length, 120);
    for (let i = 0; i < sampleCount; i++) {
      const c = candidates[rng.int(0, candidates.length - 1)];
      let minDist = Infinity;
      let losAll = 0;
      for (const s of spawns) {
        const d = Math.hypot(c.x - s.x, c.y - s.y);
        minDist = Math.min(minDist, d);
        if (hasLineOfSight(map, c.x, c.y, s.x, s.y)) losAll++;
      }
      // Prefer far apart, and prefer *not* having line of sight to everyone.
      const score = minDist - losAll * 120;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    spawns.push(best!);
  }
  return spawns;
}

export function mapSize(gw = GRID_W, gh = GRID_H): { w: number; h: number } {
  return { w: gw * TILE, h: gh * TILE };
}

export function defaultMapSeed(base: number, index: number): number {
  return deriveSeed(base, index) ^ 0x5bf03635;
}

export const MAP_WORLD_W = WORLD_W;
export const MAP_WORLD_H = WORLD_H;
