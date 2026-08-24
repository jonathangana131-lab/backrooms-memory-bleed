/**
 * Local speedrun ghosts for BACKROOMS: MEMORY BLEED (F98).
 *
 * A finished run can be recorded as a ghost replay: a sorted series of pose
 * samples [{tSec, x, z, yaw}] over the run's session clock. Ghosts are
 * per-seed (one stored ghost per run seed) and retention keeps only the
 * fastest completion: a new attempt replaces the stored replay iff its
 * duration is strictly shorter — ties keep the incumbent.
 *
 * The pipeline is record -> serialize -> replay. Replay queries interpolate
 * linearly between the bracketing samples at query time t, clamped to the
 * first/last sample at both ends. Interpolation is pure arithmetic on the
 * serialized numbers, so the same payload answers byte-identical poses
 * across instances and processes; yaw is lerped as a raw recorded stream
 * with no angular wrap correction.
 *
 * Corrupted payloads are rejected, never thrown past deserializeGhost:
 * it returns null for non-string input, invalid JSON, wrong-typed or
 * missing fields, non-finite numbers, fewer than MIN_GHOST_SAMPLES samples,
 * and samples not ascending in tSec. A rejected payload never displaces a
 * stored best. Draws come from nowhere: this module has no Date.now(), no
 * Math.random(), and no src/core/rng.ts dependency because replays must be
 * a pure function of recorded data.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One recorded pose sample of a run. */
export interface GhostSample {
  /** Session-clock time of the sample in seconds; samples ascend in tSec. */
  tSec: number;
  /** World x position. */
  x: number;
  /** World z position. */
  z: number;
  /** Recorded yaw as a raw numeric stream. */
  yaw: number;
}

/** Interpolated ghost pose at one query time. */
export interface GhostPose {
  x: number;
  z: number;
  yaw: number;
}

/** A complete recorded run. */
export interface GhostReplay {
  /** Run seed the ghost belongs to. */
  seed: number;
  /** Total completion time in seconds. */
  durationSec: number;
  /** Pose samples, ascending in tSec, at least MIN_GHOST_SAMPLES long. */
  samples: readonly GhostSample[];
}

/** Outcome of feeding one attempt into the store. */
export interface AttemptOutcome {
  /** The replay now retained for the seed (new or incumbent). */
  retained: GhostReplay;
  /** True iff the attempt displaced a previous best. */
  replaced: boolean;
}

/** Minimum sample count for a usable replay (bracketing + interpolation). */
export const MIN_GHOST_SAMPLES = 2;

/** Prefix of every per-seed storage key. */
export const GHOST_KEY_PREFIX = 'bmb.speedrun.ghost.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Storage key for one run seed.

 * @param seed Run seed; coerced via >>> 0 so equivalent seeds share a key.
 * @returns Stable key like "bmb.speedrun.ghost.c0ffee".
 */
export function ghostStorageKey(seed: number): string {
  return `${GHOST_KEY_PREFIX}${(seed >>> 0).toString(16)}`;
}

function isFiniteSample(s: unknown): s is GhostSample {
  const g = s as GhostSample | null;
  return (
    !!g && typeof g === 'object' &&
    Number.isFinite(g.tSec) && Number.isFinite(g.x) &&
    Number.isFinite(g.z) && Number.isFinite(g.yaw)
  );
}

function validReplay(r: unknown): r is GhostReplay {
  if (!r || typeof r !== 'object') return false;
  const g = r as Partial<GhostReplay>;
  if (!Number.isFinite(g.seed as number) || !Number.isFinite(g.durationSec as number)) return false;
  if (!Array.isArray(g.samples) || g.samples.length < MIN_GHOST_SAMPLES) return false;
  let prev = -Infinity;
  for (const s of g.samples) {
    if (!isFiniteSample(s)) return false;
    if ((s as GhostSample).tSec <= prev) return false;
    prev = (s as GhostSample).tSec;
  }
  return true;
}

/**
 * Serialize a replay to a stable JSON string.

 * @param replay Replay to serialize.
 * @returns JSON text; identical inputs produce byte-identical output.
 * @throws When the replay fails validation (wrong types, non-finite
 *   numbers, < MIN_GHOST_SAMPLES samples, unsorted tSec).
 */
export function serializeGhost(replay: GhostReplay): string {
  if (!validReplay(replay)) throw new Error('invalid ghost replay');
  return JSON.stringify({
    seed: replay.seed,
    durationSec: replay.durationSec,
    samples: replay.samples.map((s) => ({ tSec: s.tSec, x: s.x, z: s.z, yaw: s.yaw })),
  });
}

