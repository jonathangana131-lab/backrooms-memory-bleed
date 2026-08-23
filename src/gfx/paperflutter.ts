/**
 * Paper flutter — loose floor sheets react to nearby footsteps.
 *
 * Floor-level dressing quads (paper scraps, prayer cards, lint) are tracked
 * from their baked world positions. When the player walks close, a quad does
 * a short damped hop: +5 cm vertical bounce with a slight rotational wobble,
 * settling back flat over 0.8 s.
 *
 * Performance contract:
 *  - never creates or disposes meshes; motion is applied by mutating the
 *    existing transform of quads registered by the caller (chunk debris is
 *    baked into shared buffers — those stay untouched unless the caller
 *    hands us standalone quads).
 *  - at most MAX_ACTIVE quads animate simultaneously; triggers beyond the
 *    cap are ignored until slots free up.
 *  - zero per-frame allocation: all state lives in preallocated records and
 *    one shared scratch array reused across queries.
 */
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

/** Player distance at which a paper starts fluttering. */
export const TRIGGER_DIST = 1.2;
/** Detection band: quads within this range are tracked around the player. */
export const DETECT_DIST = 2.0;
/** Full flutter duration in seconds. */
export const FLUTTER_DURATION = 0.8;
/** Simultaneously animating quad cap. */
export const MAX_ACTIVE = 20;
/** Peak bounce height above the resting Y. */
export const BOUNCE_HEIGHT = 0.05;
/** Max wobble amplitude in radians. */
export const WOBBLE_RAD = 0.14;

interface QuadRecord {
  mesh: Mesh;
  /** Resting height of the sheet. */
  baseY: number;
  /** Baked world-space center (detection uses XZ only). */
  x: number;
  z: number;
  /** Elapsed seconds since this flutter started; < 0 while idle. */
  t: number;
  /** Per-quad phase offsets so neighbours do not move in lockstep. */
  phaseA: number;
  phaseB: number;
}

// The envelope f(p) = sin(3*pi*p) * (1-p)^2 completes exactly three half
// cycles and lands on zero at p = 1, but its raw peak is below 1 — normalize
// so the bounce peaks at BOUNCE_HEIGHT regardless of the envelope shape.
const ENVELOPE_PEAK = (() => {
  let peak = 0;
  for (let i = 1; i < 1000; i++) {
    const p = i / 1000;
    peak = Math.max(peak, Math.sin(3 * Math.PI * p) * (1 - p) * (1 - p));
  }
  return peak;
})();
const BOUNCE_AMP = BOUNCE_HEIGHT / ENVELOPE_PEAK;

export class PaperFlutter {
  private quads: QuadRecord[] = [];
  private active = 0;
  private scratch: number[] = [];

  /**
   * Track one floor-level quad. baseY is its resting height; the world XZ
   * center is read from the mesh's bounding info so both identity-transform
   * merged chunks and positioned planes work. Disposed meshes are ignored;
   * registering the same mesh twice is a no-op.
   */
  registerQuad(mesh: Mesh, baseY: number): void {
    if (mesh.isDisposed()) return;
    for (let i = 0; i < this.quads.length; i++) {
      if (this.quads[i].mesh === mesh) return;
    }
    // Force the world matrix so baked geometry resolves to true world space.
    mesh.computeWorldMatrix(true);
    const center = mesh.getBoundingInfo().boundingBox.centerWorld;
    this.quads.push({
      mesh,
      baseY,
      x: center.x,
      z: center.z,
      t: -1,
      phaseA: Math.random() * Math.PI * 2,
      phaseB: Math.random() * Math.PI * 2,
    });
  }

  /** Number of quads currently mid-flutter. */
  get activeCount(): number {
    return this.active;
  }

  /** Tracked quad count (disposed meshes pruned lazily). */
  get trackedCount(): number {
    return this.quads.length;
  }

  /**
   * Advance flutter state. px, pz is the player's ground position.
   */
  update(dt: number, px: number, pz: number): void {
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // tab-back spikes: settle instead of teleporting

    const trig2 = TRIGGER_DIST * TRIGGER_DIST;

    for (let i = this.quads.length - 1; i >= 0; i--) {
      const q = this.quads[i];
      if (q.mesh.isDisposed()) {
        if (q.t >= 0) this.active--;
        this.quads.splice(i, 1);
        continue;
      }
      const dx = q.x - px;
      const dz = q.z - pz;
      const dist2 = dx * dx + dz * dz;

      if (q.t >= 0) {
        // --- animating: damped oscillation over FLUTTER_DURATION ---
        q.t += dt;
        const p = q.t / FLUTTER_DURATION;
        if (p >= 1) {
          // settled: restore rest pose exactly
          q.mesh.position.y = q.baseY;
          q.mesh.rotation.x = 0;
          q.mesh.rotation.z = 0;
          q.t = -1;
          this.active--;
          continue;
        }
        const damp = (1 - p) * (1 - p);
        q.mesh.position.y =
          q.baseY + Math.sin(3 * Math.PI * p) * damp * BOUNCE_AMP;
        // two out-of-phase low-frequency tilts read as an uneven sheet
        // catching air rather than a rigid flip
        q.mesh.rotation.x =
          Math.sin(p * Math.PI * 4 + q.phaseA) * WOBBLE_RAD * damp;
        q.mesh.rotation.z =
          Math.sin(p * Math.PI * 3 + q.phaseB) * WOBBLE_RAD * 0.6 * damp;
      } else if (dist2 <= trig2 && this.active < MAX_ACTIVE) {
        // --- footfall trigger: player stepped within trigger range ---
        q.t = 0;
        this.active++;
      }
      // Quads between TRIGGER_DIST and DETECT_DIST simply stay tracked;
      // detectedNear() reports them without a second pass.
    }
  }

  /** Drop every registration (chunk stream-out, scene teardown). */
  clear(): void {
    this.quads.length = 0;
    this.active = 0;
  }

  /**
   * Flat [x0, z0, x1, z1, ...] view of tracked quads within DETECT_DIST of
   * the player. The backing array is shared between calls — copy it if you
   * need to keep it. Allocation-free steady state.
   */
  detectedNear(px: number, pz: number): number[] {
    const out = this.scratch;
    out.length = 0;
    const r2 = DETECT_DIST * DETECT_DIST;
    for (const q of this.quads) {
      const dx = q.x - px;
      const dz = q.z - pz;
      if (dx * dx + dz * dz <= r2) out.push(q.x, q.z);
    }
    return out;
  }
}


