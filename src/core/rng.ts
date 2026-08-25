/**
 * Deterministic hash-based RNG utilities.
 * All world generation derives from integer hashes of (seed, coords)
 * so any chunk can be regenerated identically at any time, in any order.
 */

export function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

export function hash3i(x: number, y: number, z: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(y | 0), 0xc2b2ae35);
  h = Math.imul(h ^ hash32(z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

export function hash4i(a: number, b: number, c: number, d: number, salt = 0): number {
  return hash3i(hash2i(a, b, salt), c, d, salt ^ 0x7f4a7c15);
}

export function rand2(x: number, y: number, salt = 0): number {
  return hash2i(x, y, salt) / 4294967296;
}
export function rand3(x: number, y: number, z: number, salt = 0): number {
  return hash3i(x, y, z, salt) / 4294967296;
}

export class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** Raw stream position — snapshot it to persist a deterministic draw sequence. */
  get state(): number {
    return this.s >>> 0;
  }
  set state(v: number) {
    this.s = v >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(minIncl: number, maxExcl: number): number {
    return Math.floor(this.range(minIncl, maxExcl));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function valueNoise2(x: number, y: number, salt = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = rand2(xi, yi, salt);
  const b = rand2(xi + 1, yi, salt);
  const c = rand2(xi, yi + 1, salt);


  const d = rand2(xi + 1, yi + 1, salt);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm2(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5, salt = 0): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, salt + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}


