/**
 * Floating dust motes — the particles that make empty rooms feel real.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

const COUNT = 300;
const RANGE = 18;

export class DustMotes {
  private mesh: Mesh;
  private positions: Float32Array;
  private velocities: Float32Array;

  constructor(scene: Scene) {
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RANGE * 2;
      positions[i * 3 + 1] = Math.random() * 3.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RANGE * 2;
    }
    this.positions = positions;
    this.velocities = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.velocities[i * 3] = (Math.random() - 0.5) * 0.02;
      this.velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.008;
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.02;
    }

    const mesh = new Mesh('dust', scene);
    const vd = new VertexData();
    vd.positions = Array.from(positions);
    vd.applyToMesh(mesh, true); // updatable

    const mat = new StandardMaterial('dustMat', scene);
    mat.emissiveColor = new Color3(0.6, 0.58, 0.48);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.alpha = 0.35;
    mat.pointsCloud = true;
    mat.pointSize = 2;
    mesh.material = mat;
    this.mesh = mesh;
  }

  update(dt: number, camX: number, camZ: number): void {
    const pos = this.positions;
    const vel = this.velocities;
    const halfR = RANGE;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      pos[ix] += vel[ix] * dt;
      pos[ix + 1] += vel[ix + 1] * dt;
      pos[ix + 2] += vel[ix + 2] * dt;
      pos[ix] += Math.sin(pos[ix + 1] * 3 + i) * 0.0005;
      const dx = pos[ix] - camX;
      if (dx > halfR) pos[ix] -= halfR * 2;
      else if (dx < -halfR) pos[ix] += halfR * 2;
      const dz = pos[ix + 2] - camZ;
      if (dz > halfR) pos[ix + 2] -= halfR * 2;
      else if (dz < -halfR) pos[ix + 2] += halfR * 2;
      if (pos[ix + 1] < 0.05 || pos[ix + 1] > 3.15) vel[ix + 1] *= -1;
    }
    // update GPU buffer
    const vb = this.mesh.getVerticesData('position');
    if (vb) {
      const newData = new Float32Array(pos);
      this.mesh.setVerticesData('position', newData);
    }
  }
}


