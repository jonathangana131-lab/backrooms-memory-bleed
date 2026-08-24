/***********************************************************************
 * F47 Daily rite — a shared daily seed plus a discovery checklist
 * overlay, reset at UTC midnight.
 *
 * Design intent:
 *  - Every player worldwide gets the SAME daily seed: today's UTC date
 *    string ('YYYY-MM-DD') is hashed through the repo-standard
 *    seedFromString and XOR-combined with a fixed game salt. The salt
 *    keeps daily seeds disjoint from run-seed space so a lucky run
 *    seed can never collide with a calendar day.
 *  - The checklist tracks three rite goals (read notes, visit a
 *    landmark, survive a blackout). Progress persists through an
 *    injected storage pair { get, set }, keyed by date, so it
 *    round-trips across sessions and resets naturally at rollover.
 *  - Rollover is explicit: tick()/maybeRollover() compares the stored
 *    date key against the current UTC key and starts a fresh rite when
 *    they differ. Goal completion is idempotent - reporting beyond the
 *    target never re-fires completion.
 *
 * Standalone module: owns only its own stylesheet and DOM subtree, like
 * hints.ts / compass.ts. Pure logic + DOM, no Babylon dependency. All
 * randomness flows through src/core/rng.ts (determinism law).
 ***********************************************************************/

import { seedFromString } from '../core/rng';

/** Fixed game salt XOR-ed into every daily seed (disjoint from run seeds). */
export const DAILY_RITE_SALT = 0x62ebc1d5 >>> 0;

/** Storage key prefix; the full key is PREFIX + dateKey. */
export const DAILY_RITE_KEY_PREFIX = 'bmb-dailyrite:';

/** Number of distinct rite goals presented each day. */
export const DAILY_GOAL_COUNT = 3;

/** One checklist goal of the daily rite. */
export interface DailyGoal {
  /** Stable machine id used in persisted progress and events. */
  readonly id: string;
  /** Overlay label, styled as found-document text. */
  readonly label: string;
  /** Completions required to check this goal off. */
  readonly target: number;
}

/** Today's rite goals, in canonical (id-stable) order. */
export const DAILY_GOALS: readonly DailyGoal[] = [
  { id: 'notes', label: 'READ 3 NOTES', target: 3 },
  { id: 'landmark', label: 'VISIT A LANDMARK', target: 1 },
  { id: 'blackout', label: 'SURVIVE A BLACKOUT', target: 1 },
];

/** Minimal persistence surface injected into DailyRite (localStorage-like). */
export interface DailyRiteStorage {
  /** Stored value for key, or null when absent/corrupt. */
  get(key: string): string | null;
  /** Persist value for key. */
  set(key: string, value: string): void;
}

/**
 * UTC calendar key ('YYYY-MM-DD') for a Date. Every player computing
 * this on the same calendar day gets the identical string regardless of
 * local time zone, which is what makes the seed shareable.
 */
export function utcDateKey(d: Date = new Date()): string {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

/**
 * The shared daily seed for a UTC date key: FNV-style hash of the date
 * string XOR the fixed game salt. Same date string => same seed
 * everywhere, including leap days (the date string simply hashes).
 */
export function dailySeed(dateKey: string): number {
  return (seedFromString(dateKey) ^ DAILY_RITE_SALT) >>> 0;
}

/** Persisted per-goal progress. */
export interface GoalProgress {
  /** Completions counted toward the target (never above it matters). */
  count: number;
  /** Latched once count >= target; further reports are no-ops. */
  done: boolean;
}

/** Full persisted state for one day's rite. */
export interface DailyState {
  /** UTC date key this state belongs to. */
  dateKey: string;
  /** Shared daily seed derived from dateKey. */
  seed: number;
  /** Per-goal progress keyed by goal id. */
  goals: Record<string, GoalProgress>;
}

/** Parse persisted JSON defensively; null when unusable for dateKey. */
function parseState(raw: string | null, dateKey: string): DailyState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const rec = data as { dateKey?: unknown; seed?: unknown; goals?: unknown };
  if (rec.dateKey !== dateKey || typeof rec.seed !== 'number') return null;
  if (!rec.goals || typeof rec.goals !== 'object') return null;
  const goals: Record<string, GoalProgress> = {};
  for (const g of DAILY_GOALS) {
    const gp = (rec.goals as Record<string, Partial<GoalProgress>>)[g.id];
    const count = typeof gp?.count === 'number' ? Math.max(0, Math.floor(gp.count)) : 0;
    goals[g.id] = { count, done: Boolean(gp?.done) || count >= g.target };
  }
  return { dateKey, seed: rec.seed >>> 0, goals };
}

