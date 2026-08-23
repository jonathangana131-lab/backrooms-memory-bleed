
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


