/**
 * F63 Entity funerals — processions for their own dead at erosion sites.
 *
 * When an injected reality-erosion event kills a figure, surviving
 * same-kind figures may hold a funeral: they form a column, march a seeded
 * waypoint path to the death site, pause there for a ritual of seeded
 * length inside a fixed duration band, then disperse.
 *
 * Rules enforced by this module:
 * - at most ONE procession per death site per session, including repeat
 *   deaths at the same site;
 * - participants are drawn only from the caller-supplied alive pool whose
 *   kind matches the victim - a dead kind cannot mourn itself;
 * - column spacing discipline: participants keep a fixed gap along the path,
 *   never overlapping, never overtaking;
 * - determinism: the waypoint path, ritual duration and participant draw all
 *   flow through src/core/rng.ts hashes keyed by (seed, siteKey).
 *
 * Pure logic - no DOM, no Babylon. Movement is path-arc-length based so the
 * caller renders positions each frame from advance().
 */
import { RNG, hash2i } from '../core/rng';

/** Salt so funeral draws never correlate with any other feature. */
const FUNERAL_SALT = 0xf63;

/** Waypoints between procession start area and the death site. */
export const WAYPOINT_COUNT = 5;

/** Required gap between consecutive participants along the path, metres. */
export const COLUMN_GAP_M = 1.2;

/** Minimum ritual pause at the death site, seconds. */
export const RITUAL_MIN_S = 20;

/** Maximum ritual pause at the death site, seconds. */
export const RITUAL_MAX_S = 45;

/** March speed along the path, metres/second. */
export const MARCH_SPEED_MPS = 1.4;

/**
 * Planar world position (metres, x/z ground plane).
 */
export interface Vec2 {
  /** East-west coordinate in metres. */
  readonly x: number;
  /** North-south coordinate in metres. */
  readonly z: number;
}

/**
 * One injected reality-erosion death: an erosion event killed a figure here.
 */
export interface ErosionDeathEvent {
  /** Stable death-site key; one procession max per key per session. */
  readonly siteKey: string;
  /** Where the figure died (procession destination). */
  readonly pos: Vec2;
  /** Kind/archetype of the dead figure ('human', 'fauna', ...). */
  readonly victimKind: string;
  /** Id of the dead figure (informational; not eligible as participant). */
  readonly victimId: number;
  /** Simulation second of the death. */
  readonly timeS: number;
}

/**
 * One surviving figure offered by the caller's entity tracking.
 */
export interface FuneralFigure {
  /** Stable figure id. */
  readonly id: number;
  /** Kind/archetype; must equal the victim's kind to participate. */
  readonly kind: string;
  /** Current position (used only to order the column). */
  readonly pos: Vec2;
}

/** Procession lifecycle phases. */
export type FuneralPhase = 'march' | 'ritual' | 'dispersing' | 'done';

/**
 * One scheduled funeral procession for one death site.
 */
export interface FuneralProcession {
  /** Site key this procession mourns; unique across the session. */
  readonly siteKey: string;
  /** Victim kind shared by every participant. */
  readonly kind: string;
  /** Participant figure ids, leader first, column order. */
  readonly participantIds: readonly number[];
  /** Seeded waypoint path; last waypoint is the death site itself. */
  readonly waypoints: readonly Vec2[];
  /** Seeded ritual duration in seconds within [RITUAL_MIN_S, RITUAL_MAX_S]. */
  readonly ritualDurationS: number;
}

/**
 * Live state of a procession as advanced by FuneralSystem.advance().
 */
export interface FuneralProgress {
  /** The procession being advanced. */
  readonly procession: FuneralProcession;
  /** Current phase. */
  readonly phase: FuneralPhase;
  /**
   * Arc-length position of each participant along the waypoint path
   * (metres), index-aligned with participantIds. Leader is furthest along.
   */
  readonly arcPositionsM: readonly number[];
  /** World position per participant, index-aligned with participantIds. */
  readonly positions: readonly Vec2[];
  /** Total path length in metres. */
  readonly pathLengthM: number;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Seeded waypoint path ending at the death site: WAYPOINT_COUNT approach
 * points scattered deterministically around it plus the site itself last.
 * @param seed Master run seed.
 * @param evt Death event naming the site.
 * @returns Waypoints in march order; the death site is always last.
 */
export function processionPath(seed: number, evt: ErosionDeathEvent): Vec2[] {
  const rr = new RNG(hash2i(seed, hashStr(evt.siteKey), FUNERAL_SALT));
  const pts: Vec2[] = [];
  for (let i = 0; i < WAYPOINT_COUNT - 1; i++) {
    const ang = rr.range(0, Math.PI * 2);
    const rad = rr.range(6, 18);
    pts.push({ x: evt.pos.x + Math.cos(ang) * rad, z: evt.pos.z + Math.sin(ang) * rad });
  }
  pts.push({ x: evt.pos.x, z: evt.pos.z });
  return pts;
}

/** FNV-1a so string site keys feed the integer hash law. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface InternalState {
  p: FuneralProcession;
  cum: number[];
  arcs: number[];
  phase: FuneralPhase;
  phaseClock: number;
}

/**
 * Funeral coordinator fed by injected reality-erosion deaths. Tracks the
 * one-procession-per-site ledger for the whole session and advances every
 * living procession through march -> ritual -> dispersing -> done.
 */
export class FuneralSystem {
  private readonly seed: number;
  private readonly sitesMourned = new Set<string>();
  private readonly active: InternalState[] = [];

