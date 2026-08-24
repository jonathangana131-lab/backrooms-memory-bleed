/**
 * Impossible windows (F19) - lit rooms visible where exterior should be.
 *
 * The world mesher occasionally classifies an outward wall face as
 * "exterior", yet the Backrooms have no outside. This module owns the
 * registry of windows placed on exactly those exterior-facing cells:
 * each window is a seeded lit room seen through the wall - wrong tint,
 * slow lamp phase, never a jumpscare.
 *
 * Division of labour: the caller (mesher pass) decides WHERE walls exist
 * and hands this registry the candidate cells; propose() answers with
 * placements ONLY for candidates flagged exterior-facing, so a window can
 * never land on an interior-facing cell. Culling is pure injected-camera
 * math so the per-frame pass stays allocation-free.
 *
 * Determinism law: every tint and lighting phase derives from core/rng.ts
 * hashes of (seed, window coords, step) - replays agree frame for frame.
 */
import { hash3i, rand2 } from '../core/rng';
import { CELL } from '../world/constants';

/** Outward normal of a wall face in cell space. */
export type WallFace = 'north' | 'east' | 'south' | 'west';

/** Stable index per face so mirrored faces never share a draw. */
const FACE_INDEX: Record<WallFace, number> = { north: 0, east: 1, south: 2, west: 3 };

/** A candidate cell handed over by the mesher pass. */
export interface WindowCandidate {
  /** Cell grid X the wall belongs to. */
  cellX: number;
  /** Cell grid Z the wall belongs to. */
  cellZ: number;
  /** Which face of that cell the mesher would emit. */
  face: WallFace;
  /**
   * True when the mesher classifies this wall face as exterior-facing
   * (nothing built beyond it). Interior-facing candidates are rejected.
   */
  exteriorFacing: boolean;
}

/** One registered impossible window. */
export interface WindowPlacement {
  /** Stable id: chunkKey|cellX|cellZ|face. */
  windowId: string;
  /** Chunk key the window was proposed under. */
  chunkKey: string;
  /** Cell grid X. */
  cellX: number;
  /** Cell grid Z. */
  cellZ: number;
  /** Outward face the lit room is seen through. */
  face: WallFace;
  /** Seeded room tint in 0..1 (indexes the procedural palette). */
  seededRoomTint: number;
  /** Seeded starting phase in 0..LIT_PHASE_COUNT-1 of the room's lamp cycle. */
  litPhase: number;
}

/** Injected camera pose (world XZ + yaw) consumed by culling. */
export interface CameraPose {
  x: number;
  z: number;
  yaw: number;
}

// ---- tuning (fixed gameplay invariants, not deployment config) ----

/** Windows farther than this from the camera are culled (metres). */
export const WINDOW_CULL_RADIUS_M = 48;

/** Half-angle of the camera frustum cone used for culling (radians). */
export const WINDOW_CULL_CONE_RAD = 70 * Math.PI / 180;

/** Distances below this count as on top of the camera; cone test skipped. */
const CONE_MIN_DIST_M = 0.5;

/** Distinct lighting states a window's room cycles through. */
export const LIT_PHASE_COUNT = 8;

/** Salt for per-window tint draws. */
const TINT_SALT = 0x51a7;

/** Salt for per-window lamp-phase draws. */
const PHASE_SALT = 0x1a4d;

/** Salt for the per-step phase advance. */
const PHASE_STEP_SALT = 0x7e3b;

/** Stable id for a candidate position; mirrored faces never collide. */
export function windowIdOf(
  chunkKey: string, cellX: number, cellZ: number, face: WallFace,
): string {
  return `${chunkKey}|${cellX}|${cellZ}|${face}`;
}

/**
 * The lamp state of a window at a discrete step of its cycle. Pure function
 * of (window coords, step, seed): the same windowId always walks the same
 * phase sequence, in any session, in any frame order.
 */
export function litPhaseAt(
  win: Pick<WindowPlacement, 'cellX' | 'cellZ' | 'litPhase'>,
  step: number,
  seed: number,
): number {
  const advance = hash3i(win.cellX * 131 + win.cellZ, step, seed ^ PHASE_STEP_SALT)
    % LIT_PHASE_COUNT;
  return (win.litPhase + advance) % LIT_PHASE_COUNT;
}

