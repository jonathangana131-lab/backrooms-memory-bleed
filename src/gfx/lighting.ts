/**
 * Lighting rig: dim ambient, pooled point lights bound to nearby fixtures,
 * flicker simulation, glow and post-processing.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { rand2 } from '../core/rng';
import { fixtureDeadRef } from './materials';

const POOL = 14;

/**
 * Per-district fog base colours (blended, not uniform):
 * MAZE warmer amber / OPEN_OFFICE neutral / HONEYCOMB yellowish /
 * CORRIDOR_GRID cool gray / STORAGE dark industrial brown.
 */
const DISTRICT_FOG_COLORS: Color3[] = [
  new Color3(0.105, 0.080, 0.032), // 0 MAZE
  new Color3(0.082, 0.080, 0.074), // 1 OPEN_OFFICE
  new Color3(0.098, 0.092, 0.026), // 2 HONEYCOMB
  new Color3(0.066, 0.072, 0.082), // 3 CORRIDOR_GRID
  new Color3(0.062, 0.049, 0.031), // 4 STORAGE
];

/** Weather-front tints whose fronts are wet-memory zones (TRANSIT / HOSPITAL). */
const WET_TINTS: [number, number, number][] = [[0.92, 0.94, 1.0], [0.88, 0.97, 1.04]];

/**
 * Screen-space rain: a fixed-position div overlay of thin animated lines
 * falling under a CSS keyframe animation. Pure DOM/CSS - no shader, no
 * assets. Sits above the canvas but below UI chrome; opacity is kept at
 * a whisper (0.03) so it reads as memory-weather, not weather.
 */
class ScreenRain {
  private root: HTMLDivElement | null = null;

  private ensure(): void {
    if (this.root || typeof document === 'undefined') return;
    const styleId = 'bmb-rain-style';
    if (!document.getElementById(styleId)) {
      const st = document.createElement('style');
      st.id = styleId;
      st.textContent =
        '@keyframes bmbRainFall{from{transform:translate3d(2vw,-24vh,0)}' +
        'to{transform:translate3d(-5vw,116vh,0)}}';
      document.head.appendChild(st);
    }
    const root = document.createElement('div');
    root.id = 'bmb-rain-overlay';
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:40;' +
      'opacity:0.03;overflow:hidden;display:none;';
    for (let i = 0; i < 44; i++) {
      const drop = document.createElement('div');
      const len = 70 + Math.random() * 80; // thin streaks
      drop.style.cssText =
        'position:absolute;top:-26vh;width:1px;height:' + len.toFixed(0) + 'px;' +
        'background:linear-gradient(to bottom,rgba(190,212,255,0),rgba(190,212,255,0.95));' +
        'left:' + (Math.random() * 100).toFixed(1) + 'vw;' +
        'animation:bmbRainFall ' + (0.55 + Math.random() * 0.75).toFixed(2) + 's linear infinite;' +
        'animation-delay:-' + (Math.random() * 2).toFixed(2) + 's;';
      root.appendChild(drop);
    }
    document.body.appendChild(root);
    this.root = root;
  }

  set(wet: boolean): void {
    if (wet) this.ensure();
    if (this.root) this.root.style.display = wet ? 'block' : 'none';
  }
}

function tintMatches(mul: [number, number, number], t: [number, number, number]): boolean {
  return Math.abs(mul[0] - t[0]) < 0.004
    && Math.abs(mul[1] - t[1]) < 0.004
    && Math.abs(mul[2] - t[2]) < 0.004;
}

interface PoolLight {
  light: PointLight;
  fixtureKey: string;
  baseIntensity: number;
  flicker: number;
  seedX: number;
  seedZ: number;
  phase: number;
}

export class LightingRig {
  private hemi: HemisphericLight;
  private pool: PoolLight[] = [];
  private pipeline: DefaultRenderingPipeline;
  /** global flicker stress 0..1 raises anomaly behaviour */
  public stressLevel = 0;

  constructor(private scene: Scene) {
    this.hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene);
    this.hemi.intensity = 0.85;
    this.hemi.diffuse = new Color3(1.0, 0.95, 0.78);
    this.hemi.groundColor = new Color3(0.18, 0.14, 0.07);

