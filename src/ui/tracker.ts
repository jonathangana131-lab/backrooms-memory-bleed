/**
 * Discovery tracker: achievements, toast notifications, persistence,
 * and the Tab-hold summary panel.
 *
 * Standalone module — owns only its own DOM subtree and styles; nothing
 * here touches game state directly. The game calls tracker.update(state)
 * whenever a stat changes.
 */
export enum Discovery {
  FIRST_STEPS = 'first_steps',
  FIRST_BEACON = 'first_beacon',
  HALF_WAY = 'half_way',
  ALL_BEACONS = 'all_beacons',
  LANDMARK_VISITOR = 'landmark_visitor',
  NOTE_COLLECTOR = 'note_collector',
  SURVIVOR = 'survivor',
  THRESHOLD_CROSSER = 'threshold_crosser',
}

/** Snapshot of player-facing stats used to evaluate unlock conditions. */
export interface TrackerState {
  /** Number of research beacons discovered so far. */
  discoveries: number;
  /** Notes read so far. */
  notesRead: number;
  /** Distinct landmark room names seen (see LANDMARK_KINDS in architect.ts). */
  landmarksSeen: string[];
  /** Seconds survived this expedition. */
  playtimeSec: number;
  /** Story complete (threshold crossed). */
  completed: boolean;
}

export const STORAGE_KEY = 'bmb-achievements';

export const TOTAL_BEACONS = 8;
export const TOTAL_LANDMARK_KINDS = 8;
export const NOTE_TARGET = 20;
export const SURVIVOR_SECONDS = 30 * 60;

interface AchievementDef {
  id: Discovery;
  title: string;
  description: string;
  icon: string;
}

/** Ordered catalog; order drives the panel listing. */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: Discovery.FIRST_STEPS, title: 'First Steps', description: 'Wander the yellow rooms for thirty seconds.', icon: '\u203a' },
  { id: Discovery.FIRST_BEACON, title: 'Signal Chaser', description: 'Find your first research beacon.', icon: '\u25c6' },
  { id: Discovery.HALF_WAY, title: 'Half Way', description: 'Discover half of the research beacons.', icon: '\u25d1' },
  { id: Discovery.ALL_BEACONS, title: 'Cartographer of Static', description: 'Discover every research beacon.', icon: '\u2726' },
  { id: Discovery.LANDMARK_VISITOR, title: 'Landmark Visitor', description: 'Set foot in every kind of landmark room.', icon: '\u25a3' },
  { id: Discovery.NOTE_COLLECTOR, title: 'Note Collector', description: 'Read notes left by those before you.', icon: '\u270e' },
  { id: Discovery.SURVIVOR, title: 'Survivor', description: 'Endure thirty minutes without being taken.', icon: '\u231b' },
  { id: Discovery.THRESHOLD_CROSSER, title: 'Threshold Crosser', description: 'Complete the story.', icon: '\u2318' },
];

const byId = new Map<string, AchievementDef>(ACHIEVEMENTS.map((a) => [a.id as string, a]));

/**
 * Pure evaluation: returns which achievements satisfy their condition in
 * `state` but are not yet present in `unlocked`. Order follows the catalog.
 */
export function checkUnlocks(state: TrackerState, unlocked: Iterable<string>): Discovery[] {
  const has = new Set(unlocked);
  const uniqueLandmarks = new Set(state.landmarksSeen);
  const out: Discovery[] = [];
  const tryAdd = (id: Discovery, ok: boolean): void => {
    if (ok && !has.has(id)) out.push(id);
  };
  tryAdd(Discovery.FIRST_STEPS, state.playtimeSec >= 30);
  tryAdd(Discovery.FIRST_BEACON, state.discoveries >= 1);
  tryAdd(Discovery.HALF_WAY, state.discoveries >= TOTAL_BEACONS / 2);
  tryAdd(Discovery.ALL_BEACONS, state.discoveries >= TOTAL_BEACONS);
  tryAdd(Discovery.LANDMARK_VISITOR, uniqueLandmarks.size >= TOTAL_LANDMARK_KINDS);
  tryAdd(Discovery.NOTE_COLLECTOR, state.notesRead >= NOTE_TARGET);
  tryAdd(Discovery.SURVIVOR, state.playtimeSec >= SURVIVOR_SECONDS);
  tryAdd(Discovery.THRESHOLD_CROSSER, state.completed);
  return out;
}

