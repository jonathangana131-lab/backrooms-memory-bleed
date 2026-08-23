
/**
 * Whisper direction cue: an ambient screen-edge shimmer that breathes
 * toward the origin of a spatialized whisper sound.
 *
 * Design intent (atmosphere, not UI):
 *  - Four soft gradient glows hug the screen edges (N/E/S/W relative to the
 *    camera yaw). A whisper lights the nearest edge at peak opacity 0.08 -
 *    below conscious-attention threshold - and fades out over 1.2s.
 *  - Diagonal origins split energy across the two adjacent edges at half
 *    strength, which reads as a corner without ever drawing a corner.
 *  - No borders, no icons, no text. Pure light leak. Most players only
 *    notice they turned their head.
 *
 * Accessibility tie-in: when the persisted accessibility profile
 * (localStorage key bmb-accessibility) has motionReduction enabled, the
 * shimmer never animates - it appears instantly at reduced strength,
 * holds briefly, then clears instantly (matching REDUCED_EFFECT_SCALE
 * in accessibility.ts).
 *
 * Standalone module: owns only its own stylesheet and DOM subtree, like
 * compass.ts / tracker.ts. Pure DOM/CSS, no Babylon dependency.
 */
// Kept local (mirroring src/ui/accessibility.ts) so this module stays a
// dependency-free leaf: node --experimental-strip-types test runners
// cannot resolve this codebase's extensionless relative imports.
/** localStorage key used for persisted accessibility options. */
const ACCESSIBILITY_KEY = 'bmb-accessibility';

/** Fraction of full-strength screen effects used while motion is reduced. */
export const REDUCED_EFFECT_SCALE = 0.35;

/** Peak opacity of a fully-weighted edge shimmer. Deliberately faint. */
export const SHIMMER_PEAK_OPACITY = 0.08;

/** Fade duration for one shimmer, in milliseconds. */
export const SHIMMER_FADE_MS = 1200;

/**
 * How long the reduced-motion static glow holds before clearing, in ms.
 * Short enough to stay informational, long enough to be sensed.
 */
export const REDUCED_HOLD_MS = 900;

/** Edge names in clockwise order starting at north (screen top). */
export const EDGE_NAMES = ['north', 'east', 'south', 'west'] as const;

export type EdgeName = (typeof EDGE_NAMES)[number];

/** Center heading of each edge zone in relative space (radians, 0 = ahead). */
const EDGE_CENTERS: Readonly<Record<EdgeName, number>> = {
  north: 0,
  east: Math.PI / 2,
  south: Math.PI,
  west: -Math.PI / 2,
};

/** Wrap any angle into (-PI, PI]. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x <= -Math.PI) x += Math.PI * 2;
  return x === -Math.PI ? Math.PI : x; // canonicalize -PI to +PI (both "south")
}

/** Smallest absolute difference between two angles, in [0, PI]. */
export function angleDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

/**
 * Bearing of the whisper source relative to where the camera faces:
 * 0 = dead ahead (north edge), +PI/2 = right (east edge),
 * -PI/2 = left (west edge), PI = behind (south edge).
 */
export function relativeBearing(angleRadians: number, cameraYaw: number): number {
  return normalizeAngle(angleRadians - cameraYaw);
}

/**
 * Per-edge shimmer weight in [0, 1] for a relative bearing. Linear falloff
 * across each half-turn quadrant: a cardinal bearing lights exactly one
 * edge at full strength; a diagonal bearing lights the two adjacent edges
 * at exactly half strength each.
 */
export function edgeWeights(bearing: number): Record<EdgeName, number> {
  const half = Math.PI / 2;
  const out = {} as Record<EdgeName, number>;
  for (const name of EDGE_NAMES) {
    const d = angleDistance(bearing, EDGE_CENTERS[name]);
    const w = 1 - d / half;
    out[name] = w > 0 ? w : 0;
  }
  return out;
}

/** Structural surface of Storage this module needs (probe-friendly). */
export interface CueStorageLike {
  getItem(key: string): string | null;
}

