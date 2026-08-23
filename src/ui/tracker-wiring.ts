/**
 * Gameplay → achievement trigger pipeline.
 *
 * The game loop produces stat snapshots every frame; evaluating unlock
 * conditions (and touching persistence/DOM) that often is wasteful and
 * visually noisy. TrackerFeed sits between gameplay and the Tracker:
 *
 *   - `feed(frame)` batches incoming state (cheap merge, no allocation
     churn beyond one snapshot) instead of evaluating immediately.
 *   - A single timer evaluates the batched snapshot via checkUnlocks
 *     once per FEED_INTERVAL_MS (default 5000), not per frame.
 *   - Newly earned achievements are routed through a pluggable toast
 *     sink. The UI shell (src/ui/ui.ts) exposes `ui.toast(msg)` — there
 *     is no `showToast`, so hosts install the sink via
 *     `setAchievementToastSink((info) => ui.toast(...))`; when no sink
 *     is installed the fallback logs to the console.
 *   - Milestone bookkeeping distinguishes achievements already unlocked
 *     in a previous session (persisted under STORAGE_KEY in localStorage)
 *     from ones firing THIS session: only fresh unlocks are toasted, and
 *     each id toasts exactly once per session.
 *
 * Pure logic — no DOM of its own. Construct once alongside the Tracker.
 */
import {
  ACHIEVEMENTS,
  Discovery,
  type TrackerState,
  Tracker,
  checkUnlocks,
  loadUnlocked,
  saveUnlocked,
} from './tracker';

/** How often batched gameplay state is evaluated against thresholds. */
export const FEED_INTERVAL_MS = 5000;

/** Shape handed to the toast sink (mirrors tracker's internal defs). */
export interface AchievementInfo {
  id: Discovery;
  title: string;
  description: string;
  icon: string;
}

/**
 * Receives one call per freshly unlocked achievement. Install the UI
 * variant early (e.g. right after constructing UI + Tracker):
 *   setAchievementToastSink((info) => ui.toast(`discovery: ${info.title}`));
 */
export type AchievementToastSink = (info: AchievementInfo) => void;

let toastSink: AchievementToastSink | null = null;

/** Wire achievement toasts into the app's UI toast area (or null to reset). */
export function setAchievementToastSink(sink: AchievementToastSink | null): void {
  toastSink = sink;
}

function fallbackToast(info: AchievementInfo): void {
  // No UI toast system available (tests, headless): log instead of dropping.
  console.log('[discovery] ' + info.icon + ' ' + info.title + ' — ' + info.description);
}

function emitToast(info: AchievementInfo): void {
  if (!toastSink) {
    fallbackToast(info);
    return;
  }
  try {
    toastSink(info);
  } catch {
    fallbackToast(info);
  }
}

const CATALOG = new Map<Discovery, AchievementInfo>(
  ACHIEVEMENTS.map((a) => [a.id, { id: a.id, title: a.title, description: a.description, icon: a.icon }]),
);

function cloneState(s: TrackerState): TrackerState {
  return { discoveries: s.discoveries, notesRead: s.notesRead, landmarksSeen: [...s.landmarksSeen], playtimeSec: s.playtimeSec, completed: s.completed };
}

function mergeInto(pending: TrackerState, frame: TrackerState): void {
  pending.discoveries = Math.max(pending.discoveries, frame.discoveries);
  pending.notesRead = Math.max(pending.notesRead, frame.notesRead);
  pending.playtimeSec = Math.max(pending.playtimeSec, frame.playtimeSec);
  pending.completed = pending.completed || frame.completed;
  if (frame.landmarksSeen.length > 0) {
    const seen = new Set(pending.landmarksSeen);
    for (const lm of frame.landmarksSeen) seen.add(lm);
    pending.landmarksSeen = [...seen];
  }
}

export interface TrackerFeedOptions {
  /** Evaluation cadence; <= 0 disables the auto timer (manual flush only). */
  intervalMs?: number;
  /** Observability/test hook: invoked once per evaluation with fresh ids. */
  onFlush?: (fresh: Discovery[]) => void;
}

/**
 * Collects per-frame gameplay stats and drives achievement unlocks at a
 * bounded cadence. One instance per Tracker.
 */
export class TrackerFeed {
  private readonly tracker: Tracker;
  private readonly intervalMs: number;
  private readonly onFlush?: (fresh: Discovery[]) => void;
  private pending: TrackerState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Everything unlocked before this session started (panel baseline). */
  private readonly known: Set<Discovery>;
  /** Ids whose toast fired during this session, in unlock order. */
  private readonly firedThisSession: Discovery[] = [];

  constructor(tracker: Tracker, opts?: TrackerFeedOptions) {
    this.tracker = tracker;
    this.intervalMs = opts?.intervalMs ?? FEED_INTERVAL_MS;
    this.onFlush = opts?.onFlush;
    const persisted = loadUnlocked();
    this.known = new Set<Discovery>([...tracker.unlocked, ...persisted]);
    // Sync the panel baseline with ids persisted under STORAGE_KEY that the
    // Tracker instance has not seen yet, so saving below cannot lose them.
    for (const id of persisted) {
      if (!tracker.unlocked.has(id)) tracker.unlocked.add(id);
    }
  }

  /**
   * Feed one frame of gameplay data. Cheap: merges into the pending
   * snapshot and (re)arms the interval timer; never evaluates here.
   */
  feed(frame: TrackerState): void {
    if (this.pending === null) {
      this.pending = cloneState(frame);
    } else {
      mergeInto(this.pending, frame);
    }
    if (this.timer === null && this.intervalMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.intervalMs);
    }
  }

  /**
   * Evaluate the batched snapshot now (called automatically once per
   * interval). Persists and toasts each newly earned id exactly once.
   * Returns the ids unlocked by this evaluation.
   */
  flush(): Discovery[] {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const state = this.pending;
    if (state === null) return [];
    this.pending = null;

    const fresh = checkUnlocks(state, this.known);
    if (fresh.length === 0) {
      this.onFlush?.([]);
      return [];
    }
    for (const id of fresh) {
      this.known.add(id);
      this.firedThisSession.push(id);
      // Keep the Tracker panel (Tab-hold summary) in sync so gameplay
      // unlocks show up there even though the feed owns evaluation.
      if (!this.tracker.unlocked.has(id)) this.tracker.unlocked.add(id);
      const info = CATALOG.get(id);
      if (info) emitToast(info);
    }
    saveUnlocked(this.tracker.unlocked);
    this.onFlush?.(fresh);
    return fresh;
  }

  /** Ids that fired (and were toasted) during this session, in order. */
  get sessionFired(): readonly Discovery[] {
    return this.firedThisSession;
  }

  /** True if this id was unlocked by gameplay earlier in this session. */
  firedInSession(id: Discovery): boolean {
    return this.firedThisSession.includes(id);
  }

  /** True if the id was already unlocked before this session began. */
  preUnlocked(id: Discovery): boolean {
    return this.known.has(id) && !this.firedThisSession.includes(id);
  }

  /** Stop the timer and drop any unevaluated batched state. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}


