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


