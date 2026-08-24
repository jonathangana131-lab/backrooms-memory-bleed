/**
 * Procedural materials. All textures are painted on canvases at boot:
 * no external assets, deterministic per seed.
 *
 * Texture variety system:
 * - Carpet ships as CARPET_VARIANT_COUNT procedural variants (different noise
 *   seeds). Pick per chunk with carpetVariantIndex(cx, cz) so neighboring
 *   chunks usually wear different carpet while staying fully deterministic:
 *     mesh.material = textureVariety.carpetVariants[carpetVariantIndex(cx, cz)];
 *   MaterialSet keeps its legacy shape; the variety extras live on the
 *   module-level textureVariety singleton (populated by createMaterials).
 * - Walls carry baked water-damage stains (subtle dark blotches, alpha 0.1).
 * - Ceiling textures are a CEIL_TILES x CEIL_TILES tile sheet; each tile is
 *   darkened by its own hash so suspended-ceiling grids get patchy grime
 *   while keeping the 0.61 m world tile size (via texture uScale/vScale).
 * - markDirty(x, z, radius?) paints cumulative footfall grime into the
 *   carpet canvases near frequently-visited world positions.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Scene } from '@babylonjs/core/scene';
import { RNG, hash2i, rand2 } from '../core/rng';

/**
 * Shared handle to the dead-fixture material so other gfx systems
 * (blackout flicker in LightingRig) can pulse its emissive without a
 * circular import. Null until createMaterials() runs.
 */
export const fixtureDeadRef: { mat: StandardMaterial | null } = { mat: null };

export interface MaterialSet {
  /** Alias of textureVariety.carpetVariants[0]; kept for legacy consumers. */
  carpet: StandardMaterial;
  wall: StandardMaterial;
  ceiling: StandardMaterial;
  fixture: StandardMaterial;
  fixtureDead: StandardMaterial;
  prop: StandardMaterial;
  paper: StandardMaterial;
  puddle: StandardMaterial;
  stain: StandardMaterial;
}

/**
 * Everything the texture-variety system adds beyond the classic material set.
 * Lives outside MaterialSet because ChunkManager indexes materials by
 * keyof MaterialSet. Populated by createMaterials(); before that, carpetVariants
 * is empty and markDirty is a no-op.
 */
export interface TextureVariety {
  /** Procedural carpet variants; select per chunk via carpetVariantIndex(). */
  carpetVariants: StandardMaterial[];
  /** Darken floor texture near frequently-visited world positions. */
  markDirty(x: number, z: number, radius?: number): void;
  /** Visit accumulator backing markDirty (inspectable by tests/saves). */
  dirtMap: DirtMap;
}

// ---------------------------------------------------------------------------
// Carpet variant selection (pure, chunk-deterministic)
// ---------------------------------------------------------------------------

/** Number of distinct procedural carpet textures generated at boot. */
export const CARPET_VARIANT_COUNT = 3;

/** Salt isolating carpet-variant selection from all other coordinate hashes. */
const CARPET_VARIANT_SALT = 0x51ab3c7;

/**
 * Deterministic variant index for a chunk. Adjacent chunks pick independently,
 * so neighbors frequently differ, and any chunk always regenerates identical.
 */
export function carpetVariantIndex(cx: number, cz: number): number {
  return hash2i(cx, cz, CARPET_VARIANT_SALT) % CARPET_VARIANT_COUNT;
}

/**
 * Carpet UV frequency — MUST match the mesher's CARPET_SCALE (world meters
 * per one texture repeat) so markDirty lands its grime under the player.
 * Duplicated here because mesher.ts does not export it.
 */
export const CARPET_UV_SCALE = 1 / 1.7;

// ---------------------------------------------------------------------------
// Footfall dirt accumulation (pure logic; canvas painting lives in createMaterials)
// ---------------------------------------------------------------------------

/** World-space size of one visit bucket (~half a pace). */
export const DIRT_CELL = 1.25;
/** Darkening layers painted per bucket before it saturates. */
export const DIRT_MAX_LAYERS = 8;

