/**
 * Manual checkpoint system: player-named snapshots in the 'checkpoints'
 * IndexedDB store (alongside 'slots'/'kv'), capped at 10 entries with
 * oldest-first eviction, plus F5 quick-save / F9 quick-load bound to the
 * fixed 'quick-1'..'quick-3' slots.
 *
 * Snapshots reuse the exact SaveSlot schema produced by Game.captureSlot()
 * and are validated/migrated on load through migrateSlot(), so a corrupted
 * entry degrades to `null` instead of poisoning a restore.
 */
import { migrateSlot, type SaveSlot } from '../save/db';

const DB_NAME = 'bmb';
const STORE = 'checkpoints';

/** Maximum number of named manual checkpoints kept at once. */
export const MAX_CHECKPOINTS = 10;
/** Fixed quick-slot keys cycled by F5 and read by F9. */
export const QUICK_SLOTS = ['quick-1', 'quick-2', 'quick-3'] as const;

/** 1–32 chars, alphanumeric + spaces, after trimming outer whitespace. */
const NAME_RE = /^[a-zA-Z0-9]+( [a-zA-Z0-9]+)*$/;

export interface CheckpointInfo {
  name: string;
  savedAt: number;
  discoveries: number;
}

interface CheckpointRecord {
  name: string;
  savedAt: number;
  slot: unknown;
}

function warn(msg: string): void {
  console.warn('[checkpoints] ' + msg);
}

/** Normalize + validate a checkpoint name; returns null when invalid. */
export function validateName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > 32) return null;
  return NAME_RE.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------- storage --

/** Serialized op chain so overlapping calls never race inside one store. */
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeQueue.then(fn, fn);
  writeQueue = p.then(() => undefined, () => undefined);
  return p;
}

interface OpenedDB { db: IDBDatabase; fresh: boolean }

/**
 * Version-tolerant open: probes the current version first, then upgrades by
 * exactly one step only when the 'checkpoints' store is missing. This stays
 * compatible even if another feature bumps the shared schema later.
 */
function open(): Promise<OpenedDB> {
  return new Promise((res, rej) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME); // no version -> never a VersionError
    } catch (e) {
      rej(e);
      return;
    }
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        res({ db, fresh: false });
        return;
      }
      const cur = db.version;
      db.close();
      try {
        const up = indexedDB.open(DB_NAME, cur + 1);
        let created = false;
        up.onupgradeneeded = () => {
          created = true;
          if (!up.result.objectStoreNames.contains(STORE)) up.result.createObjectStore(STORE);
        };
        up.onsuccess = () => res({ db: up.result, fresh: created });
        up.onerror = () => rej(up.error);
        up.onblocked = () => rej(new Error('checkpoint store upgrade blocked'));
      } catch (e) {
        rej(e);
      }
    };
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('database open blocked'));
  });
}

