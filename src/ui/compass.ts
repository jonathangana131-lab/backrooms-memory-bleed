/**
 * Beacon compass: a screen-edge directional indicator that always points
 * toward the nearest unfound research beacon.
 *
 * Two visual states per frame:
 *  - Off-screen: a chevron clamped to the screen edge (40px margin) rotated
 *    to face the beacon's screen-space direction.
 *  - On-screen: a small pulsing diamond floating above the beacon's world
 *    position, projected to 2D with Babylon's Vector3.Project.
 * A live distance label sits below whichever marker is visible. The whole
 * indicator fades out once you are basically there (< ~15m).
 *
 * Standalone module - owns only its own DOM subtree and styles, like
 * tracker.ts/minimap.ts. Pure DOM/CSS plus Babylon projection math.
 */
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Camera } from '@babylonjs/core/Cameras/camera';

/** Screen-edge clamp margin in CSS pixels. */
export const EDGE_MARGIN = 40;
/** World-space height of the on-screen diamond above the floor. */
export const MARKER_HEIGHT = 2.9;
/** Distance range over which the indicator fades out (near = gone). */
export const FADE_START_M = 18;
export const FADE_END_M = 12;

/** A point in render-target pixel space; z is the depth in [0..1] frustum range. */
export interface ScreenPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Clamp an arbitrary screen point to the rectangle inset by `margin`, moving
 * along the ray from the screen center through the point. Returns CSS-pixel
 * coordinates safe for placing an edge marker.
 */
export function edgeAnchor(
  sx: number,
  sy: number,
  width: number,
  height: number,
  margin: number = EDGE_MARGIN,
): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  const maxX = Math.max(1, width / 2 - margin);
  const maxY = Math.max(1, height / 2 - margin);
  let dx = sx - cx;
  let dy = sy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy - maxY }; // degenerate: top center
  const scale = Math.min(maxX / Math.abs(dx || 1e-9), maxY / Math.abs(dy || 1e-9));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** Opacity for a beacon at distance `d` meters: 1 far away, 0 within FADE_END_M. */
export function fadeForDistance(d: number): number {
  if (!isFinite(d)) return 1;
  const t = (d - FADE_END_M) / (FADE_START_M - FADE_END_M);
  if (t <= 0) return 0;
  return t >= 1 ? 1 : t;
}

/** Human-readable distance label, e.g. "142m" or ">1km" for absurd values. */
export function formatDistance(d: number): string {
  if (!isFinite(d)) return '?m';
  if (d >= 10000) return '>10km';
  return Math.round(d) + 'm';
}

/**
 * Chevron rotation (deg) for a screen-space direction; sprite points UP at 0.
 * Normalized to (-180, 180].
 */
export function chevronAngleDeg(dx: number, dy: number): number {
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg > 180) deg -= 360;
  return deg;
}

const STYLE_ID = 'bmb-compass-styles';
const CSS = [
  '.bmb-compass-root { position: absolute; inset: 0; pointer-events: none;',
    'overflow: hidden; z-index: 30; font-family: \'Courier New\', monospace; }',
  '.bmb-compass-root[hidden] { display: none; }',

  // Edge chevron: a clipped triangle that spins to face the beacon.
  '.bmb-compass-chev { position: absolute; width: 34px; height: 34px;',
    'transform: translate(-50%, -50%); will-change: transform, opacity;',
    'background: rgba(120, 220, 214, 0.14);',
    'clip-path: polygon(50% 4%, 92% 84%, 50% 64%, 8% 84%);',
    'filter: drop-shadow(0 0 6px rgba(110, 225, 215, 0.55)); }',

  // On-screen diamond above the beacon.
  '.bmb-compass-diamond { position: absolute; width: 14px; height: 14px;',
    'transform: translate(-50%, -50%) rotate(45deg);',
    'background: rgba(140, 235, 225, 0.85); border: 1px solid rgba(230, 255, 250, 0.9);',
    'box-shadow: 0 0 10px rgba(110, 225, 215, 0.8); will-change: transform, opacity;',
    'animation: bmbCompassPulse 1.6s ease-in-out infinite; }',
  '@keyframes bmbCompassPulse { 0%, 100% { box-shadow: 0 0 6px rgba(110,225,215,0.55); }',
    '50% { box-shadow: 0 0 16px rgba(110,225,215,0.95); } }',

  // Distance label under the active marker.
  '.bmb-compass-dist { position: absolute; transform: translate(-50%, 0);',
    'color: #cfeee8; font-size: 11px; letter-spacing: 0.14em;',
    'text-shadow: 0 0 4px rgba(0, 0, 0, 0.9), 0 0 8px rgba(110, 225, 215, 0.4);',
    'white-space: nowrap; will-change: transform, opacity; }',
].join('\n');

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const AXIS_Z = new Vector3(0, 0, 1);
const IDENTITY = Matrix.Identity();

/**
 * Screen-edge beacon compass. Construct once with the HUD container;
 * call update() every frame and hide() when no target exists.
 */
export class Compass {
  private root: HTMLDivElement;
  private chev: HTMLDivElement;
  private diamond: HTMLDivElement;
  private dist: HTMLDivElement;
  /** Last stable screen-space direction, used to survive degenerate frames. */
  private lastDx = 0;
  private lastDy = -1;

