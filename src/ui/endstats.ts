/**
 * Expedition debrief screen for BACKROOMS: MEMORY BLEED.
 *
 * Detailed end-game statistics presented after the Threshold ending text
 * dismisses. Every stat line is typewriter-revealed (30 ms per character)
 * against a dim amber-on-black terminal aesthetic; numbers glow amber,
 * labels stay dim. A letter rank (C/B/A/S) closes the readout, followed by
 * the expedition seed and duration.
 *
 * Standalone module owning only its own DOM subtree and styles, like
 * gallery.ts/savescreen.ts/tracker.ts. Pure helpers are exported so the
 * host can compute ranks and formatted lines without touching the DOM.
 */

/** The four director phases (see director/director.ts Phase). */
export type DirectorPhase = 'calm' | 'build' | 'peak' | 'release';

export const PHASE_ORDER: readonly DirectorPhase[] = ['calm', 'build', 'peak', 'release'];

/** Full expedition telemetry handed over when the ending fires. */
export interface ExpeditionStats {
  /** World seed the expedition ran on. */
  seed: number;
  /** Seconds survived this run. */
  durationSec: number;
  /** Total distance walked, metres. */
  distanceM: number;
  /** Distinct chunks the player entered. */
  uniqueChunks: number;
  /** Landmark room names actually visited. */
  landmarkNames: string[];
  /** Notes read during the run. */
  notesRead: number;
  /** Batteries picked up. */
  batteries: number;
  /** Relocations (entity takings) survived. */
  relocations: number;
  /** Percentage of run time spent in each director phase; sums ~100. */
  phaseTimePct: Record<DirectorPhase, number>;
  /** Deepest exploration from spawn, metres. */
  deepestM: number;
  /** Research beacons discovered this run. */
  discoveries: number;
}

export type Rank = 'C' | 'B' | 'A' | 'S';

/** Reference totals for normalizing the rank composite. */
const RANK_BEACON_TOTAL = 8;
const RANK_LANDMARK_TOTAL = 8;
const RANK_NOTE_GOAL = 20;

/**
 * Composite rank score, each factor normalized against its run target:
 * discoveries and landmark visits dominate, survival length (capped at
 * thirty minutes) and notes add bonuses, and every relocation survived
 * subtracts (the space noticed you too much).
 *
 * S >= 21, A >= 14, B >= 6, otherwise C.
 */
export function computeRank(stats: ExpeditionStats): Rank {
  const minutes = Math.max(0, stats.durationSec) / 60;
  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
  const score =
    clamp01(stats.discoveries / RANK_BEACON_TOTAL) * 10 +
    clamp01(stats.landmarkNames.length / RANK_LANDMARK_TOTAL) * 10 +
    (Math.min(minutes, 30) / 30) * 5 +
    clamp01(stats.notesRead / RANK_NOTE_GOAL) * 5 -
    Math.max(0, stats.relocations) * 2;
  if (score >= 21) return 'S';
  if (score >= 14) return 'A';
  if (score >= 6) return 'B';
  return 'C';
}

