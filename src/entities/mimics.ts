/**
 * F28 Mimic props — furniture that is an entity until observed.
 *
 * A mimic starts as an exact stand-in for an injected prop position: same
 * spot, nothing moving, no flag raised. It stops being furniture along two
 * paths — the player's gaze resting on it for longer than GAZE_HOLD_SECONDS
 * (injected gaze provider), or it drifting within REVEAL_PROXIMITY_METRES
 * while in direct view (injected frustum+LOS provider). The first
 * observation latches its true-nature flag for good.
 *
 * Freeze rules mirror the watcher beam rule exactly: NO movement of any
 * kind while observed, where observed means the gaze currently rests on
 * the prop OR it stands within reveal range in direct view. Observed and
 * unobserved ticks may interleave freely; each tick's behavior depends
 * only on that tick's observation state (freeze iff observed). While
 * unobserved — before or after the reveal latch — it creeps toward the
 * player at CREEP_SPEED with a small seeded heading wobble, so the sofa by
 * the wall is always a little closer than you remembered.
 *
 * Pure simulation — no DOM, no Babylon. Determinism law holds: all draws
 * flow through src/core/rng.ts seeded per instance, so the same seed and
 * the same observation script replay identically.
 */
import { RNG } from '../core/rng';
import { moveCircle, type CircleBody } from '../world/collision';
import type { Box2 } from '../world/architect';

// ---- injected world ----------------------------------------------------------

/** One prop position a mimic inhabits (injected). */
export interface PropAnchor {
  /** Stable prop id used by the true-nature flag and save data. */
  readonly id?: string;
  x: number;
  z: number;
}

/** Construction-time dependencies for one mimic set. */
export interface MimicDeps {
  /** Prop positions the mimics inhabit at spawn. */
  props: readonly PropAnchor[];
  /** Sim seed (determinism law). */
  seed: number;
  /**
   * Gaze provider: true while the player's gaze rests on world point
   * (x, z). Absent = never gazed at.
   */
  gazeRestingOn?(x: number, z: number): boolean;
  /**
   * Direct-view provider: true when the camera frustum plus line-of-sight
   * both include world point (x, z). Absent = never in direct view.
   */
  directViewOf?(x: number, z: number): boolean;
  /** Optional wall boxes constraining creep movement. */
  colliders?: readonly Box2[];
}

// ---- tuning ------------------------------------------------------------------

/** Gaze rest time that exposes a mimic (seconds). */
export const GAZE_HOLD_SECONDS = 1.2;

/** Direct-view proximity that exposes a mimic instantly (metres). */
export const REVEAL_PROXIMITY_METRES = 3.5;

/** Unobserved creep speed cap toward the player (m/s). */
export const CREEP_SPEED = 0.45;

/** Mimic body radius for collision resolution (metres). */
export const MIMIC_RADIUS = 0.35;

/** Creep heading wobble half-arc (radians), applied around the player bearing. */
export const WOBBLE_HALF_ARC = 0.6;

/** Seconds between seeded wobble redraws per mimic. */
export const WOBBLE_PERIOD_SEC = 2.5;

// ---- state -------------------------------------------------------------------

/** Live mutable state of one mimic. */
export interface MimicState {
  readonly index: number;
  /** Stable id from the injected anchor (falls back to 'mimic:<index>'). */
  readonly id: string;
  x: number;
  z: number;
  /** True-nature flag: latches true on first observation, never resets. */
  revealed: boolean;
  /** Watcher-rule freeze: true exactly after an update tick that was observed. */
  frozen: boolean;
  /** Consecutive gaze time accumulated on this mimic (reset when gaze breaks). */
  gazeHeldSec: number;
}

// ---- entity set ----------------------------------------------------------------

/**
 * The live mimic population over one injected prop list. update() advances
 * every mimic one frame against the player position: observation sampling,
 * reveal latching, then either freeze or capped creep.
 */
export class MimicProps {
  /** One live state record per injected prop, in injection order. */
  readonly mimics: MimicState[] = [];

  private readonly deps: MimicDeps;
  private readonly rng: RNG;
  /** Per-mimic persistent wobble streams keep draws independent of set size. */
  private readonly wobblePhase: number[] = [];
  private readonly nextWobbleAt: number[] = [];
  private clock = 0;

