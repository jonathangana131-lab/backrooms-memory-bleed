/**
 * Automatic Threshold ending capture for BACKROOMS: MEMORY BLEED.
 *
 * When the story reaches the Threshold ending, core/game.ts triggerEnding()
 * paints the screen white by setting document.body.style.background to the
 * cream whiteout colour (#efe9d8) with a 1.2s ease transition, then restores
 * the style and drops back to the menu 1.4s later. This module watches for
 * exactly that mutation and, once the whiteout has settled, grabs the live
 * render canvas one last time and composites a commemorative frame: a thin
 * ink border plus a stamped footer reading THRESHOLD CROSSED, the expedition
 * seed (hex, same format as the ending log line) and the date.
 *
 * The resulting PNG blob is handed to the onCapture callback so the gallery
 * system (src/ui/gallery.ts) - or anything else - can persist it:
 *
 *   const endCapture = new EndCapture();
 *   endCapture.onCapture = (blob) => void storePhoto(blob);
 *   endCapture.arm(() => document.getElementById('renderCanvas') as
 *     HTMLCanvasElement | null);
 *
 * Failure safety: every step (observation, compositing, encoding, delivery)
 * is individually guarded. A capture problem degrades to a console warning
 * and NEVER breaks the ending sequence itself.
 *
 * Standalone module - owns no DOM subtree, like whispercue.ts. Pure helpers
 * are exported so hosts and tests can verify stamps and compositing without
 * a live renderer.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Cream whiteout colour triggerEnding paints onto document.body. */
export const WHITEOUT_BG = '#efe9d8';

/**
 * Delay between spotting the whiteout start and grabbing the frame. The
 * fade-in runs 1.2s and the style is cleared 1.4s after triggerEnding, so
 * 1.3s lands squarely on the fully-white settled frame.
 */
export const WHITEOUT_CAPTURE_DELAY_MS = 1300;

/** Thickness of the commemorative border, in canvas pixels. */
export const FRAME_BORDER_PX = 3;

/** Ink colour used for border + stamp text (matches the UI palette). */
const INK = '#2b2620';

/** Font for the stamp footer, scaled to canvas size. */
function stampFont(px: number): string {
  return String(px) + 'px "Courier New", monospace';
}

/* ------------------------------------------------------------------ */
/* Structural types (kept loose so shims satisfy them in tests)        */
/* ------------------------------------------------------------------ */

/** Minimal 2D-context surface the compositing step relies on. */
export interface DrawContextLike {
  drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

/** Minimal canvas surface: enough to composite from and encode a blob. */
export interface FrameSourceLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): DrawContextLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Seed formatted exactly like the ending log line ('deadbeef'). */
export function formatSeedHex(seed: number): string {
  return ((seed >>> 0)).toString(16).padStart(8, '0');
}

function pad2(n: number): string {
  return n < 10 ? '0' + String(n) : String(n);
}

/**
 * The single stamped line composited onto the frame footer, e.g.
 * "THRESHOLD CROSSED \u00b7 SEED deadbeef \u00b7 2026-08-23". A missing seed
 * renders as eight question marks instead of failing the stamp.
 */
