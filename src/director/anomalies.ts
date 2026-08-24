/**
 * Spatial anomalies - deterministic wrongness the HorrorDirector asks for.
 *
 * The director publishes anomaly windows on its event bus ('directorEvent',
 * see director.ts); this system consumes those requests and manifests four
 * spatial phenomena, never as jumpscares, always as quiet wrongness:
 *
 *   DOORWAY DEJA-VU  certain seeded doorways shove the player back through
 *                    the room they just crossed; both sides of the door get
 *                    one ChunkDeltas drift step, so the decor is subtly
 *                    re-seeded and every later rebuild agrees with itself.
 *   CORRIDOR STRETCH a straight hallway steals ground while walked; when
 *                    unobserved (>2 s looking away) it collapses and hands
 *                    the stolen ground back in one disorienting jump.
 *   MIGRATING LIGHTS a lit fixture detaches and drifts cell-to-cell toward
 *                    the player's periphery, freezing while looked at dead-on.
 *   MIRROR STEPS     during rare bursts each footstep is duplicated 400 ms
 *                    late, panned just off-centre like someone matching you.
 *   STAIRWELL LOOP   inside a stairwell, the flight loops only while the
 *                    player's gaze is away for over LOOK_AWAY_SNAP_SEC;
 *                    looking back freezes it mid-loop, progress advances
 *                    discretely and position is recomputed from that
 *                    counter, so nobody teleports through walls.
 *
 * Hard rules: anomalies fire only inside a director window (build/peak),
 * never during a blackout, never within MIN_SPAWN_DIST of the spawn point,
 * under per-kind session caps and cooldowns. All randomness derives from
 * core/rng.ts hashes of (seed, coords, sim time) - replays of the same
 * timeline produce the same wrongness. World mutations go exclusively
 * through ChunkDeltas bumps, so revertAll() restores the canonical world.
 */
import { RNG, hash2i, rand2 } from '../core/rng';
import { CELL, worldToChunk, EdgeCode } from '../world/constants';
import type { Emitter } from '../core/events';
import type { DirectorEventPayload } from './director';

export type AnomalyKind =
  | 'doorway-deja-vu' | 'corridor-stretch' | 'migrating-lights' | 'mirror-steps'
  | 'stairwell-loop';
