/**
 * F35 Camcorder voice memos — record now, play back degraded later.
 *
 * The camcorder captures short spoken memos ({id, text, zone generation
 * at capture, duration, seeded waveform character}). Playback runs
 * through a degradation model driven entirely by the zone generation of
 * the chunk where the memo was recorded: the more generated/anomalous
 * the zone, the more the tape has already decayed.
 *
 * Degradation law: the MAGNITUDE curves (dropout density, pitch wobble,
 * noise floor, clarity loss) are pure monotone functions of the clamped
 * zone-generation parameter, so any sweep over zone generations is
 * provably ordered. The seeded randomness (run seed x memo id) only ever
 * picks CHARACTER parameters — wobble rate and phase, dropout phase,
 * hiss colour — which shape how the damage sounds without changing how
 * much of it there is. Consequences: the same memo id always renders the
 * identical degradation under the same run seed, and memos from deeper
 * zones always play back worse than ones from shallower zones.
 *
 * This module is the capture/playback MODEL only (headless-testable);
 * Web Audio presentation layers on top of it elsewhere.
 */

import { hash32, seedFromString } from '../core/rng';

/** Zone generation at or below this value counts as pristine (gen 0). */
export const ZONE_GEN_MAX = 8;

/** Dropouts per second at full degradation. */
export const MAX_DROPOUTS_PER_SEC = 3.2;
/** Peak pitch wobble depth in cents at full degradation. */
export const MAX_WOBBLE_CENTS = 140;
/** Noise floor amplitude (0..1) at full degradation. */
export const MAX_NOISE_FLOOR = 0.55;
/** Clarity retained by a memo recorded in the deepest zone. */
export const MIN_CLARITY = 0.12;

/**
 * Seeded playback character of one memo; magnitudes live in
 * PlaybackDegradation, this shapes how the damage moves.
 */
export interface MemoCharacter {
  /** Base voice pitch captured for this memo, Hz. */
  readonly pitchHz: number;
  /** Wobble oscillation rate, Hz. */
  readonly wobbleRateHz: number;
  /** Wobble phase offset in radians at t=0. */
  readonly wobblePhaseRad: number;
  /** First dropout onset after playback start, seconds. */
  readonly dropoutPhaseSec: number;
  /** Hiss brightness 0..1 selecting the noise-floor filter tilt. */
  readonly hissColor: number;
}

/** Complete degraded-render parameter set for one memo playback. */
export interface PlaybackDegradation {
  /** Scheduled dropouts per second of playback. */
  readonly dropoutRate: number;
  /** Pitch wobble depth in cents (peak deviation). */
  readonly pitchWobbleCents: number;
  /** Noise floor amplitude, 0..1. */
  readonly noiseFloor: number;
  /** Overall intelligibility, 1 (pristine) down to MIN_CLARITY. */
  readonly clarity: number;
  /** Seeded character shaping the render. */
  readonly character: MemoCharacter;
}

/** A stored voice memo as captured by the camcorder. */
export interface VoiceMemo {
  /** Stable memo id; fixes the seeded render forever. */
  readonly id: string;
  /** Zone generation of the chunk where recording happened. */
  readonly zoneGenAtCapture: number;
  /** Recording length in seconds (> 0). */
  readonly durationSec: number;
  /** Spoken payload preserved verbatim through storage. */
  readonly text: string;
  /** Seeded waveform identity captured at record time. */
  readonly waveform: MemoCharacter;
}

/**
 * Clamp a raw zone generation into the modelled range [0, ZONE_GEN_MAX].
 *
 * @param zoneGen - Raw zone generation value (may be negative or huge).
 * @returns Clamped degradation input.
 */
function clampZoneGen(zoneGen: number): number {
  return Math.min(ZONE_GEN_MAX, Math.max(0, zoneGen));
}

/**
 * Derive the seeded playback character for a memo. Pure function of
 * (runSeed, memoId): the same memo always renders with the same voice,
 * wobble motion, dropout phasing and hiss colour.
 *
 * @param runSeed - Run seed string.
 * @param memoId - Stable memo id.
 * @param zoneGen - Zone generation at capture (only scales pitch).
 * @returns Character parameters for rendering.
 */
export function memoCharacter(runSeed: string, memoId: string, zoneGen: number): MemoCharacter {
  let h = hash32(seedFromString(runSeed) ^ seedFromString(memoId));
  const draw = (): number => {
    h = hash32(h ^ 0x9e3779b9);
    return h / 4294967296;
  };
  // Pitch rises slightly with zone gen: deeper zones tape tighter.
  const gen = clampZoneGen(zoneGen) / ZONE_GEN_MAX;
  return {
    pitchHz: 92 + draw() * 46 + gen * 14,
    wobbleRateHz: 0.6 + draw() * 2.4,
    wobblePhaseRad: draw() * Math.PI * 2,
    dropoutPhaseSec: draw() * 1.5,
    hissColor: draw(),
  };
}

/**
 * Degraded-render parameters for one memo. Magnitudes follow pure
 * monotone curves of the clamped zone generation:
 *
 *   dropoutRate     ~ t^1.4   (nondecreasing)
 *   pitchWobbleCents~ t       (nondecreasing)
 *   noiseFloor      ~ t^0.8   (nondecreasing)
 *   clarity         linear down to MIN_CLARITY (nonincreasing)
 *
 * where t = clamp(zoneGen / ZONE_GEN_MAX). Character parameters are
 * keyed by rng(runSeed, memo.id) and never affect magnitude ordering.
 *
 * @param memo - Memo to render.
 * @param runSeed - Run seed string fixing the character stream.
 * @returns Deterministic degraded-playback parameter set.
 */
