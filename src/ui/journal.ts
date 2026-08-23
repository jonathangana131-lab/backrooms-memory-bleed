/**
 * Lore journal for BACKROOMS: MEMORY BLEED.
 *
 * A fullscreen overlay (toggled with J) listing every note the player has
 * collected, grouped by story arc (cluster ID). Notes that belong to a
 * cluster of one sit under the "FRAGMENTS" heading. Clicking a note opens a
 * paper-style reader with the full text; opening a note marks it read and an
 * unread badge on the header tracks what has not been reviewed yet.
 *
 * The game calls addNote(noteId, title, text, clusterId, district) whenever
 * the player picks up a note; the full text comes from the game's own note
 * system, so only this index needs persisting - it is written to
 * localStorage under 'bmb-journal-index' and reloaded on construction.
 *
 * Standalone module - owns only its own DOM subtree and styles, like
 * gallery.ts/compass.ts. Pure DOM + localStorage.
 */

/** localStorage key for the persisted collection index. */
export const STORAGE_KEY = 'bmb-journal-index';

/** Hard cap for derived titles before an ellipsis is appended. */
export const MAX_TITLE = 42;

/** Minimal storage surface the journal needs (localStorage-compatible). */
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** One collected note as stored in the index and rendered in the list. */
export interface JournalEntry {
  /** Stable id from the game's note system. */
  id: string;
  /** Display title (first line of the note when none was supplied). */
  title: string;
  /** Full note text, verbatim from the game's note system. */
  text: string;
  /** Story-arc cluster id; empty string for unaffiliated notes. */
  clusterId: string;
  /** District tag where the note was found. */
  district: string;
  /** Collection time (Date.now() epoch ms). */
  timestamp: number;
  /** Whether the player has opened the full-text view at least once. */
  read: boolean;
}

/** A render group: either a named story arc or the FRAGMENTS bucket. */
export interface JournalSection {
  /** Heading label, e.g. "ARC // HOLLOW CHOIR" or "FRAGMENTS". */
  label: string;
  /** Cluster id backing this section, or null for FRAGMENTS. */
  clusterId: string | null;
  /** Member notes, reading order within arcs, newest first in fragments. */
  notes: JournalEntry[];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function warn(msg: string): void {
  console.warn('[journal] ' + msg);
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve the display title: the supplied title if any, otherwise the first
 * non-blank line of the note text, hard-truncated to MAX_TITLE characters.
 */
export function deriveTitle(rawTitle: string, text: string): string {
  let t = (rawTitle ?? '').trim();
  if (!t) {
    const lines = (text ?? '').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) { t = trimmed; break; }
    }
  }
  t = t.replace(/\s+/g, ' ');
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 1).trimEnd() + '\u2026';
  return t;
}

/** Compact timestamp stamp, e.g. "AUG 23 \u00b7 04:11". */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return MONTHS[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, '0') + ' \u00b7 ' + hh + ':' + mm;
}

/** Heading label for a cluster id. */
export function arcLabel(clusterId: string): string {
  const cid = (clusterId ?? '').trim();
  return cid ? 'ARC // ' + cid.toUpperCase() : 'ARC // UNFILED';
}

/**
 * Group entries into sections. Arcs with two or more notes become their own
 * section (ordered by earliest collection time); notes whose cluster holds
 * only themselves are pooled under FRAGMENTS (newest first), listed last.
 */
export function groupByCluster(entries: JournalEntry[]): JournalSection[] {
  const byCluster = new Map<string, JournalEntry[]>();
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  for (const e of sorted) {
    const key = e.clusterId ?? '';
    const list = byCluster.get(key);
    if (list) list.push(e);
    else byCluster.set(key, [e]);
  }
  const sections: JournalSection[] = [];
  const fragments: JournalEntry[] = [];
  for (const [cid, notes] of byCluster) {
    if (notes.length >= 2) {
      sections.push({ label: arcLabel(cid), clusterId: cid || null, notes });
    } else {
      fragments.push(notes[0]);
    }
  }
  sections.sort((a, b) => {
    const ta = a.notes.length ? a.notes[0].timestamp : 0;
    const tb = b.notes.length ? b.notes[0].timestamp : 0;
    return ta - tb;
  });
  fragments.sort((a, b) => b.timestamp - a.timestamp);
  if (fragments.length > 0) {
    sections.push({ label: 'FRAGMENTS', clusterId: null, notes: fragments });
  }
  return sections;
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string'
    && typeof e.title === 'string'
    && typeof e.text === 'string'
    && typeof e.district === 'string'
    && typeof e.timestamp === 'number';
}