/**
 * Parse a serialized replay. This is the trust boundary for persisted and
 * hand-edited payloads; anything malformed returns null rather than
 * throwing.

 * @param payload Serialized replay text.
 * @returns The parsed replay, or null when corrupted (see module header for
 *   the exhaustive rejection list).
 */
export function deserializeGhost(payload: string): GhostReplay | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return validReplay(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Interpolated ghost pose at query time t: linear between the bracketing
 * samples, clamped to the end samples outside the recording span.

 * @param replay Replay to query (as returned by deserializeGhost or the store).
 * @param tSec Query time in seconds on the run's session clock.
 * @returns The interpolated pose; junk tSec clamps into the span like any
 *   other out-of-range time.
 */
export function sampleAt(replay: GhostReplay, tSec: number): GhostPose {
  const { samples } = replay;
  if (!Number.isFinite(tSec) || tSec <= samples[0].tSec) {
    const s = samples[0];
    return { x: s.x, z: s.z, yaw: s.yaw };
  }
  const last = samples[samples.length - 1];
  if (tSec >= last.tSec) return { x: last.x, z: last.z, yaw: last.yaw };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tSec <= tSec) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const u = (tSec - a.tSec) / (b.tSec - a.tSec);
  return {
    x: a.x + (b.x - a.x) * u,
    z: a.z + (b.z - a.z) * u,
    yaw: a.yaw + (b.yaw - a.yaw) * u,
  };
}

// ---------------------------------------------------------------------------
// Per-seed store
// ---------------------------------------------------------------------------

/**
 * In-memory per-seed ghost store with fastest-completion retention. Feed
 * attempts through recordAttempt; export/import go through
 * serializeGhost/deserializeGhost so persistence layers never see anything
 * but stable JSON text keyed by ghostStorageKey(seed).
 */
export class SpeedrunGhostStore {
  private readonly best = new Map<string, GhostReplay>();

  /**
   * Record one completed run. The attempt is kept only if it is strictly
   * faster than the current best for its seed — an exact tie keeps the old
   * ghost.

   * @param seed Run seed.
   * @param durationSec Completion time in seconds.
   * @param samples Pose samples ascending in tSec.
   * @returns The outcome with the retained replay, or null when the attempt
   *   itself is invalid (non-finite duration, < MIN_GHOST_SAMPLES finite
   *   samples, unsorted tSec); an invalid attempt never touches the store.
   */
  recordAttempt(
    seed: number,
    durationSec: number,
    samples: readonly GhostSample[],
  ): AttemptOutcome | null {
    if (!Number.isFinite(seed)) return null;
    const candidate: GhostReplay = { seed, durationSec, samples: [...samples] };
    if (!validReplay(candidate)) return null;
    const key = ghostStorageKey(seed);
    const incumbent = this.best.get(key);
    if (incumbent && !(durationSec < incumbent.durationSec)) {
      return { retained: incumbent, replaced: false };
    }
    this.best.set(key, candidate);
    return { retained: candidate, replaced: true };
  }

  /**
   * Current best replay for a seed.

   * @param seed Run seed.
   * @returns The retained replay, or null when no attempt has been accepted.
   */
  bestGhost(seed: number): GhostReplay | null {
    return this.best.get(ghostStorageKey(seed)) ?? null;
  }

  /**
   * Import a serialized ghost for a seed. Corrupt or slower-than-best
   * payloads are rejected and leave the store unchanged.

   * @param seed Run seed the payload claims to belong to.
   * @param payload Serialized replay text.
   * @returns True iff the payload was valid and became the new best
   *   (strictly faster than any retained ghost; ties keep the incumbent).
   */
  loadSerialized(seed: number, payload: string): boolean {
    const imported = deserializeGhost(payload);
    if (!imported) return false;
    const incumbent = this.best.get(ghostStorageKey(seed));
    if (incumbent && !(imported.durationSec < incumbent.durationSec)) return false;
    this.best.set(ghostStorageKey(seed), imported);
    return true;
  }

  /**
   * Export the best replay for a seed.

   * @param seed Run seed.
   * @returns Serialized replay text, or null when nothing is retained.
   */
  exportSeed(seed: number): string | null {
    const g = this.best.get(ghostStorageKey(seed));
    return g ? serializeGhost(g) : null;
  }
}