/** Plain-data surface the anomaly system needs from the running game. */
export interface AnomalyHost {
  playerPosition(): { x: number; z: number };
  playerYaw(): number;
  elapsed(): number;
  blackoutActive(): boolean;
  edgeCodeBetweenCell(fx: number, fz: number, tx: number, tz: number): number;
  /** Instantly place the player; resolves collisions and builds destination chunks first. */
  teleportPlayer(x: number, z: number): void;
  /** Advance a chunk's decor drift by one step and rebuild it. */
  bumpChunkDrift(cx: number, cz: number): void;
  nearestAliveFixture(x: number, z: number, maxDist: number): { x: number; z: number; key: string } | null;
  /** Position/strength of the detached fixture light (0 hides it). */
  setGhostLight(x: number, z: number, intensity: number): void;
  /** One duplicated footstep at stereo pan -1..1 with the given volume multiplier. */
  echoFootstep(pan: number, volumeMul: number): void;
  say(text: string, seconds: number): void;
  /**
   * Bounds of the stairwell block containing the player, or null when
   * outside any stairwell. Optional: hosts without a stairwell never arm F20.
   */
  stairwellBounds?(): { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  /** Seconds the player's gaze has been continuously off the stairwell flight. */
  gazeAwaySec?(): number;
  /**
   * Place the player at the landing indexed by discrete loop progress.
   * Resolves collisions and builds destination chunks (same contract as
   * teleportPlayer), so progress never lands anyone inside geometry.
   */
  repositionFromProgress?(progress: number): void;
}
// ---- tuning (fixed gameplay invariants, not deployment config) ----
/** Anomalies never manifest this close to where the player woke up. */
export const MIN_SPAWN_DIST = 40;

/** Hard per-session trigger caps per anomaly kind. */
export const CAPS: Record<AnomalyKind, number> = {
  'doorway-deja-vu': 3,
  'corridor-stretch': 3,
  'migrating-lights': 4,
  'mirror-steps': 8,
  'stairwell-loop': 2,
};

/** Minimum seconds between two firings of the same anomaly. */
export const COOLDOWNS: Record<AnomalyKind, number> = {
  'doorway-deja-vu': 75,
  'corridor-stretch': 120,
  'migrating-lights': 100,
  'mirror-steps': 60,
  'stairwell-loop': 150,
};

/** Share of doorways that remember being walked through. */
export const HAUNTED_DOOR_P = 0.22;
/** Salt for haunted-doorway selection. */
const HAUNTED_SALT = 0x5ee0d;
/** Deja-vu: how far back through the room the doorway throws you (cells). */
const DEJA_BACK_MIN = 3.5;
const DEJA_BACK_MAX = 6.5;
/** Salt for deja-vu per-doorway draws. */
const DEJA_SALT = 0xdea10;
/** Corridor stretch steals this fraction of a cell per crossed cell. */
const STRETCH_STEP_MIN = 0.18;
const STRETCH_STEP_MAX = 0.33;
/** Consecutive same-direction open crossings before a hallway is 'straight'. */
const CORRIDOR_MIN_RUN = 2;
/** Stolen ground hard cap; beyond it the hallway always collapses. */
export const MAX_STRETCH_M = 6;
/** Looking off-axis this far counts as unobserved (radians). */
const LOOK_AWAY_ANGLE = 55 * Math.PI / 180;
/** Unobserved this long and the stretch snaps back. */
export const LOOK_AWAY_SNAP_SEC = 2;
/** Mirror-step burst length and echo delay. */
const MIRROR_BURST_SEC = 7;
export const MIRROR_ECHO_DELAY_SEC = 0.4;
/** Lateral stereo offset of the mirror steps (alternates like real feet). */
const MIRROR_PAN = 0.3;
/** Migrating light lifetime range and drift speed. */
const MIGRANT_LIFE_MIN = 13;
const MIGRANT_LIFE_MAX = 18;
const MIGRANT_SPEED = 1.6;
const MIGRANT_FREEZE_CONE = 0.28; // radians - looked-at-dead-on cone
const MIGRANT_SOURCE_RANGE = 24;
/** Salt for per-progress stairwell draws. */
const STAIR_SALT = 0x57a10;
// ---- pure gating math ----

export interface GateCtx {
  kind: AnomalyKind;
  now: number;
  distFromSpawn: number;
  blackout: boolean;
  /** True while inside a director anomaly window (build/peak). */
  armed: boolean;
  /** -1 when the anomaly never fired yet. */
  lastFiredAt: number;
  usesSoFar: number;
}

export interface GateVerdict { allowed: boolean; reason: string }

const no = (reason: string): GateVerdict => ({ allowed: false, reason });

/**
 * The single authority on whether an anomaly may fire right now.
 * Order matters: window first (cheapest rejection), then blackout,
 * spawn distance, session cap, cooldown.
 */
export function checkGate(ctx: GateCtx): GateVerdict {
  if (!ctx.armed) return no('window-closed');
  if (ctx.blackout) return no('blackout');
  if (ctx.distFromSpawn < MIN_SPAWN_DIST) return no('too-close-to-spawn');
  if (ctx.usesSoFar >= CAPS[ctx.kind]) return no('cap-reached');
  if (ctx.lastFiredAt >= 0 && ctx.now - ctx.lastFiredAt < COOLDOWNS[ctx.kind]) return no('cooldown');
  return { allowed: true, reason: 'ok' };
}

/**
 * Deterministic haunted-doorway selection for the edge between two cells.
 * The same edge always answers the same way for a given seed.
 */
export function isHauntedDoorway(
  fx: number, fz: number, tx: number, tz: number, seed: number,
): boolean {
  const vert = tx !== fx;
  // unique integer id per edge so mirrored edges never share a draw
  const a = vert ? tx * 2 : fx * 2 + 1;
  const b = vert ? fz * 2 + 1 : tz * 2;
  return rand2(a, b, seed ^ HAUNTED_SALT) < HAUNTED_DOOR_P;
}
const DEJA_LINES = [
  'You have crossed this threshold before. The room noticed.',
  'This doorway remembers your weight on the hinge side.',
  'Wrong direction. You came through here the other way around.',
];
const SNAP_LINE = 'The hallway exhales. It is shorter than it was.';

/** All kinds, stable order for resets and debug readouts. */
export const ANOMALY_KINDS: readonly AnomalyKind[] = [
  'doorway-deja-vu', 'corridor-stretch', 'migrating-lights', 'mirror-steps',
  'stairwell-loop',
];

/** Bus shape the HorrorDirector exposes (see director.ts events). */
type DirectorBus = Emitter<{ directorEvent: DirectorEventPayload }>;

interface CorridorState {
  active: boolean;
  axis: 0 | 1; // 0: moving along X, 1: along Z
  dir: -1 | 1;
  run: number; // consecutive same-direction open crossings
  stretch: number; // metres currently stolen from the player
  lookAwaySec: number;
}

interface Migrant {
  sourceKey: string;
  x: number; z: number; // current detached-light position
  side: -1 | 1; // which flank it haunts
  age: number;
  life: number;
  frozen: boolean;
  wpT: number;
  wpDur: number;
  wx: number; wz: number; // current waypoint
}

/**
 * Unobserved stairwell loop state (F20). progress is a discrete landing
 * counter; consumedAway tracks how much gaze-away time has already been
 * converted into advances so each extra LOOK_AWAY_SNAP_SEC buys exactly
 * one more discrete loop.
 */
interface StairwellState {
  active: boolean;
  progress: number;
  consumedAway: number;
}
/**
 * The anomaly runtime. Pure logic plus the injected host; owns no engine
 * objects, so it is fully unit-testable against a fake AnomalyHost.
 */
export class AnomalySystem {
  private armed = false;
  private counts: Record<AnomalyKind, number> = {
    'doorway-deja-vu': 0, 'corridor-stretch': 0, 'migrating-lights': 0, 'mirror-steps': 0,
    'stairwell-loop': 0,
  };
  private lastFired: Record<AnomalyKind, number> = {
    'doorway-deja-vu': -1, 'corridor-stretch': -1, 'migrating-lights': -1, 'mirror-steps': -1,
    'stairwell-loop': -1,
  };
  private spawn = { x: 0, z: 0 };
  /** Crossings are ignored briefly after we move the player ourselves. */
  private suppressCrossUntil = -1;
  private corr: CorridorState = { active: false, axis: 0, dir: 1, run: 0, stretch: 0, lookAwaySec: 0 };
  private stair: StairwellState = { active: false, progress: 0, consumedAway: 0 };
  private migrant: Migrant | null = null;
  private migrantRetryAcc = 0;
  private burstUntil = -1;
  private stepFlip = false;
  private echoQueue: { at: number; pan: number; vol: number }[] = [];
  private offBus: () => void;

