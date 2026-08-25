/**
 * Horror Director.
 * Controls pacing: long calm periods, slow builds, rare peaks.
 *
 * Determinism: every pacing draw (phase durations, per-frame probability
 * rolls) comes from one persistent stream derived from the run seed, so two
 * directors built with the same seed take identical phase paths under an
 * identical update(dt) timeline.
 *
 * F90 consume: the host can push DirectorLearning.suggestPhaseBias() weights
 * through setFearBias(); learned fear then leans exactly two pacing sites —
 * the calm→build duration and the build→peak coin — by scaling/shifting
 * already-drawn values (no new RNG draws). Unfed directors keep the exact
 * legacy curves.
 */
import { RNG } from '../core/rng';
import { Emitter } from '../core/events';
import { adjustIntensity, adjustPhase, windowEventChance, type Temperament } from './persona';

/**
 * Salt separating the director's persistent phase/pacing stream from other
 * seed-derived streams (echo footsteps, build-transition rolls) that hash
 * the raw seed against elapsed time.
 */
const PHASE_STREAM_SALT = 0x0dd1f33d >>> 0;

// ---------------------------------------------------------------------------
// F90 consume: learned-fear pacing bias
// ---------------------------------------------------------------------------

/** Learned-fear level meaning "no evidence either way" (uniform baseline). */
export const FEAR_LEVEL_NEUTRAL = 0.5;

/**
 * F90 consume: aggregate DirectorLearning.suggestPhaseBias() tag weights
 * into one scalar level in [0, 1]. The mean of the finite weights (each
 * clamped into [0, 1] first); null/empty/all-junk input falls back to the
 * uniform neutral baseline. Pure arithmetic — no RNG, no wall clock.
 */
export function fearLevelFromWeights(weights: Record<string, number> | null | undefined): number {
  if (!weights) return FEAR_LEVEL_NEUTRAL;
  let sum = 0;
  let n = 0;
  for (const v of Object.values(weights)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sum += Math.min(1, Math.max(0, v));
    n++;
  }
  return n === 0 ? FEAR_LEVEL_NEUTRAL : sum / n;
}

/**
 * Signed fear in [-1, 1]: positive = these contexts scare this player,
 * negative = they bore this player. Junk levels fall back to neutral.
 */
function signedFear(level: number): number {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : FEAR_LEVEL_NEUTRAL;
  return (l - FEAR_LEVEL_NEUTRAL) * 2;
}

/**
 * How far learned fear swings the calm→build duration either way: fully
 * feared runs build at 0.7× the drawn duration, fully bored at 1.3×.
 */
export const FEAR_BUILD_DUR_SPAN = 0.3;

/**
 * Calm→build duration multiplier for a learned-fear level: exactly 1 at
 * the neutral baseline, shorter when the player confesses fear (lean in),
 * longer when they confess boredom (back off).
 */
export function fearBuildDurationMul(level: number): number {
  return 1 - signedFear(level) * FEAR_BUILD_DUR_SPAN;
}

/** Legacy build→peak coin before learning leaned on it. */
export const FEAR_PEAK_COIN_BASE = 0.55;

/**
 * How far learned fear swings the build→peak coin either way: fully feared
 * runs peak at 0.75, fully bored at 0.35. Neutral stays exactly legacy.
 */
export const FEAR_PEAK_COIN_SHIFT = 0.2;

/**
 * Build→peak coin chance for a learned-fear level: the legacy 0.55 at the
 * neutral baseline, biased up by confessed fear and down by boredom.
 */
export function fearPeakCoinChance(level: number): number {
  const c = FEAR_PEAK_COIN_BASE + signedFear(level) * FEAR_PEAK_COIN_SHIFT;
  return Math.min(1, Math.max(0, c));
}

export type Phase = 'calm' | 'build' | 'peak' | 'release';

/**
 * Per-run temperament mount (F48). When present, every phase-enter
 * duration routes through persona.adjustPhase, peak tension through a
 * per-peak adjustIntensity draw, and window-event chances through
 * persona.windowEventChance — all over the persona's dedicated pacing
 * stream so same-seed runs replay identically. Omitted (tests, legacy
 * hosts) means exact passthrough of the generic pacing curves.
 */
