/**
 * Seasonal-bleed ambient particles (v1.1 debt payoff) — the consumer the
 * F57 particle descriptor was waiting for.
 *
 * `src/world/seasonrooms.ts` elects one landmark room per session to bleed
 * a foreign season and stamps its frozen ParticleDescriptor on the chunk
 * layout; the chunk mesher already consumes the packed tint. This module
 * consumes the OTHER half of the descriptor: an ambient point cloud that
 * fills the bleed room with the season's particles (heat motes, snowfall,
 * rain strokes, petal drift).
 *
 * Two halves, like every other mount here:
 *  - `spawnPlan()` is a pure helper: (descriptor, room volume, cap) ->
 *    everything a renderer needs (count clamped to SEASON_PARTICLE_CAP,
 *    fall speed, sway frequency, unpacked tint, per-kind point profile).
 *  - `SeasonBleedParticles` is a DustMotes-style updatable points mesh that
 *    follows the camera with toroidal wrapping while the player stands in
 *    the bleed room. configure(null) parks it out of sight — rooms without
 *    a descriptor stay exactly as they were.
 *
 * Determinism: every initial position and sway phase derives from
 * src/core/rng.ts seeded streams, never Math.random, so a given seed
 * replays byte-identical clouds.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { RNG, seedFromString } from '../core/rng';
import { WALL_H } from '../world/constants';
import type { ParticleDescriptor } from '../world/seasonrooms';

/** Hard ceiling on live particles regardless of room volume. */
export const SEASON_PARTICLE_CAP = 300;

/** Half-extent (m) of the camera-centred wrap box on X/Z. */
const RANGE = 14;

/** Vertical band (m) particles live in: just above the floor to the ceiling. */
const Y_FLOOR = 0.05;
const Y_CEIL = WALL_H - 0.05;

/** Horizontal sway amplitude in m/s at the descriptor's swayHz. */
const SWAY_AMPLITUDE_MPS = 0.4;

/** Per-archetype render profile: point size and opacity. */
const KIND_PROFILE: Readonly<Record<string, { size: number; alpha: number }>> = Object.freeze({
  heatmote: Object.freeze({ size: 2, alpha: 0.35 }),
  snowfall: Object.freeze({ size: 3, alpha: 0.5 }),
  rainstroke: Object.freeze({ size: 1.5, alpha: 0.4 }),
  petaldrift: Object.freeze({ size: 3, alpha: 0.45 }),
});

/** Fallback for unknown archetype keys — reads like the default mote. */
const DEFAULT_KIND_PROFILE = Object.freeze({ size: 2, alpha: 0.35 });

/** Everything the renderer needs to show one season's ambient pass. */
export interface SpawnPlan {
  /** Renderer particle archetype key (straight from the descriptor). */
  readonly kind: string;
  /** Live particle count, already clamped to [0, SEASON_PARTICLE_CAP]. */
  readonly count: number;
  /** Vertical speed in m/s; negative falls, positive rises. */
  readonly fallSpeedMps: number;
  /** Horizontal sway frequency in Hz. */
  readonly swayHz: number;
  /** Unpacked tint channels in [0,1]. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Point sprite size for the archetype. */
  readonly pointSize: number;
  /** Material opacity for the archetype. */
  readonly alpha: number;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Pure spawn plan for one seasonal bleed volume.
 * count = round(densityPerM3 x volumeM3), clamped to
 * [0, cap] with junk inputs falling back to zero rather than throwing —
 * a broken descriptor must never take down the frame loop.
 * @param particle Frozen descriptor from the elected bleed room's layout.
 * @param volumeM3 Room volume in cubic metres.
 * @param cap Hard particle ceiling (default SEASON_PARTICLE_CAP).
 */
export function spawnPlan(
  particle: ParticleDescriptor,
  volumeM3: number,
  cap = SEASON_PARTICLE_CAP,
): SpawnPlan {
  const density = Number(particle?.densityPerM3);
  const vol = Number(volumeM3);
  const safeDensity = Number.isFinite(density) && density >= 0 ? density : 0;
  const safeVol = Number.isFinite(vol) && vol >= 0 ? vol : 0;
  const raw = Math.round(safeDensity * safeVol);
  const safeCap = Number.isFinite(cap) && cap >= 0 ? cap : SEASON_PARTICLE_CAP;
  const count = Math.max(0, Math.min(safeCap, raw));
  const fallRaw = Number(particle?.fallSpeedMps);
  const swayRaw = Number(particle?.swayHz);
  const rgbRaw = Number(particle?.rgb);
  const rgb = Number.isFinite(rgbRaw) && rgbRaw >= 0 ? Math.floor(rgbRaw) : 0;
  const kind = typeof particle?.kind === 'string' && particle.kind.length > 0
    ? particle.kind
    : 'heatmote';
  const profile = KIND_PROFILE[kind] ?? DEFAULT_KIND_PROFILE;
  return {
    kind,
    count,
    fallSpeedMps: Number.isFinite(fallRaw) ? fallRaw : 0,
    swayHz: Number.isFinite(swayRaw) && swayRaw >= 0 ? swayRaw : 0,
    r: clampUnit((rgb >> 16) & 255) / 255,
    g: clampUnit((rgb >> 8) & 255) / 255,
    b: clampUnit(rgb & 255) / 255,
    pointSize: profile.size,
    alpha: profile.alpha,
  };
}

/** True when two plans would render identically (no reseed needed). */
function plansEqual(a: SpawnPlan | null, b: SpawnPlan | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
    && a.count === b.count
    && a.fallSpeedMps === b.fallSpeedMps
    && a.swayHz === b.swayHz
    && a.r === b.r && a.g === b.g && a.b === b.b
    && a.pointSize === b.pointSize
    && a.alpha === b.alpha;
}

/**
 * Camera-following seasonal particle cloud over one bleed room.
 * Parked (mesh disabled, update a no-op) until a plan arrives; reconfigured
 * only when the plan actually changes so revisits within one room do not
 * visibly reshuffle the air.
 */
export class SeasonBleedParticles {
  private readonly mesh: Mesh;
  private readonly mat: StandardMaterial;
  private readonly positions: Float32Array;
  private readonly phases: Float32Array;
  private plan: SpawnPlan | null = null;
  private time = 0;
  private rng: RNG;

