/**
 * F68 The Tour Guide — escort entity that abandons you at the worst moment.
 *
 * The guide walks an injected route graph toward an injected "exit claim"
 * (a node it swears is the way out). It leads at escort speed but its
 * waypoint pacing waits for the player whenever the player falls outside
 * the leash radius. A trust meter builds while the player keeps up and
 * decays while they lag.
 *
 * The abandonment rule: once the player has passed the injected
 * point-of-no-return commit node AND overtakes the guide at their deepest
 * progress along the route, the guide departs toward the exit claim at max
 * escort speed - it knew the way all along. This happens EXACTLY ONCE per
 * run; before commitment the guide always waits, never abandons.
 *
 * Determinism: every seeded quantity flows through src/core/rng.ts hashes;
 * identical (seed, inputs) replays byte-identical timelines.
 *
 * Pure logic - no DOM, no Babylon. The caller renders positions each frame
 * from advance().
 */
import { RNG, hash2i } from '../core/rng';

/** Salt so tour-guide draws never correlate with any other feature. */
const GUIDE_SALT = 0xf68;

/** Leading speed while the player keeps up, metres/second. */
export const ESCORT_SPEED_MPS = 1.6;

/** Departure speed after abandonment - the guide's true pace, m/s. */
export const MAX_ESCORT_SPEED_MPS = 3.4;

/** Guide halts (waits) when the player is farther than this, metres. */
export const LEASH_RADIUS_M = 9;

/** Trust builds inside the leash and decays outside it, per second bounds. */
export const TRUST_RATE_PER_S_MIN = 0.04;
export const TRUST_RATE_PER_S_MAX = 0.09;
export const TRUST_DECAY_PER_S = 0.02;

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
 * One named stop on the guided route.
 */
export interface RouteNode {
  /** Stable node id referenced by edges and the exit claim. */
  readonly id: string;
  /** World position of the stop. */
  readonly pos: Vec2;
}

/**
 * One directed connection between two route nodes.
 */
export interface RouteEdge {
  /** Tail node id. */
  readonly from: string;
  /** Head node id. */
  readonly to: string;
}

/**
 * Injected route topology: nodes plus directed edges forming a walkable
 * path from {@link TourGuideOpts.startNodeId} to the exit-claim node.
 */
export interface RouteGraph {
  /** All stops of the route. */
  readonly nodes: readonly RouteNode[];
  /** Directed connections; unreachable exit claims fail loud. */
  readonly edges: readonly RouteEdge[];
}

/**
 * Injected claim about the way out: the guide insists this node is an exit.
 */
export interface ExitClaim {
  /** Route node id the guide presents as the exit; must exist in the graph. */
  readonly nodeId: string;
  /** Short in-world label used by callers for vocals/journal lines. */
  readonly label: string;
}

/**
 * Constructor options for a tour-guide run.
 */
export interface TourGuideOpts {
  /** Master run seed; keys trust rate and other per-run draws. */
  readonly seed: number;
  /** Route topology toward the exit claim. */
  readonly graph: RouteGraph;
  /** Where the route begins (the guide's spawn node). */
  readonly startNodeId: string;
  /** Point-of-no-return node: abandonment may fire only past this. */
  readonly commitNodeId: string;
  /** The exit the guide claims to know. */
  readonly exitClaim: ExitClaim;
}

/** Guide lifecycle phases. 'leading' covers both walking and waiting. */
export type GuidePhase = 'leading' | 'departing' | 'gone';

/**
 * Live state of the escort as advanced by {@link TourGuide.advance}.
 */
export interface GuideProgress {
  /** Current phase. */
  readonly phase: GuidePhase;
  /** True while phase is 'leading' and the player is beyond the leash. */
  readonly waitingForPlayer: boolean;
  /** Guide world position this frame. */
  readonly pos: Vec2;
  /** Guide arc-length position along the route, metres. */
  readonly arcM: number;
  /** Player's projected arc-length position this frame, metres. */
  readonly playerArcM: number;
  /** Player's deepest arc-length position ever reached, metres. */
  readonly playerDeepestArcM: number;
  /** True once the player is past the commit node (irreversible). */
  readonly committed: boolean;
  /** Trust meter in [0,1]; builds while followed, decays while lagging. */
  readonly trust: number;
  /** True once abandonment has fired (exactly once per run). */
  readonly abandoned: boolean;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

interface InternalState {
  phase: GuidePhase;
  waiting: boolean;
  arc: number;
  playerArc: number;
  playerDeepestArc: number;
  committed: boolean;
  trust: number;
  abandoned: boolean;
  trustRate: number;
}

/**
 * Escort coordinator for one run. Feed it the player position every frame;
 * it advances the guide along the injected route and owns the one-shot
 * abandonment decision.
 */
export class TourGuide {
  private readonly waypoints: Vec2[];
  private readonly cum: number[];
  private readonly commitArcM: number;
  private readonly exitLabel: string;
  private readonly st: InternalState;

