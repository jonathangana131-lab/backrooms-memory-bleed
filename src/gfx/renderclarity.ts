/**
 * Render clarity pass: DREAM-STATE CLARITY policy for the whole frame.
 *
 * The place is wrong, but it must be rendered crystal clear - a vivid dream
 * you walked into, not a murky tech demo. This module owns the anti-mud
 * pass on top of the existing rig:
 *
 *   - Resolution:    drives the render target toward native (scale 1.0) on
 *                    medium/high quality tiers via engine.setHardwareScalingLevel.
 *   - Textures:      raises anisotropic filtering and upgrades nearest
 *                    sampling to trilinear across every scene texture.
 *   - Anti-aliasing: honors the backend - hardware MSAA on WebGPU (created
 *                    with antialias:true in game.ts), FXAA adopted onto the
 *                    LightingRig pipeline elsewhere. Anything unavailable
 *                    degrades silently.
 *   - Fog:           caps EXP2 density so geometry stays readable at
 *                    distance while the depth mood survives (clear and wrong
 *                    beats blurry and vague). The LightingRig eases fog back
 *                    up every frame, so update() re-applies the cap.
 *   - Color:         subtle per-district-band grade through the shared
 *                    ImageProcessingConfiguration color curves - tiny hue
 *                    filters around the canonical fluorescent greens and
 *                    yellows, never a heavy LUT.
 *   - Grain:         ultra-faint film grain is OPTIONAL and DEFAULT-OFF;
 *                    murk kills the dream-clarity brief. The toggle drives
 *                    both the scene grain (enabled by lighting.ts) and the
 *                    PostFX CSS overlay node (owned there, only shown/hidden
 *                    here).
 *
 * The low quality tier keeps the pre-existing behavior end to end so weak
 * devices survive untouched.
 *
 * game.ts owns integration centrally: this module exports applyRenderClarity()
 * as its single mount point plus a returned handle carrying update(),
 * setGrain() and dispose().
 */
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Scene } from '@babylonjs/core/scene';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ColorCurves } from '@babylonjs/core/Materials/colorCurves';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';

/** Quality presets mirrored from ui/settings.ts QUALITY_LEVELS. */
export type QualityTier = 'low' | 'medium' | 'high';

/** Minimal settings slice this pass reads; GameSettings satisfies it. */
export interface RenderClaritySettings {
  /** Render quality preset ('low' | 'medium' | 'high'); anything else reads as medium. */
  readonly quality?: string;
}

// ---- resolution ----------------------------------------------------------

/** Native-resolution targets per tier. Low keeps legacy scaling entirely. */
export const CLARITY_RESOLUTION_SCALE: Readonly<Record<Exclude<QualityTier, 'low'>, number>> =
  Object.freeze({ medium: 0.85, high: 1 });

/**
 * Fraction of native resolution the clarity pass renders at.
 * @param tier active quality preset
 * @returns target scale, or null on the low tier (legacy behavior preserved).
 */
export function clarityResolutionScale(tier: QualityTier): number | null {
  if (tier === 'low') return null;
  return CLARITY_RESOLUTION_SCALE[tier];
}

/**
 * Hardware scaling level matching the tier's resolution target
 * (Babylon renders at native resolution divided by the level).
 * @param tier active quality preset
 * @returns level for engine.setHardwareScalingLevel, or null on low tier.
 */
export function clarityHardwareScalingLevel(tier: QualityTier): number | null {
  const scale = clarityResolutionScale(tier);
  return scale === null ? null : 1 / scale;
}

// ---- fog discipline ------------------------------------------------------

/**
 * Hard ceiling for EXP2 fog density. Above this the hallways turn soupy and
 * geometry stops reading at distance; the deepest district preset (storage,
 * 0.046 in lighting.ts) exceeds it deliberately and gets trimmed here.
 */
export const MAX_CLARITY_FOG_DENSITY = 0.038;

/**
 * Cap a fog density at the readability ceiling.
 * @param density raw EXP2 fog density (any non-negative value)
 * @returns density clamped into [0, MAX_CLARITY_FOG_DENSITY]
 */
export function clampFogDensity(density: number): number {
  if (!(density >= 0)) return 0; // NaN and negatives collapse to clear air
  return Math.min(density, MAX_CLARITY_FOG_DENSITY);
}

// ---- texture crispness ---------------------------------------------------

/** Anisotropic filtering levels per tier. Low keeps legacy filtering. */
export const CLARITY_ANISO_LEVEL: Readonly<Record<Exclude<QualityTier, 'low'>, number>> =
  Object.freeze({ medium: 4, high: 8 });

