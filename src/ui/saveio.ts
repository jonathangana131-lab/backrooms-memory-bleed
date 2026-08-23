/**
 * Save import/export data layer for BACKROOMS: MEMORY BLEED.
 *
 * Pure serialization + validation between SaveSlot checkpoints and the
 * portable `bmb-save` JSON envelope used by the savescreen EXPORT /
 * IMPORT flow, plus clipboard read/write helpers with graceful fallbacks.
 *
 * Envelope shape (pretty-printed):
 *   {
 *     "_format": "bmb-save",
 *     "_version": 2,
 *     "exportedAt": "<ISO-8601 timestamp>",
 *     "slot": { ...SaveSlot }
 *   }
 *
 * parseImported() accepts this envelope AND bare SaveSlot JSON (legacy /
 * hand-edited), validates every field's type and range, and returns either
 * a clean SaveSlot or an {error} object with a human-readable message.
 *
 * Round-trip guarantee: exportSlot(slot) -> parseImported() yields a slot
 * deep-equal to the input (tested explicitly in test/saveio-test.mjs).
 */
import type { SaveSlot } from '../save/db';

/** Magic format marker written into every exported checkpoint. */
export const EXPORT_FORMAT = 'bmb-save';

/** Export-envelope schema version (independent of the save-data version). */
export const EXPORT_VERSION = 2;

/** Portable checkpoint wrapper as produced by exportSlot(). */
export interface ExportEnvelope {
  /** Always 'bmb-save'. */
  _format: typeof EXPORT_FORMAT;
  /** Export-schema version; see EXPORT_VERSION. */
  _version: number;
  /** When the export was written (ISO-8601). */
  exportedAt: string;
  /** The checkpoint payload itself. */
  slot: SaveSlot;
}

/** Result of parseImported(): a validated slot, or why it was rejected. */
export type ImportResult = SaveSlot | { error: string };

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Serialize one save slot into the pretty-printed portable envelope. */
export function exportSlot(slot: SaveSlot): string {
  const envelope: ExportEnvelope = {
    _format: EXPORT_FORMAT,
    _version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    slot,
  };
  return JSON.stringify(envelope, null, 2);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v);
}

function strArr(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate one optional field via its guard; `present` short-circuits so
 * absent optional fields never fail. Returns null when acceptable.
 */
function checkOpt(
  name: string,
  v: unknown,
  ok: (val: unknown) => boolean,
  expect: string,
): string | null {
  if (v === undefined) return null;
  return ok(v) ? null : `${name}: expected ${expect}`;
}

/**
 * Validate a raw parsed payload against the full SaveSlot contract:
 * required core numerics, per-field types, and sane ranges. Returns
 * {ok:true, slot} or {ok:false, error} with a descriptive message naming
 * the offending field.
 */
export function validateSlotShape(
  raw: unknown,
): { ok: true; slot: SaveSlot } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'checkpoint: expected a JSON object' };
  const s = raw;

  // Required core fields (same rules as db.ts migrateSlot).
  for (const key of ['seed', 'px', 'pz', 'yaw', 'playtimeSec', 'savedAt'] as const) {
    if (!num(s[key])) return { ok: false, error: `${key}: expected a finite number` };
  }
  if ((s.playtimeSec as number) < 0) {
    return { ok: false, error: 'playtimeSec: expected a non-negative number' };
  }
  if ((s.savedAt as number) < 0) {
    return { ok: false, error: 'savedAt: expected a non-negative epoch timestamp' };
  }

  // Optional scalar fields.
  const err =
    checkOpt('version', s.version, num, 'a finite number') ??
    checkOpt('stability', s.stability, (v) => num(v) && (v as number) >= 0 && (v as number) <= 1, 'a number between 0 and 1') ??
    checkOpt('relocations', s.relocations, (v) => int(v) && (v as number) >= 0, 'a non-negative integer') ??
    checkOpt('completed', s.completed, (v) => typeof v === 'boolean', 'a boolean') ??
    checkOpt('batteriesTaken', s.batteriesTaken, strArr, 'an array of strings') ??
    checkOpt('landmarksSeen', s.landmarksSeen, strArr, 'an array of strings') ??
    checkOpt('landmarksSeenNG', s.landmarksSeenNG, strArr, 'an array of strings') ??
    checkOpt('batteriesTakenNG', s.batteriesTakenNG, strArr, 'an array of strings');
  if (err) return { ok: false, error: err };

  // flash: { has: boolean; on: boolean; battery: number 0..1 }
  if (s.flash !== undefined) {
    if (!isObj(s.flash)) return { ok: false, error: 'flash: expected an object' };
    const f = s.flash;
    if (typeof f.has !== 'boolean') return { ok: false, error: 'flash.has: expected a boolean' };
    if (typeof f.on !== 'boolean') return { ok: false, error: 'flash.on: expected a boolean' };
    if (!num(f.battery) || (f.battery as number) < 0 || (f.battery as number) > 1) {
      return { ok: false, error: 'flash.battery: expected a number between 0 and 1' };
    }
  }

  // pathEcho: { x: number; z: number }[]
  if (s.pathEcho !== undefined) {
    if (!Array.isArray(s.pathEcho)) return { ok: false, error: 'pathEcho: expected an array' };
    for (let i = 0; i < s.pathEcho.length; i++) {
      const p = s.pathEcho[i];
      if (!isObj(p) || !num(p.x) || !num(p.z)) {
        return { ok: false, error: `pathEcho[${i}]: expected { x: number, z: number }` };
      }
    }
  }

  // story: { stage: int>=0; discoveries: int>=0; found: [number,number,boolean][] }
  if (s.story !== undefined) {
    if (!isObj(s.story)) return { ok: false, error: 'story: expected an object' };
    const st = s.story;
    if (!int(st.stage) || (st.stage as number) < 0) {
      return { ok: false, error: 'story.stage: expected a non-negative integer' };
    }
    if (!int(st.discoveries) || (st.discoveries as number) < 0) {
      return { ok: false, error: 'story.discoveries: expected a non-negative integer' };
    }
    if (!Array.isArray(st.found)) return { ok: false, error: 'story.found: expected an array' };
    for (let i = 0; i < st.found.length; i++) {
      const t = st.found[i];
      if (
        !Array.isArray(t) || t.length !== 3 ||
        !num(t[0]) || !num(t[1]) || typeof t[2] !== 'boolean'
      ) {
        return { ok: false, error: `story.found[${i}]: expected [number, number, boolean]` };
      }
    }
  }

  return { ok: true, slot: s as unknown as SaveSlot };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse imported checkpoint text into a validated SaveSlot.
 *
 * Accepts the bmb-save envelope (any supported _version) or a bare legacy
 * SaveSlot object. Unknown extra fields pass through untouched for forward
 * compatibility. Returns {error} with a specific, human-readable reason on
 * any rejection - never throws.
 */