  /**
   * Builds the ordered waypoint path from the graph and validates every
   * injected id. A missing node or an exit unreachable from the start
   * throws at construction (misconfiguration fails loud).
   * @param opts Fully specified per-run options.
   */
  constructor(opts: TourGuideOpts) {
    const byId = new Map<string, RouteNode>(opts.graph.nodes.map((n) => [n.id, n]));
    if (!byId.has(opts.startNodeId)) throw new Error(`tourguide: unknown start node ${opts.startNodeId}`);
    if (!byId.has(opts.commitNodeId)) throw new Error(`tourguide: unknown commit node ${opts.commitNodeId}`);
    if (!byId.has(opts.exitClaim.nodeId)) throw new Error(`tourguide: unknown exit node ${opts.exitClaim.nodeId}`);
    const adj = new Map<string, string[]>();
    for (const e of opts.graph.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) throw new Error(`tourguide: edge references unknown node ${e.from}->${e.to}`);
      let list = adj.get(e.from);
      if (!list) adj.set(e.from, (list = []));
      list.push(e.to);
    }
    // BFS with insertion-ordered adjacency gives a deterministic simple path.
    const prev = new Map<string, string | null>([[opts.startNodeId, null]]);
    const queue = [opts.startNodeId];
    let found = false;
    while (queue.length > 0 && !found) {
      const cur = queue.shift() as string;
      for (const nxt of adj.get(cur) ?? []) {
        if (prev.has(nxt)) continue;
        prev.set(nxt, cur);
        if (nxt === opts.exitClaim.nodeId) { found = true; break; }
        queue.push(nxt);
      }
    }
    if (!prev.has(opts.exitClaim.nodeId)) {
      throw new Error(`tourguide: exit claim "${opts.exitClaim.label}" unreachable from ${opts.startNodeId}`);
    }
    const chain: string[] = [];
    for (let cur: string | null = opts.exitClaim.nodeId; cur !== null; cur = prev.get(cur) ?? null) {
      chain.push(cur);
    }
    chain.reverse();
    this.waypoints = chain.map((id) => (byId.get(id) as RouteNode).pos);
    this.cum = [0];
    for (let i = 1; i < this.waypoints.length; i++) {
      this.cum.push(this.cum[i - 1] + dist(this.waypoints[i - 1], this.waypoints[i]));
    }
    const commitIdx = chain.indexOf(opts.commitNodeId);
    this.commitArcM = this.cum[commitIdx];
    this.exitLabel = opts.exitClaim.label;
    const rr = new RNG(hash2i(opts.seed, GUIDE_SALT, chain.length));
    this.st = {
      phase: 'leading',
      waiting: false,
      arc: 0,
      playerArc: 0,
      playerDeepestArc: 0,
      committed: false,
      trust: 0,
      abandoned: false,
      trustRate: rr.range(TRUST_RATE_PER_S_MIN, TRUST_RATE_PER_S_MAX),
    };
  }

  /** The exit claim label this guide repeats like evidence. */
  get claim(): string {
    return this.exitLabel;
  }