export interface DirectorPersona {
  /** Run temperament selected by persona.temperamentForRun(seed). */
  temperament: Temperament;
  /** Dedicated stream from persona.pacingRngFor(seed, temperament). */
  pacingRng: RNG;
}

/**
 * Payloads published on HorrorDirector.events under the 'directorEvent'
 * key. A window opens when a build/peak phase begins and closes when the
 * director moves on; the anomaly system (director/anomalies.ts) consumes
 * these requests and decides deterministically what manifests.
 */
export type DirectorEventPayload =
  | { kind: 'window-open'; phase: 'build' | 'peak' }
  | { kind: 'window-close'; phase: 'build' | 'peak' };

export interface DirectorHost {
  lightingStress(v: number): void;
  killNearbyLight(): boolean;
  blackoutPulse(sec: number): void;
  whisperSurge(): void;
  distantThreat(): void;
  nonEuclideanNudge(): void;
  armDoorwayLoop(sec: number): void;
  requestEntitySpawn(kind: 'watcher' | 'wanderer'): void;
  playerPosition(): { x: number; z: number };
  elapsed(): number;

  // Optional phenomena hooks. Hosts may implement any subset; the
  // director degrades gracefully when one is missing.
  /** Blue overlay strength 0..1 for the cold spot phenomenon. */
  setColdSpotTint?(intensity: number): void;
  /** Light temperature boost 0..1 while a false dawn is active. */
  setLightWarmth?(warmth: number): void;
  /** Spatial footstep replay from a unit direction vector. */
  playFootstepEcho?(direction: { x: number; z: number }, volume: number): void;
}

/**
 * Minimal structural view of a transform node (e.g. a Babylon.js
 * Mesh/TransformNode) for the breathing-walls phenomenon.
 */
export interface ScalableNode {
  scaling: { x: number; y: number; z: number };
}

export class HorrorDirector {
  /**
   * Bus carrying 'directorEvent' window-open/window-close requests for
   * the anomaly system. Emitted from enter() on every phase transition.
   */
  readonly events = new Emitter<{ directorEvent: DirectorEventPayload }>();
  phase: Phase = 'calm';
  private phaseT = 0;
  private phaseDur: number;
  tension = 0;
  peaksUsed = 0;

  // --- Phenomena state ---
  /** Wall nodes that breathe during peak phase (see breathingWalls). */
  private breathingNodes: ScalableNode[] = [];
  private breathingBase = new Map<ScalableNode, { x: number; y: number; z: number }>();
  private breathClock = 0;
  private breathApplied = false;
  /** Cold-spot trail of past player positions: sampled ~4x/sec. */
  private coldTrail: { t: number; x: number; z: number }[] = [];
  private coldSampleAcc = 0;
  /** Current cold-spot overlay strength 0..1. */
  coldSpotIntensity = 0;
  /** Radius around each trail point that feels cold. */
  coldSpotRadius = 3;
  /** How long a position lingers in the cold trail. */
  coldSpotTrailSec = 10;
  /** Warm-light boost 0..1 while a false dawn is active. */
  lightWarmth = 0;
  private falseDawnUntil = -1;
  private falseDawnDuration = 8;
  private falseDawnPendingAt = -1;
  /** Last recorded footsteps for echo replay (see noteFootstep). */
  private footstepLog: { running: boolean; t: number }[] = [];
  private echoCountdown = 0;
  private echoQueue: { at: number; running: boolean }[] = [];

  /** Persistent phase/pacing stream; identical seed ⇒ identical pacing. */
  private readonly pacingRng: RNG;

  /** F48: per-run temperament mount; null keeps the generic curves. */
  private readonly persona: DirectorPersona | null;

  /** Consecutive build cycles that ended without a peak (persona context). */
  private noPeakStreak = 0;

  /** Intensity multiplier drawn once at peak entry; 1 without a persona. */
  private peakIntensityMul = 1;

  /**
   * F90 consume: latest learned-fear level aggregated from
   * DirectorLearning.suggestPhaseBias() weights (see fearLevelFromWeights).
   * Neutral until setFearBias is called, so learning-less hosts keep the
   * exact legacy pacing curves.
   */
  private fearBiasLevel = FEAR_LEVEL_NEUTRAL;

