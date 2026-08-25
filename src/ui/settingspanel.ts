/**
 * Unified settings panel for BACKROOMS: MEMORY BLEED.
 *
 * Schema-driven grouped renderer shared by every player-facing options UI.
 * Given a list of section specs and a PanelStore (a tiny get/set/resetKeys
 * contract), it builds labelled rows for sliders (with live value display),
 * toggles, and selects, wires full keyboard navigation, and pushes every
 * change straight through the store so host managers persist and broadcast
 * them immediately - there is deliberately no APPLY button (live preview).
 *
 * Store adapters bridge the two existing managers without coupling this
 * module to either: settingsStoreAdapter(SettingsManager) for the canonical
 * game settings and accessibilityStoreAdapter(AccessibilityManager) for the
 * a11y flags; compositeStore() merges several adapters into one panel-wide
 * store so a single panel can span both schemas.
 *
 * Keyboard model: TAB / SHIFT+TAB cycle the rows (wrapping), ARROW KEYS
 * adjust the focused slider or select, ENTER / SPACE activate the focused
 * toggle (or advance a select). Every section header carries a RESET link
 * that restores defaults for that section only.
 *
 * Mirrors the module hygiene of settings.ts/accessibility.ts: pure helpers
 * and CSS text are exported separately so tests can assert exact behavior
 * against a minimal DOM shim with no browser.
 */
// Type-only imports on purpose: this module stays a dependency-free leaf
// so node --experimental-strip-types test runners can load it directly.
import type { GameSettings, SettingsManager } from './settings';
import type { AccessibilityManager } from './accessibility';

/**
 * Mirror of DEFAULT_SETTINGS (src/ui/settings.ts). Kept honest by
 * test/settingspanel-test.mjs, which compares against the canonical
 * object; update both together when the schema defaults change.
 */
const GAME_SETTING_DEFAULTS: Readonly<Record<string, unknown>> =
  Object.freeze({
    masterVolume: 0.8,
    sensitivity: 1.0,
    quality: 'medium',
    fov: 90,
    subtitles: true,
    showMinimap: true,
    motionSafety: false,
    speakerTags: false,
    hardcoreBattery: false,
  });

/**
 * Mirror of DEFAULT_ACCESSIBILITY_OPTIONS (src/ui/accessibility.ts);
 * same drift-guard story as GAME_SETTING_DEFAULTS above.
 */
const ACCESSIBILITY_DEFAULTS: Readonly<Record<string, unknown>> =
  Object.freeze({
    motionReduction: false,
    highContrast: false,
    subtitleBackground: false,
    instantInteract: false,
    audioCaptions: false,
  });

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/** Numeric range control with a visible value readout. */
export interface SliderControlSpec {
  kind: 'slider';
  /** Setting key routed through the PanelStore. */
  key: string;
  /** Static row label, e.g. 'MASTER VOLUME'. */
  label: string;
  min: number;
  max: number;
  /** Increment used by arrow keys and snapping; must be > 0. */
  step: number;
  /** Optional readout formatter; default prints the plain number. */
  format?(value: number): string;
}

/** Boolean flag rendered as an ON/OFF chip. */
export interface ToggleControlSpec {
  kind: 'toggle';
  key: string;
  label: string;
  /** Chip text when enabled; default 'ON'. */
  onText?: string;
  /** Chip text when disabled; default 'OFF'. */
  offText?: string;
}

/** One named choice inside a SelectControlSpec. */
export interface SelectOption {
  value: string;
  label: string;
}

/** Enumerated choice cycled with arrow keys. */
export interface SelectControlSpec {
  kind: 'select';
  key: string;
  label: string;
  /** Choices in cycle order; the first entry is the fallback value. */
  options: readonly SelectOption[];
}

/** Any renderable control row. */
export type ControlSpec =
  | SliderControlSpec
  | ToggleControlSpec
  | SelectControlSpec;

/** A titled group of controls sharing one RESET link. */
export interface SectionSpec {
  /** Stable section identifier, e.g. 'audio'. */
  id: string;
  /** Header caption, e.g. 'AUDIO'. */
  title: string;
  controls: readonly ControlSpec[];
}

/* ------------------------------------------------------------------ */
/* Store contract + manager adapters                                   */
/* ------------------------------------------------------------------ */

/**
 * Minimal persistence surface the panel needs. Hosts either adapt an
 * existing manager (see the adapters below) or hand-roll a store.
 */
