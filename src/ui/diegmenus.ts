/**
 * Diegetic menus for BACKROOMS: MEMORY BLEED (F93).
 *
 * Title/pause menus projected onto in-world walls instead of DOM overlays.
 * The model is injected a wall plane {origin, normal, up} and menu content
 * {title, items[{id, label}]}, and projects every item to a world-space
 * quad laid out on the wall:
 *
 *   - The wall frame orthonormalizes (right, up, normal) so text runs left
 *     to right along `right` when read from the side of the plane the
 *     normal points toward; faceTowards() flips the mount so the menu is
 *     always readable from an injected viewer position.
 *   - Layout: title band across the top, one row per item below; each label
 *     keeps its character-derived aspect ratio exactly (within float noise)
 *     so projected type never stretches.
 *   - A selection highlight quad tracks the virtual cursor index and moves
 *     with it; input('up'/'down') moves the cursor and wraps exactly at the
 *     ends (last -> first on down, first -> last on up).
 *   - raycastPlane() supports mounting: cast a ray at the wall to place the
 *     menu anchor at the hit point.
 *
 * Pure math: no DOM, no Babylon, no Date.now(), no Math.random() — identical
 * injections replay byte-identical projections (see test/diegmenus-test.mjs).
 * Junk planes (non-finite entries, zero-length normal/up, collinear
 * normal/up) are rejected loudly: planeFrame throws 'degenerate wall plane'.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** World-space 3-vector. */
export type Vec3 = [number, number, number];

/** Injected wall plane: anchor point plus orientation. */
export interface WallPlane {
  /** Menu anchor (layout center) in world space. */
  origin: Vec3;
  /** Facing direction of the readable side (normalized internally). */
  normal: Vec3;
  /** Screen-up hint on the wall (normalized, orthogonalized internally). */
  up: Vec3;
}

/** One selectable entry. */
export interface MenuItem {
  /** Stable identifier surfaced by selectedId. */
  id: string;
  /** Display label; length drives the projected aspect ratio. */
  label: string;
}

/** Injected menu content. */
export interface MenuContent {
  /** Menu identifier (unused in layout, carried through). */
  id: string;
  /** Title rendered in the top band. */
  title: string;
  /** Entries in display order; must be non-empty with unique ids. */
  items: MenuItem[];
}

/** Corner order: topLeft, topRight, bottomRight, bottomLeft. */
export type Quad = [Vec3, Vec3, Vec3, Vec3];

/** One projected item row. */
export interface ProjectedItem {
  itemId: string;
  /** Label quad on the wall. */
  quad: Quad;
  /** Width/height ratio actually used for the quad (aspect preserved). */
  aspect: number;
}

