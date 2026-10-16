/**
 * Global, hard-coded simulation constants.
 *
 * Everything the simulation does is a pure function of (map seed, brain weights).
 * Never introduce non-deterministic values here (no Date.now, no Math.random).
 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

// --- World geometry -------------------------------------------------------
export const TILE = 25;
export const GRID_W = 40;
export const GRID_H = 40;
export const WORLD_W = TILE * GRID_W; // 1000
export const WORLD_H = TILE * GRID_H; // 1000

// --- Bot ------------------------------------------------------------------
export const BOT_RADIUS = 11;
export const BOT_MAX_HEALTH = 100;
export const BOT_SPEED = 165; // px / s
export const BOT_TURN_RATE = 13; // rad / s (twin-stick style, independent of movement)
export const BOT_ACCEL = 14; // velocity smoothing factor (higher = snappier)

// --- Weapon: baseline machine gun ----------------------------------------
export const BULLET_SPEED = 620;
export const BULLET_DAMAGE = 7;
export const BULLET_LIFE = 1.4; // seconds
export const BULLET_RADIUS = 3;
export const FIRE_COOLDOWN = 0.14; // seconds between shots
export const MAG_SIZE = 30;
export const RELOAD_TIME = 1.3;
export const SPREAD = 0.035; // radians of random spread per shot

// --- Sensors --------------------------------------------------------------
export const RAY_COUNT = 16;
export const RAY_RANGE = 380;
export const REL_RANGE = 520; // normalisation range for relative-position features
export const MEMORY_MAX_AGE = 3; // seconds before "last seen enemy" is forgotten
export const WALL_HUG_DIST = 19; // how close to a wall counts as hugging
export const WALL_HUG_SPEED = 0.35; // fraction of max speed that counts as "slow"

// --- Agent pacing ---------------------------------------------------------
// Brains think every N ticks and the chosen action is held in between. Halves
// the cost of sensing and inference, and makes behaviour slightly more
// deliberate (and much more readable) without feeling laggy at 60Hz.
export const DECISION_INTERVAL = 2;
/** Fraction of the match during which wall-hugging is penalised. */
export const WALL_HUG_WINDOW = 0.6;

// --- Pickups --------------------------------------------------------------
export const PICKUP_RADIUS = 13;
export const PICKUP_HEAL = 35;
export const PICKUP_AMMO = 30;
export const PICKUP_RESPAWN = 9; // seconds

// --- Match ----------------------------------------------------------------
export const MAX_MATCH_TICKS = TICK_RATE * 45; // 45 seconds hard cap

// --- Shrinking safe zone --------------------------------------------------
// Without this, "learning" degenerates into hide-and-seek on maze maps and the
// fitness signal is mostly noise. It also reads great on stream.
export const ZONE_COMFORT = 70; // how far outside counts as "get back in, now"
export const ZONE_GRACE_FRACTION = 0.18;
export const ZONE_MIN_RADIUS = 130;
/** Start radius as a fraction of the map diagonal, so the zone covers everything at first. */
export const ZONE_START_FRACTION = 0.55;
export const ZONE_DPS = 9;

// --- Observation vector layout -------------------------------------------
// self block (9)
export const OBS_SELF = 0;
export const OBS_RAYS = OBS_SELF + 9;
export const OBS_ENEMY = OBS_RAYS + RAY_COUNT * 4;
export const OBS_ALLY = OBS_ENEMY + 6;
export const OBS_MEMORY = OBS_ALLY + 4;
export const OBS_PICKUP = OBS_MEMORY + 3;
// zone: [relative x, relative y, signed distance to the edge (+ = outside)]
export const OBS_ZONE = OBS_PICKUP + 5;
export const OBS_TIME = OBS_ZONE + 3;
export const OBS_SIZE = OBS_TIME + 1;

// --- Action vector layout -------------------------------------------------
export const ACT_MOVE = 9; // 8 directions + idle (argmax)
export const ACT_TURN = 1; // continuous turn in [-1, 1] * BOT_TURN_RATE
export const ACT_FIRE = 1; // > 0 means trigger down
export const ACT_SIZE = ACT_MOVE + ACT_TURN + ACT_FIRE;
