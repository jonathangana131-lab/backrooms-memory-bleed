/**
 * Heat shimmer - rising-air distortion under live fluorescent fixtures.
 *
 * Long-lit backrooms corridors cook the air under every tube that still
 * works. Directly beneath an alive fixture the light visibly ripples:
 * a slow column of convection you feel before you understand it.
 *
 * Design rules:
 *  - Pure DOM/CSS/SVG. No canvas, no Babylon, no render-loop cost -
 *    the compositor animates everything while the game sleeps.
 *  - One transparent div per tracked fixture, driven by a shared
 *    feTurbulence + feDisplacementMap SVG filter. Very low opacity:
 *    felt, not seen.
 *  - Fixture tracking: update() receives the screen rects of the
 *    nearest ALIVE fixtures already culled to the view; at most
 *    MAX_SHIMMER_ZONES columns exist at once, pooled and re-used.
 *  - Intensity scaling: the caller folds season/day-phase (see
 *    shimmerIntensity()) plus any tint-system dimming into ONE
 *    intensity scalar. We never read clocks here.
 *  - stop() kills the system permanently - blackout rules apply.
 */

/** Screen-space rectangle describing one visible fixture head. */
export interface FixtureScreen {
  /** pixels from viewport left edge */
  left: number;
  /** pixels from viewport top edge (fixture head line) */
  top: number;
  /** fixture width in pixels */
  width: number;
}

/** Hard cap on simultaneous shimmer columns. */
export const MAX_SHIMMER_ZONES = 4;

const STYLE_ID = 'bmb-heat-shimmer-style';
const FILTER_ID = 'bmb-heat-turbulence';
const ZONE_CLASS = 'bmb-heat-shimmer';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Column look + motion. A faint warm gradient body, displaced by the
 * shared turbulence filter, drifting slowly UPWARD like heated air.
 * Alternate direction keeps the rise endless without a pop at loop point.
 */
const SHIMMER_CSS = [
  '.' + ZONE_CLASS + ' {',
  '  position: absolute;',
  '  overflow: hidden;',
  '  pointer-events: none;',
  '  background: linear-gradient(to top, rgba(255,246,214,0.16), rgba(255,250,235,0.05) 55%, rgba(255,255,255,0));',
  '  filter: url(#' + FILTER_ID + ');',
  '  animation: bmb-heat-rise 3.6s ease-in-out infinite alternate;',
  '  will-change: transform, opacity;',
  '}',
  '@keyframes bmb-heat-rise {',
  '  from { transform: translate3d(0, 0, 0) scale(1, 1); }',
  '  50%  { transform: translate3d(1px, -6px, 0) scale(1.04, 1.02); }',
  '  to   { transform: translate3d(-1px, -12px, 0) scale(0.98, 1.06); }',
  '}',
].join('\n');

function clamp01(x: number): number {
  if (!(x >= 0)) return 0; // NaN and negatives collapse to zero
  return x > 1 ? 1 : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = clamp01((x - edge0) / (edge1 - edge0));
  return u * u * (3 - 2 * u);
}

/**
 * Shared intensity bridge for tint systems.
 *
 * Shimmer breathes with the day: barely there through the dead hours,
 * strongest at high sun, and pushed harder across the whole lit span
 * during the summer cycle. Callers may multiply in their own dimming
 * (blackout, fog wash) before handing the result to update().
 *
 * @param summer      true while the summer-cycle flag is up
 * @param dayProgress 0..1 through the lit day (0 dawn, ~0.5 midday, 1 dusk)
 * @returns intensity 0..1
 */
export function shimmerIntensity(summer: boolean, dayProgress: number): number {
  const diurnal = smoothstep(0.1, 0.55, dayProgress);
  let v = 0.2 + 0.8 * diurnal;
  if (summer) v *= 1.35;
  return clamp01(v);
}