export interface ProgressInfo {
  cur: number;
  max: number;
  /** Human-readable fraction, e.g. "12/20 notes". Empty when n/a. */
  hint: string;
}

function clamp(n: number, max: number): number {
  return Math.min(n, max);
}

/** Progress fraction + hint text for a (usually locked) achievement. */
export function progressFor(id: Discovery, state: TrackerState): ProgressInfo {
  const landmarks = new Set(state.landmarksSeen).size;
  switch (id) {
    case Discovery.FIRST_STEPS:
      return { cur: clamp(Math.floor(state.playtimeSec), 30), max: 30, hint: clamp(Math.floor(state.playtimeSec), 30) + '/30 sec' };
    case Discovery.FIRST_BEACON:
      return { cur: clamp(state.discoveries, 1), max: 1, hint: clamp(state.discoveries, 1) + '/1 beacons' };
    case Discovery.HALF_WAY:
      return { cur: clamp(state.discoveries, TOTAL_BEACONS / 2), max: TOTAL_BEACONS / 2, hint: clamp(state.discoveries, TOTAL_BEACONS / 2) + '/' + TOTAL_BEACONS + ' beacons' };
    case Discovery.ALL_BEACONS:
      return { cur: clamp(state.discoveries, TOTAL_BEACONS), max: TOTAL_BEACONS, hint: clamp(state.discoveries, TOTAL_BEACONS) + '/' + TOTAL_BEACONS + ' beacons' };
    case Discovery.LANDMARK_VISITOR:
      return { cur: clamp(landmarks, TOTAL_LANDMARK_KINDS), max: TOTAL_LANDMARK_KINDS, hint: clamp(landmarks, TOTAL_LANDMARK_KINDS) + '/' + TOTAL_LANDMARK_KINDS + ' types' };
    case Discovery.NOTE_COLLECTOR:
      return { cur: clamp(state.notesRead, NOTE_TARGET), max: NOTE_TARGET, hint: clamp(state.notesRead, NOTE_TARGET) + '/' + NOTE_TARGET + ' notes' };
    case Discovery.SURVIVOR:
      return { cur: clamp(state.playtimeSec, SURVIVOR_SECONDS), max: SURVIVOR_SECONDS, hint: Math.floor(clamp(state.playtimeSec, SURVIVOR_SECONDS) / 60) + '/30 min' };
    case Discovery.THRESHOLD_CROSSER:
      return { cur: state.completed ? 1 : 0, max: 1, hint: '' };
  }
}

// ---- persistence -----------------------------------------------------------

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read the persisted unlocked-id array; tolerant of corrupt data. */
export function loadUnlocked(): Discovery[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is Discovery => typeof x === 'string' && byId.has(x));
  } catch {
    return [];
  }
}

/** Persist the unlocked-id array (JSON array of ids under STORAGE_KEY). */
export function saveUnlocked(ids: Iterable<Discovery>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota or privacy mode: achievements stay session-local */
  }
}

// ---- DOM -------------------------------------------------------------------