  constructor(private host: AnomalyHost, private seed: number, bus: DirectorBus) {
    this.spawn = { ...host.playerPosition() };
    this.offBus = bus.on('directorEvent', (e) => this.onDirectorEvent(e));
  }

  /** Unsubscribe from the director bus; safe to call once. */
  dispose(): void {
    this.offBus();
    this.migrant = null;
    this.echoQueue.length = 0;
  }

  /** Fresh expedition: clear caps/cooldowns and all in-flight wrongness. */
  reset(): void {
    this.spawn = { ...this.host.playerPosition() };
    for (const k of ANOMALY_KINDS) {
      this.counts[k] = 0;
      this.lastFired[k] = -1;
    }
    this.armed = false;
    this.suppressCrossUntil = -1;
    this.corr = { active: false, axis: 0, dir: 1, run: 0, stretch: 0, lookAwaySec: 0 };
    this.stair = { active: false, progress: 0, consumedAway: 0 };
    this.migrant = null;
    this.migrantRetryAcc = 0;
    this.burstUntil = -1;
    this.echoQueue.length = 0;
  }

  private onDirectorEvent(e: DirectorEventPayload): void {
    if (e.kind === 'window-open') {
      this.armed = true;
      if (e.phase === 'peak') this.trySpawnMigrant();
    } else {
      this.armed = false;
      // windows close while attention is elsewhere: collapse any stretch
      this.snapbackCorridor(false);
      this.disarmStairwell();
      this.burstUntil = -1;
    }
  }