function defaultCueStorage(): CueStorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: CueStorageLike }).localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    /* denied/unavailable */
  }
  return null;
}

/**
 * Read the motionReduction flag straight from persisted accessibility
 * options ('bmb-accessibility'). Missing/corrupt storage means false.
 * Probed lazily so headless hosts without localStorage still work.
 */
export function readMotionReduction(
  storage: CueStorageLike | null = defaultCueStorage(),
): boolean {
  if (!storage) return false;
  try {
    const text = storage.getItem(ACCESSIBILITY_KEY);
    if (text === null) return false;
    const raw: unknown = JSON.parse(text);
    if (raw !== null && typeof raw === 'object') {
      const flag = (raw as Record<string, unknown>)['motionReduction'];
      if (typeof flag === 'boolean') return flag;
    }
  } catch {
    /* corrupt JSON or blocked storage -> treat as unset */
  }
  return false;
}

/** Minimal structural surface of elements used by WhisperCue. */
export interface CueElementLike {
  className: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: CueElementLike): unknown;
  remove(): void;
}

/** Minimal structural surface of the document used by WhisperCue. */
export interface CueDocumentLike {
  createElement(tagName: string): CueElementLike;
  head: { appendChild(child: CueElementLike): unknown };
}

function resolveDocument(container: {
  ownerDocument?: CueDocumentLike | null;
}): CueDocumentLike {
  const doc =
    container.ownerDocument ??
    (globalThis as { document?: CueDocumentLike }).document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('WhisperCue requires a DOM document');
  }
  return doc;
}



const STYLE_ID = 'bmb-whispercue-styles';

/**
 * Stylesheet for the cue layer. Exported for tests. Gradients bleed
 * inward from each edge with a wide soft falloff; the alpha lives in the
 * gradients themselves, and per-frame opacity multiplies on top of it.
 */
export function whisperCueCssText(): string {
  return [
    '/* bmb whisper cue: ambient edge shimmer */',
    '.bmb-whispercue-layer {',
    '  position: absolute;',
    '  inset: 0;',
    '  overflow: hidden;',
    '  pointer-events: none;',
    '  z-index: 45;',
    '}',
    '.bmb-whispercue-edge { position: absolute; opacity: 0; will-change: opacity; }',
    '.bmb-whispercue-edge.north {',
    '  left: -25%; top: 0; width: 150%; height: 26vh;',
    '  background: radial-gradient(55% 130% at 50% 0%, rgba(196, 208, 228, 0.6), rgba(196, 208, 228, 0) 72%);',
    '}',
    '.bmb-whispercue-edge.south {',
    '  left: -25%; bottom: 0; width: 150%; height: 26vh;',
    '  background: radial-gradient(55% 130% at 50% 100%, rgba(196, 208, 228, 0.6), rgba(196, 208, 228, 0) 72%);',
    '}',
    '.bmb-whispercue-edge.east {',
    '  top: -25%; right: 0; height: 150%; width: 22vw;',
    '  background: radial-gradient(130% 55% at 100% 50%, rgba(206, 200, 224, 0.6), rgba(206, 200, 224, 0) 72%);',
    '}',
    '.bmb-whispercue-edge.west {',
    '  top: -25%; left: 0; height: 150%; width: 22vw;',
    '  background: radial-gradient(130% 55% at 0% 50%, rgba(206, 200, 224, 0.6), rgba(206, 200, 224, 0) 72%);',
    '}',
  ].join('\n');
}

/**
 * Simulation-side state for the cue, kept DOM-free so the fade math is
 * directly testable: feed trigger() + update(dtMs), read edge strengths.
 */
export class WhisperCueState {
  private weights: Record<EdgeName, number> = {
    north: 0,
    east: 0,
    south: 0,
    west: 0,
  };
  /** True while a reduced-motion static hold is counting down. */
  private holdingStatic = false;
  private elapsedMs = 0;

  get currentWeights(): Readonly<Record<EdgeName, number>> {
    return this.weights;
  }

  get isActive(): boolean {
    return (
      this.holdingStatic ||
      Object.values(this.weights).some((w) => w > 0)
    );
  }

