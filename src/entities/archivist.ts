/**
 * F26 The Archivist — a harmless cataloguer entity whose next-session
 * behavior depends on how often the player photographed it before.
 *
 * The Archivist walks a slow circuit between injected landmark rooms,
 * keeping at least a stand-off radius between itself and the player at
 * all times. It never approaches, never hunts, never vanishes menacingly:
 * it reads the building the way the player does. When the player
 * photographs it (the game forwards the camera-flash event to
 * photograph()), the encounter is recorded into an injected persistent
 * store keyed by run id. The NEXT session's Archivist is constructed
 * against the same store plus the list of prior run ids and comes back
 * changed, per the reaction table:
 *
 *   photos 0            -> 'shy'       (large stand-off, avoids attention)
 *   photos 1..3         -> 'curious'   (pauses to face the player)
 *   photos 4+           -> 'receptive' (small stand-off, works nearby)
 *
 * Pure simulation — no DOM, no Babylon. Determinism law holds: every
 * draw flows through src/core/rng.ts seeded per instance, so the same
 * seed and the same player inputs replay the same trajectory.
 */
import { RNG } from '../core/rng';
import { moveCircle, type CircleBody } from '../world/collision';
import type { Box2 } from '../world/architect';

// ---- injected world ----------------------------------------------------------

/** Minimal persistent store surface consumed by the Archivist (injected). */
export interface ArchivistStore {
  /** Read one previously stored value, or undefined when absent. */
  get(key: string): unknown;
  /** Write one value; implementations persist plain JSON. */
  set(key: string, value: unknown): void;
}

/** One landmark room anchor the Archivist circuits (injected). */
export interface LandmarkRoom {
  x: number;
  z: number;
}

/** Construction-time dependencies for one session's Archivist. */
export interface ArchivistDeps {
  /** Landmark rooms to wander between, in circuit order. */
  landmarks: readonly LandmarkRoom[];
  /** Persistent encounter store shared across sessions. */
  store: ArchivistStore;
  /** This session's run id; encounters are stored under it. */
  runId: string;
  /** Run ids of earlier sessions whose photos shape this one's mood. */
  priorRunIds?: readonly string[];
  /** Sim seed (determinism law). */
  seed: number;
  /** Optional base stand-off override in metres (default BASE_STANDOFF). */
  standoffRadius?: number;
}

// ---- tuning ------------------------------------------------------------------

/** Base stand-off radius in metres before the mood multiplier. */
export const BASE_STANDOFF = 6;

/** Stand-off multipliers per reaction tier. */
export const MOOD_STANDOFF_SCALE: Readonly<Record<ArchivistMood, number>> = {
  shy: 1.5,
  curious: 1.15,
  receptive: 0.9,
};

/** Wander speed between landmarks (m/s). */
export const WANDER_SPEED = 0.8;

/**
 * Retreat speed when the player crowds the stand-off ring (m/s). Set above
 * the player's sprint speed so the stand-off invariant survives any pursuit.
 */
export const RETREAT_SPEED = 4.6;

/** After retreating past this multiple of the stand-off ring, wander resumes. */
export const RESUME_HYSTERESIS = 1.25;

/** Distance at which a landmark counts as reached (metres). */
export const LANDMARK_ARRIVE_RADIUS = 1;

/** Distance inside which a curious/receptive Archivist pauses to face you. */
export const NOTICE_RANGE = 10;

/** Per-second probability of starting a face-you pause while noticed. */
export const FACE_PAUSE_CHANCE_PER_SEC = 0.12;

/** Face-you pause length bounds (seconds). */
export const FACE_PAUSE_MIN_SEC = 2;
export const FACE_PAUSE_MAX_SEC = 5;

/** Store-key prefix; full key is PREFIX + run id. */
export const ARCHIVIST_STORE_PREFIX = 'archivist:v1:';

/** Save format version for stored encounter records. */
const RECORD_VERSION = 1;

// ---- reaction table ----------------------------------------------------------

