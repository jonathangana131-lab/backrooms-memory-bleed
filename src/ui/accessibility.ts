/**
 * Accessibility options for BACKROOMS: MEMORY BLEED.
 *
 * Mirrors the persistence pattern of src/ui/settings.ts: pure TypeScript
 * core (canonical schema, validating loader, StorageLike-injected manager,
 * change callbacks) plus an opt-in DOM layer that owns only its own style
 * element, data attributes, and audio-caption overlay subtree.
 *
 * Features:
 *  - motionReduction     : disables camera shake / head bob / FOV kick,
 *                          scales down screen effects, freezes CSS motion
 *  - highContrast        : brighter HUD text, stronger outlines/borders
 *  - subtitleBackground  : solid backing behind subtitles instead of shadow
 *  - instantInteract     : hold-to-interact becomes instant on press
 *  - audioCaptions       : labeled edge-of-screen flashes for loud sounds
 */
import type { StorageLike } from './settings';

/** Canonical player-facing accessibility schema. All flags default OFF. */
export interface AccessibilityOptions {
  /** Disable camera shake, head bob, FOV kick; reduce screen effects. */
  motionReduction: boolean;
  /** Brighter HUD text and stronger outlines. */
  highContrast: boolean;
  /** Solid backing behind subtitles instead of shadow only. */
  subtitleBackground: boolean;
  /** Interactions trigger instantly on press instead of hold duration. */
  instantInteract: boolean;
  /** Visual captions ([THUNDER], [SCREAM], [IMPACT]) for loud sounds. */
  audioCaptions: boolean;
}

/** localStorage key used for persisted accessibility options. */
export const ACCESSIBILITY_KEY = 'bmb-accessibility';

/** Factory defaults - every accessibility aid starts disabled. */
export const DEFAULT_ACCESSIBILITY_OPTIONS: Readonly<AccessibilityOptions> =
  Object.freeze({
    motionReduction: false,
    highContrast: false,
    subtitleBackground: false,
    instantInteract: false,
    audioCaptions: false,
  });

/** Known loud-sound caption kinds. Arbitrary strings are also accepted. */
export const CAPTION_KINDS = ['THUNDER', 'SCREAM', 'IMPACT'] as const;

export type CaptionKind = (typeof CAPTION_KINDS)[number];

/**
 * Bracketed label for a sound kind, e.g. 'thunder' -> '[THUNDER]'.
 * Unknown kinds are upper-cased rather than rejected so new sounds work
 * without touching this module.
 */
export function captionLabel(kind: string): string {
  return '[' + String(kind).toUpperCase() + ']';
}

/** Global motion multiplier: 0 when reduction is on, otherwise 1. */
export function motionScale(options: AccessibilityOptions): 0 | 1 {
  return options.motionReduction ? 0 : 1;
}

/** Camera-shake intensity after reduction (0 when reduced). */
export function shakeIntensity(
  options: AccessibilityOptions,
  baseIntensity: number,
): number {
  return baseIntensity * motionScale(options);
}

/** Head-bob amplitude after reduction (0 when reduced). */
export function headBobAmplitude(
  options: AccessibilityOptions,
  baseAmplitude: number,
): number {
  return baseAmplitude * motionScale(options);
}

/** FOV-kick degrees after reduction (0 when reduced). */
export function fovKickDeg(
  options: AccessibilityOptions,
  baseDegrees: number,
): number {
  return baseDegrees * motionScale(options);
}

/** Fraction of full-strength screen effects used while motion is reduced. */
export const REDUCED_EFFECT_SCALE = 0.35;

/** Screen-effect strength (vignette pulses, damage flashes, grain bursts). */
export function screenEffectStrength(
  options: AccessibilityOptions,
  baseStrength: number,
): number {
  return options.motionReduction
    ? baseStrength * REDUCED_EFFECT_SCALE
    : baseStrength;
}

/**
 * Hold duration for interactions: 0ms (instant on press) when
 * instantInteract is set, otherwise the gameplay-provided duration.
 */
