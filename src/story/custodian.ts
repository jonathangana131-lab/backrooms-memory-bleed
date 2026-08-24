/**
 * The Custodian (F32): removes player graffiti/markings overnight, and a
 * cart squeak always precedes the removals.
 *
 * Pure overnight-pass model over an INJECTED markings ledger (the array the
 * caller owns — game.ts feeds its live marking list; this module never
 * imports engine or world code). Each night cycle:
 *  1. `beginNight(ordinal)` plans a bounded number of removals from the
 *     OLDEST markings first (by appliedSession, id tie-break), skipping any
 *     protected kind. The plan is drawn from src/core/rng.ts hashes of
 *     (seed, sessionOrdinal, nightOrdinal), so identical inputs replay
 *     identically.
 *  2. `update(dt)` advances the night clock. Every scheduled removal whose
 *     lead window has opened emits a 'cartSqueak' event
 *     CUSTODIAN_SQUEAK_LEAD_SECONDS ahead of its removal time — audio/UI
 *     consumers drain those events and hear the cart approaching the wall.
 *     Squeaks are evaluated before removals each frame, so a cue can never
 *     land after its removal, even under a frame that skips seconds.
 *  3. At the removal moment the marking is spliced out of the injected
 *     ledger and appended to a queryable removal ledger ({what, when}).
 *
 * All state is behind methods: callers observe the pass only through
 * drainSqueaks(), the removals/squeaks ledgers, and serialize() — never by
 * reaching into scheduling internals.
 *
 * serialize()/deserialize() round-trip the removal ledger and squeak log so
 * completeness survives session boundaries.
 */
import { RNG, hash2i } from '../core/rng';

/** Kinds of markings players can leave on surfaces. */
export type MarkingKind = 'graffiti' | 'smear' | 'stencil' | 'memorial';

/** One marking in the injected ledger. */
export interface Marking {
  /** Stable unique id within the ledger. */
  id: string;
  /** Chunk the marking lives in ('cx,cz', same format as ChunkDeltas.key). */
  chunkKey: string;
  /** Session ordinal that applied the marking; lower = older. */
  appliedSession: number;
  /** What was left behind. */
  kind: MarkingKind;
}

/** Kinds the Custodian will never remove (memorials are left standing). */
export const PROTECTED_MARKING_KINDS: readonly MarkingKind[] = ['memorial'];

/** Seconds between each cart-squeak cue and its removal moment. */
export const CUSTODIAN_SQUEAK_LEAD_SECONDS = 8;

/** Maximum markings removed during one night cycle. */
export const CUSTODIAN_REMOVALS_PER_NIGHT = 3;

/** Salt isolating Custodian schedule draws from every other hash use. */
const CUSTODIAN_SALT = 0x6d3a;

/**
 * Pre-removal cart-squeak cue. Emitted exactly once per scheduled removal,
 * CUSTODIAN_SQUEAK_LEAD_SECONDS before the removal fires.
 */
export interface CartSqueakEvent {
  /** Marking whose removal the cart is approaching. */
  markingId: string;
  /** Chunk the cart is heading toward. */
  chunkKey: string;
  /** Night ordinal the cue belongs to. */
  nightOrdinal: number;
  /** Night-clock time of the squeak itself (seconds since beginNight). */
  atNightTime: number;
  /** Lead time to the removal moment (== CUSTODIAN_SQUEAK_LEAD_SECONDS). */
  leadSeconds: number;
}

/** One entry of the queryable removal ledger. */
export interface RemovalRecord {
  /** Marking that was removed. */
  markingId: string;
  /** Chunk the marking lived in. */
  chunkKey: string;
  /** Night ordinal during which the removal happened. */
  nightOrdinal: number;
  /** Night-clock time of the removal (seconds since beginNight). */
  removedAtNightTime: number;
  /** Snapshot of the removed marking's kind and age for audit queries. */
  kind: MarkingKind;
  appliedSession: number;
}

/** One planned removal; internal — visible to consumers only through events. */
interface PlannedRemoval {
  readonly markingId: string;
  readonly chunkKey: string;
  readonly kind: MarkingKind;
  readonly appliedSession: number;
  readonly removalTime: number;
}

/** Serialized Custodian state; JSON-safe by construction. */
export interface CustodianSnapshot {
  version: 1;
  nightOrdinal: number;
  nightClock: number;
  removals: RemovalRecord[];
  squeaks: CartSqueakEvent[];
}