/** One paintable grime splat in normalized carpet UV space. */
export interface DirtOp {
  u: number;
  v: number;
  /** Radius in UV units (multiply by texture width for pixels). */
  radiusU: number;
  /** Per-layer brush alpha; total darkening grows with repeat visits. */
  alpha: number;
  /** Visit count of the bucket this op came from (1..DIRT_MAX_LAYERS). */
  visits: number;
}

function frac(n: number): number {
  return n - Math.floor(n);
}

/**
 * Tracks how often world areas have been visited and converts visits into
 * paintable grime ops. Pure: no canvas/Babylon dependencies, unit-testable.
 */
export class DirtMap {
  private visits = new Map<string, number>();
  /** Total accepted marks across the session (diagnostics). */
  totalMarks = 0;

  /**
   * Record a visit at (x, z). Returns the splat to paint, or null once that
   * bucket has saturated (DIRT_MAX_LAYERS layers already laid down).
   */
  mark(x: number, z: number, radius = 1.4): DirtOp | null {
    const gx = Math.floor(x / DIRT_CELL);
    const gz = Math.floor(z / DIRT_CELL);
    const key = gx + ':' + gz;
    const n = (this.visits.get(key) ?? 0) + 1;
    this.visits.set(key, n);
    this.totalMarks++;
    if (n > DIRT_MAX_LAYERS) return null;
    // Deterministic jitter inside the bucket so repeated layers feather out
    // into a scuff trail instead of stacking on one pixel.
    const jx = (rand2(gx, gz, 7717) - 0.5) * DIRT_CELL * 0.6;
    const jz = (rand2(gx, gz, 7718) - 0.5) * DIRT_CELL * 0.6;
    return {
      u: frac((x + jx) * CARPET_UV_SCALE),
      v: frac((z + jz) * CARPET_UV_SCALE),
      radiusU: radius * CARPET_UV_SCALE,
      alpha: 0.09,
      visits: n,
    };
  }

  /** How many times a world position's bucket has been marked. */
  visitsAt(x: number, z: number): number {
    return this.visits.get(Math.floor(x / DIRT_CELL) + ':' + Math.floor(z / DIRT_CELL)) ?? 0;
  }

  reset(): void {
    this.visits.clear();
    this.totalMarks = 0;
  }
}

/** Module-level variety handle, populated by createMaterials(). */
export const textureVariety: TextureVariety = {
  carpetVariants: [],
  markDirty: () => {},
  dirtMap: new DirtMap(),
};

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeTex(scene: Scene, name: string, w: number, h: number): { tex: DynamicTexture; ctx: CanvasRenderingContext2D } {
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  return { tex, ctx };
}

/** value-noise-ish pixel noise onto ctx */
function paintNoise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: RNG, amount: number, mono: boolean): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    if (mono) {
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    } else {
      d[i] += (rng.next() - 0.5) * amount;
      d[i + 1] += (rng.next() - 0.5) * amount;
      d[i + 2] += (rng.next() - 0.5) * amount;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function blobs(ctx: CanvasRenderingContext2D, w: number, h: number, rng: RNG, count: number, color: string, minR: number, maxR: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = rng.next() * w;
    const y = rng.next() * h;
    const r = rng.range(minR, maxR);
    const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, color.replace('ALPHA', String(alpha * rng.range(0.5, 1))));
    g.addColorStop(1, color.replace('ALPHA', '0'));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// ---------------------------------------------------------------------------
// Carpet variant painter
// ---------------------------------------------------------------------------

/** Base seed for variant noise; each variant strides far apart. */
const CARPET_SEED_BASE = 101;
const CARPET_VARIANT_STRIDE = 7919;

/** Paint one mustard office-carpet variant. Fully seeded => deterministic. */
function paintCarpet(c: CanvasRenderingContext2D, w: number, h: number, variant: number): void {
  const seed = CARPET_SEED_BASE + variant * CARPET_VARIANT_STRIDE;
  c.fillStyle = '#7a6a33';
  c.fillRect(0, 0, w, h);
  // per-variant fiber noise (this is the seed that differs between variants)
  paintNoise(c, w, h, new RNG(seed), 46, false);
  // fiber streaks (fully seeded; unseeded before the variety pass)
  const rs = new RNG(seed ^ 0x9e3779b9);
  c.globalAlpha = 0.08;
  for (let i = 0; i < 900; i++) {
    const x = rs.next() * w, y = rs.next() * h;
    c.strokeStyle = rs.chance(0.5) ? '#4d411e' : '#96823f';
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rs.next() - 0.5) * 14, y + (rs.next() - 0.5) * 14); c.stroke();
  }
  c.globalAlpha = 1;
  blobs(c, w, h, new RNG(seed + 101), 26, 'rgba(30,24,8,ALPHA)', 18, 90, 0.22);
  blobs(c, w, h, new RNG(seed + 202), 10, 'rgba(120,100,40,ALPHA)', 12, 50, 0.16);
}