export function formatStampLine(seed: number | null, date?: Date): string {
  const d = date ?? new Date();
  const ymd = String(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const hex = seed === null ? '????????' : formatSeedHex(seed);
  return 'THRESHOLD CROSSED \u00b7 SEED ' + hex + ' \u00b7 ' + ymd;
}

/** True when an inline style background equals the whiteout paint. */
export function isWhiteoutBackground(background: string | null | undefined): boolean {
  if (!background) return false;
  return background.replace(/\s+/g, '').toLowerCase() === WHITEOUT_BG;
}

/** Best-effort expedition seed for the stamp; null when unavailable. */
export function resolveSeed(): number | null {
  try {
    const g = globalThis as { __BMB__?: { stats?: () => { seed?: unknown } } };
    const stats = g.__BMB__?.stats?.();
    if (stats && typeof stats.seed === 'number' && Number.isFinite(stats.seed)) {
      return stats.seed >>> 0;
    }
  } catch {
    /* stamp simply omits the seed */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Compositing                                                         */
/* ------------------------------------------------------------------ */

export interface ComposeOptions {
  /** Expedition seed for the stamp; resolved lazily when omitted. */
  seed?: number | null;
  /** Stamp date; defaults to now. */
  date?: Date;
  /** Canvas factory; defaults to document.createElement('canvas'). */
  createCanvas?: () => FrameSourceLike;
}

/**
 * Build the commemorative frame: the source pixels drawn 1:1 onto a fresh
 * canvas, then a thin inset border, then the stamp line along the bottom.
 * Returns null (never throws) when no 2D context is available.
 */
export function composeCommemorativeFrame(
  source: FrameSourceLike,
  opts: ComposeOptions = {},
): FrameSourceLike | null {
  try {
    const mk = opts.createCanvas ?? (() => document.createElement('canvas'));
    const out = mk();
    const ctx = out.getContext('2d');
    if (!ctx || !(source.width > 0) || !(source.height > 0)) return null;

    out.width = source.width;
    out.height = source.height;

    // the whiteout frame itself (cast: shims satisfy this structurally)
    ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, source.width, source.height);

    // thin ink border, kept clear of the very edge so it survives scaling
    ctx.globalAlpha = 1;
    ctx.lineWidth = FRAME_BORDER_PX;
    ctx.strokeStyle = INK;
    const inset = Math.max(FRAME_BORDER_PX, 6);
    ctx.strokeRect(inset, inset, source.width - inset * 2, source.height - inset * 2);

    // seed stamp footer, right-aligned above the border
    const seed = opts.seed !== undefined ? opts.seed : resolveSeed();
    const line = formatStampLine(seed, opts.date);
    const px = Math.max(12, Math.min(22, Math.round(source.width / 60)));
    ctx.font = stampFont(px);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = INK;
    const pad = inset + px;
    ctx.fillText(line, source.width - pad, source.height - pad);

    return out;
  } catch (e) {
    console.warn('[endcapture] compositing failed', e);
    return null;
  }
}

/** canvas.toBlob as a promise; resolves null instead of rejecting. */
export function blobFromFrame(
  frame: FrameSourceLike,
  mime = 'image/png',
): Promise<Blob | null> {
  return new Promise((res) => {
    let settled = false;
    const done = (b: Blob | null): void => {
      if (!settled) {
        settled = true;
        res(b);
      }
    };
    try {
      // belt-and-braces timeout: some engines silently drop the callback
      setTimeout(() => done(null), 4000);
      frame.toBlob(done, mime);
    } catch {
      done(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* The capturer                                                        */
/* ------------------------------------------------------------------ */

/**
 * Watches for the Threshold whiteout and delivers one commemorative frame.
 * See the module header for wiring. Safe to arm/disarm repeatedly; each
 * arming captures at most one frame until re-armed.
 */
export class EndCapture {
  /** Gallery hook: receives the encoded PNG when a capture succeeds. */
  onCapture: ((blob: Blob) => void) | null = null;

  private provider: (() => HTMLCanvasElement | null) | null = null;
  private observer: { disconnect(): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private delayMs: number;

  constructor(delayMs: number = WHITEOUT_CAPTURE_DELAY_MS) {
    this.delayMs = delayMs;
  }

  /**
   * Start watching for the ending whiteout. canvasProvider is consulted
   * once, at capture time, so it may return null while the menu rebuilds -
   * that aborts the capture quietly rather than breaking the ending.
   */
  arm(canvasProvider: () => HTMLCanvasElement | null): void {
    this.disarm();
    this.pending = false;
    this.provider = canvasProvider;
    try {
      const mo = new MutationObserver(() => this.onBodyMutation());
      mo.observe(document.body, { attributes: true, attributeFilter: ['style'] });
      this.observer = mo;
    } catch (e) {
      console.warn('[endcapture] whiteout watcher unavailable', e);
    }
  }

  /** Stop watching and cancel any capture already scheduled. */
  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.observer?.disconnect();
    } catch {
      /* already gone */
    }
    this.observer = null;
    this.provider = null;
    this.pending = false;
  }

  /* -- internals (guarded end to end) ------------------------------ */

  private onBodyMutation(): void {
    if (this.observer === null || this.pending) return;
    let hit = false;
    try {
      hit = isWhiteoutBackground(document.body.style.background);
    } catch {
      return;
    }
    if (!hit) return;
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.captureNow();
    }, this.delayMs);
  }

  /** Run one capture attempt. Never throws; failures warn and drop. */
  private captureNow(): void {
    try {
      const raw = this.provider ? this.provider() : null;
      const framed = raw ? composeCommemorativeFrame(raw) : null;
      if (!framed) return;
      blobFromFrame(framed)
        .then((blob) => {
          if (blob && this.onCapture) {
            try {
              this.onCapture(blob);
            } catch (e) {
              console.warn('[endcapture] onCapture listener failed', e);
            }
          }
        })
        .catch((e) => console.warn('[endcapture] encoding failed', e));
    } catch (e) {
      console.warn('[endcapture] capture failed', e);
    }
  }
}


