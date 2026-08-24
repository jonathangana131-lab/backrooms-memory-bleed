/**
 * F61 The Congregation's Hymn — choir behavior at chapel landmarks.
 *
 * When the day cycle turns toward night, the believers fill a chapel and
 * sing rounds whose lyric fragments name the player's actual discoveries.
 * Grounding follows audio/hymn.ts: an injected discovery ledger (built by
 * the caller from the journal/story feed — landmark rooms entered, beacons
 * contacted) is the ONLY source of sung names, and every line carries its
 * discovery id as provenance. An empty ledger sings wordless hums.
 *
 * The kneeling formation is reused from congregation.ts (same seat spacing
 * guarantees); service timing reuses its day-phase windows so a chapel can
 * host both the silent service and the hymn from one clock provider — the
 * same DayCycle.dayProgress() fraction the game already feeds elsewhere.
 * Lines enter on a seeded cadence while the service runs and are drained
 * by the caller for captions/voice mounting.
 *
 * Pure logic — no DOM, no Babylon, no audio graph. Every draw flows through
 * src/core/rng.ts seeded per choir.
 */
import { RNG } from '../core/rng';
import { CongregationHymn, type DiscoveryEntry, type HymnLine } from '../audio/hymn';
import { generateFormation, servicePhaseAt, type Seat, type ServicePhase } from './congregation';

// ---- tuning ------------------------------------------------------------------

/** Mean seconds between sung lines while the service is running. */
export const HYMN_LINE_INTERVAL_SEC = 5;

/** Singers mounted per chapel (rings of generateFormation fill inward first). */
export const HYMN_CHOIR_COUNT = 9;

/** Salt isolating the line-cadence stream from other seeded systems. */
const CADENCE_SALT = 0x68796d >>> 0;

/** One chapel the choir gathers in. */
export interface ChapelAnchor {
  /** Landmark name ('CHAPEL'); carried onto lines for caption routing. */
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

/**
 * One chapel's choir. Feed update(dt) per frame with the same injected
 * day-phase provider that drives the congregation service; drain the line
 * queue for captions or voice synthesis. Same seed + same ledger + same
 * phase script replay the identical hymn transcript.
 */
export class ChapelChoir {
  /** Kneeling seats around the altar, inner ring first (mount surface). */
  readonly seats: readonly Seat[];
  /** Service phase observed at the most recent update(). */
  phase: ServicePhase = 'idle';

  private readonly anchor: ChapelAnchor;
  private readonly hymn: CongregationHymn;
  private readonly rng: RNG;
  private lineTimer = HYMN_LINE_INTERVAL_SEC;
  private pending: HymnLine[] = [];

  constructor(anchor: ChapelAnchor, discoveries: readonly DiscoveryEntry[], seed: number, private readonly dayPhase: () => number) {
    this.anchor = anchor;
    this.hymn = new CongregationHymn(discoveries, seed);
    this.rng = new RNG((seed ^ CADENCE_SALT) >>> 0);
    this.seats = generateFormation(anchor.x, anchor.z, HYMN_CHOIR_COUNT, seed ^ CADENCE_SALT);
  }

  /** The chapel this choir sings in. */
  get chapel(): ChapelAnchor {
    return this.anchor;
  }

  /** True while a service is running (gathering, kneel, or disperse). */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Groundable discovery count handed to the hymn (mount/debug surface). */
  get discoveryCount(): number {
    return this.hymn.discoveryCount;
  }

  /** Seeded entry-beat offset of voice v within any round (mount surface). */
  voiceStagger(v: number): number {
    return this.hymn.voiceStagger(v);
  }

  /**
   * Advance one frame. The phase comes straight from the injected provider;
   * lines accumulate only while the service runs (gathering through kneel),
   * never while the chapel sits idle — silence outside services is part of
   * the dread.
   */
  update(dt: number): void {
    const phase = servicePhaseAt(this.dayPhase());
    this.phase = phase;
    if (phase === 'idle' || !(dt > 0)) return;
    this.lineTimer -= dt;
    if (this.lineTimer > 0) return;
    this.lineTimer = HYMN_LINE_INTERVAL_SEC * this.rng.range(0.8, 1.25);
    this.pending.push(this.hymn.nextLine());
  }

  /**
   * Consume queued sung lines (caption/audio consumer calls once per frame).
   * Returned lines keep their voice/beat provenance and grounded id.
   */
  drainLines(): HymnLine[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}