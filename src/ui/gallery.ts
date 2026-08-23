/**
 * Screenshot gallery for BACKROOMS: MEMORY BLEED.
 *
 * Captured photos are persisted in IndexedDB (store 'photos'): each entry
 * holds the full-resolution PNG blob, a 160x90 JPEG thumbnail, the district
 * name, and a timestamp. At most MAX_PHOTOS are kept - adding past the cap
 * evicts the oldest photos.
 *
 * Pressing G toggles a fullscreen grid overlay of thumbnails. Clicking a
 * thumbnail enlarges it and selects it; D deletes and E exports (downloads)
 * the selection. ESC backs out of the enlarged view, then closes the overlay.
 *
 * Standalone module - owns only its own DOM subtree and styles, like
 * compass.ts/tracker.ts. Pure DOM + IndexedDB.
 */

/** Maximum number of stored photos; the oldest are evicted beyond this. */
export const MAX_PHOTOS = 24;
/** Thumbnail dimensions (16:9) rendered into the grid. */
export const THUMB_W = 160;
export const THUMB_H = 90;
/** JPEG quality used for thumbnails. */
export const THUMB_QUALITY = 0.72;

/** Persisted photo payload (stored under an out-of-line numeric key). */
export interface PhotoRecord {
  /** Full-resolution screenshot blob (PNG). */
  blob: Blob;
  /** Small JPEG preview for fast grid rendering. */
  thumb: Blob;
  /** Capture time (Date.now() epoch ms). */
  timestamp: number;
  /** District the shot was taken in. */
  district: string;
}

/** A photo as read back from the store, with its database key attached. */
export interface StoredPhoto extends PhotoRecord {
  id: IDBValidKey;
}

const DB_NAME = 'bmb-gallery';
const DB_VERSION = 1;
const STORE = 'photos';

function warn(msg: string): void {
  console.warn('[gallery] ' + msg);
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Monotonic-ish unique numeric key: ms timestamp + rotating sequence. */
let keySeq = 0;
export function makePhotoId(now: number = Date.now()): number {
  keySeq = (keySeq + 1) % 1000;
  return now * 1000 + keySeq;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      rej(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

async function getAllPairs(db: IDBDatabase): Promise<{ keys: IDBValidKey[]; vals: unknown[] }> {
  const tx = db.transaction(STORE, 'readonly');
  const os = tx.objectStore(STORE);
  const valsP = reqToPromise(os.getAll());
  const keysP = reqToPromise(os.getAllKeys());
  const [vals, keys] = await Promise.all([valsP, keysP]);
  return { keys, vals };
}

/** Insert a record under an explicit key. */
async function putPhoto(db: IDBDatabase, id: number, rec: PhotoRecord): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(rec, id);
  await txDone(tx);
}

/** Remove one photo by key. */
async function deletePhotoById(db: IDBDatabase, id: IDBValidKey): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

/** Drop the oldest records until at most MAX_PHOTOS remain. */
async function evictOldest(db: IDBDatabase): Promise<void> {
  const { keys, vals } = await getAllPairs(db);
  if (keys.length <= MAX_PHOTOS) return;
  const order = keys
    .map((k, i) => ({
      k,
      ts: (vals[i] as Partial<PhotoRecord> | null)?.timestamp ?? 0,
      id: typeof k === 'number' ? k : 0,
    }))
    // id asc breaks ties between same-ms captures (ids encode creation order).
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
  const victims = order.slice(0, keys.length - MAX_PHOTOS).map((o) => o.k);
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  for (const v of victims) os.delete(v);
  await txDone(tx);
}

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

/** Cover-fit draw of the bitmap into a w x h canvas (center crop). */
function drawCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  w: number,
  h: number,
): void {
  const s = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Decode the full PNG and re-encode a 160x90 center-crop JPEG preview.
 * Prefers OffscreenCanvas; falls back to a regular DOM canvas. Throws when
 * neither decoding nor encoding is available.
 */
async function makeThumb(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  let out: Blob | null = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(THUMB_W, THUMB_H);
      const ctx = c.getContext('2d');
      if (ctx) {
        drawCover(ctx, bmp, THUMB_W, THUMB_H);
        out = await c.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
      }
    }
    if (!out && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = THUMB_W;
      c.height = THUMB_H;
      const ctx = c.getContext('2d');
      if (ctx) {
        drawCover(ctx, bmp, THUMB_W, THUMB_H);
        out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', THUMB_QUALITY));
      }
    }
  } finally {
    bmp.close?.();
  }
  if (!out) throw new Error('thumbnail encoding unavailable');
  return out;
}

