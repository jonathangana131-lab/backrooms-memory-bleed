/**
 * Horror Director.
 * Controls pacing: long calm periods, slow builds, rare peaks.
 */
import { RNG } from '../core/rng';

export type Phase = 'calm' | 'build' | 'peak' | 'release';

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
    if (p === 'peak') this.peaksUsed++;
    this.phase = p;
    this.phaseT = 0;
    this.phaseDur = dur;
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


