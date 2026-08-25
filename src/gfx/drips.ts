/**
 * Ceiling water drips - the wet rooms leak.
 *
 * In chunks that already have floor puddles (layout.puddles non-empty), the
 * caller registers ceiling stain positions; each registered point sheds a
 * small elongated drop every 3-8 s. The drop falls from the ceiling to the
 * floor, and on impact a tiny ring quad expands and fades over 0.4 s while a
 * short filtered "plink" (sine pitch drop 800 -> 400 Hz, ~80 ms) plays,
 * attenuated by distance and panned toward the drip position.
 *
 * Performance contract:
 *  - at most MAX_ACTIVE drips animate simultaneously (6 preallocated drop +
 *    splash mesh slots, reused - never created/disposed per drip);
 *  - drip points farther than ACTIVATE_DIST from the player do not count
 *    down or spawn: nothing animates when nobody can see it;
 *  - zero steady-state allocation: all state lives in preallocated records;
 *  - audio degrades gracefully: with no AudioContext (or a suspended one)
 *    the visuals run silent.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

/** Ceiling height (matches world/constants WALL_H); drops start here. */
export const CEIL_Y = 3.05;
/** Floor plane the drops land on. */
export const FLOOR_Y = 0;
/** Simultaneously animating drip cap. */
export const MAX_ACTIVE = 6;
/** Player distance beyond which the whole system idles. */
export const ACTIVATE_DIST = 20;
/** Ring expansion lifetime in seconds. */
export const SPLASH_DURATION = 0.4;
/** Constant fall speed in m/s (~0.44 s for the full 3.05 m drop). */
export const FALL_SPEED = 7;
/** Seconds between drips at one stain point (randomized uniform range). */
export const INTERVAL_MIN = 3;
export const INTERVAL_MAX = 8;

/**
 * Salt separating this system's interval draw stream from every other seeded
 * consumer of a run seed (mirrors the XOR-salt pattern of HumHarmonics'
 * HUM_SEED_SALT / EntityVocals' ctor seed).
 */
export const DRIP_SEED_SALT = 0x64726970; // 'drip'

// --- mirrored deterministic helpers (tiledisplace.ts precedent: local copies
// --- of src/core/rng.ts so the module stays dependency-free under direct
// --- node strip-types test imports; algorithms identical to the RNG law) ----

