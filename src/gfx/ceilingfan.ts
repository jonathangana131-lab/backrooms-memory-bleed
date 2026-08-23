/**
 * Ceiling fans: rare procedural dressing for OPEN_OFFICE / HONEYCOMB rooms.
 *
 * A fan is a merged mesh of a ceiling mount plate, a drop rod, a center
 * hub cylinder and four flat blade boxes pitched 5 degrees. Fans hang at
 * the ceiling plane (y = WALL_H) and spin about their local Y axis.
 *
 * Old fans misbehave: each fan carries an internal state machine that
 * turns itself ON/OFF and between speeds at random - but ONLY while the
 * director is in its build/peak phases (the place remembers harder when
 * tension rises). The hub also orbits its mount by up to +/-2 mm, one
 * full wobble circle per revolution, which reads as a bent rod.
 *
 * Placement is deterministic: ~10% of OPEN_OFFICE/HONEYCOMB chunks win a
 * hash lottery and host exactly one fan near the room centre. Any chunk
 * can be regenerated identically at any time, in any order.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { rand2, hash2i } from '../core/rng';

/** Fan operating states. */
export type FanState = 'off' | 'slow' | 'medium' | 'fast';

/** All valid states in ascending speed order. */
export const FAN_STATES: readonly FanState[] = ['off', 'slow', 'medium', 'fast'];

/** Blade tip speed per state, in revolutions per second. */
export const FAN_SPEEDS: Readonly<Record<FanState, number>> = {
  off: 0,
  slow: 0.3,
  medium: 0.8,
  fast: 1.5,
};

/** Placement lottery salt (independent of every other feature). */
const FAN_SALT = 0xfa11;
/** Rarity gate: 1 winning residue out of this many -> ~10% of chunks. */
const FAN_PERIOD = 10;

/** Hub orbit amplitude: +/-2 mm of bent-rod wobble. */
const WOBBLE_AMP = 0.002;
/** Blade pitch from horizontal, degrees. */
const BLADE_PITCH_DEG = 5;
/** Drop below the ceiling plane to the blade disc. */
const DROP_Y = 0.36;
/** Floor(0) to ceiling height, matching src/world/constants.ts. */
const WALL_H = 3.05;
/** Chunk side length in meters, matching src/world/constants.ts. */
const CHUNK_SIZE = 30;
/** Autonomous re-decision interval range while tense (seconds). */
const SWITCH_MIN_S = 12;
const SWITCH_MAX_S = 48;

/** District ids mirrored locally (const enum cannot cross isolatedModules). */
const DISTRICT_OPEN_OFFICE = 1;
const DISTRICT_HONEYCOMB = 2;

/** Director tension phases during which fans may change their own state. */
function maySelfSwitch(phase: string | undefined): boolean {
  return phase === 'build' || phase === 'peak';
}

/** Weighted random next state; never repeats the current one. */
function nextRandomState(current: FanState): FanState {
  const r = Math.random();
  // cumulative weights: off .35 / slow .30 / medium .25 / fast .10
  let pick: FanState;
  if (r < 0.35) pick = 'off';
  else if (r < 0.65) pick = 'slow';
  else if (r < 0.90) pick = 'medium';
  else pick = 'fast';
  return pick === current ? nextRandomState(current) : pick;
}

/**
 * Deterministic placement gate for chunk (cx, cz). Returns the fan's world
 * X/Z near the chunk's room centre, or null when this chunk hosts nothing.
 * Only OPEN_OFFICE (1) and HONEYCOMB (2) qualify, and only when the chunk
 * hash wins the 1-in-10 lottery (~10% of those chunks).
 */
export function tryPlace(
  cx: number,
  cz: number,
  district: number,
): { x: number; z: number } | null {
  if (district !== DISTRICT_OPEN_OFFICE && district !== DISTRICT_HONEYCOMB) return null;
  if (hash2i(cx, cz, FAN_SALT) % FAN_PERIOD !== 0) return null;

  const centerX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centerZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
  // Small deterministic jitter keeps fans off the exact grid seam while
  // staying well clear of perimeter walls (max +/-2.5 m of a 15 m half-span).
  const jx = (rand2(cx, cz, FAN_SALT ^ 0xa17) - 0.5) * 5;
  const jz = (rand2(cx, cz, FAN_SALT ^ 0xb22) - 0.5) * 5;
  return { x: centerX + jx, z: centerZ + jz };
}

/** Shared dull-metal material, cached per scene. */
function fanMaterial(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('bmbFanMetal');
  if (existing) return existing as StandardMaterial;
  const mat = new StandardMaterial('bmbFanMetal', scene);
  mat.diffuseColor = new Color3(0.16, 0.155, 0.14); // aged grey-brown metal
  mat.specularColor = new Color3(0.06, 0.06, 0.06); // almost dead sheen
  return mat;
}

export class CeilingFan {
  /** World position of the mount point on the ceiling plane. */
  public readonly x: number;
  public readonly z: number;

  private st: FanState;
  /** Accumulated rotation in radians (drives spin AND wobble phase). */
  private angle = 0;
  /** Seconds until the next autonomous state decision while tense. */
  private switchIn: number;
  private mesh: Mesh | null = null;
  private basePos: Vector3 | null = null;

