/**
 * First-watcher introduction orchestration for BACKROOMS: MEMORY BLEED.
 *
 * The first time an expedition meets a watcher must never be incidental:
 * this module turns the spawn into a designed moment with a fixed shape
 *
 *   IDLE    -> nothing has begun; shouldPlay() gates on localStorage
 *   PRELUDE -> 2 seconds BEFORE the watcher becomes visible: every
 *              fluorescent hum ducks to half, a low string swell ramps
 *              in from silence, and the nearest fixture flickers
 *   REVEAL  -> visibility moment: the subtitle "...something is standing
 *              very still." holds while hum/swell ease back to baseline
 *   DONE    -> moment over; markShown() persists the flag under
 *              localStorage 'bmb-firstwatcher' so it never plays again
 *
 * Pure logic + localStorage. No engine dependencies: audio/lighting/UI
 * consumers sample getEffects() (or the individual getters) once per
 * frame after update(dt) and apply the values themselves. Deterministic
 * under Node apart from the storage probe, so tests can drive the whole
 * timeline with a stub backend (see test/watcherintro-test.mjs).
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** localStorage key holding the once-ever "first watcher shown" flag. */
export const WATCHERINTRO_STORAGE_KEY = 'bmb-firstwatcher';

/** Seconds of prelude BEFORE the watcher becomes visible. */
export const PRELUDE_SECONDS = 2;

/** Fraction of normal hum gain during the prelude (ducks by half). */
export const HUM_DUCK = 0.5;

/** Seconds the reveal lingers (subtitle hold + ease-back window). */
export const REVEAL_HOLD_SECONDS = 4;

/** The one subtitle the reveal is allowed to say. Ever. */
export const WATCHER_SUBTITLE = '...something is standing very still.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle states of the orchestrated first encounter. */
export type WatcherIntroPhase = 'idle' | 'prelude' | 'reveal' | 'done';

/**
 * Per-frame effect levels handed to audio/lighting consumers. During the
 * PRELUDE this is exactly the designed recipe: hum ducked to 0.5, a
 * string swell ramping 0..1 across the two seconds, and the fixture
 * flicker active. Outside the prelude everything eases home.
 */
export interface WatcherIntroEffects {
  /** Multiplier applied to fluorescent-hum gain this frame. */
  humDuck: number;
  /** Low-string swell level in [0, 1] (ramps up through the prelude). */
  stringSwell: number;
  /** True while the fixture near the watcher should strobe. */
  flickerFixture: boolean;
}

/** Minimal storage surface (DOM localStorage or a test stub). */
export interface WatcherIntroStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): WatcherIntroStorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: WatcherIntroStorageLike }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch {
    /* denied / unavailable */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence (one-shot flag)
// ---------------------------------------------------------------------------

/** Read the persisted shown flag. Missing/corrupt storage reads as false. */
export function readShownFlag(storage: WatcherIntroStorageLike | null): boolean {
  if (!storage) return false;
  try {
    const text = storage.getItem(WATCHERINTRO_STORAGE_KEY);
    if (text === null) return false;
    const raw: unknown = JSON.parse(text);
    if (raw === true) return true;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return (raw as Record<string, unknown>).shown === true;
    }
  } catch {
    /* corrupt JSON -> treat as unset */
  }
  return false;
}

/** Persist the shown flag (best effort; quota/denial never throws out). */
export function persistShownFlag(storage: WatcherIntroStorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(WATCHERINTRO_STORAGE_KEY, JSON.stringify({ shown: true }));
  } catch {
    /* quota / denied -> the intro still completes this expedition */
  }
}

// ---------------------------------------------------------------------------
// Contract other modules can program against
// ---------------------------------------------------------------------------

