/**
 * F64 The Negotiator — trades items for passage via gesture language.
 *
 * A silent figure blocks a passage and asks for things in gesture language:
 * it presents a seeded sequence of gestures drawn from a fixed catalog,
 * the player answers through injected gesture inputs, and a fully matched
 * sequence consumes one offered item to open a passage flag for T seconds.
 *
 * Guarantees (the AC):
 *   - full accept path works across seeds: matching the whole demand with
 *     the offered item in hand opens the passage for exactly PASSAGE seconds;
 *   - a wrong gesture resets sequence progress to zero and arms a hysteresis
 *     window during which every input is ignored (no re-arm, no extension);
 *   - each completed trade escalates the next demand length by one, bounded
 *     at MAX_DEMAND_LEN;
 *   - the passage window expires after exactly T seconds of advance();
 *   - deterministic per seed: demand sequences replay identically and
 *     decorrelate across seeds;
 *   - per-negotiator memory (trade count, live demand, progress, timers)
 *     survives serialize()/restore() byte-for-byte;
 *   - junk fails loud: malformed dependencies, unknown gestures, hostile dt,
 *     and corrupt save data all throw.
 *
 * Pure simulation module — no DOM, no Babylon. Determinism law holds: all
 * draws flow through src/core/rng.ts hashes and the seeded RNG class.
 */
import { RNG, hash4i } from '../core/rng';

// ---- gesture catalog ----------------------------------------------------------

/** Fixed gesture language; canonical catalog order used for hashing. */
export const GESTURES = ['palm-open', 'point', 'tilt-head', 'step-back'] as const;

/** One gesture the negotiator may demand or the player may answer with. */
export type Gesture = (typeof GESTURES)[number];

// ---- injected offer/passage model ----------------------------------------------

/**
 * Host capabilities the negotiator needs. Feature isolation: the game mounts
 * this over its inventory and passage systems; the machine never reaches
 * past the seam.
 */
export interface NegotiatorHost {
  /** Whether the player currently holds at least one unit of {@link itemId}. */
  hasOffer(itemId: string): boolean;
  /** Remove one unit of the offered item; called exactly once per accepted trade. */
  takeOffer(itemId: string): void;
  /** Open the passage keyed by negotiator id for `seconds` seconds of game time. */
  openPassage(negotiatorId: string, seconds: number): void;
}

/** Constructor dependencies; everything except tuning knobs is required. */
export interface NegotiatorDeps {
  /** Stable negotiator identity; keys passages and save records. */
  readonly id: string;
  /** Session seed steering the seeded demand sequences. */
  readonly seed: number;
  /** Item id the negotiator trades for. */
  readonly itemId: string;
  /** Offer/passage seam owned by the mounting system. */
  readonly host: NegotiatorHost;
  /** First-trade demand length (default {@link DEFAULT_BASE_DEMAND_LEN}). */
  readonly baseDemandLen?: number;
  /** Escalation ceiling (default {@link DEFAULT_MAX_DEMAND_LEN}). */
  readonly maxDemandLen?: number;
  /** Seconds a granted passage stays open (default {@link DEFAULT_PASSAGE_SECONDS}). */
  readonly passageSeconds?: number;
}

// ---- tuning -------------------------------------------------------------------

/** Default first-trade demand length. */
export const DEFAULT_BASE_DEMAND_LEN = 2;

/** Default escalation ceiling. */
export const DEFAULT_MAX_DEMAND_LEN = 5;

/** Default passage window in seconds. */
export const DEFAULT_PASSAGE_SECONDS = 45;

/** Input dead-time armed by a wrong answer, in seconds. */
export const HYSTERESIS_SECONDS = 3;

/** Salt separating this system's hash stream from other rng.ts consumers. */
const HASH_SALT = 0x6e65676f; // "nego"

/** Save format version for serialize()/restore(). */
const SAVE_VERSION = 1;

// ---- phases -----------------------------------------------------------------

/** Lifecycle of the trade conversation. */
export type NegotiatorPhase =
  /** Waiting for the player to open negotiations. */
  | 'idle'
  /** A demand sequence is on the table. */
  | 'demanding';