    for (let i = 0; i < POOL; i++) {
      const l = new PointLight('pl' + i, new Vector3(0, -100, 0), scene);
      l.range = 13.5;
      l.diffuse = new Color3(1.0, 0.94, 0.72);
      l.intensity = 0;
      this.pool.push({ light: l, fixtureKey: '', baseIntensity: 0, flicker: 0, seedX: 0, seedZ: 0, phase: Math.random() * 100 });
    }

    const glow = new GlowLayer('glow', scene, { mainTextureFixedSize: 512, blurKernelSize: 48 });
    glow.intensity = 0.75;

    this.pipeline = new DefaultRenderingPipeline('pipeline', true, scene, []);


    this.pipeline.fxaaEnabled = true;
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.55;
    this.pipeline.bloomWeight = 0.28;
    this.pipeline.bloomKernel = 48;
    const ip = this.pipeline.imageProcessing;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.55;
    ip.vignetteStretch = 0.5;
    ip.vignetteCameraFov = 1.3;
    const grainCfg = this.scene.imageProcessingConfiguration as unknown as Record<string, number | boolean>;
    grainCfg.grainEnabled = true;
    grainCfg.grainIntensity = 9;
    grainCfg.grainAnimated = true;
    ip.toneMappingEnabled = true;
    ip.exposure = 1.32;
    ip.contrast = 1.18;

    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.028;
    scene.fogColor = new Color3(0.086, 0.072, 0.034);
  }

  attachToCamera(cam: Camera): void {
    this.pipeline.addCamera(cam);
  }

  private baseFog = new Color3(0.086, 0.072, 0.034);
  private baseHemi = new Color3(1.0, 0.95, 0.78);

  private targetFogDensity = 0.028;

  // ---- district fog blending -------------------------------------------
  // Fog colour is not uniform per district: it blends across district
  // boundaries. Crossing into a new district starts a cross-fade from the
  // colour mix you were seeing toward the new district's colour, so the air
  // shifts gradually with distance from the boundary instead of snapping.
  // (Time-since-crossing is used as the blend axis - at walking pace it
  // tracks metres-from-boundary closely enough to feel spatial.)
  private curDistrict = -1;
  private fogFrom = DISTRICT_FOG_COLORS[1].clone();
  private fogBlendT = 1;
  /** effective pre-tint fog base; setWeatherTint multiplies this */
  private effectiveFogBase = this.baseFog.clone();
  private tmpFogA = new Color3();

  /** District-driven fog depth + boundary-blended colour per district. */
  setDistrictFog(district: number, dt: number): void {
    const presets = [0.040, 0.021, 0.032, 0.026, 0.046]; // maze/office/honeycomb/corridor/storage
    this.targetFogDensity = presets[district] ?? 0.028;
    const k = Math.min(1, dt * 0.4);
    this.scene.fogDensity += (this.targetFogDensity - this.scene.fogDensity) * k;

    const clamped = district >= 0 && district < DISTRICT_FOG_COLORS.length ? district : 1;
    if (clamped !== this.curDistrict) {
      // boundary crossed: snapshot the current blended colour as the fade source
      if (this.curDistrict >= 0) this.fogFrom.copyFrom(this.effectiveFogBase);
      else this.fogFrom.copyFrom(DISTRICT_FOG_COLORS[clamped]);
      this.curDistrict = clamped;
      this.fogBlendT = 0;
    }
    // ~3.2 s of travel to fully settle after a crossing
    this.fogBlendT = Math.min(1, this.fogBlendT + dt * 0.31);
    const s = this.fogBlendT * this.fogBlendT * (3 - 2 * this.fogBlendT); // smoothstep
    Color3.LerpToRef(this.fogFrom, DISTRICT_FOG_COLORS[this.curDistrict], s, this.tmpFogA);
    this.effectiveFogBase.copyFrom(this.tmpFogA);
  }

  /** Scars: increase vignette weight based on relocation count. */
  setVignetteWeight(w: number): void {
    const ip = this.pipeline.imageProcessing;
    ip.vignetteWeight = w;
  }

  /** Ease scene mood toward the active memory-weather front. */
  setWeatherTint(mul: [number, number, number], dt: number): void {
    const k = Math.min(1, dt * 0.25);
    // fog base is the boundary-blended district colour, then tinted by weather
    this.scene.fogColor = Color3.Lerp(this.scene.fogColor, new Color3(
      this.effectiveFogBase.r * mul[0], this.effectiveFogBase.g * mul[1], this.effectiveFogBase.b * mul[2],
    ), k);
    this.hemi.diffuse = Color3.Lerp(this.hemi.diffuse, new Color3(
      this.baseHemi.r * mul[0], this.baseHemi.g * mul[1], this.baseHemi.b * mul[2],
    ), k);
    // screen-space rain rides TRANSIT/HOSPITAL wet-memory fronts
    const nowMs = performance.now();
    if (nowMs > this.manualWetUntil) {
      const wet = WET_TINTS.some((t) => tintMatches(mul, t));
      if (wet !== this.autoWet) { this.autoWet = wet; this.rain.set(wet); }
    }
  }

  // ---- screen-space rain (TRANSIT / HOSPITAL wet zones) -----------------
  private rain = new ScreenRain();
  /** manual override window: explicit setWetZone() wins for 10 s */
  private manualWetUntil = 0;
  private autoWet = false;

  /**
   * Manually force the CSS rain overlay on/off (e.g. when a caller knows the
   * player is standing in a TRANSIT/HOSPITAL chunk). Takes precedence over
   * front-tint auto-detection for 10 seconds.
   */
  setWetZone(wet: boolean): void {
    this.manualWetUntil = performance.now() + 10000;
    this.rain.set(wet);
  }

  /**
   * Bind the pool to the nearest alive fixtures around the player.
   * fixtures: {x,z,flicker,alive} list from loaded chunks.
   */
  /** fired when the migrating light burns out */
  onLightDied: (() => void) | null = null;
  private lastSortKey = '';
  private lastSorted: { x: number; z: number; flicker: number; alive: boolean }[] = [];
  /** migrating light: index into pool, target position, progress */
  private migrant: { poolIdx: number; tx: number; tz: number; t: number; dur: number } | null = null;

  /** During peaks: one light detaches and drifts toward you, then dies. */
  startMigratingLight(px: number, pz: number): void {
    // find the brightest bound pool light within range
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < this.pool.length; i++) {
      const pl = this.pool[i];
      if (pl.baseIntensity <= 0) continue;
      const d = (pl.light.position.x - px) ** 2 + (pl.light.position.z - pz) ** 2;
      if (d < bestD && d > 9) { bestD = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      this.migrant = { poolIdx: bestIdx, tx: px, tz: pz, t: 0, dur: 9 + Math.random() * 6 };
    }
  }

  private lastT = 0;

  // ---- blackout flicker-swap state ----
  /** test hook: hold the flashed emissive frame for N seconds (default: single frame) */
  public flashHoldSec = 0;
  private wasDeadOut = false;
  private nextFlashAt = 0;
  private flashArmed = false;
  private flashHoldUntil = -1;

  update(px: number, pz: number, time: number, fixtures: ReadonlyArray<{ x: number; z: number; flicker: number; alive: boolean }>, version = 0): void {
    const ldt = Math.min(0.1, Math.max(0, time - this.lastT));
    this.lastT = time;
    // migrating light keeps its own assignment; everything else may rebind

    // re-sort only when the world version or player chunk-quarter changes;
    // otherwise reuse the previous nearest-set assignment.
    const sortKey = version + ':' + Math.floor(px / 4) + ':' + Math.floor(pz / 4);
    if (sortKey !== this.lastSortKey || !this.lastSorted.length) {
      this.lastSortKey = sortKey;
      this.lastSorted = fixtures
        .filter((f) => f.alive)
        .map((f) => ({ x: f.x, z: f.z, flicker: f.flicker, alive: true }))
        .sort((a, b) => ((a.x - px) ** 2 + (a.z - pz) ** 2) - ((b.x - px) ** 2 + (b.z - pz) ** 2))
        .slice(0, POOL);
    }
    const sorted = this.lastSorted.map((f) => ({ f, d: (f.x - px) ** 2 + (f.z - pz) ** 2 }));

    const used = new Set<number>();
    for (let i = 0; i < sorted.length; i++) {
      if (this.migrant && this.migrant.poolIdx === i) continue;
      const { f, d } = sorted[i];
      const pl = this.pool[i];
      used.add(i);
      pl.fixtureKey = f.x + ',' + f.z;
      pl.light.position.set(f.x, 2.86, f.z);
      pl.baseIntensity = 1.7 * Math.max(0.3, 1 - Math.sqrt(d) / 26);
      pl.flicker = f.flicker % 100;
      pl.seedX = f.x; pl.seedZ = f.z;
    }
    for (let i = 0; i < POOL; i++) {
      if (!used.has(i)) {
        this.pool[i].light.position.set(0, -100, 0);
        this.pool[i].baseIntensity = 0;
      }
    }

    // Migrating light drifts toward the player, then burns out
    if (this.migrant) {
      const mg = this.migrant;
      mg.t += ldt;
      const pl = this.pool[mg.poolIdx];
      const k = Math.min(1, mg.t / mg.dur);
      pl.light.position.x += (mg.tx - pl.light.position.x) * Math.min(1, ldt * 0.35);
      pl.light.position.z += (mg.tz - pl.light.position.z) * Math.min(1, ldt * 0.35);
      pl.light.intensity = pl.baseIntensity * (1 - k) * (0.7 + 0.3 * Math.sin(mg.t * 9));
      if (k >= 1 || mg.t > mg.dur * 1.4) {
        pl.light.intensity = 0;
        this.migrant = null;
        this.onLightDied?.();
      }
    }

    // ---- blackout fixture flicker swap ---------------------------------
    // During blackouts the game forces every fixture alive=false, so a
    // fully-dead fixture list means lights-out. Every 3-7 s one "dead"
    // fluorescent fights back for a SINGLE frame: the shared dead-fixture
    // material's emissiveColor is pulsed high, then dropped back down on the
    // next update. flashHoldSec lets visual tests hold the frame longer.
    const deadOut = fixtures.length > 0 && !fixtures.some((f) => f.alive);
    if (deadOut && !this.wasDeadOut) this.nextFlashAt = time + 3 + Math.random() * 4;
    this.wasDeadOut = deadOut;
    const deadMat = fixtureDeadRef.mat;
    if (this.flashArmed && (this.flashHoldUntil < 0 || time >= this.flashHoldUntil)) {
      if (deadMat) deadMat.emissiveColor.set(0, 0, 0);
      this.flashArmed = false;
      this.flashHoldUntil = -1;
    }
    if (deadOut && !this.flashArmed && deadMat && time >= this.nextFlashAt) {
      if (deadMat.isFrozen) deadMat.unfreeze();
      deadMat.emissiveColor.set(0.95, 0.92, 0.72); // brief surge of life
      this.flashArmed = true;
      this.flashHoldUntil = this.flashHoldSec > 0 ? time + this.flashHoldSec : -1; // -1: exactly one frame
      // occasionally a dying tube double-strobes before settling back to dark
      this.nextFlashAt = time + (Math.random() < 0.25 ? 0.09 : 3 + Math.random() * 4);
    }

    // Flicker simulation
    const stress = this.stressLevel;
    for (const pl of this.pool) {
      let mul = 1;
      const t = time + pl.phase;
      if (pl.flicker < 12) {
        // buzzing irregular flicker
        const n = rand2(Math.floor(t * 24), Math.floor(pl.seedX * 7 + pl.seedZ * 13), 999);
        mul = 0.55 + 0.45 * (n > 0.4 ? 1 : 0.15);
      } else if (pl.flicker < 18) {
        // dying tube: slow pulsing
        mul = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.7));
      }
      if (stress > 0) {
        const s = rand2(Math.floor(t * 30), Math.floor(pl.seedZ), 12345);
        if (s > 1 - stress * 0.35) mul *= 0.15;
      }
      pl.light.intensity = pl.baseIntensity * mul;
    }
  }
}


