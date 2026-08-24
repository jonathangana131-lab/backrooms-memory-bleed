/** Manages live reconstructed humans around the player. */
import type { Scene } from '@babylonjs/core/scene';
import { HumanFigure, type HumanType } from './humans';
import type { Box2 } from '../world/architect';

/** One live figure's distance to the player, rebuilt every update(). */
export interface ProximityEntry {
  figure: HumanFigure;
  type: HumanType;
  /** straight-line distance to the player in meters */
  dist: number;
}

/** All HumanTypes, used when group dynamics ask a spawn to diversify. */
const ALL_TYPES: readonly HumanType[] = ['watcher', 'wanderer', 'helper', 'incomplete', 'believer', 'double'];

/** Two live entities of the same archetype within this range count as a cluster. */
const CLUSTER_RADIUS = 15;
/** Same archetype on the same rounded tile is suppressed for this long (seconds). */
const SPAWN_MEMORY_TTL = 120;
/** Movement thresholds (m/s) matching PlayerController speeds: crouch 1.15, walk 2.35, sprint 4.4. */
const STILL_SPEED = 0.3;
const SPRINT_SPEED = 3.4;

/** Rolling behavior profile of the player, refreshed by update(). */
export interface PlayerProfile {
  /** seconds of behavior observed so far */
  observedSec: number;
  /** seconds spent essentially stationary */
  stillTimeSec: number;
  /** seconds spent moving faster than walk pace */
  sprintTimeSec: number;
  /** fraction of observed time sprinting (0..1) */
  sprintRatio: number;
  /** fraction of observed time with the torch beam on (0..1) */
  torchOnRatio: number;
  /** 0..1 - high sprint + high torch use reads as confident */
  confidence: number;
  /** 0..1 - inverse of confidence; standing still adds caution */
  cautiousness: number;
}

export class HumanManager {
  figures: HumanFigure[] = [];
  /** incremented when a watcher vanishes close to the player */
  vanishEvents = 0;
  /** set by the game for audio/light feedback */
  onWatcherVanish: (() => void) | null = null;
  /** fired when a watcher is first caught in the torch beam */
  onBeamFreeze: (() => void) | null = null;
  /** one entry per live figure with its player distance; refreshed every update() */
  proximities: ProximityEntry[] = [];
  /** optional per-frame callback for driving audio proximity layers */
  onProximity: ((entries: readonly ProximityEntry[]) => void) | null = null;
  /** interesting prop positions (batteries, signs) wanderers stop to inspect */
  interestPoints: ReadonlyArray<{ x: number; z: number }> = [];

  /**
   * Adaptive difficulty bias, 0..1 (clamped).
   *   0 = aggressive: spawns pull close to a confident player
   *   1 = passive:    spawns push far from a cautious player
   * Set externally via setDifficultyBias(); also auto-suggested from the
   * behavior profile (see getPlayerProfile().cautiousness).
   */
  difficultyBias = 0.5;
  /** distance multiplier bounds applied by scaledDistance() */
  static readonly BIAS_MIN_SCALE = 0.7;
  static readonly BIAS_MAX_SCALE = 1.45;
  /** spawn memory: "type:x:z" -> clock seconds of last spawn there */
  private spawnMemory = new Map<string, number>();
  /** internal clock advanced by update(dt); drives memory TTLs and profiling */
  private clock = 0;
  private lastPx: number | null = null;
  private lastPz: number | null = null;
  private profile = {
    observedSec: 0,
    stillTimeSec: 0,
    sprintTimeSec: 0,
    torchOnSec: 0,
  };

  constructor(private scene: Scene) {}

  /** Spawn exactly where asked (legacy path). Same archetype on the same
   *  rounded tile within 120s is nudged aside instead of re-spawned there. */
  spawn(type: HumanType, x: number, z: number, seed: number): HumanFigure {
    const spot = this.resolveSpawnSpot(type, x, z);
    const f = new HumanFigure(type, this.scene, spot.x, spot.z, seed);
    f.onBeamFrozen = () => this.onBeamFreeze?.();
    f.pointsOfInterest = this.interestPoints;
    this.figures.push(f);
    return f;
  }

  /**
   * Adaptive spawn: applies group-dynamics variety to the requested archetype,
   * then runs the same placement pipeline as spawn() (memory nudge included).
   * Existing callers of spawn() are unaffected.
   */
  smartSpawn(preferred: HumanType, x: number, z: number, seed: number): { figure: HumanFigure; type: HumanType } {
    const type = this.suggestType(preferred, x, z);
    return { figure: this.spawn(type, x, z, seed), type };
  }