/** Read and validate the persisted index; corrupt data yields []. */
export function loadIndex(store: JournalStorage | null): JournalEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: JournalEntry[] = [];
    for (const item of parsed) {
      if (!isEntry(item)) continue;
      out.push({
        id: item.id,
        title: deriveTitle(item.title, item.text),
        text: item.text,
        clusterId: typeof item.clusterId === 'string' ? item.clusterId : '',
        district: item.district,
        timestamp: item.timestamp,
        read: item.read === true,
      });
    }
    return out;
  } catch (e) {
    warn('failed to load index: ' + (e instanceof Error ? e.message : String(e)));
    return [];
  }
}

/** Persist the index; failures are warned about and swallowed. */
export function saveIndex(entries: JournalEntry[], store: JournalStorage | null): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch (e) {
    warn('failed to save index: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

function safeLocalStorage(): JournalStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    window.localStorage.getItem(STORAGE_KEY);
    return window.localStorage;
  } catch {
    return null;
  }
}
/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

export class Journal {
  /** Root overlay element, child of the container passed to the ctor. */
  readonly root: HTMLElement;
  private listEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private countEl!: HTMLElement;
  private readerEl!: HTMLElement;
  private readerPaperEl!: HTMLElement;
  private entries: JournalEntry[];
  private openState = false;
  private store: JournalStorage | null;