  /** Begin a shimmer for a source heard at `bearing` relative to view. */
  trigger(bearing: number, motionReduced: boolean): void {
    this.weights = edgeWeights(bearing);
    this.elapsedMs = 0;
    this.holdingStatic = motionReduced;
  }

  /**
   * Advance time. Returns the opacity each edge should have right now.
   * Normal mode eases the shimmer out quadratically over 1.2s; reduced-
   * motion mode snaps to a dimmer static glow, holds, then snaps off.
   */
  update(dtMs: number, motionReduced: boolean): Record<EdgeName, number> {
    const out = {} as Record<EdgeName, number>;
    this.elapsedMs += Math.max(0, dtMs);
    if (motionReduced) {
      this.holdingStatic = true;
      const scale = SHIMMER_PEAK_OPACITY * REDUCED_EFFECT_SCALE;
      const visible = this.elapsedMs < REDUCED_HOLD_MS ? scale : 0;
      for (const name of EDGE_NAMES) out[name] = this.weights[name] * visible;
      return out;
    }
    this.holdingStatic = false;
    const t = this.elapsedMs / SHIMMER_FADE_MS;
    if (t >= 1) {
      this.weights = { north: 0, east: 0, south: 0, west: 0 };
      for (const name of EDGE_NAMES) out[name] = 0;
      return out;
    }
    // Quadratic ease-out: quick bloom, long soft tail.
    const k = 1 - t;
    const factor = k * (2 - k);
    for (const name of EDGE_NAMES) {
      out[name] = this.weights[name] * SHIMMER_PEAK_OPACITY * factor;
    }
    return out;
  }
}

/**
 * DOM side of the whisper cue. Attach once to the HUD container; call
 * trigger() when a whisper plays and pump update(dt) every frame.
 */
export class WhisperCue {
  private readonly layer: CueElementLike;
  private readonly edges: Record<EdgeName, CueElementLike>;
  private readonly state = new WhisperCueState();
  private motionReduced: boolean;

  constructor(container: CueElementLike) {
    const doc = resolveDocument(container as {
      ownerDocument?: CueDocumentLike | null;
    });
    this.motionReduced = readMotionReduction();

    // Inject the stylesheet once per document.
    const styleEl = doc.createElement('style');
    styleEl.className = STYLE_ID;
    (styleEl as CueElementLike & { textContent?: string }).textContent =
      whisperCueCssText();
    doc.head.appendChild(styleEl);

    this.layer = doc.createElement('div');
    this.layer.className = 'bmb-whispercue-layer';
    this.edges = {} as Record<EdgeName, CueElementLike>;
    for (const name of EDGE_NAMES) {
      const el = doc.createElement('div');
      el.className = 'bmb-whispercue-edge ' + name;
      el.style.setProperty('opacity', '0');
      this.edges[name] = el;
      this.layer.appendChild(el);
    }
    container.appendChild(this.layer);
  }

  /**
   * Flash the edge(s) nearest a whisper heard at world-space heading
   * `angleRadians`, given the camera yaw at that moment.
   */
  trigger(angleRadians: number, cameraYaw: number): void {
    // Re-probe the live accessibility setting so toggling it mid-game is
    // honored without rebuilding the cue.
    this.motionReduced = readMotionReduction();
    this.state.trigger(
      relativeBearing(angleRadians, cameraYaw),
      this.motionReduced,
    );
    // Paint frame zero immediately: full-strength shimmer in normal mode,
    // instant dim glow (never an animated ramp) in reduced-motion mode.
    this.apply(this.state.update(0, this.motionReduced));
  }

  /** Advance the fade. `dt` is seconds since the previous frame. */
  update(dt: number): void {
    this.apply(this.state.update(dt * 1000, this.motionReduced));
  }

  /** Remove every trace from the DOM. */
  dispose(): void {
    this.layer.remove();
  }

  private apply(frame: Readonly<Record<EdgeName, number>>): void {
    for (const name of EDGE_NAMES) {
      this.edges[name].style.setProperty('opacity', frame[name].toFixed(4));
    }
  }
}


