/*********************************************************************
 * Contact shadows - soft blob shadows under furniture props.
 *
 * Real shadow maps only cover what the torch touches (see shadows.ts);
 * furniture sitting outside any light used to look pasted onto the floor.
 * This module stamps a soft dark ellipse quad under every furniture prop
 * so each piece reads as *grounded* even in a dead corridor.
 *
 * Like lightpools.ts this is PURE canvas logic - no DOM, no Babylon,
 * safe in workers/tests:
 *
 *   - getShadowSpec() returns one declarative radial-gradient spec
 *     (center alpha fading to 0 at the rim) SHARED by every shadow
 *     instance - one texture, zero per-prop bitmap cost.
 *   - sampleShadowAlpha() evaluates that falloff analytically so tests
 *     can reason about coverage without a canvas.
 *   - paintShadowTexture() rasterizes the spec onto a
 *     CanvasRenderingContext2D (createRadialGradient) for consumers
 *     building the shared DynamicTexture / material.
 *   - generateForProps() turns a prop layout into shadow placements.
 *     Radius scales with the prop's mesher footprint; size/rotation
 *     jitter derives from a hash of the quantized world position, so
 *     the same layout always regenerates byte-identical shadows in any
 *     order.
 *
 * Shadows hover at y = SHADOW_Y (0.003): above the floor, below floor
 * debris and the wear decals, so nothing z-fights.
 *********************************************************************/

import { hash2i, rand2 } from '../core/rng';
import type { PropInstance, PropKind } from '../world/architect';

/** Texture edge length in texels (power of two for GPU friendliness). */
export const SHADOW_TEXTURE_SIZE = 128;

/** Height above the floor the shadow quads hover at. */
export const SHADOW_Y = 0.003;

/** Peak alpha at an ellipse's center; fades to 0 at the rim. */
export const SHADOW_ALPHA = 0.15;

/** Margin multiplier: the blob peeks out ~12% beyond the footprint. */
export const SHADOW_MARGIN = 1.12;

/** Salt for the per-prop size-jitter hash (arbitrary, fixed forever). */
const SALT_SIZE = 0xc0a1;

/** Salt for the independent rotation-jitter hash. */
const SALT_ROT = 0x5ead;

/** Size jitter half-range: radius scales by 1 +/- SIZE_JITTER. */
const SIZE_JITTER = 0.08;

/** Rotation jitter half-range in radians (~ +/- 3.4 degrees). */
const ROT_JITTER = 0.06;

/** One falloff stop on the gradient profile. */
export interface ShadowStop {
  /** Gradient radius fraction where this stop sits, 0..1. */
  at: number;
  /** Alpha at this stop (absolute; center == SHADOW_ALPHA). */
  a: number;
}

/** One radial gradient contribution, normalized 0..1 texture space. */
export interface ShadowGradient {
  /** Center, normalized 0..1 (0.5 = texture middle). */
  cx: number;
  cy: number;
  /** Radius as a fraction of texture size (rim of the blob). */
  r: number;
  /** Falloff profile, ascending by 'at', ending at the rim. */
  stops: ShadowStop[];
}

/** Declarative canvas spec returned by getShadowSpec(). */
export interface ShadowTextureSpec {
  /** Texture edge length in texels. */
  size: number;
  /** Radial gradients composited with source-over. */
  gradients: ShadowGradient[];
}

/**
 * Unrotated footprints (full width x depth, metres) lifted straight out
 * of the mesher's addProp boxes so blobs match what actually renders.
 */
export const PROP_FOOTPRINTS: Readonly<Record<PropKind, [number, number] | null>> = {
  desk: [1.5, 0.75],
  chair: [0.5, 0.5],
  cabinet: [0.95, 0.5],
  sofa: [1.9, 0.85],
  bed: [1.05, 2.05],
  bedframe: [1.0, 2.0],
  locker: [0.45, 0.5],
  gurney: [0.7, 1.95],
  bench: [1.7, 0.48],
  planter: [0.65, 0.65],
  turnstile: [0.35, 0.65],
  crate: null, // variant-dependent: see crateFootprint()
  stacked_chairs: [0.48, 0.48],
  tv: [0.62, 0.55],
  // battery is debris-scale and sits at y>=0.004 - ABOVE the shadow
  // plane - so it gets no blob (it would z-fight its own occupant).
  battery: null,
  vending: [0.92, 0.8],
  whiteboard: [1.55, 0.45],
  cooler: [0.4, 0.4],
  couch_l: [2.3, 1.4], // bounding box of the L (arm reaches +x)
  shelf: [0.9, 0.35],
};

