/**
 * F61 The Congregation's Hymn — believers sing rounds naming YOUR
 * discoveries.
 *
 * When the chapel fills (congregation.ts), the believers sing. The hymn is
 * built from stolen memory in the same grounding discipline as gossip.ts:
 * an injected discovery ledger ({id, name} — every thing the player has
 * actually found) is the ONLY source of sung names. Every lyric line slots
 * exactly one ledger name verbatim and carries its id as provenance; a
 * line can never name a discovery absent from the ledger. With an empty
 * ledger the choir goes wordless — silent humming only, no invented text.
 *
 * Round structure: VOICE_COUNT voices per round, each entering at a seeded
 * stagger offset inside the ROUND_BEATS bar; rounds cycle forever, so the
 * stagger pattern of one round repeats as the round counter advances.
 * A rolling dedup window keeps a choir from repeating itself within
 * HYMN_DEDUP_WINDOW consecutive lines.
 *
 * Pure logic — no DOM, no Babylon, no audio graph; the caller mounts each
 * line's voice/beat onto its audio or caption layer. Determinism law holds:
 * every draw flows through src/core/rng.ts seeded per choir instance.
 */
import { RNG, hash2i } from '../core/rng';

// ---- injected ledger ---------------------------------------------------------

/** One player discovery as recorded by the caller's journal tracking. */
export interface DiscoveryEntry {
  /** Stable discovery id; echoed on every generated line as provenance. */
  readonly id: string;
  /** Human-readable name slotted verbatim into lyric lines. */
  readonly name: string;
}

// ---- tuning ------------------------------------------------------------------

/** Voices singing each round. */
export const VOICE_COUNT = 4;

/** Beats in one round bar; voice staggers live inside [0, ROUND_BEATS). */
export const ROUND_BEATS = 16;

/**
 * Dedup horizon: a generated lyric text may not repeat within this many
 * consecutive emitted lines.
 */
export const HYMN_DEDUP_WINDOW = 8;

/** Redraw attempts allowed before dedup concedes and emits a hum line. */
const MAX_DEDUP_ATTEMPTS = 24;

/** Salt for the seeded per-voice stagger draws. */
const STAGGER_SALT = 0x6879 >>> 0;

/** Wordless syllables hummed when there is nothing grounded to sing. */
const HUM_SYLLABLES: readonly string[] = ['mm', 'mm—mm', 'mm—mm—mm'];

// ---- templates ---------------------------------------------------------------

/**
 * Lyric templates; `{discovery}` is replaced by the drawn discovery name.
 * Register follows the believer voice in gossip.ts: gratitude stated
 * plainly, ownership reversed — you found it, they keep it.
 */
const LYRIC_TEMPLATES: readonly string[] = [
  'we remember {discovery}. we sing it so it stays.',
  'you found {discovery}. the finding belongs to us now.',
  'blessed is the walk that ended at {discovery}.',
  'say {discovery} again. the walls lean in to hear it.',
  '{discovery} was lost until your light crossed it. rest now.',
  'we keep a seat open facing {discovery}. it is always warm.',
];

// ---- line model ---------------------------------------------------------------

export type HymnLineKind = 'lyric' | 'hum';

/** One sung line: either a grounded lyric or a wordless hum. */
export interface HymnLine {
  readonly kind: HymnLineKind;
  /** 0-based voice singing this line within its round. */
  readonly voice: number;
  /** Global beat index when this line enters (rounds advance by ROUND_BEATS). */
  readonly beat: number;
  /**
   * Full line text. Lyric lines contain exactly one ledger name verbatim;
   * hum lines are wordless syllables and never contain any name.
   */
  readonly text: string;
  /** Ledger id of the referenced discovery; null for hum lines. */
  readonly discoveryId: string | null;
}

/**
 * One choir. Construct per session; call nextLine() to walk the hymn in
 * performance order. Same seed reproduces the identical transcript.
 *
 * Grounding guarantee (the AC): every non-null `discoveryId` comes from
 * the injected ledger and every lyric text contains that entry's name —
 * names enter the hymn from nowhere else. An empty (or fully invalid)
 * ledger produces only hum lines.
 */
export class CongregationHymn {
  private readonly discoveries: readonly DiscoveryEntry[];
  private readonly rng: RNG;
  /** Seeded entry beat for each voice, fixed across all rounds. */
  private readonly stagger: number[] = [];
  /** Rolling window of recently emitted texts, most recent last. */
  private readonly recent: string[] = [];
  private roundIndex = 0;
  /** Lines of the current round still to emit, in performance order. */
  private queue: HymnLine[] = [];

  constructor(ledger: readonly DiscoveryEntry[], seed: number) {
    // Only well-formed entries can ground a lyric: both id and non-empty
    // name are required, mirroring gossip.ts's site filter.
    this.discoveries = ledger.filter(
      (e) => !!e && typeof e.id === 'string' && e.id.length > 0 &&
             typeof e.name === 'string' && e.name.length > 0,
    );
    this.rng = new RNG(seed >>> 0 || 0x9e3779b9);
    for (let v = 0; v < VOICE_COUNT; v++) {
      this.stagger.push(hash2i(seed >>> 0, v, STAGGER_SALT) % ROUND_BEATS);
    }
  }

  /** Number of groundable discoveries currently in the pool. */
  get discoveryCount(): number {
    return this.discoveries.length;
  }

  /** Seeded entry-beat offset of voice v within any round. */
  voiceStagger(v: number): number {
    return this.stagger[v];
  }

  /** Index of the round currently being performed (or next to fill). */
  get currentRound(): number {
    return this.roundIndex;
  }

  /**
   * Next line in performance order. Rounds fill in cycle: each round's
   * voices are emitted sorted by their stagger offsets, so entry order
   * rotates with the seed but stays fixed across rounds. Returns hum lines
   * only when the ledger grounds nothing.
   */
  nextLine(): HymnLine {
    if (this.queue.length === 0) this.fillRound();
    return this.queue.shift() as HymnLine;
  }

  /** Build the upcoming round's lines in stagger order. */
  private fillRound(): void {
    const base = this.roundIndex * ROUND_BEATS;
    const entries: Array<{ voice: number; beat: number }> = [];
    for (let v = 0; v < VOICE_COUNT; v++) {
      entries.push({ voice: v, beat: base + this.stagger[v] });
    }
    entries.sort((a, b) => a.beat - b.beat);
    this.queue = entries.map((e) => this.makeLine(e.voice, e.beat));
    this.roundIndex++;
  }

  /** One line: grounded lyric when possible, otherwise a wordless hum. */
  private makeLine(voice: number, beat: number): HymnLine {
    if (this.discoveries.length === 0) {
      const text = HUM_SYLLABLES[this.rng.int(0, HUM_SYLLABLES.length)];
      return { kind: 'hum', voice, beat, text, discoveryId: null };
    }
    for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS; attempt++) {
      const d = this.discoveries[this.rng.int(0, this.discoveries.length)];
      const body = LYRIC_TEMPLATES[this.rng.int(0, LYRIC_TEMPLATES.length)];
      const text = body.replaceAll('{discovery}', d.name);
      if (this.recent.includes(text)) continue;
      this.recent.push(text);
      if (this.recent.length > HYMN_DEDUP_WINDOW) this.recent.shift();
      return { kind: 'lyric', voice, beat, text, discoveryId: d.id };
    }
    // Dedup exhausted (tiny ledgers): concede to a wordless hum rather
    // than repeat inside the window — humming stays grounded by default.
    return { kind: 'hum', voice, beat, text: HUM_SYLLABLES[0], discoveryId: null };
  }
}