  private gate(kind: AnomalyKind, now: number): GateVerdict {
    const pos = this.host.playerPosition();
    return checkGate({
      kind,
      now,
      distFromSpawn: Math.hypot(pos.x - this.spawn.x, pos.z - this.spawn.z),
      blackout: this.host.blackoutActive(),
      armed: this.armed,
      lastFiredAt: this.lastFired[kind],
      usesSoFar: this.counts[kind],
    });
  }

  private markFired(kind: AnomalyKind, now: number): void {
    this.counts[kind]++;
    this.lastFired[kind] = now;
  }

  /** Per-kind session usage against caps, for debug readouts. */
  usage(): Record<AnomalyKind, number> {
    return { ...this.counts };
  }

  /** True while a director anomaly window (build/peak) is open. */
  inWindow(): boolean {
    return this.armed;
  }

  /**
   * Per-frame driver: fires due mirror echoes and advances the corridor,
   * stairwell-loop and migrating-light state machines. dt is clamped by
   * the caller.
   */
  update(dt: number): void {
    if (!(dt > 0)) return;
    const now = this.host.elapsed();
    while (this.echoQueue.length > 0 && this.echoQueue[0].at <= now) {
      const e = this.echoQueue.shift()!;
      this.host.echoFootstep(e.pan, e.vol);
    }
    if (this.echoQueue.length > 64) this.echoQueue.length = 64;
    this.corridorUpdate(dt);
    this.stairwellUpdate();
    this.migrantUpdate(dt);
  }

  // ---- mirror steps ----

  /**
   * Record one of the player's own footsteps. Inside an open burst every
   * step is duplicated MIRROR_ECHO_DELAY_SEC late, panned just off centre
   * and alternating side to side, like feet matching yours behind you.
   */
  noteFootstep(running: boolean): void {
    const now = this.host.elapsed();
    if (now < this.burstUntil) {
      this.queueMirrorEcho(now, running);
      return;
    }
    if (!this.armed || this.host.blackoutActive()) return;
    const verdict = this.gate('mirror-steps', now);
    if (!verdict.allowed) return;
    this.markFired('mirror-steps', now);
    this.burstUntil = now + MIRROR_BURST_SEC;
    this.queueMirrorEcho(now, running); // duplicate the step that opened the burst
  }

  private queueMirrorEcho(now: number, running: boolean): void {
    this.stepFlip = !this.stepFlip;
    this.echoQueue.push({
      at: now + MIRROR_ECHO_DELAY_SEC,
      pan: (this.stepFlip ? 1 : -1) * MIRROR_PAN,
      vol: running ? 0.8 : 0.55,
    });
  }

  // ---- cell crossings: doorway deja-vu + corridor stretch feed ----