export function degradationFor(memo: VoiceMemo, runSeed: string): PlaybackDegradation {
  const t = clampZoneGen(memo.zoneGenAtCapture) / ZONE_GEN_MAX;
  return {
    dropoutRate: MAX_DROPOUTS_PER_SEC * Math.pow(t, 1.4),
    pitchWobbleCents: MAX_WOBBLE_CENTS * t,
    noiseFloor: MAX_NOISE_FLOOR * Math.pow(t, 0.8),
    clarity: 1 - (1 - MIN_CLARITY) * t,
    character: memoCharacter(runSeed, memo.id, memo.zoneGenAtCapture),
  };
}

/**
 * Capture a new memo. The id must be supplied by the caller (camcorder
 * sequence numbers work); it permanently pins both the waveform
 * identity and the degraded render for this run seed.
 *
 * @param id - Stable unique memo id.
 * @param text - Spoken payload to preserve verbatim.
 * @param zoneGenAtCapture - Zone generation where recording happened.
 * @param durationSec - Recording length in seconds; clamped to >= 0.25.
 * @param runSeed - Run seed string seeding the waveform identity.
 * @returns The immutable captured memo.
 */
export function recordMemo(
  id: string,
  text: string,
  zoneGenAtCapture: number,
  durationSec: number,
  runSeed: string,
): VoiceMemo {
  return {
    id,
    zoneGenAtCapture,
    durationSec: Math.max(0.25, durationSec),
    text,
    waveform: memoCharacter(runSeed, id, zoneGenAtCapture),
  };
}

/** On-disk envelope for serialized memo stores. */
interface StoredMemoStore {
  readonly version: 1;
  readonly runSeed: string;
  readonly memos: readonly VoiceMemo[];
}

/**
 * Ordered collection of captured memos with JSON persistence. Storage
 * round-trips are byte-faithful at the model level: deserialize(
 * serialize(store)) yields deep-equal memos whose renders match the
 * originals exactly.
 */
export class VoiceMemoStore {
  private readonly memos = new Map<string, VoiceMemo>();

  /**
   * @param runSeed - Run seed shared by every memo recorded here.
   */
  constructor(public readonly runSeed: string) {}

  /**
   * Capture and store a memo via recordMemo().
   *
   * @param id - Stable unique memo id; re-recording an id replaces it.
   * @param text - Spoken payload.
   * @param zoneGenAtCapture - Zone generation where recording happened.
   * @param durationSec - Recording length in seconds.
   * @returns The stored memo.
   */
  record(
    id: string,
    text: string,
    zoneGenAtCapture: number,
    durationSec: number,
  ): VoiceMemo {
    const memo = recordMemo(id, text, zoneGenAtCapture, durationSec, this.runSeed);
    this.memos.set(id, memo);
    return memo;
  }

  /**
   * Look up a stored memo by id.
   *
   * @param id - Memo id.
   * @returns The memo, or undefined when absent.
   */
  get(id: string): VoiceMemo | undefined {
    return this.memos.get(id);
  }

  /**
   * All stored memos in insertion order.
   *
   * @returns Read-only array copy.
   */
  all(): readonly VoiceMemo[] {
    return [...this.memos.values()];
  }

  /**
   * Remove a memo.
   *
   * @param id - Memo id.
   * @returns True when a memo was removed.
   */
  remove(id: string): boolean {
    return this.memos.delete(id);
  }

  /**
   * Serialize to a JSON document carrying the run seed so restores
   * reproduce identical renders.
   *
   * @returns JSON string.
   */
  serialize(): string {
    const doc: StoredMemoStore = {
      version: 1,
      runSeed: this.runSeed,
      memos: this.all(),
    };
    return JSON.stringify(doc);
  }

  /**
   * Restore a store from serialize() output. Rejects foreign versions
   * loudly rather than guessing at unknown formats.
   *
   * @param json - Document produced by serialize().
   * @returns A store equal to the serialized one.
   */
  static deserialize(json: string): VoiceMemoStore {
    const doc = JSON.parse(json) as Partial<StoredMemoStore>;
    if (doc.version !== 1 || typeof doc.runSeed !== 'string' || !Array.isArray(doc.memos)) {
      throw new Error(`unsupported memo store format: ${JSON.stringify(doc.version ?? null)}`);
    }
    const store = new VoiceMemoStore(doc.runSeed);
    for (const memo of doc.memos) {
      if (
        typeof memo !== 'object' || memo === null ||
        typeof memo.id !== 'string' ||
        typeof memo.zoneGenAtCapture !== 'number' ||
        typeof memo.durationSec !== 'number' ||
        typeof memo.text !== 'string' ||
        typeof memo.waveform !== 'object' || memo.waveform === null
      ) {
        throw new Error('malformed memo entry in store document');
      }
      store.memos.set(memo.id, {
        id: memo.id,
        zoneGenAtCapture: memo.zoneGenAtCapture,
        durationSec: memo.durationSec,
        text: memo.text,
        waveform: { ...memo.waveform },
      });
    }
    return store;
  }
}