  /**
   * @param x  world X of the ceiling mount
   * @param z  world Z of the ceiling mount
   * @param initialState starting state; defaults to a deterministic
   *        position-hashed pick so regenerating a chunk reproduces it
   */
  constructor(x: number, z: number, initialState?: FanState) {
    this.x = x;
    this.z = z;
    if (initialState) {
      this.st = initialState;
    } else {
      const h = rand2(Math.round(x * 64), Math.round(z * 64), FAN_SALT ^ 0x57a7);
      this.st = h < 0.45 ? 'off' : h < 0.72 ? 'slow' : h < 0.92 ? 'medium' : 'fast';
    }
    // Stagger the first self-switch so co-placed fans never decide in lockstep.
    this.switchIn = SWITCH_MIN_S + Math.random() * (SWITCH_MAX_S - SWITCH_MIN_S);
  }

  /** Current operating state. */
  get state(): FanState {
    return this.st;
  }

  /** Total accumulated revolutions (useful for tests/audio coupling). */
  get revolutions(): number {
    return this.angle / (Math.PI * 2);
  }

  /** Current angular velocity in rad/s (0 when off). */
  get angularSpeed(): number {
    return FAN_SPEEDS[this.st] * Math.PI * 2;
  }

  /** Force a state; validates strictly so wiring typos fail loudly. */
  setState(s: FanState): void {
    if (!FAN_STATES.includes(s)) {
      throw new TypeError('CeilingFan.setState: unknown state "' + String(s) + '"');
    }
    this.st = s;
  }

  /**
   * Build the procedural fan mesh: mount plate, drop rod, hub cylinder and
   * four 5-degree-pitched flat blade boxes, all merged into ONE mesh.
   * The mesh hangs from (this.x, WALL_H, this.z).
   */
  createMesh(scene: Scene): Mesh {
    const mat = fanMaterial(scene);
    const parts: Mesh[] = [];

    // Ceiling mount plate.
    const plate = MeshBuilder.CreateBox('fanPlate', { width: 0.18, height: 0.04, depth: 0.18 }, scene);
    plate.position.y = -0.02;
    parts.push(plate);

    // Drop rod down from the plate.
    const rod = MeshBuilder.CreateCylinder('fanRod', { height: 0.26, diameter: 0.035, tessellation: 8 }, scene);
    rod.position.y = -(0.04 + 0.13);
    parts.push(rod);

    // Center hub the blades bolt onto.
    const hub = MeshBuilder.CreateCylinder('fanHub', { height: 0.09, diameter: 0.15, tessellation: 12 }, scene);
    hub.position.y = -DROP_Y;
    parts.push(hub);

    // Four flat blades, pitched about their long (radial) axis.
    const pitch = (BLADE_PITCH_DEG * Math.PI) / 180;
    for (let i = 0; i < 4; i++) {
      const blade = MeshBuilder.CreateBox('fanBlade' + i, { width: 0.58, height: 0.018, depth: 0.15 }, scene);
      const yaw = (i * Math.PI) / 2;
      const radius = 0.075 + 0.29; // hub radius + half blade span
      blade.position.set(Math.cos(yaw) * radius, -DROP_Y - 0.01, Math.sin(yaw) * radius);
      // Babylon applies Euler as Ry(yaw)*Rx(pitch)*Rz(roll), so setting
      // rotation.y then rotation.x pitches each blade about its own radial
      // axis AFTER it has been swung out to its yaw angle: a flat blade
      // twisted 5 degrees for bite.
      blade.rotation.y = yaw;
      blade.rotation.x = pitch;
      parts.push(blade);
    }

    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    const mesh = merged ?? parts[0];
    mesh.name = 'ceilingFan';
    mesh.material = mat;
    mesh.position.set(this.x, WALL_H, this.z);
    mesh.rotation.y = rand2(Math.round(this.x), Math.round(this.z), FAN_SALT ^ 0x33d) * Math.PI * 2;

    this.mesh = mesh;
    this.basePos = mesh.position.clone();
    return mesh;
  }

  /**
   * Advance spin + wobble, and let the fan misbehave: while the director is
   * in a build/peak phase the fan randomly re-decides its state every
   * 12-48 s. In calm/release phases it holds whatever state it has.
   * @param dt frame delta seconds
   * @param phase director phase ('calm' | 'build' | 'peak' | 'release')
   */
  update(dt: number, phase?: string): void {
    this.angle += this.angularSpeed * dt;

    if (maySelfSwitch(phase)) {
      this.switchIn -= dt;
      if (this.switchIn <= 0) {
        this.st = nextRandomState(this.st);
        this.switchIn = SWITCH_MIN_S + Math.random() * (SWITCH_MAX_S - SWITCH_MIN_S);
      }
    }

    // Bent-rod wobble: the hub orbits its mount once per revolution,
    // amplitude +/-2 mm. Frozen solid when the fan is off.
    if (this.mesh && this.basePos) {
      this.mesh.position.x = this.basePos.x + Math.cos(this.angle) * WOBBLE_AMP;
      this.mesh.position.z = this.basePos.z + Math.sin(this.angle) * WOBBLE_AMP;
    }
  }

  /** Release the mesh back to the scene (safe to call repeatedly). */
  dispose(): void {
    if (this.mesh) {
      this.mesh.dispose();
      this.mesh = null;
      this.basePos = null;
    }
  }
}