/** Fresh blank state for a date key. */
function blankState(dateKey: string): DailyState {
  const goals: Record<string, GoalProgress> = {};
  for (const g of DAILY_GOALS) goals[g.id] = { count: 0, done: false };
  return { dateKey, seed: dailySeed(dateKey), goals };
}

/* ------------------------------------------------------------------ */
/* Overlay DOM surfaces (structural, stub-friendly)                    */
/* ------------------------------------------------------------------ */

/** Minimal structural surface of elements used by the overlay. */
export interface RiteElementLike {
  className: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: RiteElementLike): unknown;
  remove(): void;
}

/** Minimal structural surface of the document used by the overlay. */
export interface RiteDocumentLike {
  createElement(tagName: string): RiteElementLike;
  head: { appendChild(child: RiteElementLike): unknown };
}

/** Options for constructing a DailyRite. */
export interface DailyRiteOptions {
  /** Injected persistence pair (production forwards localStorage). */
  storage: DailyRiteStorage;
  /** Injected document (tests pass a stub; production uses the global). */
  document?: RiteDocumentLike | null;
  /**
   * Injected container for the checklist overlay element. When omitted
   * (or when no document is available) the rite runs headless: pure
   * model only, which is what the game logic consumes.
   */
  container?: RiteElementLike | null;
  /** Override the clock; defaults to wall time (tests pin dates here). */
  now?: () => Date;
}

/**
 * Owns one day's rite: the shared seed, the persistent checklist, the
 * UTC-midnight rollover, and (optionally) the checklist overlay.
 *
 *   const rite = new DailyRite({ storage: localStorage });
 *   rite.report('notes');            // one note read
 *   rite.tick();                     // checks rollover once per session
 */
export class DailyRite {
  private readonly storage: DailyRiteStorage;
  private readonly nowFn: () => Date;
  private state: DailyState;
  private el: RiteElementLike | null = null;
  private doc: RiteDocumentLike | null = null;
  /** Overlay row elements currently mounted, in goal order. */
  private overlayRows: RiteElementLike[] = [];
  private rows: Record<string, RiteElementLike> = {};

  constructor(opts: DailyRiteOptions) {
    this.storage = opts.storage;
    this.nowFn = opts.now ?? (() => new Date());
    const key = utcDateKey(this.nowFn());
    const saved = parseState(this.storage.get(DAILY_RITE_KEY_PREFIX + key), key);
    this.state = saved ?? blankState(key);
    this.persist();
    this.mountOverlay(opts.document ?? null, opts.container ?? null);
  }

  /** The shared daily seed every player derives for this date. */
  get seed(): number {
    return this.state.seed;
  }

  /** UTC date key of the active rite. */
  get dateKey(): string {
    return this.state.dateKey;
  }

  /** Snapshot of current per-goal progress (copy; safe to inspect). */
  get progress(): Record<string, GoalProgress> {
    const out: Record<string, GoalProgress> = {};
    for (const g of DAILY_GOALS) {
      const p = this.state.goals[g.id] ?? { count: 0, done: false };
      out[g.id] = { count: p.count, done: p.done };
    }
    return out;
  }

  /** True when every rite goal is checked off. */
  get complete(): boolean {
    return DAILY_GOALS.every((g) => this.state.goals[g.id]?.done === true);
  }

  /**
   * Report progress toward a goal. Returns true exactly when this call
   * NEWLY completes the goal (idempotent: repeat reports past the
   * target return false and change nothing latched).
   */
  report(goalId: string, amount: number = 1): boolean {
    const goal = DAILY_GOALS.find((g) => g.id === goalId);
    if (!goal || !(amount > 0)) return false;
    const p = this.state.goals[goalId];
    if (!p || p.done) return false;
    p.count += Math.floor(amount);
    if (p.count >= goal.target) {
      p.done = true;
      this.persist();
      this.renderRows();
      return true;
    }
    this.persist();
    return false;
  }

