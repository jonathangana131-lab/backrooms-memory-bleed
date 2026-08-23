/**
 * TorchShadows: real shadow casting for the flashlight.
 *
 * The torch spotlight (see src/player/flashlight.ts) gets a ShadowGenerator
 * so entities and large props throw proper shadows onto the walls and floor
 * as you sweep the beam across them - the single biggest "the dark has
 * weight" upgrade in a first-person horror rig.
 *
 * Design notes:
 *   - 1024 map + exponential blur: soft penumbras read better than hard
 *     edges at Backrooms light ranges, and 1024 keeps the per-frame cost
 *     of an extra render pass tolerable on integrated GPUs.
 *   - SELECTIVE casters: nothing casts until it is registered through
 *     addCaster(). Entities and large props opt in; wall panels, ceiling
 *     tiles and every small decorative quad stay out of the depth pass.
 *   - PERFORMANCE GUARD: during blackouts there is nothing lit to cast
 *     from, so shadows are switched off entirely (light.shadowEnabled =
 *     false skips the depth pass for the torch). The guard self-detects
 *     blackout by watching the fixture pool: when every point light in
 *     the scene is dead for a run of consecutive frames, shadows drop;
 *     the moment any fixture fights back (or the blackout ends), they
 *     re-enable automatically. Torch-off frames skip the depth pass too.
 *
 * The game loop only needs to call setEnabled() if it wants a hard
 * override (e.g. quality settings); blackout handling is automatic.
 */
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
// side-effect import registers the shadow scene component under tree-shaking
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { Scene } from '@babylonjs/core/scene';
import type { Observer } from '@babylonjs/core/Misc/observable';

/** Shadow map resolution: enough detail for a 28 m torch cone. */
export const SHADOW_MAP_SIZE = 1024;
const MAP_SIZE = SHADOW_MAP_SIZE;
/** Exponential blur kernel: wider = softer penumbra. */
const BLUR_KERNEL = 16;
/** Shadow strength: 0 = pitch black, never quite full so shapes stay readable. */
const DARKNESS = 0.35;
/** Bias against shadow acne on the flat wall/floor geometry. */
const BIAS = 0.0015;
/** Consecutive all-dead fixture frames before we call it a blackout
 *  (single-frame ghost-lit flickers must NOT trip the guard). */
const BLACKOUT_FRAMES = 10;

export class TorchShadows {
  readonly generator: ShadowGenerator;
  private readonly scene: Scene;
  /** meshes registered to cast; drives renderList bookkeeping */
  private readonly casters = new Set<AbstractMesh>();
  /** hard user override (quality setting / manual off) */
  private userEnabled = true;
  /** last computed effective state */
  private active = false;
  private deadFrames = 0;
  private observer: Observer<Scene> | null = null;
  private disposed = false;

  constructor(light: SpotLight) {
    this.scene = light.getScene();
    const gen = new ShadowGenerator(MAP_SIZE, light);
    gen.useBlurExponentialShadowMap = true;
    gen.blurKernel = BLUR_KERNEL;
    gen.setDarkness(DARKNESS);
    gen.bias = BIAS;
    // torch range is 28 m; keep the exponential depth curve gentle so far
    // shadows do not wash out
    gen.depthScale = 12;
    this.generator = gen;
    this.observer = this.scene.onBeforeRenderObservable.add(() => this.refresh());
    this.refresh();
    // the torch starts parked/off: make sure the depth pass really is off
    // even though Light.shadowEnabled defaults to true
    if (!this.active) light.shadowEnabled = false;
  }

  /**


