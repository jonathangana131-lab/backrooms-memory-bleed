/** IndexedDB persistence: save slots, settings — with migration, corruption recovery, quota handling, and auto-backup. */
const DB_NAME = 'bmb';
const DB_VER = 2;

/** Current save-data version (independent of the IndexedDB schema version). */
export const SAVE_VERSION = 2;

export interface SaveSlot {
  seed: number;
  px: number; pz: number; yaw: number;
  playtimeSec: number;
  savedAt: number;
  version: number;
  mem?: unknown;
  weather?: unknown;
  flash?: { has: boolean; on: boolean; battery: number };
  batteriesTaken?: string[];
  /** names of landmark rooms the player has entered at least once */
  landmarksSeen?: string[];
  /** reality-erosion stability at save time */
  stability?: number;
  /** relocations experienced */
  relocations?: number;
  /** true when the Threshold ending has been reached */
  completed?: boolean;
  /** landmark names visited (persisted for NG+) */
  landmarksSeenNG?: string[];
  /** battery keys consumed (persisted for NG+) */
  batteriesTakenNG?: string[];
  /** downsampled movement trail from the previous session (max ~200) */
  pathEcho?: { x: number; z: number }[];
  story?: { stage: number; discoveries: number; found: [number, number, boolean][] };
  /** F26: photographs taken of the Archivist, keyed by run id; the tally
   * drives the next session's reaction tier (see entities/archivist.ts). */
  archivistEncounters?: Record<string, number>;
  /** F32: Custodian night count + removal ledger so erased markings stay
   * gone across sessions (see entities/custodian.ts). */
  custodian?: {
    version: 1;
    nights: number;
    removals: {
      markingId: string; chunkKey: string; kind: string;
      appliedSession: number; nightOrdinal: number; removedAtNightTime: number;
    }[];
  };
  /** F66: prior-session decision sites the Double cites and revisits. */
  choices?: { id: string; kind: string; x: number; z: number }[];
}

export interface SettingsData {
  sensitivity: number;
  volume: number;
  quality: number;
  /** Vertical field of view in degrees (60–110). */
  fov?: number;
}

const AUTO_KEY = 'auto';
const BACKUP_KEY = 'auto-backup';

function warn(msg: string): void {
  console.warn('[save] ' + msg);
}

/**
 * Upgrade a raw persisted value to the current SaveSlot shape.
 * Accepts structured-clone objects or legacy JSON strings.
 * Returns null when the data is unusable (unparseable / missing required fields).
 * Backward compatible: v1 saves load fine and gain v2 defaults.
 */
export function migrateSlot(raw: unknown): SaveSlot | null {
  let val: unknown = raw;
  if (typeof raw === 'string') {
    try {
      val = JSON.parse(raw);
    } catch {
      warn('corrupt slot: unparseable JSON, discarding');
      return null;
    }
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    warn('corrupt slot: not an object, discarding');
    return null;
  }
  const s = val as Partial<SaveSlot> & Record<string, unknown>;
  // Required core fields must be present and numeric.
  if (typeof s.seed !== 'number' || !Number.isFinite(s.seed) ||
      typeof s.px !== 'number' || !Number.isFinite(s.px) ||
      typeof s.pz !== 'number' || !Number.isFinite(s.pz)) {
    warn('corrupt slot: missing required fields (seed/px/pz), discarding');
    return null;
  }
  const arr = (v: unknown, fallback: never[]): unknown[] => Array.isArray(v) ? v : fallback;
  return {
    ...s,
    version: SAVE_VERSION,
    stability: typeof s.stability === 'number' ? s.stability : 1,
    relocations: typeof s.relocations === 'number' ? s.relocations : 0,
    landmarksSeen: arr(s.landmarksSeen, []) as string[],
    pathEcho: arr(s.pathEcho, []) as { x: number; z: number }[],
  } as SaveSlot;
}

function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string } | null | undefined;
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/** Serialized write queue: overlapping saveNow() calls chain instead of racing. */
let writeQueue: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = writeQueue.then(fn, fn);
  writeQueue = p.then(() => undefined, () => undefined);
  return p;
}

interface OpenedDB { db: IDBDatabase; fresh: boolean }

function open(): Promise<OpenedDB> {
  return new Promise((res, rej) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      rej(e); return;
    }
    let fresh = false;
    req.onupgradeneeded = () => {
      fresh = true;
      const db = req.result;
      if (!db.objectStoreNames.contains('slots')) db.createObjectStore('slots');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints');
    };
    req.onsuccess = () => res({ db: req.result, fresh });
    req.onerror = () => rej(req.error);
  });
}

function putOnce(db: IDBDatabase, store: string, key: string, val: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => { res(); };
    tx.onerror = () => { rej(tx.error); };
    tx.onabort = () => { rej(tx.error ?? new DOMException('transaction aborted', 'AbortError')); };
  });
}

