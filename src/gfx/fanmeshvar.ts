/**
 * Ceiling-fan appearance variants - blade profiles, hub treatments and
 * district finish tints, all emitted as pure data.
 *
 * ceilingfan.ts owns placement, spin state and the merged Babylon mesh;
 * this module owns WHAT a particular fan looks like before any engine
 * object exists. Every emitter returns axis-aligned box specs in fan-local
 * space (origin at the blade-disc centre, +Y up, negative Y hanging down
 * the drop rod), so variants compose without touching mesher code:
 *
 *   FanMeshVar.blades('airfoil', 'industrial')
 *   FanMeshVar.hub('stacked', 'industrial')
 *
 * Pure logic - no Babylon dependency, fully deterministic: same inputs
 * give identical spec arrays every session. No randomness anywhere; the
 * caller picks styles via src/core/rng.ts if it wants variation.
 */

/** Blade silhouette family for one fan. */
export type BladeStyle = 'flat' | 'paddle' | 'airfoil';

/** Hub treatment for one fan. */
export type HubStyle = 'plain' | 'stacked';

/** District finish driving the RGB tint multipliers. */
export type FinishStyle = 'office' | 'medical' | 'industrial';

/**
 * Vertex tint as linear RGB multipliers applied through the mesher's
 * vertex-color pass. [1, 1, 1] leaves material colors alone.
 */
export type Tint = [number, number, number];

/**
 * One mesher-ready box in fan-local space, mirroring the mesher's
 * addBox(m, x, z, y0, y1, w, d) argument-for-argument: x/z is the box
 * CENTER column, y0/y1 the vertical span relative to the blade-disc
 * plane, w/d FULL horizontal extents.
 */
export interface BoxSpec {
  /** Center column X in meters (addBox arg 2). */
  x: number;
  /** Center column Z in meters (addBox arg 3). */
  z: number;
  /** Bottom of the box relative to the blade disc (addBox arg 4). */
  y0: number;
  /** Top of the box relative to the blade disc (addBox arg 5). */
  y1: number;
  /** FULL extent along X in meters (addBox arg 6). */
  w: number;
  /** FULL extent along Z in meters (addBox arg 7). */
  d: number;
  /** Per-box RGB multipliers; every emitter fills this in. */
  tint: Tint;
}

/** Tint placeholder used when the caller passes no finish. */
const NEUTRAL_TINT: Tint = [1, 1, 1];

/** Per-finish RGB multipliers: office stays near-white, medical cools
 * down, industrial darkens toward grimy brown-grey painted metal. */
const FINISH_TINTS: Record<FinishStyle, Tint> = {
  office: [1.0, 0.97, 0.92],
  medical: [0.93, 0.97, 1.0],
  industrial: [0.78, 0.76, 0.72],
};

/** Exhaustive-switch guard: fails loud on an unknown style literal. */
function fail(what: string, value: never): never {
  throw new Error('fanmeshvar: unknown ' + what + ': ' + String(value));
}

/* ------------------------------------------------------------------ */
/* Blade emitters                                                      */
/* ------------------------------------------------------------------ */

/** Radial distance from hub edge to blade tip, in meters. */
const BLADE_REACH = 0.62;

/** Emit one blade profile four times, once per cardinal direction. */
function fourBlades(
  tint: Tint,
  inner: number,
  outer: number,
  halfWid: number,
  y0: number,
  y1: number,
): BoxSpec[] {
  const out: BoxSpec[] = [];
  for (const alongX of [false, true]) {
    for (const sign of [1, -1]) {
      const start = sign > 0 ? inner : -outer;
      const end = sign > 0 ? outer : -inner;
      // Each arm centers on its own midpoint, so signed spans mirror cleanly.
      const mid = (inner + outer) / 2;
      const len = outer - inner;
      if (alongX) {
        out.push({ x: sign * mid, z: 0, y0, y1, w: len, d: 2 * halfWid, tint });
      } else {
        out.push({ x: 0, z: sign * mid, y0, y1, w: 2 * halfWid, d: len, tint });
      }
    }
  }
  return out;
}

/** Flat stamped-steel blades: one thin plate per arm, constant chord. */
function flatBlades(tint: Tint): BoxSpec[] {
  return fourBlades(tint, 0.12, BLADE_REACH, 0.055, -0.008, 0);
}

/** Paddle blades: wider chord, thicker section, drooping tips. */
function paddleBlades(tint: Tint): BoxSpec[] {
  const out: BoxSpec[] = fourBlades(tint, 0.10, BLADE_REACH, 0.075, -0.014, 0.006);
  // Tip pads drop the outer third a further 12 mm, reading as pitched wood.
  for (const s of [1, -1]) {
    out.push({ x: s * 0.47, z: 0, y0: -0.026, y1: -0.008, w: 0.30, d: 0.15, tint });
    out.push({ x: 0, z: s * 0.47, y0: -0.026, y1: -0.008, w: 0.15, d: 0.30, tint });
  }
  return out;
}