/** Full projection consumed by a mesh builder. */
export interface MenuProjection {
  titleQuad: Quad;
  /** Item quads in content order, all coplanar on the wall. */
  items: ProjectedItem[];
  /** Highlight quad around the cursor row, or null if none fits. */
  highlightQuad: Quad | null;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Wall-space width of the whole menu, meters. */
export const MENU_WIDTH_M = 2.4;
/** Wall-space height of the whole menu, meters. */
export const MENU_HEIGHT_M = 1.5;
/** Fraction of MENU_HEIGHT_M given to the title band. */
export const TITLE_BAND_FRAC = 0.28;
/** Label height as a fraction of its row height. */
export const LABEL_HEIGHT_FRAC = 0.55;
/** Title height as a fraction of the title band. */
export const TITLE_HEIGHT_FRAC = 0.5;
/** Horizontal margin between the highlight band and the menu edge. */
export const HIGHLIGHT_MARGIN_FRAC = 0.06;
/** Vertical shrink of the highlight band inside its row. */
export const HIGHLIGHT_SHRINK_FRAC = 0.08;
/** Projected width per character relative to glyph height. */
export const CHAR_ASPECT = 0.6;
/** Aspect floor so tiny/empty labels stay clickable-sized. */
export const MIN_LABEL_ASPECT = 1.2;
/** Aspect ceiling so pathological labels cannot leave the menu width. */
export const MAX_LABEL_ASPECT = 16;

// ---------------------------------------------------------------------------
// Vector helpers (kept local; no Babylon import by design)
// ---------------------------------------------------------------------------

/** Componentwise sum. */
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
/** Scalar multiple. */
function mul(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
/** Dot product. */
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** Cross product. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
/** Euclidean length. */
function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Reject non-finite vectors.
 *
 * @param v Vector to check.
 * @param name Field name used in the error message.
 * @throws When any component is missing or non-finite.
 */
function assertFiniteVec(v: Vec3, name: string): void {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(`degenerate wall plane: ${name} is not a finite vec3`);
  }
}

// ---------------------------------------------------------------------------
// Plane frame + mounting
// ---------------------------------------------------------------------------

/** Orthonormalized wall frame. */
export interface PlaneFrame {
  origin: Vec3;
  /** Unit right direction (viewer's right on the readable side). */
  right: Vec3;
  /** Unit up direction, orthogonalized against the normal. */
  up: Vec3;
  /** Unit facing normal. */
  normal: Vec3;
}

/**
 * Build the orthonormal reading frame of a wall plane.
 *
 * Junk planes are rejected loudly and documented here: non-finite/missing
 * components, zero-length normal or up, and collinear normal/up (the cross
 * product that defines `right` would vanish, making left/right undefined)
 * all throw.
 *
 * @param plane Injected wall plane.
 * @returns Orthonormal frame with right = normalize(up x normal),
 *   up re-orthogonalized as normalize(normal x right).
 * @throws Error prefixed 'degenerate wall plane' for every junk case above.
 */
export function planeFrame(plane: WallPlane): PlaneFrame {
  if (!plane || typeof plane !== 'object') {
    throw new Error('degenerate wall plane: not an object');
  }
  assertFiniteVec(plane.origin, 'origin');
  assertFiniteVec(plane.normal, 'normal');
  assertFiniteVec(plane.up, 'up');
  const nLen = len(plane.normal);
  if (!(nLen > 1e-9)) throw new Error('degenerate wall plane: zero-length normal');
  const n: Vec3 = mul(plane.normal, 1 / nLen);
  const uLen = len(plane.up);
  if (!(uLen > 1e-9)) throw new Error('degenerate wall plane: zero-length up');
  const r = cross(plane.up, n);
  const rLen = len(r);
  if (!(rLen > 1e-6)) throw new Error('degenerate wall plane: collinear normal and up');
  const right: Vec3 = mul(r, 1 / rLen);
  let u = cross(n, right);
  const u2 = len(u);
  u = mul(u, 1 / u2);
  return { origin: [...plane.origin] as Vec3, right, up: u, normal: n };
}

/**
 * Flip a plane's readable side toward a viewer when needed.
 *
 * @param plane Injected wall plane.
 * @param viewerPos Position of the reading camera/entity.
 * @returns A plane equivalent to the input but with the normal pointing at
 *   the viewer's side, so projected text reads correctly from there.
 */
export function faceTowards(plane: WallPlane, viewerPos: Vec3): WallPlane {
  const f = planeFrame(plane);
  const toViewer: Vec3 = [
    viewerPos[0] - plane.origin[0],
    viewerPos[1] - plane.origin[1],
    viewerPos[2] - plane.origin[2],
  ];
  if (dot(toViewer, f.normal) < 0) {
    return { origin: [...plane.origin] as Vec3, normal: mul(f.normal, -1), up: [...plane.up] as Vec3 };
  }
  return { origin: [...plane.origin] as Vec3, normal: [...plane.normal] as Vec3, up: [...plane.up] as Vec3 };
}

/**
 * Raycast against the infinite wall plane (for mounting the menu anchor).
 *
 * @param ro Ray origin.
 * @param rd Ray direction (any length; need not be normalized).
 * @param plane Injected wall plane.
 * @returns Hit point, or null when the ray misses (parallel, junk, or
 *   behind the ray).
 */
export function raycastPlane(ro: Vec3, rd: Vec3, plane: WallPlane): Vec3 | null {
  try {
    assertFiniteVec(ro, 'ray origin');
    assertFiniteVec(rd, 'ray direction');
    assertFiniteVec(plane.origin, 'origin');
    assertFiniteVec(plane.normal, 'normal');
  } catch {
    return null;
  }
  const nLen = len(plane.normal);
  if (!(nLen > 1e-9)) return null;
  const n = mul(plane.normal, 1 / nLen);
  const denom = dot(rd, n);
  // Parallel rays never land; epsilon absorbs float noise at grazing angles.
  if (Math.abs(denom) < 1e-9) return null;
  const w: Vec3 = [
    plane.origin[0] - ro[0],
    plane.origin[1] - ro[1],
    plane.origin[2] - ro[2],
  ];
  const t = dot(w, n) / denom;
  if (!(t >= 1e-6)) return null;
  return add(ro, mul(rd, t));
}

// ---------------------------------------------------------------------------
// Aspect + layout helpers
// ---------------------------------------------------------------------------

/**
 * Reading aspect of a label: characters times CHAR_ASPECT, clamped to
 * [MIN_LABEL_ASPECT, MAX_LABEL_ASPECT]. Empty labels take the floor so the
 * quad stays grabbable.
 *
 * @param label Label text.
 * @returns Preserved width/height ratio for the projected quad.
 */
export function labelAspectRatio(label: string): number {
  const l = typeof label === 'string' ? label.length : 0;
  return Math.min(MAX_LABEL_ASPECT, Math.max(MIN_LABEL_ASPECT, l * CHAR_ASPECT));
}

/**
 * Wall-local (u, v) -> world point on the frame.
 *
 * @param f Orthonormal plane frame.
 * @param u Horizontal offset from the anchor, meters.
 * @param v Vertical offset from the anchor, meters.
 * @returns World-space corner position.
 */
function at(f: PlaneFrame, u: number, v: number): Vec3 {
  return add(add(f.origin, mul(f.right, u)), mul(f.up, v));
}

/** Quad from wall-local bounds, corners TL/TR/BR/BL. */
function quadUV(f: PlaneFrame, u0: number, u1: number, v0: number, v1: number): Quad {
  return [at(f, u0, v1), at(f, u1, v1), at(f, u1, v0), at(f, u0, v0)];
}

// ---------------------------------------------------------------------------
// DiegeticMenu
// ---------------------------------------------------------------------------

/**
 * Virtual-cursor diegetic menu mounted on one wall plane. State is only the
 * cursor index; projection is recomputed from injected content + plane on
 * demand and is fully deterministic.
 */
export class DiegeticMenu {
  private readonly content: MenuContent;
  private readonly plane: WallPlane;
  private readonly ids: Set<string>;
  private cursorIndex = 0;