function isProtected(kind: MarkingKind): boolean {
  return PROTECTED_MARKING_KINDS.includes(kind);
}

/**
 * Overnight Custodian pass. Feed update() once per frame while a night
 * cycle runs; drain squeak events for audio cues and read the removal
 * ledger for audits/tests.
 */
export class Custodian {
  private readonly seed: number;
  private readonly sessionOrdinal: number;
  private readonly bound: number;
  private readonly leadSeconds: number;

  /** Injected live marking ledger — mutated in place on removals. */
  private readonly markings: Marking[];

  private nightOrdinalValue = -1;
  private nightClock = 0;
  /** Immutable plan for the open night, sorted by removal time. */
  private plan: readonly PlannedRemoval[] = [];
  private nextSqueak = 0;
  private nextRemoval = 0;
  private readonly removalsLedger: RemovalRecord[] = [];
  private readonly squeakLog: CartSqueakEvent[] = [];
  private pendingSqueaks: CartSqueakEvent[] = [];

  constructor(
    markings: Marking[],
    config?: CustodianConfig,
  ) {
    this.markings = Array.isArray(markings) ? markings : [];
    this.seed = Number.isFinite(config?.seed) ? (config!.seed! >>> 0) : 0x9e3779b9;
    this.sessionOrdinal = Number.isFinite(config?.sessionOrdinal)
      ? Math.max(0, Math.floor(config!.sessionOrdinal!))
      : 0;
    this.bound =
      Number.isFinite(config?.removalsPerNight) && config!.removalsPerNight! >= 0
        ? Math.floor(config!.removalsPerNight!)
        : CUSTODIAN_REMOVALS_PER_NIGHT;
    this.leadSeconds =
      Number.isFinite(config?.squeakLeadSeconds) && config!.squeakLeadSeconds! >= 0
        ? config!.squeakLeadSeconds!
        : CUSTODIAN_SQUEAK_LEAD_SECONDS;
  }

  /**
   * Begin a night cycle. Plans the whole night deterministically: eligible
   * (non-protected) markings sorted oldest-first, bounded count, removal
   * times drawn from (seed, sessionOrdinal, nightOrdinal). Beginning the
   * already-open ordinal is a no-op — the pass never rewinds a running
   * night or its audit trail; to replay a night, rebuild the instance
   * (constructor or deserialize).
   * @param nightOrdinal Index of this night within the run.
   */
  beginNight(nightOrdinal: number): void {
    if (!Number.isFinite(nightOrdinal)) return;
    const ordinal = Math.max(0, Math.floor(nightOrdinal));
    if (ordinal === this.nightOrdinalValue) return;
    this.nightOrdinalValue = ordinal;
    this.nightClock = 0;
    this.pendingSqueaks = [];

    const rr = new RNG(hash2i(this.sessionOrdinal, ordinal, this.seed ^ CUSTODIAN_SALT));
    const eligible = this.markings
      .filter((m) => !isProtected(m.kind))
      .sort((a, b) =>
        a.appliedSession !== b.appliedSession
          ? a.appliedSession - b.appliedSession
          : a.id < b.id ? -1 : 1,
      );

    // Removals land inside a bounded window that always leaves room for the
    // full lead time, so a squeak can never be clipped by the night start.
    const windowStart = this.leadSeconds + 1;
    const windowSpan = Math.max(30, this.bound * 20);
    const chosen: PlannedRemoval[] = [];
    for (let i = 0; i < this.bound && i < eligible.length; i++) {
      const m = eligible[i];
      chosen.push({
        markingId: m.id,
        chunkKey: m.chunkKey,
        kind: m.kind,
        appliedSession: m.appliedSession,
        removalTime: windowStart + rr.next() * windowSpan,
      });
    }
    chosen.sort((a, b) => a.removalTime - b.removalTime);
    this.plan = chosen;
    this.nextSqueak = 0;
    this.nextRemoval = 0;
  }

