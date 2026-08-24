const node = (name) => ({
  name,
  position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  rotation: { x: 0, y: 0, z: 0 },
  scaling: { x: 1, y: 1, z: 1 },
  isVisible: true,
  isPickable: false,
  material: null,
  parent: null,
  getChildMeshes: () => [],
  dispose() {},
});
export class TransformNode { constructor(n) { Object.assign(this, node(n)); } }
export const MeshBuilder = { CreateBox: (n) => node(n), CreateSphere: (n) => node(n) };
export class StandardMaterial { constructor(n) { this.name = n; } }
export class Color3 {}
export class Vector3 {}