  /**
   * @param content Menu content; empty item lists, duplicate ids and
   *   non-string labels fail loud (a menu without rows has no cursor).
   * @param plane Mounting wall plane; junk planes fail loud via planeFrame.
   */
  constructor(content: MenuContent, plane: WallPlane) {
    if (!content || !Array.isArray(content.items) || content.items.length === 0) {
      throw new Error(`menu ${String(content?.id ?? '?')} needs at least one item`);
    }
    this.ids = new Set();
    for (const it of content.items) {
      if (!it || typeof it.id !== 'string' || it.id === '') {
        throw new Error(`menu ${content.id}: every item needs a non-empty id`);
      }
      if (typeof it.label !== 'string') {
        throw new Error(`menu ${content.id} item ${it.id}: label must be a string`);
      }
      if (this.ids.has(it.id)) throw new Error(`menu ${content.id}: duplicate item id ${it.id}`);
      this.ids.add(it.id);
    }
    planeFrame(plane); // reject junk planes at construction time
    this.content = content;
    this.plane = plane;
  }

  /** Index of the virtual cursor into content.items. */
  get cursor(): number {
    return this.cursorIndex;
  }

  /** Id of the selected item. */
  get selectedId(): string {
    return this.content.items[this.cursorIndex].id;
  }

  /**
   * Move the cursor by a signed row count with exact end wrapping.
   *
   * @param delta Signed row count (any magnitude; wraps modulo item count).
   * @returns The new cursor index.
   */
  move(delta: number): number {
    const n = this.content.items.length;
    if (!Number.isFinite(delta)) return this.cursorIndex;
    const step = Math.trunc(delta);
    this.cursorIndex = ((this.cursorIndex + step) % n + n) % n;
    return this.cursorIndex;
  }