// ---- snapshots ---------------------------------------------------------------

/** Read-only view of the machine's live state, returned by advance(). */
export interface NegotiatorStatus {
  readonly phase: NegotiatorPhase;
  /** Length of the current (or upcoming) demand sequence. */
  readonly demandLen: number;
  /** Matched-so-far count within the active demand. */
  readonly progressIndex: number;
  readonly tradesCompleted: number;
  /** True while wrong-answer hysteresis suppresses input. */
  readonly hysteresisActive: boolean;
  /** Remaining wrong-answer dead time in seconds (0 when inactive). */
  readonly hysteresisRemainingSec: number;
  readonly passageActive: boolean;
  readonly passageRemainingSec: number;
}

/** Result of one player gesture input; extends the status snapshot. */
export interface RespondResult extends NegotiatorStatus {
  /** False when input was swallowed (wrong phase or hysteresis). */
  readonly counted: boolean;
  /** True only on the frame a trade completes and the passage opens. */
  readonly accepted: boolean;
  /** True when the sequence was matched but the player had nothing to offer. */
  readonly missingOffer: boolean;
  /** True when the gesture mismatched the demanded one. */
  readonly wrongGesture: boolean;
}

/** Plain JSON snapshot produced by serialize(); round-trips via restore(). */
export interface NegotiatorSaveData {
  version: number;
  id: string;
  tradesCompleted: number;
  phase: NegotiatorPhase;
  /** Live demand sequence, empty while idle. */
  demand: Gesture[];
  progressIndex: number;
  /** Remaining wrong-answer dead time in seconds. */
  hysteresisRemainingSec: number;
  /** Remaining passage window in seconds. */
  passageRemainingSec: number;
}

// ---- helpers -------------------------------------------------------------------

function isGesture(v: unknown): v is Gesture {
  return typeof v === 'string' && (GESTURES as readonly string[]).includes(v);
}

/** Clamp v into [0, hi]; NaN-safe because callers pre-validate finiteness. */
function clampMin0(v: number): number {
  return v <= 0 ? 0 : v;
}

/** Demand length after `trades` completions; monotone, bounded. */
export function demandLengthFor(trades: number, base: number, max: number): number {
  const b = Math.max(1, Math.floor(base));
  return Math.min(Math.max(b, Math.floor(max)), b + Math.max(0, Math.floor(trades)));
}

// ---- machine ---------------------------------------------------------------------

/**
 * Trade-state machine for one Negotiator. Create fresh via the constructor;
 * rebuild saved sessions through {@link Negotiator.restore}. Drive time with
 * advance(dt) and answer demands with respond(gesture).
 */
export class Negotiator {
  private readonly deps: Required<Pick<NegotiatorDeps, 'id' | 'seed' | 'itemId' | 'host'>> &
    Required<NegotiatorDeps>;
  private phase: NegotiatorPhase = 'idle';
  private demand: Gesture[] = [];
  private progressIndex = 0;
  private tradesCompleted = 0;
  private hysteresisRemainingSec = 0;
  private passageRemainingSec = 0;

