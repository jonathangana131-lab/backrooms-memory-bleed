/**
 * F27 Watcher packs — coordinated multi-watcher stalks at stage >= 3.
 *
 * A single watcher holds still and waits. A pack does neither: it spreads
 * into a ring around the player at radius bands, keeps mutual spacing
 * discipline (no two members closer than MIN_MEMBER_SPACING), and shares
 * aggression — one member spotting the player raises the whole pack's
 * stalk level, which then decays slowly when nobody sees anything.
 *
 * Pure coordination logic (no Babylon imports), matching schedules.ts.
 * The coordinator OWNS NO BODIES: every update() consumes injected member
 * positions plus the player position and returns per-member commands
 * (target + velocity) that the caller applies to its own figures. Stage
 * gating runs through an injected stage provider; below STAGE_GATE the
 * pack refuses to activate and sightings raise nothing.
 */
import { RNG } from '../core/rng';

// ---- tuning ------------------------------------------------------------------

/** Minimum mutual distance between pack members (metres). */
export const MIN_MEMBER_SPACING = 6;
/** Horror stage at which packs may activate (injected provider). */
export const STAGE_GATE = 3;
/** Ring radius bands around the player, metres. Members split across bands. */
export const RING_BANDS: readonly number[] = [9, 14];
/** Aggression added to the shared pack level per sighting report. */
export const AGGRESSION_RISE = 0.35;
/** Shared stalk level decay per second while the pack exists. */
export const AGGRESSION_DECAY_PER_SEC = 0.04;
/** Base pursuit speed toward a slot (m/s); scales up with stalk level. */
export const BASE_SPEED = 3.2;
/** Extra speed at full stalk level (m/s). */
export const STALK_SPEED_BOOST = 1.4;

/** Stream salt for the pack's slot-rotation draw. */
const PACK_SALT = 0x3fa7c >>> 0;

export type PackState = 'inactive' | 'stalking';

/** One watcher's injected state for an update tick. */
export interface PackInput {
  /** stable member id (index into the coordinator's member list) */
  id: number;
  x: number;
  z: number;
  /** true when this member can see the player this frame */
  sawPlayer?: boolean;
}

/** One member's orders for this frame; caller applies vx/vz or steers to tx/tz. */
export interface PackCommand {
  id: number;
  /** resolved formation target (spacing-disciplined) */
  tx: number;
  tz: number;
  /** capped velocity toward the target this frame */
  vx: number;
  vz: number;
  /** speed cap used for vx/vz (scales with shared stalk level) */
  speed: number;
  /** shared pack aggression 0..1 — identical for every member */
  aggression: number;
}

export interface WatcherPackOptions {
  /** stable member ids forming the pack */
  memberIds: readonly number[];
  /** injected horror-stage provider; queried every update() */
  stage: () => number;
  seed: number;
}

/**
 * Coordinator for one pack. Deterministic per seed: the ring rotation is a
 * single seeded draw at construction, and every later decision is a pure
 * function of (injected inputs, elapsed simulation via dt accumulation).
 */
export class WatcherPack {
  /** shared aggression 0..1; raised by ANY member's sighting, decayed by time */
  stalkLevel = 0;
  /** observed at the most recent update() */
  state: PackState = 'inactive';

  private readonly memberIds: readonly number[];
  private readonly stage: () => number;
  private readonly ringRotation: number;

  constructor(opts: WatcherPackOptions) {
    this.memberIds = [...opts.memberIds];
    this.stage = opts.stage;
    this.ringRotation = new RNG((opts.seed ^ PACK_SALT) >>> 0).next() * Math.PI * 2;
  }