  /**
   * @param seed Master run seed; keys paths, durations and participant draws.
   */
  constructor(seed: number) {
    this.seed = seed;
  }

  /** Site keys that already held (or hold) a procession this session. */
  get mournedSites(): readonly string[] {
    return [...this.sitesMourned];
  }

  /**
   * Ingest one erosion death and maybe schedule its funeral. A procession
   * forms only when the site has none yet AND at least MIN_PARTICIPANTS
   * alive figures share the victim's kind; otherwise the dead go unmourned.
   * Participants are drawn only from that alive same-kind pool - the victim
   * itself is excluded even if the caller lists it.
   * @param evt The death event.
   * @param alivePool Every currently alive figure the caller knows about.
   * @returns The scheduled procession, or null when unmourned.
   */
  onDeath(evt: ErosionDeathEvent, alivePool: readonly FuneralFigure[]): FuneralProcession | null {
    if (this.sitesMourned.has(evt.siteKey)) return null;
    // Mark the ledger regardless of turnout: one attempt per site, ever.
    this.sitesMourned.add(evt.siteKey);
    const candidates = alivePool
      .filter((f) => f.kind === evt.victimKind && f.id !== evt.victimId)
      .sort((a, b) => dist(a.pos, evt.pos) - dist(b.pos, evt.pos) || a.id - b.id);
    if (candidates.length < MIN_PARTICIPANTS) return null;
    const rr = new RNG(hash2i(this.seed ^ FUNERAL_SALT, hashStr(evt.siteKey), evt.victimId | 0));
    const take = Math.min(candidates.length, MAX_PARTICIPANTS);
    const chosen = candidates.slice(0, take);
    const waypoints = processionPath(this.seed, evt);
    const p: FuneralProcession = {
      siteKey: evt.siteKey,
      kind: evt.victimKind,
      participantIds: chosen.map((f) => f.id),
      waypoints,
      ritualDurationS: rr.range(RITUAL_MIN_S, RITUAL_MAX_S),
    };
    const cum = cumulativeLengths(waypoints);
    // Column starts stacked behind the path start, leader at s=0.
    const arcs = p.participantIds.map((_, i) => -i * COLUMN_GAP_M);
    this.active.push({ p, cum, arcs, phase: 'march', phaseClock: 0 });
    return p;
  }

  /**
   * Advance every active procession by dtS of simulation time. March moves
   * the column along the seeded path at MARCH_SPEED_MPS holding COLUMN_GAP_M
   * spacing; arrival triggers a ritual pause of the seeded duration; then
   * the column disperses (backs off the path) until done.
   * @param dtS Seconds to advance.
   * @returns Snapshot per still-active procession after the step (finished
   * ones drop out once dispersal completes).
   */
  advance(dtS: number): FuneralProgress[] {
    for (const st of this.active) {
      st.phaseClock += dtS;
      const total = st.cum[st.cum.length - 1];
      if (st.phase === 'march') {
        const lead = Math.min(total, st.arcs[0] + MARCH_SPEED_MPS * dtS);
        for (let i = 0; i < st.arcs.length; i++) {
          st.arcs[i] = Math.max(-i * COLUMN_GAP_M, lead - i * COLUMN_GAP_M);
        }
        if (lead >= total) {
          st.phase = 'ritual';
          st.phaseClock = 0;
        }
      } else if (st.phase === 'ritual') {
        if (st.phaseClock >= st.p.ritualDurationS) {
          st.phase = 'dispersing';
          st.phaseClock = 0;
        }
      } else if (st.phase === 'dispersing') {
        for (let i = 0; i < st.arcs.length; i++) {
          st.arcs[i] -= MARCH_SPEED_MPS * dtS;
        }
        if (st.arcs[st.arcs.length - 1] <= -st.arcs.length * COLUMN_GAP_M) {
          st.phase = 'done';
        }
      }
    }
    // Finished processions leave the active set for good.
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].phase === 'done') this.active.splice(i, 1);
    }
    return this.active.map(snapshot);
  }

  /** Progress snapshot per active procession without advancing time. */
  progress(): FuneralProgress[] {
    return this.active.map(snapshot);
  }
}

/** Fewest same-kind survivors that will still hold a funeral. */
export const MIN_PARTICIPANTS = 2;

/** Column cap; extra candidates stay behind. */
export const MAX_PARTICIPANTS = 6;

function cumulativeLengths(pts: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}

function pointAt(st: InternalState, s: number): Vec2 {
  const { p, cum } = st;
  const total = cum[cum.length - 1];
  const sc = Math.max(0, Math.min(total, s));
  for (let i = 1; i < cum.length; i++) {
    if (sc <= cum[i]) {
      const segLen = cum[i] - cum[i - 1] || 1e-9;
      return lerp(p.waypoints[i - 1], p.waypoints[i], (sc - cum[i - 1]) / segLen);
    }
  }
  return p.waypoints[p.waypoints.length - 1];
}

function snapshot(st: InternalState): FuneralProgress {
  return {
    procession: st.p,
    phase: st.phase,
    arcPositionsM: [...st.arcs],
    positions: st.arcs.map((s) => pointAt(st, s)),
    pathLengthM: st.cum[st.cum.length - 1],
  };
}