function requestAsPromise<T>(req: IDBRequest<T>, done: () => void): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => { try { done(); } finally { res(req.result); } };
    req.onerror = () => { try { done(); } finally { rej(req.error); } };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const { db } = await open();
  try {
    return await new Promise<T | undefined>((res, rej) => {
      let result: T | undefined;
      let failed = false;
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => { if (!failed) res(result); };
      tx.onerror = () => { failed = true; rej(tx.error); };
      tx.onabort = () => { failed = true; rej(tx.error ?? new DOMException('aborted', 'AbortError')); };
      try {
        const r = fn(tx.objectStore(STORE));
        if (r) requestAsPromise(r as IDBRequest<T>, () => {}).then((v) => { result = v; }, () => {});
      } catch (e) {
        failed = true;
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  } finally {
    db.close();
  }
}

function putRecord(key: string, rec: CheckpointRecord): Promise<void> {
  return enqueue(() => withStore('readwrite', (s) => { s.put(rec, key); }).then(() => undefined));
}

function getRecord(key: string): Promise<CheckpointRecord | null> {
  return enqueue(async () => {
    const raw = await withStore<CheckpointRecord | undefined>('readonly', (s) => s.get(key));
    return raw ?? null;
  });
}

function deleteKey(key: string): Promise<void> {
  return enqueue(() => withStore('readwrite', (s) => { s.delete(key); }).then(() => undefined));
}

/** All non-corrupt records as [key, record] pairs (raw order). */
function allRecords(): Promise<[string, CheckpointRecord][]> {
  return enqueue(async () => {
    const keys = (await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? [];
    const vals = (await withStore<CheckpointRecord[]>('readonly', (s) => s.getAll())) ?? [];
    const out: [string, CheckpointRecord][] = [];
    for (let i = 0; i < keys.length && i < vals.length; i++) {
      out.push([String(keys[i]), vals[i]]);
    }
    return out;
  });
}

function isQuickSlot(key: string): boolean {
  return (QUICK_SLOTS as readonly string[]).includes(key);
}

// -------------------------------------------------------------- validation --

/**
 * Validate one stored record. Returns null for anything unusable — wrong
 * shape, unparseable legacy JSON, or a slot failing migrateSlot() — which
 * callers turn into a safe load failure.
 */
export function validateRecord(raw: unknown): CheckpointRecord | null {
  let val: unknown = raw;
  if (typeof raw === 'string') {
    try {
      val = JSON.parse(raw);
    } catch {
      warn('corrupt checkpoint: unparseable JSON');
      return null;
    }
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    warn('corrupt checkpoint: not an object');
    return null;
  }
  const r = val as Partial<CheckpointRecord> & Record<string, unknown>;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) {
    warn('corrupt checkpoint: missing savedAt');
    return null;
  }
  // The payload must be a full SaveSlot snapshot (same bar as auto-saves).
  const slot = migrateSlot(r.slot);
  if (!slot) {
    warn('corrupt checkpoint: slot fails migration/validation');
    return null;
  }
  return { name: typeof r.name === 'string' ? r.name : '', savedAt: r.savedAt, slot };
}

// ------------------------------------------------------------------ manager --

export interface CheckpointManagerOptions {
  /** Produces the current full-state snapshot (usually Game.captureSlot()). */
  capture?: () => SaveSlot | null;
  /** Applies a loaded snapshot back to the running game. */
  restore?: (slot: SaveSlot) => void | Promise<void>;
}

export class CheckpointManager {
  private readonly capture?: () => SaveSlot | null;
  private readonly restore?: (slot: SaveSlot) => void | Promise<void>;
  private quickIndex = 0; // next quick slot to receive an F5 save
  private keyTarget: EventTarget | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(opts: CheckpointManagerOptions = {}) {
    this.capture = opts.capture;
    this.restore = opts.restore;
  }

  /**
   * Snapshot `state` under `name` (overwrites an existing checkpoint of the
   * same name). Resolves false for invalid names or when storage is
   * unavailable — it never throws for caller-input reasons.
   */
  async createCheckpoint(name: string, state: SaveSlot): Promise<boolean> {
    const clean = validateName(name);
    if (!clean) {
      warn(`rejected checkpoint name ${JSON.stringify(String(name))} (need 1-32 chars, letters/digits/spaces)`);
      return false;
    }
    if (!state || typeof state !== 'object') return false;
    try {
      await putRecord(clean, { name: clean, savedAt: Date.now(), slot: state });
      await this.enforceLimit(clean);
      return true;
    } catch (e) {
      warn(`createCheckpoint('${clean}') failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Load the named checkpoint. Missing or corrupted entries resolve to
   * null (corrupted ones are also removed so they cannot linger).
   */
  async loadCheckpoint(name: string): Promise<SaveSlot | null> {
    try {
      const rec = await getRecord(name);
      if (!rec) return null;
      const ok = validateRecord(rec);
      if (!ok) {
        void deleteKey(name).catch(() => {});
        return null;
      }
      return ok.slot as SaveSlot;
    } catch (e) {
      warn(`loadCheckpoint('${name}') failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * List manual checkpoints (quick slots excluded), newest first.
   * Corrupted entries are skipped and pruned.
   */
  async listCheckpoints(): Promise<CheckpointInfo[]> {
    try {
      const pairs = await allRecords();
      const corrupt: string[] = [];
      const infos: CheckpointInfo[] = [];
      for (const [key, raw] of pairs) {
        if (isQuickSlot(key)) continue;
        const rec = validateRecord(raw);
        if (!rec) {
          corrupt.push(key);
          continue;
        }
        const story = (rec.slot as SaveSlot).story as { discoveries?: number } | undefined;
        infos.push({
          name: rec.name || key,
          savedAt: rec.savedAt,
          discoveries: typeof story?.discoveries === 'number' ? story.discoveries : 0,
        });
      }
      if (corrupt.length > 0) void Promise.all(corrupt.map((k) => deleteKey(k))).catch(() => {});
      infos.sort((a, b) => b.savedAt - a.savedAt);
      return infos;
    } catch (e) {
      warn(`listCheckpoints failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Remove a named checkpoint; true when something was deleted. */
  async deleteCheckpoint(name: string): Promise<boolean> {
    try {
      const existed = (await getRecord(name)) !== null;
      if (existed) await deleteKey(name);
      return existed;
    } catch {
      return false;
    }
  }

  /** Keep at most MAX_CHECKPOINTS named checkpoints; oldest savedAt evicted. */
  private async enforceLimit(except: string): Promise<void> {
    const pairs = (await allRecords()).filter(([k]) => !isQuickSlot(k));
    if (pairs.length <= MAX_CHECKPOINTS) return;
    const sorted = pairs
      .map(([key, raw]) => ({ key, savedAt: validateRecord(raw)?.savedAt ?? 0 }))
      .sort((a, b) => a.savedAt - b.savedAt);
    let excess = sorted.length - MAX_CHECKPOINTS;
    for (const victim of sorted) {
      if (excess <= 0) break;
      if (victim.key === except) continue; // never evict the just-written one
      warn(`evicting oldest checkpoint '${victim.key}'`);
      await deleteKey(victim.key);
      excess--;
    }
  }

  // ------------------------------------------------------------ quick slots --

  /**
   * Quick-save into the next of 'quick-1'..'quick-3' (round-robin). Uses
   * `capture()` when no explicit state is passed. False on failure.
   */
  async quickSave(state?: SaveSlot): Promise<boolean> {
    const slot = state ?? this.capture?.() ?? null;
    if (!slot) {
      warn('quickSave: no state available');
      return false;
    }
    const key = QUICK_SLOTS[this.quickIndex % QUICK_SLOTS.length];
    this.quickIndex = (this.quickIndex + 1) % QUICK_SLOTS.length;
    try {
      await putRecord(key, { name: key, savedAt: Date.now(), slot });
      return true;
    } catch (e) {
      warn(`quickSave failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Load the most recently written quick slot (or null when none/corrupt). */
  async quickLoad(): Promise<SaveSlot | null> {
    try {
      let best: SaveSlot | null = null;
      let bestAt = -1;
      let bestKey = '';
      for (const key of QUICK_SLOTS) {
        const rec = validateRecord(await getRecord(key));
        if (rec && rec.savedAt > bestAt) {
          bestAt = rec.savedAt;
          best = rec.slot as SaveSlot;
          bestKey = key;
        }
      }
      return best;
    } catch (e) {
      warn(`quickLoad failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Key of the newest populated quick slot, or null. */
  async lastQuickSlot(): Promise<string | null> {
    try {
      let best: string | null = null;
      let bestAt = -1;
      for (const key of QUICK_SLOTS) {
        const rec = validateRecord(await getRecord(key));
        if (rec && rec.savedAt > bestAt) {
          bestAt = rec.savedAt;
          best = key;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------- F5/F9 binding --

  /**
   * Bind F5 (quick-save) and F9 (quick-load) keydown handlers. Pass a custom
   * EventTarget in tests; defaults to the global window. F5's default page-
   * reload behavior is suppressed while playing.
   */
  bindQuickKeys(target?: EventTarget): void {
    this.unbindQuickKeys();
    const t = target ?? (globalThis as { window?: EventTarget }).window ?? null;
    if (!t || typeof t.addEventListener !== 'function') return;
    this.keyTarget = t;
    this.keyHandler = (e: KeyboardEvent): void => {
      if (e.code === 'F5') {
        e.preventDefault?.();
        void this.quickSave().then((ok) => {
          if (ok) console.log('[checkpoints] quick-saved (' + QUICK_SLOTS[(this.quickIndex + QUICK_SLOTS.length - 1) % QUICK_SLOTS.length] + ')');
        });
      } else if (e.code === 'F9') {
        e.preventDefault?.();
        void this.quickLoad().then((slot) => {
          if (!slot) return;
          console.log('[checkpoints] quick-loaded');
          void this.restore?.(slot);
        });
      }
    };
    t.addEventListener('keydown', this.keyHandler as EventListener);
  }

  /** Detach any F5/F9 handlers installed by bindQuickKeys(). */
  unbindQuickKeys(): void {
    if (this.keyTarget && this.keyHandler) {
      this.keyTarget.removeEventListener('keydown', this.keyHandler as EventListener);
    }
    this.keyTarget = null;
    this.keyHandler = null;
  }
}