export function interactionHoldMs(
  options: AccessibilityOptions,
  defaultHoldMs: number,
): number {
  return options.instantInteract ? 0 : defaultHoldMs;
}

/**
 * Validate arbitrary parsed data into a full AccessibilityOptions object.
 * Missing or non-boolean fields fall back to their defaults, mirroring
 * validateSettings() in settings.ts.
 */
export function validateAccessibilityOptions(
  raw: unknown,
): AccessibilityOptions {
  const src =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const bool = (key: keyof AccessibilityOptions): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : false;
  return {
    motionReduction: bool('motionReduction'),
    highContrast: bool('highContrast'),
    subtitleBackground: bool('subtitleBackground'),
    instantInteract: bool('instantInteract'),
    audioCaptions: bool('audioCaptions'),
  };
}

/** In-memory fallback so headless/non-browser hosts still work. */
class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function defaultStorage(): StorageLike {
  // Lazily probe globalThis so this module never hard-requires a DOM.
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (
      ls &&
      typeof ls.getItem === 'function' &&
      typeof ls.setItem === 'function'
    ) {
      return ls;
    }
  } catch {
    /* denied/unavailable - fall through */
  }
  return new MemoryStorage();
}

type OptionsListener = (options: AccessibilityOptions) => void;

/**
 * Owns the live accessibility options object, its persistence, and its
 * subscribers. Same contract shape as SettingsManager: instantiate once
 * at boot, mutate through set(), react through onChange().
 */
export class AccessibilityManager {
  private storage: StorageLike;
  private listeners = new Set<OptionsListener>();
  private current: AccessibilityOptions;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
    this.current = this.load();
  }

  /** Current options (defensive copy - mutate via set()). */
  get options(): Readonly<AccessibilityOptions> {
    return { ...this.current };
  }

  /** Read from storage, validating every field. */
  load(): AccessibilityOptions {
    let raw: unknown = null;
    try {
      const text = this.storage.getItem(ACCESSIBILITY_KEY);
      if (text !== null) raw = JSON.parse(text);
    } catch {
      /* corrupt JSON -> defaults below */
    }
    this.current = validateAccessibilityOptions(raw);
    return { ...this.current };
  }

  /** Persist the given-or-current options to storage. */
  save(options: AccessibilityOptions = this.current): void {
    try {
      this.storage.setItem(ACCESSIBILITY_KEY, JSON.stringify(options));
    } catch {
      /* quota/denied - persistence is best-effort */
    }
  }

  /**
   * Merge a partial patch into current options, validate, persist, and
   * notify listeners. Returns the resulting full snapshot.
   */
  set(patch: Partial<AccessibilityOptions>): AccessibilityOptions {
    this.current = validateAccessibilityOptions({ ...this.current, ...patch });
    this.save();
    this.notify();
    return { ...this.current };
  }

  /** Restore factory defaults, persist, notify. */
  reset(): AccessibilityOptions {
    this.current = validateAccessibilityOptions(DEFAULT_ACCESSIBILITY_OPTIONS);
    this.save();
    this.notify();
    return { ...this.current };
  }

  /**
   * Register a listener fired on every applied change. Returns an
   * unsubscribe function.
   */
  onChange(cb: OptionsListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    const snapshot = { ...this.current };
    for (const cb of this.listeners) cb(snapshot);
  }
}

/**
 * Data-attribute token list applied to the root element. CSS below keys
 * off these tokens so game stylesheets can also opt in.
 */
export function accessibilityTokens(options: AccessibilityOptions): string[] {
  const tokens: string[] = [];
  if (options.motionReduction) tokens.push('motion-reduced');
  if (options.highContrast) tokens.push('high-contrast');
  if (options.subtitleBackground) tokens.push('subtitle-bg');
  if (options.instantInteract) tokens.push('instant-interact');
  if (options.audioCaptions) tokens.push('audio-captions');
  return tokens;
}

/**
 * Stylesheet text for the active options. Pure function of the options so
 * tests can assert exact rules without a DOM.
 */
