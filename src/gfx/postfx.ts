/**
 * Post-processing manager: vignette pulse, chromatic aberration, film grain,
 * depth-of-field hint.
 *
 * Sits on top of the rig from lighting.ts. When a DefaultRenderingPipeline is
 * available (the LightingRig builds one named 'pipeline') its shader features
 * are driven directly; DOM/CSS overlays carry the rest so every effect still
 * reads even if the pipeline is absent or disposed.
 *
 *   - Vignette pulse:  breathing-rate oscillation of vignette weight (+/-0.3)
 *                      during anomaly peak phase.
 *   - Chromatic split: RGB fringing that scales with memory instability,
 *                      capped at MAX_ABERRATION_OFFSET of screen width.
 *   - Film grain:      animated SVG-noise overlay div at opacity 0.04,
 *                      jittered per animation frame.
 *   - DOF hint:        edge-weighted backdrop blur while a blackout holds
 *                      (center stays sharp, like eyes refusing to focus).
 */
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';

/** Breathing rate at rest ~12-16 breaths/min -> ~0.22 Hz. */
const BREATH_HZ = 0.22;
/** Vignette pulse amplitude (weight swings +/- this around its base). */
const PULSE_AMP = 0.3;
/** Maximum RGB-split offset, as a fraction of render width. */
const MAX_ABERRATION_OFFSET = 0.002;
/** Grain overlay opacity - a whisper, same register as screen rain. */
const GRAIN_OPACITY = 0.04;
/** Blackout edge-blur radius in px. */
const BLACKOUT_BLUR_PX = 2.4;

// ---- film grain ----------------------------------------------------------

const GRAIN_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' " +
  "numOctaves='2' stitchTiles='stitch'/>" +
  "<feColorMatrix type='saturate' values='0'/></filter>" +
  "<rect width='100%' height='100%' filter='url(%23n)'/></svg>";

/**
 * Animated grain: one fixed div tiled with SVG fractal noise. The tile is
 * repositioned every other frame so the noise crawls instead of scrolling -
 * dead film, not a screensaver. Runs its own rAF loop because grain never
 * sleeps, even when the sim hitches.
 */
class FilmGrain {
  private el: HTMLDivElement | null = null;
  private raf = 0;
  private frame = 0;