  /**
   * Feed one navigation input event.
   *
   * @param action 'up' selects the previous row, 'down' the next; both wrap
   *   exactly at the ends. Unknown actions are ignored.
   * @returns True when the cursor moved.
   */
  input(action: string): boolean {
    if (action === 'up') { this.move(-1); return true; }
    if (action === 'down') { this.move(1); return true; }
    return false;
  }

  /**
   * Project the current menu state onto the wall.
   *
   * @returns Title/item/highlight quads, all coplanar on the injected wall
   *   plane, laid out from the orthonormal reading frame.
   */
  project(): MenuProjection {
    const f = planeFrame(this.plane);
    const halfW = MENU_WIDTH_M / 2;
    const halfH = MENU_HEIGHT_M / 2;

    // Title band: top strip of the menu, centered horizontally.
    const bandTop = halfH;
    const bandBottom = halfH - TITLE_BAND_FRAC * MENU_HEIGHT_M;
    const titleH0 = (bandTop - bandBottom) * TITLE_HEIGHT_FRAC;
    const titleAspect = labelAspectRatio(this.content.title);
    // Preserve the title's aspect exactly: over-long titles shrink glyph
    // height instead of stretching width past the menu edge.
    const titleH = Math.min(titleH0, (MENU_WIDTH_M * 0.9) / titleAspect);
    const titleW = titleAspect * titleH;
    const titleQuad = quadUV(f, -titleW / 2, titleW / 2, bandBottom + ((bandTop - bandBottom) - titleH) / 2, bandBottom + ((bandTop - bandBottom) + titleH) / 2);

    // Rows fill everything below the band, evenly split per item.
    const rowsTop = bandBottom;
    const rowsH = rowsTop + halfH;
    const rowH = rowsH / this.content.items.length;
    const items: ProjectedItem[] = this.content.items.map((it, i) => {
      const rowCenterV = rowsTop - rowH * (i + 0.5);
      const aspect = labelAspectRatio(it.label);
      // Preserve the label's aspect exactly: over-long labels shrink glyph
      // height instead of stretching width past the row budget.
      const maxW = MENU_WIDTH_M * 0.86;
      const h0 = rowH * LABEL_HEIGHT_FRAC;
      const h = Math.min(h0, maxW / aspect);
      const w = aspect * h;
      return { itemId: it.id, quad: quadUV(f, -w / 2, w / 2, rowCenterV - h / 2, rowCenterV + h / 2), aspect };
    });

    // Highlight band tracks the virtual cursor row.
    const i = this.cursorIndex;
    const rowCenterV = rowsTop - rowH * (i + 0.5);
    const hlH = rowH * (1 - 2 * HIGHLIGHT_SHRINK_FRAC);
    const hlW = MENU_WIDTH_M * (1 - 2 * HIGHLIGHT_MARGIN_FRAC);
    const highlightQuad = quadUV(f, -hlW / 2, hlW / 2, rowCenterV - hlH / 2, rowCenterV + hlH / 2);

    return { titleQuad, items, highlightQuad };
  }
}