/**
 * Rising-distortion overlay. Feed it screen rects of alive, on-screen
 * fixtures plus one intensity scalar; it does the rest.
 */
export class HeatShimmer {
  private stopped = false;
  private zones: HTMLElement[] = [];

  constructor(container: HTMLElement) {
    // One shared <style> for the whole page - later instances reuse it.
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = SHIMMER_CSS;
      container.appendChild(style);
    }

    // One shared displacement filter: animated turbulence, very gentle.
    if (!document.getElementById(FILTER_ID)) {
      container.appendChild(this.buildFilter());
    }

    // Pooled columns, hidden until a fixture claims them.
    for (let i = 0; i < MAX_SHIMMER_ZONES; i++) {
      const zone = document.createElement('div');
      zone.className = ZONE_CLASS;
      zone.style.display = 'none';
      // Stagger the loop phase so paired fixtures never ripple in lockstep.
      zone.style.animationDelay = (-i * 0.9).toFixed(2) + 's';
      container.appendChild(zone);
      this.zones.push(zone);
    }
  }

  /**
   * Re-target the shimmer columns onto the given alive fixtures
   * (nearest-first, already view-culled by the caller). intensity 0..1
   * scales column opacity; anything outside 0..1 clamps.
   */
  update(fixtureScreens: FixtureScreen[], intensity: number): void {
    if (this.stopped) return;
    const k = clamp01(intensity);
    // Keep only well-formed rects, preserving the caller's nearest-first
    // order, then claim at most MAX_SHIMMER_ZONES columns.
    const picked: FixtureScreen[] = [];
    if (Array.isArray(fixtureScreens)) {
      for (const f of fixtureScreens) {
        if (picked.length >= MAX_SHIMMER_ZONES) break;
        if (f && typeof f.width === 'number' && f.width > 0) picked.push(f);
      }
    }

    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i];
      const f = picked[i];

      if (!f) {
        zone.style.display = 'none';
        continue;
      }

      const height = Math.max(48, Math.min(f.width * 1.4, 180));
      zone.style.display = 'block';
      zone.style.left = f.left + 'px';
      zone.style.top = f.top + 'px';
      zone.style.width = f.width + 'px';
      zone.style.height = Math.round(height) + 'px';
      // Base visibility is deliberately tiny; intensity nudges it.
      zone.style.opacity = (0.05 + 0.13 * k).toFixed(3);
    }
  }

  /** Kill the system permanently. Columns hide and stay hidden. */
  stop(): void {
    this.stopped = true;
    for (const z of this.zones) z.style.display = 'none';
  }

  /** True after stop(); update() calls are ignored from then on. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Number of columns currently visible over fixtures. */
  get activeZones(): number {
    return this.zones.filter((z) => z.style.display === 'block').length;
  }

  /** Build the shared feTurbulence displacement filter (with SMIL drift). */
  private buildFilter(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('style', 'position:absolute');

    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', FILTER_ID);
    filter.setAttribute('x', '-20%');
    filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%');
    filter.setAttribute('height', '140%');

    const turb = document.createElementNS(SVG_NS, 'feTurbulence');
    turb.setAttribute('type', 'fractalNoise');
    turb.setAttribute('baseFrequency', '0.012 0.03');
    turb.setAttribute('numOctaves', '2');
    turb.setAttribute('seed', '17');
    turb.setAttribute('result', 'noise');

    const drift = document.createElementNS(SVG_NS, 'animate');
    drift.setAttribute('attributeName', 'baseFrequency');
    drift.setAttribute('values', '0.012 0.03;0.02 0.045;0.012 0.03');
    drift.setAttribute('dur', '7s');
    drift.setAttribute('repeatCount', 'indefinite');
    turb.appendChild(drift);

    const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'noise');
    disp.setAttribute('scale', '6');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    filter.appendChild(turb);
    filter.appendChild(disp);
    svg.appendChild(filter);
    return svg as unknown as SVGSVGElement;
  }
}