/* ------------------------------------------------------------------ */
/* Overlay UI                                                          */
/* ------------------------------------------------------------------ */

const OVERLAY_STYLE =
  'position:fixed;inset:0;z-index:900;display:flex;flex-direction:column;' +
  'background:rgba(4,5,7,0.94);color:#cfd6cf;font-family:monospace;padding:18px;';
const GRID_STYLE =
  'flex:1;display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start;' +
  'overflow-y:auto;padding:4px;';
const CELL_STYLE =
  'width:172px;background:#101312;border:1px solid #2a322c;cursor:pointer;' +
  'padding:5px;text-align:left;color:#9fb09f;font-family:monospace;font-size:11px;';
const CELL_SELECTED_STYLE =
  'width:172px;background:#18231c;border:1px solid #58e08a;cursor:pointer;' +
  'padding:5px;text-align:left;color:#cfe8d4;font-family:monospace;font-size:11px;';
const IMG_STYLE = 'display:block;width:160px;height:90px;object-fit:cover;';
const VIEWER_STYLE =
  'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
  'background:rgba(2,3,4,0.96);flex-direction:column;gap:10px;';
const VIEWER_HIDDEN_STYLE =
  'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(2,3,4,0.96);flex-direction:column;gap:10px;';
const FULL_IMG_STYLE = 'max-width:92vw;max-height:82vh;border:1px solid #2a322c;';
const HINT_STYLE = 'font-family:monospace;font-size:12px;color:#8fa38f;letter-spacing:1px;';

function isTextEntryTarget(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string } | null;
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/* ------------------------------------------------------------------ */
/* PhotoGallery                                                        */
/* ------------------------------------------------------------------ */

export class PhotoGallery {
  private readonly container: HTMLElement;
  private root: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private viewer: HTMLElement | null = null;
  private viewerImg: HTMLImageElement | null = null;
  private viewerLabel: HTMLElement | null = null;
  /** Newest-first snapshot cache used for rendering. */
  private photos: StoredPhoto[] = [];
  private selectedId: IDBValidKey | null = null;
  private _viewerOpen = false;
  private objectUrls: string[] = [];
  private viewerUrl: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKey);
    }
  }

  /** Whether the fullscreen grid overlay is currently visible. */
  get isOpen(): boolean {
    return this.root !== null && this.root.style.display !== 'none';
  }

  /** Whether a single enlarged photo is being viewed inside the overlay. */
  get viewing(): boolean {
    return this._viewerOpen;
  }

  /** Release listeners, DOM, and blob URLs. */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKey);
    }
    this.revokeAll();
    this.root?.remove();
    this.root = null;
    this.grid = null;
    this.viewer = null;
  }