/** Airfoil blades: a fat leading-edge spar plus a thin trailing skin. */
function airfoilBlades(tint: Tint): BoxSpec[] {
  const out: BoxSpec[] = [];
  // Spar: narrow, thick, set toward the leading edge of each arm.
  const spar = fourBlades(tint, 0.11, BLADE_REACH - 0.08, 0.03, -0.016, 0.010);
  out.push(...spar);
  // Trailing skin: wide, paper-thin, flush with the spar top.
  const skin = fourBlades(tint, 0.16, BLADE_REACH, 0.075, -0.004, 0);
  out.push(...skin);
  return out;
}

/* ------------------------------------------------------------------ */
/* Hub emitters                                                        */
/* ------------------------------------------------------------------ */

/**
 * Push one squat cylinder as a crossed pair of slabs - the merge hides
 * the seam and the silhouettes reads round at fan scale.
 */
function pushDisc(out: BoxSpec[], r: number, yTop: number, yBottom: number, tint: Tint): void {
  out.push({ x: 0, z: 0, y0: yBottom, y1: yTop, w: 2 * r, d: r, tint });
  out.push({ x: 0, z: 0, y0: yBottom, y1: yTop, w: r, d: 2 * r, tint });
}

/** Plain hub: a single shallow drum just under the blade plane. */
function plainHub(tint: Tint): BoxSpec[] {
  const out: BoxSpec[] = [];
  pushDisc(out, 0.09, -0.290, -0.350, tint);
  return out;
}

/** Stacked hub: three stepped drums tapering down the rod. */
function stackedHub(tint: Tint): BoxSpec[] {
  const out: BoxSpec[] = [];
  // Top collar hugs the rod, mid disc bulges, lower disc steps back in -
  // overlaps between bands stop hairline seams in the merged mesh.
  pushDisc(out, 0.09, -0.310, -0.370, tint);
  pushDisc(out, 0.19, -0.350, -0.415, tint);
  pushDisc(out, 0.13, -0.400, -0.450, tint);
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const FanMeshVar = {
  /**
   * Emit the four blades for one profile as axis-aligned box specs in
   * fan-local space. With 'finish' given, each spec carries the finish
   * tint; otherwise the neutral [1,1,1] placeholder.
   */
  blades(style: BladeStyle, finish?: FinishStyle): BoxSpec[] {
    const tint = finish ? this.tints(finish) : NEUTRAL_TINT;
    switch (style) {
      case 'flat': return flatBlades(tint);
      case 'paddle': return paddleBlades(tint);
      case 'airfoil': return airfoilBlades(tint);
      default: return fail('blade style', style);
    }
  },

  /**
   * Emit the hub treatment as axis-aligned box specs in fan-local space.
   * With 'finish' given, each spec carries the finish tint; otherwise
   * the neutral [1,1,1] placeholder.
   */
  hub(style: HubStyle, finish?: FinishStyle): BoxSpec[] {
    const tint = finish ? this.tints(finish) : NEUTRAL_TINT;
    switch (style) {
      case 'plain': return plainHub(tint);
      case 'stacked': return stackedHub(tint);
      default: return fail('hub style', style);
    }
  },

  /** Per-finish RGB tint multipliers (office / medical / industrial). */
  tints(style: FinishStyle): Tint {
    switch (style) {
      case 'office':
      case 'medical':
      case 'industrial':
        return FINISH_TINTS[style];
      default: return fail('finish style', style);
    }
  },
};

/**
 * Feed box specs straight through the mesher's addBox pattern:
 * each spec becomes addBox(mesh, x, z, y0, y1, w, d). The caller adds the
 * fan's world offset inside its own addBox closure (mirroring how props
 * pass p.x/p.z through). Optional per-box tint hooks mirror the mesher's
 * tintVerts pattern: record positions.length / 3 BEFORE the box, multiply
 * the recorded range by the spec tint AFTER it.
 *
 * @param mesh destination mesh arrays bundle the caller owns
 * @param specs box specs from FanMeshVar.blades()/hub()
 * @param addBox mesher-compatible emission callback
 * @param hooks optional vertex-tint pass, omitted for untinted meshes
 */
export function emitFanBoxes<M>(
  mesh: M,
  specs: BoxSpec[],
  addBox: (mesh: M, x: number, z: number, y0: number, y1: number, w: number, d: number) => void,
  hooks?: {
    vertCount: (mesh: M) => number;
    tint: (mesh: M, fromVert: number, r: number, g: number, b: number) => void;
  },
): void {
  for (const s of specs) {
    const fromVert = hooks ? hooks.vertCount(mesh) : 0;
    addBox(mesh, s.x, s.z, s.y0, s.y1, s.w, s.d);
    if (hooks) hooks.tint(mesh, fromVert, s.tint[0], s.tint[1], s.tint[2]);
  }
}