  /** The game reports every cell-to-cell crossing of the player here. */
  noteCellCrossing(fx: number, fz: number, tx: number, tz: number): void {
    const now = this.host.elapsed();
    if (now < this.suppressCrossUntil) return;
    const code = this.host.edgeCodeBetweenCell(fx, fz, tx, tz);
    if (code === EdgeCode.DOORWAY) {
      // a doorway breaks a hallway run; stolen ground dissolves quietly
      this.corr.active = false;
      this.corr.run = 0;
      this.corr.stretch = 0;
      this.tryDejaVu(fx, fz, tx, tz, now);
    } else if (code === EdgeCode.OPEN) {
      this.feedCorridor(fx, fz, tx, tz, now);
    }
  }

  private tryDejaVu(fx: number, fz: number, tx: number, tz: number, now: number): void {
    if (!isHauntedDoorway(fx, fz, tx, tz, this.seed)) return;
    const verdict = this.gate('doorway-deja-vu', now);
    if (!verdict.allowed) return;
    const pos = this.host.playerPosition();
    const dx = tx - fx, dz = tz - fz; // unit step in cell space
    const rr = new RNG(hash2i(tx * 31 + fx, tz * 17 + fz, this.seed ^ DEJA_SALT));
    const dist = CELL * rr.range(DEJA_BACK_MIN, DEJA_BACK_MAX);
    const bx = pos.x - dx * dist;
    const bz = pos.z - dz * dist;
    this.markFired('doorway-deja-vu', now);
    this.host.teleportPlayer(bx, bz);
    // both sides of the door re-seed their decor exactly one drift step
    this.host.bumpChunkDrift(worldToChunk(pos.x), worldToChunk(pos.z));
    this.host.bumpChunkDrift(worldToChunk(bx), worldToChunk(bz));
    this.suppressCrossUntil = now + 0.9;
    this.host.say(DEJA_LINES[rr.int(0, DEJA_LINES.length)], 4.5);
  }

  private feedCorridor(fx: number, fz: number, tx: number, tz: number, now: number): void {
    const axis: 0 | 1 = tx !== fx ? 0 : 1;
    const dir = (axis === 0 ? Math.sign(tx - fx) : Math.sign(tz - fz)) as -1 | 1;
    const st = this.corr;
    if (st.active && (st.axis !== axis || st.dir !== dir)) {
      // walking back out through stolen ground: it dissolves without a snap
      st.active = false; st.stretch = 0; st.lookAwaySec = 0; st.run = 1;
    } else if (!st.active) {
      st.axis = axis;
      st.dir = dir;
      st.run++;
      if (st.run < CORRIDOR_MIN_RUN) return;
      const verdict = this.gate('corridor-stretch', now);
      if (!verdict.allowed) { st.run = 0; return; }
      this.markFired('corridor-stretch', now);
      st.active = true;
      st.stretch = 0;
      st.lookAwaySec = 0;
    } else {
      st.run++;
    }
    const rr = new RNG(hash2i(fx, fz, this.seed ^ 0xc07a));
    const step = CELL * rr.range(STRETCH_STEP_MIN, STRETCH_STEP_MAX);
    st.stretch += step;
    const pos = this.host.playerPosition();
    // pull the player subtly back along the hallway: it lengthens ahead
    this.host.teleportPlayer(
      pos.x - (axis === 0 ? dir : 0) * step,
      pos.z - (axis === 1 ? dir : 0) * step,
    );
    this.suppressCrossUntil = now + 0.5;
  }

  private corridorUpdate(dt: number): void {
    const st = this.corr;
    if (!st.active) return;
    const deviation = facingDeviation(st.axis, st.dir, this.host.playerYaw());
    if (deviation > LOOK_AWAY_ANGLE) st.lookAwaySec += dt;
    else st.lookAwaySec = 0;
    if (
      st.stretch >= MAX_STRETCH_M ||
      st.lookAwaySec >= LOOK_AWAY_SNAP_SEC ||
      !this.armed ||
      this.host.blackoutActive()
    ) {
      this.snapbackCorridor(true);
    }
  }

