/**
 * Horror Director.
 * Controls pacing: long calm periods, slow builds, rare peaks.
 */
import { RNG } from '../core/rng';
import { Emitter } from '../core/events';

export type Phase = 'calm' | 'build' | 'peak' | 'release';

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
  private phaseDur = 70 + Math.random() * 60;
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

  constructor(private host: DirectorHost, private seed: number) {}

  notifyDiscovery(): void {
    this.tension = Math.min(1, this.tension + 0.15);
  }

  update(dt: number): void {
    this.phaseT += dt;
    switch (this.phase) {
      case 'calm': {
        this.tension = Math.max(0, this.tension - dt * 0.05);
        if (this.phaseT > this.phaseDur) this.enter('build', 35 + Math.random() * 55);
        break;
      }
      case 'build': {
        this.tension = Math.min(0.75, (this.phaseT / this.phaseDur) * 0.75);
        if (Math.random() < dt * 0.06) this.host.killNearbyLight();
        if (Math.random() < dt * 0.04) this.host.distantThreat();
        if (this.phaseT > this.phaseDur) {
          const rng = new RNG((this.seed ^ Math.floor(this.host.elapsed() * 1000)) >>> 0);
          if (rng.chance(0.55)) this.enter('peak', 12 + rng.next() * 14);
          else this.enter('release', 40 + rng.next() * 50);
        }
        break;
      }
      case 'peak': {
        this.tension = 0.85 + Math.sin(this.phaseT * 3) * 0.1;
        if (this.phaseT < dt * 2) {
          const blackoutSec = 3 + Math.random() * 5;
          this.host.blackoutPulse(blackoutSec);
          // When this blackout lifts, the lights come back warm (falseDawn).
          this.falseDawnPendingAt = this.host.elapsed() + blackoutSec;
          this.host.requestEntitySpawn('watcher');
          if (Math.random() < 0.35) this.host.nonEuclideanNudge();
          if (Math.random() < 0.4) this.host.armDoorwayLoop(75);
        }
        if (Math.random() < dt * 0.2) this.host.whisperSurge();
        if (this.phaseT > this.phaseDur) this.enter('release', 50 + Math.random() * 70);
        break;
      }
      case 'release': {
        this.tension = Math.max(0, 0.4 - this.phaseT * 0.05);
        if (this.phaseT > this.phaseDur) this.enter('calm', 60 + Math.random() * 80);
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
    if (p === 'peak') this.peaksUsed++;
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


