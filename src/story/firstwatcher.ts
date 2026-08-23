/**
 * First-watcher introduction moment: the first time ANY watcher spawns in
 * an expedition, the reveal is orchestrated rather than incidental.
 *
 * Timeline (all times in seconds, driven by update(dt)):
 *
 *   t = 0            playPreloader() called as a watcher spawn resolves
 *                    -- watcher exists but is NOT yet visible
 *   t in [0, 2)      PRELUDE: every fluorescent hum ducks to 50% while a
 *                    single low string swell fades in underneath; the
 *                    fixture nearest the spawn point flickers rapidly
 *   t = 2            VISIBILITY MOMENT: subtitle fires exactly once --
 *                    "...something is standing very still."
 *   t in [2, REVEAL) REVEAL: hum and swell ease back to their baselines
 *                    while the subtitle holds on screen
 *   t >= REVEAL      done; markShown() persists the slot so it never
 *                    repeats on any future expedition from that save
 *
 * Pure logic + localStorage. No engine dependencies -- like beats.ts this
 * is a dependency-free leaf so node --experimental-strip-types test
 * runners can load it directly; game.ts samples its curves each frame
 * and applies them to audio/lighting/UI surfaces.
 */

/** localStorage key tracking first-watcher-shown per save slot. */
export const FIRSTWATCHER_STORAGE_KEY = 'bmb-firstwatcher';

/** Seconds between prelude start and the watcher becoming visible. */
export const PRELUDE_SECONDS = 2;

/** Fraction of normal hum gain during the prelude (ducks by 50%). */
export const HUM_DUCK_FRACTION = 0.5;

/** The one subtitle the visibility moment is allowed to say. Ever. */
export const FIRSTWATCHER_SUBTITLE = '...something is standing very still.';

/** Seconds the reveal phase lingers after visibility before going quiet. */
export const REVEAL_HOLD_SECONDS = 4;

/** Strobe rate of the prelude flicker, in toggles per second. */
export const FLICKER_RATE_HZ = 24;

/** Phases of the orchestrated intro. */
export type FirstWatcherPhase = 'idle' | 'prelude' | 'reveal' | 'done';

/** Minimal storage surface (DOM localStorage or a test stub). */
export interface FirstWatcherStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): FirstWatcherStorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: FirstWatcherStorageLike }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch {
    /* denied / unavailable */
  }
  return null;
}

/**
 * Read the set of save slots that have already seen their first watcher.
 * Missing/corrupt storage yields an empty record, never a throw.
 */
export function readShownSlots(storage: FirstWatcherStorageLike | null): Record<string, boolean> {
  if (!storage) return {};
  try {
    const text = storage.getItem(FIRSTWATCHER_STORAGE_KEY);
    if (text === null) return {};
    const raw: unknown = JSON.parse(text);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        out[k] = v === true;
      }
      return out;
    }
  } catch {
    /* corrupt JSON -> treat as unset */
  }
  return {};
}

/** Persist one more save slot into the shown record (best effort). */
export function persistShownSlot(
  storage: FirstWatcherStorageLike | null,
  slot: string,
): void {
  if (!storage) return;
  try {
    const slots = readShownSlots(storage);
    slots[slot] = true;
    storage.setItem(FIRSTWATCHER_STORAGE_KEY, JSON.stringify(slots));
  } catch {
    /* quota / denied -> the intro still completes this expedition */
  }
}

/**
 * Fluorescent-hum gain multiplier for time t since playPreloader().
 * Prelude: ramps 1 -> HUM_DUCK_FRACTION over the first half of the lead,
 * then holds. Reveal: eases back to 1 across the hold. Outside the intro
 * the hum runs untouched at 1.
 */
export function humCurve(phase: FirstWatcherPhase, t: number): number {
  if (phase === 'prelude') {
    const k = Math.min(1, Math.max(0, t / (PRELUDE_SECONDS * 0.5)));
    return 1 + (HUM_DUCK_FRACTION - 1) * k;
  }
  if (phase === 'reveal') {
    const k = Math.min(1, Math.max(0, t / REVEAL_HOLD_SECONDS));
    return HUM_DUCK_FRACTION + (1 - HUM_DUCK_FRACTION) * k;
  }
  return 1;
}

/**
 * Low-string swell level in [0, 1] for time t since playPreloader().
 * Fades in across the whole prelude so the swell arrives with the figure;
 * fades back out across the reveal hold. Smoothstep keeps the fade musical.
 */
export function swellCurve(phase: FirstWatcherPhase, t: number): number {
  if (phase !== 'prelude' && phase !== 'reveal') return 0;
  const total = PRELUDE_SECONDS + REVEAL_HOLD_SECONDS;
  const x = Math.min(1, Math.max(0, t / total));
  // smoothstep up through the prelude, mirrored down through the reveal
  const s = x * x * (3 - 2 * x);
  return s;
}

/** Tiny deterministic integer hash (local so this stays a leaf module). */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Rapid-flicker intensity multiplier for the fixture nearest the spawn
 * point during the prelude, in (0, 1]. Hard chaotic strobing at
 * FLICKER_RATE_HZ driven by a stable spatial seed, with a decaying
 * envelope that settles just as the watcher becomes visible. Any light
 * outside the prelude runs at a calm 1.
 */
export function preludeFlicker(phase: FirstWatcherPhase, t: number, seed: number): number {
  if (phase !== 'prelude') return 1;
  const frame = Math.floor(t * FLICKER_RATE_HZ);
  const strobe = hash2(frame, seed) > 0.42 ? 1 : 0.08;
  const decay = 1 - Math.min(1, t / PRELUDE_SECONDS) * 0.45;
  return Math.max(0, Math.min(1, strobe * decay));
}

