/**
 * F49 Accessibility pack for BACKROOMS: MEMORY BLEED.
 *
 * Three independent toggles over injected options
 * {motionSafety, speakerTags, highContrast}. Every toggle zeroes its own
 * effect EXACTLY when off: each effector is a passthrough identity in the
 * off state, and enabling one never alters another toggle's output.
 *
 * Features:
 *  - motionSafety : camera shake/tilt suppression. filter(shakeVec)
 *                   returns a zeroed vector when on; passthrough off.
 *  - speakerTags  : subtitle lines get '[SPEAKER]' prefixes from an
 *                   injected speaker map (helper/believer/double/watcher/
 *                   system -> distinct tags; unknown -> '[???]').
 *  - highContrast : palette override descriptor {bgLift, textBoost,
 *                   outlineStrength} for the CSS layer; no override off.
 *
 * Junk options FAIL LOUD: validateAccessibilityPackOptions() throws a
 * TypeError naming every offending field instead of silently defaulting,
 * because a silently-disabled motion-safety mode is a player-safety lie.
 */

/** Canonical accessibility-pack schema. All toggles default OFF. */
export interface AccessibilityPackOptions {
  /** Suppress camera shake and tilt outputs. */
  motionSafety: boolean;
  /** Prefix subtitle lines with bracketed speaker tags. */
  speakerTags: boolean;
  /** Apply the high-contrast palette override descriptor. */
  highContrast: boolean;
}

/** Factory defaults - every pack toggle starts disabled. */
export const DEFAULT_ACCESSIBILITY_PACK_OPTIONS: Readonly<AccessibilityPackOptions> =
  Object.freeze({ motionSafety: false, speakerTags: false, highContrast: false });

const TOGGLE_KEYS = ['motionSafety', 'speakerTags', 'highContrast'] as const;

/**
 * Validate arbitrary parsed data into a full AccessibilityPackOptions.
 * Unlike src/ui/accessibility.ts's lenient persistence loader, this gate
 * is for injected runtime options: any non-object input, missing key, or
 * non-boolean value throws a TypeError listing the offending fields, so
 * a misconfigured injection surfaces at the earliest resolvable point.
 *
 * @param raw - candidate options, typically from an injected config.
 * @returns a fresh options object with exactly the three canonical booleans.
 * @throws TypeError when raw is not an object or any toggle is not boolean.
 */
export function validateAccessibilityPackOptions(
  raw: unknown,
): AccessibilityPackOptions {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(
      'accessibilitypack: options must be an object with boolean fields ' +
        TOGGLE_KEYS.join('/') +
        ', got ' +
        (raw === null ? 'null' : typeof raw),
    );
  }
  const src = raw as Record<string, unknown>;
  const bad = TOGGLE_KEYS.filter((k) => typeof src[k] !== 'boolean');
  if (bad.length > 0) {
    throw new TypeError(
      'accessibilitypack: non-boolean option fields: ' +
        bad.map((k) => k + '=' + String(src[k])).join(', '),
    );
  }
  return {
    motionSafety: src['motionSafety'] as boolean,
    speakerTags: src['speakerTags'] as boolean,
    highContrast: src['highContrast'] as boolean,
  };
}

/* ------------------------------------------------------------------ */
/* motionSafety                                                        */
/* ------------------------------------------------------------------ */

/** Minimal structural surface of a shake vector consumed by this pack. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Canonical zeroed shake output for motion-safety mode. */
export const ZERO_SHAKE: Readonly<Vec3Like> = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Build the camera-shake effector for the given options.
 *
 * @param options - validated pack options.
 * @returns a pure filter: with motionSafety ON every input maps to the
 *          shared zeroed vector; OFF it is the passthrough identity and
 *          returns the argument object unchanged by reference.
 */
export function createShakeFilter(
  options: AccessibilityPackOptions,
): (shakeVec: Vec3Like) => Vec3Like {
  if (!options.motionSafety) return (v) => v;
  return () => ZERO_SHAKE;
}

/**
 * Build the camera-tilt effector for the given options.
 *
 * @param options - validated pack options.
 * @returns a pure filter over a roll angle in radians: 0 whenever
 *          motionSafety is ON; the passthrough identity otherwise.
 */
export function createTiltFilter(
  options: AccessibilityPackOptions,
): (tiltRad: number) => number {
  if (!options.motionSafety) return (r) => r;
  return () => 0;
}

/* ------------------------------------------------------------------ */
/* speakerTags                                                         */
/* ------------------------------------------------------------------ */

/** Default speaker -> bracketed-tag map; every tag is distinct. */
export const DEFAULT_SPEAKER_TAGS: Readonly<Record<string, string>> =
  Object.freeze({
    helper: '[HELPER]',
    believer: '[BELIEVER]',
    double: '[DOUBLE]',
    watcher: '[WATCHER]',
    system: '[SYSTEM]',
  });

/** Tag substituted for speakers absent from the injected map. */
export const UNKNOWN_SPEAKER_TAG = '[???]';