  constructor(container: HTMLElement, storage?: JournalStorage | null) {
    this.store = storage !== undefined ? storage : safeLocalStorage();
    this.entries = loadIndex(this.store);

    injectStyles(container);

    this.root = document.createElement('div');
    this.root.className = 'bmb-journal-overlay';

    const frame = document.createElement('div');
    frame.className = 'bmb-journal-frame';

    const head = document.createElement('div');
    head.className = 'bmb-journal-head';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'bmb-journal-eyebrow';
    eyebrow.textContent = 'RECOVERED DOCUMENTATION';

    const titleRow = document.createElement('div');
    titleRow.className = 'bmb-journal-title-row';

    const title = document.createElement('h1');
    title.className = 'bmb-journal-title';
    title.textContent = 'FIELD JOURNAL';

    this.countEl = document.createElement('span');
    this.countEl.className = 'bmb-journal-count';
    titleRow.appendChild(title);
    titleRow.appendChild(this.countEl);

    const metaRow = document.createElement('div');
    metaRow.className = 'bmb-journal-meta-row';

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'bmb-journal-badge';

    const closeHint = document.createElement('span');
    closeHint.className = 'bmb-journal-hint';
    closeHint.textContent = '[J] TOGGLE \u00b7 [ESC] CLOSE';

    metaRow.appendChild(this.badgeEl);
    metaRow.appendChild(closeHint);

    head.appendChild(eyebrow);
    head.appendChild(titleRow);
    head.appendChild(metaRow);

    this.listEl = document.createElement('div');
    this.listEl.className = 'bmb-journal-list';

    frame.appendChild(head);
    frame.appendChild(this.listEl);
    this.root.appendChild(frame);

    // Full-text reader (hidden until a note is clicked).
    this.readerEl = document.createElement('div');
    this.readerEl.className = 'bmb-journal-reader';
    this.readerPaperEl = document.createElement('div');
    this.readerPaperEl.className = 'bmb-journal-paper';
    this.readerEl.appendChild(this.readerPaperEl);
    this.root.appendChild(this.readerEl);

    container.appendChild(this.root);

    this.root.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.root) this.close();
    });
    this.readerEl.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.readerEl) this.closeReader();
    });

    document.addEventListener('keydown', this.onKey);
    this.renderList();
    this.updateBadge();
  }

  /* ---------------- public API ---------------- */

  /**
   * Record a collected note. The full text comes from the game's note
   * system; duplicate ids are ignored. Returns true if it was newly added.
   */
  addNote(
    noteId: string,
    title: string,
    text: string,
    clusterId: string = '',
    district: string = '',
  ): boolean {
    if (!noteId) {
      warn('addNote called without a note id');
      return false;
    }
    if (this.entries.some((e) => e.id === noteId)) return false;
    this.entries.push({
      id: noteId,
      title: deriveTitle(title, text),
      text,
      clusterId: (clusterId ?? '').trim(),
      district: (district ?? '').trim(),
      timestamp: Date.now(),
      read: false,
    });
    saveIndex(this.entries, this.store);
    this.renderList();
    this.updateBadge();
    return true;
  }

  /** Show or hide the fullscreen journal. */
  toggle(): void {
    if (this.openState) this.close();
    else this.openOverlay();
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** Total number of collected notes. */
  getCollectedCount(): number {
    return this.entries.length;
  }

  /** Number of collected notes not yet reviewed. */
  getUnreadCount(): number {
    return this.entries.reduce((n, e) => n + (e.read ? 0 : 1), 0);
  }

  /** Detach the overlay and its global listeners. */
  dispose(): void {
    document.removeEventListener('keydown', this.onKey);
    if (this.root.parentElement) this.root.parentElement.removeChild(this.root);
  }

  /* ---------------- internals ---------------- */

  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const tag = target && target.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && e.key !== 'Escape') return;
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'Escape') {
      if (!this.openState) return;
      e.preventDefault();
      if (this.readerVisible()) this.closeReader();
      else this.close();

(Showing lines 345-358 of 615. Use offset=359 to continue.)

    }
  };

  private readerVisible(): boolean {
    return this.readerEl.style.display === 'flex';
  }

  private openOverlay(): void {
    this.openState = true;
    this.root.style.display = 'flex';
    this.renderList();
    this.updateBadge();
  }

  private close(): void {
    this.openState = false;
    this.closeReader();
    this.root.style.display = 'none';
  }

  private closeReader(): void {
    this.readerEl.style.display = 'none';
  }

  private markRead(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.read) return;
    entry.read = true;
    saveIndex(this.entries, this.store);
    this.updateBadge();
  }

  private updateBadge(): void {
    const unread = this.getUnreadCount();
    this.countEl.textContent = this.entries.length + ' COLLECTED';
    if (unread > 0) {
      this.badgeEl.style.display = 'inline-block';
      this.badgeEl.textContent = unread + ' UNREAD';
      this.badgeEl.classList.add('on');
    } else {
      this.badgeEl.style.display = 'none';
      this.badgeEl.classList.remove('on');
    }
  }

  private openReader(entry: JournalEntry): void {
    this.markRead(entry.id);
    this.readerPaperEl.textContent = '';

    const paperTitle = document.createElement('h2');
    paperTitle.className = 'bmb-journal-paper-title';
    paperTitle.textContent = entry.title;

    const paperMeta = document.createElement('div');
    paperMeta.className = 'bmb-journal-paper-meta';
    paperMeta.textContent =
      entry.district.toUpperCase() + ' \u00b7 FOUND ' + formatStamp(entry.timestamp);

    this.readerPaperEl.appendChild(paperTitle);
    this.readerPaperEl.appendChild(paperMeta);

    const paragraphs = entry.text.split(/\n\s*\n|\n/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const p = document.createElement('p');
      p.textContent = trimmed;
      this.readerPaperEl.appendChild(p);
    }

    const closeTag = document.createElement('span');
    closeTag.className = 'bmb-journal-paper-close';
    closeTag.textContent = '[ESC] RETURN TO JOURNAL';
    this.readerPaperEl.appendChild(closeTag);

    this.readerEl.style.display = 'flex';
    this.renderList();
  }

  private renderList(): void {
    this.listEl.textContent = '';
    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bmb-journal-empty';
      const l1 = document.createElement('p');
      l1.textContent = 'NOTHING COLLECTED YET.';
      const l2 = document.createElement('p');
      l2.className = 'dim';
      l2.textContent = 'The halls remember more than you do. Keep looking.';
      empty.appendChild(l1);
      empty.appendChild(l2);
      this.listEl.appendChild(empty);
      return;
    }

    const sections = groupByCluster(this.entries);
    for (const section of sections) {
      const sec = document.createElement('section');
      sec.className = 'bmb-journal-section';

      const h2 = document.createElement('h2');
      h2.textContent = section.label;
      const tally = document.createElement('span');
      tally.className = 'bmb-journal-tally';
      tally.textContent = String(section.notes.length);
      h2.appendChild(tally);
      sec.appendChild(h2);

      for (const entry of section.notes) {
        sec.appendChild(this.buildItem(entry));
      }
      this.listEl.appendChild(sec);
    }
  }

  private buildItem(entry: JournalEntry): HTMLElement {
    const item = document.createElement('div');
    item.className = 'bmb-journal-note' + (entry.read ? ' read' : ' unread');
    item.dataset.noteId = entry.id;

    const row = document.createElement('div');
    row.className = 'bmb-journal-note-top';

    const status = document.createElement('span');
    status.className = 'bmb-journal-status';
    status.textContent = entry.read ? '\u00b7' : '\u25cf';

    const name = document.createElement('span');
    name.className = 'bmb-journal-note-name';
    name.textContent = entry.title;

    row.appendChild(status);
    row.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'bmb-journal-note-meta';
    const bits: string[] = [];
    if (entry.district) bits.push(entry.district.toUpperCase());
    bits.push(formatStamp(entry.timestamp));
    bits.push(entry.read ? 'READ' : 'UNREAD');
    meta.textContent = bits.join('  \u00b7  ');

    item.appendChild(row);
    item.appendChild(meta);

    item.addEventListener('click', () => this.openReader(entry));
    return item;
  }
}
/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