  /**
   * Group dynamics: if two or more live entities of the preferred type sit
   * within CLUSTER_RADIUS of each other near (x, z), prefer a different,
   * non-clustered type; otherwise pass the preference through unchanged.
   */
  suggestType(preferred: HumanType, x?: number, z?: number): HumanType {
    if (!this.isTypeClustered(preferred, x, z)) return preferred;
    for (const t of ALL_TYPES) {
      if (t !== preferred && !this.isTypeClustered(t, x, z)) return t;
    }
    return ALL_TYPES[(ALL_TYPES.indexOf(preferred) + 1) % ALL_TYPES.length];
  }

  /** True when two+ live figures of this type are within 15m of each other
   *  (optionally anchored near point (x, z)). */
  isTypeClustered(type: HumanType, x?: number, z?: number): boolean {
    const of = this.figures.filter((f) =>
      f.type === type && (x === undefined || z === undefined || Math.hypot(f.body.x - x, f.body.z - z) <= CLUSTER_RADIUS),
    );
    for (let i = 0; i < of.length; i++) {
      for (let j = i + 1; j < of.length; j++) {
        if (Math.hypot(of[i].body.x - of[j].body.x, of[i].body.z - of[j].body.z) <= CLUSTER_RADIUS) return true;
      }
    }
    return false;
  }

  /** Difficulty bias knob: 0 = aggressive/near, 1 = passive/far. Clamped. */
  setDifficultyBias(cautiousness: number): void {
    this.difficultyBias = Math.min(1, Math.max(0, cautiousness));
  }

  /** Scale a base spawn distance for the current bias (aggressive pulls in,
   *  passive pushes out). Linear between BIAS_MIN_SCALE and BIAS_MAX_SCALE. */
  scaledDistance(baseDist: number): number {
    const { BIAS_MIN_SCALE, BIAS_MAX_SCALE } = HumanManager;
    return baseDist * (BIAS_MIN_SCALE + (BIAS_MAX_SCALE - BIAS_MIN_SCALE) * this.difficultyBias);
  }

  /** Suggest a spawn position at a bias-adjusted distance ahead of the player.
   *  Forward vector matches the game convention: forward = (-sin yaw, -cos yaw). */
  suggestSpawnPosition(px: number, pz: number, yaw: number, minDist: number, maxDist: number): { x: number; z: number } {
    const jitter = ((this.clock * 2654435761) % 1000) / 1000;
    const raw = this.scaledDistance(minDist + (maxDist - minDist) * jitter);
    const d = Math.min(Math.max(raw, minDist * HumanManager.BIAS_MIN_SCALE), maxDist * HumanManager.BIAS_MAX_SCALE);
    return { x: px - Math.sin(yaw) * d, z: pz - Math.cos(yaw) * d };
  }

  /** Was this archetype spawned on this rounded tile within the last 120s? */
  recentlySpawned(type: HumanType, x: number, z: number): boolean {
    const t = this.spawnMemory.get(spawnKey(type, x, z));
    return t !== undefined && this.clock - t < SPAWN_MEMORY_TTL;
  }

