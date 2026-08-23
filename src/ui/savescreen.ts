/**
 * Save slot browser for BACKROOMS: MEMORY BLEED.
 *
 * Fullscreen overlay opened from the title screen. Lists every available
 * save entry - named checkpoints, the auto-save, and the auto-backup - in
 * a scrollable column with name, monospace timestamp, discovery count,
 * and playtime per row.
 *
 * Per-slot actions: LOAD (primary), DELETE (two-press confirm), EXPORT
 * (downloads the checkpoint as JSON). IMPORT picks up a .json checkpoint
 * file, validates it against the core SaveSlot contract, and only offers
 * it to the host when it parses cleanly.
 *
 * Standalone module owning its own DOM subtree and styles, like
 * gallery.ts/tracker.ts. Keyboard navigable: arrows move the selection,
 * Enter loads, D deletes (press again to confirm), E exports, ESC closes.
 */
import type { SaveSlot } from '../save/db';

/** One browsable save entry as handed to the screen by the host. */
export interface SlotInfo {
  /** Stable slot identifier, e.g. 'auto', 'auto-backup', 'checkpoint-3'. */
  name: string;
  /** When the entry was written (epoch ms). */
  timestamp: number;
  /** Story discoveries recorded at save time. */
  discoveries: number;
  /** Total play time in seconds. */
  playtimeSec: number;
  /**
   * Optional full checkpoint payload. When present, EXPORT serializes
   * this; otherwise the SlotInfo summary itself is downloaded.
   */
  data?: unknown;
}

/** Host callbacks invoked by user interaction. */
export interface SaveScreenActions {
  /** Player confirmed loading this slot. */
  onLoad(slot: SlotInfo): void;
  /** Player confirmed deletion of the named slot. */
  onDelete(name: string): void;
  /** A picked file passed validation and is offered for import. */
  onImport(file: File): void;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Local-time timestamp rendered for the meta line (monospace friendly). */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}

/** Playtime as H:MM:SS. */
export function formatPlaytime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

export type CheckpointValidation =
  | { ok: true; slot: SaveSlot }
  | { ok: false; reason: string };

/**
 * Validate an arbitrary parsed value against the core SaveSlot contract -
 * same required-field rules as db.ts's migrateSlot (numeric seed/px/pz).
 * Used to gate imported files before they reach the host.
 */
export function validateCheckpoint(raw: unknown): CheckpointValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not a checkpoint object' };
  }
  const s = raw as Partial<SaveSlot> & Record<string, unknown>;
  if (typeof s.seed !== 'number' || !Number.isFinite(s.seed)) {
    return { ok: false, reason: 'missing numeric seed' };
  }
  if (typeof s.px !== 'number' || !Number.isFinite(s.px)) {
    return { ok: false, reason: 'missing numeric px' };
  }
  if (typeof s.pz !== 'number' || !Number.isFinite(s.pz)) {
    return { ok: false, reason: 'missing numeric pz' };
  }
  return { ok: true, slot: raw as SaveSlot };
}

/** Validate a picked file by reading its text. */
export async function validateCheckpointFile(file: File): Promise<CheckpointValidation> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, reason: 'unreadable file' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable JSON' };
  }
  return validateCheckpoint(parsed);
}

/** Serialize a slot for the EXPORT download. */
export function slotExportJson(slot: SlotInfo): string {
  return JSON.stringify(slot.data ?? slot, null, 2);
}