const STYLE_ID = 'bmb-tracker-styles';
const CSS = [
  '.bmb-tracker-toasts { position: fixed; top: 18px; right: 0; z-index: 60;',
    'display: flex; flex-direction: column; gap: 10px; pointer-events: none; }',
  '.bmb-ach-toast { display: flex; align-items: center; gap: 12px; min-width: 260px;',
    'max-width: 360px; padding: 10px 16px 10px 10px; background: rgba(8,9,7,0.88);',
    'border: 1px solid rgba(190,205,180,0.35); border-right: none; color: #cfd8c6;',
    "font-family: 'Courier New', monospace; font-size: 12px; letter-spacing: 0.04em;",
    'opacity: 0; transform: translateX(110%);',
    'animation: bmbToastIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards; }',
  '.bmb-ach-toast.bmb-out { animation: bmbToastOut 0.5s ease forwards; }',
  '@keyframes bmbToastIn { to { opacity: 1; transform: translateX(0); } }',
  '@keyframes bmbToastOut { from { opacity: 1; transform: translateX(0); }',
    'to { opacity: 0; transform: translateX(110%); } }',
  '.bmb-ach-toast .bmb-toast-icon { flex: 0 0 auto; width: 34px; height: 34px;',
    'display: flex; align-items: center; justify-content: center; font-size: 17px;',
    'color: #9fd8c4; border: 1px solid rgba(159,216,196,0.4); background: rgba(159,216,196,0.06); }',
  '.bmb-ach-toast .bmb-toast-body { display: flex; flex-direction: column; gap: 2px; }',
  '.bmb-ach-toast .bmb-toast-label { font-size: 9px; letter-spacing: 0.28em;',
    'text-transform: uppercase; color: rgba(159,216,196,0.65); }',
  '.bmb-ach-toast .bmb-toast-title { font-size: 13px; color: #ecf2e4; letter-spacing: 0.08em; }',
  '.bmb-ach-toast .bmb-toast-desc { font-size: 11px; color: rgba(207,216,198,0.72); }',

  '.bmb-ach-panel { position: fixed; inset: 0; z-index: 55; display: flex;',
    'align-items: center; justify-content: center; background: rgba(4,5,4,0.82);',
    "font-family: 'Courier New', monospace; color: #cfd8c6; pointer-events: none; }",
  '.bmb-ach-panel[hidden] { display: none; }',
  '.bmb-ach-panel-inner { width: min(480px, 86vw); max-height: 80vh; overflow-y: auto;',
    'border: 1px solid rgba(190,205,180,0.3); background: rgba(10,11,9,0.94); padding: 22px 26px; }',
  '.bmb-ach-panel h2 { margin: 0 0 4px; font-size: 14px; letter-spacing: 0.34em;',
    'text-transform: uppercase; color: #ecf2e4; font-weight: normal; }',
  '.bmb-ach-panel .bmb-ach-count { font-size: 10px; letter-spacing: 0.2em;',
    'color: rgba(159,216,196,0.7); margin-bottom: 14px; }',
  '.bmb-ach-row { display: flex; align-items: baseline; gap: 10px; padding: 7px 0;',
    'border-top: 1px solid rgba(190,205,180,0.12); font-size: 12px; }',
  '.bmb-ach-row .bmb-row-icon { width: 18px; text-align: center; color: #9fd8c4; }',
  '.bmb-ach-row .bmb-row-title { letter-spacing: 0.08em; }',
  '.bmb-ach-row .bmb-row-hint { margin-left: auto; font-size: 10px; color: rgba(207,216,198,0.55); }',
  '.bmb-ach-row.locked { opacity: 0.38; }',
  '.bmb-ach-row.locked .bmb-row-icon { color: rgba(207,216,198,0.5); }',
  '.bmb-ach-row.unlocked .bmb-row-title { color: #ecf2e4; }',
].join('\n');

const TOAST_MS = 4000;
const TOAST_FADE_MS = 600;

/**
 * Achievement tracker UI. Owns its own DOM (toast layer + panel overlay);
 * construct once with any parent element (defaults to document.body).
 */
export class Tracker {
  readonly unlocked: Set<Discovery> = new Set(loadUnlocked());
  private toastsEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private tabHeld = false;
  private lastState: TrackerState | null = null;

  constructor(parent: HTMLElement = document.body) {
    injectStyles();
    this.buildToasts(parent);
    this.buildPanel(parent);
    this.bindTabHold();
  }