export function accessibilityCssText(options: AccessibilityOptions): string {
  let css = '';

  if (options.highContrast) {
    css += `
/* bmb a11y: high contrast */
html[data-bmb-a11y~="high-contrast"] #ui { color: #fff3bd; text-shadow: 0 0 2px #000, 0 0 4px #000; }
html[data-bmb-a11y~="high-contrast"] .objective { color: #ffedb0; text-shadow: 0 0 3px #000, 0 1px 2px #000; }
html[data-bmb-a11y~="high-contrast"] .subtitle { color: #ffffff; text-shadow: 0 0 3px #000, 0 0 6px #000; }
html[data-bmb-a11y~="high-contrast"] .prompt { color: #ffffff; background: rgba(0,0,0,0.9); border: 2px solid #ffe98a; box-shadow: 0 0 0 1px #000; }
html[data-bmb-a11y~="high-contrast"] .toast { color: #fff3bd; background: rgba(0,0,0,0.92); border-left: 3px solid #ffe98a; }
html[data-bmb-a11y~="high-contrast"] .crosshair { background: #ffffff; box-shadow: 0 0 0 2px #000, 0 0 6px rgba(255,255,255,0.8); }
html[data-bmb-a11y~="high-contrast"] .stamina-wrap { border: 2px solid #e8d878; background: rgba(0,0,0,0.85); }
html[data-bmb-a11y~="high-contrast"] .stamina-fill { filter: brightness(1.25); }
html[data-bmb-a11y~="high-contrast"] .btn { color: #fff3bd; border-width: 2px; border-color: #cdbf72; text-shadow: 0 0 2px #000; }
html[data-bmb-a11y~="high-contrast"] .btn:hover:not(.disabled) { color: #ffffff; border-color: #ffeea0; }
html[data-bmb-a11y~="high-contrast"] .debug-overlay { color: #d6ffb0; background: rgba(0,0,0,0.85); text-shadow: 0 0 2px #000; }
`;
  }

  if (options.subtitleBackground) {
    css += `
/* bmb a11y: subtitle background */
html[data-bmb-a11y~="subtitle-bg"] .subtitle {
  background: rgba(0, 0, 0, 0.82);
  border: 1px solid rgba(220, 205, 150, 0.35);
  border-radius: 3px;
  padding: 10px 18px;
  text-shadow: none;
}
`;
  }

  if (options.motionReduction) {
    css += `
/* bmb a11y: motion reduction - freeze UI transitions/animations */
html[data-bmb-a11y~="motion-reduced"] *,
html[data-bmb-a11y~="motion-reduced"] *::before,
html[data-bmb-a11y~="motion-reduced"] *::after {
  transition-duration: 0s !important;
  transition-property: none !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
}
`;
  }

  // Caption overlay chrome ships whenever the controller exists; the flash
  // pulse animation is suppressed under motion reduction.
  css += [
    '',
    '/* bmb a11y: audio caption overlay */',
    '.bmb-a11y-caption-layer { position: fixed; inset: 0; pointer-events: none; z-index: 70; }',
    '.bmb-a11y-caption {',
    '  position: absolute;',
    "  font: bold 13px 'Courier New', monospace;",
    '  letter-spacing: 2px;',
    '  color: #ffffff;',
    '  background: rgba(0, 0, 0, 0.88);',
    '  border: 1px solid rgba(255, 240, 170, 0.9);',
    '  padding: 5px 12px;',
    '  white-space: nowrap;',
    '}',
  ].join('\n');

  return css;
}

/** How long one caption flash stays visible, in ms. */
export const CAPTION_FLASH_MS = 1400;

/** Fixed edge slots captions cycle through, as [x%, y%] viewport coords. */
const CAPTION_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [4, 6],
  [78, 6],
  [4, 90],
  [78, 90],
];

/** Minimal structural surface of Document used by AccessibilityController. */
export interface A11yDocumentLike {
  createElement(tagName: string): A11yElementLike;
  head: { appendChild(child: A11yElementLike): unknown };
  documentElement: {
    dataset: Record<string, string>;
    appendChild(child: A11yElementLike): unknown;
  };
}