/**
 * Anisotropic filtering level for the tier.
 * @param tier active quality preset
 * @returns aniso level, or null on the low tier (legacy behavior preserved).
 */
export function anisotropicLevelFor(tier: QualityTier): number | null {
  if (tier === 'low') return null;
  return CLARITY_ANISO_LEVEL[tier];
}

// ---- color identity ------------------------------------------------------

/**
 * One district band's subtle grade, expressed as ImageProcessingConfiguration
 * color-curve scalars: a faint global filter (hue + density) plus a small
 * saturation lift. Densities stay at or below 10 of 100 - tinting, not a LUT.
 */
export interface GradeBand {
  /** Filter hue in degrees (0 red, ~60 fluorescent yellow-green, 200 cool gray-blue). */
  readonly hue: number;
  /** Filter strength in [-100, 100]; small positives only in this table. */
  readonly density: number;
  /** Saturation adjustment in [-100, 100]; small lifts keep the dream vivid. */
  readonly saturation: number;
}

/**
 * Per-district-band grades, ordered exactly like lighting.ts DISTRICT_FOG_COLORS
 * (maze / open-office / honeycomb / corridor-grid / storage). Cool fluorescent
 * greens and yellows stay canonical.
 */
export const GRADE_BANDS: readonly GradeBand[] = Object.freeze([
  Object.freeze({ hue: 52, density: 5, saturation: 6 }), // 0 maze
  Object.freeze({ hue: 62, density: 4, saturation: 5 }), // 1 open office
  Object.freeze({ hue: 68, density: 7, saturation: 8 }), // 2 honeycomb
  Object.freeze({ hue: 205, density: 4, saturation: 3 }), // 3 corridor grid
  Object.freeze({ hue: 45, density: 3, saturation: 4 }), // 4 storage
]);

/** Band applied whenever a caller passes an out-of-range or unknown index. */
export const GRADE_BAND_FALLBACK: GradeBand = GRADE_BANDS[1];

/**
 * Resolve the grade for a district band index.
 * @param band district index (lighting.ts district numbering)
 * @returns the band's grade, or GRADE_BAND_FALLBACK outside 0..4.
 */
export function gradeBandFor(band: number): GradeBand {
  return Number.isInteger(band) && band >= 0 && band < GRADE_BANDS.length
    ? GRADE_BANDS[band]
    : GRADE_BAND_FALLBACK;
}

// ---- grain ----------------------------------------------------------------

/** id of the PostFX-owned CSS grain overlay node (only toggled here). */
export const GRAIN_OVERLAY_ID = 'bmb-grain-overlay';

/** Grain intensity when the toggle is ON - a whisper, well under lighting.ts's 9. */
export const GRAIN_ENABLED_INTENSITY = 4;

// ---- tier normalization ---------------------------------------------------

/**
 * Map arbitrary settings input onto a known tier. Unknown or missing values
 * read as the factory-default tier (medium), matching validateSettings().
 * @param raw raw quality field from any settings shape
 * @returns a known QualityTier
 */
export function normalizeQualityTier(raw: unknown): QualityTier {
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'medium';
}

// ---- application ----------------------------------------------------------

/** What one applyRenderClarity() run actually did; surfaced for tests/diagnostics. */
export interface RenderClarityReport {
  /** Normalized tier the pass ran under. */
  tier: QualityTier;
  /** False exactly on the low tier, where everything keeps legacy behavior. */
  applied: boolean;
  /** Hardware scaling level written, or null when untouched. */
  hardwareScalingLevel: number | null;
  /** Anisotropic filtering level written, or null when untouched. */
  anisotropicFilteringLevel: number | null;
  /** Scene textures that received the aniso/sampling treatment. */
  texturesTouched: number;
  /** Textures upgraded from nearest to trilinear sampling. */
  samplingUpgraded: number;
  /** AA strategy settled on for this backend. */
  antiAliasing: 'msaa-hardware' | 'fxaa' | 'none';
  /** Whether the subtle sharpen stage was enabled (high tier only). */
  sharpen: boolean;
  /** Fog density observed before capping, when it exceeded the cap. */
  fogDensityCappedFrom: number | null;
  /** Fog density after the last cap application. */
  fogDensityAfter: number | null;
  /** District band the color grade was last applied for (-1 before first grade). */
  gradeBand: number;
  /** Current state of the optional grain toggle (default OFF). */
  grainEnabled: boolean;
}