/** Behavior tier derived from how many times the player has photographed it. */
export type ArchivistMood = 'shy' | 'curious' | 'receptive';

/**
 * Reaction table: photo-count band -> mood.
 *   0 photos -> 'shy', 1..3 -> 'curious', 4+ -> 'receptive'.
 */
export function reactionForPhotos(photoCount: number): ArchivistMood {
  const n = Math.max(0, Math.floor(photoCount));
  if (n <= 0) return 'shy';
  if (n <= 3) return 'curious';
  return 'receptive';
}

/** Plain JSON encounter record persisted under one run id. */
export interface ArchivistEncounterRecord {
  version: number;
  /** Photographs taken of the Archivist during that run. */
  photos: number;
  /** Mood those photos produced for the following session. */
  tier: ArchivistMood;
}

function parseRecord(raw: unknown): ArchivistEncounterRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ArchivistEncounterRecord>;
  if (r.version !== RECORD_VERSION || typeof r.photos !== 'number') return null;
  return { version: RECORD_VERSION, photos: Math.max(0, Math.floor(r.photos)), tier: reactionForPhotos(r.photos) };
}

// ---- entity ------------------------------------------------------------------

/**
 * One session's Archivist. Construct fresh through the constructor (it reads
 * prior encounters from the injected store at build time); photograph()
 * records into the same store for the next session. update() advances one
 * frame: landmark wandering with mood-flavored pauses, plus stand-off
 * maintenance that holds even under direct pursuit.
 */
export class Archivist {
  /** Live position; radius matches the human figures' circle bodies. */
  readonly body: CircleBody;
  /** Mood derived from all encounters recorded before this construction. */
  readonly mood: ArchivistMood;
  /** Total photos recorded across prior runs at construction time. */
  readonly priorPhotos: number;
  /** Current heading the renderer should face the figure toward (radians). */
  facingYaw = 0;

  private readonly deps: ArchivistDeps;
  private readonly rng: RNG;
  private readonly baseStandoff: number;
  private readonly runKey: string;
  private runPhotos = 0;
  private life = 0;
  private waypoint = 0;
  private retreating = false;
  private facePauseUntil = 0;

  constructor(deps: ArchivistDeps) {
    this.deps = deps;
    this.rng = new RNG((deps.seed >>> 0) || 0x9e3779b9);
    this.baseStandoff = deps.standoffRadius ?? BASE_STANDOFF;
    this.runKey = ARCHIVIST_STORE_PREFIX + deps.runId;
    let prior = 0;
    for (const id of deps.priorRunIds ?? []) {
      if (id === deps.runId) continue; // own record is counted separately below
      const rec = parseRecord(deps.store.get(ARCHIVIST_STORE_PREFIX + id));
      if (rec) prior += rec.photos;
    }
    // resuming the same run id (page reload) restores this run's own tally
    const own = parseRecord(deps.store.get(this.runKey));
    if (own) this.runPhotos = own.photos;
    this.priorPhotos = prior;
    this.mood = reactionForPhotos(prior + this.runPhotos);
    const first = deps.landmarks[0];
    const start = first ?? { x: 0, z: 0 };
    this.body = { x: start.x, z: start.z, radius: 0.3 };
    this.waypoint = deps.landmarks.length > 0 ? this.rng.int(0, deps.landmarks.length) : 0;
  }

  /** Effective stand-off radius for the current mood (metres). */
  get standoff(): number {
    return this.baseStandoff * MOOD_STANDOFF_SCALE[this.mood];
  }

  /** Photos recorded during THIS run (this session's own encounters). */
  get photosThisRun(): number {
    return this.runPhotos;
  }

  /**
   * Camera-flash event forwarded by the game when the player photographs the
   * Archivist. Records the encounter under this run id immediately, so a
   * later session constructed against the same store sees it.
   *
   * @returns total photos recorded for this run after this one
   */
  photograph(): number {
    this.runPhotos++;
    const record: ArchivistEncounterRecord = {
      version: RECORD_VERSION,
      photos: this.runPhotos,
      tier: reactionForPhotos(this.runPhotos),
    };
    this.deps.store.set(this.runKey, record);
    return this.runPhotos;
  }

