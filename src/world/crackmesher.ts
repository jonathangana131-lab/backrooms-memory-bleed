/**
 * CrackMesherPass — emission adapter from wall-crack instances to decal quads.
 *
 * cracks.ts decides WHERE the Backrooms remember being haunted ({x, z,
 * rotY, stage} CrackInstances); this pass decides how those memories LOOK.
 * Each crack's jagged trunk-and-branch polyline (buildCrackGeometry) is
 * projected onto a vertical plane hugging the wall face — every segment
 * becomes one dark, tapering QuadInstance in exactly the CornerAO/moisture/
 * wallwear decal contract: four world-space corners (CCW from the normal),
 * a shared surface normal, and flat per-corner RGB multipliers the mesher
 * applies as a tint pass. Quads sit CRACK_DECAL_OFFSET (0.008 m) proud of
 * the wall surface so they never z-fight.
 *
 * Escalation reads straight off the instance's stage, mirroring the growth
 * laws inside buildCrackGeometry: higher stage = longer quads (everything
 * stretches by the shared 1 + 0.18/stage growth factor) and darker tints
 * (darkness 0.5 + 0.12/stage, capped), so rooms visibly worsen per return
 * visit without any new materials.
 *
 * Pure data in / pure data out: deterministic function of the crack list
 * plus the pass seed, no engine dependencies, safe to call from workers
 * or tests.
 */
import { MAX_STAGE, buildCrackGeometry } from './cracks';
import type { CrackInstance } from './cracks';
import { WALL_H } from './constants';
import type { QuadInstance } from '../gfx/cornerao';

/** Gap keeping crack quads a hair proud of the wall face (no z-fighting). */
export const CRACK_DECAL_OFFSET = 0.008;

/**
 * Per-stage length growth factor, identical to buildCrackGeometry's
 * lenScale law: everything about the decal stretches by this each stage.
 */
export const CRACK_GROWTH = 0.18;

/** Base darkness of a fresh (stage 0) crack polyline. */
export const CRACK_DARK_BASE = 0.5;
/** Darkness added per growth stage, capped at 0.95 like the source system. */
export const CRACK_DARK_PER_STAGE = 0.12;

/**
 * How much of a segment's darkness converts into tint multiplication:
 * tint = 1 - dark * CRACK_TINT_STRENGTH (kept well under full black so the
 * decal reads as grime in the plaster, not a hole).
 */
export const CRACK_TINT_STRENGTH = 0.45;

/** Extra brightness toward a segment's tip so strokes feather out. */
export const CRACK_TIP_FADE = 0.08;

/** Vertical clamp band keeping every decal corner on the wall face. */
export const CRACK_MIN_Y = 0.04;
export const CRACK_MAX_Y_MARGIN = 0.04;

/** Darkness of one crack polyline at a given stage (matches cracks.ts). */
export function darknessForStage(stage: number): number {
  const s = Math.max(0, Math.min(Math.floor(stage), MAX_STAGE));
  return Math.min(0.95, CRACK_DARK_BASE + CRACK_DARK_PER_STAGE * s);
}

/**
 * Length growth factor at a given stage — the shared escalation law both
 * cracks.ts geometry and this mesher scale by.
 */
export function growthFactor(stage: number): number {
  const s = Math.max(0, Math.min(Math.floor(stage), MAX_STAGE));
  return 1 + CRACK_GROWTH * s;
}

/** Neutral-to-dark base tint multiplier for a stage (root of each stroke). */
export function tintForStage(stage: number): number {
  return 1 - darknessForStage(stage) * CRACK_TINT_STRENGTH;
}

/** Snap an arbitrary yaw to the nearest wall-aligned quarter turn. */
function snapYaw(rotY: number): number {
  const q = Math.round(rotY / (Math.PI / 2));
  return ((q % 4) + 4) % 4 * (Math.PI / 2);
}

export interface CrackMesherOptions {
  /** Seed forwarded to buildCrackGeometry (same seed, same jagged shape). */
  seed?: number;
  /** Wall-face standoff in metres. Default CRACK_DECAL_OFFSET. */
  offset?: number;
}

/**
 * Converts CrackInstance decals into wall-mounted QuadInstance damage
 * marks. Integrate-ready beside CornerAO/moisture: for each returned quad
 * q, emit quad() from q.positions/q.normal then multiply the four fresh
 * vertices' color channels pairwise by q.tints.
 */
export class CrackMesherPass {
  readonly seed: number;
  readonly offset: number;

  constructor(opts: CrackMesherOptions = {}) {
    this.seed = opts.seed ?? 0;
    this.offset = Math.max(0, opts.offset ?? CRACK_DECAL_OFFSET);
  }

  /**
   * All damage-decal quads for the given cracks. Deterministic: identical
   * inputs produce byte-identical quad lists, in input order.
   */
  generate(cracks: CrackInstance[]): QuadInstance[] {
    const out: QuadInstance[] = [];
    for (const crack of cracks) {
      if (!crack || !Number.isFinite(crack.x)
        || !Number.isFinite(crack.z) || !Number.isFinite(crack.rotY)) continue;
      const rotY = snapYaw(crack.rotY);
      // Wall-face basis: n is the outward normal, t runs along the wall.
      const nx = Math.sin(rotY);
      const nz = Math.cos(rotY);
      const tx = nz;
      const tz = -nx;
      // Anchor lifted proud of the wall surface along its own normal.
      const ox = crack.x + nx * this.offset;
      const oz = crack.z + nz * this.offset;

      const maxY = WALL_H - CRACK_MAX_Y_MARGIN;
      const clampY = (v: number): number =>
        v < CRACK_MIN_Y ? CRACK_MIN_Y : v > maxY ? maxY : v;

      const rootTint = tintForStage(crack.stage);
      const tipTint = Math.min(1, rootTint + CRACK_TIP_FADE);

      for (const seg of buildCrackGeometry(crack, this.seed)) {
        const du = seg.u1 - seg.u0;
        const dv = seg.v1 - seg.v0;
        const len = Math.hypot(du, dv);
        if (!(len > 1e-6)) continue; // degenerate stroke: nothing to draw
        const ux = du / len;
        const uy = dv / len;
        const px = -uy; // in-plane perpendicular
        const py = ux;
        const hw = Math.max(0.002, seg.width);
        const hl = len / 2;
        const mu = (seg.u0 + seg.u1) / 2;
        const mv = (seg.v0 + seg.v1) / 2;

        // Four corners in decal-local (u, v), ordered a,b,c,d around the
        // stroke: a/b trail the root end, c/d lead the tip end.
        const lu = [
          mu + px * hw - ux * hl,
          mu - px * hw - ux * hl,
          mu - px * hw + ux * hl,
          mu + px * hw + ux * hl,
        ];
        const lv = [
          mv + py * hw - uy * hl,
          mv - py * hw - uy * hl,
          mv - py * hw + uy * hl,
          mv + py * hw + uy * hl,
        ];

        const positions: number[] = [];
        const tints: number[] = [];
        for (let i = 0; i < 4; i++) {
          positions.push(
            ox + tx * lu[i],
            clampY(lv[i]),
            oz + tz * lu[i],
          );
          // Feather: root end keeps the stage tint, tip end lifts a touch.
          const tEnd = (i >= 2 ? 1 : -1); // a,b -> root, c,d -> tip
          const shade = tEnd < 0 ? rootTint : tipTint;
          tints.push(shade, shade, shade);
        }

        out.push({ positions, normal: [nx, 0, nz], tints });
      }
    }
    return out;
  }
}