  /**
   * @param host Pacing hooks the director drives.
   * @param seed Run seed; all pacing derives from it deterministically.
   * @param rng Optional injected stream (tests); defaults to one derived
   *            from `seed` so same-seed replays are identical.
   * @param persona Optional F48 temperament mount; without it the generic
   *                pacing curves pass through untouched.
   */
  constructor(private host: DirectorHost, private seed: number, rng?: RNG, persona?: DirectorPersona) {
    this.pacingRng = rng ?? new RNG((seed ^ PHASE_STREAM_SALT) >>> 0);
    this.persona = persona ?? null;
    this.phaseDur = this.pacingRng.range(70, 130);
  }

  /**
   * Route one phase-enter duration through the temperament table. Without
   * a persona this is the identity; with one, draws come from the persona's
   * dedicated stream (caller-owned draw order preserved).
   */
  private personaDuration(phase: Phase, baseSec: number): number {
    if (!this.persona) return baseSec;
    return adjustPhase(phase, baseSec, this.persona.temperament, this.persona.pacingRng, {
      safetyStreak: this.noPeakStreak,
    });
  }

  /**
   * Scale a window-event chance through the temperament's window-rate
   * appetite; identity without a persona.
   */
  private personaChance(baseChancePerSec: number): number {
    if (!this.persona) return baseChancePerSec;
    return windowEventChance(baseChancePerSec, this.persona.temperament);
  }

  notifyDiscovery(): void {
    this.tension = Math.min(1, this.tension + 0.15);
  }

  /**
   * F90 consume: feed the director's learned-fear level from
   * DirectorLearning.suggestPhaseBias() weights. Consumed at exactly two
   * sites — the calm→build duration multiplier and the build→peak coin —
   * by scaling already-drawn values and shifting an existing threshold,
   * never by adding RNG draws. Null/undefined resets to the neutral
   * baseline (exact legacy behavior).
   */
  setFearBias(weights: Record<string, number> | null | undefined): void {
    this.fearBiasLevel = fearLevelFromWeights(weights);
  }

  /** Latest learned-fear level in [0, 1]; 0.5 = neutral/unfed. */
  get fearBias(): number {
    return this.fearBiasLevel;
  }

  update(dt: number): void {
    this.phaseT += dt;
    switch (this.phase) {
      case 'calm': {
        this.tension = Math.max(0, this.tension - dt * 0.05);
        if (this.phaseT > this.phaseDur) {
          // F90 consume: learned fear shortens the road into build (lean
          // into what scares THIS player); boredom lengthens it. The
          // multiplier scales the already-drawn base — no new draws.
          this.enter('build', this.personaDuration(
            'build',
            this.pacingRng.range(35, 90) * fearBuildDurationMul(this.fearBiasLevel),
          ));
        }
        break;
      }
      case 'build': {
        this.tension = Math.min(0.75, (this.phaseT / this.phaseDur) * 0.75);
        if (this.pacingRng.chance(this.personaChance(dt * 0.06))) this.host.killNearbyLight();
        if (this.pacingRng.chance(this.personaChance(dt * 0.04))) this.host.distantThreat();
        if (this.phaseT > this.phaseDur) {
          const rng = new RNG((this.seed ^ Math.floor(this.host.elapsed() * 1000)) >>> 0);
          // F90 consume: the build→peak coin leans on the same single draw —
          // confessed fear raises the threshold toward peak, boredom lowers
          // it. Neutral bias keeps the exact legacy 0.55.
          if (rng.chance(fearPeakCoinChance(this.fearBiasLevel))) {
            this.enter('peak', this.personaDuration('peak', 12 + rng.next() * 14));
          } else this.enter('release', this.personaDuration('release', 40 + rng.next() * 50));
        }
        break;
      }
      case 'peak': {
        // F48: peak tension runs through the per-peak intensity multiplier
        // drawn at enter('peak'); clamped to the same 0..1 proxy range.
        this.tension = Math.min(1, Math.max(0, this.peakIntensityMul * (0.85 + Math.sin(this.phaseT * 3) * 0.1)));
        if (this.phaseT < dt * 2) {
          const blackoutSec = this.pacingRng.range(3, 8);
          this.host.blackoutPulse(blackoutSec);
          // When this blackout lifts, the lights come back warm (falseDawn).
          this.falseDawnPendingAt = this.host.elapsed() + blackoutSec;
          this.host.requestEntitySpawn('watcher');
          if (this.pacingRng.chance(this.personaChance(0.35))) this.host.nonEuclideanNudge();
          if (this.pacingRng.chance(this.personaChance(0.4))) this.host.armDoorwayLoop(75);
        }
        if (this.pacingRng.chance(this.personaChance(dt * 0.2))) this.host.whisperSurge();
        if (this.phaseT > this.phaseDur) {
          this.enter('release', this.personaDuration('release', this.pacingRng.range(50, 120)));
        }
        break;
      }
      case 'release': {
        this.tension = Math.max(0, 0.4 - this.phaseT * 0.05);
        if (this.phaseT > this.phaseDur) {
          this.enter('calm', this.personaDuration('calm', this.pacingRng.range(60, 140)));
        }
        break;
      }
    }
    // --- phenomena drivers ---
    if (this.phase === 'peak') this.breathClock += dt;
    this.breathingWalls();
    this.coldSpot(dt);
    this.echoFootsteps(dt);
    this.falseDawnUpdate();
    this.host.lightingStress(this.phase === 'calm' ? this.tension * 0.3 : this.tension);
  }