function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  const hl = (v: number): number => {
    v |= 0;
    v = Math.imul(v ^ (v >>> 16), 0x85ebca6b);
    v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
    return (v ^ (v >>> 16)) >>> 0;
  };
  h = Math.imul(h ^ hl(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hl(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Sequential draw stream, algorithm-identical to src/core/rng.ts RNG. */
class RngStream {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

interface DripPoint {
  x: number;
  z: number;
  /** Countdown to next drop; only ticks while the player is near. */
  nextIn: number;
}

interface Slot {
  /** Elapsed seconds since this drip started; < 0 while idle. */
  t: number;
  x: number;
  z: number;
}

/** Inverse-square-ish attenuation: unity within REF m, falls off beyond. */
function rolloff(dist: number): number {
  const REF = 5;
  if (!(dist >= REF)) return Number.isNaN(dist) ? 0 : 1;
  const r = REF / dist;
  return r * r;
}

const seedFor = (runSeed: number): number => ((runSeed | 0) ^ DRIP_SEED_SALT) >>> 0;

export class CeilingDrips {
  private points: DripPoint[] = [];
  private dropMeshes: Mesh[] = [];
  private splashMeshes: Mesh[] = [];
  private slots: Slot[] = [];
  private splashes: Slot[] = [];
  private active = 0;
  private stopped = false;
  private ctx: AudioContext | null;
  /** Node plink voices terminate into; null = the ctx's own destination. */
  private destination: AudioNode | null = null;

  /**
   * Deterministic draw stream for drip intervals. The legacy module drew
   * from Math.random (both call sites: initial registration and post-spawn
   * re-roll), which broke the repo's determinism law; both now draw here.
   * seed=0 keeps direct-constructed instances on a fixed, documented stream.
   */
  private rng: RngStream;
  /** Construction seed, reused by reset() when it gets no usable runSeed. */
  private readonly baseSeed: number;

  constructor(scene: Scene, ctx?: AudioContext, seed = 0) {
    this.ctx = ctx ?? null;
    this.baseSeed = seed | 0;
    this.rng = new RngStream(seedFor(this.baseSeed));

    // ---- shared materials ----
    const dropMat = new StandardMaterial('dripDropMat', scene);
    dropMat.emissiveColor = new Color3(0.5, 0.62, 0.68);
    dropMat.diffuseColor = new Color3(0, 0, 0);
    dropMat.specularColor = new Color3(0, 0, 0);
    dropMat.disableLighting = true;
    dropMat.alpha = 0.85;

    const splashMat = new StandardMaterial('dripSplashMat', scene);
    splashMat.emissiveColor = new Color3(0.55, 0.66, 0.72);
    splashMat.diffuseColor = new Color3(0, 0, 0);
    splashMat.specularColor = new Color3(0, 0, 0);
    splashMat.disableLighting = true;
    splashMat.backFaceCulling = false;
    const ring = new DynamicTexture('dripRing', { width: 64, height: 64 }, scene, false);
    const c = ring.getContext();
    c.clearRect(0, 0, 64, 64);
    c.strokeStyle = 'rgba(205,225,235,1)';
    c.lineWidth = 5;
    c.beginPath();
    c.arc(32, 32, 22, 0, Math.PI * 2);
    c.stroke();
    ring.update();
    ring.hasAlpha = true;
    splashMat.opacityTexture = ring;

    // ---- preallocated mesh pool ----
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const drop = MeshBuilder.CreateBox('dripDrop' + i, { width: 0.03, height: 0.16, depth: 0.03 }, scene);
      drop.material = dropMat;
      drop.isVisible = false;
      this.dropMeshes.push(drop);

      const splash = MeshBuilder.CreatePlane('dripSplash' + i, { size: 1 }, scene);
      splash.material = splashMat;
      splash.rotation.x = Math.PI / 2; // lie flat on the floor
      splash.isVisible = false;
      this.splashMeshes.push(splash);

      this.slots.push({ t: -1, x: 0, z: 0 });
      this.splashes.push({ t: -1, x: 0, z: 0 });
    }
  }

  /** Currently falling or impacting drip count. */
  get activeCount(): number {
    return this.active;
  }

  /** Seeded uniform interval draw — both former Math.random sites use it. */
  private randInterval(): number {
    return this.rng.range(INTERVAL_MIN, INTERVAL_MAX);
  }

  /**
   * Bind (or rebind) the plink voice output. Called once audio is live so
   * the splash sound rides the caller's bus instead of being hardwired to
   * ctx.destination (ambience-bus authority rule). Passing no destination
   * falls back to the ctx's own destination.
   */
  attachAudio(ctx: AudioContext, destination?: AudioNode): void {
    this.ctx = ctx;
    this.destination = destination ?? ctx.destination;
  }

  /** Registered ceiling stain points. */
  get pointCount(): number {
    return this.points.length;
  }

  /**
   * Track one ceiling stain as a drip source. Callers should register stains
   * only from chunks whose layout.puddles is non-empty - no puddle, no
   * audible splash. Registration beyond 96 points is ignored.
   */
  registerStain(x: number, z: number): void {
    if (this.points.length >= 96) return;
    this.points.push({ x, z, nextIn: this.randInterval() });
  }

  /**
   * Advance the simulation. px, pz is the player ground position.
   * Everything freezes when no registered point is within ACTIVATE_DIST.
   */
  update(dt: number, px: number, pz: number): void {
    if (this.stopped || dt <= 0) return;
    if (dt > 0.1) dt = 0.1; // tab-back spike guard

    const r2 = ACTIVATE_DIST * ACTIVATE_DIST;
    let anyNear = false;

    // --- scheduling ---
    for (const p of this.points) {
      const dx = p.x - px;
      const dz = p.z - pz;
      if (dx * dx + dz * dz > r2) continue;
      anyNear = true;
      p.nextIn -= dt;
      if (p.nextIn <= 0 && this.active < MAX_ACTIVE) {
        p.nextIn = this.randInterval();
        this.spawn(p.x, p.z);
      }
    }
    if (!anyNear && this.active === 0) return; // fully idle

    // --- falling drops ---
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const s = this.slots[i];
      if (s.t < 0) continue;
      s.t += dt;
      const y = CEIL_Y - FALL_SPEED * s.t;
      const mesh = this.dropMeshes[i];
      if (y <= FLOOR_Y) {
        // impact -> hand the slot to its splash
        mesh.isVisible = false;
        s.t = -1;
        this.active--;
        const sp = this.splashes[i];
        sp.t = 0;
        sp.x = s.x;
        sp.z = s.z;
        const sm = this.splashMeshes[i];
        sm.position.x = s.x;
        sm.position.y = FLOOR_Y + 0.02;
        sm.position.z = s.z;
        sm.scaling.x = 0.12;
        sm.scaling.y = 0.12;
        sm.isVisible = true;
        sm.visibility = 0.7;
        this.plink(s.x, s.z, px, pz);
      } else {
        mesh.position.x = s.x;
        mesh.position.y = y + 0.08; // box center rides half its height above the tip
        mesh.position.z = s.z;
      }
    }

    // --- expanding rings ---
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const sp = this.splashes[i];
      if (sp.t < 0) continue;
      sp.t += dt;
      const p = sp.t / SPLASH_DURATION;
      if (p >= 1) {
        this.splashMeshes[i].isVisible = false;
        sp.t = -1;
        continue;
      }
      const sm = this.splashMeshes[i];
      const size = 0.12 + p * 0.55; // expand toward ~2x puddle-shimmer width
      sm.scaling.x = size;
      sm.scaling.y = size;
      sm.visibility = 0.7 * (1 - p) * (1 - p);
    }
  }

  /** Claim an idle slot for a fresh drop. Assumes a slot is free. */
  private spawn(x: number, z: number): void {
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const s = this.slots[i];
      if (s.t >= 0) continue;
      s.t = 0;
      s.x = x;
      s.z = z;
      const mesh = this.dropMeshes[i];
      mesh.position.x = x;
      mesh.position.y = CEIL_Y;
      mesh.position.z = z;
      mesh.isVisible = true;
      this.active++;
      return;
    }
  }

  /**
   * The plink: sine oscillator sweeping 800 -> 400 Hz over 80 ms through a
   * fast decay envelope, inverse-square distance attenuation, stereo-panned
   * by the drip horizontal offset from the listener. Silent without a
   * running AudioContext.
   */
  private plink(x: number, z: number, px: number, pz: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const dx = x - px;
    const dz = z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist > ACTIVATE_DIST) return;
    const vol = 0.14 * rolloff(dist);
    const pan = Math.max(-1, Math.min(1, dist > 0.001 ? dx / dist : 0)) * 0.8;

    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(800, t);
    o.frequency.exponentialRampToValueAtTime(400, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.destination ?? ctx.destination);
    o.start(t);
    o.stop(t + 0.14);
  }

  /**
   * Re-arm the system for a fresh expedition. Unlike stop() (terminal by
   * contract), reset() un-stops: every timer, splash and registered point is
   * cleared, the pooled meshes hide, and — when a usable runSeed arrives —
   * the interval stream reseeds off (runSeed ^ DRIP_SEED_SALT) so a run
   * replays its drip cadence byte-identically. Non-finite runSeeds fall back
   * to the construction seed (junk falls safe).
   */
  reset(runSeed?: number): void {
    this.stopped = false;
    this.active = 0;
    this.points.length = 0;
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const mesh = this.dropMeshes[i];
      if (mesh) mesh.isVisible = false;
      const sm = this.splashMeshes[i];
      if (sm) sm.isVisible = false;
      this.slots[i].t = -1;
      this.splashes[i].t = -1;
    }
    const s = Number.isFinite(runSeed) ? (runSeed as number) : this.baseSeed;
    this.rng = new RngStream(seedFor(s));
  }

  /**
   * Halt everything: hide all pooled meshes, clear timers, ignore future
   * updates. Audio tails decay out naturally on their own nodes.
   */
  stop(): void {
    this.stopped = true;
    for (let i = 0; i < MAX_ACTIVE; i++) {
      this.dropMeshes[i].isVisible = false;
      this.splashMeshes[i].isVisible = false;
      this.slots[i].t = -1;
      this.splashes[i].t = -1;
    }
    this.active = 0;
    this.points.length = 0;
  }
}
