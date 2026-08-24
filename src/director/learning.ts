/**
 * Director v2 fear-learning telemetry for BACKROOMS: MEMORY BLEED (F90).
 *
 * Pauses, hesitations, and lingers are the player's involuntary confession of
 * what scares them; skips confess boredom. This model consumes injected
 * scare-response events {kind, contextTag, intensity} and maintains a
 * per-contextTag fear affinity as an EMA (ALPHA = 0.2) over a scare signal:
 * pause is the strongest positive signal, skip is negative. The director reads
 * suggestPhaseBias() to learn which anomaly contexts to lean into — tag
 * weights normalized 0..1 where higher means scarier to THIS player and 0.5
 * is the uniform cold-start baseline every tag shares before evidence.
 *
 * Long stretches without events decay every affinity toward the uniform
 * baseline (exponential, after DECAY_GRACE_SEC of idle clock), so stale
 * fears fade instead of pacing the run forever. The model is pure arithmetic
 * over an injected session clock: no Date.now(), no Math.random() — identical
 * event/clock feeds replay byte-identical serialized state (see
 * test/directorlearning-test.mjs).
 */

// ---------------------------------------------------------------------------
// Inputs + outputs
// ---------------------------------------------------------------------------

/** Kind of observed player scare-response. */
export type ScareEventKind = 'pause' | 'hesitation' | 'linger' | 'skip';

/** One injected observation of how the player reacted inside a context. */
export interface ScareResponseEvent {
  /** Which kind of reaction occurred. */
  kind: ScareEventKind;
  /** Anomaly/context tag the reaction happened in (e.g. 'hum-corridor'). */
  contextTag: string;
  /** Strength of the reaction in [0, 1] (dwell length, freeze depth...). */
  intensity: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** EMA smoothing factor applied per recorded event. */
export const ALPHA = 0.2;

/**
 * Idle session-clock seconds after which affinities start decaying toward
 * the uniform baseline. Below this, ordinary gaps between encounters leave
 * learned fear untouched.
 */
export const DECAY_GRACE_SEC = 90;

/** Exponential decay time constant (s) for the post-grace drift to uniform. */
export const DECAY_TAU_SEC = 240;

/**
 * Scare signal per event kind: how strongly that reaction confesses fear.
 * Skip is negative — it says the context did NOT scare this player.
 */
export const KIND_SIGNAL: Readonly<Record<ScareEventKind, number>> = {
  pause: 1,
  hesitation: 0.75,
  linger: 0.5,
  skip: -1,
};

const SERIALIZATION_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a value into [0, 1]; non-finite values clamp to 0.