  ensure(): void {
    if (this.el || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'bmb-grain-overlay';
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:42;' +
      'opacity:' + GRAIN_OPACITY + ';' +
      'background-image:url("data:image/svg+xml,' + GRAIN_SVG + '");';
    document.body.appendChild(el);
    this.el = el;
    const tick = (): void => {
      // update at half rate (~30 fps) - film grain flickers, it does not strobe
      if ((this.frame++ & 1) === 0 && this.el) {
        this.el.style.backgroundPosition =
          ((Math.random() * 128) | 0) + 'px ' + ((Math.random() * 128) | 0) + 'px';
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.el?.remove();
    this.el = null;
  }
}

/**
 * DOF hint for blackouts: a full-screen backdrop-blur masked with a radial
 * gradient so only the edges of vision soften - the center stays readable,
 * which is what makes it feel ocular rather than like a broken texture.
 */
class EdgeBlur {
  private el: HTMLDivElement | null = null;

  private ensure(): void {
    if (this.el || typeof document === 'undefined') return;
    const mask =
      'radial-gradient(circle at 50% 50%, transparent 34%, black 82%)';
    const el = document.createElement('div');
    el.id = 'bmb-dof-overlay';
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:44;display:none;' +
      '-webkit-backdrop-filter:blur(' + BLACKOUT_BLUR_PX + 'px);' +
      'backdrop-filter:blur(' + BLACKOUT_BLUR_PX + 'px);' +
      '-webkit-mask-image:' + mask + ';mask-image:' + mask + ';';
    document.body.appendChild(el);
    this.el = el;
  }

  set(on: boolean): void {
    if (on) this.ensure();
    if (this.el) this.el.style.display = on ? 'block' : 'none';
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }
}

export interface PostFXOptions {
  /** Camera to attach our own pipeline to when none is supplied. */
  camera?: Camera;
  /** Existing pipeline to drive (e.g. LightingRig's). Auto-adopted if omitted. */
  pipeline?: DefaultRenderingPipeline;
}

export class PostFX {
  private scene: Scene | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  /** true when we constructed the pipeline ourselves (and so dispose it). */
  private ownsPipeline = false;

  private grain = new FilmGrain();
  private edgeBlur = new EdgeBlur();

  // vignette pulse state
  private pulseActive = false;
  private pulsePhase = 0;
  private vignetteBase = 1.55;
  private vignetteCurrent = 1.55;

  // chromatic aberration state (smoothed toward target)
  private aberrationTarget = 0;
  private aberrationActual = 0;

  /**
   * Bind to a scene. If no pipeline is given we adopt the first existing
   * DefaultRenderingPipeline (the LightingRig's), else create a lean one for
   * the optional camera with everything but FXAA and aberration disabled so
   * we never double-apply bloom/tone-mapping on top of the rig.
   */
  init(scene: Scene, opts?: PostFXOptions): void {
    this.scene = scene;
    this.grain.ensure(); // CSS layer: always available

    let pipe = opts?.pipeline ?? null;
    if (!pipe) pipe = this.findExistingPipeline(scene);
    if (!pipe && opts?.camera) {
      pipe = new DefaultRenderingPipeline('bmb-postfx', false, scene, [opts.camera]);
      pipe.fxaaEnabled = true;
      pipe.bloomEnabled = false;
      pipe.imageProcessingEnabled = false;
      pipe.depthOfFieldEnabled = false;
      pipe.grainEnabled = false;
      pipe.sharpenEnabled = false;
      this.ownsPipeline = true;
    }
    if (pipe) {
      this.pipeline = pipe;
      this.vignetteBase = pipe.imageProcessing.vignetteWeight || this.vignetteBase;
      this.vignetteCurrent = this.vignetteBase;
    }
  }

  /** Adopt the LightingRig's pipeline if it exists and we have none yet. */
  private findExistingPipeline(scene: Scene): DefaultRenderingPipeline | null {
    const list = scene.postProcessRenderPipelineManager.supportedPipelines;
    for (const p of list) {
      if (
        p.getClassName() === 'DefaultRenderingPipeline' &&
        p instanceof DefaultRenderingPipeline
      ) {
        return p;
      }
    }
    return null;
  }

  /** Late-bind a camera (mirrors LightingRig.attachToCamera). */
  attachToCamera(cam: Camera): void {
    if (this.pipeline) this.pipeline.addCamera(cam);
    else this.init(this.scene!, { camera: cam });
  }

  /** Peak-phase heartbeat: vignette breathes +/-0.3 around its base weight. */
  setPulse(active: boolean): void {
    if (active === this.pulseActive) return;
    this.pulseActive = active;
    if (active) {
      this.pulsePhase = -Math.PI / 2; // start at minimum: inhale into the peak
      const ip = this.pipeline?.imageProcessing;
      this.vignetteBase = ip ? ip.vignetteWeight : this.vignetteBase;
    }
    // on deactivate, update() eases the weight back to base
  }

  /**
   * Memory instability 0..1 drives RGB split. At 1 the fringe offset is
   * exactly MAX_ABERRATION_OFFSET of render width (~2 px at 1080p).
   */
  setAberration(intensity: number): void {
    this.aberrationTarget = Math.min(1, Math.max(0, intensity));
  }

  /** Blackout blur hint (edge-weighted CSS backdrop-filter). */
  setBlackout(active: boolean): void {
    this.edgeBlur.set(active);
  }

  private lastAberrationPx = -1;

  /** Advance pulse/easing; call once per frame with the sim delta in seconds. */
  update(dt: number): void {
    if (!this.scene) return;
    const step = Math.min(0.1, Math.max(0, dt));

    // -- vignette pulse --
    if (this.pipeline && this.pulseActive) {
      this.pulsePhase += step * BREATH_HZ * Math.PI * 2;
      this.vignetteCurrent =
        this.vignetteBase + PULSE_AMP * Math.sin(this.pulsePhase);
      this.pipeline.imageProcessing.vignetteEnabled = true;
      this.pipeline.imageProcessing.vignetteWeight = this.vignetteCurrent;
    } else if (this.pipeline && !this.pulseActive) {
      // settle back after a peak ends
      if (Math.abs(this.vignetteCurrent - this.vignetteBase) > 0.001) {
        const k = Math.min(1, step * 5);
        this.vignetteCurrent +=
          (this.vignetteBase - this.vignetteCurrent) * k;
        this.pipeline.imageProcessing.vignetteWeight = this.vignetteCurrent;
      }
    }

    // -- chromatic aberration (smoothed) --
    if (this.pipeline) {
      const k = Math.min(1, step * 6);
      this.aberrationActual +=
        (this.aberrationTarget - this.aberrationActual) * k;
      const px =
        this.aberrationActual * MAX_ABERRATION_OFFSET *
        this.scene!.getEngine().getRenderWidth();
      if (Math.abs(px - this.lastAberrationPx) > 0.01) {
        this.pipeline.chromaticAberrationEnabled = px > 0.05;
        if (px > 0.05) {
          this.pipeline.chromaticAberration.aberrationAmount = px;
        }
        this.lastAberrationPx = px;
      }
    }
  }

  /** Remove overlays and any pipeline we created. */
  dispose(): void {
    this.grain.dispose();
    this.edgeBlur.dispose();
    if (this.ownsPipeline) this.pipeline?.dispose();
    this.pipeline = null;
    this.scene = null;
  }
}