  /** Collapse the stretch and hand the stolen ground back in one jump. */
  private snapbackCorridor(announce: boolean): void {
    const st = this.corr;
    const fwd = st.stretch;
    st.active = false; st.stretch = 0; st.lookAwaySec = 0; st.run = 0;
    if (fwd < 0.6) return;
    const pos = this.host.playerPosition();
    this.host.teleportPlayer(
      pos.x + (st.axis === 0 ? st.dir : 0) * fwd,
      pos.z + (st.axis === 1 ? st.dir : 0) * fwd,
    );
    this.suppressCrossUntil = this.host.elapsed() + 0.6;
    // even a metre of returned ground is worth one quiet line
    if (announce && fwd >= 0.9) this.host.say(SNAP_LINE, 3.5);
  }

  // ---- unobserved stairwell loop ----

  /** True while a stairwell episode is looping the player. */
  inStairwellLoop(): boolean {
    return this.stair.active;
  }

  /**
   * F20 driver. Arming requires the player inside injected stairwell bounds
   * during an open window; the loop then advances ONLY while the injected
   * gaze-away timer exceeds LOOK_AWAY_SNAP_SEC. Every advance increments a
   * discrete progress counter and recomputes position from it - nothing is
   * interpolated and nobody is teleported through walls. Looking back (or
   * leaving the bounds) freezes/resets the state machine untouched.
   */
  private stairwellUpdate(): void {
    const st = this.stair;
    const bounds = this.host.stairwellBounds ? this.host.stairwellBounds() : null;
    if (!bounds) {
      // stepping out of the stairwell lets go of the wrongness entirely
      if (st.active) this.disarmStairwell();
      return;
    }
    const away = this.host.gazeAwaySec ? this.host.gazeAwaySec() : 0;
    // observed: the flight holds perfectly still, mid-loop or not; the
    // unobserved-time meter restarts so a fresh absence owes its own 2 s
    if (away <= LOOK_AWAY_SNAP_SEC) {
      if (st.active) st.consumedAway = 0;
      return;
    }
    if (!st.active) {
      const verdict = this.gate('stairwell-loop', this.host.elapsed());
      if (!verdict.allowed) return;
      this.markFired('stairwell-loop', this.host.elapsed());
      st.active = true;
      st.progress = 0;
      st.consumedAway = away - LOOK_AWAY_SNAP_SEC;
      // crossing the threshold IS the first wrong landing
      this.advanceStairwell(st);
    }
    // one discrete landing per full unobserved interval past what we spent
    while (away - st.consumedAway > LOOK_AWAY_SNAP_SEC) {
      st.consumedAway += LOOK_AWAY_SNAP_SEC;
      this.advanceStairwell(st);
    }
  }

  /**
   * One discrete loop: draw how many flights this landing steals (seeded,
   * so replays of the same timeline loop identically), bump the progress
   * counter, and recompute the player's position from that counter alone.
   */
  private advanceStairwell(st: StairwellState): void {
    const pos = this.host.playerPosition();
    const rr = new RNG(hash2i(st.progress, Math.round((pos.x + pos.z) * 8), this.seed ^ STAIR_SALT));
    st.progress += rr.chance(0.35) ? 2 : 1;
    if (this.host.repositionFromProgress) this.host.repositionFromProgress(st.progress);
  }

  /** End the episode; geometry returns to its honest arrangement. */
  private disarmStairwell(): void {
    this.stair = { active: false, progress: 0, consumedAway: 0 };
  }

  // ---- migrating lights ----

  /** Detach the nearest alive fixture and start it drifting. */
  private trySpawnMigrant(): boolean {
    if (this.migrant) return true;
    const now = this.host.elapsed();
    const verdict = this.gate('migrating-lights', now);
    if (!verdict.allowed) return false;
    const pos = this.host.playerPosition();
    const src = this.host.nearestAliveFixture(pos.x, pos.z, MIGRANT_SOURCE_RANGE);
    if (!src) return false;
    this.markFired('migrating-lights', now);
    const rr = new RNG(hash2i(Math.round(src.x * 4), Math.round(src.z * 4), this.seed ^ 0x71c7));
    const m: Migrant = {
      sourceKey: src.key,
      x: src.x, z: src.z,
      side: rr.chance(0.5) ? 1 : -1,
      age: 0,
      life: rr.range(MIGRANT_LIFE_MIN, MIGRANT_LIFE_MAX),
      frozen: false,
      wpT: 0,
      wpDur: 1.6,
      wx: src.x, wz: src.z,
    };
    this.pickWaypoint(m, rr);
    this.migrant = m;
    return true;
  }