/** Mount-point API returned by applyRenderClarity(); game.ts calls update()/setGrain(). */
export interface RenderClarityHandle {
  /** Snapshot of the last application (mutated in place by update()). */
  readonly report: RenderClarityReport;
  /**
   * Re-assert the per-frame parts of the policy: re-cap scene fog (the
   * LightingRig eases density back up toward its presets every frame) and,
   * optionally, move the color grade to another district band.
   * @param band district index to grade for; omit to keep the current band
   */
  update(band?: number): void;
  /**
   * Toggle the ultra-faint film grain (default OFF). Drives the scene grain
   * configuration and the PostFX CSS overlay node when a DOM is present.
   * @param enabled true restores the faint grain, false keeps the frame clean
   */
  setGrain(enabled: boolean): void;
  /** Drop internal references. Visual state persists until settings change. */
  dispose(): void;
}

/** true only for WebGPU-backed engines; exotic engines read as WebGL paths. */
function isWebGPUEngine(engine: Engine): boolean {
  try {
    return (engine as { isWebGPU?: boolean }).isWebGPU === true;
  } catch {
    return false;
  }
}

// ---- WebGPU light budget ---------------------------------------------------

/**
 * Max simultaneous lights a material may bind under WebGPU. Babylon's
 * WebGPU backend allocates one uniform-buffer binding per bound light in
 * BOTH shader stages, plus three fixed bindings (scene/mesh/material).
 * Chunk materials request 16 simultaneous lights -> 19 vertex-stage UBOs,
 * past the WebGPU per-stage limit of 12; every render-pipeline creation
 * then fails GPU validation and the whole world draws black. WebGL has no
 * per-stage UBO limit and keeps the higher counts untouched.
 * Budget math: 8 lights + 3 fixed bindings = 11 <= 12.
 */
export const WEBGPU_MAX_SIMULTANEOUS_LIGHTS = 8;

/**
 * Clamp every current and future material's maxSimultaneousLights to the
 * WebGPU-safe budget. Installs a scene observer so chunk-streamed and
 * prop materials created later stay clamped too. No-op on non-WebGPU
 * engines - WebGL rendering keeps its full light counts.
 *
 * @param scene the game scene whose materials must respect the budget
 * @param engine the active engine; the clamp applies only when WebGPU
 * @returns disposer detaching the material-added observer
 */
export function enforceWebGPULightBudget(
  scene: Scene,
  engine: Engine,
): () => void {
  if (!isWebGPUEngine(engine)) return () => {};
  const clamp = (mat: unknown): void => {
    const m = mat as { maxSimultaneousLights?: number };
    if (
      m &&
      typeof m.maxSimultaneousLights === 'number' &&
      m.maxSimultaneousLights > WEBGPU_MAX_SIMULTANEOUS_LIGHTS
    ) {
      m.maxSimultaneousLights = WEBGPU_MAX_SIMULTANEOUS_LIGHTS;
    }
  };
  for (const mat of scene.materials ?? []) clamp(mat);
  const obs = scene.onNewMaterialAddedObservable.add(clamp);
  return () => {
    scene.onNewMaterialAddedObservable.remove(obs);
  };
}

/** Locate the LightingRig's DefaultRenderingPipeline, or null when absent. */
function findDefaultPipeline(scene: Scene): DefaultRenderingPipeline | null {
  try {
    const list = scene.postProcessRenderPipelineManager.supportedPipelines;
    for (const p of list) {
      if (p.getClassName() === 'DefaultRenderingPipeline' && p instanceof DefaultRenderingPipeline) {
        return p;
      }
    }
  } catch {
    // no pipeline manager yet - AA simply stays wherever the rig left it
  }
  return null;
}

/** Show/hide the PostFX grain overlay; an absent DOM (tests/headless) is fine. */
function setGrainOverlayVisible(visible: boolean): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(GRAIN_OVERLAY_ID);
  if (el) el.style.display = visible ? 'block' : 'none';
}

/**
 * Apply the dream-state clarity policy to a live engine + scene.
 * Safe to call again on settings changes; returns a handle for the per-frame
 * fog cap and the grain toggle. Never throws for missing rig pieces - anything
 * unavailable degrades silently.
 *
 * @param engine the game engine (WebGL Engine or WebGPUEngine as Engine)
 * @param scene the game scene (materials/textures/pipeline already built)
 * @param settings settings slice; only the quality preset is read
 * @returns handle carrying the report plus update()/setGrain()/dispose()
 */
