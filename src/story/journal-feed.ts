/**
 * Journal feed for BACKROOMS: MEMORY BLEED.
 *
 * Bridges the Architect's chunk layouts (see src/world/architect.ts) to the
 * lore journal (src/ui/journal.ts): every NoteInstance found in a layout is
 * converted into a journal entry with a derived title, a stable FNV-1a note
 * id (text + coords), and a cluster id grouping spatially adjacent notes
 * into story arcs.
 *
 * Pure logic - no DOM, no Babylon dependencies. The journal is reached
 * through a minimal structural API so tests can stub it.
 */

/** One pickup-able note as emitted by the Architect's layout generator. */
export interface FeedNote {
  /** World x coordinate (meters). */
  x: number;
  /** World z coordinate (meters). */
  z: number;
  /** Full note text. */
  text: string;
}

/** Minimal layout surface consumed by the feed (ChunkLayout-compatible). */
export interface FeedLayout {
  cx: number;
  cz: number;
  notes: FeedNote[];
}

/** Minimal journal surface the feed pushes entries into. */
export interface JournalApi {
  addNote(
    noteId: string,
    title: string,
    text: string,
    clusterId?: string,
    district?: string,
  ): boolean;
}

/** Notes closer than this (meters) chain into one story-arc cluster. */
export const CLUSTER_RADIUS = 15;

/** Hard cap before a derived title gets an ellipsis appended. */
export const FEED_TITLE_MAX = 40;
/** Sentences up to this length are kept verbatim as titles. */
export const FEED_TITLE_KEEP_MAX = 60;

/** 32-bit FNV-1a over a UTF-16 code-unit sequence. Deterministic. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

/**
 * Stable note id: FNV-1a over the full text plus world coordinates, so the
 * same note re-generated from an eternal layout dedups, while identical
 * prose found elsewhere stays distinct.
 */
export function noteIdFor(text: string, x: number, z: number): string {
  return 'note-' + hex8(fnv1a(text + '|' + x + ',' + z));
}

/** Title = first sentence; kept verbatim up to 60 chars, then cut to 40 + '...'. */
export function deriveFeedTitle(text: string): string {
  const body = (text ?? '').replace(/\s+/g, ' ').trim();
  const m = body.match(/^[^.!?]*/);
  let sentence = (m ? m[0] : body).trim();
  if (!sentence) sentence = body;
  if (sentence.length > FEED_TITLE_KEEP_MAX) {
    return sentence.slice(0, FEED_TITLE_MAX) + '...';
  }
  return sentence;
}

/** Cluster id anchored on a first note's coordinates. */
export function arcClusterId(x: number, z: number): string {
  return 'arc-' + hex8(fnv1a(x + ',' + z));
}

/**
 * Feeds Architect layouts into the journal. Keeps a cross-layout dedup set:
 * the eternal generator reproduces the same note ids every visit, so a
 * revisited or overlapping chunk never double-files an entry.
 */
export class JournalFeed {
  private readonly journalApi: JournalApi;
  private readonly seen: Set<string> = new Set();

  constructor(journalApi: JournalApi) {
    this.journalApi = journalApi;
  }

  /**
   * Push every note in `layout` into the journal. Sequential notes within
   * CLUSTER_RADIUS of the run's first note share a cluster id derived from
   * that first note's coordinates; isolated notes land under 'frag'.
   * Returns how many notes were newly accepted by the journal.
   */
  feedFromLayout(layout: FeedLayout, district: number): number {
    if (!layout || !Array.isArray(layout.notes)) return 0;
    let fed = 0;
    const notes = layout.notes;
    let i = 0;
    while (i < notes.length) {
      // grow a run forward while notes stay within CLUSTER_RADIUS of the
      // run's anchor (its first note)
      let end = i + 1;
      while (
        end < notes.length &&
        Math.hypot(notes[end].x - notes[i].x, notes[end].z - notes[i].z) <= CLUSTER_RADIUS
      ) {
        end++;
      }
      const clustered = end - i > 1;
      const clusterId = clustered ? arcClusterId(notes[i].x, notes[i].z) : 'frag';
      for (let j = i; j < end; j++) {
        const note = notes[j];
        const text = typeof note.text === 'string' ? note.text : '';
        if (!text.trim()) continue;
        const id = noteIdFor(text, note.x, note.z);
        if (this.seen.has(id)) continue;
        const ok = this.journalApi.addNote(
          id,
          deriveFeedTitle(text),
          text,
          clusterId,
          String(district),
        );
        if (!ok) continue;
        this.seen.add(id);
        fed++;
      }
      i = end;
    }
    return fed;
  }
}