  /**
   * Feed current stats; unlocks anything newly earned, persists it and shows
   * one toast per fresh achievement. Returns the ids just unlocked.
   */
  update(state: TrackerState): Discovery[] {
    const fresh = checkUnlocks(state, this.unlocked);
    this.lastState = state;
    if (fresh.length === 0) return [];
    for (const id of fresh) this.unlocked.add(id);
    saveUnlocked(this.unlocked);
    for (const id of fresh) this.showToast(id);
    if (this.tabHeld) this.renderPanel(state);
    return fresh;
  }

  // -- toasts --

  private buildToasts(parent: HTMLElement): void {
    this.toastsEl = document.createElement('div');
    this.toastsEl.className = 'bmb-tracker-toasts';
    parent.appendChild(this.toastsEl);
  }

  private showToast(id: Discovery): void {
    const def = byId.get(id);
    if (!def) return;
    const el = document.createElement('div');
    el.className = 'bmb-ach-toast';
    el.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'bmb-toast-icon';
    icon.textContent = def.icon;

    const body = document.createElement('div');
    body.className = 'bmb-toast-body';

    const label = document.createElement('div');
    label.className = 'bmb-toast-label';
    label.textContent = 'discovery';

    const title = document.createElement('div');
    title.className = 'bmb-toast-title';
    title.textContent = def.title;

    const desc = document.createElement('div');
    desc.className = 'bmb-toast-desc';
    desc.textContent = def.description;

    body.append(label, title, desc);
    el.append(icon, body);
    this.toastsEl.appendChild(el);

    setTimeout(() => {
      el.classList.add('bmb-out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      // Fallback removal in case animationend never fires (hidden tab).
      setTimeout(() => el.remove(), TOAST_FADE_MS + 400);
    }, TOAST_MS);
  }

  // -- Tab-hold panel --

  private buildPanel(parent: HTMLElement): void {
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'bmb-ach-panel';
    this.panelEl.hidden = true;

    const inner = document.createElement('div');
    inner.className = 'bmb-ach-panel-inner';

    const heading = document.createElement('h2');
    heading.textContent = 'discoveries';

    this.countEl = document.createElement('div');
    this.countEl.className = 'bmb-ach-count';

    this.listEl = document.createElement('div');

    inner.append(heading, this.countEl, this.listEl);
    this.panelEl.appendChild(inner);
    parent.appendChild(this.panelEl);
  }

  /** Rebuild the panel list from current stats. */
  renderPanel(state?: TrackerState): void {
    const blank: TrackerState = { discoveries: 0, notesRead: 0, landmarksSeen: [], playtimeSec: 0, completed: false };
    const st = state ?? blank;
    this.listEl.textContent = '';
    for (const def of ACHIEVEMENTS) {
      const got = this.unlocked.has(def.id);
      const row = document.createElement('div');
      row.className = 'bmb-ach-row ' + (got ? 'unlocked' : 'locked');

      const icon = document.createElement('span');
      icon.className = 'bmb-row-icon';
      icon.textContent = def.icon;

      const title = document.createElement('span');
      title.className = 'bmb-row-title';
      title.textContent = got ? def.title : '???';

      row.append(icon, title);

      if (got) {
        const desc = document.createElement('span');
        desc.className = 'bmb-row-hint';
        desc.textContent = def.description;
        row.appendChild(desc);
      } else {
        const p = progressFor(def.id, st);
        if (p.hint) {
          const hint = document.createElement('span');
          hint.className = 'bmb-row-hint';
          hint.textContent = p.hint;
          row.appendChild(hint);
        }
      }
      this.listEl.appendChild(row);
    }
    this.countEl.textContent = this.unlocked.size + ' / ' + ACHIEVEMENTS.length + ' found';
  }

  private bindTabHold(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      if (this.tabHeld) return;
      this.tabHeld = true;
      this.renderPanel(this.lastState ?? undefined);
      this.panelEl.hidden = false;
    });
    const release = (): void => {
      if (!this.tabHeld) return;
      this.tabHeld = false;
      this.panelEl.hidden = true;
    };
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Tab') release();
    });
    window.addEventListener('blur', release);
  }
}

(Showing lines 338-365 of 373. Use offset=366 to continue.)


function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}


