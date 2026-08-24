/**
 * Camcorder optics for BACKROOMS: MEMORY BLEED (F92).
 *
 * Pure thin-lens optics model behind the photo-mode depth of field and the
 * focal breathing of the player's handheld camcorder. Given a focus
 * distance and zoom the model derives:
 *
 *   - DOF near/far limits via the hyperfocal equations, with focal length
 *     driven by the zoom position (wide 14 mm .. tele 56 mm on a
 *     Super-35-class sensor).
 *   - Focal breathing: zooming shifts the effective focal length, which
 *     narrows the field of view slightly toward the tele end. The breathing
 *     amplitude is seeded per lens serial (hash of the serial string via
 *     src/core/rng.ts), so each unit breathes differently but always within
 *     MAX_BREATH_RAD and always monotonically in zoom.
 *   - A render-consumer descriptor {nearBlur, farBlur, fovShiftRad} where
 *     the blur weights are normalized defocus fractions at the near and far
 *     side of the focus plane.
 *   - IR-mode coupling: with the injected irMode flag on, both blur weights
 *     scale by exactly IR_BLUR_CENTER_RATIO (the IR lens is center-weighted,
 *     so edge defocus reads softer); the fov shift is unaffected.
 *
 * Pure arithmetic: no DOM, no Babylon, no Date.now(), no Math.random() —
 * all seeded variation comes from src/core/rng.ts hashes (see
 * test/camoptics-test.mjs). Junk inputs never throw; they clamp into range.
 */

import { rand2, seedFromString } from '../core/rng';

// ---------------------------------------------------------------------------
// Lens constants
// ---------------------------------------------------------------------------

/** Wide-end focal length in mm. */
export const FOCAL_MIN_MM = 14;
/** Tele-end focal length in mm. */
export const FOCAL_MAX_MM = 56;
/** Lens iris used for the DOF model, in f-stops. */
export const APERTURE_FSTOPS = 2.8;
/** Circle of confusion in mm for the Super-35-class sensor. */
export const COC_MM = 0.03;
/** Sensor width in mm; sets the base field of view per focal length. */
export const SENSOR_WIDTH_MM = 23.5;
/** Closest focus distance in meters the lens can resolve. */
export const MIN_FOCUS_M = 0.15;
/** Hard ceiling on the focal-breathing FOV shift, in radians. */
export const MAX_BREATH_RAD = 0.02;
/** Breathing grows with the square of zoom: wide is calm, tele breathes. */
export const BREATH_EXPONENT = 2;
/**
 * Exact blur-weight ratio applied in IR mode. The IR tube is center-weighted,
 * so near/far blur weights drop to exactly this fraction of their visible-
 * light values; the AC proves the ratio holds to machine precision.
 */
export const IR_BLUR_CENTER_RATIO = 0.72;

/** Serial of the default lens when an injection omits or junks the serial. */
export const DEFAULT_LENS_SERIAL = 'BMB-BR-77';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Render-consumer descriptor produced by computeOptics. */
export interface OpticDescriptor {
  /** Normalized near-field defocus weight in 0..1 (1 = fully defocused). */
  nearBlur: number;
  /** Normalized far-field defocus weight in 0..1 (0 = infinity-focused). */
  farBlur: number;
  /**
   * Focal-breathing offset in radians; the consumer narrows its vertical FOV
   * by exactly this amount relative to baseFovRad(zoom).
   */
  fovShiftRad: number;
}

/** Injected input for one optic evaluation. */
export interface OpticInput {
  /** Focus distance in meters (clamped to MIN_FOCUS_M minimum). */
  focusDistM: number;
  /** Zoom position in 0..1 (wide..tele); junk clamps into range. */
  zoom: number;
  /** When true, blur weights shift by exactly IR_BLUR_CENTER_RATIO. */
  irMode?: boolean;
  /** Lens serial string seeding the breathing amplitude. */
  lensSerial?: string;
}

// ---------------------------------------------------------------------------
// Optics primitives
// ---------------------------------------------------------------------------

