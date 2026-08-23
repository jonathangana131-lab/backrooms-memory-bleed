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


