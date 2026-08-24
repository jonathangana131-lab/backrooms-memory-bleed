/**
 * F65 Child drawings — appear near playgrounds depicting events YOU caused.
 *
 * Small crayon scribbles are pinned near playground landmarks, and every
 * single one depicts a real entry from the injected player-events ledger —
 * never a fabricated event. An event grounds at a playground when its
 * resolved world position falls within link radius of that playground; each
 * grounding event becomes exactly one drawing (1:1, kind + siteKey
 * provenance preserved) up to a per-playground cap. Density therefore scales
 * with local event count until the cap. No events means no drawings,
 * anywhere.
 *
 * Guarantees (the AC):
 *   - every generated drawing maps 1:1 to a real ledger event: sceneKind is
 *     the event's kind and the event's siteKey rides along as provenance;
 *   - an empty ledger produces zero drawings;
 *   - drawings spawn only inside scatter radius of a playground center;
 *   - density scales with local event count up to MAX_PER_PLAYGROUND;
 *   - deterministic per (seed, ledger, playgrounds);
 *   - generated drawings survive serialize()/restore() identically;
 *   - junk injections fail loud.
 *
 * Pure simulation/descriptor module — no DOM, no Babylon; consumers render
 * the descriptor however they like. Determinism law holds: all draws flow
 * through src/core/rng.ts hashes.
 */
import { RNG, hash4i, seedFromString } from '../core/rng';

// ---- injected player-events ledger ----------------------------------------------

/** Every event kind a child may depict; canonical order for stable sorting. */
export const EVENT_KINDS = ['relocation', 'blackout', 'beacon-found', 'entity-fled'] as const;

/** Kind of player-caused event the drawings ground in. */
export type PlayerEventKind = (typeof EVENT_KINDS)[number];

/** One recorded player-caused event (injected read-only view). */
export interface PlayerEventEntry {
  readonly kind: PlayerEventKind;
  /** Stable site identifier of where the event happened. */
  readonly siteKey: string;
  /** Session time of the event in seconds. */
  readonly whenSec: number;
}

/** A playground landmark drawings may cluster around. */
export interface PlaygroundSite {
  readonly key: string;
  readonly x: number;
  readonly z: number;
}

/** Resolves a ledger siteKey to world position; null when unknown. */
export type SiteResolver = (siteKey: string) => { x: number; z: number } | null;

/** Constructor dependencies. */
export interface ChildDrawingsDeps {
  /** Session seed steering scribble seeds, scatter, and captions. */
  readonly seed: number;
  /** The player-events ledger; entries are grounded, never invented. */
  readonly events: readonly PlayerEventEntry[];
  /** Playground landmark positions. */
  readonly playgrounds: readonly PlaygroundSite[];
  /** siteKey → world position seam owned by the mounting system. */
  readonly resolveSite: SiteResolver;
}

// ---- tuning -------------------------------------------------------------------

/** Events farther than this from every playground never become drawings (m). */
export const LINK_RADIUS_M = 20;

/** Drawing centers stay within this radius of their playground center (m). */
export const SCATTER_RADIUS_M = 3;

/** Hard ceiling on drawings per playground. */
export const MAX_PER_PLAYGROUND = 5;

/** Salt separating this system's hash stream from other rng.ts consumers. */
const HASH_SALT = 0x63686472; // "chdr"

/** Save format version for serialize()/restore(). */
const SAVE_VERSION = 1;

// ---- descriptors ----------------------------------------------------------------

/** One crayon-style drawing descriptor; consumers render from these fields. */
export interface ChildDrawing {
  /** Stable drawing id derived from playground + event ordinal. */
  readonly id: string;
  /** Playground this drawing hangs near. */
  readonly playgroundKey: string;
  /** Event kind depicted — always copied from a real ledger entry. */
  readonly sceneKind: PlayerEventKind;
  /** Provenance: the depicted event's siteKey, verbatim. */
  readonly sourceSiteKey: string;
  /** Session time of the depicted event, verbatim. */
  readonly whenSec: number;
  /** Deterministic seed for the consumer's crayon renderer. */
  readonly scribbleSeed: number;
  /** World position within SCATTER_RADIUS_M of the playground center. */
  readonly x: number;
  readonly z: number;
  /** Short seeded caption fragment describing the scene. */
  readonly captionFragment: string;
}