  /** Next drift target: the player's flank at a radius that shrinks over the light's life. */
  private pickWaypoint(m: Migrant, rr: RNG): void {
    const pos = this.host.playerPosition();
    const yaw = this.host.playerYaw();
    const fxc = -Math.sin(yaw), fzc = -Math.cos(yaw);
    const ang = m.side * rr.range(1.05, 1.92); // 60..110 degrees off facing
    const rx = fxc * Math.cos(ang) - fzc * Math.sin(ang);
    const rz = fxc * Math.sin(ang) + fzc * Math.cos(ang);
    const k = Math.min(1, m.age / m.life);
    const radius = 9 - 6.5 * k;
    m.wx = pos.x + rx * radius;
    m.wz = pos.z + rz * radius;
  }

  private migrantUpdate(dt: number): void {
    if (!this.migrant) {
      if (!this.armed || this.host.blackoutActive()) return;
      this.migrantRetryAcc += dt;
      if (this.migrantRetryAcc >= 5) {
        this.migrantRetryAcc = 0;
        this.trySpawnMigrant();
      }
      return;
    }
    const m = this.migrant;
    m.age += dt;
    const pos = this.host.playerPosition();
    const tox = m.x - pos.x, toz = m.z - pos.z;
    const dist = Math.hypot(tox, toz) || 1;
    const yaw = this.host.playerYaw();
    // looked at dead-on: the light freezes in place until attention wanders
    const facingDot = (-Math.sin(yaw) * tox - Math.cos(yaw) * toz) / dist;
    m.frozen = dist < 26 && facingDot > Math.cos(MIGRANT_FREEZE_CONE);
    if (!m.frozen) {
      const mdx = m.wx - m.x, mdz = m.wz - m.z;
      const ml = Math.hypot(mdx, mdz);
      if (ml > 0.001) {
        const stepLen = Math.min(ml, MIGRANT_SPEED * dt);
        m.x += (mdx / ml) * stepLen;
        m.z += (mdz / ml) * stepLen;
      }
      m.wpT += dt;
      if (ml < 0.15 || m.wpT >= m.wpDur) {
        m.wpT = 0;
        m.wpDur = 1.4 + rand2(Math.round(m.wx), Math.round(m.wz), this.seed ^ 0x77ab) * 0.8;
        this.pickWaypoint(m, new RNG(hash2i(Math.round(m.wx), Math.round(m.wz), this.seed ^ 0x77ac)));
      }
    }
    const remain = m.life - m.age;
    if (remain <= 0 || this.host.blackoutActive()) {
      this.host.setGhostLight(m.x, 2.86, 0);
      this.migrant = null;
      return;
    }
    const fade = Math.min(1, remain / 1.5);
    const pulse = 0.85 + 0.15 * Math.sin(this.host.elapsed() * 7);
    this.host.setGhostLight(m.x, 2.86, 1.5 * fade * pulse * (m.frozen ? 1.12 : 1));
  }
}

/** Angle between the player's facing and a corridor axis (radians, 0 = aligned). */
export function facingDeviation(axis: 0 | 1, dir: -1 | 1, yaw: number): number {
  const fxv = -Math.sin(yaw), fzv = -Math.cos(yaw);
  const ax = axis === 0 ? dir : 0;
  const az = axis === 1 ? dir : 0;
  return Math.acos(Math.max(-1, Math.min(1, fxv * ax + fzv * az)));
}
