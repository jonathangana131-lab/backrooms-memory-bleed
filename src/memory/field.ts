/**
 * Memory Contamination Engine.
 *
 * Tracks where human memories bled into the Backrooms, what kind they
 * are, how strong they are, and how they evolve (blend, decay, spread).
 */
import { hash2i, fbm2 } from '../core/rng';
import { RNG } from '../core/rng';
import type { MemoryWeather } from './weather';

export const enum MemoryKind {
  NONE = 0,
  RESIDENCE = 1,
  OFFICE = 2,
  HOSPITAL = 3,
  SCHOOL = 4,
  MALL = 5,
  TRANSIT = 6,
  PERSONAL = 7,
}

export const MEMORY_NAMES: Record<number, string> = {
  [MemoryKind.NONE]: '',
  [MemoryKind.RESIDENCE]: 'a home that was never built',
  [MemoryKind.OFFICE]: 'quarterly reports and dead fluorescents',
  [MemoryKind.HOSPITAL]: 'antiseptic and waiting rooms',
  [MemoryKind.SCHOOL]: 'lockers and linoleum echoes',
  [MemoryKind.MALL]: 'fountains, food court, closing time',
  [MemoryKind.TRANSIT]: 'the last train nobody boarded',
  [MemoryKind.PERSONAL]: 'your own footsteps, returned',
};

export interface MemoryNode {
  region: string;
  kind: MemoryKind;
  intensity: number;
  bornAt: number;
  lastSeenAt: number;
}

export const REGION_SIZE = 24;

export function regionKeyOf(x: number, z: number): string {
  return Math.floor(x / REGION_SIZE) + ',' + Math.floor(z / REGION_SIZE);
}

const SECTOR_LETTERS = 'KMRVTSHDWQN';

/** Stable human-readable sector name for a position, e.g. "SECTOR K-7". */
export function sectorName(seed: number, x: number, z: number): string {
  const gx = Math.floor(x / (REGION_SIZE * 4));
  const gz = Math.floor(z / (REGION_SIZE * 4));
  const h = hash2i(gx, gz, seed ^ 0x5ec70);
  return 'SECTOR ' + SECTOR_LETTERS[h % SECTOR_LETTERS.length] + '-' + ((h % 19) + 1);
}

function baseKindAt(seed: number, x: number, z: number): MemoryKind {
  const n = fbm2(x * 0.008, z * 0.008, 3, 2, 0.6, seed ^ 0x5eed);
  const m = fbm2(x * 0.033, z * 0.033, 2, 2, 0.5, seed ^ 0xbeef);
  let idx: number;
  if (n < 0.35) idx = Math.floor(m * 3);
  else if (n < 0.7) idx = 2 + Math.floor(m * 2);
  else idx = 4 + Math.floor(m * 3);
  return (idx + 1) as MemoryKind;
}

function baseIntensityAt(seed: number, x: number, z: number): number {
  const n = fbm2(x * 0.02, z * 0.02, 3, 2, 0.55, seed ^ 0x1777);
  return Math.max(0, Math.min(1, (n - 0.32) * 2.1));
}

export class MemoryField {


  nodes = new Map<string, Map<string, MemoryNode>>();
  private trail = new Map<string, number>();
  nowSec = 0;
  /** optional active weather front modifying all samples */
  weather: MemoryWeather | null = null;

  constructor(public seed: number) {}

  /**
   * Pure, eternal layer: depends only on (seed, coords). Used for
   * STRUCTURAL generation so chunk borders always agree no matter
   * when or where chunks were built.
   */
  sampleBaseAt(x: number, z: number): { kind: MemoryKind; intensity: number } {
    return { kind: baseKindAt(this.seed, x, z), intensity: baseIntensityAt(this.seed, x, z) };
  }