  private enter(p: Phase, dur: number): void {
    const prev = this.phase;
    if (p === 'peak') {
      this.peaksUsed++;
      // F48: one intensity draw per peak, reused for the whole peak so
      // tension stays smooth instead of re-rolling every frame.
      this.peakIntensityMul = this.persona
        ? adjustIntensity(1, 'peak', this.persona.temperament, this.persona.pacingRng)
        : 1;
      this.noPeakStreak = 0;
    } else if (prev === 'build' && p === 'release') {
      // F48: a build that resolved without a peak grows the vindictive
      // safety streak feeding the next build's compression.
      this.noPeakStreak++;
    }
    this.phase = p;
    this.phaseT = 0;
    this.phaseDur = dur;
    if (p === 'build' || p === 'peak') {
      this.events.emit('directorEvent', { kind: 'window-open', phase: p });
    } else if (prev === 'build' || prev === 'peak') {
      this.events.emit('directorEvent', { kind: 'window-close', phase: prev });
    }
  }

  // ==================== PHENOMENA ====================

  /**
   * Register the wall nodes that breathe during peak phase. Call once
   * after level construction; update() drives breathingWalls() for you.
   */
  registerBreathingWalls(nodes: ScalableNode[]): void {
    this.breathingBase.clear();
    for (const n of nodes) {
      this.breathingBase.set(n, { x: n.scaling.x, y: n.scaling.y, z: n.scaling.z });
    }
    this.breathingNodes = nodes.slice();
    this.breathApplied = false;
  }

  /**
   * PHENOMENON — Breathing Walls.
   * During peak phase the registered walls subtly expand/contract:
   * each node oscillates a few percent around its captured base scale.
   * When the peak ends, every node is snapped back to base exactly once.
   */
  private breathingWalls(): void {
    const peak = this.phase === 'peak';
    let stillDeformed = false;
    for (const n of this.breathingNodes) {
      const base = this.breathingBase.get(n);
      if (!base) continue;
      if (peak) {
        const s = 1 + Math.sin(this.breathClock * 1.7) * 0.03;
        n.scaling.x = base.x * s;
        n.scaling.y = base.y * (2 - s); // rough volume compensation
        n.scaling.z = base.z * s;
        stillDeformed = true;
      } else if (this.breathApplied) {
        n.scaling.x = base.x;
        n.scaling.y = base.y;
        n.scaling.z = base.z;
      }
    }
    this.breathApplied = stillDeformed;
  }

  /**
   * PHENOMENON — Cold Spot.
   * Samples the player position ~4x/sec into a short trail; while any
   * trail point sits within coldSpotRadius of the player the overlay
   * strength rises toward 1, and it decays back to 0 once they leave.
   * The host tint hook is optional; intensity is always published on
   * coldSpotIntensity for debug readouts.
   */
  private coldSpot(dt: number): void {
    const now = this.host.elapsed();
    const pos = this.host.playerPosition();
    this.coldSampleAcc += dt;
    if (this.coldSampleAcc >= 0.25) {
      this.coldSampleAcc = 0;
      this.coldTrail.push({ t: now, x: pos.x, z: pos.z });
    }
    while (this.coldTrail.length > 0 && now - this.coldTrail[0].t > this.coldSpotTrailSec) {
      this.coldTrail.shift();
    }
    let target = 0;
    for (const pt of this.coldTrail) {
      const d = Math.hypot(pt.x - pos.x, pt.z - pos.z);
      if (d < this.coldSpotRadius) target = Math.max(target, 1 - d / this.coldSpotRadius);
    }
    // ease toward the target so the tint never pops between samples
    this.coldSpotIntensity += (target - this.coldSpotIntensity) * Math.min(1, dt * 3);
    if (this.coldSpotIntensity < 0.005) this.coldSpotIntensity = 0;
    this.host.setColdSpotTint?.(this.coldSpotIntensity);
  }

