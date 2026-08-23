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


(Showing lines 124-203 of 436. Use offset=204 to continue.)

