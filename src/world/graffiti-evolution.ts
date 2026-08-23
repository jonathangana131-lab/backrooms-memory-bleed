/**
 * Graffiti evolution — escalating messages written across visits.
 *
 * The Backrooms are never idle: between sessions someone (something?) comes
 * back and rewrites the walls. Each graffiti starts at stage 0 (the base text
 * the layout generator chose) and creeps forward one stage every time the
 * player re-enters its chunk after being away for GRAFFITI_AWAY_MS.
 *
 * Pure logic + localStorage only — no engine dependencies. The world layer
 * swaps its final text selection for getText(pool, chunkKey, index) and calls
 * noteChunkEntry(chunkKey) whenever the player enters a chunk.
 */

/** localStorage bucket holding stage numbers and last-visit times. */
export const GRAFFITI_STAGE_KEY = 'bmb-graffiti-stages';

/** Player must be away from a chunk this long before its graffiti escalates. */
export const GRAFFITI_AWAY_MS = 5 * 60_000;

/**
 * Escalation chains keyed by the base text. Stage 0 always repeats the base
 * text verbatim, so un-evolved graffiti looks exactly like before. Chains are
 * 2–3 entries long; the last entry is the terminal message.
 */
export const EVOLVED_GRAFFITI: Record<string, string[]> = {
  'GET OUT': ['GET OUT', 'GET OUT GET OUT', 'TOO LATE'],
  'IT LEARNS': ['IT LEARNS', 'IT LEARNS FASTER', 'IT TEACHES NOW'],
  'STILL HERE': ['STILL HERE', 'STILL HERE STILL HERE', 'ALWAYS WAS'],
  'NOT YOUR HOME': ['NOT YOUR HOME', 'NOT ANYONES HOME', 'HOME NOTICED YOU'],
  'WAKE UP': ['WAKE UP', 'WAKE UP WAKE UP', 'YOU ARE THE DREAM'],
  'DONT SLEEP': ['DONT SLEEP', 'DONT SLEEP DONT SLEEP', 'IT SLEEPS FOR YOU'],
  'I WAS SOMEONE': ['I WAS SOMEONE', 'I WAS SOMEONE ELSE', 'WHO WAS I'],
  'THE WALLS COPIED ME': ['THE WALLS COPIED ME', 'THE WALLS IMPROVED ME', 'THE COPY IS BETTER'],
  'NO EXIT': ['NO EXIT', 'NO EXIT NO EXIT', 'EXITS ARE DECORATION'],
  'WHO REMEMBERS ME': ['WHO REMEMBERS ME', 'REMEMBER WHO REMEMBERS YOU', 'I FORGOT FIRST'],
  'COPIED POORLY': ['COPIED POORLY', 'COPIED POORLY ON PURPOSE', 'YOU ARE THE DRAFT'],
  'CHECK YOUR MEMORY': ['CHECK YOUR MEMORY', 'CHECK IT AGAIN', 'IT CHANGED BACK'],
  'WARD 6 LIES': ['WARD 6 LIES', 'WARD 6 NEVER CLOSED', 'YOU NEVER CHECKED OUT'],
  'MIND THE GAP': ['MIND THE GAP', 'THE GAP MINDS YOU', 'YOU ARE THE GAP'],
};

export interface GraffitiEvolution {
  /**
   * Final text for one graffiti slot. Picks a base from baseTexts
   * deterministically from chunkKey + index (same slot, same wall, same
   * starting word every session), then applies the stored evolution stage.
   */
  getText(baseTexts: string[], chunkKey: string, index: number): string;
  /**
   * Record the player entering chunkKey. Returns true when this was a genuine
   * return (away ≥ GRAFFITI_AWAY_MS) and every registered graffiti in that
   * chunk advanced one stage — callers can use it to invalidate cached
   * graffiti materials.
   */
  noteChunkEntry(chunkKey: string): boolean;
}

interface Persisted {
  v: 1;
  /** slot key '<chunkKey>:<index>' → evolution stage */
  stages: Record<string, number>;
  /** chunkKey → last entry timestamp (ms) */
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

/** FNV-1a — stable slot hashing without importing the RNG stack. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function emptyState(): Persisted {
  return { v: 1, stages: {}, visits: {} };
}

function loadState(storage: Storage | null): Persisted {
  try {
    const raw = storage?.getItem(GRAFFITI_STAGE_KEY);
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
    storage?.setItem(GRAFFITI_STAGE_KEY, JSON.stringify(state));
  } catch {
    // quota/private-mode: evolution still works this session, just won't persist
  }
}

/**
 * Apply an evolution stage to a base text. Known bases climb their authored
 * chain; unknown bases fall back to frantic repetition, as if the writer kept
 * going over the same words.
 */
export function evolveGraffiti(base: string, stage: number): string {
  const chain = EVOLVED_GRAFFITI[base];
  const maxStage = (chain ? chain.length : 3) - 1;
  const s = Math.max(0, Math.min(Math.floor(stage), maxStage));
  if (chain) return chain[s];
  if (s <= 0) return base;
  return Array.from({ length: s + 1 }, () => base).join(' ');
}

export function createGraffitiEvolution(
  now: () => number = () => Date.now(),
  storage: Storage | null = safeStorage(),
): GraffitiEvolution {
  const state = loadState(storage);

  return {
    getText(baseTexts: string[], chunkKey: string, index: number): string {
      if (!baseTexts || baseTexts.length === 0) return '';
      const slotKey = chunkKey + ':' + index;
      const base = baseTexts[fnv1a(slotKey) % baseTexts.length];
      let stage = state.stages[slotKey];
      if (stage === undefined) {
        // register the slot so future re-entries know what to escalate
        stage = 0;
        state.stages[slotKey] = stage;
        saveState(storage, state);
      }
      return evolveGraffiti(base, stage);
    },

    noteChunkEntry(chunkKey: string): boolean {
      const t = now();
      const prev = state.visits[chunkKey];
      state.visits[chunkKey] = t;
      if (prev === undefined || t - prev < GRAFFITI_AWAY_MS) {
        saveState(storage, state);
        return false;
      }
      const prefix = chunkKey + ':';
      for (const k of Object.keys(state.stages)) {
        if (k.startsWith(prefix)) state.stages[k] = (state.stages[k] ?? 0) + 1;
      }
      saveState(storage, state);
      return true;
    },
  };
}

/** Default instance backed by the real localStorage and clock. */
export const graffitiEvolution: GraffitiEvolution = createGraffitiEvolution();


