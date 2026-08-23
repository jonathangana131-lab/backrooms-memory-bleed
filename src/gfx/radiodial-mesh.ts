/**
 * Radio dial mesh integration - bridges radiodial.ts's pure canvas painters
 * into Babylon materials for the radios placed by radioprops.ts.
 *
 * Three factories:
 *
 *  - createDialTexture    : DynamicTexture carrying paintDial's resting
 *                           face (dim amber scale on aged bakelite).
 *  - createDialLitTexture : same flow over paintDialLit - the emissively
 *                           lit tuned twin with the hot glowing scale.
 *  - createDialMaterial   : StandardMaterial wiring the resting face into
 *                           diffuseMap and the lit face into emissiveMap,
 *                           so an unlit radio reads as dark plastic under
 *                           scene lighting while its scale still glows the
 *                           moment the tuner powers it.
 *
 * Everything is deterministic per seed: both painters hash their grain off
 * the seed, so a given radio always wears the same face across sessions.
 */
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

import {
  dialCanvasSize,
  paintDial,
  paintDialLit,
} from './radiodial';

/** Warm amber tint multiplying the lit emissive face. */
const DIAL_EMISSIVE_TINT = new Color3(1.0, 0.82, 0.45);

/**
 * Paint one dial variant into a fresh DynamicTexture sized by
 * dialCanvasSize() and upload it to the GPU.
 *
 * @param scene owning scene
 * @param seed  radio seed - drives brand, grain, scratches, rest needle
 * @param name  texture name (unique-ish per radio)
 * @param lit   false -> paintDial resting face, true -> paintDialLit twin
 */
function bakeDialTexture(
  scene: Scene,
  seed: number,
  name: string,
  lit: boolean,
): DynamicTexture {
  const { width, height } = dialCanvasSize();
  const tex = new DynamicTexture(name, { width, height }, scene, true);
  const ctx = tex.getContext() as unknown as import('./radiodial').DialCtx;
  if (lit) {
    paintDialLit(ctx, width, height, seed);
  } else {
    paintDial(ctx, width, height, seed);
  }
  tex.update(false);
  return tex;
}

/**
 * Resting dial face as a DynamicTexture: dim FM scale on aged plastic,
 * deterministic for the given radio seed.
 */
export function createDialTexture(scene: Scene, seed: number): DynamicTexture {
  return bakeDialTexture(scene, seed, 'dialTex' + seed, false);
}

/**
 * Emissively lit twin as a DynamicTexture: surging backlight, hot scale,
 * burning needle. Same layout as createDialTexture so a material swap
 * between the two reads as power, not redesign.
 */
export function createDialLitTexture(scene: Scene, seed: number): DynamicTexture {
  return bakeDialTexture(scene, seed, 'dialLitTex' + seed, true);
}

/**
 * Material factory for one radio's dial quad.
 *
 *  - diffuseMap : the resting face (responds to scene lights)
 *  - emissiveMap: the lit face (glows regardless of lighting), multiplied
 *                 by a warm amber emissiveColor
 *  - specular   : killed outright; bakelite does not gleam
 *
 * Deterministic per seed - every radio of the same seed gets identical
 * faces.
 */
export function createDialMaterial(scene: Scene, seed: number): StandardMaterial {
  const mat = new StandardMaterial('dialMat' + seed, scene);
  mat.diffuseTexture = createDialTexture(scene, seed);
  mat.emissiveTexture = createDialLitTexture(scene, seed);
  mat.emissiveColor = DIAL_EMISSIVE_TINT;
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = true;
  return mat;
}


