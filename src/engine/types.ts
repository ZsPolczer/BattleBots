/** Shared types for the simulation, brains, and the network protocol. */

/** What a brain outputs. Written in place to avoid per-tick allocation. */
export interface Action {
  /** 0..7 = compass direction (x8), 8 = idle */
  move: number;
  /** -1..1, scaled by BOT_TURN_RATE to rotate the body this tick */
  turn: number;
  /** >0 means "hold the trigger" */
  fire: number;
}

export function makeAction(): Action {
  return { move: 8, turn: 0, fire: 0 };
}

export function resetAction(a: Action): void {
  a.move = 8;
  a.turn = 0;
  a.fire = 0;
}

/** Mutable per-bot combat statistics used for fitness and for the broadcast HUD. */
export interface BotStats {
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  kills: number;
  wallHugTicks: number;
  moveTicks: number;
  ticksAlive: number;
  distance: number;
  pickups: number;
  /** Ticks with line of sight and the enemy inside the firing arc. */
  shotOpportunityTicks: number;
}

export function makeStats(): BotStats {
  return {
    damageDealt: 0,
    damageTaken: 0,
    shotsFired: 0,
    shotsHit: 0,
    kills: 0,
    wallHugTicks: 0,
    moveTicks: 0,
    ticksAlive: 0,
    distance: 0,
    pickups: 0,
    shotOpportunityTicks: 0,
  };
}

/** Serialized map, cheap to ship to the browser. */
export interface MapData {
  seed: number;
  gw: number;
  gh: number;
  tile: number;
  /** base64 of a Uint8Array; 0 = floor, 1 = wall, 2 = destructible wall */
  tiles: string;
  spawns: Array<{ x: number; y: number }>;
}

export interface BulletSnapshot {
  x: number;
  y: number;
  px: number;
  py: number;
  owner: number;
}

export interface BotSnapshot {
  id: number;
  name: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  elo: number;
  generation: number;
  reloading: boolean;
  ammo: number;
  hitFlash: number;
  kills: number;
  /** true while standing outside the shrinking safe zone */
  danger?: boolean;
}

export interface PickupSnapshot {
  x: number;
  y: number;
  type: number;
}

export type WorldEventType =
  | 'shot'
  | 'hit'
  | 'kill'
  | 'death'
  | 'pickup'
  | 'spawn'
  | 'roundStart'
  | 'roundEnd';

export interface WorldEvent {
  tick: number;
  type: WorldEventType;
  actor?: number;
  target?: number;
  x?: number;
  y?: number;
  text?: string;
  color?: string;
}

export interface MatchInfo {
  generation: number;
  round: number;
  tick: number;
  elapsed: number;
  maxElapsed: number;
  mapSeed: number;
  /** Increments every round so the viewer knows when to refetch the map. */
  mapVersion?: number;
  /** 'fight' while the round runs, 'intermission' during the post-round beat. */
  phase?: 'fight' | 'intermission';
  /** Consecutive wins by the reigning champion ("king of the hill"). */
  defenses?: number;
  champion: { name: string; elo: number; generation: number };
  challenger: { name: string; elo: number; generation: number };
  scoreboard: { champion: number; challenger: number; draws: number };
  ticksPerSecond: number;
}

export interface Snapshot {
  map?: MapData;
  bots: BotSnapshot[];
  bullets: BulletSnapshot[];
  pickups: PickupSnapshot[];
  events: WorldEvent[];
  info: MatchInfo;
  /** Safe zone; anything outside it takes damage. */
  zone?: { x: number; y: number; r: number };
}