  constructor(scene: Scene, seedString = 'seasonbleed') {
    this.rng = new RNG(seedFromString(seedString));
    this.positions = new Float32Array(SEASON_PARTICLE_CAP * 3);
    this.phases = new Float32Array(SEASON_PARTICLE_CAP);
    // park every slot far below the world; configure() lifts the ones it needs
    for (let i = 0; i < SEASON_PARTICLE_CAP; i++) {
      this.positions[i * 3 + 1] = -1000;
      this.phases[i] = this.rng.next() * Math.PI * 2;
    }
    const mesh = new Mesh('seasonbleed-particles', scene);
    const vd = new VertexData();
    vd.positions = Array.from(this.positions);
    vd.applyToMesh(mesh, true); // updatable
    const mat = new StandardMaterial('seasonbleedMat', scene);
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.pointsCloud = true;
    mat.pointSize = 2;
    mesh.material = mat;
    mesh.setEnabled(false);
    this.mesh = mesh;
    this.mat = mat;
  }

  /** Whether a plan is currently mounted. */
  get active(): boolean {
    return this.plan !== null && this.plan.count > 0;
  }

  /** The plan currently mounted, or null when parked. */
  get currentPlan(): SpawnPlan | null {
    return this.plan;
  }

  /** World position of live particle i (parked slots read y=-1000). */
  pointAt(i: number): [number, number, number] {
    const ix = i * 3;
    return [this.positions[ix], this.positions[ix + 1], this.positions[ix + 2]];
  }

  /**
   * Mount (or change / clear) the ambient plan. A null plan parks the
   * cloud; an equal plan is a no-op; anything else reseeds the first
   * `count` slots deterministically around the origin — the cloud then
   * follows the camera through update().
   */
  configure(plan: SpawnPlan | null): void {
    if (plansEqual(this.plan, plan)) return;
    this.plan = plan;
    if (!plan || plan.count <= 0) {
      this.mesh.setEnabled(false);
      return;
    }
    this.mesh.setEnabled(true);
    this.mat.pointSize = plan.pointSize;
    this.mat.alpha = plan.alpha;
    this.mat.emissiveColor = new Color3(plan.r, plan.g, plan.b);
    // fresh deterministic field per distinct plan; keep phase stream running
    // so reseeds never repeat the same shuffle within a session
    for (let i = 0; i < plan.count; i++) {
      const ix = i * 3;
      this.positions[ix] = (this.rng.next() - 0.5) * RANGE * 2;
      this.positions[ix + 1] = Y_FLOOR + this.rng.next() * (Y_CEIL - Y_FLOOR);
      this.positions[ix + 2] = (this.rng.next() - 0.5) * RANGE * 2;
      this.phases[i] = this.rng.next() * Math.PI * 2;
    }
    for (let i = plan.count; i < SEASON_PARTICLE_CAP; i++) {
      this.positions[i * 3 + 1] = -1000;
    }
    this.pushBuffer();
  }

  /**
   * Integrate one frame: vertical fall/rise with band wrap, sinusoidal
   * horizontal sway at the plan's frequency, toroidal X/Z wrap around the
   * camera so the cloud is always around the player. No-op while parked.
   */
  update(dt: number, camX: number, camZ: number): void {
    const plan = this.plan;
    if (!plan || plan.count <= 0) return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.time += step;
    const pos = this.positions;
    const omega = plan.swayHz * Math.PI * 2;
    const height = Y_CEIL - Y_FLOOR;
    const halfR = RANGE;
    for (let i = 0; i < plan.count; i++) {
      const ix = i * 3;
      let y = pos[ix + 1] + plan.fallSpeedMps * step;
      // wrap through the band in both directions (negative falls, positive rises)
      y = Y_FLOOR + ((y - Y_FLOOR) % height + height) % height;
      pos[ix + 1] = y;
      pos[ix] += Math.sin(this.time * omega + this.phases[i]) * SWAY_AMPLITUDE_MPS * step;
      const dx = pos[ix] - camX;
      if (dx > halfR) pos[ix] -= halfR * 2;
      else if (dx < -halfR) pos[ix] += halfR * 2;
      const dz = pos[ix + 2] - camZ;
      if (dz > halfR) pos[ix + 2] -= halfR * 2;
      else if (dz < -halfR) pos[ix + 2] += halfR * 2;
    }
    this.pushBuffer();
  }

  private pushBuffer(): void {
    // buffer was created updatable; in-place upload keeps GC quiet
    try { this.mesh.updateVerticesData('position', this.positions); }
    catch { this.mesh.setVerticesData('position', new Float32Array(this.positions), true); }
  }
}