/** Minimal structural surface of HTMLElement used by AccessibilityController. */
export interface A11yElementLike {
  tagName?: string;
  className: string;
  textContent: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: A11yElementLike): unknown;
  removeChild?(child: A11yElementLike): unknown;
  remove(): void;
  children?: A11yElementLike[];
}

/**
 * DOM side of the accessibility system. Attach once at boot; it keeps the
 * root data attributes, the injected stylesheet, and the caption overlay
 * in sync with the manager. Owns nothing else in the page.
 */
export class AccessibilityController {
  private readonly doc: A11yDocumentLike;
  private readonly styleEl: A11yElementLike;
  private readonly captionLayer: A11yElementLike;
  private live: AccessibilityOptions;
  private slotIndex = 0;
  private detached = false;

  private constructor(doc: A11yDocumentLike, initial: AccessibilityOptions) {
    this.doc = doc;
    this.live = initial;
    this.styleEl = doc.createElement('style');
    this.captionLayer = doc.createElement('div');
    this.captionLayer.className = 'bmb-a11y-caption-layer';
    this.apply(initial);
    doc.head.appendChild(this.styleEl);
    doc.documentElement.appendChild(this.captionLayer);
  }

  /**
   * Create the controller bound to a manager: applies current options now
   * and re-applies on every change. Returns an unsubscribe-style cleanup.
   */
  static attach(
    manager: AccessibilityManager,
    doc: A11yDocumentLike,
  ): { controller: AccessibilityController; dispose(): void } {
    const controller = new AccessibilityController(doc, manager.options);
    const unsubscribe = manager.onChange((next) => controller.apply(next));
    return {
      controller,
      dispose(): void {
        unsubscribe();
        controller.detach();
      },
    };
  }

  /** Push an options snapshot into the DOM (root attrs + stylesheet). */
  apply(options: AccessibilityOptions): void {
    if (this.detached) return;
    this.live = options;
    this.doc.documentElement.dataset['bmbA11y'] =
      accessibilityTokens(options).join(' ');
    this.styleEl.textContent = accessibilityCssText(options);
    // Options turned off mid-flight: drop any flashes already on screen.
    if (!options.audioCaptions && this.captionLayer.children) {
      for (const child of [...this.captionLayer.children]) child.remove();
    }
  }

  /**
   * Flash a labeled caption at the screen edge for a loud sound. Accepts
   * a raw kind ('THUNDER') or a preformatted label ('[THUNDER]'). No-op
   * unless the audioCaptions option is enabled.
   */
  showCaption(kindOrLabel: string): A11yElementLike | null {
    if (this.detached || !this.live.audioCaptions) return null;
    const label = kindOrLabel.startsWith('[')
      ? kindOrLabel
      : captionLabel(kindOrLabel);
    const el = this.doc.createElement('div');
    el.className = 'bmb-a11y-caption';
    el.textContent = label;
    const [xPct, yPct] = CAPTION_SLOTS[this.slotIndex % CAPTION_SLOTS.length];
    this.slotIndex++;
    el.style.setProperty('left', xPct + '%');
    el.style.setProperty('top', yPct + '%');
    this.captionLayer.appendChild(el);
    const timer = setTimeout(() => {
      el.remove();
    }, CAPTION_FLASH_MS);
    const unwatch = () => clearTimeout(timer);
    (el as A11yElementLike & { __bmbUnwatch?: () => void }).__bmbUnwatch =
      unwatch;
    return el;
  }

  /** Remove every trace of the controller from the document. */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    delete this.doc.documentElement.dataset['bmbA11y'];
    this.styleEl.remove();
    if (this.captionLayer.children) {
      for (const child of [...this.captionLayer.children]) {
        const unwatch = (
          child as A11yElementLike & { __bmbUnwatch?: () => void }
        ).__bmbUnwatch;
        if (unwatch) unwatch();
        child.remove();
      }
    }
    this.captionLayer.remove();
  }
}


