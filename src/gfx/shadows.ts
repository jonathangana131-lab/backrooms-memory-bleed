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

(Showing lines 1-80 of 168. Use offset=81 to continue.)

  addCaster(mesh: AbstractMesh, includeDescendants = true): void {
    if (this.disposed || this.casters.has(mesh)) return;
    this.casters.add(mesh);
    mesh.receiveShadows = false; // casters are not receivers here
    this.generator.addShadowCaster(mesh, includeDescendants);
    this.refreshCasters();
  }

  /** Unregister a caster added with addCaster(). */
  removeCaster(mesh: AbstractMesh): void {
    if (!this.casters.has(mesh)) return;
    this.casters.delete(mesh);
    this.generator.removeShadowCaster(mesh, true);
    this.refreshCasters();
  }

  /** Hard on/off switch. Blackouts re-disable automatically regardless. */
  setEnabled(on: boolean): void {
    this.userEnabled = on;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
      this.observer = null;
    }
    this.casters.clear();
    this.generator.dispose();
  }

  /** Keep the generator's render list exactly in sync with our caster set. */
  private refreshCasters(): void {
    const map = this.generator.getShadowMap();
    if (!map) return;
    map.renderList = this.active ? [...this.casters] : [];
  }

  /**
   * Effective-state machine, evaluated once per frame:
   *   shadows run  <=>  userEnabled && torch lit && not in a blackout
   */
  private refresh(): void {
    if (this.disposed) return;
    const torchLit = this.torchLit();
    const blackout = this.detectBlackout();

    const shouldRun = this.userEnabled && torchLit && !blackout;
    if (shouldRun === this.active) {
      // still keep the render list honest after add/remove while running
      if (shouldRun) this.refreshCasters();
      return;
    }
    this.active = shouldRun;
    this.light.shadowEnabled = shouldRun;
    this.refreshCasters();
  }

  private get light(): SpotLight {
    return this.generator.getLight() as SpotLight;
  }

  /** Torch parked below the world or intensity 0 -> no beam, no depth pass. */
  private torchLit(): boolean {
    const l = this.light;
    return l.intensity > 0.01 && l.position.y > -40;
  }

  /**
   * A blackout means EVERY fixture point light in the scene is dead.
   * Requires BLACKOUT_FRAMES consecutive dead frames so one-frame
   * ghost-lit flickers do not churn the guard.
   */
  private detectBlackout(): boolean {
    let fixtureAlive = false;
    let sawFixture = false;
    for (const l of this.scene.lights) {
      const pl = l as PointLight;
      if (l.getClassName() !== 'PointLight') continue;
      sawFixture = true;
      if (pl.intensity > 0 && pl.position.y > 0) {
        fixtureAlive = true;
        break;
      }
    }
    if (!sawFixture || fixtureAlive) {
      // no fixture pool at all (menu / unit scenes) is not a blackout
      this.deadFrames = 0;
      return false;
    }
    this.deadFrames++;
    return this.deadFrames >= BLACKOUT_FRAMES;
  }
}