export interface WatcherIntro {
  /** True only when the orchestrated moment has never played here. */
  shouldPlay(): boolean;
  /** Start the prelude (2s before the watcher becomes visible). */
  begin(): void;
  /** Advance the timeline; drives prelude -> reveal -> done. */
  update(dt: number): void;
  /** True while the prelude or reveal is running. */
  isActive(): boolean;
  /** Current lifecycle phase ('idle' | 'prelude' | 'reveal' | 'done'). */
  readonly phase: string;
  /**
   * The reveal subtitle while the reveal holds, else null. Non-null
   * exactly when phase === 'reveal'.
   */
  getText(): string | null;
  /** Persist the never-again flag and retire the intro. Idempotent. */
  markShown(): void;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Construction options. */
export interface WatcherIntroOptions {
  /** Storage backend; defaults to probing globalThis.localStorage. Pass null to run in-memory. */
  storage?: WatcherIntroStorageLike | null;
}

/**
 * Owns the first-watcher encounter timeline. The game constructs one per
 * expedition and drives it:
 *
 *   watcher spawns hidden:  if (intro.shouldPlay()) intro.begin();
 *   each frame:             intro.update(dt);
 *                           apply intro.getEffects() to hum / strings / lights;
 *                           const line = intro.getText(); if (line) ui.say(line);
 *   after the reveal:       intro.markShown();
 */
export class WatcherIntroController implements WatcherIntro {
  private _phase: WatcherIntroPhase = 'idle';
  private t = 0;
  private readonly store: WatcherIntroStorageLike | null;

  constructor(opts: WatcherIntroOptions = {}) {
    // Explicit null opts OUT of storage entirely (tests); undefined probes.
    this.store = opts.storage !== undefined ? opts.storage : defaultStorage();
  }

  /** Current phase (exposed read-only through the contract). */
  get phase(): string {
    return this._phase;
  }

  /**
   * True only while the stored shown flag is unset AND no intro is
   * currently running. Once the flag persists, the moment never plays
   * again -- on any later expedition either.
   */
  shouldPlay(): boolean {
    if (this._phase !== 'idle') return false;
    return !readShownFlag(this.store);
  }

  /** Begin the 2-second prelude. No-op unless shouldPlay() holds. */
  begin(): void {
    if (!this.shouldPlay()) return;
    this._phase = 'prelude';
    this.t = 0;
  }

  /** Advance the intro clock by dt seconds (clamped, NaN-safe). */
  update(dt: number): void {
    if (this._phase !== 'prelude' && this._phase !== 'reveal') return;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const prevT = this.t;
    this.t += step;
    if (this._phase === 'prelude' && prevT < PRELUDE_SECONDS && this.t >= PRELUDE_SECONDS) {
      // Visibility moment: the watcher becomes visible; subtitle fires.
      this._phase = 'reveal';
    }
    if (this._phase === 'reveal' && this.t >= PRELUDE_SECONDS + REVEAL_HOLD_SECONDS) {
      this._phase = 'done';
    }
  }

  /** True while the moment is on screen / in your ears. */
  isActive(): boolean {
    return this._phase === 'prelude' || this._phase === 'reveal';
  }

  /**
   * The reveal subtitle, delivered exactly while the reveal holds --
   * i.e. at the visibility moment and for the hold duration. Null in
   * every other phase, including after markShown().
   */
  getText(): string | null {
    return this._phase === 'reveal' ? WATCHER_SUBTITLE : null;
  }

  /**
   * Persist the once-ever flag and retire the intro for good. Safe to
   * call repeatedly and safe to call before begin() (it still records
   * that the moment has been seen).
   */
  markShown(): void {
    persistShownFlag(this.store);
    this._phase = 'done';
  }

  // -- per-frame effect sampling --------------------------------------------

  /** Full effect snapshot for audio/lighting consumers this frame. */
  getEffects(): WatcherIntroEffects {
    if (this._phase === 'prelude') {
      return {
        humDuck: HUM_DUCK,
        stringSwell: Math.min(1, Math.max(0, this.t / PRELUDE_SECONDS)),
        flickerFixture: true,
      };
    }
    if (this._phase === 'reveal') {
      // Ease everything home across the hold so the moment exhales
      // instead of cutting.
      const k = Math.min(1, Math.max(0, (this.t - PRELUDE_SECONDS) / REVEAL_HOLD_SECONDS));
      return {
        humDuck: HUM_DUCK + (1 - HUM_DUCK) * k,
        stringSwell: 1 - k,
        flickerFixture: false,
      };
    }
    return { humDuck: 1, stringSwell: 0, flickerFixture: false };
  }

  /** Seconds elapsed since begin() (0 before the intro runs). */
  getElapsed(): number {
    return this.t;
  }
}