(Showing lines 225-264 of 556. Use offset=265 to continue.)


  /* ------------------------- public actions ----------------------- */

  /** Show the overlay if hidden, hide it if shown. */
  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.ensureOverlay();
    this.selectedId = null;
    this.closeViewer();
    this.root!.style.display = 'flex';
    void this.refresh();
  }

  close(): void {
    this.closeViewer();
    if (this.root) this.root.style.display = 'none';
  }

  /**
   * Persist a new screenshot: generates the 160x90 JPEG thumbnail, stores
   * the pair in IndexedDB, evicts the oldest photos past MAX_PHOTOS, and
   * refreshes the grid if the overlay is open.
   */
  async addPhoto(blob: Blob, district: string): Promise<void> {
    let thumb: Blob;
    try {
      thumb = await makeThumb(blob);
    } catch (e) {
      warn('thumbnail generation failed, storing full frame as thumb: ' +
        (e instanceof Error ? e.message : String(e)));
      thumb = blob;
    }
    const rec: PhotoRecord = { blob, thumb, timestamp: Date.now(), district };
    const db = await openDB();
    try {
      await putPhoto(db, makePhotoId(), rec);
      await evictOldest(db);
    } finally {
      db.close();
    }
    if (this.isOpen) await this.refresh();
  }

  /** All stored photos, newest first. */
  async getAll(): Promise<StoredPhoto[]> {
    const db = await openDB();
    try {
      const { keys, vals } = await getAllPairs(db);
      const out: StoredPhoto[] = [];
      for (let i = 0; i < keys.length; i++) {
        const v = vals[i] as Partial<PhotoRecord> | null;
        if (!v || !(v.blob instanceof Blob)) continue;
        out.push({
          id: keys[i],
          blob: v.blob,
          thumb: v.thumb instanceof Blob ? v.thumb : v.blob,
          timestamp: typeof v.timestamp === 'number' ? v.timestamp : 0,
          district: typeof v.district === 'string' ? v.district : '?',
        });
      }
      // Newest first; id desc breaks ties between same-ms captures.
      out.sort((a, b) =>
        b.timestamp - a.timestamp || Number(b.id) - Number(a.id));
      return out;
    } finally {
      db.close();
    }
  }

  /** Delete a photo by key; updates selection/viewer/grid state. */
  async deletePhoto(id: IDBValidKey): Promise<void> {
    const db = await openDB();
    try {
      await deletePhotoById(db, id);
    } finally {
      db.close();
    }
    if (this.selectedId === id) this.selectedId = null;
    if (this._viewerOpen && this.photos.some((p) => p.id === id)) this.closeViewer();
    if (this.isOpen) await this.refresh();
  }

  /** Download the full-resolution PNG for a photo. */
  async exportPhoto(id: IDBValidKey): Promise<void> {
    const list = this.photos.length > 0 ? this.photos : await this.getAll();
    const photo = list.find((p) => p.id === id);
    if (!photo) return;
    this.triggerDownload(
      photo.blob,
      'backrooms-' + slugify(photo.district) + '-' + fileStamp(photo.timestamp) + '.png',
    );
  }

  /* --------------------------- internals -------------------------- */

  private onKey = (e: KeyboardEvent): void => {
    if (isTextEntryTarget(e)) return;
    const k = (e.key ?? '').toLowerCase();
    if (k === 'g') {
      e.preventDefault?.();
      this.toggle();
      return;
    }
    if (!this.isOpen) return;
    if (k === 'escape') {
      e.preventDefault?.();
      if (this._viewerOpen) this.closeViewer();
      else this.close();
    } else if (k === 'd') {
      if (this.selectedId !== null) void this.deletePhoto(this.selectedId);
    } else if (k === 'e') {
      if (this.selectedId !== null) void this.exportPhoto(this.selectedId);
    }
  };

  private async refresh(): Promise<void> {
    try {
      this.photos = await this.getAll();
    } catch (e) {
      warn('failed to load photos: ' + (e instanceof Error ? e.message : String(e)));
      this.photos = [];
    }
    this.renderGrid();
  }

  private revokeAll(): void {
    for (const u of this.objectUrls) {
      try { URL.revokeObjectURL(u); } catch { /* ignore */ }
    }
    this.objectUrls = [];
    if (this.viewerUrl !== null) {

(Showing lines 355-399 of 556. Use offset=400 to continue.)

      try { URL.revokeObjectURL(this.viewerUrl); } catch { /* ignore */ }
      this.viewerUrl = null;
    }
  }

  private trackUrl(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    this.objectUrls.push(u);
    return u;
  }

  private ensureOverlay(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.className = 'bmb-gallery';
    root.setAttribute('style', OVERLAY_STYLE.replace('display:flex', 'display:none'));

    const header = document.createElement('div');
    header.className = 'bmb-gallery-header';
    header.textContent = 'MEMORY FRAGMENTS // [G] close';
    header.setAttribute('style', HINT_STYLE + 'margin-bottom:10px;');
    root.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'bmb-gallery-grid';
    grid.setAttribute('style', GRID_STYLE);
    root.appendChild(grid);

    const viewer = document.createElement('div');
    viewer.className = 'bmb-gallery-viewer';
    viewer.setAttribute('style', VIEWER_HIDDEN_STYLE);
    viewer.addEventListener('click', () => this.closeViewer());

    const viewerImg = document.createElement('img');
    viewerImg.className = 'bmb-gallery-full';
    viewerImg.setAttribute('style', FULL_IMG_STYLE);
    viewerImg.alt = 'enlarged photograph';
    viewer.appendChild(viewerImg);

    const viewerLabel = document.createElement('div');
    viewerLabel.className = 'bmb-gallery-viewer-label';
    viewerLabel.setAttribute('style', HINT_STYLE);
    viewer.appendChild(viewerLabel);

    const viewerHint = document.createElement('div');
    viewerHint.className = 'bmb-gallery-viewer-hint';
    viewerHint.textContent = '[D] discard   [E] export   [ESC] back';
    viewerHint.setAttribute('style', HINT_STYLE);
    viewer.appendChild(viewerHint);

    root.appendChild(viewer);
    this.container.appendChild(root);

    this.root = root;
    this.grid = grid;
    this.viewer = viewer;
    this.viewerImg = viewerImg;
    this.viewerLabel = viewerLabel;
  }

  private renderGrid(): void {
    const grid = this.grid;
    if (!grid) return;
    this.revokeAll();
    grid.textContent = '';
    if (this.photos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bmb-gallery-empty';
      empty.textContent = 'no fragments recovered yet // press the shutter to remember';
      empty.setAttribute('style', HINT_STYLE + 'padding:20px;');
      grid.appendChild(empty);
      return;
    }
    for (const photo of this.photos) {
      const selected = this.selectedId !== null && this.selectedId === photo.id;
      const cell = document.createElement('button');
      cell.className = 'bmb-gallery-cell';
      cell.setAttribute('style', selected ? CELL_SELECTED_STYLE : CELL_STYLE);

      const img = document.createElement('img');
      img.className = 'bmb-gallery-thumb';
      img.setAttribute('style', IMG_STYLE);
      img.src = this.trackUrl(photo.thumb);
      img.alt = photo.district;
      cell.appendChild(img);

      const label = document.createElement('div');
      label.className = 'bmb-gallery-caption';
      const d = new Date(photo.timestamp);
      label.textContent = photo.district + ' // ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      cell.appendChild(label);

      cell.addEventListener('click', () => {
        this.selectedId = photo.id;
        this.renderGrid();
        this.showViewer(photo);
      });
      grid.appendChild(cell);
    }
  }

  private showViewer(photo: StoredPhoto): void {
    this.ensureOverlay();
    if (this.viewerUrl !== null) {
      try { URL.revokeObjectURL(this.viewerUrl); } catch { /* ignore */ }
      this.viewerUrl = null;
    }
    this.viewerUrl = URL.createObjectURL(photo.blob);
    if (this.viewerImg) this.viewerImg.src = this.viewerUrl;
    if (this.viewerLabel) {
      const d = new Date(photo.timestamp);
      this.viewerLabel.textContent = photo.district + ' // ' + d.toLocaleString();
    }
    this._viewerOpen = true;
    if (this.viewer) this.viewer.style.display = 'flex';
  }

  private closeViewer(): void {
    this._viewerOpen = false;
    if (this.viewer) this.viewer.style.display = 'none';
    if (this.viewerUrl !== null) {
      try { URL.revokeObjectURL(this.viewerUrl); } catch { /* ignore */ }
      this.viewerUrl = null;
    }
  }

  private triggerDownload(blob: Blob, filename: string): void {
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    if (document.body) document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 5000);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function fileStamp(ts: number): string {
  return new Date(ts).toISOString().replace(/[:.]/g, '-').slice(0, 19);
}


