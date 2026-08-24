/**
 * F28 Mimic props — scene wiring.
 *
 * Bridges the pure MimicProps simulation (src/entities/mimics.ts) to the
 * Babylon scene: builds one furniture figure (crate / chair / locker) per
 * mimic anchor, syncs every mesh to its simulated body each frame — frozen
 * mimics visibly stop, creeping ones drift — and despawns far props
 * gracefully via GracefulDespawn: instant removal outside the gaze cone,
 * a one-second material fade while watched.
 *
 * Observation providers reuse the watcher gaze-cone rule: a prop counts as
 * gazed when it sits inside the player's forward cone with line of sight,
 * the same dot-threshold discipline HumanManager applies to torch-beam
 * freezes. All randomness flows through the seeded MimicProps streams.
 */
import type { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MimicProps, MIMIC_RADIUS } from './mimics';
import { GracefulDespawn, FADE_DURATION_S } from './graceful';
import { hasLineOfSight } from '../world/collision';
import type { Box2 } from '../world/architect';

/** Furniture silhouettes a mimic can wear. */
export type MimicVariant = 'crate' | 'chair' | 'locker';

/** One furniture anchor streamed in for a mimic to inhabit. */
export interface MimicPropAnchor {
  /** Stable id feeding the true-nature flag and save data. */
  readonly id: string;
  x: number;
  z: number;
  variant: MimicVariant;
}

/** Live fade bookkeeping for one wired mimic. */
interface FadeState {
  /** Seconds left in the watched fade; absence = not fading. */
  remaining: number;
}

/** Direct-view cone half-angle proxy: cos threshold over the XZ plane. */
const VIEW_COS = Math.cos((30 * Math.PI) / 180);
/** Beyond this distance a gaze cannot rest on the prop (metres). */
const GAZE_RANGE_M = 22;
/** Past this distance the prop becomes eligible for graceful despawn. */
export const DESPAWN_DIST_M = 55;

/** Deps injected from the game; colliders re-read every frame. */
export interface MimicWiringDeps {
  seed: number;
}

export class MimicPropWiring {
  /** The pure simulation this wiring renders. */
  readonly sim: MimicProps;
  /** Wired nodes keyed by mimic index; removed on graceful despawn. */
  private readonly nodes = new Map<number, TransformNode>();
  private readonly fades = new Map<number, FadeState>();
  private readonly mat: StandardMaterial;
  private fwdX = 0;
  private fwdZ = -1;
  private camX = 0;
  private camZ = 0;
  private colliders: readonly Box2[] = [];

  constructor(scene: Scene, deps: MimicWiringDeps) {
    const self = this;
    this.sim = new MimicProps({
      seed: deps.seed,
      // anchors stream in through add()/sim.addProp after construction
      props: [],
      // gaze rests on the prop when it holds inside the player's forward
      // cone with line of sight — the same seenBy discipline watchers use
      gazeRestingOn(x, z) {
        return self.inView(x, z, GAZE_RANGE_M);
      },
      directViewOf(x, z) {
        return self.inView(x, z, GAZE_RANGE_M + 4);
      },
    });
    const existing = scene.getMaterialByName('mimicFurnitureMat') as StandardMaterial | null;
    if (existing) {
      this.mat = existing;
    } else {
      this.mat = new StandardMaterial('mimicFurnitureMat', scene);
      this.mat.diffuseColor = new Color3(0.42, 0.36, 0.26);
      this.mat.specularColor = new Color3(0.02, 0.02, 0.02);
      this.mat.maxSimultaneousLights = 8;
    }
    this.scene = scene;
  }

  private scene: Scene;

  /** Register a streamed-in anchor and build its furniture mesh. */
  add(anchor: MimicPropAnchor): void {
    if (this.nodes.size >= 12) return; // bounded population; despawns recycle
    this.sim.addProp({ id: anchor.id, x: anchor.x, z: anchor.z });
    const state = this.sim.mimics[this.sim.mimics.length - 1]!;
    this.nodes.set(state.index, this.buildVariant(anchor.variant));
  }