// ---------------------------------------------------------------------------
// Ceiling tile sheet
// ---------------------------------------------------------------------------

const CEIL_TEX_SIZE = 512;
/** Ceiling tiles per texture side; uScale/vScale keep each tile 0.61 m wide. */
const CEIL_TILES = 4;
/** Salt for per-tile grime hashing (independent of all other hashes). */
const CEIL_GRIME_SALT = 0x2f61b;

/** Paint the ceiling as a CEIL_TILES-square sheet with hash-driven per-tile grime. */
function paintCeiling(c: CanvasRenderingContext2D): void {
  const S = CEIL_TEX_SIZE;
  const T = S / CEIL_TILES;
  c.fillStyle = '#b8ad8a';
  c.fillRect(0, 0, S, S);
  paintNoise(c, S, S, new RNG(909), 20, true);

  for (let ty = 0; ty < CEIL_TILES; ty++) {
    for (let tx = 0; tx < CEIL_TILES; tx++) {
      const px = tx * T, py = ty * T;
      const srng = new RNG(hash2i(tx + 31, ty + 57, 909));
      // per-tile grime: hash decides how dirty this particular tile is
      const grime = rand2(tx, ty, CEIL_GRIME_SALT);
      if (grime > 0.25) {
        c.fillStyle = 'rgba(28,24,16,' + (Math.min(grime, 1) * 0.16).toFixed(3) + ')';
        c.fillRect(px, py, T, T);
      }
      // mineral-fiber speckles (seeded per tile)
      for (let i = 0; i < 165; i++) {
        c.fillStyle = srng.chance(0.5) ? 'rgba(90,82,60,0.5)' : 'rgba(230,225,200,0.5)';
        c.fillRect(px + srng.next() * T, py + srng.next() * T, 2, 2);
      }
      // occasional brown water bloom confined to this tile
      if (srng.chance(0.22)) {
        const bx = px + srng.range(T * 0.25, T * 0.75);
        const by = py + srng.range(T * 0.25, T * 0.75);
        const br = srng.range(T * 0.15, T * 0.42);
        const wg = c.createRadialGradient(bx, by, br * 0.1, bx, by, br);
        wg.addColorStop(0, 'rgba(122,96,44,' + (0.25 * srng.range(0.5, 1)).toFixed(3) + ')');
        wg.addColorStop(1, 'rgba(122,96,44,0)');
        c.fillStyle = wg;
        c.fillRect(px, py, T, T);
      }
      // tile grid seams (shared edges are overdrawn harmlessly)
      c.strokeStyle = 'rgba(60,54,38,0.85)';
      c.lineWidth = 5;
      c.strokeRect(px, py, T, T);
      c.strokeStyle = 'rgba(60,54,38,0.35)';
      c.lineWidth = 2;
      c.strokeRect(px + 6, py + 6, T - 12, T - 12);
    }
  }
}

// ---------------------------------------------------------------------------