 * @param v Arbitrary number.
 * @returns v when finite, clamped into [0, 1]; 0 otherwise.
 */
function unit(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Clamp an affinity into its legal [-1, 1] range.

 * @param v Affinity value.
 * @returns v clamped into [-1, 1].
 */
function signedUnit(v: number): number {
  return Math.min(1, Math.max(-1, v));
}

// ---------------------------------------------------------------------------
// Learning model
// ---------------------------------------------------------------------------

/**
 * Per-contextTag fear-affinity tracker feeding the horror director's pacing
 * bias. Feed events through record(); read the director-facing weights with
 * suggestPhaseBias(); advance the injected session clock with advanceClock()
 * so idle stretches can decay toward uniform.
 */
export class DirectorLearning {
  private readonly affinity = new Map<string, number>();
  private idleSec = 0;
  /** Idle seconds beyond DECAY_GRACE_SEC already folded into the decay. */
  private decayedExcessSec = 0;

  /**
   * @param knownTags Context tags to track from cold start (uniform 0.5)
   *   before any evidence arrives; tags also register themselves on first use.
   */
  constructor(knownTags: readonly string[] = []) {
    for (const tag of knownTags) this.registerTag(tag);
  }

  /**
   * Record one scare-response event.
   *
   * @param ev Injected observation; kind must be known, contextTag a
   *   non-empty string, intensity non-finite events are dropped.
   * @returns True when the event was folded into the affinity EMA.
   * @throws When kind is not a ScareEventKind or contextTag is missing/empty.
   */
  record(ev: ScareResponseEvent): boolean {
    const signal = typeof ev?.kind === 'string' ? KIND_SIGNAL[ev.kind as ScareEventKind] : undefined;
    if (signal === undefined) {
      throw new Error(`unknown scare-response kind: ${String(ev?.kind)}`);
    }
    if (typeof ev.contextTag !== 'string' || ev.contextTag === '') {
      throw new Error('scare-response event needs a non-empty string contextTag');
    }
    if (!Number.isFinite(ev.intensity)) return false;
    this.registerTag(ev.contextTag);
    const sample = signal * unit(ev.intensity);
    const prev = this.affinity.get(ev.contextTag) ?? 0;
    this.affinity.set(ev.contextTag, prev + ALPHA * (sample - prev));
    // Fresh evidence ends the idle stretch: fear stops decaying.
    this.idleSec = 0;
    this.decayedExcessSec = 0;
    return true;
  }

  /**
   * Advance the injected session clock. Stretches past DECAY_GRACE_SEC decay
   * every affinity exponentially toward 0 (= uniform bias) with time constant
   * DECAY_TAU_SEC; only the newly-exceeded excess is applied, so repeated
   * small ticks and one large tick land on the same state.
   *
   * @param deltaSec Non-negative finite clock advance in seconds.
   */
  advanceClock(deltaSec: number): void {
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) return;
    this.idleSec += deltaSec;
    const excess = Math.max(0, this.idleSec - DECAY_GRACE_SEC);
    if (excess <= this.decayedExcessSec) return;
    const factor = Math.exp(-(excess - this.decayedExcessSec) / DECAY_TAU_SEC);
    for (const [tag, value] of this.affinity) this.affinity.set(tag, value * factor);
    this.decayedExcessSec = excess;
  }

  /**
   * Director-facing pacing suggestion: one normalized weight per known tag.
   * Weight = 0.5 + 0.5 × affinity, so the cold start is exactly uniform at
   * 0.5 and stronger fear pushes toward 1 while skipped contexts sag to 0.

   * @returns Tag → weight map, every weight within [0, 1].
   */
  suggestPhaseBias(): Record<string, number> {
    const bias: Record<string, number> = {};
    for (const [tag, value] of this.affinity) {
      bias[tag] = 0.5 * (1 + signedUnit(value));
    }
    return bias;
  }

  /** Context tags currently tracked, sorted for deterministic iteration. */
  tags(): readonly string[] {
    return [...this.affinity.keys()].sort();
  }

  /**
   * Serialize full learning state to JSON.
   *
   * @returns JSON string covering every affinity plus the idle clock.
   */
  serialize(): string {
    const tags: Record<string, number> = {};
    for (const tag of this.tags()) tags[tag] = this.affinity.get(tag) ?? 0;
    return JSON.stringify({ v: SERIALIZATION_VERSION, tags, idleSec: this.idleSec });
  }

  /**
   * Restore learning state from serialize() output.
   *
   * @param json JSON string produced by serialize().
   * @returns A restored model continuing exactly where the source left off.
   * @throws On any malformed payload (wrong version, non-finite affinity or
   *   idle clock, non-string/empty tag) — callers keep their current model.
   */
  static deserialize(json: string): DirectorLearning {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new Error('director-learning save is not valid JSON');
    }
    const obj = raw as { v?: unknown; tags?: unknown; idleSec?: unknown };
    if (!obj || obj.v !== SERIALIZATION_VERSION) {
      throw new Error('director-learning save version mismatch');
    }
    if (!obj.tags || typeof obj.tags !== 'object' || Array.isArray(obj.tags)) {
      throw new Error('director-learning save needs a tags object');
    }
    const model = new DirectorLearning();
    for (const [tag, value] of Object.entries(obj.tags)) {
      if (typeof tag !== 'string' || tag === '') throw new Error('empty tag in save');
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
        throw new Error(`affinity out of range for tag ${tag}`);
      }
      model.registerTag(tag);
      model.affinity.set(tag, value);
    }
    if (
      typeof obj.idleSec !== 'number' ||
      !Number.isFinite(obj.idleSec) ||
      obj.idleSec < 0
    ) {
      throw new Error('director-learning save idleSec must be a non-negative number');
    }
    model.idleSec = obj.idleSec;
    model.decayedExcessSec = Math.max(0, obj.idleSec - DECAY_GRACE_SEC);
    return model;
  }

  /** Register a tag at the uniform baseline if not already tracked. */
  private registerTag(tag: string): void {
    if (!this.affinity.has(tag)) this.affinity.set(tag, 0);
  }
}