  /**
   * Advance one simulation step.
   *
   * Pacing: while leading, the guide walks toward the exit at
   * ESCORT_SPEED_MPS only when the player is within LEASH_RADIUS_M;
   * otherwise it stands still and waits. Trust builds inside the leash and
   * decays outside it.
   *
   * Abandonment: fires exactly once, and only when the player is committed
   * (past the commit node) AND at their deepest-ever route progress AND
   * has overtaken the guide. After firing, the guide departs along the
   * remaining route at MAX_ESCORT_SPEED_MPS until it reaches the claimed
   * exit and is gone.
   * @param dtS Seconds to advance.
   * @param playerPos Player world position this frame.
   * @returns Snapshot of guide state after the step.
   */
  advance(dtS: number, playerPos: Vec2): GuideProgress {
    const st = this.st;
    st.playerArc = projectOntoPath(this.waypoints, this.cum, playerPos);
    if (st.playerArc > st.playerDeepestArc) st.playerDeepestArc = st.playerArc;
    if (!st.committed && st.playerDeepestArc >= this.commitArcM) st.committed = true;
    const total = this.cum[this.cum.length - 1];

    if (st.phase === 'leading') {
      const playerDist = dist(this.pointAt(st.arc), playerPos);
      st.waiting = playerDist > LEASH_RADIUS_M;
      // The step is clamped to the largest arc gain whose endpoint stays
      // within the leash, so even a huge dt can never carry the guide past
      // the radius between checks.
      let clampedArc = st.arc;
      if (!st.waiting) {
        clampedArc = this.clampStepToLeash(st.arc, Math.min(ESCORT_SPEED_MPS * dtS, total - st.arc), playerPos);
      }
      if (clampedArc > st.arc) {
        st.trust = Math.min(1, st.trust + st.trustRate * dtS);
        st.arc = clampedArc;
      } else {
        // Pacing hold: the player is outside the leash, or no forward motion
        // fits inside it this frame.
        st.waiting = true;
        st.trust = Math.max(0, st.trust - TRUST_DECAY_PER_S * dtS);
      }
      // One-shot abandonment: committed + deepest progress + overtaken.
      if (
        !st.abandoned &&
        st.committed &&
        st.playerArc >= st.playerDeepestArc - 1e-9 &&
        st.playerArc >= st.arc
      ) {
        st.abandoned = true;
        st.phase = 'departing';
        st.waiting = false;
      }
    } else if (st.phase === 'departing') {
      st.arc = Math.min(total, st.arc + MAX_ESCORT_SPEED_MPS * dtS);
      if (st.arc >= total) st.phase = 'gone';
    }

    return {
      phase: st.phase,
      waitingForPlayer: st.waiting,
      pos: this.pointAt(st.arc),
      arcM: st.arc,
      playerArcM: st.playerArc,
      playerDeepestArcM: st.playerDeepestArc,
      committed: st.committed,
      trust: st.trust,
      abandoned: st.abandoned,
    };
  }

  /** Snapshot without advancing time. */
  progress(): GuideProgress {
    const st = this.st;
    return {
      phase: st.phase,
      waitingForPlayer: st.waiting,
      pos: this.pointAt(st.arc),
      arcM: st.arc,
      playerArcM: st.playerArc,
      playerDeepestArcM: st.playerDeepestArc,
      committed: st.committed,
      trust: st.trust,
      abandoned: st.abandoned,
    };
  }

  /**
   * Largest arc position reachable from `fromArc` within `stepM` metres
   * whose point stays within {@link LEASH_RADIUS_M} of the player. Bisection
   * keeps only verified-feasible endpoints, so the returned point always
   * respects the leash even where distance is non-monotone along a bend.
   * Assumes the caller verified the point at `fromArc` is inside the leash.
   */
  private clampStepToLeash(fromArc: number, stepM: number, playerPos: Vec2): number {
    if (stepM <= 0) return fromArc;
    if (dist(this.pointAt(fromArc + stepM), playerPos) <= LEASH_RADIUS_M) return fromArc + stepM;
    let lo = 0;
    let hi = stepM;
    while (hi - lo > 1e-6) {
      const mid = (lo + hi) / 2;
      if (dist(this.pointAt(fromArc + mid), playerPos) <= LEASH_RADIUS_M) lo = mid;
      else hi = mid;
    }
    return fromArc + lo;
  }

  private pointAt(s: number): Vec2 {
    return pointAtArc(this.waypoints, this.cum, s);
  }
}

/** Arc length of the path point nearest to p, clamped to [0, total]. */
function projectOntoPath(pts: readonly Vec2[], cum: readonly number[], p: Vec2): number {
  let bestD = Infinity;
  let bestS = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = cum[i] - cum[i - 1] || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / (segLen * segLen)));
    const q = lerp(a, b, t);
    const d = dist(q, p);
    if (d < bestD) {
      bestD = d;
      bestS = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    }
  }
  return bestS;
}

/** World position at arc length s along the polyline. */
function pointAtArc(pts: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
  const total = cum[cum.length - 1];
  const sc = Math.max(0, Math.min(total, s));
  for (let i = 1; i < cum.length; i++) {
    if (sc <= cum[i]) {
      const segLen = cum[i] - cum[i - 1] || 1e-9;
      return lerp(pts[i - 1], pts[i], (sc - cum[i - 1]) / segLen);
    }
  }
  return pts[pts.length - 1];
}
