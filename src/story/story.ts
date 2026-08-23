/**
 * Story: expedition objectives, research beacon discoveries, threshold ending.
 * Beacons are deterministic per seed; discovered state is persisted.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { hash2i, RNG } from '../core/rng';
import { CELL } from '../world/constants';
import type { PropInstance } from '../world/architect';

export interface BeaconState {
  cx: number; cz: number;
  x: number; z: number;
  threshold: boolean;
  found: boolean;
}

const LORE: string[] = [
  'BEACON 7-C CONTACTED. "If you can read this, the space has already started copying you. Keep moving. Do not sleep on the carpet."',
  'LOG 31: We watched a corridor rebuild itself overnight. The wallpaper pattern matched a hospital none of us had ever visited. None of us ADMITTED visiting.',
  'LOG 44: It does not store memories. It REPLAYS them with errors, like a tape left in the sun. The errors are load-bearing now.',
  'LOG 52: Team B found a break room identical to theirs, down to the mug. The mug said a name nobody recognized. They drank from it anyway.',
  'LOG 60: Reconsolidation confirmed. The space remembers what YOU remember, badly, and it is starting to remember you back.',
  'LOG 67: Subject Marlow described a bedroom from her childhood. We never gave it the address. It built the room anyway, one floor below where she slept. The glow stars were correct. She never told anyone about the glow stars.',
  'LOG 73: Night guard reports monitors showing rooms that DO NOT EXIST YET. We reviewed the tapes. The rooms appear on camera roughly ninety minutes after he stops writing about them. He has agreed to keep writing.',
  'LOG 81: Communication attempt logged under Protocol R. We left written questions in occupied sectors. Replies arrive overnight, in the asker\u2019s own handwriting. Content analysis: mostly questions back. One reply was a floor plan of this camp.',
  'LOG 88: Two expedition members reunited at junction K-4 after nineteen days apart. Both privately report that the other felt RECONSTRUCTED. Neither will say which one they doubt. We have stopped asking.',
  'FINAL LOG: The Threshold only opens for someone the space finds INTERESTING. Try to stay interesting. - R.',
];

export class StorySystem {
  stage = 0; // 0 intro,1 first beacon,2 three beacons,3 threshold available,4 ended
  discoveries = 0;
  beacons = new Map<string, BeaconState>();
  private meshes = new Map<string, { mesh: Mesh; mat: StandardMaterial }>();
  endingTriggered = false;

  constructor(private scene: Scene, public seed: number) {}

  /** Deterministic beacon placement for a chunk. */
  beaconForChunk(cx: number, cz: number): BeaconState | null {
    const key = cx + ',' + cz;
    const existing = this.beacons.get(key);
    if (existing) return existing;
    if ((hash2i(cx, cz, this.seed ^ 316963681) % 23) !== 5) return null;
    const rng = new RNG(hash2i(cx, cz, this.seed ^ 0x77aa));
    const b: BeaconState = {
      cx, cz,
      x: (cx * 12 + 6 + rng.range(-2, 2)) * CELL,
      z: (cz * 12 + 6 + rng.range(-2, 2)) * CELL,
      threshold: false,
      found: false,
    };
    this.beacons.set(key, b);
    return b;
  }

  /** Guaranteed first beacon near spawn ring and the far threshold. */
  anchors(): { first: BeaconState; threshold: BeaconState } {
    const rng = new RNG(this.seed ^ 0xa11ce);
    const ang = rng.next() * Math.PI * 2;
    const mk = (dist: number, threshold: boolean): BeaconState => {
      const x = Math.cos(ang + (threshold ? 1.3 : 0)) * dist;
      const z = Math.sin(ang + (threshold ? 1.3 : 0)) * dist;
      const cx = Math.floor(x / (CELL * 12));
      const cz = Math.floor(z / (CELL * 12));
      const key = cx + ',' + cz;
      let b = this.beacons.get(key);
      if (!b) {
        b = { cx, cz, x: (cx * 12 + 6) * CELL, z: (cz * 12 + 6) * CELL, threshold, found: false };
        this.beacons.set(key, b);
      }
      return b;
    };
    return { first: mk(105, false), threshold: mk(255, true) };
  }

  /** Abandoned expedition camp around an unfound beacon. */
  campDecor(b: BeaconState): PropInstance[] {
    const rng = new RNG(hash2i(b.cx, b.cz, this.seed ^ 0xcafe));
    const out: PropInstance[] = [];
    const n = b.threshold ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const ang = rng.next() * Math.PI * 2;
      const d = rng.range(1.0, 2.4);
      out.push({
        kind: rng.chance(0.75) ? 'crate' : 'cabinet',
        x: b.x + Math.cos(ang) * d,
        z: b.z + Math.sin(ang) * d,
        rot: rng.int(0, 4) as 0 | 1 | 2 | 3,
        variant: rng.int(0, 3),
      });
    }
    out.push({ kind: 'bench', x: b.x + rng.range(-3, 3), z: b.z + rng.range(-3, 3), rot: rng.int(0, 4) as 0 | 1 | 2 | 3, variant: 1 });
    out.push({ kind: 'stacked_chairs', x: b.x + rng.range(-2.5, 2.5), z: b.z + rng.range(-2.5, 2.5), rot: 0, variant: 2 });
    return out;
  }

  /** Materialize deterministic beacon defs for all chunks in radius. */
  ensureBeaconsAround(cx: number, cz: number, r: number): void {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        void this.beaconForChunk(cx + dx, cz + dz);
      }
    }
  }

  /** Ensure visuals exist for nearby unfound beacons; pulse them. */
  update(px: number, pz: number, time: number): void {
    const view = 90;
    for (const [key, b] of this.beacons) {
      const d = Math.hypot(b.x - px, b.z - pz);
      const have = this.meshes.has(key);
      if (!have && d < view && !b.found) {
        this.buildMesh(key, b);
      }
      const m = this.meshes.get(key);