export interface PanelStore {
  /**
   * Optional claim over a settings key. Used by compositeStore() to route
   * writes; when absent, ownership is inferred from get() != undefined.
   */
  owns?(key: string): boolean;
  /** Current value for a key; undefined means "not owned / unset". */
  get(key: string): unknown;
  /** Apply a partial patch immediately (persist + notify upstream). */
  set(patch: Readonly<Record<string, unknown>>): void;
  /** Restore factory defaults for exactly these keys. */
  resetKeys(keys: readonly string[]): void;
}

const GAME_SETTING_KEYS = Object.keys(GAME_SETTING_DEFAULTS);

/**
 * Adapt the canonical game-settings manager. Patches are forwarded
 * wholesale; validateSettings() drops keys outside its schema, so hosts
 * extending the schema (e.g. invertY) should layer their own store.
 */
export function settingsStoreAdapter(manager: SettingsManager): PanelStore {
  return {
    owns: (key) => GAME_SETTING_KEYS.includes(key),
    get: (key) => (manager.settings as Record<string, unknown>)[key],
    set: (patch) => {
      manager.set(patch as Partial<GameSettings>);
    },
    resetKeys: (keys) => {
      const patch: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in GAME_SETTING_DEFAULTS) patch[key] = GAME_SETTING_DEFAULTS[key];
      }
      if (Object.keys(patch).length > 0) {
        manager.set(patch as Partial<GameSettings>);
      }
    },
  };
}

const ACCESSIBILITY_KEYS = Object.keys(ACCESSIBILITY_DEFAULTS);

/** Adapt the accessibility-options manager the same way. */
export function accessibilityStoreAdapter(
  manager: AccessibilityManager,
): PanelStore {
  return {
    owns: (key) => ACCESSIBILITY_KEYS.includes(key),
    get: (key) => (manager.options as Record<string, unknown>)[key],
    set: (patch) => {
      manager.set(patch);
    },
    resetKeys: (keys) => {
      const patch: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in ACCESSIBILITY_DEFAULTS) patch[key] = ACCESSIBILITY_DEFAULTS[key];
      }
      if (Object.keys(patch).length > 0) manager.set(patch);
    },
  };
}

/**
 * Merge several stores behind one facade. Reads resolve to the first
 * owning store holding a defined value; writes are split per key and
 * routed to that key's owner; resets are likewise partitioned.
 */