  /**
   * Record one of the player's own footsteps for later echo replay
   * (see echoFootsteps). Keeps a short rolling log only.
   */
  noteFootstep(running: boolean): void {
    this.footstepLog.push({ running, t: this.host.elapsed() });
    if (this.footstepLog.length > 32) this.footstepLog.shift();
  }

  /**
   * PHENOMENON — Footstep Echo.
   * A few seconds into release after a peak, occasionally replays a burst
   * of the player's recent steps as if someone just behind were walking:
   * playFootstepEcho receives a unit direction and a per-step volume.
   * All draws come from seed-derived RNG instances so replays of the same
   * timeline echo identically.
   */
  private echoFootsteps(dt: number): void {
    const now = this.host.elapsed();
    // Fire any due queued echoes; each step gets its own direction draw.
    while (this.echoQueue.length > 0 && this.echoQueue[0].at <= now) {
      const step = this.echoQueue.shift()!;
      if (!this.host.playFootstepEcho) continue;
      const rng = new RNG((this.seed ^ Math.floor(step.at * 1000)) >>> 0);
      const a = rng.next() * Math.PI * 2;
      this.host.playFootstepEcho({ x: Math.cos(a), z: Math.sin(a) }, step.running ? 0.5 : 0.35);
    }
    // Arm an echo occasionally while unwinding after a peak.
    if (this.echoQueue.length === 0 && this.echoCountdown <= 0) {
      if (this.phase !== 'release' || this.peaksUsed === 0 || this.footstepLog.length < 4) return;
      const rng = new RNG((this.seed ^ Math.floor(now * 131)) >>> 0);
      if (rng.chance(dt * 0.05)) this.echoCountdown = 3 + rng.next() * 5;
      return;
    }
    if (this.echoCountdown > 0) {
      this.echoCountdown -= dt;
      if (this.echoCountdown > 0) return;
      const rng = new RNG((this.seed ^ Math.floor(now * 977)) >>> 0);
      const count = Math.min(this.footstepLog.length, 5 + rng.int(0, 4));
      let at = now + 0.8; // slight delay before the first borrowed step
      for (let i = 0; i < count; i++) {
        at += this.footstepLog[i].running ? 0.32 : 0.45;
        this.echoQueue.push({ at, running: this.footstepLog[i].running });
      }
    }
  }

  /**
   * PHENOMENON — False Dawn.
   * When a peak's blackout lifts (falseDawnPendingAt reached), light comes
   * back too warm for falseDawnDuration seconds. Warmth ramps in over the
   * first second and eases out across the rest of the window; setLightWarmth
   * drives the host's color grading and lightWarmth mirrors it for saves/UI.
   */
  private falseDawnUpdate(): void {
    const now = this.host.elapsed();
    if (this.falseDawnUntil < 0 && this.falseDawnPendingAt >= 0 && now >= this.falseDawnPendingAt) {
      this.falseDawnPendingAt = -1;
      this.falseDawnUntil = now + this.falseDawnDuration;
    }
    if (this.falseDawnUntil < 0) return;
    const remain = this.falseDawnUntil - now;
    if (remain <= 0) {
      this.falseDawnUntil = -1;
      this.lightWarmth = 0;
      this.host.setLightWarmth?.(0);
      return;
    }
    const gone = this.falseDawnDuration - remain;
    const attack = Math.min(1, gone);
    const release = Math.min(1, remain / (this.falseDawnDuration * 0.6));
    this.lightWarmth = attack * release;
    this.host.setLightWarmth?.(this.lightWarmth);
  }

  describe(): string {
    return this.phase + ' t=' + this.tension.toFixed(2);
  }
}