/** One placed blob shadow. */
export interface ShadowInstance {
  /** Prop this shadow belongs to (echoed for wiring/debugging). */
  kind: PropKind;
  /** World-space center on the shadow plane. */
  x: number;
  z: number;
  /** Hover height: always SHADOW_Y. */
  y: number;
  /** Ellipse half-extent along local X/Z, metres (jitter included). */
  rx: number;
  rz: number;
  /** Local rotation around Y in radians (jitter only; blobs follow
   *  the footprint's quarter-turn orientation via rx/rz swapping). */
  rot: number;
  /** Peak alpha (SHADOW_ALPHA scaled by the same size jitter). */
  alpha: number;
}

/**
 * The ONE shared texture spec. Every ContactShadows instance samples the
 * same soft radial falloff - a single DynamicTexture serves the whole
 * scene regardless of prop count.
 */
let cachedSpec: ShadowTextureSpec | null = null;

export function getShadowSpec(): ShadowTextureSpec {
  if (!cachedSpec) {
    cachedSpec = {
      size: SHADOW_TEXTURE_SIZE,
      gradients: [
        {
          cx: 0.5,
          cy: 0.5,
          r: 0.5,
          stops: [
            { at: 0.0, a: SHADOW_ALPHA },
            { at: 0.45, a: SHADOW_ALPHA * 0.72 },
            { at: 0.8, a: SHADOW_ALPHA * 0.22 },
            { at: 1.0, a: 0 },
          ],
        },
      ],
    };
  }
  return cachedSpec;
}

/**
 * Evaluate the shared falloff analytically at normalized radius t
 * (0 = ellipse center, 1 = rim). Piecewise-linear across the stops.
 */
export function sampleShadowAlpha(t: number): number {
  const stops = getShadowSpec().gradients[0].stops;
  const u = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i].at) {
      const p = stops[i - 1], q = stops[i];
      const f = (u - p.at) / (q.at - p.at);
      return p.a + (q.a - p.a) * f;
    }
  }
  return 0;
}

/**
 * Rasterize the shared spec onto a 2D context. Consumers hand in the
 * context of a Babylon DynamicTexture canvas (or any CanvasRenderingContext2D).
 */
export function paintShadowTexture(
  ctx: CanvasRenderingContext2D, size: number,
): void {
  ctx.clearRect(0, 0, size, size);
  for (const gr of getShadowSpec().gradients) {
    const grad = ctx.createRadialGradient(
      gr.cx * size, gr.cy * size, 0,
      gr.cx * size, gr.cy * size, gr.r * size,
    );
    for (const st of gr.stops) {
      grad.addColorStop(st.at, 'rgba(0, 0, 0, ' + st.a.toFixed(6) + ')');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
}

/** Crate blobs track the variant-sized stack (mesher: s = 0.5+v*0.13). */
function crateFootprint(variant: number): [number, number] {
  const s = 0.5 + variant * 0.13;
  let w = s;
  if (variant === 3) w = Math.max(s, 0.12 + s * 0.8); // second offset crate
  return [w, s];
}

function footprintFor(kind: PropKind, variant: number): [number, number] | null {
  if (kind === 'crate') return crateFootprint(variant);
  const fp = PROP_FOOTPRINTS[kind];
  return fp ?? null;
}

/**
 * Turn a prop layout into blob-shadow placements. Deterministic: the
 * identical layout produces the identical list, always, because every
 * jitter draws from hashes of the quantized world position.
 *
 * Quarter-turn prop rotation swaps the footprint axes here (the blob
 * itself stays axis-aligned apart from the tiny organic rot jitter),
 * so a rotated desk still shades along its long axis.
 */
export function generateForProps(props: PropInstance[]): ShadowInstance[] {
  const out: ShadowInstance[] = [];
  for (const p of props) {
    const fp = footprintFor(p.kind, p.variant);
    if (!fp) continue; // battery & friends cast no blob

    // Deterministic per-prop jitter sources (position-quantized so
    // sub-tick float drift can never change a hash input).
    const qx = Math.round(p.x * 64);
    const qz = Math.round(p.z * 64);

    // Odd quarter-turns rotate the footprint 90 degrees.
    const [fw, fd] = p.rot % 2 === 0 ? fp : [fp[1], fp[0]];

    const sizeJit = 1 + (rand2(qx, qz, SALT_SIZE) * 2 - 1) * SIZE_JITTER;
    const rotJit = (rand2(qx, qz, SALT_ROT) * 2 - 1) * ROT_JITTER;

    out.push({
      kind: p.kind,
      x: p.x,
      z: p.z,
      y: SHADOW_Y,
      rx: fw * 0.5 * SHADOW_MARGIN * sizeJit,
      rz: fd * 0.5 * SHADOW_MARGIN * sizeJit,
      rot: rotJit,
      alpha: SHADOW_ALPHA * sizeJit,
    });
  }
  return out;
}


