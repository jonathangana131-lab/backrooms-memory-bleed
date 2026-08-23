/**
 * Photo mode: free-fly camera overlay for sightseeing and screenshots.
 *
 * Enter snapshots the live camera position/rotation plus any CSS filter on
 * the render canvas; exit restores all three exactly. While active the
 * player body is ignored - WASD/arrows fly relative to camera yaw, Q/E or
 * R/F step down/up, Shift doubles speed, F cycles color-grade filters and
 * C captures a PNG data URL of the canvas. Escape exits.
 *
 * Pure DOM/input coordination: camera state crosses only through the
 * injected deps object, so the mode is unit-testable without Babylon.
 */

/** Lifecycle states of the photo-mode state machine. */
export type PhotoModeState = 'inactive' | 'active';

/** Names of the built-in color-grade presets (canvas CSS filters). */
export type PhotoFilterName = 'none' | 'noir' | 'sepia' | 'bleach' | 'vhs';

/** Camera state captured on enter and restored on exit. */
export interface PhotoModeSnapshot {
  /** Camera position at enter time. */
  pos: { x: number; y: number; z: number };
  /** Camera rotation (yaw/pitch/roll radians) at enter time. */
  rot: { x: number; y: number; z: number };
  /** Canvas inline filter at enter time ('' when none). */
  filter: string;
}

/** Host services PhotoMode needs; everything crosses these hooks. */
export interface PhotoModeDeps {
  /** The render canvas (filter target and capture source). */
  canvas: HTMLCanvasElement;
  /** Current camera position. */
  getCameraPos(): { x: number; y: number; z: number };
  /** Overwrite the camera position. */
  setCameraPos(p: { x: number; y: number; z: number }): void;
  /** Current camera rotation. */
  getCameraRot(): { x: number; y: number; z: number };
  /** Overwrite the camera rotation. */
  setCameraRot(r: { x: number; y: number; z: number }): void;
  /** Base fly speed in metres per second (default 6). */
  moveSpeed?: number;
}

/** Filter presets in cycling order, with their canvas CSS filter strings. */
export const PHOTO_FILTERS: ReadonlyArray<{ name: PhotoFilterName; css: string }> = [
  { name: 'none', css: '' },
  { name: 'noir', css: 'grayscale(1) contrast(1.25) brightness(0.95)' },
  { name: 'sepia', css: 'sepia(0.75) contrast(1.1)' },
  { name: 'bleach', css: 'saturate(0.35) brightness(1.15) contrast(1.05)' },
  { name: 'vhs', css: 'saturate(1.4) hue-rotate(-8deg) contrast(0.95)' },
];

/** Keys the fly controls consume while active (preventDefault targets). */
const FLY_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE', 'KeyR', 'KeyF',
]);

export class PhotoMode {
  private readonly deps: PhotoModeDeps;
  private _state: PhotoModeState = 'inactive';
  private _filter: PhotoFilterName = 'none';
  private snapshot: PhotoModeSnapshot | null = null;
  private frameEl: HTMLElement | null = null;
  private readonly pressed = new Set<string>();
  private onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private onKeyUp: ((e: KeyboardEvent) => void) | null = null;

  constructor(deps: PhotoModeDeps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('PhotoMode requires a deps object');
    }
    for (const key of [
      'canvas',
      'getCameraPos',
      'setCameraPos',
      'getCameraRot',
      'setCameraRot',
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((deps as any)[key] == null) {
        throw new Error('PhotoMode deps missing: ' + String(key));
      }
    }
    this.deps = deps;
  }

  /* ------------------------------------------------------------ */
  /* State machine                                                  */
  /* ------------------------------------------------------------ */

  /** Current lifecycle state. */
  get state(): PhotoModeState {
    return this._state;
  }

  /** True while the free-fly camera is live. */
  get isActive(): boolean {
    return this._state === 'active';
  }

  /** Currently applied filter preset name. */
  get filter(): PhotoFilterName {
    return this._filter;
  }

  /**
   * Enter photo mode: snapshot the current camera state, remember the
   * canvas filter, install input listeners, and go active.
   */
  enter(): void {
    if (this._state === 'active') return;
    this.snapshot = {
      pos: { ...this.deps.getCameraPos() },
      rot: { ...this.deps.getCameraRot() },
      filter: this.deps.canvas.style.filter || '',
    };
    this.attachInput();
    this.pressed.clear();
    this._state = 'active';
  }

  /**
   * Exit photo mode: restore the snapshotted camera state and canvas
   * filter, remove listeners. Safe to call when already inactive.
   */
  exit(): void {
    this.detachInput();
    this.pressed.clear();
    if (this.snapshot && this._state === 'active') {
      this.deps.setCameraPos({ ...this.snapshot.pos });
      this.deps.setCameraRot({ ...this.snapshot.rot });
      this.deps.canvas.style.filter = this.snapshot.filter;
    }
    this.snapshot = null;
    this._state = 'inactive';
  }



  /** True while the mode occupies input/camera (alias of isActive). */
  get isOpen(): boolean {
    return this._state === 'active';
  }

  /** Current fly speed in metres per second before Shift boost. */
  private get speed(): number {
    return this.deps.moveSpeed ?? 6;
  }