  /**
   * Advance the night clock one frame, emitting due squeak cues and firing
   * due removals against the injected ledger. Squeaks are emitted before
   * removals, in schedule order, so every removal is preceded by its cue.
   * @param dt frame delta in seconds (non-finite/negative treated as 0)
   */
  update(dt: number): void {
    if (this.nightOrdinalValue < 0 || this.plan.length === 0) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.nightClock += step;

    while (
      this.nextSqueak < this.plan.length &&
      this.plan[this.nextSqueak].removalTime - this.nightClock <= this.leadSeconds
    ) {
      const p = this.plan[this.nextSqueak++];
      const squeak: CartSqueakEvent = {
        markingId: p.markingId,
        chunkKey: p.chunkKey,
        nightOrdinal: this.nightOrdinalValue,
        atNightTime: this.nightClock,
        leadSeconds: this.leadSeconds,
      };
      this.pendingSqueaks.push(squeak);
      this.squeakLog.push(squeak);
    }

    while (
      this.nextRemoval < this.plan.length &&
      this.nightClock >= this.plan[this.nextRemoval].removalTime
    ) {
      const p = this.plan[this.nextRemoval++];
      const index = this.markings.findIndex((m) => m.id === p.markingId);
      if (index === -1) continue; // caller already removed it; nothing left to record
      this.markings.splice(index, 1);
      this.removalsLedger.push({
        markingId: p.markingId,
        chunkKey: p.chunkKey,
        nightOrdinal: this.nightOrdinalValue,
        removedAtNightTime: this.nightClock,
        kind: p.kind,
        appliedSession: p.appliedSession,
      });
    }
  }

  /**
   * Consume queued cart-squeak events (audio consumers call this once per
   * frame); returned events are removed from the queue but stay in the log.
   */
  drainSqueaks(): CartSqueakEvent[] {
    const out = this.pendingSqueaks;
    this.pendingSqueaks = [];
    return out;
  }

  /**
   * Queryable removal ledger: every marking this Custodian has ever removed,
   * in removal order. Every entry had its lead squeak fire first.
   */
  get removals(): readonly RemovalRecord[] {
    return this.removalsLedger;
  }

  /** Full squeak log across all nights (audit trail). */
  get squeaks(): readonly CartSqueakEvent[] {
    return this.squeakLog;
  }

  /** Currently open night ordinal (-1 before beginNight). */
  get currentNight(): number {
    return this.nightOrdinalValue;
  }

  /** JSON-safe snapshot of the Custodian's persistent state. */
  serialize(): CustodianSnapshot {
    return JSON.parse(JSON.stringify({
      version: 1 as const,
      nightOrdinal: this.nightOrdinalValue,
      nightClock: this.nightClock,
      removals: this.removalsLedger,
      squeaks: this.squeakLog,
    }));
  }

  /**
   * Rebuild a Custodian from a snapshot produced by serialize(). The
   * restored instance carries the full removal + squeak ledgers (completeness
   * survives session boundaries) with no open night — callers call
   * beginNight() again to resume scheduling.
   * @returns The rebuilt instance, or null for any payload that is not a
   *   structurally valid v1 snapshot.
   */
  static deserialize(
    snapshot: unknown,
    markings: Marking[],
    config?: CustodianConfig,
  ): Custodian | null {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const v = snapshot as Partial<CustodianSnapshot>;
    if (v.version !== 1) return null;
    if (!Array.isArray(v.removals) || !Array.isArray(v.squeaks)) return null;
    for (const r of v.removals) {
      if (!r || typeof r.markingId !== 'string' || typeof r.chunkKey !== 'string' ||
          typeof r.removedAtNightTime !== 'number') return null;
    }
    for (const s of v.squeaks) {
      if (!s || typeof s.markingId !== 'string' || typeof s.atNightTime !== 'number') return null;
    }
    return new Custodian(markings, config).withLedgers(
      v.removals.map((r) => ({ ...r })),
      v.squeaks.map((s) => ({ ...s })),
    );
  }

  /** Restore restored ledgers without exposing them beyond the class body. */
  private withLedgers(
    removals: RemovalRecord[],
    squeaks: CartSqueakEvent[],
  ): this {
    this.removalsLedger.push(...removals);
    this.squeakLog.push(...squeaks);
    return this;
  }
}

/** Optional construction parameters; every field has a default. */
export interface CustodianConfig {
  /** Deterministic seed for schedule draws (src/core/rng.ts law). */
  seed?: number;
  /** Session ordinal the pass runs in; part of the schedule key. */
  sessionOrdinal?: number;
  /** Max removals per night (default CUSTODIAN_REMOVALS_PER_NIGHT). */
  removalsPerNight?: number;
  /** Lead time between squeak and removal (default CUSTODIAN_SQUEAK_LEAD_SECONDS). */
  squeakLeadSeconds?: number;
}
