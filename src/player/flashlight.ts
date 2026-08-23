/**
 * Flashlight: recovered at the first research camp. A focused beam
 * that turns darkness usable - for a while. It sips charge from
 * lit fluorescents when stowed.
 *
 * Also owns the volumetric-style beam CONE: a purely cosmetic additive
 * cone that shows WHERE the torch is pointing while it is on.
 */
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

export class Flashlight {
  light: SpotLight;
  /** owned by player after first camp */
  has = false;
  on = false;
  /** 0..1 charge; drains ~85s of continuous use */
  battery = 1;
  private lastT = 0;

  /** additive beam-cone mesh (apex at the lens, base 8 m out) */
  private beam: Mesh;
  private beamMat: StandardMaterial;
  private tmpA = new Vector3();
  private tmpB = new Vector3();

  constructor(scene: Scene) {
    this.light = new SpotLight('torch', new Vector3(0, 1.5, 0), new Vector3(0, 0, 1), 0.46, 4, scene);
    this.light.diffuse = new Color3(1.0, 0.97, 0.88);
    this.light.intensity = 0;
    this.light.range = 28;
    this.light.position.set(0, -50, 0);

    // ---- BEAM CONE -------------------------------------------------------
    // Cylinder degenerated into a cone: apex (diameter 0) sits at the lamp,
    // base (radius 1.2 -> diameter 2.4) sits 8 m down the beam. Baked once
    // so the local +Z axis IS the beam axis; lookAt() aims it every frame.
    const cone = MeshBuilder.CreateCylinder('torchBeam', {
      height: 8,
      diameterTop: 2.4,   // far end, radius 1.2 m
      diameterBottom: 0,  // apex at the lens
      tessellation: 24,
    }, scene);
    cone.rotation.x = Math.PI / 2; // rotate local +Y (base end) onto +Z...
    cone.bakeCurrentTransformIntoVertices(); // ...then freeze it into the verts
    this.beamMat = new StandardMaterial('torchBeamMat', scene);
    this.beamMat.emissiveColor = new Color3(1.0, 0.97, 0.85);
    this.beamMat.disableLighting = true;
    this.beamMat.alpha = 0.08;
    this.beamMat.alphaMode = Constants.ALPHA_ADD; // glow, don't occlude
    this.beamMat.backFaceCulling = false;
    this.beamMat.fogEnabled = false; // the beam cuts through the fog
    cone.material = this.beamMat;
    cone.isPickable = false;
    cone.alwaysSelectAsActiveMesh = true; // never frustum-cull the thin cone
    cone.setEnabled(false);
    this.beam = cone;
  }

  toggle(): boolean {
    if (!this.has || this.battery <= 0.001) return false;
    this.on = !this.on;
    return this.on;
  }

  update(dt: number, time: number, px: number, pz: number, yaw: number, pitch: number, nearLitLight: boolean): void {
    void dt;
    const ldt = Math.min(0.1, Math.max(0, time - this.lastT));
    this.lastT = time;

    if (this.on) {
      this.battery = Math.max(0, this.battery - ldt / 85);
      if (this.battery <= 0) { this.on = false; }
    } else if (nearLitLight) {
      // trickle-charges under working fluorescents
      this.battery = Math.min(1, this.battery + ldt / 45);
    } else if (this.battery < 0.3) {
      // ambient trickle: the Backrooms itself provides some energy (caps at
      // 30%) - the cap bounds the TRICKLE GAIN only and must never drain
      // charge already stored above 30%.
      this.battery = Math.min(0.3, this.battery + ldt / 180);
    }



      this.light.position.set(0, -50, 0);
      this.beam.setEnabled(false);
      return;
    }

    // dying battery: dimming + flicker (also breathes through the cone)
    let mul = 1;
    if (this.battery < 0.25) {
      mul = 0.4 + 0.6 * (this.battery / 0.25);
      if (Math.sin(time * 31) > 0.86) mul *= 0.3;
    }
    this.light.intensity = 15.0 * mul;

    // position slightly right-below the eye, aimed along view
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    const fy = Math.sin(-pitch);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ex = px + rx * 0.18, ez = pz + rz * 0.18;
    this.light.position.set(ex, 1.52, ez);
    this.light.direction.set(fx + rx * 0.08, fy, fz + rz * 0.08);

    // ---- beam cone follows the exact lamp ray ----
    const dx = fx + rx * 0.08, dy = fy, dz = fz + rz * 0.08;
    const len = Math.hypot(dx, dy, dz) || 1;
    const nx = dx / len, ny = dy / len, nz = dz / len;
    this.beam.setEnabled(true);
    this.beamMat.alpha = 0.08 * mul;
    // cone spans z [-4, +4] locally: park its centre 4 m along the ray so the
    // apex lands on the lens and the 1.2 m base floats 8 m ahead.
    this.beam.position.set(ex + nx * 4, 1.52 + ny * 4, ez + nz * 4);
    this.tmpA.set(ex + nx * 10, 1.52 + ny * 10, ez + nz * 10);
    this.beam.lookAt(this.tmpA);
    void this.tmpB;
  }
}