  /**
   * Cycle to the next color-grade preset (wraps to 'none') and apply it
   * live while active.
   */
  cycleFilter(): PhotoFilterName {
    const idx = PHOTO_FILTERS.findIndex((f) => f.name === this._filter);
    const next = PHOTO_FILTERS[(idx + 1) % PHOTO_FILTERS.length];
    this.setFilter(next.name);
    return next.name;
  }

  /** Apply a named preset by name (unknown names fall back to 'none'). */
  setFilter(name: PhotoFilterName): void {
    const preset = PHOTO_FILTERS.find((f) => f.name === name) ?? PHOTO_FILTERS[0];
    this._filter = preset.name;
    if (this._state === 'active') {
      this.deps.canvas.style.filter = preset.css;
    }
  }

  /**
   * Capture the canvas as a PNG data URL. Only meaningful while active;
   * flashes the frame element for viewfinder feedback.
   */
  capture(): string | null {
    if (this._state !== 'active') return null;
    let url: string | null = null;
    try {
      url = this.deps.canvas.toDataURL('image/png');
    } catch {
      // Tainted canvas (foreign origin textures): capture is unavailable,
      // but photo mode itself keeps working.
      url = null;
    }
    this.flashFrame();
    return url;
  }

  /** Per-frame fly movement from the currently held keys. */
  update(dt: number): void {
    if (this._state !== 'active' || dt <= 0) return;
    const mult = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight') ? 2 : 1;
    const step = this.speed * mult * Math.min(dt, 0.1);
    if (!this.pressed.size) return;

    const pos = this.deps.getCameraPos();
    const rot = this.deps.getCameraRot();
    let dx = 0;
    let dy = 0;
    let dz = 0;
    // Yaw-relative planar basis: forward is -Z rotated by rotation.y.
    const sin = Math.sin(rot.y);
    const cos = Math.cos(rot.y);
    const fwdX = -sin;
    const fwdZ = -cos;
    const rightX = cos;
    const rightZ = -sin;
    if (this.pressed.has('KeyW') || this.pressed.has('ArrowUp')) { dx += fwdX; dz += fwdZ; }
    if (this.pressed.has('KeyS') || this.pressed.has('ArrowDown')) { dx -= fwdX; dz -= fwdZ; }
    if (this.pressed.has('KeyD') || this.pressed.has('ArrowRight')) { dx += rightX; dz += rightZ; }
    if (this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')) { dx -= rightX; dz -= rightZ; }
    if (this.pressed.has('KeyE') || this.pressed.has('KeyR')) dy += 1;
    if (this.pressed.has('KeyQ') || this.pressed.has('KeyF')) dy -= 1;

    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return;
    this.deps.setCameraPos({
      x: pos.x + (dx / len) * step * mult,
      y: Math.max(0.3, pos.y + (dy / len) * step * mult),
      z: pos.z + (dz / len) * step * mult,
    });
  }

  /** Install window key listeners and show the viewfinder frame. */
  private attachInput(): void {
    this.onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        this.exit();
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        this.cycleFilter();
        return;
      }
      if (e.code === 'KeyC') {
        e.preventDefault();
        this.capture();
        return;
      }
      if (FLY_KEYS.has(e.code)) {
        e.preventDefault();
        this.pressed.add(e.code);
      }
    };
    this.onKeyUp = (e: KeyboardEvent): void => {
      this.pressed.delete(e.code);
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.ensureFrame().style.display = 'block';
  }

  /** Remove key listeners and hide the viewfinder frame. */
  private detachInput(): void {
    if (this.onKeyDown) window.removeEventListener('keydown', this.onKeyDown);
    if (this.onKeyUp) window.removeEventListener('keyup', this.onKeyUp);
    this.onKeyDown = null;
    this.onKeyUp = null;
    if (this.frameEl) this.frameEl.style.display = 'none';
  }

  /** Lazily build the viewfinder frame overlay inside the canvas parent. */
  private ensureFrame(): HTMLElement {
    if (!this.frameEl) {
      const el = this.deps.canvas.ownerDocument.createElement('div');
      el.className = 'photo-frame';
      el.textContent = 'PHOTO MODE — WASD fly · Q/E down/up · F filter · C capture · Esc exit';
      el.style.cssText =
        'position:absolute;inset:8px;border:2px solid rgba(255,255,255,0.35);' +
        'pointer-events:none;display:none;color:rgba(255,255,255,0.7);' +
        'font:12px monospace;padding:6px;box-sizing:border-box;';
      this.deps.canvas.parentElement?.appendChild(el);
      this.frameEl = el;
    }
    return this.frameEl;
  }

  /** Brief white flash on the frame element after a capture. */
  private flashFrame(): void {
    const el = this.ensureFrame();
    el.style.backgroundColor = 'rgba(255,255,255,0.25)';
    window.setTimeout(() => {
      el.style.backgroundColor = 'transparent';
    }, 90);
  }

  /** Full teardown: exit and drop the frame element. */
  dispose(): void {
    this.exit();
    this.frameEl?.remove();
    this.frameEl = null;
  }
}
