export class Color3 {
  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }
  copyFrom(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color3(this.r, this.g, this.b); }
}
export class Vector3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
export class PointLight {
  constructor(name, pos, scene) { this.name = name; this.position = pos;
    this.intensity = 0; this.range = 0; this.diffuse = null; }
}