  private resolveSpawnSpot(type: HumanType, x: number, z: number): { x: number; z: number } {
    if (!this.recentlySpawned(type, x, z)) {
      this.spawnMemory.set(spawnKey(type, x, z), this.clock);
      pruneMemory(this.spawnMemory, this.clock);
      return { x, z };
    }
    // ring search until the tile is fresh (or we run out of patience)
    for (let r = 1; r <= 8; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (!this.recentlySpawned(type, nx, nz)) {
            this.spawnMemory.set(spawnKey(type, nx, nz), this.clock);
            pruneMemory(this.spawnMemory, this.clock);
            return { x: nx, z: nz };
          }
        }
      }
    }
    this.spawnMemory.set(spawnKey(type, x, z), this.clock); // saturated: allow anyway
    return { x, z };
  }

  /** Rolling read-only view of player behavior patterns. */
  getPlayerProfile(): PlayerProfile {
    const obs = Math.max(this.profile.observedSec, 1e-6);
    const sprintRatio = this.profile.sprintTimeSec / obs;
    const torchOnRatio = this.profile.torchOnSec / obs;
    const stillRatio = this.profile.stillTimeSec / obs;
    const confidence = Math.min(1, sprintRatio * 2 + torchOnRatio * 0.5);
    const cautiousness = Math.min(1, 1 - confidence + stillRatio * 0.25);
    return {
      observedSec: this.profile.observedSec,
      stillTimeSec: this.profile.stillTimeSec,
      sprintTimeSec: this.profile.sprintTimeSec,
      sprintRatio,
      torchOnRatio,
      confidence,
      cautiousness,
    };
  }

  update(dt: number, px: number, pz: number, pyaw: number, colliders: readonly Box2[], beam?: { on: boolean }): void {
    // ---- behavior profiling ----
    this.clock += dt;
    let speed = 0;
    if (this.lastPx !== null && this.lastPz !== null && dt > 0) {
      speed = Math.hypot(px - this.lastPx, pz - this.lastPz) / dt;
    }
    this.lastPx = px;
    this.lastPz = pz;
    this.profile.observedSec += dt;
    if (speed < STILL_SPEED) this.profile.stillTimeSec += dt;
    if (speed >= SPRINT_SPEED) this.profile.sprintTimeSec += dt;
    if (beam?.on) this.profile.torchOnSec += dt;

    const gone: HumanFigure[] = [];
    const proximity: ProximityEntry[] = [];
    for (const f of this.figures) {
      const dx = px - f.body.x;
      const dz = pz - f.body.z;
      const d = Math.hypot(dx, dz);
      const yawToPlayer = Math.atan2(dx, dz);
      let litByBeam = false;
      if (beam?.on && d < 14 && d > 0.5) {
        const fx = -Math.sin(pyaw), fz = -Math.cos(pyaw);
        litByBeam = (fx * ((f.body.x - px) / d) + fz * ((f.body.z - pz) / d)) > 0.86;
      }
      const frozenBefore = f.isBeamFrozen();
      f.update(dt, px, pz, colliders, yawToPlayer, litByBeam);
      if (litByBeam && !frozenBefore && f.isBeamFrozen()) {
        this.onBeamFreeze?.();
      }
      // publish from the post-move position so entries stay consistent with
      // nearestDist(), which reads the same final positions
      proximity.push({ figure: f, type: f.type, dist: Math.hypot(px - f.body.x, pz - f.body.z) });
      let despawn = false;
      if (d > 62 || f.life > f.vanishAt) despawn = true;
      const closeVanish =
        (f.type === 'watcher' && d < 4.6 && f.life > 1.2) ||
        (f.type === 'double' && d < 5 && f.life > 3);
      if (closeVanish) {
        despawn = true;
        this.vanishEvents++;
        this.onWatcherVanish?.();
      }
      // watchers never approach; wanderers may drift away freely
      if (despawn) gone.push(f);
    }
    for (const f of gone) {
      f.dispose();
      const i = this.figures.indexOf(f);
      if (i >= 0) this.figures.splice(i, 1);
    }
    // publish fresh per-figure distances so the game can layer audio by proximity
    this.proximities = gone.length > 0
      ? proximity.filter((e) => this.figures.includes(e.figure))
      : proximity;
    if (this.onProximity) this.onProximity(this.proximities);
  }

  nearestDist(px: number, pz: number): number {
    let best = Infinity;
    for (const f of this.figures) best = Math.min(best, Math.hypot(f.body.x - px, f.body.z - pz));
    return best;
  }

  nearestOf(px: number, pz: number, types: HumanType[]): HumanFigure | null {
    let best: HumanFigure | null = null;
    let bd = Infinity;
    for (const f of this.figures) {
      if (!types.includes(f.type)) continue;
      const d = Math.hypot(f.body.x - px, f.body.z - pz);
      if (d < bd) { bd = d; best = f; }
    }
    return bd < 7 ? best : null;
  }

  reset(): void {
    for (const f of this.figures) f.dispose();
    this.figures.length = 0;


    this.spawnMemory.clear();
    this.lastPx = null;
    this.lastPz = null;
  }

  get count(): number { return this.figures.length; }
}

function spawnKey(type: HumanType, x: number, z: number): string {
  return type + ':' + Math.round(x) + ':' + Math.round(z);
}

function pruneMemory(mem: Map<string, number>, now: number): void {
  if (mem.size < 256) return;
  for (const [k, t] of mem) {
    if (now - t >= SPAWN_MEMORY_TTL) mem.delete(k);
  }
}