/** Key of the oldest slot entry other than `except`, or null when none exists. */
async function oldestSlotKey(db: IDBDatabase, except: string): Promise<string | null> {
  return new Promise((res, rej) => {
    const tx = db.transaction('slots', 'readonly');
    const r = tx.objectStore('slots').getAll();
    const rk = tx.objectStore('slots').getAllKeys();
    let vals: unknown[] = [];
    let keys: IDBValidKey[] = [];
    let failed = false;
    r.onerror = () => { failed = true; rej(r.error); };
    rk.onerror = () => { failed = true; rej(rk.error); };
    r.onsuccess = () => { vals = r.result as unknown[]; maybeDone(); };
    rk.onsuccess = () => { keys = rk.result; maybeDone(); };
    function maybeDone(): void {
      if (failed || vals.length !== keys.length) return;
      let best: string | null = null;
      let bestAt = Infinity;
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i]);
        if (k === except) continue;
        const savedAt = typeof vals[i] === 'object' && vals[i] !== null
          ? ((vals[i] as SaveSlot).savedAt ?? 0)
          : 0;
        if (savedAt < bestAt) { bestAt = savedAt; best = k; }
      }
      res(best);
    }
  });
}

async function putInternal(store: string, key: string, val: unknown): Promise<void> {
  const { db, fresh } = await open();
  try {
    await putOnce(db, store, key, val);
  } catch (err) {
    if (isQuotaError(err)) {
      // Free space by dropping the oldest non-current slot, then retry once.
      try {
        const victim = await oldestSlotKey(db, key);
        if (victim) {
          warn(`quota exceeded: evicting oldest slot '${victim}' and retrying`);
          await new Promise<void>((res, rej) => {
            const tx = db.transaction('slots', 'readwrite');
            tx.objectStore('slots').delete(victim);
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error ?? new Error('evict aborted'));
          });
          await putOnce(db, store, key, val);
          return;
        }
      } catch (retryErr) {
        throw retryErr instanceof Error ? retryErr : new Error(String(retryErr));
      }
    }
    throw err;
  } finally {
    db.close();
  }
}

function put(store: string, key: string, val: unknown): Promise<void> {
  return enqueue(() => putInternal(store, key, val));
}

function getRaw(store: string, key: string): Promise<unknown> {
  return new Promise(async (res, rej) => { // eslint-disable-line no-async-promise-executor
    let db: IDBDatabase;
    try {
      ({ db } = await open());
    } catch (e) {
      rej(e); return;
    }
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) { settled = true; try { db.close(); } catch { /* ignore */ } fn(); }
    };
    try {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => done(() => res(r.result ?? null));
      r.onerror = () => done(() => rej(r.error));
    } catch (e) {
      done(() => rej(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

async function get<T>(store: string, key: string): Promise<T | null> {
  const raw = await getRaw(store, key);
  // Legacy entries may have been stored as JSON strings.
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      warn(`corrupt entry '${key}' in '${store}': unparseable JSON`);
      return null;
    }
  }
  return (raw as T) ?? null;
}

export const SaveDB = {
  /**
   * Write a save slot. Before overwriting 'auto', the existing 'auto'
   * snapshot is copied to 'auto-backup' so a bad write can be undone via
   * restoreBackup(). Quota-exceeded writes evict the oldest non-current
   * slot once and retry.
   */
  async saveGame(slot: SaveSlot): Promise<void> {
    // Snapshot the previous 'auto' into the backup slot (best effort).
    try {
      const prev = await get<SaveSlot>('slots', AUTO_KEY);
      if (prev) await put('slots', BACKUP_KEY, prev);
    } catch (e) {
      warn('backup of current auto slot failed; continuing with save: ' + (e instanceof Error ? e.message : String(e)));
    }
    await put('slots', AUTO_KEY, slot);
  },
  /**
   * Load the auto slot. Corrupt/unparseable entries yield null (with a
   * console warning) rather than throwing; loaded saves are migrated to v2.
   * If this returns null but hasBackup() is true, callers can offer
   * restoreBackup() to recover the previous good snapshot.
   */
  async loadGame(): Promise<SaveSlot | null> {
    try {
      return migrateSlot(await get<unknown>('slots', AUTO_KEY));
    } catch (e) {
      warn('loadGame failed: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  },
  /** Load the pre-overwrite backup of the auto slot (migrated like loadGame). */
  async loadBackup(): Promise<SaveSlot | null> {
    try {
      return migrateSlot(await get<unknown>('slots', BACKUP_KEY));
    } catch (e) {
      warn('loadBackup failed: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  },
  /** True when a restorable backup snapshot exists. */
  async hasBackup(): Promise<boolean> {
    return (await SaveDB.loadBackup()) !== null;
  },
  /** Copy the backup snapshot back over 'auto'; returns the restored slot. */
  async restoreBackup(): Promise<SaveSlot | null> {
    const bak = await SaveDB.loadBackup();
    if (!bak) return null;
    await put('slots', AUTO_KEY, bak);
    return bak;
  },
  hasSave(): Promise<boolean> { return SaveDB.loadGame().then((s) => !!s); },
  saveSettings(s: SettingsData): Promise<void> { return put('kv', 'settings', s); },
  async loadSettings(): Promise<SettingsData | null> {
    try {
      const raw = await get<SettingsData>('kv', 'settings');
      if (!raw || typeof raw !== 'object') return null;
      return raw;
    } catch (e) {
      warn('loadSettings failed: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  },
};