  /**
    * Advance the rite clock: roll over at UTC midnight. Returns true
    * when a fresh rite was started (progress reset, new daily seed).
    */
  tick(): boolean {
    return this.maybeRollover(utcDateKey(this.nowFn()));
  }

  /** Roll to dateKey when it differs from the active rite's key. */
  maybeRollover(dateKey: string): boolean {
    if (dateKey === this.state.dateKey) return false;
    const saved = parseState(this.storage.get(DAILY_RITE_KEY_PREFIX + dateKey), dateKey);
    this.state = saved ?? blankState(dateKey);
    this.persist();
    this.renderRows();
    return true;
  }

  /** Write the active state under its date-keyed slot. */
  private persist(): void {
    this.storage.set(DAILY_RITE_KEY_PREFIX + this.state.dateKey, JSON.stringify(this.state));
  }

  /* ------------------------- overlay ------------------------------ */

  private mountOverlay(
    doc: RiteDocumentLike | null,
    container: RiteElementLike | null,
  ): void {
    if (!doc || !container) return; // headless mode: model only
    const style = doc.createElement('style');
    style.className = 'bmb-ritestyle';
    setText(style, buildCss());
    doc.head.appendChild(style);

    const root = doc.createElement('div');
    root.className = 'bmb-dailyrite';
    root.style.setProperty('display', 'none');
    container.appendChild(root);

    this.doc = doc;
    this.el = root;
    this.renderRows();
  }

  /** Rebuild goal rows into the overlay (no-op when headless). */
  private renderRows(): void {
    if (!this.el || !this.doc) return;
    for (const r of this.overlayRows) {
      try {
        r.remove();
      } catch {
        /* already detached */
      }
    }
    this.overlayRows = [];
    this.rows = {};
    for (const g of DAILY_GOALS) {
      const row = this.doc.createElement('div');
      row.className = 'bmb-dailyrite-row';
      const p = this.state.goals[g.id] ?? { count: 0, done: false };
      setText(row,
        (p.done ? '[x] ' : '[ ] ') + g.label +
        (g.target > 1 ? ' ' + Math.min(p.count, g.target) + '/' + g.target : ''));
      if (p.done) row.style.setProperty('color', 'rgba(120, 220, 150, 1)');
      this.el.appendChild(row);
      this.rows[g.id] = row;
      this.overlayRows.push(row);
    }
  }

  /** Show the checklist overlay. */
  show(): void {
    this.el?.style.setProperty('display', 'block');
  }

  /** Hide the checklist overlay. */
  hide(): void {
    this.el?.style.setProperty('display', 'none');
  }

  /** Whether the overlay is mounted (false in headless mode). */
  get hasOverlay(): boolean {
    return this.el !== null;
  }

  /** Remove the DOM subtree (model stays usable). */
  disposeOverlay(): void {
    try {
      this.el?.remove();
    } catch {
      /* already detached */
    }
    this.el = null;
    this.rows = {};
  }

  /** Row element for a goal id, when the overlay is mounted. */
  rowFor(goalId: string): RiteElementLike | undefined {
    return this.rows[goalId];
  }
}

/** Build the overlay stylesheet text. */
function buildCss(): string {
  return [
    '.bmb-dailyrite {',
    '  position: fixed;',
    '  right: 18px;',
    '  top: 14px;',
    '  padding: 10px 14px;',
    '  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;',
    '  font-size: 12px;',
    '  letter-spacing: 0.06em;',
    '  color: rgba(206, 198, 178, 1);',
    '  background: rgba(8, 9, 7, 0.72);',
    '  border: 1px solid rgba(120, 110, 80, 0.5);',
    '  z-index: 6;',
    '  pointer-events: none;',
    '  white-space: pre-line;',
    '}',
  ].join(String.fromCharCode(10));
}

/** Write text content onto an element without relying on DOM typings. */
function setText(el: RiteElementLike, text: string): void {
  (el as unknown as { textContent?: string }).textContent = text;
}