export function createMaterials(scene: Scene): MaterialSet {
  // ---- CARPET: mustard office carpet, dense fiber noise, stains ----
  // Three procedural variants (different noise seeds); chunks select among
  // them deterministically via carpetVariantIndex(cx, cz).
  const cw = 512;
  interface CarpetSurface { tex: DynamicTexture; ctx: CanvasRenderingContext2D; w: number; h: number; }
  const carpetSurfaces: CarpetSurface[] = [];
  for (let v = 0; v < CARPET_VARIANT_COUNT; v++) {
    const car = makeTex(scene, 'carpetAlb' + v, cw, cw);
    paintCarpet(car.ctx, cw, cw, v);
    carpetSurfaces.push({ tex: car.tex, ctx: car.ctx, w: cw, h: cw });
  }
  const carpetBump = makeTex(scene, 'carpetBmp', 256, 256);
  {
    carpetBump.ctx.fillStyle = '#808080';
    carpetBump.ctx.fillRect(0, 0, 256, 256);
    paintNoise(carpetBump.ctx, 256, 256, new RNG(404), 110, true);
  }

  const carpetVariants: StandardMaterial[] = [];
  for (let v = 0; v < CARPET_VARIANT_COUNT; v++) {
    const mat = new StandardMaterial('matCarpet' + v, scene);
    mat.diffuseTexture = carpetSurfaces[v].tex;
    mat.bumpTexture = carpetBump.tex;
    (mat.diffuseTexture as Texture).uScale = 1; (mat.diffuseTexture as Texture).vScale = 1;
    mat.specularColor = new Color3(0.03, 0.03, 0.02);
    mat.specularPower = 8;
    carpetVariants.push(mat);
  }
  const carpet = carpetVariants[0];

  // ---- WALL: pale yellow wallpaper with skirting baked at v bottom ----
  const ww = 512, wh = 512;
  const wal = makeTex(scene, 'wallAlb', ww, wh);
  {
    const c = wal.ctx;
    const g = c.createLinearGradient(0, 0, 0, wh);
    g.addColorStop(0, '#cfc27a');
    g.addColorStop(0.5, '#c6b76c');
    g.addColorStop(0.92, '#b3a35c');
    g.addColorStop(1, '#6e6234'); // skirting band (bottom of texture)
    c.fillStyle = g;
    c.fillRect(0, 0, ww, wh);
    paintNoise(c, ww, wh, new RNG(505), 16, false);
    // faint vertical wallpaper stripes
    c.globalAlpha = 0.05;
    for (let x = 0; x < ww; x += 42) {
      c.fillStyle = '#8f7f3a';
      c.fillRect(x, 0, 21, wh);
    }
    c.globalAlpha = 1;
    // mottling
    blobs(c, ww, wh, new RNG(606), 34, 'rgba(140,120,60,ALPHA)', 20, 80, 0.10);
    blobs(c, ww, wh, new RNG(707), 22, 'rgba(70,58,20,ALPHA)', 14, 60, 0.13);
    // grime rising from floor
    const gr = c.createLinearGradient(0, wh, 0, wh * 0.78);
    gr.addColorStop(0, 'rgba(40,32,12,0.45)');
    gr.addColorStop(1, 'rgba(40,32,12,0)');
    c.fillStyle = gr;
    c.fillRect(0, wh * 0.78, ww, wh * 0.22);
    // skirting top edge line
    c.fillStyle = 'rgba(30,26,12,0.8)';
    c.fillRect(0, wh - 4, ww, 3);
    // ---- WATER DAMAGE: faint dark blotches seeping at random spots ----
    blobs(c, ww, wh, new RNG(8484), 12, 'rgba(46,36,20,ALPHA)', 18, 72, 0.10);
    // drip streaks trickling down from some of the blotches
    const dr = new RNG(8485);
    for (let i = 0; i < 8; i++) {
      const dx = dr.next() * ww;
      const dy = dr.range(wh * 0.04, wh * 0.55);
      const len = dr.range(40, 170);
      const wid = dr.range(2, 6);
      const dg = c.createLinearGradient(0, dy, 0, dy + len);
      dg.addColorStop(0, 'rgba(46,36,20,0.10)');
      dg.addColorStop(1, 'rgba(46,36,20,0)');
      c.fillStyle = dg;
      c.fillRect(dx, dy, wid, len);
    }
  }
  const wallBump = makeTex(scene, 'wallBmp', 256, 256);
  {
    wallBump.ctx.fillStyle = '#808080';
    wallBump.ctx.fillRect(0, 0, 256, 256);
    paintNoise(wallBump.ctx, 256, 256, new RNG(808), 34, true);
  }
  const wall = new StandardMaterial('matWall', scene);
  wall.diffuseTexture = wal.tex;
  wall.bumpTexture = wallBump.tex;
  wall.specularColor = new Color3(0.05, 0.05, 0.04);

  // ---- CEILING: mineral tiles with grid, per-tile hash grime ----
  const ce = makeTex(scene, 'ceilAlb', CEIL_TEX_SIZE, CEIL_TEX_SIZE);
  paintCeiling(ce.ctx);
  const ceiling = new StandardMaterial('matCeiling', scene);
  ceiling.diffuseTexture = ce.tex;
  // The sheet holds CEIL_TILES squared world tiles; mesher UVs run at 1 repeat
  // per 0.61 m, so scaling repeats down by CEIL_TILES keeps every tile 0.61 m
  // while letting each physical tile carry its own grime level.
  (ceiling.diffuseTexture as Texture).uScale = 1 / CEIL_TILES;
  (ceiling.diffuseTexture as Texture).vScale = 1 / CEIL_TILES;
  ceiling.specularColor = new Color3(0.04, 0.04, 0.03);

  // ---- FIXTURES ----
  const fx = makeTex(scene, 'fixtureAlb', 128, 64);
  {
    const c = fx.ctx;
    const g = c.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, '#fffbe8');
    g.addColorStop(0.5, '#fffff4');
    g.addColorStop(1, '#fdf3cf');
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 64);
    // diffuser ribs
    c.globalAlpha = 0.15;
    for (let x = 0; x < 128; x += 8) {
      c.fillStyle = '#c9bd92';
      c.fillRect(x, 0, 3, 64);
    }
    c.globalAlpha = 1;
  }
  const fixture = new StandardMaterial('matFixture', scene);
  fixture.diffuseTexture = fx.tex;
  fixture.emissiveTexture = fx.tex;
  fixture.emissiveColor = new Color3(1.0, 0.98, 0.86);
  fixture.disableLighting = true;

  const fixtureDead = new StandardMaterial('matFixtureDead', scene);
  fixtureDead.diffuseColor = new Color3(0.16, 0.15, 0.11);
  fixtureDead.specularColor = Color3.Black();
  // baseline: fully dark tube. LightingRig flashes this high for single
  // frames during blackouts, so it must NOT be frozen below.
  fixtureDead.emissiveColor = Color3.Black();
  fixtureDeadRef.mat = fixtureDead;

  // ---- PROPS: grimy furniture material ----
  const pw = 256;
  const prm = makeTex(scene, 'propAlb', pw, pw);
  {
    const c = prm.ctx;
    c.fillStyle = '#4a4238';
    c.fillRect(0, 0, pw, pw);
    paintNoise(c, pw, pw, new RNG(1234), 26, false);
    blobs(c, pw, pw, new RNG(2345), 14, 'rgba(20,16,10,ALPHA)', 10, 40, 0.3);
    // scratches (seeded: texture generation must stay deterministic)
    c.globalAlpha = 0.12;
    const srng = new RNG(0x5ca7);
    for (let i = 0; i < 60; i++) {
      c.strokeStyle = '#1a150e';
      const x = srng.next() * pw, y = srng.next() * pw;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (srng.next() - 0.5) * 50, y + (srng.next() - 0.5) * 12); c.stroke();
    }
    c.globalAlpha = 1;
  }
  const prop = new StandardMaterial('matProp', scene);
  prop.diffuseTexture = prm.tex;
  prop.specularColor = new Color3(0.04, 0.04, 0.03);
  prop.maxSimultaneousLights = 16;

  // ---- PAPER litter ----
  const pap = makeTex(scene, 'paperAlb', 64, 64);
  {
    const c = pap.ctx;
    c.fillStyle = '#cfc8b0';
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = 'rgba(90,86,70,0.5)';
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      c.moveTo(6 + i * 11, 14);
      c.lineTo(6 + i * 11, 50);
      c.stroke();
    }
    c.fillStyle = 'rgba(120,100,60,0.25)';
    c.fillRect(0, 52, 64, 12);
  }
  const paper = new StandardMaterial('matPaper', scene);
  paper.diffuseTexture = pap.tex;
  paper.specularColor = new Color3(0.05, 0.05, 0.04);
  paper.maxSimultaneousLights = 16;

  // ---- PUDDLES: dark damp patches that catch the fluorescents ----
  const puddle = new StandardMaterial('matPuddle', scene);
  puddle.diffuseColor = new Color3(0.13, 0.135, 0.115);
  puddle.specularColor = new Color3(1.5, 1.45, 1.2);
  puddle.specularPower = 96;
  puddle.emissiveColor = new Color3(1.0, 0.1, 0.05); // TEMP diagnostic red
  puddle.maxSimultaneousLights = 16;

  // ---- CEILING STAINS: dark water blooms ----
  const stain = new StandardMaterial('matStain', scene);
  stain.diffuseColor = new Color3(0.16, 0.12, 0.06);
  stain.specularColor = new Color3(0.5, 0.48, 0.38);
  stain.specularPower = 42;
  stain.emissiveColor = new Color3(0.012, 0.01, 0.006);
  stain.maxSimultaneousLights = 16;

  // ---- DYNAMIC DIRTYING: footfall grime brushed into the carpet canvases ----
  const dirtMap = new DirtMap();
  const markDirty = (x: number, z: number, radius = 1.4): void => {
    const op = dirtMap.mark(x, z, radius);
    if (!op) return; // bucket saturated
    // Same world spot must darken on every variant: chunks show different
    // canvases but share world-anchored UVs, so paint all three.
    for (const s of carpetSurfaces) {
      const px = op.u * s.w;
      // DynamicTexture canvases are uploaded flipped: canvas row 0 is v = 1.
      const py = (1 - op.v) * s.h;
      const rpx = Math.max(2, op.radiusU * s.w);
      const dg = s.ctx.createRadialGradient(px, py, rpx * 0.15, px, py, rpx);
      dg.addColorStop(0, 'rgba(24,20,10,' + op.alpha + ')');
      dg.addColorStop(1, 'rgba(24,20,10,0)');
      s.ctx.fillStyle = dg;
      s.ctx.fillRect(px - rpx, py - rpx, rpx * 2, rpx * 2);
    }
    for (const s of carpetSurfaces) s.tex.update(false);
  };

  // allow the pooled point lights to reach every material
  for (const m of [carpet, wall, ceiling]) m.maxSimultaneousLights = 16;

  // upload all painted canvases to GPU
  for (const s of carpetSurfaces) s.tex.update(false);
  carpetBump.tex.update(false);
  wal.tex.update(false);
  wallBump.tex.update(false);
  ce.tex.update(false);
  fx.tex.update(false);
  prm.tex.update(false);
  pap.tex.update(false);

  // static world materials never need recompilation
  // NOTE: fixtureDead stays unfrozen - its emissiveColor is pulsed at runtime
  // by the blackout flicker swap in LightingRig.update().
  // Frozen materials still accept DynamicTexture.update() content uploads,
  // which is all markDirty needs.
  for (const m of [...carpetVariants, wall, ceiling, prop, paper]) m.freeze();

  puddle.freeze();
  stain.freeze();

  // publish the variety system for chunk managers / gameplay systems
  textureVariety.carpetVariants = carpetVariants;
  textureVariety.markDirty = markDirty;
  textureVariety.dirtMap = dirtMap;

  return { carpet, wall, ceiling, fixture, fixtureDead, prop, paper, puddle, stain };
}