  /**
   * Advance the simulation and sync meshes. Colliders must be the wall
   * set around the player for this frame (creep resolution + gaze LOS).
   */
  update(dt: number, px: number, pz: number, yaw: number, colliders: readonly Box2[]): void {
    this.camX = px;
    this.camZ = pz;
    this.fwdX = -Math.sin(yaw);
    this.fwdZ = -Math.cos(yaw);
    this.colliders = colliders;
    this.sim.update(dt, px, pz);
    for (let i = this.sim.mimics.length - 1; i >= 0; i--) {
      const m = this.sim.mimics[i]!;
      const node = this.nodes.get(i);
      if (!node) continue;
      node.position.set(m.x, 0, m.z);
      const d = Math.hypot(m.x - px, m.z - pz);
      if (d <= DESPAWN_DIST_M) continue;
      const fade = this.fades.get(i);
      if (fade) {
        fade.remaining -= dt;
        this.applyFade(node, Math.max(0, fade.remaining / FADE_DURATION_S));
        if (fade.remaining <= 0) this.remove(i, node);
      } else if (
        GracefulDespawn.shouldInstantDespawn(
          { x: this.fwdX, z: this.fwdZ },
          { x: px, z: pz },
          { x: m.x, z: m.z },
        )
      ) {
        this.remove(i, node); // unwatched: the corridor is simply empty now
      } else {
        // watched: swap in a private material copy so fading this prop
        // never dims the neighbours sharing the furniture material
        const priv = this.mat.clone('mimicFade_' + i);
        priv.alpha = 1;
        for (const mesh of node.getChildMeshes()) mesh.material = priv;
        this.fades.set(i, { remaining: FADE_DURATION_S });
      }
    }
  }

  /** True-nature flag lookup by stable prop id (save/debug surface). */
  isRevealed(id: string): boolean {
    return this.sim.isRevealed(id);
  }

  /** Live mimic count still wired into the scene. */
  get count(): number {
    return this.nodes.size;
  }

  /** Dispose every mesh; the sim dies with the run. */
  dispose(): void {
    for (const node of this.nodes.values()) node.dispose(false, true);
    this.nodes.clear();
    this.fades.clear();
  }

  // -- internals --------------------------------------------------------------

  /** Forward-cone plus line-of-sight visibility test against live walls. */
  private inView(x: number, z: number, rangeM: number): boolean {
    const dx = x - this.camX;
    const dz = z - this.camZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6 || d > rangeM) return false;
    if ((dx / d) * this.fwdX + (dz / d) * this.fwdZ < VIEW_COS) return false;
    return hasLineOfSight(this.camX, this.camZ, x, z, this.colliders);
  }

  /** Build the crate/chair/locker silhouette for one mimic slot. */
  private buildVariant(variant: MimicVariant): TransformNode {
    const root = new TransformNode('mimic_' + variant, this.scene);
    const box = (name: string, w: number, h: number, dpt: number, y: number): void => {
      const b = MeshBuilder.CreateBox(name, { width: w, height: h, depth: dpt }, this.scene);
      b.position.y = y;
      b.material = this.mat;
      b.isPickable = false;
      b.parent = root;
    };
    switch (variant) {
      case 'chair':
        box('seat', 0.46, 0.07, 0.46, 0.45);
        box('back', 0.46, 0.5, 0.07, 0.72);
        box('legs', 0.4, 0.44, 0.4, 0.22);
        break;
      case 'locker':
        box('body', 0.62, 1.9, 0.5, 0.95);
        break;
      default:
        box('crate', 0.7, 0.7, 0.7, 0.35);
        break;
    }
    return root;
  }

  /** Scale every child material's alpha toward 0 during a watched fade. */
  private applyFade(node: TransformNode, k: number): void {
    for (const mesh of node.getChildMeshes()) {
      const m = mesh.material as StandardMaterial | null;
      if (!m) continue;
      m.alpha = k;
    }
  }

  /** Drop one mimic's node and fade bookkeeping. */
  private remove(index: number, node: TransformNode): void {
    node.dispose(false, true);
    this.nodes.delete(index);
    this.fades.delete(index);
  }
}
