/**
 * F46 Expedition ledger — cross-run meta-archive of discovered notes and
 * completed clusters.
 *
 * The ledger outlives individual expeditions: each run records the note
 * ids it found and clusters it completed under its expedition id, and any
 * future run can query prior-run summaries (counts, firsts, rarest). The
 * model is pure; persistence goes through an injected storage pair
 * { get, set } (localStorage-like, same idiom as ui/dailyrite), so tests
 * and callers can back it with anything.
 *
 * Merge semantics are idempotent per (expeditionId, entryId): re-merging
 * an entry an expedition already recorded is a structural no-op with
 * first-write-wins on conflicting content. A storage-version guard turns
 * foreign payloads into a documented result object instead of a throw —
 * a corrupt or future-version archive must never take the game down.
 */

/** Current ledger payload version; bumps invalidate foreign archives. */
export const LEDGER_VERSION = 1;

/** Injected-storage key the ledger is persisted under. */
export const LEDGER_STORAGE_KEY = 'bmb-expedition-ledger';

/** One discovered item within one expedition. */
export interface LedgerEntry {
  /** Unique within its expedition; merge identity key. */
  entryId: string;
  /** 'note' = journal note found; 'cluster' = landmark cluster completed. */
  kind: 'note' | 'cluster';
  /** Content id of the note, or cluster id when kind is 'cluster'. */
  refId: string;
  /** Rarity 0=common .. 3=unique; higher is rarer. */
  rarity: number;
  /** Discovery timestamp (ms epoch); optional for older records. */
  discoveredAt?: number;
}

/** The full cross-run archive. */
export interface LedgerData {
  version: number;
  /** Entries per expedition id, in first-recorded order. */
  expeditions: Record<string, LedgerEntry[]>;
}

/** Minimal persistence surface injected into the ledger. */
export interface LedgerStorageLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/**
 * Why loadLedger rejected (or skipped) a payload.
 * - 'missing': no stored value under LEDGER_STORAGE_KEY yet.
 * - 'unparseable': stored value is not a JSON object (corrupt string etc).
 * - 'foreign-version': valid archive written by another LEDGER_VERSION.
 * - 'malformed': right version but entries/expeditions fail validation.
 */
export type LedgerLoadFailureReason =
  | 'missing'
  | 'unparseable'
  | 'foreign-version'
  | 'malformed';

export type LedgerLoadResult =
  | { ok: true; ledger: LedgerData }
  | { ok: false; reason: LedgerLoadFailureReason };

/** Fresh empty archive. */
export function createLedger(): LedgerData {
  return { version: LEDGER_VERSION, expeditions: {} };
}

function isValidEntry(e: unknown): e is LedgerEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const v = e as Partial<LedgerEntry>;
  return (
    typeof v.entryId === 'string' &&
    typeof v.refId === 'string' &&
    (v.kind === 'note' || v.kind === 'cluster') &&
    typeof v.rarity === 'number' &&
    Number.isFinite(v.rarity) &&
    (v.discoveredAt === undefined || typeof v.discoveredAt === 'number')
  );
}

/**
 * Structural validation for payloads claiming to be a ledger.
 * @returns The validated archive, or null when malformed.
 */
export function validateLedger(val: unknown): LedgerData | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const v = val as Partial<LedgerData>;
  if (v.version !== LEDGER_VERSION) return null;
  if (!v.expeditions || typeof v.expeditions !== 'object' ||
      Array.isArray(v.expeditions)) return null;
  for (const list of Object.values(v.expeditions)) {
    if (!Array.isArray(list) || !list.every(isValidEntry)) return null;
  }
  return { version: LEDGER_VERSION, expeditions: v.expeditions };
}

/** Parse a stored raw value into a load result; never throws. */
function parseStored(raw: unknown): LedgerLoadResult {
  let val: unknown = raw;
  if (typeof raw === 'string') {
    try {
      val = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'unparseable' };
    }
  }
  if (!val || typeof val !== 'object') return { ok: false, reason: 'unparseable' };
  const version = (val as { version?: unknown }).version;
  if (version !== LEDGER_VERSION) return { ok: false, reason: 'foreign-version' };
  const ledger = validateLedger(val);
  if (!ledger) return { ok: false, reason: 'malformed' };
  return { ok: true, ledger };
}

/**
 * Load the archive from injected storage.
 * @returns The validated ledger, or a documented failure reason. Never
 *   throws: corrupt, foreign or missing archives degrade to `ok:false`.
 */
