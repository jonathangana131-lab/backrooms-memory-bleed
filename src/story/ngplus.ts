/**
 * New Game+ (F45): the place remembers — prior-run graffiti appears in
 * fresh runs.
 *
 * Pure model over an INJECTED storage pair { get, set } (localStorage-like,
 * same idiom as save/ledger). A finished run archives its graffiti through
 * archiveGraffiti(); a fresh run calls newRun(seed, runId), which surfaces
 * up to NGPLUS_GHOSTS_PER_RUN archived entries as ghost-markings tagged
 * with provenance {priorRunId, contentHash} so the world shows scars of
 * expeditions that are already over.
 *
 * Import semantics:
 *  - Idempotent per run id: every ghost imported into run R records its
 *    source run in the imported ledger, so re-running newRun for R never
 *    duplicates or re-surfaces the same graffiti.
 *  - Deterministic per (seed, runId): which archived entries surface is
 *    drawn from src/core/rng.ts hashes of exactly those two values.
 *  - A corrupt, foreign-version, or missing archive degrades to an empty
 *    import — never a throw. Storage writes fail loud (same policy as
 *    save/ledger).
 */
import { RNG, hash2i, seedFromString } from '../core/rng';

/** Current New Game+ payload version; bumps invalidate foreign archives. */
export const NGPLUS_VERSION = 1;

/** Injected-storage key holding the cross-run graffiti archive. */
export const NGPLUS_ARCHIVE_KEY = 'bmb-ngplus-archive';

/** Injected-storage key holding per-run already-imported source runs. */
export const NGPLUS_IMPORTED_KEY = 'bmb-ngplus-imported';

/** Maximum ghost-markings surfaced into one new run. */
export const NGPLUS_GHOSTS_PER_RUN = 5;

/** Salt isolating New Game+ draws from every other hash use. */
const NGPLUS_SALT = 0x4e47;

/** One graffiti entry archived by a finished run. */
export interface ArchivedGraffiti {
  /** Run that left the marking; import identity key together with entryId. */
  runId: string;
  /** Unique within its run; import identity key together with runId. */
  entryId: string;
  /** Chunk the marking lives in ('cx,cz', same format as ChunkDeltas.key). */
  chunkKey: string;
  /** What was written on the wall. */
  content: string;
}

/** The full cross-run archive. */
export interface NgPlusArchive {
  version: number;
  /** Archived graffiti in first-archived order. */
  graffiti: ArchivedGraffiti[];
}

/**
 * Where a ghost marking came from; carried on every surfaced marking so
 * consumers can verify and display its history.
 */
export interface GhostProvenance {
  /** Run whose wall this writing originally haunted. */
  priorRunId: string;
  /** Hash of the archived content at import time (see contentHashOf). */
  contentHash: number;
}

/** A prior-run graffiti resurfaced into a fresh run. */
export interface GhostMarking {
  /** Stable derived id ('ngplus-<hex>'); unique within the importing run. */
  id: string;
  /** Chunk the ghost appears in. */
  chunkKey: string;
  /** Ghosts are always graffiti — only graffiti is archived. */
  kind: 'graffiti';
  /** The original writing. */
  content: string;
  /** Prior-run origin record. */
  provenance: GhostProvenance;
}

/** Minimal persistence surface injected into New Game+. */
export interface NgPlusStorageLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Already-imported source runs per importing run id. */
export interface NgPlusImportedRecord {
  version: number;
  /** Map of runId -> source run ids whose ghosts it already received. */
  imported: Record<string, string[]>;
}

/** Deterministic content hash carried in ghost provenance (FNV-1a, rng.ts). */
export function contentHashOf(content: string): number {
  return seedFromString(content);
}

function isValidEntry(e: unknown): e is ArchivedGraffiti {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const v = e as Partial<ArchivedGraffiti>;
  return (
    typeof v.runId === 'string' && v.runId.length > 0 &&
    typeof v.entryId === 'string' && v.entryId.length > 0 &&
    typeof v.chunkKey === 'string' &&
    typeof v.content === 'string'
  );
}

/**
 * Structural validation for payloads claiming to be an archive.
 * @returns The validated archive, or null when malformed.
 */
export function validateArchive(val: unknown): NgPlusArchive | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const v = val as Partial<NgPlusArchive>;
  if (v.version !== NGPLUS_VERSION) return null;
  if (!Array.isArray(v.graffiti) || !v.graffiti.every(isValidEntry)) return null;
  return { version: NGPLUS_VERSION, graffiti: v.graffiti.map((g) => ({ ...g })) };
}

function isValidImportedRecord(val: unknown): val is NgPlusImportedRecord {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const v = val as Partial<NgPlusImportedRecord>;
  if (v.version !== NGPLUS_VERSION) return false;
  if (!v.imported || typeof v.imported !== 'object' || Array.isArray(v.imported)) return false;
  return Object.values(v.imported).every(
    (list) => Array.isArray(list) && list.every((id) => typeof id === 'string'),
  );
}

