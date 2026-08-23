/**
 * Incoming weather-front warning UI for BACKROOMS: MEMORY BLEED.
 *
 * Pure DOM/CSS layer (no game-engine dependencies) that watches forecast
 * updates pushed from the world sim and renders two effects:
 *
 *  - Warning banner : top-center fading text ("THE AIR SHIFTS", or the
 *                     pulsing violet "SOMETHING VIOLENT APPROACHES" for
 *                     storms) that fades in over WARNING_FADE_MS when a
 *                     front's eta drops under 30s and holds until the
 *                     front arrives (etaSec <= 0).
 *  - Arrival flash  : a brief full-screen inset box-shadow glow, tinted
 *                     by the arriving front's kind, at ARRIVAL_OPACITY
 *                     fading out over ARRIVAL_FADE_MS.
 *
 * Restraint: banners respect a WARN_GAP_MS minimum gap between warnings
 * and are suppressed entirely while the director reports a 'peak' phase
 * (via setPhase). The arrival flash is tied to the discrete front-passing
 * event itself and is not gap-limited.
 *
 * Palette: #0a0a0c base, amber #ffb347 accents, violet #9d6bff storms.
 */

/** Forecast snapshot pushed by the weather system each tick. */
export interface WeatherForecast {
  /** Front kind id (drives arrival-flash tint). */
  kind: number;
  /** Front intensity, nominally 0..1+. */
  intensity: number;
  /** Seconds until the front reaches the player. */
  etaSec: number;
  /** True when this front is a violent storm. */
  storm: boolean;
}

/** Eta threshold under which the warning banner appears. */
export const WARN_ETA_THRESHOLD_SEC = 30;

/** Minimum milliseconds between two warning banners (restraint rule). */
export const WARN_GAP_MS = 60_000;

/** Banner fade-in duration in ms. */
export const WARNING_FADE_MS = 3000;

/** Arrival flash peak opacity. */
export const ARRIVAL_OPACITY = 0.15;

/** Arrival flash fade-out duration in ms. */
export const ARRIVAL_FADE_MS = 2000;

/** Delay before the arrival flash starts fading back out (lets the glow land). */
export const ARRIVAL_HOLD_MS = 50;

/** Banner text for ordinary fronts. */
export const BANNER_TEXT_CALM = 'THE AIR SHIFTS';

/** Banner text for storm fronts. */
export const BANNER_TEXT_STORM = 'SOMETHING VIOLENT APPROACHES';

/** Violet used for storm styling. */
export const STORM_VIOLET = '#9d6bff';

/** Amber accent for ordinary warnings. */
export const AMBER_ACCENT = '#ffb347';

/**
 * Arrival-flash tints cycled by front kind. Storm fronts always override
 * to the storm violet; everything else picks deterministically from here.
 */
export const FRONT_TINTS: readonly string[] = Object.freeze([
  AMBER_ACCENT,
  '#ff7a45',
  '#ffd27f',
  STORM_VIOLET,
  '#c48aff',
  '#7fb8ff',
]);

/**
 * Deterministic tint for an arriving front. Storms are always violet;
 * other kinds cycle through the restrained horror palette by index.
 */
export function frontTint(kind: number, storm: boolean): string {
  if (storm) return STORM_VIOLET;
  const k = Number.isFinite(kind) ? Math.abs(Math.trunc(kind)) : 0;
  return FRONT_TINTS[k % FRONT_TINTS.length];
}

/** True when the given director phase suppresses warnings ('peak'-ish). */
export function phaseSuppressesWarnings(phase: string | null | undefined): boolean {
  if (!phase) return false;
  return String(phase).toLowerCase().includes('peak');
}

const CSS_TEXT = [
  '.bmb-weather-banner {',
  '  position: fixed;',
  '  top: 12vh;',
  '  left: 50%;',
  '  transform: translateX(-50%);',
  '  z-index: 60;',
  "  font-family: 'Courier New', Courier, monospace;",
  '  font-size: clamp(18px, 2.4vw, 30px);',
  '  letter-spacing: 0.42em;',
  '  text-indent: 0.42em;',
  '  color: ' + AMBER_ACCENT + ';',
  '  text-shadow: 0 0 14px rgba(255, 179, 71, 0.55), 0 0 40px rgba(10, 10, 12, 0.9);',
  '  background: transparent;',
  '  pointer-events: none;',
  '  user-select: none;',
  '  white-space: nowrap;',
  '  opacity: 0;',
  '  transition: opacity ' + WARNING_FADE_MS + 'ms ease-in;',
  '}',
  '.bmb-weather-banner.bmb-visible {',
  '  opacity: 1;',
  '}',
  '.bmb-weather-banner.bmb-storm {',
  '  color: ' + STORM_VIOLET + ';',
  '  text-shadow: 0 0 16px rgba(157, 107, 255, 0.75), 0 0 46px rgba(10, 10, 12, 0.9);',
  '  animation: bmb-weather-storm-pulse 1.1s ease-in-out infinite alternate;',
  '}',
  '@keyframes bmb-weather-storm-pulse {',
  '  from { opacity: 0.55; }',
  '  to   { opacity: 1; }',
  '}',
  '.bmb-weather-flash {',
  '  position: fixed;',
  '  inset: 0;',
  '  z-index: 59;',
  '  pointer-events: none;',
  '  background: transparent;',
  '  opacity: 0;',
  '  transition: opacity ' + ARRIVAL_FADE_MS + 'ms ease-out;',
  '}',
].join('\n');