/** Integer formatting with thousands separators (monospace friendly). */
export function formatInt(n: number): string {
  return String(Math.round(Math.max(0, n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Duration as H:MM:SS. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

/** One typed-out segment of a debrief row. */
export interface LineSegment {
  text: string;
  /** Amber value vs dim label styling. */
  tone: 'dim' | 'amber';
}

/** One debrief row: ordered segments typed left to right. */
export interface DebriefLine {
  segments: LineSegment[];
}

function segs(label: string, value: string): DebriefLine {
  return {
    segments: [
      { text: label + ' ', tone: 'dim' },
      { text: value, tone: 'amber' },
    ],
  };
}

function interleave(items: LineSegment[], sep: LineSegment): LineSegment[] {
  const out: LineSegment[] = [];
  items.forEach((it, i) => {
    if (i > 0) out.push(sep);
    out.push(it);
  });
  return out;
}

/** Build the ordered stat rows shown above the rank. */
export function formatStatLines(stats: ExpeditionStats): DebriefLine[] {
  const pct = (p: number): string => Math.round(Math.max(0, p)) + '%';
  const phases = PHASE_ORDER.map(
    (p): LineSegment => ({ text: p.toUpperCase() + ' ' + pct(stats.phaseTimePct[p]), tone: 'dim' })
  );
  const lines: DebriefLine[] = [
    segs('DISTANCE WALKED', formatInt(stats.distanceM) + ' m'),
    segs('UNIQUE CHUNKS ENTERED', formatInt(stats.uniqueChunks)),
    segs('LANDMARKS VISITED', String(stats.landmarkNames.length)),
    segs('NOTES READ', String(stats.notesRead)),
    segs('BATTERIES COLLECTED', String(stats.batteries)),
    segs('RELOCATIONS SURVIVED', String(stats.relocations)),
    {
      segments: [
        { text: 'DIRECTOR PHASES // ', tone: 'dim' },
        ...interleave(phases, { text: ' \u00b7 ', tone: 'dim' }),
      ],
    },
    segs('DEEPEST FROM SPAWN', formatInt(stats.deepestM) + ' m'),
  ];
  return lines;
}

/** Final footer line: seed + duration. */
export function formatFooter(stats: ExpeditionStats): string {
  return (
    'EXPEDITION SEED ' + String(Math.floor(stats.seed)) +
    ' \u00b7 DURATION ' + formatDuration(stats.durationSec)
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const MONO = "'Courier New',Courier,monospace";
const TONE_DIM = '#6e6438';
const TONE_AMBER = '#ffb347';

const OVERLAY_STYLE =
  'position:absolute;inset:0;display:none;flex-direction:column;' +
  'align-items:center;justify-content:center;background:rgba(3,3,5,0.94);' +
  'font-family:' + MONO + ';color:#cdbf72;z-index:70;';
const PANEL_STYLE =
  'width:min(680px,92%);max-height:86%;overflow-y:auto;display:flex;' +
  'flex-direction:column;border:1px solid #6e6438;background:#07070a;' +
  'padding:22px 26px;box-sizing:border-box;';
const TITLE_STYLE =
  'font-family:' + MONO + ';font-size:14px;letter-spacing:4px;color:#ff7d68;' +
  'margin-bottom:14px;text-align:left;';
const STAT_ROW_STYLE =
  'font-family:' + MONO + ';font-size:13px;letter-spacing:1px;line-height:1.7;' +
  'min-height:1.7em;text-align:left;white-space:pre-wrap;';
const RANK_ROW_STYLE =
  'font-family:' + MONO + ';font-size:15px;letter-spacing:3px;line-height:1.8;' +
  'margin-top:12px;border-top:1px solid #2a2a20;padding-top:10px;text-align:left;';
const FOOTER_STYLE =
  'font-family:' + MONO + ';font-size:11px;letter-spacing:2px;color:#6e6438;' +
  'margin-top:10px;text-align:left;min-height:1.5em;';
const HINT_STYLE =
  'font-family:' + MONO + ';font-size:10px;letter-spacing:2px;color:#4a4426;' +
  'margin-top:16px;text-align:left;';

/* ------------------------------------------------------------------ */
/* EndStats                                                            */
/* ------------------------------------------------------------------ */

export interface EndStatsOptions {
  /** Per-character typing delay in ms. Defaults to 30. */
  charDelayMs?: number;
}

/**
 * Post-ending statistics overlay. The game creates one instance and calls
 * show(stats) once the ending text dismisses; hide() dismisses early.
 */
export class EndStats {
  private container: HTMLElement;
  private charDelayMs: number;

  private root: HTMLElement | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private rowsToType: HTMLElement[] = [];
  private _isOpen = false;

  private readonly onKey: (ev: KeyboardEvent) => void;

  constructor(container: HTMLElement, opts?: EndStatsOptions) {
    this.container = container;
    this.charDelayMs = opts && opts.charDelayMs !== undefined ? opts.charDelayMs : 30;
    this.onKey = (ev: KeyboardEvent): void => {
      if (!this._isOpen) return;
      if (ev.key === 'Escape') this.hide();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKey);
    }
  }

  /** True while the debrief overlay is visible. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /* ------------------------- public API --------------------------- */

  /** Open the debrief for these stats and start the typewriter reveal. */
  show(stats: ExpeditionStats): void {
    this.clearTimers();
    this.ensureOverlay();
    this.render(stats);
    if (this.root) this.root.style.display = 'flex';
    this._isOpen = true;
    this.scheduleReveal();
  }

  /** Close the overlay and stop any pending typewriter output. */
  hide(): void {
    this.clearTimers();
    if (this.root) this.root.style.display = 'none';
    this._isOpen = false;
  }

  /** Release listeners and DOM. */
  dispose(): void {
    this.clearTimers();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKey);
    }
    this.root?.parentElement?.removeChild(this.root);
    this.root = null;
    this._isOpen = false;
  }

  /* -------------------------- internals --------------------------- */

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private ensureOverlay(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.className = 'bmb-endstats';
    root.setAttribute('style', OVERLAY_STYLE);
    const panel = document.createElement('div');
    panel.className = 'bmb-endstats-panel';
    panel.setAttribute('style', PANEL_STYLE);
    root.appendChild(panel);
    this.container.appendChild(root);
    this.root = root;
  }

  /**
   * Build every row with its full text stashed in data attributes but
   * empty rendered content; scheduleReveal types them out row by row.
   */
  private render(stats: ExpeditionStats): void {
    const panel = this.root!.children[0] as HTMLElement;
    while (panel.children.length > 0) panel.removeChild(panel.children[0]);
    this.rowsToType = [];

    // Title: simple single-span typed row.
    this.rowsToType.push(this.appendTypedText(panel, 'bmb-endstats-title', TITLE_STYLE, 'EXPEDITION DEBRIEF'));

    let landmarkRowSeen = false;
    for (const line of formatStatLines(stats)) {
      const row = document.createElement('div');
      row.className = 'bmb-endstats-row';
      row.setAttribute('style', STAT_ROW_STYLE);
      let full = '';
      for (const segment of line.segments) {
        const span = document.createElement('span');
        span.setAttribute(
          'style',
          'color:' + (segment.tone === 'amber' ? TONE_AMBER : TONE_DIM) + ';'
        );
        span.setAttribute('data-text', segment.text);
        span.textContent = '';
        row.appendChild(span);
        full += segment.text;
      }
      row.setAttribute('data-full', full);
      panel.appendChild(row);
      this.rowsToType.push(row);

      // Landmark names listed under the count row.
      if (!landmarkRowSeen && line.segments[0].text.indexOf('LANDMARKS VISITED') === 0) {
        landmarkRowSeen = true;
        if (stats.landmarkNames.length > 0) {
          const namesText = '\u2022 ' + stats.landmarkNames.join('\n\u2022 ');
          this.rowsToType.push(
            this.appendTypedSpanRow(panel, 'bmb-endstats-landmarks', namesText)
          );
        }
      }
    }

    // Rank row: dim label + large amber letter.
    const rankRow = document.createElement('div');
    rankRow.className = 'bmb-endstats-rank';
    rankRow.setAttribute('style', RANK_ROW_STYLE);
    const rankLabel = document.createElement('span');
    rankLabel.setAttribute('style', 'color:' + TONE_DIM + ';');
    rankLabel.setAttribute('data-text', 'EXPEDITION RANK ');
    rankLabel.textContent = '';
    const rankValue = document.createElement('span');
    rankValue.setAttribute('style', 'color:' + TONE_AMBER + ';font-size:20px;');
    rankValue.setAttribute('data-text', computeRank(stats));
    rankValue.textContent = '';
    rankRow.appendChild(rankLabel);
    rankRow.appendChild(rankValue);
    rankRow.setAttribute('data-full', 'EXPEDITION RANK ' + computeRank(stats));
    panel.appendChild(rankRow);
    this.rowsToType.push(rankRow);

    // Final line: expedition seed + duration.
    this.rowsToType.push(
      this.appendTypedText(panel, 'bmb-endstats-footer', FOOTER_STYLE, formatFooter(stats))
    );

    const hint = document.createElement('div');
    hint.className = 'bmb-endstats-hint';
    hint.setAttribute('style', HINT_STYLE);
    hint.textContent = '[ESC] DISMISS';
    panel.appendChild(hint);
  }

  /** Single-span typed row (title / footer / landmark list). */
  private appendTypedText(panel: HTMLElement, cls: string, style: string, text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('style', style);
    el.textContent = '';
    el.setAttribute('data-chars', text);
    panel.appendChild(el);
    return el;
  }

  /** Row wrapping one dim typed span (landmark name list). */
  private appendTypedSpanRow(panel: HTMLElement, cls: string, text: string): HTMLElement {
    const row = document.createElement('div');
    row.className = cls;
    row.setAttribute('style', STAT_ROW_STYLE);
    const span = document.createElement('span');
    span.setAttribute('style', 'color:' + TONE_DIM + ';white-space:pre-wrap;');
    span.setAttribute('data-text', text);
    span.textContent = '';
    row.appendChild(span);
    row.setAttribute('data-full', text);
    panel.appendChild(row);
    return row;
  }

  /**
   * Sequentially typewriter-reveal every prepared row: characters appear
   * one every charDelayMs; the next row starts when the current finishes.
   * Rows carry either data-chars (plain single-text rows) or a set of
   * spans each carrying data-text (label/value rows).
   */
  private scheduleReveal(): void {
    const queue = this.rowsToType.slice();
    const typeRow = (row: HTMLElement, onDone: () => void): void => {
      if (row.hasAttribute('data-chars')) {
        const full = row.getAttribute('data-chars') ?? '';
        const tick = (): void => {
          const done = (row.textContent ?? '').length;
          if (done < full.length) {
            row.textContent = full.slice(0, done + 1);
            this.timers.push(setTimeout(tick, this.charDelayMs));
          } else {
            onDone();
          }
        };
        tick();
      } else if (row.hasAttribute('data-full')) {
        const spans = Array.prototype.slice.call(row.children) as HTMLElement[];
        let si = 0;
        const tick = (): void => {
          if (si >= spans.length) {
            onDone();
            return;
          }
          const span = spans[si];
          const fullText = span.getAttribute('data-text') ?? '';
          const done = (span.textContent ?? '').length;
          if (done < fullText.length) {
            span.textContent = fullText.slice(0, done + 1);
            this.timers.push(setTimeout(tick, this.charDelayMs));
          } else {
            si++;
            this.timers.push(setTimeout(tick, this.charDelayMs));
          }
        };
        tick();
      } else {
        onDone();
      }
    };
    const next = (): void => {
      const row = queue.shift();
      if (!row) return;
      typeRow(row, next);
    };
    next();
  }
}