  /**
   * Advance one frame. Wandering keeps the landmark circuit; whenever the
   * player is inside the stand-off ring the Archivist retreats radially at
   * RETREAT_SPEED until clear past RESUME_HYSTERESIS x the ring. A final
   * invariant clamp projects it back onto the ring if a wall corner ever
   * leaves it inside — the stand-off promise outranks positional subtlety.
   */
  update(dt: number, px: number, pz: number, colliders: readonly Box2[]): void {
    if (dt <= 0) return;
    this.life += dt;
    const b = this.body;
    let dx = px - b.x;
    let dz = pz - b.z;
    let dist = Math.hypot(dx, dz);
    if (dist > 1e-9) {
      this.facingYaw = Math.atan2(-dx, -dz); // face away from the player by default
    }

    if (this.retreating) {
      if (dist > 1e-9) {
        const ux = -dx / dist;
        const uz = -dz / dist;
        moveAway(b, ux, uz, RETREAT_SPEED * dt, colliders);
        this.facingYaw = Math.atan2(dx, dz); // facing flight direction
      }
      if (dist > this.standoff * RESUME_HYSTERESIS) this.retreating = false;
    } else {
      // mood flavor: curious/receptive pause and study the player up close
      if (this.mood !== 'shy' && dist <= NOTICE_RANGE && this.life >= this.facePauseUntil) {
        if (this.rng.chance(FACE_PAUSE_CHANCE_PER_SEC * dt)) {
          this.facePauseUntil = this.life + this.rng.range(FACE_PAUSE_MIN_SEC, FACE_PAUSE_MAX_SEC);
          this.facingYaw = Math.atan2(dx, dz); // turn to face the player
        }
      }
      const pausing = this.life < this.facePauseUntil;
      if (pausing) {
        this.facingYaw = Math.atan2(dx, dz);
      } else if (this.deps.landmarks.length > 0) {
        const target = this.deps.landmarks[this.waypoint % this.deps.landmarks.length];
        const tx = target.x - b.x;
        const tz = target.z - b.z;
        const tl = Math.hypot(tx, tz);
        if (tl <= LANDMARK_ARRIVE_RADIUS) {
          this.waypoint = (this.waypoint + 1) % this.deps.landmarks.length;
        } else {
          const step = WANDER_SPEED * dt;
          const nx = b.x + (tx / tl) * step;
          const nz = b.z + (tz / tl) * step;
          // never wander INTO the ring: skip the step if it would close inside
          const nd = Math.hypot(px - nx, pz - nz);
          if (nd >= this.standoff) {
            b.x = nx;
            b.z = nz;
            resolveCircle(b, colliders);
            this.facingYaw = Math.atan2(tx, tz);
          }
        }
      }
      if (dist < this.standoff) this.retreating = true;
    }

    // invariant clamp: after everything, the ring holds
    dx = px - b.x;
    dz = pz - b.z;
    dist = Math.hypot(dx, dz);
    if (dist < this.standoff) {
      if (dist > 1e-9) {
        const push = (this.standoff - dist) + 1e-4;
        b.x -= (dx / dist) * push;
        b.z -= (dz / dist) * push;
      } else {
        b.x += this.standoff; // degenerate co-location: break out along +x
      }
    }
  }
}

// ---- helpers ------------------------------------------------------------------

/** Retreat step with wall sliding. */
function moveAway(body: CircleBody, ux: number, uz: number, step: number, colliders: readonly Box2[]): void {
  moveCircle(body, ux * step, uz * step, colliders);
}

/** Push-out-only resolve for skipped-step cases (no translation requested). */
function resolveCircle(body: CircleBody, colliders: readonly Box2[]): void {
  moveCircle(body, 0, 0, colliders);
}