  constructor(deps: MimicDeps) {
    this.deps = deps;
    this.rng = new RNG((deps.seed >>> 0) || 0x9e3779b9);
    for (let i = 0; i < deps.props.length; i++) {
      const p = deps.props[i];
      this.mimics.push({
        index: i,
        id: p.id ?? 'mimic:' + i,
        x: p.x,
        z: p.z,
        revealed: false,
        frozen: false,
        gazeHeldSec: 0,
      });
      // per-mimic wobble stream seeded up front: the draw sequence stays fixed
      // regardless of how many mimics exist or when they are observed
      this.wobblePhase.push(this.rng.range(0, Math.PI * 2));
      this.nextWobbleAt.push(this.rng.range(0, WOBBLE_PERIOD_SEC));
    }
  }

  /**
   * Register one prop anchor mid-session (chunk-streamed spawns). The
   * per-mimic draw streams extend in insertion order, so the same spawn
   * script replays identically under the determinism law.
   */
  addProp(p: PropAnchor): void {
    const i = this.mimics.length;
    this.mimics.push({
      index: i,
      id: p.id ?? 'mimic:' + i,
      x: p.x,
      z: p.z,
      revealed: false,
      frozen: false,
      gazeHeldSec: 0,
    });
    this.wobblePhase.push(this.rng.range(0, Math.PI * 2));
    this.nextWobbleAt.push(this.rng.range(0, WOBBLE_PERIOD_SEC));
  }

  /**
   * Advance one frame. For each mimic: sample observation (gaze OR close
   * direct view), latch the reveal flag, freeze iff observed, otherwise
   * creep toward the player at CREEP_SPEED with a seeded heading wobble.
   */
  update(dt: number, px: number, pz: number): void {
    if (dt <= 0) return;
    const colliders = this.deps.colliders ?? [];
    for (let i = 0; i < this.mimics.length; i++) {
      const m = this.mimics[i];
      const dx = px - m.x;
      const dz = pz - m.z;
      const dist = Math.hypot(dx, dz);
      const gazed = this.deps.gazeRestingOn ? this.deps.gazeRestingOn(m.x, m.z) === true : false;
      const inDirectView = this.deps.directViewOf ? this.deps.directViewOf(m.x, m.z) === true : false;
      const closeVisible = inDirectView && dist <= REVEAL_PROXIMITY_METRES;
      const observed = gazed || closeVisible;

      m.gazeHeldSec = gazed ? m.gazeHeldSec + dt : 0;
      if (!m.revealed && (closeVisible || m.gazeHeldSec >= GAZE_HOLD_SECONDS)) m.revealed = true;
      m.frozen = observed; // watcher consistency: no movement while observed
      if (observed) continue;

      if (dist <= 1e-6) continue; // arrived: nothing left to creep toward
      if (this.clock >= this.nextWobbleAt[i]) {
        this.wobblePhase[i] += (this.rng.next() - 0.5) * WOBBLE_HALF_ARC * 2;
        this.nextWobbleAt[i] = this.clock + WOBBLE_PERIOD_SEC;
      }
      const ux = dx / dist;
      const uz = dz / dist;
      const lateral = Math.sin(this.wobblePhase[i]);
      // unit steer plus unit-normalized lateral blend, renormalized back onto
      // CREEP_SPEED: the speed cap holds by construction, not discipline
      let vx = ux - uz * lateral;
      let vz = uz + ux * lateral;
      const vl = Math.hypot(vx, vz) || 1;
      vx = (vx / vl) * CREEP_SPEED;
      vz = (vz / vl) * CREEP_SPEED;
      const body: CircleBody = { x: m.x, z: m.z, radius: MIMIC_RADIUS };
      moveCircle(body, vx * dt, vz * dt, colliders);
      m.x = body.x;
      m.z = body.z;
    }
    this.clock += dt;
  }

  /** True-nature flag lookup by stable id. Unknown ids read as never revealed. */
  isRevealed(id: string): boolean {
    const m = this.mimics.find((mm) => mm.id === id);
    return m ? m.revealed : false;
  }
}