/** True when the camera pose admits this placement into the frame. */
export function windowVisible(
  win: Pick<WindowPlacement, 'cellX' | 'cellZ'>,
  cam: CameraPose,
  radiusM: number,
): boolean {
  const wx = (win.cellX + 0.5) * CELL;
  const wz = (win.cellZ + 0.5) * CELL;
  const dx = wx - cam.x, dz = wz - cam.z;
  const dist = Math.hypot(dx, dz);
  // exact radius boundary: inside R visible, outside R+eps culled
  if (dist > radiusM) return false;
  if (dist < CONE_MIN_DIST_M) return true;
  // repo facing convention (see anomalies.ts): forward is (-sin yaw, -cos yaw)
  const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
  const dot = (dx * fx + dz * fz) / dist;
  return dot >= Math.cos(WINDOW_CULL_CONE_RAD);
}

/** Plain-data snapshot produced by serialize() and consumed by deserialize(). */
export interface SerializedWindows {
  version: 1;
  seed: number;
  entries: WindowPlacement[];
}

/**
 * Registry and culling authority for impossible windows. Owns no engine
 * objects; the render pass reads placements each frame and hides culled ones.
 */
export class ImpossibleWindowRegistry {
  private readonly byId = new Map<string, WindowPlacement>();

  constructor(private readonly seed: number) {}

  /**
   * Register candidates for one chunk and return their placements. Only
   * exterior-facing candidates become windows; interior-facing cells are
   * rejected outright, so callers can never place a window where no
   * exterior wall is emitted. Re-proposing the same id updates its entry.
   *
   * @param chunkKey Key of the chunk being proposed for.
   * @param cells Candidate wall faces emitted by the mesher for that chunk.
   * @returns The placements for this call's accepted candidates.
   */
  propose(chunkKey: string, cells: readonly WindowCandidate[]): WindowPlacement[] {
    const out: WindowPlacement[] = [];
    for (const c of cells) {
      if (!c.exteriorFacing) continue;
      const id = windowIdOf(chunkKey, c.cellX, c.cellZ, c.face);
      const win: WindowPlacement = {
        windowId: id,
        chunkKey,
        cellX: c.cellX,
        cellZ: c.cellZ,
        face: c.face,
        seededRoomTint: rand2(
          c.cellX * 61 + FACE_INDEX[c.face], c.cellZ * 17, this.seed ^ TINT_SALT,
        ),
        litPhase: hash3i(c.cellX, c.cellZ * 7 + FACE_INDEX[c.face], this.seed ^ PHASE_SALT)
          % LIT_PHASE_COUNT,
      };
      this.byId.set(id, win);
      out.push(win);
    }
    return out;
  }

  /** The registered window for an exact id, or undefined. */
  get(windowId: string): WindowPlacement | undefined {
    return this.byId.get(windowId);
  }

  /** All registered windows, sorted by id for stable iteration. */
  all(): WindowPlacement[] {
    return [...this.byId.values()].sort((a, b) => (a.windowId < b.windowId ? -1 : 1));
  }

  /** Registered count. */
  get size(): number {
    return this.byId.size;
  }

  /** The lamp phase of a registered window at a discrete step of its cycle. */
  phaseAt(windowId: string, step: number): number {
    const win = this.byId.get(windowId);
    if (!win) return -1;
    return litPhaseAt(win, step, this.seed);
  }

  /** Placements admitted by the injected camera pose at the given radius. */
  visible(cam: CameraPose, radiusM: number = WINDOW_CULL_RADIUS_M): WindowPlacement[] {
    return this.all().filter((w) => windowVisible(w, cam, radiusM));
  }

  /** Snapshot of the full registry; JSON round-trips byte-identically. */
  serialize(): SerializedWindows {
    return { version: 1, seed: this.seed, entries: this.all() };
  }

  /** Rebuild a registry from serialize() output; identical registries answer identically. */
  static deserialize(data: SerializedWindows): ImpossibleWindowRegistry {
    const reg = new ImpossibleWindowRegistry(data.seed);
    for (const e of data.entries) reg.byId.set(e.windowId, { ...e });
    return reg;
  }
}
