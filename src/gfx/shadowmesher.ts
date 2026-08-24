/**
 * Shadow mesher emission pass.
 *
 * Turns the declarative blob placements from contactshadow.ts into flat,
 * floor-hugging vertex-tinted quads that the chunk mesher bakes straight
 * into the floor geometry (layout.shadowQuads -> CornerAO-style batches).
 *
 * Pure math over plain arrays: no DOM, no Babylon, safe in workers/tests.
 * Deterministic per prop - the pass is a pure map over generateForProps(),
 * whose jitter derives from quantized world position hashes, so any input
 * order regenerates byte-identical output.
 */

import {
  SHADOW_Y,
  SHADOW_ALPHA,
  generateForProps,
  type ShadowInstance,
} from './contactshadow';
import type { PropInstance } from '../world/architect';

/** Default darkening applied at (or above) the reference alpha. */
export const SHADOW_STRENGTH = 0.85;

/**
 * Vertex gray tint for a blob whose center alpha is alpha.
 * Linear in alpha up to the reference (SHADOW_ALPHA), clamped on both
 * sides so weird inputs stay neutral: alpha <= 0 leaves the vertex white,
 * alpha >= reference applies the full configured darkening.
 */
export function shadowVertexTint(alpha: number, strength: number): number {
  if (alpha <= 0) return 1;
  const t = Math.min(1, alpha / SHADOW_ALPHA);
  return 1 - strength * t;
}

/** One emitted floor quad (CornerAO drop-in shape). */
export interface ShadowQuad {
  /** 4 corners x xyz, CCW seen from above, y === SHADOW_Y. */
  positions: number[];
  /** Flat-shade normal, always (0, 1, 0). */
  normal: number[];
  /** 4 corners x RGB, every channel equal to the vertex tint. */
  tints: number[];
}

/** Local corner layout, CCW seen from above (+y). */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, 1],
  [1, -1],
];

/**
 * Batches props into shadow quads. Construct once per world, feed every
 * chunk's prop list through generate(); the strength option scales how
 * dark the darkest allowed tint gets (clamped into 0..1).
 */
export class ShadowMesherPass {
  /** Effective darkening strength after clamping (0..1). */
  readonly strength: number;

  constructor(opts?: { strength?: number }) {
    this.strength = Math.min(1, Math.max(0, opts?.strength ?? SHADOW_STRENGTH));
  }

  /**
   * Emit one ground quad per shadow-bearing prop.
   * @param props prop instances from the chunk layout
   */
  generate(props: PropInstance[]): ShadowQuad[] {
    const shadows = generateForProps(props);
    const quads: ShadowQuad[] = [];
    for (const s of shadows) quads.push(this.quadFor(s));
    return quads;
  }

  /** Build one CCW quad centered under its blob instance. */
  private quadFor(s: ShadowInstance): ShadowQuad {
    const tint = shadowVertexTint(s.alpha, this.strength);
    const cos = Math.cos(s.rot);
    const sin = Math.sin(s.rot);

    const positions: number[] = [];
    const tints: number[] = [];
    for (const corner of CORNERS) {
      const lx = corner[0] * s.rx;
      const lz = corner[1] * s.rz;
      positions.push(s.x + lx * cos - lz * sin, SHADOW_Y, s.z + lx * sin + lz * cos);
      tints.push(tint, tint, tint);
    }
    return { positions, normal: [0, 1, 0], tints };
  }
}