  /**
   * Advance one frame.
   *
   * @param dt Timestep in seconds (> 0).
   * @param px Player x.
   * @param pz Player z.
   * @param members Injected member positions; ids must match memberIds.
   * @returns One command per input member (same order). While inactive the
   *          commands hold position and sightings raise nothing.
   */
  update(dt: number, px: number, pz: number, members: readonly PackInput[]): PackCommand[] {
    // time decays the shared level first, so a sighting tick's rise is exact
    this.stalkLevel = Math.max(0, this.stalkLevel - AGGRESSION_DECAY_PER_SEC * dt);

    if (this.stage() < STAGE_GATE || members.length === 0) {
      this.state = 'inactive';
      return members.map((m) => hold(m.id, m.x, m.z, this.stalkLevel));
    }
    this.state = 'stalking';

    // shared aggression: any sighting lifts the WHOLE pack
    let sighted = false;
    for (const m of members) if (m.sawPlayer) sighted = true;
    if (sighted) this.stalkLevel = Math.min(1, this.stalkLevel + AGGRESSION_RISE);

    const slots = this.assignSlots(px, pz, members.length);
    const speed = BASE_SPEED + STALK_SPEED_BOOST * this.stalkLevel;

    // desired step toward each slot, then resolve mutual spacing on the
    // candidate endpoints in id order so the invariant is kept exactly
    const candidates = members.map((m, i) => {
      const dx = slots[i].x - m.x;
      const dz = slots[i].z - m.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, speed * dt);
      return { id: m.id, cx: d > 1e-9 ? m.x + (dx / d) * step : m.x, cz: d > 1e-9 ? m.z + (dz / d) * step : m.z };
    });
    resolveSpacing(candidates);

    return candidates.map((c) => {
      const src = members.find((m) => m.id === c.id)!;
      const dx = c.cx - src.x;
      const dz = c.cz - src.z;
      const d = Math.hypot(dx, dz);
      return {
        id: c.id,
        tx: c.cx,
        tz: c.cz,
        vx: d > 1e-9 ? (dx / d) * Math.min(d / dt, speed) : 0,
        vz: d > 1e-9 ? (dz / d) * Math.min(d / dt, speed) : 0,
        speed,
        aggression: this.stalkLevel,
      };
    });
  }

  /**
   * Ring formation around the player: all n slots are spread evenly around
   * the full circle (seeded rotation); the first ceil(n/2) indices take the
   * inner band radius, the rest the outer band. Slot i belongs to memberIds
   * order (stable assignment). Even global angles keep cross-band neighbours
   * far enough apart that the spacing resolver stays idle at the ideal posts.
   */
  private assignSlots(px: number, pz: number, n: number): Array<{ x: number; z: number }> {
    const slots: Array<{ x: number; z: number }> = [];
    const innerCount = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const band = i < innerCount ? 0 : 1;
      const radius = RING_BANDS[Math.min(band, RING_BANDS.length - 1)];
      const ang = this.ringRotation + (i / n) * Math.PI * 2;
      slots.push({ x: px + Math.cos(ang) * radius, z: pz + Math.sin(ang) * radius });
    }
    return slots;
  }
}

/**
 * Push candidate endpoints apart (symmetrically, in list order) until every
 * pair respects MIN_MEMBER_SPACING, so commands can never direct two members
 * inside the pack's own spacing discipline. Converges because each pass
 * strictly increases violating pair distances and slots are finite targets.
 */
function resolveSpacing(candidates: Array<{ id: number; cx: number; cz: number }>): void {
  // each pass strictly increases every violating pair's distance, so the
  // cascade converges geometrically; 64 passes end far inside float noise
  for (let pass = 0; pass < 64; pass++) {
    let violated = false;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        const dx = b.cx - a.cx;
        const dz = b.cz - a.cz;
        const d = Math.hypot(dx, dz);
        if (d >= MIN_MEMBER_SPACING || d < 1e-9) {
          if (d < 1e-9) { a.cx += 0.01; } // degenerate overlap: deterministic nudge
          continue;
        }
        violated = true;
        const push = (MIN_MEMBER_SPACING - d) / 2;
        const ux = d > 1e-9 ? dx / d : 1;
        const uz = d > 1e-9 ? dz / d : 0;
        a.cx -= ux * push;
        a.cz -= uz * push;
        b.cx += ux * push;
        b.cz += uz * push;
      }
    }
    if (!violated) return;
  }
}

function hold(id: number, x: number, z: number, aggression: number): PackCommand {
  return { id, tx: x, tz: z, vx: 0, vz: 0, speed: 0, aggression };
}
