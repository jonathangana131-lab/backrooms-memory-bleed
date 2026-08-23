/**
 * Ambient story beats: timed narrative moments that surface as quiet
 * observations while exploring. Each beat fires at most once per session,
 * gated by a minimum cooldown so the world never talks over itself.
 *
 * Pure logic module — no engine dependencies. game.ts feeds a BeatState
 * snapshot each frame and displays whatever update() returns.
 */

/** Snapshot of the state a beat condition may inspect. */
export interface BeatState {
  /** Seconds survived this expedition. */
  playtimeSec: number;
  /** Research beacons discovered so far. */
  discoveries: number;
  /** Notes read so far. */
  notesRead: number;
  /** Distinct landmark rooms seen. */
  landmarksSeen: ReadonlySet<string> | readonly string[];
  /** Erosion stability, 0 (gone) to 1 (intact). */
  stability: number;
  /** Director tension phase. */
  phase: 'calm' | 'build' | 'peak' | 'release';
}

/** A single scripted narrative moment. */
export interface StoryBeat {
  id: string;
  condition(state: BeatState): boolean;
  text: string;
  /** Higher wins when several conditions hold on the same tick. */
  priority: number;
}

function landmarkCount(s: BeatState): number {
  const lm = s.landmarksSeen;
  return typeof (lm as ReadonlySet<string>).size === 'number'
    ? (lm as ReadonlySet<string>).size
    : (lm as readonly string[]).length;
}

/** All beats, ordered roughly by narrative arc (early -> late). */
export const BEATS: readonly StoryBeat[] = [
  // ---- Early game: observations ----------------------------------------
  {
    id: 'hum',
    condition: (s) => s.playtimeSec >= 45 && s.phase === 'calm',
    text: 'The fluorescent hum sits a half-step flat. Somewhere it resolves into a tune you know, and stops the moment you try to name it.',
    priority: 10,
  },
  {
    id: 'footprints',
    condition: (s) => s.playtimeSec >= 180,
    text: 'Your footprints cross an intersection ahead of you. You have been walking in a straight line.',
    priority: 9,
  },
  {
    id: 'first-note',
    condition: (s) => s.notesRead >= 1,
    text: 'Whoever wrote that note pressed hard enough to emboss the next three pages. None of the pages are here.',
    priority: 12,
  },
  {
    id: 'same-stain',
    condition: (s) => landmarkCount(s) >= 3,
    text: 'Three different rooms, three different layouts. The same water stain in each, moved to a corner you were not looking at.',
    priority: 11,
  },

  // ---- Mid game: revelations about the space ---------------------------
  {
    id: 'warm-lamp',
    condition: (s) => s.discoveries >= 2,
    text: 'The second beacon’s lamp was already warm when you reached it. The dust around its base held no footprints but yours.',
    priority: 13,
  },
  {
    id: 'uncommitted',
    condition: (s) => s.playtimeSec >= 360 && s.stability <= 0.75,
    text: 'The corridor you came down by is not gone. It has simply stopped committing to having existed. The wall where you entered is load-bearing wallpaper.',
    priority: 15,
  },
  {
    id: 'peak-listen',
    condition: (s) => s.phase === 'peak' && s.playtimeSec >= 420,
    text: 'During the worst of it, the walls breathe in. You count four seconds before they let go. It is exactly how long you have been holding yours.',
    priority: 14,
  },
  {
    id: 'later-notes',
    condition: (s) => s.notesRead >= 8,
    text: 'The later notes stop using the word “down.” Not replaced — removed, cleanly, from sentences that still need it. The writers noticed too.',
    priority: 16,
  },
  {
    id: 'map-refolds',
    condition: (s) => landmarkCount(s) >= 5,
    text: 'Five landmarks found. Your mental map keeps refolding along creases you did not put in it, and every fold lands the exit further out, not closer.',
    priority: 17,
  },

  // ---- Late game: existential hints ------------------------------------
  {
    id: 'rehearsed',
    condition: (s) => s.discoveries >= 4 && s.stability <= 0.6,
    text: 'Each beacon log describes someone arriving exactly where you are standing. The descriptions improve. Yours would read fluently already.',
    priority: 19,
  },
  {
    id: 'low-stability',
    condition: (s) => s.stability <= 0.45,
    text: 'Stability under half. The space replays your memories with errors, and lately the errors are things you remember more clearly than the originals.',
    priority: 18,
  },
  {
    id: 'deep-time',
    condition: (s) => s.playtimeSec >= 1500,
    text: 'You try to remember the face you came in with and get a floor plan instead. It is a good floor plan. You have been studying it for some time.',
    priority: 20,
  },
];

const MIN_COOLDOWN_SEC = 90;

/**
 * Scheduler: evaluates beat conditions against the live state and emits
 * one beat’s text when it fires. Beats fire once per session; at least
 * MIN_COOLDOWN_SEC must pass between any two beats.
 */
export class StoryBeats {
  private fired = new Set<string>();
  private cooldown = 0;

  /** Seconds until another beat may fire. */
  get cooldownRemaining(): number {
    return this.cooldown;
  }

  /** Ids of beats already shown this session (ordered by firing). */
  firedIds(): string[] {
    return [...this.fired];
  }

  /**
   * Advance time and evaluate conditions.
   * @returns The fired beat’s text, or null when nothing fires this tick.
   */
  update(dt: number, state: BeatState): string | null {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cooldown > 0) return null;
    let best: StoryBeat | null = null;
    for (const beat of BEATS) {
      if (this.fired.has(beat.id)) continue;
      let ok = false;
      try {
        ok = beat.condition(state);
      } catch {
        ok = false;
      }
      if (ok && (best === null || beat.priority > best.priority)) best = beat;
    }
    if (best === null) return null;
    this.fired.add(best.id);
    this.cooldown = MIN_COOLDOWN_SEC;
    return best.text;
  }

  /** Forget everything shown this session (new expedition). */
  reset(): void {
    this.fired.clear();
    this.cooldown = 0;
  }
}