export function parseImported(json: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: 'unparseable JSON: ' + msg };
  }
  if (!isObj(parsed)) return { error: 'import: expected a JSON object' };

  let payload: unknown = parsed;

  // Envelope detection: only treat it as an envelope when _format is present.
  if (typeof parsed._format === 'string') {
    if (parsed._format !== EXPORT_FORMAT) {
      return { error: `unsupported save format '${parsed._format}' (expected '${EXPORT_FORMAT}')` };
    }
    if (!int(parsed._version) || (parsed._version as number) < 1) {
      return { error: '_version: expected a positive integer' };
    }
    if ((parsed._version as number) > EXPORT_VERSION) {
      return { error: `unsupported save version ${parsed._version} (newest supported: ${EXPORT_VERSION})` };
    }
    if (typeof parsed.exportedAt !== 'string' || Number.isNaN(Date.parse(parsed.exportedAt))) {
      return { error: 'exportedAt: expected an ISO-8601 timestamp string' };
    }
    if (!('slot' in parsed)) return { error: "envelope: missing 'slot' payload" };
    payload = parsed.slot;
  }

  const res = validateSlotShape(payload);
  return res.ok ? res.slot : { error: res.error };
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

/**
 * Copy text to the system clipboard. Prefers the async
 * navigator.clipboard API, falls back to a hidden-textarea +
 * execCommand('copy') trick for older/insecure contexts.
 * Resolves false (never throws) when every path fails.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* permission denied / insecure context -> try the fallback below */
    }
  }
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

/**
 * Read text from the system clipboard, or null when unavailable/denied.
 * Uses navigator.clipboard.readText first, then an execCommand('paste')
 * attempt through a temporary contenteditable host.
 */
export async function pasteFromClipboard(): Promise<string | null> {
  if (typeof navigator !== 'undefined' && navigator.clipboard &&
      typeof navigator.clipboard.readText === 'function') {
    try {
      const text = await navigator.clipboard.readText();
      return typeof text === 'string' ? text : null;
    } catch {
      /* permission denied -> try the fallback below */
    }
  }
  if (
    typeof document !== 'undefined' &&
    typeof document.queryCommandSupported === 'function' &&
    document.queryCommandSupported('paste')
  ) {
    try {
      const host = document.createElement('div');
      host.contentEditable = 'true';
      host.style.position = 'fixed';
      host.style.top = '-1000px';
      host.style.opacity = '0';
      document.body.appendChild(host);
      host.focus();
      const ok = document.execCommand('paste');
      const text = ok ? host.textContent : null;
      host.remove();
      return typeof text === 'string' ? text : null;
    } catch {
      /* fall through */
    }
  }
  return null;
}


