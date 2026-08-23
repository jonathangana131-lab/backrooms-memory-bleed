/**
 * Footstep surface detection.
 *
 * Maps the player's world position + current district onto one of four
 * footstep surfaces: 'carpet' | 'tile' | 'metal' | 'splash'.
 *
 * Layers, highest priority first:
 *   1. Splash override  - any registered puddle within PUDDLE_RADIUS m.
 *   2. District default - MAZE/CORRIDOR_GRID -> carpet,
 *                         OPEN_OFFICE/HONEYCOMB -> tile, STORAGE -> metal.
 *
 * District-to-surface transitions are debounced with hysteresis: the
 * detector must see the new district surface persist while the player
 * moves HYSTERESIS_DIST m past where it was first seen before committing
 * the change. This prevents footstep material from flip-flopping when
 * the player wanders along a district boundary. The splash override is
 * intentionally immediate (a puddle is a small, deliberate feature and
 * its radius already exceeds the hysteresis distance).
 */

/** Footstep surface kinds reported by the detector. */
export type SurfaceKind = 'carpet' | 'tile' | 'metal' | 'splash';

/** Non-splash surface kinds (the committed district surfaces). */
export type BaseSurfaceKind = 'carpet' | 'tile' | 'metal';

/*
 * Numeric district constants matching `District` in src/world/constants.ts.
 * Duplicated as plain numbers because this module must stay dependency-free
 * (and runnable under node --experimental-strip-types, which cannot execute
 * TypeScript `enum`s).
 */
export const DISTRICT_MAZE = 0;
export const DISTRICT_OPEN_OFFICE = 1;
export const DISTRICT_HONEYCOMB = 2;
export const DISTRICT_CORRIDOR_GRID = 3;
export const DISTRICT_STORAGE = 4;

/** Radius (m) around a registered puddle center that counts as standing in it. */
export const PUDDLE_RADIUS = 0.8;

/** Distance (m) of sustained travel required before a surface change commits. */
export const SURFACE_HYSTERESIS_DIST = 0.5;

/** Default district -> surface mapping. Unknown districts fall back to carpet. */
const DISTRICT_SURFACE: Record<number, BaseSurfaceKind> = {
  [DISTRICT_MAZE]: 'carpet',
  [DISTRICT_OPEN_OFFICE]: 'tile',
  [DISTRICT_HONEYCOMB]: 'tile',
  [DISTRICT_CORRIDOR_GRID]: 'carpet',
  [DISTRICT_STORAGE]: 'metal',
};

export interface Point2 {
  x: number;
  z: number;
}

interface PendingChange {
  surface: BaseSurfaceKind;
  anchorX: number;
  anchorZ: number;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export class SurfaceDetector {
  /** Registered puddle centers in world space (replaced by setPuddles). */
  private puddleList: Point2[] = [];

  /** Committed district-level surface (hysteresis state machine). */
  private base: BaseSurfaceKind | null = null;

  /** Last sampled player position (hysteresis travel reference). */
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;

  /** Candidate surface waiting out the hysteresis distance, if any. */
  private pending: PendingChange | null = null;

  /** Most recent value returned by detect(). */
  private lastDetected: SurfaceKind | null = null;

  /** Replace the registered puddle set (world-space centers). */
  setPuddles(points: Point2[]): void {
    this.puddleList = points.map((p) => ({ x: p.x, z: p.z }));
  }

  /** Last value returned by detect(); null before the first call. */
  get currentSurface(): SurfaceKind | null {
    return this.lastDetected;
  }

  /** True when (x, z) lies within PUDDLE_RADIUS of a registered puddle. */
  isInPuddle(x: number, z: number): boolean {
    const r2 = PUDDLE_RADIUS * PUDDLE_RADIUS;
    for (let i = 0; i < this.puddleList.length; i++) {
      const p = this.puddleList[i];
      if (dist2(x, z, p.x, p.z) <= r2) return true;
    }
    return false;
  }

  /** Default surface for a district number (unknown districts -> carpet). */
  districtSurface(district: number): BaseSurfaceKind {
    return DISTRICT_SURFACE[district] ?? 'carpet';
  }

  /**
   * Detect the footstep surface at (x, z) in `district`.
   * Updates internal hysteresis state and currentSurface.
   */
  detect(x: number, z: number, district: number): SurfaceKind {
    const raw = this.districtSurface(district);

    if (this.base === null) {
      // First observation commits immediately.
      this.base = raw;
      this.pending = null;
    } else if (raw !== this.base) {
      // Different district surface: require sustained travel before switching.
      // Anchor candidates at the PREVIOUS sampled position so that a large
      // single-step move (sparse sampling / teleport) past the boundary
      // commits immediately.
      const anchorX = this.hasLast ? this.lastX : x;
      const anchorZ = this.hasLast ? this.lastZ : z;
      if (this.pending === null || this.pending.surface !== raw) {
        this.pending = { surface: raw, anchorX, anchorZ };
      }
      const travelled = Math.hypot(x - this.pending.anchorX, z - this.pending.anchorZ);
      if (travelled >= SURFACE_HYSTERESIS_DIST) {
        this.base = raw;
        this.pending = null;
      }
    } else {
      // Back on the committed surface: drop any stale candidacy.
      this.pending = null;
    }

    // Splash override is immediate and wins over the district surface.
    const result: SurfaceKind = this.isInPuddle(x, z) ? 'splash' : this.base;
    this.lastDetected = result;
    this.lastX = x;
    this.lastZ = z;
    this.hasLast = true;
    return result;
  }
}


