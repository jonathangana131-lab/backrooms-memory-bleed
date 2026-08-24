/**
 * Room-tone drops (F37): granular silence preceding ANY anomaly type.
 *
 * An injected anomaly-scheduler announces anomalies some seconds ahead;
 * this module answers every announcement by scheduling a room-tone gain
 * dip that bottoms out EXACTLY at the anomaly's start instant:
 *
 *   window   [start - duration, start], duration seeded in 1.2-2.5 s
 *   depth    seeded between -18 dB and -30 dB relative (>= 18 dB drop)
 *   shape    smooth descent into the floor across the window, exponential
 *            recovery (tau ~0.9 s) once the anomaly begins
 *   ration   at most one dip per 90 s of session timeline; extra
 *            announcements inside that window are silently skipped
 *
 * The dip is kind-agnostic: doorway déjà-vu, corridor stretch, migrating
 * lights -- anything the scheduler announces gets the same hush, because
 * the silence itself is the tell.
 *
 * Deterministic: duration and depth derive from (seed, kind, startAt) via
 * RNG-law hashes, so a replayed announcement timeline reproduces the same
 * dips. Pure model + optional WebAudio mount -- tests drive gainAt()
 * directly, the live graph receives absolute-time automation at announce
 * time.
 */

// --- mirrored deterministic helpers (tiledisplace.ts precedent: local copies
// --- of src/core/rng.ts so the module stays dependency-free under direct
// --- node strip-types test imports; algorithms identical to the RNG law) ----

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** FNV-1a over a string, for hashing anomaly kinds. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- tuning ------------------------------------------------------------------

export const DIP_MIN_DURATION_S = 1.2;
export const DIP_MAX_DURATION_S = 2.5;
/** Shallowest allowed dip floor; AC requires >= this much attenuation. */
export const DIP_MAX_DEPTH_DB = -18;
/** Deepest dip floor ("near-silence"). */
export const DIP_DEPTH_FLOOR_DB = -30;
/** Minimum seconds between consecutive dip starts (ration <= 1 / 90 s). */
export const DIP_MIN_INTERVAL_S = 90;
/** Dip end must align with anomaly start within this tolerance (seconds). */
export const DIP_ALIGN_TOLERANCE_S = 0.1;
/** Exponential-recovery time constant after the anomaly starts (seconds). */
export const RECOVERY_TAU_S = 0.9;

/** Salt separating room-tone hashing from every other feature. */
export const ROOM_TONE_SALT = 0x270be;

/** An upcoming anomaly, announced leadTime seconds before it starts. */
export interface AnomalyAnnouncement {
  /** Scheduler-defined anomaly kind; any string is valid. */
  kind: string;
  /** Session-timeline instant (seconds) at which the anomaly begins. */
  startAt: number;
}

/** Injected scheduler interface announcing anomalies ahead of time. */
export interface AnomalyScheduler {
  /**
   * Register a callback invoked once per scheduled anomaly.
   * @param cb receiver of announcements
   */
  onAnnouncement(cb: (a: AnomalyAnnouncement) => void): void;
}

/** One scheduled room-tone dip (the dip ENDS exactly at startAt). */
export interface RoomToneDip {
  /** Kind of the anomaly this dip precedes. */
  kind: string;
  /** Anomaly start = end of the dip window. */
  startAt: number;
  /** Window opening = start - duration. */
  beginAt: number;
  /** Floor level in dB relative to unity. */
  depthDb: number;
}

/** Construction options; every field has a procedural default. */
export interface RoomToneOptions {
  /** Deterministic seed for dip duration/depth draws. */
  seed?: number;
  /** Session clock in seconds (defaults to a private zero-based counter). */
  clock?: () => number;
  /** Optional AudioContext for the live graph mount. */
  ctx?: AudioContext;
  /** Destination the room-tone bus feeds; requires ctx. */
  destination?: AudioNode;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Room-tone dip scheduler. Feed it announcements from any anomaly
 * scheduler; evaluate the mix envelope with gainAt(), or let the optional
 * WebAudio bus automate itself.
 */
export class RoomToneDrops {
  private readonly seed: number;
  private readonly clockFn: () => number;
  private readonly out: GainNode | null;
  private readonly ctx: AudioContext | null;

  /** Backing store for the default zero-based session clock. */
  private defaultNow = 0;

  private readonly dips_: RoomToneDip[] = [];
  private lastDipStart: number | null = null;