/** Minimal fixture record the nearest-fixture pick needs. */
export interface FixtureLite {
  x: number;
  z: number;
}

/** Index of the alive fixture nearest the spawn point, or -1 if none. */
export function nearestFixtureIndex(fixtures: readonly FixtureLite[], x: number, z: number): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const d = (f.x - x) ** 2 + (f.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Construction options. */
export interface FirstWatcherOptions {
  /** Save slot id used to scope the never-repeat flag (e.g. 'auto'). */
  slot?: string;
  /** Storage backend; defaults to probing globalThis.localStorage. */
  storage?: FirstWatcherStorageLike | null;
}

/**
 * Orchestrator for the first-watcher introduction. game.ts owns exactly
 * one instance per expedition:

   - each watcher spawn:  if (intro.shouldPlay()) intro.playPreloader(x, z);
   - each frame:          intro.update(dt); apply getHumScale(),
                          getSwellLevel() and getFlickerMul(); when
                          intro.consumeSubtitle() fires, ui.say(FIRSTWATCHER_SUBTITLE)
   - after the reveal:    intro.markShown() persists the never-repeat flag
 */
export class FirstWatcher implements FirstWatcherIntro {
  private phase: FirstWatcherPhase = 'idle';
  private t = 0;
  private sx = 0;
  private sz = 0;
  private subtitlePending = false;
  private subtitleTaken = false;
  private shownThisExpedition = false;

  constructor(private opts: FirstWatcherOptions = {}) {}

  /**
   * True only when this save slot has never seen a watcher AND no intro
   * has run yet this expedition. Once-per-expedition even if persistence
   * fails; once-ever-per-slot when it succeeds.
   */
  shouldPlay(): boolean {
    if (this.shownThisExpedition) return false;
    if (this.phase !== 'idle' && this.phase !== 'done') return false;
    const slot = this.opts.slot ?? 'auto';
    const slots = readShownSlots(this.opts.storage ?? defaultStorage());
    return !slots[slot];
  }

  /**
   * Begin the 2-second audio/lighting prelude at the given spawn point.
   * The caller keeps the spawned watcher hidden until update() crosses
   * PRELUDE_SECONDS. No-op unless shouldPlay() holds.
   */
  playPreloader(spawnX = 0, spawnZ = 0): void {
    if (!this.shouldPlay()) return;
    this.phase = 'prelude';
    this.t = 0;
    this.sx = spawnX;
    this.sz = spawnZ;
    this.subtitlePending = false;
    this.subtitleTaken = false;
  }

  /** Advance the intro clock; transitions prelude -> reveal -> done. */
  update(dt: number): void {
    if (this.phase !== 'prelude' && this.phase !== 'reveal') return;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const prevT = this.t;
    this.t += step;
    if (this.phase === 'prelude' && prevT < PRELUDE_SECONDS && this.t >= PRELUDE_SECONDS) {
      // visibility moment: arm the once-only subtitle
      this.phase = 'reveal';
      this.subtitlePending = true;
    }
    if (this.phase === 'reveal' && this.t >= PRELUDE_SECONDS + REVEAL_HOLD_SECONDS) {
      this.phase = 'done';
    }
  }

  /**
   * True exactly once, on the frame the watcher becomes visible. The
   * caller displays FIRSTWATCHER_SUBTITLE against it.
   */
  consumeSubtitle(): boolean {
    if (!this.subtitlePending || this.subtitleTaken) return false;
    this.subtitlePending = false;
    this.subtitleTaken = true;
    return true;
  }

  /**
   * Mark the save slot as having seen its first watcher and retire the
   * intro for the rest of this expedition. Safe to call repeatedly.
   */
  markShown(): void {
    this.shownThisExpedition = true;
    persistShownSlot(this.opts.storage ?? defaultStorage(), this.opts.slot ?? 'auto');
    if (this.phase !== 'done') this.phase = 'done';
  }

  /** True while the orchestrated moment is on screen / in your ears. */
  isActive(): boolean {
    return this.phase === 'prelude' || this.phase === 'reveal';
  }

  /** Current phase (for debug HUDs and tests). */
  getPhase(): FirstWatcherPhase {
    return this.phase;
  }

  /** Seconds elapsed since playPreloader(). */
  getElapsed(): number {
    return this.t;
  }

  /** Recorded spawn point of the introduced watcher. */
  getSpawnPoint(): { x: number; z: number } {
    return { x: this.sx, z: this.sz };
  }

  /** Hum gain multiplier to apply to every fluorescent layer this frame. */
  getHumScale(): number {
    return humCurve(this.phase, this.t);
  }

  /** Low-string swell level in [0,1] to feed the music bus this frame. */
  getSwellLevel(): number {
    return swellCurve(this.phase, this.t);
  }

  /**
   * Flicker multiplier for the fixture nearest the spawn point this
   * frame; all other lights pass through untouched at 1.
   */
  getFlickerMul(): number {
    const seed = Math.floor(this.sx * 11 + this.sz * 17);
    return preludeFlicker(this.phase, this.t, seed);
  }
}

/** Structural contract other modules can program against. */
export interface FirstWatcherIntro {
  /** Whether this expedition/slot still deserves the orchestrated intro. */
  shouldPlay(): boolean;
  /** Start the 2-second prelude before the watcher becomes visible. */
  playPreloader(spawnX?: number, spawnZ?: number): void;
  /** Persist first-watcher-shown for the save slot; end the intro. */
  markShown(): void;
  /** True while the prelude or reveal is running. */
  isActive(): boolean;
}


