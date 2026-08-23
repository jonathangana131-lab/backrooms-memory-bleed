
export type ProjectionMesh = Mesh & { setFlicker(tMs: number): void };

const TEX_W = 512;
const TEX_H = 128;

/**
 * Projector flicker at time tMs: a slow double-sine breathe with occasional
 * deterministic bulb sags. Pure function of tMs.
 */
export function flickerAlpha(tMs: number): number {
  const t = tMs * 0.001;
  let a = 0.86 + 0.09 * Math.sin(t * 5.9) * Math.sin(t * 1.71 + 0.6);
  const win = Math.floor(t / 2.3);
  if (hash32(win) % 97 < 14) a *= 0.42 + (hash32(win ^ 0x9e37) % 20) / 100;
  return Math.max(0, Math.min(1, a));
}

/**
 * Build the projected-text quad for a placement: canvas-generated texture
 * (soft-edged warm-white letters on transparent ground), additive-ish
 * alpha blending, floating 0.02 m off the wall. The returned mesh carries
 * setFlicker(tMs), which modulates visibility like a failing lamp.
 */
export function makeProjectionMesh(scene: Scene, place: ProjectionPlacement): ProjectionMesh {
  const tex = new DynamicTexture('projectionTex', { width: TEX_W, height: TEX_H }, scene, true);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 64px "Courier New", monospace';
  ctx.save();
  ctx.translate(TEX_W / 2, TEX_H / 2);
  // outer bloom pass then hot core pass -> soft projector edge falloff
  ctx.shadowColor = 'rgba(255,240,205,0.9)';
  ctx.shadowBlur = 26;
  ctx.fillStyle = 'rgba(255,244,218,0.5)';
  ctx.fillText(place.text, 0, 0);
  ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(255,248,232,0.95)';
  ctx.fillText(place.text, 0, 0);
  ctx.restore();
  tex.update(false);

  const mat = new StandardMaterial('projectionMat', scene);
  mat.diffuseTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(1, 0.95, 0.84); // warm white
  mat.specularColor = new Color3(0, 0, 0);
  mat.alphaMode = Constants.ALPHA_ADD; // additive-ish: light thrown on plaster
  mat.backFaceCulling = false;
  mat.alpha = flickerAlpha(0);

  const w = Math.min(2.4, place.text.length * 0.22 + 0.3);
  const mesh = MeshBuilder.CreatePlane('projection', { width: w, height: 0.5 }, scene);
  // offset along the facing normal pushes the quad off the wall
  mesh.position.set(
    place.x + Math.sin(place.rotY) * PROJECTION_OFFSET,
    PROJECTION_Y,
    place.z + Math.cos(place.rotY) * PROJECTION_OFFSET,
  );
  mesh.rotation.y = place.rotY;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();

  const setFlicker = (tMs: number): void => {
    mat.alpha = flickerAlpha(tMs);
  };
  return Object.assign(mesh, { setFlicker }) as ProjectionMesh;
}