export function applyRenderClarity(
  engine: Engine,
  scene: Scene,
  settings: RenderClaritySettings,
): RenderClarityHandle {
  const tier = normalizeQualityTier(settings?.quality);
  const report: RenderClarityReport = {
    tier,
    applied: false,
    hardwareScalingLevel: null,
    anisotropicFilteringLevel: null,
    texturesTouched: 0,
    samplingUpgraded: 0,
    antiAliasing: 'none',
    sharpen: false,
    fogDensityCappedFrom: null,
    fogDensityAfter: null,
    gradeBand: -1,
    grainEnabled: false,
  };

  if (tier === 'low') {
    // weak devices keep the old behavior end to end
    return { report, update: () => {}, setGrain: () => {}, dispose: () => {} };
  }
  report.applied = true;

  // -- resolution: drive toward native --
  const level = clarityHardwareScalingLevel(tier);
  if (level !== null) {
    try {
      engine.setHardwareScalingLevel(level);
      report.hardwareScalingLevel = level;
    } catch {
      // scaling refused - keep rendering at whatever the rig chose
    }
  }

  // -- texture crispness: aniso + trilinear everywhere --
  const aniso = anisotropicLevelFor(tier);
  if (aniso !== null) {
    for (const tex of scene.textures ?? []) {
      const bt = tex as BaseTexture;
      try {
        bt.anisotropicFilteringLevel = aniso;
        if (bt.samplingMode === Texture.NEAREST_SAMPLINGMODE) {
          (bt as { samplingMode: number }).samplingMode = Texture.TRILINEAR_SAMPLINGMODE;
          report.samplingUpgraded++;
        }
        report.texturesTouched++;
      } catch {
        // disposed or locked texture - skip it
      }
    }
    report.anisotropicFilteringLevel = aniso;
  }

  // -- anti-aliasing: honor the backend --
  try {
    if (isWebGPUEngine(engine)) {
      // created with antialias:true in game.ts; FXAA would only soften MSAA
      report.antiAliasing = 'msaa-hardware';
    } else {
      const pipe = findDefaultPipeline(scene);
      if (pipe) {
        pipe.fxaaEnabled = true;
        report.antiAliasing = 'fxaa';
      }
    }
  } catch {
    // AA stays wherever the rig left it
  }

  // -- subtle sharpen on the top tier only (halo-safe amounts) --
  if (tier === 'high') {
    try {
      const pipe = findDefaultPipeline(scene);
      if (pipe) {
        pipe.sharpenEnabled = true;
        pipe.sharpen.edgeAmount = 0.18;
        pipe.sharpen.colorAmount = 0;
        report.sharpen = true;
      }
    } catch {
      // no pipeline to sharpen through - silently skipped
    }
  }

  // -- grain: default OFF --
  // grain fields are version-dependent on ImageProcessingConfiguration; go
  // through the same structural bag lighting.ts uses when it enables them.
  const ipc = scene.imageProcessingConfiguration as unknown as Record<string, number | boolean>;
  const ipcCfg = scene.imageProcessingConfiguration; // typed view for curve binding
  try {
    ipc.grainEnabled = false;
  } catch {
    // configuration locked - the CSS overlay toggle below still applies
  }
  setGrainOverlayVisible(false);
  report.grainEnabled = false;

  let curves: ColorCurves | null = null;

  const handle: RenderClarityHandle = {
    report,

    update(band?: number): void {
      // fog: the LightingRig re-eases density upward every frame; re-cap.
      try {
        const before = scene.fogDensity;
        const after = clampFogDensity(before);
        if (before > MAX_CLARITY_FOG_DENSITY) {
          report.fogDensityCappedFrom = before;
        }
        scene.fogDensity = after;
        report.fogDensityAfter = after;
      } catch {
        // scene gone mid-frame - nothing to cap
      }
      // color: re-grade when the district band moves.
      if (band !== undefined) {
        try {
          if (!curves) curves = new ColorCurves();
          const g = gradeBandFor(band);
          curves.globalHue = g.hue;
          curves.globalDensity = g.density;
          curves.globalSaturation = g.saturation;
          ipcCfg.colorCurves = curves;
          ipcCfg.colorCurvesEnabled = true;
          report.gradeBand = band;
        } catch {
          // curve binding unsupported - canonical colors remain untouched
        }
      }
    },

    setGrain(enabled: boolean): void {
      try {
        ipc.grainEnabled = enabled;
        if (enabled) {
          ipc.grainIntensity = GRAIN_ENABLED_INTENSITY;
          ipc.grainAnimated = true;
        }
      } catch {
        // configuration locked - CSS layer still reflects the request
      }
      setGrainOverlayVisible(enabled);
      report.grainEnabled = enabled;
    },

    dispose(): void {
      curves = null;
    },
  };

  // initial application: cap whatever density the rig booted with
  handle.update();

  return handle;
}
