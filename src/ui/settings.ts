/**
 * Settings persistence for BACKROOMS: MEMORY BLEED.
 *
 * Pure TypeScript - no DOM access anywhere. Browser storage is reached
 * through a minimal StorageLike interface injected by the host (the game
 * passes localStorage; tests pass an in-memory stub or nothing).
 *
 * Responsibilities:
 *  - canonical schema + defaults (key 'bmb-settings')
 *  - load-time clamping / fallback so corrupt data can never break boot
 *  - export/import round-trips for shareable settings blobs
 *  - change callbacks so UI/audio/camera subsystems can react
 */

/** Canonical player-facing settings schema. */
export interface GameSettings {
  /** Master audio volume, 0..1. */
  masterVolume: number;
  /** Mouse/look sensitivity multiplier, 0.1..5. */
  sensitivity: number;
  /** Render quality preset: 'low' | 'medium' | 'high'. */
  quality: string;
  /** Field of view in degrees, 60..120. */
  fov: number;
  /** Whether spoken lines render as subtitle text. */
  subtitles: boolean;
  /** Whether the minimap overlay is visible. */
  showMinimap: boolean;
}

/** Minimal storage contract - satisfied by DOM localStorage and test stubs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage key used for all persisted settings. */
export const SETTINGS_KEY = 'bmb-settings';

/** Allowed quality presets. Anything else falls back to DEFAULT_SETTINGS.quality. */
export const QUALITY_LEVELS = ['low', 'medium', 'high'] as const;

/** Valid numeric ranges per field; values outside are clamped on load. */
export const SETTINGS_RANGES = {
  masterVolume: { min: 0, max: 1 },
  sensitivity: { min: 0.1, max: 5 },
  fov: { min: 60, max: 120 },
} as const;

/** Factory defaults applied whenever a stored value is missing or invalid. */
export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  masterVolume: 0.8,
  sensitivity: 1.0,
  quality: 'medium',
  fov: 90,
  subtitles: true,
  showMinimap: true,
});

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

function clampNumber(value: unknown, field: keyof typeof SETTINGS_RANGES): number {
  const range = SETTINGS_RANGES[field];
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, range.min, range.max)
    : DEFAULT_SETTINGS[field];
}

/**
 * Validate arbitrary parsed data into a full GameSettings object.
 * Missing fields get defaults; numbers are clamped into range; booleans
 * must be actual booleans; quality must be a known preset.
 */
export function validateSettings(raw: unknown): GameSettings {
  const src =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    masterVolume: clampNumber(src.masterVolume, 'masterVolume'),
    sensitivity: clampNumber(src.sensitivity, 'sensitivity'),
    quality: (QUALITY_LEVELS as readonly string[]).includes(src.quality as string)
      ? (src.quality as string)
      : DEFAULT_SETTINGS.quality,
    fov: clampNumber(src.fov, 'fov'),
    subtitles:
      typeof src.subtitles === 'boolean' ? src.subtitles : DEFAULT_SETTINGS.subtitles,
    showMinimap:
      typeof src.showMinimap === 'boolean'
        ? src.showMinimap
        : DEFAULT_SETTINGS.showMinimap,
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
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      return ls;
    }
  } catch {
    /* denied/unavailable - fall through */
  }
  return new MemoryStorage();
}

type SettingsListener = (settings: GameSettings) => void;

/**
 * Owns the live settings object, its persistence, and its subscribers.
 * Instantiate once at boot: new SettingsManager() in the browser, or
 * new SettingsManager(stub) in tests / workers.
 */
export class SettingsManager {
  private storage: StorageLike;
  private listeners = new Set<SettingsListener>();
  private current: GameSettings;

  constructor(storage?: StorageLike) {
    this.storage = storage ?? defaultStorage();
    this.current = this.load();
  }

  /** Current settings (defensive copy - mutate via set()). */
  get settings(): Readonly<GameSettings> {
    return { ...this.current };
  }

  /** Read from storage, validating/clamping every field. */
  load(): GameSettings {
    let raw: unknown = null;
    try {
      const text = this.storage.getItem(SETTINGS_KEY);
      if (text !== null) raw = JSON.parse(text);
    } catch {
      /* corrupt JSON -> defaults below */
    }
    this.current = validateSettings(raw);
    return { ...this.current };
  }

  /** Persist the given-or-current settings to storage. */
  save(settings: GameSettings = this.current): void {
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* quota/denied - persistence is best-effort */
    }
  }

  /**
   * Merge a partial patch into current settings, validate, persist,
   * and notify listeners. Returns the resulting full snapshot.
   */
  set(patch: Partial<GameSettings>): GameSettings {
    this.current = validateSettings({ ...this.current, ...patch });
    this.save();
    this.notify();
    return { ...this.current };
  }

  /** Restore factory defaults, persist, notify. */
  reset(): GameSettings {
    this.current = validateSettings(DEFAULT_SETTINGS);
    this.save();
    this.notify();
    return { ...this.current };
  }

  /** Serialize current settings to a JSON string (for sharing/copy-out). */
  exportSettings(): string {
    return JSON.stringify(this.current);
  }

  /**
   * Parse a JSON string and apply it wholesale. Returns false (leaving
   * current settings untouched) when the blob is not valid JSON or fails
   * validation; returns true after apply+persist+notify otherwise.
   */
  importSettings(json: string): boolean {
    if (typeof json !== 'string') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return false;
    }
    if (parsed === null || typeof parsed !== 'object') return false;
    // A blob with no volume field at all is treated as not-a-settings-blob.
    if (!('masterVolume' in (parsed as object))) return false;
    this.current = validateSettings(parsed);
    this.save();
    this.notify();
    return true;
  }

  /**
   * Register a listener fired on every applied change. Returns an
   * unsubscribe function.
   */
  onChange(cb: SettingsListener): () => void {
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


