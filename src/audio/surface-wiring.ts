/**
 * Game-loop wiring for district footsteps - BACKROOMS: MEMORY BLEED.
 *
 * Bridges the world simulation and SurfaceFootsteps: every time the player
 * controller reports a footfall at (x, z), this adapter decides which floor
 * material is underfoot and forwards one play() call:
 *
 *   MAZE / CORRIDOR_GRID    -> carpet  (damp concrete dusted with debris)
 *   OPEN_OFFICE / HONEYCOMB -> tile    (linoleum over poured slab)
 *   STORAGE                 -> metal   (grated catwalk flooring)
 *   standing inside a puddle zone -> splash override
 *
 * The adapter also rate-limits calls so a chatty game loop cannot machine-gun
 * the synth: steps closer together than the natural cadence (~2.2 steps/s
 * walking, faster while sprinting) are dropped, with a hard 150 ms dedup
 * floor that applies no matter what.
 */
import { SurfaceFootsteps, type SurfaceKind } from './surfaces';

/**
 * District ordinals mirror District in world/constants.ts. Duplicated as
 * plain numbers so this module stays loadable under Node type stripping
 * (const enums are not erasable syntax).
 */
const DISTRICT_MAZE = 0;
const DISTRICT_OPEN_OFFICE = 1;
const DISTRICT_HONEYCOMB = 2;
const DISTRICT_CORRIDOR_GRID = 3;
const DISTRICT_STORAGE = 4;

/** District id -> base floor material. Unknown ids fall back to carpet. */
export function districtToSurface(district: number): SurfaceKind {
  switch (district) {
    case DISTRICT_OPEN_OFFICE:
    case DISTRICT_HONEYCOMB:
      return 'tile';
    case DISTRICT_STORAGE:
      return 'metal';
    case DISTRICT_MAZE:
    case DISTRICT_CORRIDOR_GRID:
      return 'carpet';
    default:
      return 'carpet';
  }
}

/** One registered puddle zone: center + splash radius, both meters. */
export interface PuddleZone {
  x: number;
  z: number;
  /** Splash radius in meters; defaults to PUDDLE_RADIUS. */
  r?: number;
}

/** Default puddle detection radius (meters). */
export const PUDDLE_RADIUS = 1.2;

/** Natural walk cadence: ~2.2 steps per second -> ~455 ms between steps. */
export const WALK_STEP_MS = 1000 / 2.2;

/** Sprinting shortens the stride period to roughly 320 ms. */
export const SPRINT_STEP_MS = 320;

/** Absolute dedup floor: never emit two steps within 150 ms. */
export const MIN_STEP_GAP_MS = 150;

/**
 * Adapter owned by the game loop. Feed it step() on footfall events;
 * it picks the surface and throttles the synth.
 */
export class SurfaceWiring {
  private readonly footsteps: SurfaceFootsteps;
  private readonly districtProvider: () => number;
  /** Optional external puddle probe; when set it overrides the built-in check. */
  private readonly puddleCheck: ((x: number, z: number) => boolean) | null;

  /** Registered puddle zones, replaced wholesale by setPuddles(). */
  private puddles: PuddleZone[] = [];

  /** Timestamp (ms, audio-clock domain) of the last emitted step. */
  private lastStepMs = -Infinity;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    districtProvider: () => number,
    puddleCheck?: (x: number, z: number) => boolean,
  ) {
    this.footsteps = new SurfaceFootsteps(ctx, destination);
    this.districtProvider = districtProvider;
    this.puddleCheck = puddleCheck ?? null;
  }

  /**
   * Register puddle zones (replaces any previous list). Positions are world
   * meters; each entry splashes within its own radius or PUDDLE_RADIUS.
   */
  setPuddles(list: PuddleZone[]): void {
    this.puddles = Array.isArray(list) ? list.slice() : [];
  }

  /**
   * Report one footfall at world position (x, z).
   *
   * Returns true when a step was actually played; false when the call was
   * rate-limited away (too soon after the previous step).
   */
  step(x: number, z: number, sprinting = false): boolean {
    // Audio clock in ms - same timebase SurfaceFootsteps schedules against.
    const nowMs = this.nowMs();
    const gap = sprinting ? SPRINT_STEP_MS : WALK_STEP_MS;
    // Hard 150 ms dedup floor first (guards clock jumps), then the natural
    // stride-period gate (~455 ms walk / ~320 ms sprint).
    if (nowMs - this.lastStepMs < MIN_STEP_GAP_MS) return false;
    if (nowMs - this.lastStepMs < gap) return false;

    const surface = this.surfaceAt(x, z);
    this.footsteps.play(surface, sprinting);
    this.lastStepMs = nowMs;
    return true;
  }

  /** Floor material underfoot: splash override wins over the district base. */
  private surfaceAt(x: number, z: number): SurfaceKind {
    return this.isPuddle(x, z)
      ? 'splash'
      : districtToSurface(this.districtProvider());
  }

  /** Radius check against registered puddle zones (or external probe). */
  private isPuddle(x: number, z: number): boolean {
    if (this.puddleCheck) return this.puddleCheck(x, z);
    for (let i = 0; i < this.puddles.length; i++) {
      const p = this.puddles[i];
      const r = typeof p.r === 'number' && p.r >= 0 ? p.r : PUDDLE_RADIUS;
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz <= r * r) return true;
    }
    return false;
  }

  /**
   * Time source. Uses the audio context clock when available so wiring and
   * synthesis share one timebase; falls back to the monotonic host clock in
   * headless/test environments where no real context exists.
   */
  private nowMs(): number {
    // SurfaceFootsteps keeps its context private; read it structurally.
    const ctx = (this.footsteps as unknown as { ctx?: AudioContext }).ctx;
    if (ctx && Number.isFinite(ctx.currentTime)) {
      return ctx.currentTime * 1000;
    }
    return typeof performance !== 'undefined'
      ? performance.now()
      : Date.now();
  }
}