interface StyleBag {
  [key: string]: unknown;
}

/**
 * WeatherUI owns its banner + flash overlay inside a caller-provided
 * container and exposes a tiny push API: update(forecast), setPhase(phase),
 * reset().
 */
export class WeatherUI {
  private readonly root: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly flash: HTMLElement;

  private phase: string = '';
  /** Previous forecast eta, null when no forecast was ever seen/cleared. */
  private prevEtaSec: number | null = null;
  /** Last-seen kind/storm, reused if a cleared forecast implies arrival. */
  private lastKind: number = 0;
  private lastStorm: boolean = false;
  /** Timestamp of the last banner shown; 0 = never warned yet. */
  private lastWarnAt: number = 0;
  private bannerVisible: boolean = false;
  /** Pending flash-fade timeout id, tracked so reset() can cancel it. */
  private flashFadeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    const doc =
      container.ownerDocument ?? (globalThis as { document?: Document }).document ?? null;
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('WeatherUI requires an owner document');
    }

    const style = doc.createElement('style');
    style.textContent = CSS_TEXT;
    (doc.head ?? doc).appendChild(style);

    this.banner = doc.createElement('div');
    this.banner.className = 'bmb-weather-banner';

    this.flash = doc.createElement('div');
    this.flash.className = 'bmb-weather-flash';
    const initStyle = this.flash.style as unknown as StyleBag;
    initStyle['boxShadow'] = 'none';
    initStyle['opacity'] = '0'; // matches the CSS default; keeps stub DOMs consistent

    this.root = doc.createElement('div');
    this.root.className = 'bmb-weather-root';
    this.root.appendChild(this.banner);
    this.root.appendChild(this.flash);
    container.appendChild(this.root);
  }

  /**
   * Push a new forecast (or null when tracking is lost). Drives both the
   * warning banner window and the arrival-flash edge case.
   */
  update(f: WeatherForecast | null): void {
    const eta = f && Number.isFinite(f.etaSec) ? f.etaSec : null;
    let kind = this.lastKind;
    let storm = this.lastStorm;
    if (f) {
      if (Number.isFinite(f.kind)) this.lastKind = f.kind;
      this.lastStorm = !!f.storm;
      kind = this.lastKind;
      storm = this.lastStorm;
    }

    // --- Arrival flash: previous eta > 0, now the front has landed. ---
    if (this.prevEtaSec !== null && this.prevEtaSec > 0 && (eta === null || eta <= 0)) {
      this.triggerArrivalFlash(kind, storm);
    }

    // --- Warning banner window ---
    const inWindow = eta !== null && eta > 0 && eta < WARN_ETA_THRESHOLD_SEC;
    const gapOk = this.lastWarnAt === 0 || Date.now() - this.lastWarnAt >= WARN_GAP_MS;
    if (inWindow && gapOk && !phaseSuppressesWarnings(this.phase)) {
      this.showBanner(storm);
    } else if (!inWindow) {
      // Outside the warning window (or no forecast): make sure it is gone.
      this.hideBanner();
    }
    // inWindow but gap not elapsed or peak-suppressed: stay silent and
    // keep both the restraint clock and any current fade untouched.

    this.prevEtaSec = eta;
  }

  /** Report the director phase. Any 'peak' phase suppresses warnings live. */
  setPhase(p: string): void {
    this.phase = typeof p === 'string' ? p : '';
    if (phaseSuppressesWarnings(this.phase)) this.hideBanner();
  }

  /** Clear all transient state and visuals (new run, warp, menu, ...). */
  reset(): void {
    this.hideBanner();
    if (this.flashFadeTimer !== null) {
      clearTimeout(this.flashFadeTimer);
      this.flashFadeTimer = null;
    }
    const s = this.flash.style as unknown as StyleBag;
    s['boxShadow'] = 'none';
    s['opacity'] = '0';
    this.phase = '';
    this.prevEtaSec = null;
    this.lastKind = 0;
    this.lastStorm = false;
    this.lastWarnAt = 0;
  }

  private showBanner(storm: boolean): void {
    this.banner.textContent = storm ? BANNER_TEXT_STORM : BANNER_TEXT_CALM;
    this.banner.classList.toggle('bmb-storm', storm);
    if (!this.bannerVisible) {
      this.bannerVisible = true;
      this.lastWarnAt = Date.now();
      // Restart the fade-in cleanly even right after a prior hide.
      this.banner.classList.remove('bmb-visible');
      void (this.banner as unknown as { offsetWidth?: number }).offsetWidth;
      this.banner.classList.add('bmb-visible');
    }
  }

  private hideBanner(): void {
    if (this.bannerVisible) {
      this.bannerVisible = false;
      this.banner.classList.remove('bmb-visible');
    }
  }

  private triggerArrivalFlash(kind: number, storm: boolean): void {
    if (this.flashFadeTimer !== null) clearTimeout(this.flashFadeTimer);
    const tint = frontTint(kind, storm);
    const s = this.flash.style as unknown as StyleBag;
    s['boxShadow'] = 'inset 0 0 180px 60px ' + tint;
    s['opacity'] = String(ARRIVAL_OPACITY);
    // Let the glow land for a beat, then ease back out over ARRIVAL_FADE_MS.
    this.flashFadeTimer = setTimeout(() => {
      this.flashFadeTimer = null;
      s['opacity'] = '0';
    }, ARRIVAL_HOLD_MS);
  }
}