  sampleAt(x: number, z: number): { kind: MemoryKind; intensity: number } {
    let bestK: MemoryKind = baseKindAt(this.seed, x, z);
    let bestI = baseIntensityAt(this.seed, x, z);

    const rx = Math.floor(x / REGION_SIZE);
    const rz = Math.floor(z / REGION_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.nodes.get((rx + dx) + ',' + (rz + dz));
        if (!bucket) continue;
        for (const node of bucket.values()) {
          const cx = (rx + dx + 0.5) * REGION_SIZE;
          const cz = (rz + dz + 0.5) * REGION_SIZE;
          const d = Math.hypot(cx - x, cz - z) / REGION_SIZE;
          const w = node.intensity * Math.max(0, 1 - d * 0.8);
          if (w > 0.05 && w > bestI * 0.75) {
            bestI = Math.min(1, Math.max(bestI, w));
            bestK = node.kind;
          }
        }
      }
    }
    const t = this.trail.get(rx + ',' + rz) ?? 0;
    if (t > 6) {
      const tw = Math.min(0.65, t * 0.01);
      if (tw > bestI * 0.6) {
        bestK = MemoryKind.PERSONAL;
        bestI = Math.max(bestI, tw);
      }
    }
    const out = { kind: bestK, intensity: bestI };
    if (this.weather) this.weather.apply(out, x, z);
    return out;
  }

  recordPresence(x: number, z: number, dt: number): void {
    const k = regionKeyOf(x, z);
    this.trail.set(k, (this.trail.get(k) ?? 0) + dt);
    // bound growth so saves stay small on very long expeditions
    if (this.trail.size > 1600) {
      let dropped = 0;
      for (const key of this.trail.keys()) {
        if (dropped++ >= 300) break;
        this.trail.delete(key);
      }
    }
  }

  inject(x: number, z: number, kind: MemoryKind, intensity: number): void {
    const rk = regionKeyOf(x, z);
    let bucket = this.nodes.get(rk);
    if (!bucket) {
      bucket = new Map();
      this.nodes.set(rk, bucket);
    }
    const id = 'n' + bucket.size + '_' + Math.floor(intensity * 100);
    bucket.set(id, { region: rk, kind, intensity, bornAt: this.nowSec, lastSeenAt: this.nowSec });
  }

  tick(dt: number): void {
    this.nowSec += dt;
    if (Math.floor(this.nowSec) % 10 !== 0) return;
    const rng = new RNG(hash2i(Math.floor(this.nowSec / 10), 77, this.seed));
    for (const [rk, bucket] of this.nodes) {
      for (const [id, node] of bucket) {
        node.intensity -= dt * 0.004;
        if (node.intensity <= 0.02) {
          bucket.delete(id);
        } else if (rng.chance(0.03)) {
          const parts = rk.split(',');
          const nx = (Number(parts[0]) + rng.int(-1, 2)) * REGION_SIZE + 1;
          const nz = (Number(parts[1]) + rng.int(-1, 2)) * REGION_SIZE + 1;
          this.inject(nx, nz, node.kind, node.intensity * 0.7);
        }
      }
      if (bucket.size === 0) this.nodes.delete(rk);
    }
    if (rng.chance(0.15)) {
      const keys = [...this.trail.keys()];
      if (keys.length > 12) {
        const k = rng.pick(keys);
        const parts = k.split(',').map(Number);
        this.inject(
          parts[0] * REGION_SIZE + rng.range(-900, 900),
          parts[1] * REGION_SIZE + rng.range(-900, 900),
          MemoryKind.PERSONAL,
          rng.range(0.25, 0.5),
        );
      }
    }
  }

  serialize(): { nodes: [string, [string, MemoryNode][]][]; trail: [string, number][]; nowSec: number } {
    return {
      nodes: [...this.nodes.entries()].map(([k, b]) => [k, [...b.entries()]] as [string, [string, MemoryNode][]]),
      trail: [...this.trail.entries()],
      nowSec: this.nowSec,
    };
  }

  static deserialize(seed: number, data: ReturnType<MemoryField['serialize']> | null): MemoryField {
    const f = new MemoryField(seed);
    if (!data) return f;
    f.nowSec = data.nowSec ?? 0;
    for (const [rk, arr] of data.nodes ?? []) f.nodes.set(rk, new Map(arr));
    for (const [k, v] of data.trail ?? []) f.trail.set(k, v);
    return f;
  }

  stats(): Record<string, number> {
    let n = 0;
    for (const b of this.nodes.values()) n += b.size;
    return { deltaNodes: n, trailRegions: this.trail.size };
  }
}