/** Plain JSON snapshot produced by serialize(); round-trips via restore(). */
export interface ChildDrawingsSaveData {
  version: number;
  seed: number;
  drawings: ChildDrawing[];
}

// ---- captions --------------------------------------------------------------------

/** Caption fragment pools, one per depicted event kind. */
const CAPTIONS: Record<PlayerEventKind, readonly string[]> = {
  relocation: ['the room moved again', 'our house walked away', 'walls changed while we slept'],
  blackout: ['the dark ate the hallway', 'everyone went quiet at once', 'the lights forgot us'],
  'beacon-found': ['she found the humming light', 'the singing box was warm', 'we followed the glow home'],
  'entity-fled': ['the tall thing ran away', 'it got scared of us', 'the long arms gave up'],
};

// ---- helpers -----------------------------------------------------------------------

function isFinitePos(p: { x: number; z: number } | null | undefined): p is { x: number; z: number } {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.z);
}

/** Squared distance between two world points. */
function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

// ---- generator ------------------------------------------------------------------------

/**
 * Grounds the injected player-events ledger into playground drawings. Create
 * one per session; call {@link ChildDrawings.drawings} whenever the world
 * needs the current set (cached after first generation).
 */
export class ChildDrawings {
  private readonly deps: ChildDrawingsDeps;
  private cache: ChildDrawing[] | null = null;