/** Filename for an exported checkpoint. */
export function exportFileName(slot: SlotInfo): string {
  const stamp = new Date(slot.timestamp || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const slug = slot.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'slot';
  return 'backrooms-' + slug + '-' + stamp + '.json';
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const OVERLAY_STYLE =
  'position:absolute;inset:0;display:none;flex-direction:column;' +
  'align-items:center;justify-content:center;background:rgba(4,4,6,0.92);' +
  "font-family:'Courier New',Courier,monospace;color:#cdbf72;z-index:60;";
const PANEL_STYLE =
  'width:min(720px,90%);max-height:82%;display:flex;flex-direction:column;' +
  'border:1px solid #6e6438;background:#0a0a0c;padding:18px 22px;box-sizing:border-box;';
const TITLE_STYLE =
  "font-family:'Courier New',Courier,monospace;font-size:15px;letter-spacing:3px;" +
  'color:#ff7d68;margin-bottom:10px;text-align:left;';
const LIST_STYLE =
  'flex:1 1 auto;overflow-y:auto;min-height:120px;border-top:1px solid #2a2a20;' +
  'border-bottom:1px solid #2a2a20;';
const ROW_STYLE =
  'display:flex;align-items:center;justify-content:space-between;gap:10px;' +
  'padding:8px;border-bottom:1px solid #1a1a14;color:#8f8354;';
const ROW_SELECTED_STYLE =
  ROW_STYLE +
  'background:#14120c;color:#cdbf72;outline:1px solid #6e6438;';
const INFO_STYLE = 'min-width:0;flex:1 1 auto;';
const NAME_STYLE =
  "font-family:'Courier New',Courier,monospace;font-size:13px;letter-spacing:2px;" +
  'color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
  'text-align:left;background:none;border:none;padding:0;';
const META_STYLE =
  "font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:1px;" +
  'color:#6e6438;margin-top:2px;white-space:nowrap;text-align:left;background:none;border:none;padding:0;';
const ACTIONS_STYLE = 'display:flex;gap:6px;flex:none;';
const BTN_BASE =
  "font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:2px;" +
  'padding:5px 10px;border:1px solid #6e6438;background:transparent;color:#8f8354;cursor:pointer;';
const BTN_LOAD = BTN_BASE + 'color:#ffb347;border-color:#b09a55;';
const BTN_DELETE = BTN_BASE;
const BTN_DELETE_ARMED = BTN_BASE + 'color:#d84848;border-color:#d84848;';
const BTN_EXPORT = BTN_BASE;
const FOOTER_STYLE =
  'display:flex;justify-content:space-between;gap:10px;margin-top:10px;align-items:center;';
const HINT_STYLE =
  "font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:2px;color:#6e6438;";
const STATUS_STYLE =
  "font-family:'Courier New',Courier,monospace;font-size:11px;letter-spacing:1px;" +
  'color:#d84848;min-height:14px;margin-top:8px;text-align:left;';

/* ------------------------------------------------------------------ */
/* SaveScreen                                                          */
/* ------------------------------------------------------------------ */

export class SaveScreen {
  private container: HTMLElement;
  private actions: SaveScreenActions;

  private root: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;

  private slots: SlotInfo[] = [];
  private selected = 0;
  /** Index of the row whose DELETE button is armed for confirmation. */
  private armedDelete = -1;
  private _isOpen = false;

  constructor(container: HTMLElement, actions: SaveScreenActions) {
    this.container = container;
    this.actions = actions;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKey);
    }
  }

  /** True while the overlay is visible. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /* ------------------------- public API --------------------------- */

  /** Populate and open the browser with the given entries. */
  show(slots: SlotInfo[]): void {
    this.slots = Array.isArray(slots) ? slots.slice() : [];
    // Newest first for browsing.
    this.slots.sort((a, b) => b.timestamp - a.timestamp);
    this.selected = this.slots.length > 0 ? Math.min(this.selected, this.slots.length - 1) : 0;
    this.armedDelete = -1;
    this.ensureOverlay();
    this.render();
    if (this.root) this.root.style.display = 'flex';
    this._isOpen = true;
    this.setStatus('');
  }

  /** Close the overlay. */
  hide(): void {
    this.armedDelete = -1;
    if (this.root) this.root.style.display = 'none';
    this._isOpen = false;
  }

  /** Toggle visibility. */
  toggle(slots?: SlotInfo[]): void {
    if (this._isOpen) this.hide();
    else this.show(slots ?? this.slots);
  }

  /** Release listeners and DOM. */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKey);
    }
    if (this.fileInput) {
      this.fileInput.parentElement?.removeChild(this.fileInput);
      this.fileInput = null;
    }
    this.root?.parentElement?.removeChild(this.root);
    this.root = null;
    this.listEl = null;
    this.statusEl = null;
    this._isOpen = false;
  }

  /**
   * Import path shared by the hidden file picker and tests: validates the
   * file first; on success hands it to the host, otherwise surfaces the
   * rejection reason in the status line and calls nothing.
   */
  async ingestFile(file: File): Promise<boolean> {
    const verdict = await validateCheckpointFile(file);
    if (!verdict.ok) {
      this.setStatus('IMPORT REJECTED // ' + file.name + ': ' + verdict.reason);
      return false;
    }
    this.setStatus('CHECKPOINT VALID // ' + file.name);
    this.actions.onImport(file);
    return true;
  }

  /* -------------------------- internals --------------------------- */

  private setStatus(msg: string): void {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  private ensureOverlay(): void {
    if (this.root) return;

    const root = document.createElement('div');
    root.className = 'bmb-savescreen';
    root.setAttribute('style', OVERLAY_STYLE);

    const panel = document.createElement('div');
    panel.className = 'bmb-savescreen-panel';
    panel.setAttribute('style', PANEL_STYLE);

    const title = document.createElement('div');
    title.className = 'bmb-savescreen-title';
    title.textContent = '// MEMORY LEDGER';
    title.setAttribute('style', TITLE_STYLE);

    const list = document.createElement('div');
    list.className = 'bmb-savescreen-list';
    list.setAttribute('style', LIST_STYLE);

    const footer = document.createElement('div');
    footer.className = 'bmb-savescreen-footer';
    footer.setAttribute('style', FOOTER_STYLE);

    const importBtn = document.createElement('button');
    importBtn.className = 'bmb-savescreen-import';
    importBtn.textContent = 'IMPORT';
    importBtn.setAttribute('style', BTN_EXPORT);
    importBtn.addEventListener('click', () => {
      this.ensureFileInput().click();
    });
    footer.appendChild(importBtn);

    const hint = document.createElement('div');
    hint.className = 'bmb-savescreen-hint';
    hint.textContent = '[\u2191\u2193] select   [ENTER] load   [D] delete x2   [E] export   [ESC] close';
    hint.setAttribute('style', HINT_STYLE);
    footer.appendChild(hint);

    const status = document.createElement('div');
    status.className = 'bmb-savescreen-status';
    status.setAttribute('style', STATUS_STYLE);

    panel.appendChild(title);
    panel.appendChild(list);
    panel.appendChild(footer);
    panel.appendChild(status);
    root.appendChild(panel);
    this.container.appendChild(root);

    this.root = root;
    this.listEl = list;
    this.statusEl = status;
  }

  private ensureFileInput(): HTMLInputElement {
    if (this.fileInput) return this.fileInput;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.setAttribute('style', 'display:none;');
    input.addEventListener('change', () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      void this.ingestFile(files[0]);
      // Allow re-picking the same file later.
      input.value = '';
    });
    if (this.root && this.root.parentElement) {
      this.root.parentElement.appendChild(input);
    } else if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(input);
    }
    this.fileInput = input;
    return input;
  }

  private render(): void {
    const list = this.listEl;
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (this.slots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bmb-savescreen-empty';
      empty.textContent = 'no recoverable memories found // the dark keeps nothing';
      empty.setAttribute('style', HINT_STYLE + 'padding:20px;');
      list.appendChild(empty);
      return;
    }

    this.slots.forEach((slot, i) => {
      list.appendChild(this.renderRow(slot, i === this.selected));
    });

    const selectedRow = list.children[this.selected];
    if (selectedRow && typeof (selectedRow as HTMLElement).scrollIntoView === 'function') {
      (selectedRow as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  private renderRow(slot: SlotInfo, isSelected: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bmb-savescreen-row';
    row.setAttribute('style', isSelected ? ROW_SELECTED_STYLE : ROW_STYLE);

    const info = document.createElement('div');
    info.className = 'bmb-savescreen-row-info';
    info.setAttribute('style', INFO_STYLE);

    const name = document.createElement('div');
    name.className = 'bmb-savescreen-row-name';
    name.textContent = slot.name.toUpperCase();
    name.setAttribute('style', NAME_STYLE);
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'bmb-savescreen-row-meta';
    meta.textContent =
      formatTimestamp(slot.timestamp) +
      ' \u00b7 discoveries ' +
      String(slot.discoveries ?? 0) +
      ' \u00b7 ' +
      formatPlaytime(slot.playtimeSec ?? 0);
    meta.setAttribute('style', META_STYLE);
    info.appendChild(meta);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'bmb-savescreen-row-actions';
    actions.setAttribute('style', ACTIONS_STYLE);

    const idx = this.indexOfName(slot.name);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'bmb-savescreen-load';
    loadBtn.textContent = 'LOAD';
    loadBtn.setAttribute('style', isSelected ? BTN_LOAD : BTN_BASE);
    loadBtn.addEventListener('click', () => this.doLoad(slot));
    actions.appendChild(loadBtn);

    const armed = idx >= 0 && idx === this.armedDelete;
    const delBtn = document.createElement('button');
    delBtn.className = 'bmb-savescreen-delete';
    delBtn.textContent = armed ? 'CONFIRM?' : 'DELETE';
    delBtn.setAttribute('style', armed ? BTN_DELETE_ARMED : BTN_DELETE);
    delBtn.addEventListener('click', () => this.doDelete(idx));
    actions.appendChild(delBtn);

    const expBtn = document.createElement('button');
    expBtn.className = 'bmb-savescreen-export';
    expBtn.textContent = 'EXPORT';
    expBtn.setAttribute('style', BTN_EXPORT);
    expBtn.addEventListener('click', () => this.doExport(slot));
    actions.appendChild(expBtn);

    row.appendChild(actions);
    return row;
  }

  private indexOfName(name: string): number {
    return this.slots.findIndex((s) => s.name === name);
  }

  private doLoad(slot: SlotInfo): void {
    this.hide();
    this.actions.onLoad(slot);
  }

  private doDelete(index: number): void {
    if (index < 0 || index >= this.slots.length) return;
    if (this.armedDelete !== index) {
      // First press arms the confirm state.
      this.armedDelete = index;
      this.render();
      this.setStatus('PRESS DELETE AGAIN TO ERASE // ' + this.slots[index].name);
      return;
    }
    const name = this.slots[index].name;
    this.armedDelete = -1;
    this.setStatus('ERASED // ' + name);
    this.actions.onDelete(name);
  }

  private doExport(slot: SlotInfo): void {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    const blob = new Blob([slotExportJson(slot)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(slot);
    if (document.body) document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 5000);
    this.setStatus('EXPORTED // ' + exportFileName(slot));
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this._isOpen) return;
    const k = e.key ?? '';
    switch (k) {
      case 'Escape':
        e.preventDefault?.();
        this.hide();
        break;
      case 'ArrowDown':
        e.preventDefault?.();
        this.move(1);
        break;
      case 'ArrowUp':
        e.preventDefault?.();
        this.move(-1);
        break;
      case 'Enter': {
        e.preventDefault?.();
        const slot = this.slots[this.selected];
        if (slot) this.doLoad(slot);
        break;
      }
      case 'Delete':
      case 'Backspace':
      case 'd':
      case 'D': {
        e.preventDefault?.();
        this.doDelete(this.selected);
        break;
      }
      case 'e':
      case 'E': {
        const slot = this.slots[this.selected];
        if (slot) this.doExport(slot);
        break;
      }
      default:
        break;
    }
  };

  private move(delta: number): void {
    if (this.slots.length === 0) return;
    const next = (this.selected + delta + this.slots.length) % this.slots.length;
    if (next === this.selected) return;
    this.selected = next;


    this.armedDelete = -1;
    this.setStatus('');
    this.render();
  }
}