export function compositeStore(parts: readonly PanelStore[]): PanelStore {
  const ownerFor = (key: string): PanelStore | undefined => {
    for (const part of parts) {
      if (part.owns?.(key)) return part;
    }
    for (const part of parts) {
      if (part.get(key) !== undefined) return part;
    }
    return undefined;
  };
  const partition = (keys: readonly string[]): Map<PanelStore, string[]> => {
    const grouped = new Map<PanelStore, string[]>();
    for (const key of keys) {
      const owner = ownerFor(key);
      if (!owner) continue;
      const bucket = grouped.get(owner);
      if (bucket) bucket.push(key);
      else grouped.set(owner, [key]);
    }
    return grouped;
  };
  return {
    owns: (key) => ownerFor(key) !== undefined,
    get: (key) => {
      const owner = ownerFor(key);
      return owner === undefined ? undefined : owner.get(key);
    },
    set: (patch) => {
      for (const [owner, keys] of partition(Object.keys(patch))) {
        const sub: Record<string, unknown> = {};
        for (const key of keys) sub[key] = patch[key];
        owner.set(sub);
      }
    },
    resetKeys: (keys) => {
      for (const [owner, owned] of partition(keys)) owner.resetKeys(owned);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Snap a value onto the step grid and clamp into [min, max]. Floating
 * drift is trimmed to the decimal precision of the step (0.05 stays two
 * decimals, 0.1 stays one).
 */
export function clampToStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const s = step > 0 && Number.isFinite(step) ? step : 1;
  const snapped = Math.round((value - lo) / s) * s + lo;
  const clamped = Math.min(hi, Math.max(lo, snapped));
  const decimals = (String(s).split('.')[1] ?? '').length;
  return Number(clamped.toFixed(decimals));
}

/** Index of value within the option list, or -1 when unrecognized. */
export function optionIndex(
  options: readonly SelectOption[],
  value: unknown,
): number {
  for (let i = 0; i < options.length; i++) {
    if (options[i].value === value) return i;
  }
  return -1;
}

/**
 * Neighbor option value in cycle order: dir +1 advances (wrapping from
 * the end to the start), dir -1 steps back. Returns null for an empty
 * list; an unknown current value resolves to the first option for +1
 * and the last option for -1.
 */
export function cycleOption(
  options: readonly SelectOption[],
  value: unknown,
  dir: 1 | -1,
): string | null {
  if (options.length === 0) return null;
  const idx = optionIndex(options, value);
  if (idx < 0) {
    return dir === 1
      ? options[0].value
      : options[options.length - 1].value;
  }
  const next = (idx + dir + options.length) % options.length;
  return options[next].value;
}

/** Default slider readout: plain number, float drift trimmed. */
export function defaultSliderFormat(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Keys controlled by a section, in declaration order. */
export function sectionKeys(section: SectionSpec): string[] {
  return section.controls.map((c) => c.key);
}

/* ------------------------------------------------------------------ */
/* Default sections                                                    */
/* ------------------------------------------------------------------ */

/**
 * Canonical AUDIO / CONTROLS / VISUALS / ACCESSIBILITY layout matching
 * the shipped schemas. invertY lives outside both persisted schemas; a
 * composite store including a host-provided extension store covers it.
 */
export function defaultSections(): SectionSpec[] {
  return [
    {
      id: 'audio',
      title: 'AUDIO',
      controls: [
        {
          kind: 'slider',
          key: 'masterVolume',
          label: 'MASTER VOLUME',
          min: 0,
          max: 1,
          step: 0.05,
          format: (v) => Math.round(v * 100) + '%',
        },
      ],
    },
    {
      id: 'controls',
      title: 'CONTROLS',
      controls: [
        {
          kind: 'slider',
          key: 'sensitivity',
          label: 'SENSITIVITY',
          min: 0.1,
          max: 5,
          step: 0.1,
        },
        { kind: 'toggle', key: 'invertY', label: 'INVERT Y' },
      ],
    },
    {
      id: 'visuals',
      title: 'VISUALS',
      controls: [
        {
          kind: 'select',
          key: 'quality',
          label: 'QUALITY',
          options: [
            { value: 'low', label: 'LOW' },
            { value: 'medium', label: 'MEDIUM' },
            { value: 'high', label: 'HIGH' },
          ],
        },
        {
          kind: 'slider',
          key: 'fov',
          label: 'FIELD OF VIEW',
          min: 60,
          max: 120,
          step: 1,
          format: (v) => String(Math.round(v)) + '\u00b0',
        },
        { kind: 'toggle', key: 'subtitles', label: 'SUBTITLES' },
        { kind: 'toggle', key: 'showMinimap', label: 'MINIMAP' },
        {
          kind: 'toggle',
          key: 'hardcoreBattery',
          label: 'HARDCORE BATTERY',
        },
      ],
    },
    {
      id: 'accessibility',
      title: 'ACCESSIBILITY',
      controls: [
        { kind: 'toggle', key: 'motionReduction', label: 'REDUCE MOTION' },
        { kind: 'toggle', key: 'highContrast', label: 'HIGH CONTRAST' },
        { kind: 'toggle', key: 'instantInteract', label: 'INSTANT INTERACT' },
        { kind: 'toggle', key: 'motionSafety', label: 'MOTION SAFETY' },
        { kind: 'toggle', key: 'speakerTags', label: 'SPEAKER TAGS' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Stylesheet text for the panel's static chrome. Exported separately so
 * tests can assert exact rules, mirroring accessibilityCssText().
 */
export function settingsPanelCssText(): string {
  return [
    '/* bmb settings panel */',
    '.bmb-settings-panel { display: flex; flex-direction: column; gap: 14px; }',
    '.bmb-sp-section { border: 1px solid rgba(207,199,166,0.25); padding: 10px 12px; }',
    '.bmb-sp-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }',
    '.bmb-sp-title { letter-spacing: 3px; font-weight: bold; }',
    '.bmb-sp-reset { cursor: pointer; opacity: 0.7; text-decoration: underline; background: none; border: none; font: inherit; color: inherit; }',
    '.bmb-sp-reset:hover { opacity: 1; }',
    '.bmb-sp-row { display: flex; align-items: center; gap: 10px; padding: 4px 6px; cursor: pointer; }',
    '.bmb-sp-row.bmb-sp-focused { outline: 1px solid #ffe98a; background: rgba(255,233,138,0.08); }',
    '.bmb-sp-label { flex: 1 1 auto; white-space: nowrap; }',
    '.bmb-sp-track { flex: 0 0 140px; height: 6px; background: rgba(207,199,166,0.25); position: relative; }',
    '.bmb-sp-fill { position: absolute; left: 0; top: 0; bottom: 0; background: #cdbf72; }',
    '.bmb-sp-value { min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; }',
    '.bmb-sp-chip { min-width: 44px; text-align: center; border: 1px solid rgba(207,199,166,0.5); padding: 2px 8px; }',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Panel builder                                                       */
/* ------------------------------------------------------------------ */

const ROW_CLASS = 'bmb-sp-row';
const FOCUS_CLASS_SUFFIX = ' bmb-sp-focused';

interface RowRef {
  el: HTMLElement;
  spec: ControlSpec;
  /** Re-read the store and redraw the row. */
  update(): void;
  /** Arrow-key adjustment; no-op for kinds arrows do not affect. */
  adjust(dir: 1 | -1): void;
  /** Primary action for Enter/Space/click. */
  activate(): void;
}

export interface SettingsPanelHandle {
  /** Root element appended to the container. */
  readonly root: HTMLElement;
  /** Rows in tab-cycle order. */
  readonly rows: readonly RowRef[];
  /** Redraw every row from the current store contents. */
  refresh(): void;
  /** Current virtual focus index. */
  focusIndex(): number;
  /** Move virtual focus (wraps); returns the new index. */
  moveFocus(delta: number): number;
  /** Detach listeners and remove the subtree from the container. */
  dispose(): void;
}

/**
 * Build the whole panel into `container`. Changes flow out through
 * store.set()/store.resetKeys() the instant they happen; call refresh()
 * after external mutations to resync the readouts.
 */
export function buildSettingsPanel(
  container: HTMLElement,
  store: PanelStore,
  sections: readonly SectionSpec[],
): SettingsPanelHandle {
  const doc: Document =
    (container.ownerDocument as Document | null) ??
    (globalThis as { document?: Document }).document as Document;

  const root = doc.createElement('div');
  root.className = 'bmb-settings-panel';

  const rows: RowRef[] = [];
  let focusIdx = 0;

  /* ------------------------------------------------ row factories --- */

  const makeSlider = (spec: SliderControlSpec): RowRef => {
    const row = doc.createElement('div');
    row.className = ROW_CLASS;
    row.setAttribute('data-kind', 'slider');
    row.setAttribute('data-key', spec.key);

    const label = doc.createElement('span');
    label.className = 'bmb-sp-label';
    label.textContent = spec.label;

    const track = doc.createElement('span');
    track.className = 'bmb-sp-track';
    const fill = doc.createElement('span');
    fill.className = 'bmb-sp-fill';
    track.appendChild(fill);

    const readout = doc.createElement('span');
    readout.className = 'bmb-sp-value';

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(readout);

    const format = spec.format ?? defaultSliderFormat;
    const span = spec.max - spec.min;

    const read = (): number => {
      const raw = store.get(spec.key);
      return typeof raw === 'number' && Number.isFinite(raw)
        ? clampToStep(raw, spec.min, spec.max, spec.step)
        : clampToStep(spec.min, spec.min, spec.max, spec.step);
    };

    const update = (): void => {
      const v = read();
      const pct =
        span > 0 ? (((v - spec.min) / span) * 100).toFixed(1) + '%' : '0%';
      fill.setAttribute('style', 'width:' + pct);
      readout.textContent = format(v);
    };

    const adjust = (dir: 1 | -1): void => {
      const current = read();
      const next = clampToStep(
        current + dir * spec.step,
        spec.min,
        spec.max,
        spec.step,
      );
      if (next === current) return; // pinned at a bound - no spurious write
      store.set({ [spec.key]: next });
      update();
    };

    return { el: row, spec, update, adjust, activate: () => {} };
  };

  const makeToggle = (spec: ToggleControlSpec): RowRef => {
    const row = doc.createElement('div');
    row.className = ROW_CLASS;
    row.setAttribute('data-kind', 'toggle');
    row.setAttribute('data-key', spec.key);

    const label = doc.createElement('span');
    label.className = 'bmb-sp-label';
    label.textContent = spec.label;

    const chip = doc.createElement('span');
    chip.className = 'bmb-sp-chip';

    row.appendChild(label);
    row.appendChild(chip);

    const onText = spec.onText ?? 'ON';
    const offText = spec.offText ?? 'OFF';

    const update = (): void => {
      const on = store.get(spec.key) === true;
      chip.textContent = on ? onText : offText;
      row.setAttribute('data-on', on ? 'true' : 'false');
    };

    const activate = (): void => {
      store.set({ [spec.key]: !(store.get(spec.key) === true) });
      update();
    };

    return { el: row, spec, update, adjust: () => {}, activate };
  };

  const makeSelect = (spec: SelectControlSpec): RowRef => {
    const row = doc.createElement('div');
    row.className = ROW_CLASS;
    row.setAttribute('data-kind', 'select');
    row.setAttribute('data-key', spec.key);

    const label = doc.createElement('span');
    label.className = 'bmb-sp-label';
    label.textContent = spec.label;

    const chip = doc.createElement('span');
    chip.className = 'bmb-sp-chip';

    row.appendChild(label);
    row.appendChild(chip);

    const update = (): void => {
      const idx = optionIndex(spec.options, store.get(spec.key));
      const active = idx >= 0 ? spec.options[idx] : spec.options[0];
      chip.textContent = active !== undefined ? active.label : '';
      row.setAttribute('data-value', active !== undefined ? active.value : '');
    };

    const adjust = (dir: 1 | -1): void => {
      const next = cycleOption(spec.options, store.get(spec.key), dir);
      if (next === null) return;
      store.set({ [spec.key]: next });
      update();
    };

    return { el: row, spec, update, adjust, activate: () => adjust(1) };
  };

  const makeRow = (spec: ControlSpec): RowRef => {
    switch (spec.kind) {
      case 'slider':
        return makeSlider(spec);
      case 'toggle':
        return makeToggle(spec);
      case 'select':
        return makeSelect(spec);
    }
  };

  /* --------------------------------------------------- assembly ----- */

  const applyFocusedClass = (): void => {
    for (let i = 0; i < rows.length; i++) {
      const base = rows[i].el.className.replace(FOCUS_CLASS_SUFFIX, '');
      rows[i].el.className = i === focusIdx ? base + FOCUS_CLASS_SUFFIX : base;
    }
  };

  const moveFocus = (delta: number): number => {
    if (rows.length === 0) return 0;
    focusIdx = (focusIdx + delta + rows.length) % rows.length;
    applyFocusedClass();
    return focusIdx;
  };

  for (const section of sections) {
    const sectionEl = doc.createElement('div');
    sectionEl.className = 'bmb-sp-section';
    sectionEl.setAttribute('data-section', section.id);

    const header = doc.createElement('div');
    header.className = 'bmb-sp-header';

    const title = doc.createElement('span');
    title.className = 'bmb-sp-title';
    title.textContent = section.title;

    const reset = doc.createElement('button');
    reset.type = 'button';
    reset.className = 'bmb-sp-reset';
    reset.setAttribute('data-reset', section.id);
    reset.textContent = 'RESET';

    header.appendChild(title);
    header.appendChild(reset);
    sectionEl.appendChild(header);

    const sectionRows: RowRef[] = [];
    for (const spec of section.controls) {
      const rowRef = makeRow(spec);
      sectionRows.push(rowRef);
      rows.push(rowRef);
      sectionEl.appendChild(rowRef.el);
    }

    reset.addEventListener('click', () => {
      store.resetKeys(sectionKeys(section));
      for (const rowRef of sectionRows) rowRef.update();
    });

    root.appendChild(sectionEl);
  }

  for (let i = 0; i < rows.length; i++) {
    const rowRef = rows[i];
    rowRef.el.addEventListener('click', () => {
      if (focusIdx !== i) {
        focusIdx = i;
        applyFocusedClass();
      }
      rowRef.activate();
    });
  }

  /* -------------------------------------------------- keyboard ------ */

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (rows.length === 0) return;
    let handled = true;
    switch (ev.key) {
      case 'Tab':
        moveFocus(ev.shiftKey ? -1 : 1);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        rows[focusIdx].adjust(1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        rows[focusIdx].adjust(-1);
        break;
      case 'Enter':
      case ' ':
        rows[focusIdx].activate();
        break;
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  };

  const win = (globalThis as {
    window?: {
      addEventListener(t: string, f: (e: KeyboardEvent) => void): void;
      removeEventListener(t: string, f: (e: KeyboardEvent) => void): void;
    };
  }).window;

  win?.addEventListener('keydown', onKeyDown);

  /* ----------------------------------------------------- styles ----- */



  try {
    const head = doc.head;
    if (head) {
      const style = doc.createElement('style');
      style.textContent = settingsPanelCssText();
      head.appendChild(style);
    }
  } catch {
    /* styleless hosts are fine - the panel stays functional */
  }

  /* ------------------------------------------------------ boot ------ */

  for (const rowRef of rows) rowRef.update();
  applyFocusedClass();
  container.appendChild(root);

  return {
    root,
    rows,
    refresh(): void {
      for (const rowRef of rows) rowRef.update();
    },
    focusIndex(): number {
      return focusIdx;
    },
    moveFocus,
    dispose(): void {
      win?.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}