let stylesInjected = false;

/** Dark horror palette matching src/style.css; injected once per page. */
function injectStyles(container: HTMLElement): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  const head = document.head ?? container;
  head.appendChild(style);
}

const CSS = [
'.bmb-journal-overlay {',
'  position: fixed; inset: 0; z-index: 47; display: none;',
'  align-items: center; justify-content: center;',
'  background: radial-gradient(ellipse at 50% 40%, rgba(24,21,8,0.94), rgba(4,4,1,0.985) 75%);',
"  font-family: 'Courier New', monospace; color: #d8cfa8;",
'  pointer-events: auto; user-select: none;',
'}',
'.bmb-journal-frame {',
'  width: min(720px, 92vw); max-height: 86vh;',
'  display: flex; flex-direction: column;',
'  background: rgba(10,9,3,0.72);',
'  border: 1px solid #6e6438;',
'  box-shadow: 0 0 60px rgba(0,0,0,0.85), inset 0 0 40px rgba(30,26,10,0.5);',
'  padding: 26px 32px;',
'}',
'.bmb-journal-eyebrow { font-size: 10px; letter-spacing: 5px; color: #8f8354; opacity: 0.8; margin-bottom: 6px; }',
'.bmb-journal-title-row { display: flex; align-items: baseline; gap: 14px; }',
'.bmb-journal-title {',
'  font-size: 22px; letter-spacing: 9px; font-weight: normal; color: #e8dc9e;',
'  text-shadow: 0 0 18px rgba(230,214,120,0.25); margin: 0;',
'}',
'.bmb-journal-count { font-size: 11px; letter-spacing: 3px; color: #94884f; }',
'.bmb-journal-meta-row {',
'  display: flex; justify-content: space-between; align-items: center;',
'  margin-top: 8px; padding-bottom: 12px;',
'  border-bottom: 1px solid rgba(160,146,80,0.35);',
'}',
'.bmb-journal-badge {',
'  display: none; font-size: 10px; letter-spacing: 3px; color: #fff3bd;',
'  border: 1px solid #a89a52; padding: 3px 9px;',
'  background: rgba(90,80,34,0.35);',
'  animation: bmbJournalPulse 2.4s ease-in-out infinite;',
'}',
'@keyframes bmbJournalPulse {',
'  0%, 100% { opacity: 0.65; }',
'  50% { opacity: 1; }',
'}',
'.bmb-journal-hint { font-size: 10px; letter-spacing: 2px; color: #6e6539; }',
'.bmb-journal-list { overflow-y: auto; margin-top: 6px; padding-right: 8px; scrollbar-width: thin; scrollbar-color: #554c2a transparent; }',
'.bmb-journal-section { margin-top: 18px; }',
'.bmb-journal-section h2 {',
'  font-size: 12px; letter-spacing: 5px; font-weight: normal; color: #cdbf72;',
'  margin: 0 0 8px; display: flex; align-items: center; gap: 10px;',
'}',
'.bmb-journal-section h2::after {',
"  content: ''; flex: 1; height: 1px;",
'  background: linear-gradient(90deg, rgba(110,100,56,0.6), transparent);',
'}',
'.bmb-journal-tally {',
'  font-size: 10px; letter-spacing: 1px; color: #94884f;',
'  border: 1px solid rgba(110,100,56,0.6); padding: 1px 6px;',
'}',
'.bmb-journal-note {',
'  padding: 10px 12px; margin-bottom: 6px; cursor: pointer;',
'  border: 1px solid rgba(77,70,40,0.5); background: rgba(16,14,6,0.45);',
'  transition: all .15s ease;',
'}',
'.bmb-journal-note:hover { border-color: #cdbf72; background: rgba(60,52,20,0.35); box-shadow: 0 0 14px rgba(220,200,110,0.15); }',
'.bmb-journal-note-top { display: flex; align-items: center; gap: 10px; min-width: 0; }',
'.bmb-journal-status { width: 12px; flex: none; text-align: center; font-size: 11px; }',
'.bmb-journal-note.unread .bmb-journal-status { color: #ffe98f; text-shadow: 0 0 8px rgba(255,233,143,0.8); animation: bmbJournalPulse 2.4s ease-in-out infinite; }',
'.bmb-journal-note.read .bmb-journal-status { color: #55503a; }',
'.bmb-journal-note-name {',
'  font-size: 14px; letter-spacing: 1.5px; white-space: nowrap;',
'  overflow: hidden; text-overflow: ellipsis; min-width: 0;',
'}',
'.bmb-journal-note.unread .bmb-journal-note-name { color: #efe4ac; }',
'.bmb-journal-note.read .bmb-journal-note-name { color: #94884f; }',
'.bmb-journal-note-meta { margin-top: 4px; padding-left: 22px; font-size: 10px; letter-spacing: 2px; color: #6e6539; }',
'.bmb-journal-empty { text-align: center; margin-top: 60px; letter-spacing: 3px; }',
'.bmb-journal-empty p { font-size: 13px; color: #c9bd85; margin: 6px 0; }',
'.bmb-journal-empty p.dim { font-size: 11px; color: #6e6539; font-style: italic; }',
'.bmb-journal-reader {',
'  position: fixed; inset: 0; z-index: 48; display: none;',
'  align-items: center; justify-content: center;',
'  background: rgba(4,4,2,0.72); pointer-events: auto;',
'}',
'.bmb-journal-paper {',
'  width: min(560px, 86vw); max-height: 80vh; overflow-y: auto;',
'  background: linear-gradient(175deg, #d8d0b4, #c9c09e); color: #3a3222;',
'  padding: 30px 34px 22px; transform: rotate(-1.4deg);',
'  box-shadow: 0 18px 60px rgba(0,0,0,0.75);',
'  scrollbar-width: thin;',
'}',
'.bmb-journal-paper-title {',
'  font-size: 17px; letter-spacing: 2px; font-weight: bold; margin: 0 0 4px;',
'}',
'.bmb-journal-paper-meta { font-size: 10px; letter-spacing: 2px; color: #6e6444; margin-bottom: 16px; border-bottom: 1px solid rgba(110,100,68,0.4); padding-bottom: 10px; }',
'.bmb-journal-paper p { font-size: 15px; line-height: 1.8; letter-spacing: 0.4px; margin: 0 0 14px; white-space: pre-wrap; }',
'.bmb-journal-paper-close { display: block; text-align: right; color: #6e6444; font-size: 10px; letter-spacing: 2px; }',
].join('\n');