  constructor(container: HTMLElement) {
    injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'bmb-compass-root';
    this.root.hidden = true;

    this.chev = document.createElement('div');
    this.chev.className = 'bmb-compass-chev';

    this.diamond = document.createElement('div');
    this.diamond.className = 'bmb-compass-diamond';

    this.dist = document.createElement('div');
    this.dist.className = 'bmb-compass-dist';

    this.root.append(this.chev, this.diamond, this.dist);
    container.appendChild(this.root);
  }

  /** Hide every marker (no target, paused, menu, ...). */
  hide(): void {
    this.root.hidden = true;
  }

  /**
   * Per-frame update.
   *
   * @param px    player world X
   * @param pz    player world Z
   * @param pyaw  player yaw (radians, TargetCamera rotation.y convention)
   * @param camera active Babylon camera
   * @param bx    beacon world X
   * @param bz    beacon world Z
   * @param active whether a target beacon exists right now
   */
  update(
    px: number,
    pz: number,
    pyaw: number,
    camera: Camera,
    bx: number,
    bz: number,
    active: boolean,
  ): void {
    if (!active) {
      this.hide();
      return;
    }

    const scene = camera.getScene();
    const engine = scene.getEngine();
    const rw = engine.getRenderWidth();
    const rh = engine.getRenderHeight();
    if (rw < 2 || rh < 2) {
      this.hide();
      return;
    }

    const rect = this.root.getBoundingClientRect();
    const cw = rect.width > 1 ? rect.width : rw;
    const ch = rect.height > 1 ? rect.height : rh;

    // World -> screen via Babylon's projector (marker floats above the pole).
    const world = new Vector3(bx, MARKER_HEIGHT, bz);
    const vp = camera.viewport.toGlobal(rw, rh);
    const p = Vector3.Project(world, IDENTITY, scene.getTransformMatrix(), vp);
    const cssX = (p.x / rw) * cw;
    const cssY = (p.y / rh) * ch;

    // Is the beacon in front of the camera (inside the view frustum half-space)?
    const camPos = camera.globalPosition;
    const toBeacon = new Vector3(bx - camPos.x, world.y - camPos.y, bz - camPos.z);
    const forward = Vector3.TransformNormal(AXIS_Z, camera.getWorldMatrix());
    const facing = Vector3.Dot(toBeacon, forward) > 0;

    const onScreen =
      facing && p.z >= 0 && p.z <= 1 &&
      cssX >= 0 && cssX <= cw && cssY >= 0 && cssY <= ch;

    const distance = Math.hypot(bx - px, bz - pz);
    const alpha = fadeForDistance(distance);
    this.root.hidden = alpha <= 0;
    if (this.root.hidden) return;

    this.root.style.opacity = String(alpha);
    this.dist.textContent = formatDistance(distance);

    if (onScreen) {
      // Diamond hovering above the beacon's projected position.
      this.diamond.style.display = 'block';
      this.chev.style.display = 'none';
      this.diamond.style.left = cssX.toFixed(1) + 'px';
      this.diamond.style.top = cssY.toFixed(1) + 'px';
      this.dist.style.left = cssX.toFixed(1) + 'px';
      this.dist.style.top = (cssY + 16).toFixed(1) + 'px';
      this.lastDx = cssX - cw / 2;
      this.lastDy = cssY - ch / 2;
      return;
    }

    // Off-screen: chevron pinned to the screen edge along the beacon's
    // screen-space direction. Behind the camera the projection mirrors
    // through the screen center, so flip it back.
    this.diamond.style.display = 'none';
    this.chev.style.display = 'block';
    let dx = cssX - cw / 2;
    let dy = cssY - ch / 2;
    if (!facing) {
      dx = -dx;
      dy = -dy;
    }
    // Degenerate frame (dead ahead / dead behind): fall back to the planar
    // bearing implied by player yaw, then to last frame's direction.
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      const s = Math.sin(pyaw);
      const c = Math.cos(pyaw);
      dx = (bx - px) * c - (bz - pz) * s;
      dy = -((bx - px) * s + (bz - pz) * c);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        dx = this.lastDx;
        dy = this.lastDy;
      }
    }
    if (dx !== 0 || dy !== 0) {
      this.lastDx = dx;
      this.lastDy = dy;
    }
    const anchor = edgeAnchor(cw / 2 + dx, ch / 2 + dy, cw, ch);
    this.chev.style.left = anchor.x.toFixed(1) + 'px';
    this.chev.style.top = anchor.y.toFixed(1) + 'px';
    this.chev.style.transform =
      'translate(-50%, -50%) rotate(' + chevronAngleDeg(dx, dy).toFixed(1) + 'deg)';
    // Label rides just inside the marker so it never leaves the screen.
    const inward = edgeAnchor(cw / 2 + dx, ch / 2 + dy, cw, ch, EDGE_MARGIN + 26);
    this.dist.style.left = inward.x.toFixed(1) + 'px';
    this.dist.style.top = inward.y.toFixed(1) + 'px';
  }
}


