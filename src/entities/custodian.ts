/**
 * F32 The Custodian — entity behavior layer over the overnight removal pass
 * in src/story/custodian.ts.
 *
 * The pass model is headless and injected-ledger driven; this layer owns the
 * live ledger the world feeds: every wall scrawl a loaded chunk exposes is
 * registered here as a removable marking under a position-stable id (the
 * same key ChunkManager.removedGraffiti filters builds by, so an erased
 * scrawl stays gone across rebuilds and sessions). Player-applied markings
 * join through applyPlayerMarking() with a newer appliedSession, and the
 * oldest-first rule makes the Custodian work through the building's own
 * residue before it touches anything the player left.
 *
 * The caller drives the cycle: beginNight() when the day cycle enters its
 * night stretch, update(dt) per frame while it lasts, then drainSqueaks()
 * (cart-approach audio cues) and drainRemovals() (world mutations: mark
 * ChunkManager.removedGraffiti, rebuild the chunk). serialize()/restore()
 * round-trip the removal ledger through the save slot so erasures survive
 * session boundaries.
 *
 * Pure logic — no DOM, no Babylon. All schedule draws stay inside the
 * story-pass RNG (src/core/rng.ts law).
 */
import { Custodian, type CartSqueakEvent, type CustodianConfig, type CustodianSnapshot, type Marking, type RemovalRecord } from '../story/custodian';

/** One world scrawl offered for registration (chunk-local graffiti hit). */
export interface GraffitiHit {
  cx: number;
  cz: number;
  x: number;
  z: number;
}

/**
 * Position-stable marking id for one graffiti hit: 'cx,cz:x100:z100'.
 * Identical to the ChunkManager.removedGraffiti key format, so callers can
 * feed drained removals straight into the build filter.
 */
export function graffitiMarkingId(hit: GraffitiHit): string {
  return hit.cx + ',' + hit.cz + ':' + Math.round(hit.x * 100) + ':' + Math.round(hit.z * 100);
}

/** Parse one graffiti marking id back to its chunk and world position. */
export function parseGraffitiMarkingId(id: string): GraffitiHit | null {
  const m = /^(-?\d+),(-?\d+):(-?\d+):(-?\d+)$/.exec(id);
  if (!m) return null;
  return { cx: Number(m[1]), cz: Number(m[2]), x: Number(m[3]) / 100, z: Number(m[4]) / 100 };
}

/** JSON-safe persistent state of one wiring (save-slot payload). */
export interface CustodianWiringSnapshot {
  version: 1;
  /** Highest night ordinal begun so far; the next night continues from it. */
  nights: number;
  /** Every removal ever recorded, in removal order. */
  removals: RemovalRecord[];
}

/**
 * World-facing Custodian behavior. Owns the marking ledger and the pass;
 * consumers observe it only through the drain/serialize methods.
 */
export class CustodianWiring {
  private readonly markings: Marking[] = [];
  private readonly knownIds = new Set<string>();
  // Not readonly: restore() swaps in a deserialized pass (same class body).
  private pass: Custodian;
  private ledgerSeen = 0;
  private nights = -1;

  constructor(passConfig?: CustodianConfig) {
    this.pass = new Custodian(this.markings, passConfig);
  }

  /** The open night ordinal (-1 before the first beginNight). */
  get currentNight(): number {
    return this.pass.currentNight;
  }

  /** Highest night ordinal begun so far; the next night continues past it. */
  get nightCount(): number {
    return Math.max(0, this.nights);
  }

  /**
   * Register loaded-chunk graffiti as removable markings. Already-known ids
   * are skipped, so feeding every frame's layout set is cheap. Applied as
   * authored residue (appliedSession 0): older than any player marking.
   * @returns How many markings were newly registered.
   */
  registerGraffiti(hits: readonly GraffitiHit[]): number {
    let added = 0;
    for (const h of hits) {
      const id = graffitiMarkingId(h);
      if (this.knownIds.has(id)) continue;
      this.knownIds.add(id);
      this.markings.push({ id, chunkKey: h.cx + ',' + h.cz, appliedSession: 0, kind: 'graffiti' });
      added++;
    }
    return added;
  }

  /**
   * Record a player-applied marking (id + chunk key as in Marking). Player
   * marks carry appliedSession 1, so the oldest-first pass clears the
   * building's own residue first.
   */
  applyPlayerMarking(id: string, chunkKey: string, kind: Marking['kind'] = 'graffiti'): void {
    if (this.knownIds.has(id)) return;
    this.knownIds.add(id);
    this.markings.push({ id, chunkKey, appliedSession: 1, kind });
  }

  /**
   * Begin the overnight pass for a night ordinal. Re-beginning the open
   * ordinal is a no-op (the pass never rewinds a running night).
   */
  beginNight(nightOrdinal: number): void {
    if (nightOrdinal > this.nights) this.nights = nightOrdinal;
    this.pass.beginNight(nightOrdinal);
  }

  /** Advance the open night one frame (squeak cues + due removals). */
  update(dt: number): void {
    this.pass.update(dt);
  }

  /** Consume queued cart-squeak cues (audio consumer calls once per frame). */
  drainSqueaks(): CartSqueakEvent[] {
    return this.pass.drainSqueaks();
  }

  /**
   * Consume removals recorded since the previous call, oldest first. For
   * every entry the caller marks ChunkManager.removedGraffiti and rebuilds
   * the chunk so the scrawl vanishes from the live scene.
   */
  drainRemovals(): RemovalRecord[] {
    const all = this.pass.removals;
    if (all.length === this.ledgerSeen) return [];
    const out = all.slice(this.ledgerSeen);
    this.ledgerSeen = all.length;
    return out;
  }

  /** Full removal ledger (audit/query surface; AC: removal ledger test). */
  get removalLedger(): readonly RemovalRecord[] {
    return this.pass.removals;
  }

  /** Full squeak log across all nights (audit trail). */
  get squeakLog(): readonly CartSqueakEvent[] {
    return this.pass.squeaks;
  }

  /** JSON-safe snapshot for the save slot. */
  serialize(): CustodianWiringSnapshot {
    return JSON.parse(JSON.stringify({ version: 1 as const, nights: Math.max(0, this.nights), removals: this.pass.removals }));
  }

  /**
   * Rebuild a wiring from a save-slot payload: the full removal ledger
   * carries over and the next beginNight() continues past the stored
   * ordinal. Returns null for any structurally invalid payload.
   */
  static restore(raw: unknown, passConfig?: CustodianConfig): CustodianWiring | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = raw as Partial<CustodianWiringSnapshot> & { removals?: unknown };
    if (v.version !== 1 || typeof v.nights !== 'number' || !Array.isArray(v.removals)) return null;
    // Rebuild the pass through its own strict deserializer and adopt it:
    // the slot stores removal records only, so the squeak log restarts
    // empty (auditable history resumes with the next night rather than
    // failing the load). Removed markings stay out of the live ledger —
    // they only occupy knownIds so a re-registration cannot resurrect them.
    const snap: CustodianSnapshot = { version: 1, nightOrdinal: -1, nightClock: 0, removals: v.removals as RemovalRecord[], squeaks: [] };
    const probeMarkings: Marking[] = [];
    const pass = Custodian.deserialize(snap, probeMarkings, passConfig);
    if (!pass) return null;
    const wiring = new CustodianWiring(passConfig);
    wiring.pass = pass;
    for (const r of pass.removals) wiring.knownIds.add(r.markingId);
    wiring.nights = Math.max(0, Math.floor(v.nights));
    wiring.ledgerSeen = pass.removals.length;
    return wiring;
  }
}