/**
 * Load the archive from injected storage.
 * @returns The validated archive, or null for missing/corrupt/foreign
 *   payloads — callers treat null as "nothing to remember". Never throws on
 *   payload problems; a throwing storage.get also degrades to null.
 */
export function loadArchive(storage: NgPlusStorageLike): NgPlusArchive | null {
  let raw: unknown;
  try {
    raw = storage.get(NGPLUS_ARCHIVE_KEY);
  } catch {
    return null; // unreadable storage remembers nothing; the run must go on
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return validateArchive(raw);
}

/**
 * Archive graffiti from a finished run into injected storage. Entries whose
 * (runId, entryId) already exist keep the first-archived version, so
 * archiving one run twice is a structural no-op. A corrupt existing archive
 * is replaced by a fresh valid one rather than preserved.
 * @throws Propagates storage.set failures — writes must fail loud.
 */
export function archiveGraffiti(
  storage: NgPlusStorageLike,
  runId: string,
  entries: readonly Omit<ArchivedGraffiti, 'runId'>[],
): void {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('archiveGraffiti: runId must be a non-empty string');
  }
  const current = loadArchive(storage);
  const graffiti: ArchivedGraffiti[] = current ? current.graffiti : [];
  const seen = new Set(graffiti.map((g) => g.runId + '\u0000' + g.entryId));
  for (const e of entries ?? []) {
    const candidate = { ...e, runId };
    if (!isValidEntry(candidate)) continue;
    const key = candidate.runId + '\u0000' + candidate.entryId;
    if (seen.has(key)) continue;
    seen.add(key);
    graffiti.push(candidate);
  }
  // Deep-clone so later mutation of caller state cannot alias storage.
  storage.set(NGPLUS_ARCHIVE_KEY, JSON.parse(JSON.stringify({
    version: NGPLUS_VERSION,
    graffiti,
  })));
}

function loadImported(storage: NgPlusStorageLike): NgPlusImportedRecord {
  let raw: unknown;
  try {
    raw = storage.get(NGPLUS_IMPORTED_KEY);
  } catch {
    raw = undefined;
  }
  if (isValidImportedRecord(raw)) {
    return { version: NGPLUS_VERSION, imported: JSON.parse(JSON.stringify(raw.imported)) };
  }
  return { version: NGPLUS_VERSION, imported: {} };
}

/**
 * Begin a new run: surface prior-run graffiti as ghost-markings.
 *
 * Deterministic function of (seed, runId) plus the archive contents: picks
 * up to NGPLUS_GHOSTS_PER_RUN not-yet-imported entries via rng.ts draws,
 * tags each with {priorRunId, contentHash}, and records the source runs as
 * imported so calling again for this runId yields [] (double-import no-op).
 * Missing, corrupt, foreign, or unreadable archives yield [] without
 * throwing and without touching the imported ledger.
 * @returns Ghost markings in deterministic selection order.
 * @throws Propagates storage.set failures when recording the import.
 */
export function newRun(
  storage: NgPlusStorageLike,
  seed: number,
  runId: string,
): GhostMarking[] {
  if (typeof runId !== 'string' || runId.length === 0 ||
      !Number.isFinite(seed)) {
    return [];
  }
  const archive = loadArchive(storage);
  if (!archive || archive.graffiti.length === 0) return [];

  const imported = loadImported(storage);
  const done = new Set(imported.imported[runId] ?? []);
  const pool = archive.graffiti
    .filter((g) => !done.has(g.runId))
    .sort((a, b) =>
      a.runId !== b.runId
        ? a.runId < b.runId ? -1 : 1
        : a.entryId < b.entryId ? -1 : 1,
    );
  if (pool.length === 0) return [];

  // Partial Fisher-Yates over the ordered pool: selection depends only on
  // (seed, runId) and the pool, so replays are identical.
  const rr = new RNG(hash2i(seedFromString(runId), seed >>> 0, NGPLUS_SALT));
  const count = Math.min(NGPLUS_GHOSTS_PER_RUN, pool.length);
  const chosen: ArchivedGraffiti[] = [];
  for (let i = 0; i < count; i++) {
    const j = i + rr.int(0, pool.length - i);
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
    chosen.push(pool[i]);
  }

  const usedIds = new Set<string>();
  const ghosts = chosen.map((g) => {
    let id = 'ngplus-' +
      hash2i(seedFromString(g.runId + '/' + g.entryId), seed >>> 0, NGPLUS_SALT)
        .toString(16);
    while (usedIds.has(id)) id += 'x'; // hash collision guard; vanishingly rare
    usedIds.add(id);
    return {
      id,
      chunkKey: g.chunkKey,
      kind: 'graffiti' as const,
      content: g.content,
      provenance: { priorRunId: g.runId, contentHash: contentHashOf(g.content) },
    };
  });

  const sources = [...new Set(chosen.map((g) => g.runId))];
  imported.imported[runId] = [...(imported.imported[runId] ?? []), ...sources];
  // Deep-clone so later mutation cannot alias storage.
  storage.set(NGPLUS_IMPORTED_KEY, JSON.parse(JSON.stringify(imported)));
  return ghosts;
}
