/**
 * Deterministic procedural dressing for sign and graffiti textures.
 *
 * Pure functions over (text, kind) — no Babylon, no DOM — so ChunkManager
 * stays importable headless and tests can assert that a rebuilt chunk
 * renders byte-identical dressing.
 */
import { hash2i, RNG, seedFromString } from '../core/rng';

/** Salt keeping texture-grime streams independent of layout/beacon streams. */
const TEXTURE_SALT = 0x67e1ce >>> 0;

/**
 * Grime speckles painted onto one sign texture. Pure: the same (text,
 * kind) always yields the identical speckle field, so a rebuilt chunk (or
 * a re-entered landmark) renders identical dressing. Positions are uniform
 * over the 512x128 sign canvas with the original 3x2 brush.
 * @param text Sign text backing the material cache key.
 * @param kind Numeric sign kind; different kinds get independent streams.
 * @param count Speckle count (matches the original 40-brush loop).
 * @returns Rect list in canvas pixels ready for ctx.fillRect.
 */
export function signGrimeRects(
  text: string,
  kind: number,
  count = 40,
): { x: number; y: number; w: number; h: number }[] {
  const rng = new RNG(hash2i(seedFromString(text), kind | 0, TEXTURE_SALT));
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({ x: rng.next() * 512, y: rng.next() * 128, w: 3, h: 2 });
  }
  return rects;
}

/**
 * Deterministic graffiti tilt in [-0.05, 0.05) rad, stable per text so a
 * re-rendered fragment leans exactly the way it did when first seen.
 * @param text Graffiti fragment backing the material cache key.
 * @returns Rotation in radians for the texture-space text draw.
 */
export function graffitiTilt(text: string): number {
  const rng = new RNG(hash2i(seedFromString(text), 2, TEXTURE_SALT));
  return rng.range(-0.05, 0.05);
}
