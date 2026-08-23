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
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Disposal probe that tolerates Babylon builds where Material lacks
 * isDisposed(); degrades to "not disposed" rather than crashing.
 */