  constructor(deps: NegotiatorDeps) {
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('Negotiator: deps object required');
    }
    if (typeof deps.id !== 'string' || deps.id.length === 0) {
      throw new TypeError('Negotiator: id must be a non-empty string');
    }
    if (!Number.isFinite(deps.seed)) {
      throw new TypeError('Negotiator: seed must be a finite number');
    }
    if (typeof deps.itemId !== 'string' || deps.itemId.length === 0) {
      throw new TypeError('Negotiator: itemId must be a non-empty string');
    }
    const host = deps.host;
    if (
      !host ||
      typeof host.hasOffer !== 'function' ||
      typeof host.takeOffer !== 'function' ||
      typeof host.openPassage !== 'function'
    ) {
      throw new TypeError('Negotiator: host must provide hasOffer/takeOffer/openPassage');
    }
    for (const knob of [deps.baseDemandLen, deps.maxDemandLen, deps.passageSeconds]) {
      if (knob !== undefined && (!Number.isFinite(knob) || knob <= 0)) {
        throw new TypeError('Negotiator: tuning knobs must be positive finite numbers');
      }
    }
    const base = deps.baseDemandLen ?? DEFAULT_BASE_DEMAND_LEN;
    const max = deps.maxDemandLen ?? DEFAULT_MAX_DEMAND_LEN;
    this.deps = {
      id: deps.id,
      seed: deps.seed >>> 0 || 0x9e3779b9,
      itemId: deps.itemId,
      host,
      baseDemandLen: Math.max(1, Math.floor(base)),
      maxDemandLen: Math.max(Math.max(1, Math.floor(base)), Math.floor(max)),
      passageSeconds: deps.passageSeconds ?? DEFAULT_PASSAGE_SECONDS,
    };
  }

  // -- queries ----------------------------------------------------------------

  /** Current lifecycle phase. */
  get status(): NegotiatorStatus {
    return {
      phase: this.phase,
      demandLen: this.demand.length || this.nextDemandLength(),
      progressIndex: this.progressIndex,
      tradesCompleted: this.tradesCompleted,
      hysteresisActive: this.hysteresisRemainingSec > 0,
      hysteresisRemainingSec: this.hysteresisRemainingSec,
      passageActive: this.passageRemainingSec > 0,
      passageRemainingSec: this.passageRemainingSec,
    };
  }

  /** The live demand sequence; empty while idle. */
  get currentDemand(): readonly Gesture[] {
    return this.demand;
  }

  /** Number of accepted trades so far (drives escalation). */
  get completedTrades(): number {
    return this.tradesCompleted;
  }

  // -- commands -----------------------------------------------------------------

  /**
   * Present the next seeded demand sequence. Throws when a demand is already
   * on the table — close one out (or let it be answered) before re-opening.
   */
  beginTrade(): readonly Gesture[] {
    if (this.phase === 'demanding') {
      throw new Error(`Negotiator ${this.deps.id}: trade already in progress`);
    }
    this.demand = this.rollDemand(this.tradesCompleted);
    this.progressIndex = 0;
    this.phase = 'demanding';
    return this.demand;
  }

  /**
   * Answer the active demand with one gesture. Unknown gesture names throw.
   * While hysteresis is active the input is swallowed whole (no progress,
   * no re-arm). On a full match the trade settles immediately: with the
   * offered item in hand it is accepted (item consumed, passage opened,
   * escalation advanced); without one the demand restarts from zero.
   */
  respond(gesture: Gesture | string): RespondResult {
    if (!isGesture(gesture)) {
      throw new TypeError(`Negotiator: unknown gesture "${String(gesture)}"`);
    }
    if (this.phase !== 'demanding') {
      return { ...this.status, counted: false, accepted: false, missingOffer: false, wrongGesture: false };
    }
    if (this.hysteresisRemainingSec > 0) {
      return { ...this.status, counted: false, accepted: false, missingOffer: false, wrongGesture: false };
    }
    const wanted = this.demand[this.progressIndex]!;
    if (gesture !== wanted) {
      this.hysteresisRemainingSec = HYSTERESIS_SECONDS;
      this.progressIndex = 0;
      return { ...this.status, counted: true, accepted: false, missingOffer: false, wrongGesture: true };
    }
    this.progressIndex++;
    if (this.progressIndex < this.demand.length) {
      return { ...this.status, counted: true, accepted: false, missingOffer: false, wrongGesture: false };
    }
    // Sequence matched — settle against the offer seam.
    if (!this.deps.host.hasOffer(this.deps.itemId)) {
      this.progressIndex = 0;
      return { ...this.status, counted: true, accepted: false, missingOffer: true, wrongGesture: false };
    }
    this.deps.host.takeOffer(this.deps.itemId);
    this.deps.host.openPassage(this.deps.id, this.deps.passageSeconds);
    this.passageRemainingSec = this.deps.passageSeconds;
    this.tradesCompleted++;
    this.demand = [];
    this.progressIndex = 0;
    this.phase = 'idle';
    return { ...this.status, counted: true, accepted: true, missingOffer: false, wrongGesture: false };
  }

  /**
   * Advance simulation time by `dt` seconds: drains the wrong-answer
   * hysteresis and the passage window. Hostile dt throws.
   */
  advance(dt: number): NegotiatorStatus {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new TypeError(`Negotiator: dt must be finite and non-negative, got ${dt}`);
    }
    if (this.hysteresisRemainingSec > 0) {
      this.hysteresisRemainingSec = clampMin0(this.hysteresisRemainingSec - dt);
    }
    if (this.passageRemainingSec > 0) {
      // Expiry only drains the local mirror of the window; the host owns the
      // real flag from the openPassage grant and needs no second call.
      this.passageRemainingSec = clampMin0(this.passageRemainingSec - dt);
    }
    return this.status;
  }

  // -- persistence ---------------------------------------------------------------

  /** Plain JSON snapshot of per-negotiator memory. */
  serialize(): NegotiatorSaveData {
    return {
      version: SAVE_VERSION,
      id: this.deps.id,
      tradesCompleted: this.tradesCompleted,
      phase: this.phase,
      demand: [...this.demand],
      progressIndex: this.progressIndex,
      hysteresisRemainingSec: this.hysteresisRemainingSec,
      passageRemainingSec: this.passageRemainingSec,
    };
  }

  /**
   * Rebuild a negotiator from serialize() output against fresh deps. Demand
   * sequences are ordinal-hashed (not streamed), so the restored machine
   * rolls identical futures without carrying RNG state. Corrupt data throws.
   */
  static restore(data: NegotiatorSaveData, deps: NegotiatorDeps): Negotiator {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Negotiator.restore: save data object required');
    }
    if (data.version !== SAVE_VERSION) {
      throw new TypeError(`Negotiator.restore: unsupported save version ${String((data as { version?: unknown }).version)}`);
    }
    if (typeof data.id !== 'string' || data.id.length === 0) {
      throw new TypeError('Negotiator.restore: id must be a non-empty string');
    }
    if (data.phase !== 'idle' && data.phase !== 'demanding') {
      throw new TypeError(`Negotiator.restore: bad phase ${String(data.phase)}`);
    }
    if (!Array.isArray(data.demand) || !data.demand.every(isGesture)) {
      throw new TypeError('Negotiator.restore: demand must be an array of catalog gestures');
    }
    for (const num of [data.tradesCompleted, data.progressIndex, data.hysteresisRemainingSec, data.passageRemainingSec]) {
      if (!Number.isFinite(num) || num < 0) {
        throw new TypeError('Negotiator.restore: counters must be finite and non-negative');
      }
    }
    const n = new Negotiator(deps);
    if (deps.id !== data.id) {
      throw new TypeError(`Negotiator.restore: id mismatch (save ${data.id}, deps ${deps.id})`);
    }
    if (data.phase === 'demanding' && data.demand.length === 0) {
      throw new TypeError('Negotiator.restore: demanding phase requires a live demand');
    }
    n.tradesCompleted = Math.floor(data.tradesCompleted);
    n.phase = data.phase;
    n.demand = [...data.demand];
    n.progressIndex = Math.min(Math.floor(data.progressIndex), n.demand.length);
    n.hysteresisRemainingSec = data.hysteresisRemainingSec;
    n.passageRemainingSec = data.passageRemainingSec;
    return n;
  }

  // -- internals -----------------------------------------------------------------

  /** Next demand length after `trades` completions (escalation, bounded). */
  private nextDemandLength(): number {
    return demandLengthFor(this.tradesCompleted, this.deps.baseDemandLen, this.deps.maxDemandLen);
  }

  /**
   * Roll the demand sequence for trade ordinal `ordinal` purely from
   * (seed, id, ordinal) so restores never need RNG state.
   */
  private rollDemand(ordinal: number): Gesture[] {
    const len = this.nextDemandLength();
    const idHash = hash4i(this.deps.seed, ordinal + 1, this.deps.id.length, HASH_SALT);
    const rng = new RNG(idHash ^ (this.deps.seed >>> 3));
    const out: Gesture[] = [];
    for (let i = 0; i < len; i++) out.push(rng.pick(GESTURES));
    return out;
  }
}
