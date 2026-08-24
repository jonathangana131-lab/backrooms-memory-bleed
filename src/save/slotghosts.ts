/**
 * Save-slot ghosts for BACKROOMS: MEMORY BLEED (F89).
 *
 * Loading an old save flashes temporal echoes of that timeline. Slot
 * metadata {slotId, savedAtSec, seed, position} is injected per load event;
 * the model emits at most one echo burst — a ghost-figure flicker cue pinned
 * to the saved position — whose lifetime scales with staleness
 * (now − savedAt) up to ECHO_LIFETIME_CAP_SEC and then stays constant.
 * Slots staler than STALE_CUTOFF_SEC (a 30-day proxy in seconds) emit no
 * echo at all: the place has already forgotten that timeline.
 *
 * Echoes are strictly visual: every cue carries visualOnly = true and no
 * entity handle, collider, or gameplay hook, so nothing can interact with
 * the living world. Each load event bursts exactly once; repeat
 * notifications for the same load are silent until the slot unloads again.
 *
 * Flicker rhythm derives from src/core/rng.ts keyed by (slotId, seed), so
 * the same pair replays byte-identical cues. No Date.now(), no Math.random()
 * (see test/slotghosts-test.mjs).
 */

import { RNG, seedFromString } from '../core/rng';

// ---------------------------------------------------------------------------
// Inputs + cues
// ---------------------------------------------------------------------------

/** Metadata of one save slot as injected on a load event. */
export interface SaveSlotMeta {
  /** Stable save-slot identifier. */
  slotId: string;
  /** Session-clock time the save was written, in seconds. */
  savedAtSec: number;
  /** Seed of the run the save belongs to. */
  seed: number;
  /** World position the player occupied at save time [x, y, z]. */
  position: readonly [number, number, number];
}

/** One temporal echo cue; consumed by a purely visual renderer. */
export interface EchoCue {
  /** Slot the echo belongs to. */
  slotId: string;
  /** Ghost figure position [x, y, z] (the saved position). */
  position: readonly [number, number, number];
  /** Total lifetime of the flicker burst in seconds. */
  lifetimeSec: number;
  /** Ascending on/off offsets within lifetimeSec where the figure blinks. */
  flickerOffsetsSec: readonly number[];
  /** Always true: echoes never register entities or colliders. */
  visualOnly: true;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Upper bound on any echo's lifetime, in seconds. */
export const ECHO_LIFETIME_CAP_SEC = 30;

/** Lifetime of a brand-new save's echo, in seconds. */
export const ECHO_LIFETIME_BASE_SEC = 4;

/** Staleness (s) after which the ramp reaches the cap and stays constant. */
export const ECHO_LIFETIME_RAMP_SEC = 600;

/**
 * Slots staler than this emit no echo. A 30-day proxy expressed in seconds
 * so tests can exercise it without wall-clock dates.
 */
export const STALE_CUTOFF_SEC = 30 * 86400;

/** Number of flicker blinks inside one echo burst. */
export const FLICKER_COUNT = 5;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Echo lifetime for a staleness value: linear from
 * ECHO_LIFETIME_BASE_SEC at staleness 0 up to ECHO_LIFETIME_CAP_SEC at
 * ECHO_LIFETIME_RAMP_SEC, then constant at the cap.

 * @param stalenessSec now − savedAt in seconds, clamped at ≥ 0.
 * @returns Lifetime in seconds, always within
 *   [ECHO_LIFETIME_BASE_SEC, ECHO_LIFETIME_CAP_SEC].
 */
export function echoLifetimeSec(stalenessSec: number): number {
  const s = Number.isFinite(stalenessSec) ? Math.max(0, stalenessSec) : 0;
  if (s >= ECHO_LIFETIME_RAMP_SEC) return ECHO_LIFETIME_CAP_SEC;
  const t = s / ECHO_LIFETIME_RAMP_SEC;
  return ECHO_LIFETIME_BASE_SEC + (ECHO_LIFETIME_CAP_SEC - ECHO_LIFETIME_BASE_SEC) * t;
}

// ---------------------------------------------------------------------------
// Load-event model
// ---------------------------------------------------------------------------

/**
 * Once-per-load ghost tracker. Feed each save-slot load through notifyLoad;
 * it returns the single echo burst for that load, or [] when the slot is
 * too stale, already loaded, or its metadata is unusable.
 */
export class SlotGhosts {
  private readonly loadedSlots = new Set<string>();

  /**
   * Notify one load event.

   * @param meta Injected save-slot metadata.
   * @param nowSec Session-clock time of the load, in seconds.
   * @returns Exactly one EchoCue on the first notification of a fresh load,
   *   otherwise [] (repeat notifications, stale slots > STALE_CUTOFF_SEC,
   *   or non-finite clock/position junk).
   * @throws When slotId is missing or not a string.
   */
  notifyLoad(meta: SaveSlotMeta, nowSec: number): readonly EchoCue[] {
    if (!meta || typeof meta.slotId !== 'string' || meta.slotId === '') {
      throw new Error('save-slot metadata needs a non-empty string slotId');
    }
    if (this.loadedSlots.has(meta.slotId)) return [];
    if (!Number.isFinite(nowSec) || !Number.isFinite(meta.savedAtSec)) return [];
    if (!Array.isArray(meta.position) || !meta.position.every(Number.isFinite)) return [];
    this.loadedSlots.add(meta.slotId);
    const staleness = Math.max(0, nowSec - meta.savedAtSec);
    if (staleness > STALE_CUTOFF_SEC) return [];
    const rng = new RNG(
      (seedFromString(meta.slotId) ^ (meta.seed >>> 0)) >>> 0 || 0x9e3779b9,
    );
    const lifetimeSec = echoLifetimeSec(staleness);
    // Deterministic blink rhythm keyed by (slotId, seed): offsets spread
    // across the lifetime without colliding onto identical timestamps.
    const offsets = new Set<number>();
    while (offsets.size < FLICKER_COUNT) {
      offsets.add(Math.floor(rng.next() * Math.max(1, lifetimeSec * 1000)) / 1000);
    }
    const cue: EchoCue = {
      slotId: meta.slotId,
      position: [...meta.position] as [number, number, number],
      lifetimeSec,
      flickerOffsetsSec: [...offsets].sort((a, b) => a - b),
      visualOnly: true,
    };
    return [cue];
  }

  /**
   * Mark a slot unloaded so a later reload may burst again.
   *
   * @param slotId Slot identifier to forget.
   */
  unload(slotId: string): void {
    this.loadedSlots.delete(slotId);
  }

  /** Slots currently considered loaded since their last burst. */
  get loaded(): readonly string[] {
    return [...this.loadedSlots];
  }
}