export function loadLedger(storage: LedgerStorageLike): LedgerLoadResult {
  let raw: unknown;
  try {
    raw = storage.get(LEDGER_STORAGE_KEY);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (raw === undefined || raw === null) return { ok: false, reason: 'missing' };
  return parseStored(raw);
}

/**
 * Persist the archive through injected storage.
 * @throws Propagates storage.set failures — writes must fail loud.
 */
export function saveLedger(storage: LedgerStorageLike, ledger: LedgerData): void {
  // Deep-clone so later mutation of caller state cannot alias storage.
  storage.set(LEDGER_STORAGE_KEY, JSON.parse(JSON.stringify(ledger)));
}

/**
 * Merge entries for one expedition into a NEW archive (input untouched).
 * Entries whose entryId already exists in that expedition are skipped,
 * so merging the same expedition twice is structurally identical to
 * merging once; conflicting duplicates keep the first-recorded version.
 * @param ledger Archive to fold into.
 * @param expeditionId Run the entries belong to.
 * @param entries Discovered items in discovery order; appended after any
 *   already-recorded entries of this expedition.
 */
export function mergeExpedition(
  ledger: LedgerData,
  expeditionId: string,
  entries: readonly LedgerEntry[],
): LedgerData {
  const next: LedgerData = {
    version: LEDGER_VERSION,
    expeditions: JSON.parse(JSON.stringify(ledger.expeditions)),
  };
  const existing = next.expeditions[expeditionId] ?? [];
  const seen = new Set(existing.map((e) => e.entryId));
  for (const entry of entries) {
    if (seen.has(entry.entryId)) continue;
    seen.add(entry.entryId);
    existing.push({ ...entry });
  }
  next.expeditions[expeditionId] = existing;
  return next;
}

/** Cross-run summary of everything the archive remembers. */
export interface LedgerSummary {
  /** Expeditions with at least one recorded entry. */
  expeditionCount: number;
  /** Unique discovered notes across all runs. */
  noteCount: number;
  /** Completed clusters across all runs. */
  clusterCount: number;
  /** Total recorded entries. */
  totalEntries: number;
  /** Earliest-discovered entry; ties break by expedition then entryId. */
  firstDiscovery: LedgerEntry | null;
  /** Rarest note (max rarity); ties break like firstDiscovery. */
  rarestNote: LedgerEntry | null;
  /** Rarest completed cluster (max rarity); ties break likewise. */
  rarestCluster: LedgerEntry | null;
}

function pickBy(
  entries: readonly LedgerEntry[],
  better: (candidate: LedgerEntry, best: LedgerEntry) => boolean,
): LedgerEntry | null {
  let best: LedgerEntry | null = null;
  for (const e of entries) {
    if (!best || better(e, best)) best = e;
  }
  return best;
}

/** Deterministic tie-break: earlier expeditionId, then earlier entryId. */
function earlierId(a: LedgerEntry, b: LedgerEntry): boolean {
  return a.entryId < b.entryId;
}

/**
 * Summarize the archive for prior-run queries. Pure function of the
 * archive contents; deterministic tie-breaks keep replays identical.
 */
export function summarize(ledger: LedgerData): LedgerSummary {
  const all: LedgerEntry[] = [];
  const notes: LedgerEntry[] = [];
  const clusters: LedgerEntry[] = [];
  for (const id of Object.keys(ledger.expeditions).sort()) {
    const list = ledger.expeditions[id];
    if (!Array.isArray(list) || list.length === 0) continue;
    all.push(...list);
    for (const e of list) (e.kind === 'note' ? notes : clusters).push(e);
  }
  const byRarityThenEarlier = (a: LedgerEntry, b: LedgerEntry): boolean =>
    a.rarity > b.rarity || (a.rarity === b.rarity && earlierId(a, b));
  return {
    expeditionCount: Object.keys(ledger.expeditions)
      .filter((id) => (ledger.expeditions[id]?.length ?? 0) > 0)
      .length,
    noteCount: notes.length,
    clusterCount: clusters.length,
    totalEntries: all.length,
    firstDiscovery: pickBy(all, (a, b) =>
      (a.discoveredAt ?? Infinity) < (b.discoveredAt ?? Infinity) ||
      ((a.discoveredAt ?? Infinity) === (b.discoveredAt ?? Infinity) &&
        earlierId(a, b)),
    ),
    rarestNote: pickBy(notes, byRarityThenEarlier),
    rarestCluster: pickBy(clusters, byRarityThenEarlier),
  };
}