/**
 * Build the subtitle tagger for the given options.
 *
 * @param options - validated pack options.
 * @param tags - optional injected speaker map overlaid on the defaults;
 *               its keys win per key, unmapped speakers keep their default
 *               tags, and lookup is case-insensitive.
 * @returns a pure function: with speakerTags OFF the line passes through
 *          unchanged (identity); ON, the returned line is
 *          '<TAG> <line>' using the mapped tag, or UNKNOWN_SPEAKER_TAG
 *          when the speaker has no mapping at all.
 */
export function createSubtitleTagger(
  options: AccessibilityPackOptions,
  tags: Readonly<Record<string, string>> = DEFAULT_SPEAKER_TAGS,
): (speaker: string, line: string) => string {
  if (!options.speakerTags) return (_speaker, line) => line;
  const lowered = new Map<string, string>();
  for (const key of Object.keys(DEFAULT_SPEAKER_TAGS)) {
    lowered.set(key.toLowerCase(), DEFAULT_SPEAKER_TAGS[key]!);
  }
  for (const key of Object.keys(tags)) lowered.set(key.toLowerCase(), tags[key]!);
  return (speaker, line) => {
    const tag = lowered.get(String(speaker).toLowerCase()) ?? UNKNOWN_SPEAKER_TAG;
    return tag + ' ' + line;
  };
}

/* ------------------------------------------------------------------ */
/* highContrast                                                        */
/* ------------------------------------------------------------------ */

/** Palette override descriptor applied to the CSS layer when enabled. */
export interface HighContrastPalette {
  /** Fraction (0..1) the background is lifted toward readable grey. */
  bgLift: number;
  /** Multiplier (>=1, <=2) applied to HUD/subtitle text brightness. */
  textBoost: number;
  /** Fraction (0..1) of full outline strength drawn around text/UI. */
  outlineStrength: number;
}

/** Canonical high-contrast palette used when no override is injected. */
export const HIGH_CONTRAST_PALETTE: Readonly<HighContrastPalette> = Object.freeze({
  bgLift: 0.24,
  textBoost: 1.4,
  outlineStrength: 0.85,
});

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Resolve the palette override descriptor for the given options.
 *
 * @param options - validated pack options.
 * @param palette - optional injected palette overriding HIGH_CONTRAST_PALETTE.
 * @returns the clamped palette while highContrast is ON, otherwise null -
 *          "no override" is the off-state identity for the CSS layer.
 */
export function resolveHighContrastPalette(
  options: AccessibilityPackOptions,
  palette: HighContrastPalette = HIGH_CONTRAST_PALETTE,
): HighContrastPalette | null {
  if (!options.highContrast) return null;
  return {
    bgLift: clamp01(palette.bgLift),
    textBoost: Math.min(2, Math.max(1, palette.textBoost)),
    outlineStrength: clamp01(palette.outlineStrength),
  };
}

/**
 * Render the palette descriptor as CSS custom-property declarations for
 * the stylesheet layer.
 *
 * @param palette - descriptor from resolveHighContrastPalette(), or null.
 * @returns '' when palette is null (off-state identity emits no rules),
 *          otherwise one '--bmb-hc-*' declaration per field.
 */
export function paletteCssText(palette: HighContrastPalette | null): string {
  if (!palette) return '';
  return [
    '--bmb-hc-bg-lift: ' + palette.bgLift.toFixed(3) + ';',
    '--bmb-hc-text-boost: ' + palette.textBoost.toFixed(3) + ';',
    '--bmb-hc-outline-strength: ' + palette.outlineStrength.toFixed(3) + ';',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* composed pack                                                       */
/* ------------------------------------------------------------------ */

/**
 * All three effectors bound to one validated options snapshot. Toggles
 * are independent by construction: each effector consults only its own
 * boolean, so combined modes compose without interference.
 */
export interface AccessibilityPack {
  /** Validated options this pack was built from. */
  readonly options: Readonly<AccessibilityPackOptions>;
  /** Camera-shake filter (zeroed under motionSafety, identity off). */
  filterShake(shakeVec: Vec3Like): Vec3Like;
  /** Camera-tilt filter in radians (0 under motionSafety, identity off). */
  filterTilt(tiltRad: number): number;
  /** Subtitle tagger (prefixed under speakerTags, identity off). */
  tagSubtitle(speaker: string, line: string): string;
  /** Palette descriptor for the CSS layer (null when highContrast off). */
  palette(): HighContrastPalette | null;
}

/**
 * Build a complete pack from injected options.
 *
 * @param options - candidate options; validated here, failing loud.
 * @param tags - optional injected speaker map for createSubtitleTagger.
 * @param palette - optional injected palette for resolveHighContrastPalette.
 * @returns the composed pack.
 * @throws TypeError when options are junk (see validateAccessibilityPackOptions).
 */
export function createAccessibilityPack(
  options: AccessibilityPackOptions,
  tags?: Readonly<Record<string, string>>,
  palette?: HighContrastPalette,
): AccessibilityPack {
  const valid = validateAccessibilityPackOptions(options);
  const shake = createShakeFilter(valid);
  const tilt = createTiltFilter(valid);
  const tag = createSubtitleTagger(valid, tags);
  return {
    options: { ...valid },
    filterShake: shake,
    filterTilt: tilt,
    tagSubtitle: tag,
    palette: () => resolveHighContrastPalette(valid, palette),
  };
}
