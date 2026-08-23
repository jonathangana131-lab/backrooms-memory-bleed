/**
 * Supernatural entity transition effects for BACKROOMS: MEMORY BLEED.
 *
 * Things do not simply pop into the Backrooms. They condense out of nothing,
 * and when they leave they dissolve back into it. This module provides:
 *
 *   - fadeIn:      alpha ramp 0 -> original over ~0.8 s (ease-out)
 *   - dissolveOut: alpha ramp to 0 + upward drift over 0.6 s
 *   - dimFixture:  brief emissive sag on nearby fixtures while something manifests
 *
 * Materials in this codebase are shared across figures (humans.ts hands every
 * reconstruction the same 'humanMat'/'believerMat'), so these helpers clone
 * the mesh's material before touching alpha and restore the original when the
 * transition completes. All animation is per-frame lerping driven by
 * scene.onBeforeRenderObservable; delta time comes from the engine.
 *
 * Every entry point is null-safe: a missing mesh, scene, engine or material
 * degrades to a silent no-op rather than corrupting a spawn or despawn call.
 */
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { Scene } from '@babylonjs/core/scene';

const DISSOLVE_DURATION = 0.6;
const DISSOLVE_DRIFT = 0.15;
const DIM_FRACTION = 0.2;
const DIM_DURATION = 0.5;

/** ease-out quad: fast start, gentle settle */
function easeOut(t: number): void {
  return 1 - (1 - t) * (1 - t);
}

/** engine delta time in seconds, with a sane fallback if the engine lies */
function frameDelta(scene: Scene): number {
  const dt = scene.getEngine().getDeltaTime() / 1000;
  return Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
}

/**
 * Run step() once per frame on the scene's before-render observable until it
 * returns true, then detach. Null-safe on the observable.
 */
function eachFrame(scene: Scene | null | undefined, step: (dtSec: number) => boolean): void {
  if (!scene || !scene.onBeforeRenderObservable) return;
  let obs: Observer<Scene> | null = null;
  obs = scene.onBeforeRenderObservable.add(() => {
    if (!obs) return;
    if (step(frameDelta(scene))) {
      scene.onBeforeRenderObservable.remove(obs);
    }
  });
}

/**
 * Fade a mesh in from nothing: clones its material, lerps alpha 0 -> original
 * over durationSec with an ease-out curve, then restores the original material
 * and disposes the temporary clone. No-ops without a mesh/scene/material.
 */
export function fadeIn(mesh: Mesh | null | undefined, durationSec = 0.8): void {
  if (!mesh || mesh.isDisposed()) return;
  const scene = mesh.getScene();
  const original = mesh.material as Material | null;
  if (!scene || !original) return;

  const targetAlpha = original.alpha;
  const temp = original.clone(original.name + '_fadeIn');
  if (!temp) return;
  temp.alpha = 0;
  mesh.material = temp;

  let elapsed = 0;
  eachFrame(scene, (dt: number) => {
    // mesh vanished mid-transition: bail out cleanly
    if (mesh.isDisposed()) {
      temp.dispose(false, false);
      return true;
    }
    elapsed += dt;
    const t = Math.min(elapsed / durationSec, 1);
    temp.alpha = targetAlpha * easeOut(t);
    if (t >= 1) {
      mesh.material = original;
      temp.dispose(false, false);
      return true;
    }
    return false;
  });
}

/**
 * Dissolve a mesh back into the Backrooms: lerps alpha -> 0 over 0.6 s while
 * drifting the mesh up by DISSOLVE_DRIFT metres, fires onComplete, restores
 * the original material, then disposes the temporary clone. No-ops safely.
 */
export function dissolveOut(mesh: Mesh | null | undefined, onComplete: (() => void) | undefined): void {
  if (!mesh || mesh.isDisposed()) return;
  const scene = mesh.getScene();
  const original = mesh.material as Material | null;
  if (!scene || !original) return;

  const startY = mesh.position.y;
  const startAlpha = original.alpha;
  const temp = original.clone(original.name + '_dissolve');
  if (!temp) return;
  mesh.material = temp;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!mesh.isDisposed()) mesh.material = original!;
    onComplete && onComplete();
    temp.dispose(false, false);
  };

  let elapsed = 0;
  eachFrame(scene, (dt: number) => {
    if (mesh.isDisposed()) {
      finish();
      return true;
    }
    elapsed += dt;
    const t = Math.min(elapsed / DISSOLVE_DURATION, 1);
    const eased = easeOut(t);
    temp.alpha = startAlpha * (1 - eased);
    mesh.position.y = startY + DISSOLVE_DRIFT * eased;
    if (t >= 1) {
      finish();
      return true;
    }
    return false;
  });
}

/**
 * Briefly sag a fixture's emissive output by DIM_FRACTION for DIM_DURATION
 * seconds — the power draw of something manifesting nearby — then restore it
 * exactly. Sag and recovery ramps take 25% of the window each. No-ops safely.
 */
export function dimFixture(mat: StandardMaterial | null | undefined): void {
  if (!mat || mat.isDisposed()) return;
  const scene = mat.getScene();
  if (!scene) return;

  const originalEmissive = mat.emissiveColor.clone();
  const dimmed = originalEmissive.scale(1 - DIM_FRACTION);
  const ramp = DIM_DURATION * 0.25;

  let elapsed = 0;
  eachFrame(scene, (dt: number) => {
    if (mat.isDisposed()) return true;
    elapsed += dt;
    if (elapsed <= ramp) {
      mat.emissiveColor = Color3.Lerp(originalEmissive, dimmed, elapsed / ramp);
    } else if (elapsed < DIM_DURATION - ramp) {

(Showing lines 30-159 of 169. Use offset=160 to continue.)

  const ramp = DIM_DURATION * 0.25;

  let elapsed = 0;
  eachFrame(scene, (dt: number) => {
    if (materialDisposed(mat!)) return true;
    elapsed += dt;
    if (elapsed <= ramp) {
      mat.emissiveColor = Color3.Lerp(originalEmissive, dimmed, elapsed / ramp);
    } else if (elapsed < DIM_DURATION - ramp) {
      mat.emissiveColor = dimmed;
    } else if (elapsed < DIM_DURATION) {
      mat.emissiveColor = Color3.Lerp(dimmed, originalEmissive, (elapsed - (DIM_DURATION - ramp)) / ramp);
    } else {
      mat.emissiveColor = originalEmissive;
      return true;
    }
    return false;
  });
}