  constructor(deps: ChildDrawingsDeps) {
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('ChildDrawings: deps object required');
    }
    if (!Number.isFinite(deps.seed)) {
      throw new TypeError('ChildDrawings: seed must be a finite number');
    }
    if (!Array.isArray(deps.events)) {
      throw new TypeError('ChildDrawings: events must be an array');
    }
    for (const e of deps.events) {
      if (!e || typeof e !== 'object') throw new TypeError('ChildDrawings: ledger entry required');
      if (!(EVENT_KINDS as readonly string[]).includes(e.kind)) {
        throw new TypeError(`ChildDrawings: unknown event kind ${String(e.kind)}`);
      }
      if (typeof e.siteKey !== 'string' || e.siteKey.length === 0) {
        throw new TypeError('ChildDrawings: siteKey must be a non-empty string');
      }
      if (!Number.isFinite(e.whenSec)) {
        throw new TypeError('ChildDrawings: whenSec must be finite');
      }
    }
    if (!Array.isArray(deps.playgrounds)) {
      throw new TypeError('ChildDrawings: playgrounds must be an array');
    }
    const seen = new Set<string>();
    for (const p of deps.playgrounds) {
      if (!p || typeof p !== 'object' || typeof p.key !== 'string' || p.key.length === 0) {
        throw new TypeError('ChildDrawings: playground key must be a non-empty string');
      }
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
        throw new TypeError('ChildDrawings: playground position must be finite');
      }
      if (seen.has(p.key)) {
        throw new TypeError(`ChildDrawings: duplicate playground key ${p.key}`);
      }
      seen.add(p.key);
    }
    if (typeof deps.resolveSite !== 'function') {
      throw new TypeError('ChildDrawings: resolveSite must be a function');
    }
    this.deps = { ...deps, seed: deps.seed >>> 0 || 0x9e3779b9 };
  }

  /**
   * All drawings for the session: real ledger events grounded near
   * playgrounds, capped per playground, deterministic per inputs. Cached
   * after the first call.
   */
  get drawings(): readonly ChildDrawing[] {
    if (this.cache === null) this.cache = this.generate();
    return this.cache;
  }

  /** Plain JSON snapshot of the generated set. */
  serialize(): ChildDrawingsSaveData {
    return { version: SAVE_VERSION, seed: this.deps.seed, drawings: [...this.drawings] };
  }

  /**
   * Rebuild from serialize() output. The persisted drawing list replaces
   * generation wholesale (a restored session replays its saved evidence),
   * so corrupt data throws rather than silently regenerating.
   */
  static restore(data: ChildDrawingsSaveData): ChildDrawings {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('ChildDrawings.restore: save data object required');
    }
    if (data.version !== SAVE_VERSION) {
      throw new TypeError(`ChildDrawings.restore: unsupported save version ${String((data as { version?: unknown }).version)}`);
    }
    if (!Number.isFinite(data.seed)) {
      throw new TypeError('ChildDrawings.restore: seed must be finite');
    }
    if (!Array.isArray(data.drawings)) {
      throw new TypeError('ChildDrawings.restore: drawings must be an array');
    }
    for (const d of data.drawings) {
      if (!d || typeof d !== 'object' ||
          typeof d.id !== 'string' ||
          typeof d.playgroundKey !== 'string' ||
          !(EVENT_KINDS as readonly string[]).includes(d.sceneKind) ||
          typeof d.sourceSiteKey !== 'string' ||
          !Number.isFinite(d.whenSec) ||
          !Number.isFinite(d.scribbleSeed) ||
          !Number.isFinite(d.x) || !Number.isFinite(d.z) ||
          typeof d.captionFragment !== 'string') {
        throw new TypeError('ChildDrawings.restore: malformed drawing descriptor');
      }
    }
    // Deps are irrelevant to a fully persisted set; resolveSite validates as
    // junk-free but never runs because the cache is pre-seeded.
    const out = new ChildDrawings({
      seed: data.seed,
      events: [],
      playgrounds: [],
      resolveSite: () => null,
    });
    out.cache = data.drawings.map((d) => ({ ...d }));
    return out;
  }

  // -- internals -----------------------------------------------------------------

  /** Ground ledger events to playgrounds and roll one drawing per match. */
  private generate(): ChildDrawing[] {
    if (this.deps.events.length === 0 || this.deps.playgrounds.length === 0) return [];
    const out: ChildDrawing[] = [];
    for (const pg of this.deps.playgrounds) {
      // Ledger events whose resolved position links to THIS playground,
      // ordered deterministically (time, then siteKey, then kind).
      const linked: Array<{ e: PlayerEventEntry; ex: number; ez: number }> = [];
      for (const e of this.deps.events) {
        const pos = this.deps.resolveSite(e.siteKey);
        if (!isFinitePos(pos)) continue;
        if (dist2(pos.x, pos.z, pg.x, pg.z) <= LINK_RADIUS_M * LINK_RADIUS_M) {
          linked.push({ e, ex: pos.x, ez: pos.z });
        }
      }
      if (linked.length === 0) continue;
      linked.sort((a, b) =>
        a.e.whenSec - b.e.whenSec ||
        (a.e.siteKey < b.e.siteKey ? -1 : a.e.siteKey > b.e.siteKey ? 1 : 0) ||
        (EVENT_KINDS.indexOf(a.e.kind) - EVENT_KINDS.indexOf(b.e.kind)),
      );
      // Density scales with local event count up to the cap; 1:1 mapping.
      const take = Math.min(linked.length, MAX_PER_PLAYGROUND);
      const pgHash = seedFromString(pg.key);
      for (let i = 0; i < take; i++) {
        const { e } = linked[i]!;
        const rng = new RNG(hash4i(this.deps.seed, pgHash, i + 1, HASH_SALT));
        const ang = rng.next() * Math.PI * 2;
        const rad = Math.sqrt(rng.next()) * SCATTER_RADIUS_M;
        out.push({
          id: `childdrawing-${pg.key}-${i}`,
          playgroundKey: pg.key,
          sceneKind: e.kind,
          sourceSiteKey: e.siteKey,
          whenSec: e.whenSec,
          scribbleSeed: hash4i(this.deps.seed, pgHash, e.whenSec | 0, HASH_SALT ^ (i + 1)),
          x: pg.x + Math.cos(ang) * rad,
          z: pg.z + Math.sin(ang) * rad,
          captionFragment: CAPTIONS[e.kind][rng.int(0, CAPTIONS[e.kind].length)]!,
        });
      }
    }
    return out;
  }
}