  constructor(opts: RoomToneOptions = {}) {
    this.seed = (opts.seed ?? 0) | 0;
    this.clockFn = opts.clock ?? (() => this.defaultNow);
    if (opts.ctx && opts.destination) {
      this.ctx = opts.ctx;
      this.out = opts.ctx.createGain();
      this.out.gain.value = 1;
      this.out.connect(opts.destination);
    } else {
      this.ctx = null;
      this.out = null;
    }
  }

  /**
   * Advance the default (injected-clock-less) session timeline. Callers
   * that supply their own clock never need this.
   * @param dt seconds to advance by
   */
  advance(dt: number): void {
    if (Number.isFinite(dt)) this.defaultNow += dt;
  }

  /**
   * Subscribe to an injected anomaly scheduler. Any number of schedulers
   * can be attached; all announcements funnel through the same rationing.
   * @param scheduler upstream anomaly scheduler
   */
  attach(scheduler: AnomalyScheduler): void {
    scheduler.onAnnouncement((a) => this.announce(a.kind, a.startAt));
  }

  /**
   * Consider one announcement directly (also used by attach()). Accepted
   * announcements schedule a dip ending exactly at startAt.
   * @param kind anomaly kind string
   * @param startAt session-timeline anomaly start in seconds
   * @returns true when a dip was scheduled, false when rationing,
   *          invalid input, or an already-started anomaly suppressed it
   */
  announce(kind: string, startAt: number): boolean {
    if (typeof kind !== 'string' || kind.length === 0 || !Number.isFinite(startAt)) return false;
    if (startAt <= this.clockFn()) return false; // too late to pre-dip
    if (this.lastDipStart !== null && startAt - this.lastDipStart < DIP_MIN_INTERVAL_S) return false;

    const rngSeed = hash2i(hashString(kind), Math.round(startAt * 1000), this.seed ^ ROOM_TONE_SALT);
    const dur = DIP_MIN_DURATION_S +
      (hash32(rngSeed) / 4294967296) * (DIP_MAX_DURATION_S - DIP_MIN_DURATION_S);
    const depthDb = DIP_DEPTH_FLOOR_DB +
      (hash32(rngSeed ^ 0x51ce) / 4294967296) * (DIP_MAX_DEPTH_DB - DIP_DEPTH_FLOOR_DB);

    const dip: RoomToneDip = { kind, startAt, beginAt: startAt - dur, depthDb };
    this.dips_.push(dip);
    this.lastDipStart = startAt;
    this.scheduleAutomation(dip);
    return true;
  }

  /** Scheduled dips in announcement order. */
  dips(): readonly RoomToneDip[] {
    return this.dips_;
  }

  /**
   * Room-tone gain factor at session time t (1 = untouched mix). The value
   * descends smoothly across each dip window, bottoms out at the anomaly
   * start, then recovers exponentially. Overlapping envelopes take the
   * quietest contribution.
   * @param t session-timeline seconds
   */
  gainAt(t: number): number {
    if (!Number.isFinite(t)) return 1;
    let g = 1;
    for (const d of this.dips_) {
      if (t < d.beginAt) continue;
      const depth = Math.pow(10, d.depthDb / 20);
      if (t < d.startAt) {
        const k = clamp((t - d.beginAt) / (d.startAt - d.beginAt), 0, 1);
        g = Math.min(g, 1 + (depth - 1) * smoothstep(k));
      } else {
        const recovered = Math.exp(-(t - d.startAt) / RECOVERY_TAU_S);
        g = Math.min(g, 1 + (depth - 1) * recovered);
      }
      if (g <= depth) break;
    }
    return g;
  }

  /** Live room-tone bus gain node, or null when unmounted. */
  get node(): GainNode | null {
    return this.out;
  }

  /** Push absolute-time automation into the mounted graph (no-op unmounted). */
  private scheduleAutomation(dip: RoomToneDip): void {
    if (!this.out) return;
    const p = this.out.gain;
    const depth = Math.pow(10, dip.depthDb / 20);
    const t = (this.ctx as AudioContext).currentTime;
    const offset = dip.beginAt - this.clockFn(); // translate session -> audio time
    p.setValueAtTime(this.gainAt(this.clockFn()), t);
    p.linearRampToValueAtTime(depth, t + Math.max(0, offset) + (dip.startAt - dip.beginAt));
    p.setTargetAtTime(1, t + Math.max(0, offset) + (dip.startAt - dip.beginAt), RECOVERY_TAU_S);
  }
}