/** Clamp a number into [lo, hi]; non-finite values collapse to lo. */
function clampFinite(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Focal length in mm at a zoom position.
 *
 * @param zoom Zoom position; junk/out-of-range clamps to 0..1.
 * @returns Linear interpolation FOCAL_MIN_MM..FOCAL_MAX_MM.
 */
export function focalMm(zoom: number): number {
  const z = clampFinite(zoom, 0, 1);
  return FOCAL_MIN_MM + z * (FOCAL_MAX_MM - FOCAL_MIN_MM);
}

/**
 * Base vertical-equivalent horizontal FOV in radians before breathing.
 *
 * @param zoom Zoom position in 0..1.
 * @returns Full horizontal angle subtended by SENSOR_WIDTH_MM at the lens.
 */
export function baseFovRad(zoom: number): number {
  const f = focalMm(zoom);
  return 2 * Math.atan(SENSOR_WIDTH_MM / (2 * f));
}

/**
 * Deterministic seed integer derived from a lens serial string. Junk serials
 * (non-string or empty) fall back to DEFAULT_LENS_SERIAL so every call site
 * sees one stable default lens instead of divergent behavior.
 *
 * @param lensSerial Serial engraved on the lens body.
 * @returns 32-bit unsigned hash usable with rand2.
 */
export function lensSeedFromSerial(lensSerial: string): number {
  const s = typeof lensSerial === 'string' && lensSerial.length > 0
    ? lensSerial
    : DEFAULT_LENS_SERIAL;
  return seedFromString(s);
}

/**
 * Breathing amplitude for one lens, from its serial hash. Every lens gets a
 * distinct amplitude in [0.35, 1] x MAX_BREATH_RAD, but no lens exceeds the
 * ceiling, keeping the AC bound exact for any serial.
 *
 * @param lensSeed Seed integer from lensSeedFromSerial.
 * @returns Amplitude in radians, strictly positive.
 */
export function breathAmplitudeRad(lensSeed: number): number {
  const u = rand2(lensSeed | 0, 0x1e55, 0x0e92);
  return (0.35 + 0.65 * u) * MAX_BREATH_RAD;
}

/**
 * Focal-breathing FOV shift at a zoom position for a seeded lens.
 * Strictly increasing in zoom (amplitude x z^BREATH_EXPONENT) and bounded
 * by the lens amplitude, itself bounded by MAX_BREATH_RAD.
 *
 * @param zoom Zoom position; junk clamps to 0..1.
 * @param lensSeed Seed integer from lensSeedFromSerial.
 * @returns Shift in radians in [0, MAX_BREATH_RAD].
 */
export function fovShiftRad(zoom: number, lensSeed: number): number {
  const z = clampFinite(zoom, 0, 1);
  return breathAmplitudeRad(lensSeed) * Math.pow(z, BREATH_EXPONENT);
}

/**
 * Hyperfocal distance in meters: H = f^2 / (N c) + f.
 *
 * @param zoom Zoom position in 0..1.
 * @returns Hyperfocal distance in meters (> 0).
 */
export function hyperfocalM(zoom: number): number {
  const fMm = focalMm(zoom);
  return (fMm * fMm) / (APERTURE_FSTOPS * COC_MM) / 1000 + fMm / 1000;
}

/** Focus distance clamped to the lens' closest resolvable distance. */
function saneFocus(distM: number): number {
  return clampFinite(distM, MIN_FOCUS_M, Number.MAX_VALUE);
}

/**
 * Near DOF limit in meters: s(H-f)/(H+s-2f).
 *
 * @param distM Focus distance in meters.
 * @param zoom Zoom position in 0..1.
 * @returns Near limit, always <= focus distance.
 */
export function dofNearM(distM: number, zoom: number): number {
  const s = saneFocus(distM);
  const H = hyperfocalM(zoom);
  const f = focalMm(zoom) / 1000;
  const denom = H + s - 2 * f;
  // Denominator is positive across the whole focal table (f < N*c), but the
  // guard keeps degenerate future constant edits from emitting negatives.
  if (!(denom > 0)) return s;
  return (s * (H - f)) / denom;
}

/**
 * Far DOF limit in meters: s(H-f)/(H-s); Infinity once the subject sits at
 * or beyond the hyperfocal distance (far branch merges with infinity).
 *
 * @param distM Focus distance in meters.
 * @param zoom Zoom position in 0..1.
 * @returns Far limit >= focus distance, or Infinity past hyperfocal.
 */
export function dofFarM(distM: number, zoom: number): number {
  const s = saneFocus(distM);
  const H = hyperfocalM(zoom);
  const f = focalMm(zoom) / 1000;
  const denom = H - s;
  if (!(denom > 0)) return Infinity;
  return (s * (H - f)) / denom;
}

/** Clamp into 0..1; non-finite collapses to 0. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Evaluate the full render-consumer optic descriptor. Junk inputs clamp —
 * NaN/Infinity distances collapse to MIN_FOCUS_M, junk zooms to 0 — so the
 * output never contains non-finite numbers. With irMode on, both blur
 * weights are exactly IR_BLUR_CENTER_RATIO times their visible-light values.
 *
 * @param input Focus/zoom pose plus optional IR flag and lens serial.
 * @returns Descriptor with finite nearBlur/farBlur in 0..1 and
 *   fovShiftRad in [0, MAX_BREATH_RAD].
 */
export function computeOptics(input: OpticInput): OpticDescriptor {
  const d = saneFocus(input.focusDistM);
  const zoom = clampFinite(input.zoom, 0, 1);
  const seed = lensSeedFromSerial(input.lensSerial ?? '');
  const near = dofNearM(d, zoom);
  const far = dofFarM(d, zoom);
  let nearBlur = clamp01(1 - near / d);
  let farBlur = far === Infinity ? 0 : clamp01(1 - d / far);
  if (input.irMode === true) {
    nearBlur *= IR_BLUR_CENTER_RATIO;
    farBlur *= IR_BLUR_CENTER_RATIO;
  }
  return { nearBlur, farBlur, fovShiftRad: fovShiftRad(zoom, seed) };
}
