/**
 * Water stain growth — ceiling damage that spreads across visits.
 *
 * Mirrors graffiti-evolution: each ceiling stain starts at stage 0 (the fresh
 * damp patch the layout generator chose) and creeps forward one stage every
 * time the player re-enters its chunk after being away for STAIN_AWAY_MS.
 * By stage 3 the stain has fully bloomed — bigger, darker, with a heavy ring
 * around its edge where the water kept pooling.
 *
 * Pure logic + localStorage only — no engine dependencies. The world layer
 * calls getStage(chunkKey, i) while placing stains and getSpec(baseRadius,
 * stage) when meshing; noteChunkEntry(chunkKey) fires whenever the player
 * enters a chunk.
 */

/** localStorage bucket holding stain stage numbers and last-visit times. */
export const STAIN_STAGE_KEY = 'bmb-stain-stages';

/** Player must be away from a chunk this long before its stains spread. */
export const STAIN_AWAY_MS = 5 * 60_000;

/** Fully bloomed stain. Stage 0 is the initial damp patch. */
export const MAX_STAIN_STAGE = 3;

/**
 * Visual spec for one stain instance, consumed by the mesher. All values are
 * derived from (baseRadius, stage); 'radius' multiplies baseRadius.
 */
export interface StainSpec {
  /** Radius multiplier on the generator's base radius: 1 -> 1.6 by stage 3. */
  radius: number;
  /** Darkening of the outer ring: 0 (invisible) -> 0.4 (heavy bloom edge). */
  edgeDarkness: number;
  /** Color progression toward rotten brown: 0 -> 1 across stages. */
  colorShift: number;
  /** Convenience fill color for this stage (hex), lerped between anchors. */
  color: string;
}

/**
 * Fill-color anchors per stage: pale damp patch -> saturated moldy brown.
 * Intermediate stages lerp between neighboring anchors in RGB space.
 */
const COLOR_ANCHORS: ReadonlyArray<[number, number, number]> = [
  [125, 143, 153], // stage 0 — fresh pale damp
  [104, 122, 111], // stage 1 — drying tide line
  [ 82,  92,  71], // stage 2 — spreading bloom
  [ 58,  61,  47], // stage 3 — fully bloomed, rotten
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function anchorColor(stageF: number): string {
  const clamped = Math.max(0, Math.min(COLOR_ANCHORS.length - 1, stageF));
  const i = Math.min(Math.floor(clamped), COLOR_ANCHORS.length - 2);
  const t = clamped - i;
  const a = COLOR_ANCHORS[i];
  const b = COLOR_ANCHORS[i + 1];
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bl = Math.round(lerp(a[2], b[2], t));
  return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
}

interface Persisted {
  v: 1;
  /** stain position key '<chunkKey>:<index>' -> growth stage */
  stages: Record<string, number>;
  /** chunkKey -> last entry timestamp (ms) */
  visits: Record<string, number>;
}

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function emptyState(): Persisted {
  return { v: 1, stages: {}, visits: {} };
}

function loadState(storage: Storage | null): Persisted {
  try {
    const raw = storage?.getItem(STAIN_STAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      v: 1,
      stages: parsed.stages && typeof parsed.stages === 'object' ? parsed.stages : {},
      visits: parsed.visits && typeof parsed.visits === 'object' ? parsed.visits : {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(storage: Storage | null, state: Persisted): void {
  try {
    storage?.setItem(STAIN_STAGE_KEY, JSON.stringify(state));
  } catch {
    // quota/private-mode: growth still works this session, just won't persist
  }
}

export interface StainGrowth {
  /**
   * Growth stage for one stain slot. Registers the slot at stage 0 on first
   * sight so later re-entries know what to advance.
   */
  getStage(chunkKey: string, stainIndex: number): number;
  /**
   * Record the player entering chunkKey. Returns true when this was a genuine
   * return (away >= STAIN_AWAY_MS) and every registered stain in that chunk
   * advanced one stage — callers can use it to invalidate cached stain
   * geometry/materials.
   */
  noteChunkEntry(chunkKey: string): boolean;
  /** Visual spec for the mesher at a given growth stage. */
  getSpec(baseR: number, stage: number): StainSpec;
}

export function createStainGrowth(
  now: () => number = () => Date.now(),
  storage: Storage | null = safeStorage(),
): StainGrowth {
  const state = loadState(storage);

  return {
    getStage(chunkKey: string, stainIndex: number): number {
      const slotKey = chunkKey + ':' + stainIndex;
      let stage = state.stages[slotKey];
      if (stage === undefined) {
        // register the slot so future re-entries know what to grow
        stage = 0;
        state.stages[slotKey] = stage;
        saveState(storage, state);
      }
      return Math.max(0, Math.min(MAX_STAIN_STAGE, stage));
    },

    noteChunkEntry(chunkKey: string): boolean {
      const t = now();
      const prev = state.visits[chunkKey];
      state.visits[chunkKey] = t;
      if (prev === undefined || t - prev < STAIN_AWAY_MS) {
        saveState(storage, state);
        return false;
      }
      const prefix = chunkKey + ':';
      for (const k of Object.keys(state.stages)) {
        if (k.startsWith(prefix)) {
          state.stages[k] = Math.min(MAX_STAIN_STAGE, (state.stages[k] ?? 0) + 1);
        }
      }
      saveState(storage, state);
      return true;
    },

    getSpec(baseR: number, stage: number): StainSpec {
      void baseR; // multiplier form keeps the mesher free to scale per-stain
      const s = Math.max(0, Math.min(MAX_STAIN_STAGE, Math.floor(stage)));
      const t = s / MAX_STAIN_STAGE;
      return {
        radius: lerp(1, 1.6, t),
        edgeDarkness: lerp(0, 0.4, t),
        colorShift: t,
        color: anchorColor(s),
      };
    },
  };
}

/** Default instance backed by the real localStorage and clock. */
export const stainGrowth: StainGrowth = createStainGrowth();


