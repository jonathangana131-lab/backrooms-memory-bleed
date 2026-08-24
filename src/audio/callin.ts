/**
 * Call-in radio show for BACKROOMS: MEMORY BLEED (F86).
 *
 * Night-frequency callers phone in and describe YOUR exact equipment
 * loadout — the same grounding discipline as entity gossip and the hymn:
 * every equipment claim in every spoken segment is assembled from the
 * injected loadout descriptor and carries a structured EquipmentClaim
 * recording which descriptor field it asserts. No descriptor, no show:
 * the constructor accepts null and tick() stays permanently silent.
 *
 * Segment text is generated from the same values as its claims, so text
 * can never contradict the descriptor: flashlight segments interpolate
 * flashlightModel verbatim, battery segments come from the pool keyed by
 * the actual batteryPctBand, camcorder segments come from the possess or
 * absent pool matching hasCamcorder, notes segments interpolate the real
 * notesRead count (or a tier derived from it), and district segments name
 * only entries of districtsVisited. Districts never visited are never
 * named.
 *
 * The show runs on an injected session clock: tick() pulls the clock,
 * airs every call whose scheduled time has arrived (cadence drawn from
 * the seeded stream), and tolerates junk clocks (NaN, backward time)
 * by airing nothing rather than corrupting the schedule.
 *
 * Output keeps a dedup window: identical segment text never repeats
 * within DEDUP_WINDOW consecutive segments; colliding picks redraw
 * deterministically up to MAX_PICK_ATTEMPTS and otherwise drop that
 * segment.
 *
 * All randomness flows from src/core/rng.ts keyed by the show seed, so a
 * given seed + loadout + clock feed replays an identical broadcast.
 *
 * Pure Node-testable: no DOM, no Babylon imports, no Date.now(), no
 * Math.random() (see test/callin-test.mjs).
 */

import { RNG } from '../core/rng';

// ---------------------------------------------------------------------------
// Loadout descriptor
// ---------------------------------------------------------------------------

/** Coarse battery-charge band callers can refer to. */
export type BatteryBand = 'full' | 'steady' | 'fading' | 'dying';

/** All bands; a descriptor names exactly one. */
export const BATTERY_BANDS: readonly BatteryBand[] = [
  'full', 'steady', 'fading', 'dying',
];

/**
 * The player's equipment loadout as callers see it. Every spoken
 * equipment claim traces to exactly one field here; there is no other
 * source of facts on the show.
 */
export interface LoadoutDescriptor {
  /** Exact flashlight model string callers repeat verbatim (non-empty). */
  flashlightModel: string;
  /** Charge band of the flashlight cell. */
  batteryPctBand: BatteryBand;
  /** Whether the player carries the camcorder. */
  hasCamcorder: boolean;
  /** Count of journal/notepaper pages read so far (integer >= 0). */
  notesRead: number;
  /** Districts the player has actually entered; callers name only these. */
  districtsVisited: readonly string[];
}

// ---------------------------------------------------------------------------
// Structured claims + aired-call types
// ---------------------------------------------------------------------------

/** A descriptor field a segment may assert. */
export type LoadoutField =
  | 'flashlightModel'
  | 'batteryPctBand'
  | 'hasCamcorder'
  | 'notesRead'
  | 'districtsVisited';

/** One equipment assertion made by a segment. */
export interface EquipmentClaim {
  /** Which descriptor field is asserted. */
  field: LoadoutField;
  /**
   * Asserted value as a string: the field's own value, or (for
   * districtsVisited) one named entry of that list.
   */
  value: string;
}

/** One spoken segment of a call: text plus the claims it makes. */
export interface CallerSegment {
  /** Full line text as spoken on air. */
  text: string;
  /** Every equipment claim the text makes; openers have none. */
  claims: readonly EquipmentClaim[];
}

/** One aired call-in. */
export interface AiredCall {
  /** Stable caller archetype id. */
  callerId: string;
  /** On-air handle of the caller. */
  callerName: string;
  /** Session-clock second the call aired at. */
  tSec: number;
  /** Spoken segments in order; at least one. */
  segments: readonly CallerSegment[];
}

/** Injected session clock; seconds on the game's own timeline. */
export interface SessionClock {
  /** Current session time in seconds (monotonic while healthy). */
  nowSec(): number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Qualitative reading-load tier derived from the real count; callers use
 * it instead of inventing numbers.
 *
 * @param n Read-page count (integer >= 0).
 * @returns Tier label for the count bucket.
 */
export function notesTier(n: number): 'barely any' | 'a handful of' | 'a stack of' | 'an archive of' {
  if (n < 5) return 'barely any';
  if (n < 20) return 'a handful of';
  if (n < 50) return 'a stack of';
  return 'an archive of';
}

// ---------------------------------------------------------------------------
// Script pools
// ---------------------------------------------------------------------------

/**
 * Flashlight segments; the placeholder `%M` is replaced with the real
 * flashlightModel. Never aired with any other model substituted.
 */
export const FLASHLIGHT_LINES: readonly string[] = [
  'that %M of yours hums when you point it at the ceiling',
  'you still carry the %M? mine died two floors in',
  'keep the %M low. they track beams longer than they track feet',
  'someone traded me a %M once. it came back wrong',
  'the %M draws them from the next room if you sweep it wide',
];

/** Battery segments keyed by the REAL band; other bands never air. */
export const BATTERY_LINES: Readonly<Record<BatteryBand, readonly string[]>> = {
  full: [
    'your cell reads full tonight. enjoy it while the walls let you',
    'fresh charge, huh. new power gets noticed down there',
    'that full battery of yours is the loudest thing you carry',
  ],
  steady: [
    'your cell is holding steady. steady is a rumour down there',
    'they say a steady charge means the level likes you. it lies',
    'half a tank and holding. the drains come at night',
  ],
  fading: [
    'your light is fading. we can tell by how short your walks sound',
    'a dying cell changes how a person talks. yours is going',
    'when the fade starts, count your exits before the dark does',
  ],
  dying: [
    'your cell is nearly dead. we heard the flicker from two floors up',
    'carrying a dead light is its own kind of confession',
    'when that cell goes, stand still. moving blind is how they meet you',
  ],
};

/** Camcorder segments when the player HAS the camera. */
export const CAMCORDER_YES_LINES: readonly string[] = [
  'the camcorder on your strap sees more than you do. keep it rolling',
  'point the camera at what you refuse to look at',
  'tape the hallways. playback shows the extra footsteps',
];

/** Camcorder segments when the player does NOT have the camera. */
export const CAMCORDER_NO_LINES: readonly string[] = [
  'going in with no camcorder is one way to stay unrecorded',
  'without the camera nobody can check what walked behind you',
  'no lens means no playback. some nights that is the safer trade',
];

/** Numeric notes segments; `%N` becomes the real notesRead count. */
export const NOTES_COUNT_LINES: readonly string[] = [
  'you have read %N pages of other people\u2019s notes. they read you back',
  '%N notes in and you still trust the handwriting?',
  'word is you are %N pages deep. the paper remembers readers',
];

/** Notes segments keyed by the tier returned by notesTier(notesRead). */
export const NOTES_TIER_LINES: Readonly<Record<ReturnType<typeof notesTier>, readonly string[]>> = {
  'barely any': [
    'barely any pages read and already they annotate your steps',
    'you hardly touch the notes. the margins miss you',
  ],
  'a handful of': [
    'a handful of pages in and the advice starts contradicting itself',
    'a handful of notes is enough to be dangerous with',
  ],
  'a stack of': [
    'a stack of notes read. you are becoming somebody\u2019s footnote',
    'with a stack of pages behind you, start writing your own',
  ],
  'an archive of': [
    'an archive of other people\u2019s words in your head. heavy luggage',
    'you have read an archive down there. no wonder it talks to you',
  ],
};

/** Single-district segments; `%D` becomes a REAL visited district. */
export const DISTRICT_LINES: readonly string[] = [
  'callers keep naming %D. nobody admits walking it',
  'you passed through %D. it kept a copy of your footsteps',
  '%D remembers the hour you crossed it. clocks there disagree',
];

/** Two-district segments; `%A` and `%B` become REAL visited districts. */
export const DISTRICT_PAIR_LINES: readonly string[] = [
  'on our maps %A bleeds straight into %B. do not ask which map',
  'you crossed %A into %B. between them there is a hallway that is in neither',
];

/** Zero-claim opening lines (show texture; assert no equipment facts). */
export const OPENER_LINES: readonly string[] = [
  'calling it in on the night frequency',
  'anyone still receiving, this channel finds you',
  'the switchboard lit up the moment you went under',
  'line\u2019s quiet except for us tonight',
];

/** Fixed caller archetypes; ids are stable for dedup and tests. */
export const CALLERS: readonly { id: string; name: string }[] = [
  { id: 'moth', name: 'Moth-3' },
  { id: 'lineman', name: 'Wire-Walker' },
  { id: 'clerk', name: 'Night Clerk' },
  { id: 'cartographer', name: 'The Cartographer' },
  { id: 'insomniac', name: 'Insomniac-9' },
];

// ---------------------------------------------------------------------------
// Cadence + dedup constants
// ---------------------------------------------------------------------------

/** Delay before the first call, seconds (drawn uniformly in this range). */
export const FIRST_CALL_DELAY_SEC = 20;
/** Minimum gap between calls, seconds. */
export const CALL_GAP_MIN_SEC = 45;
/** Maximum gap between calls, seconds. */
export const CALL_GAP_MAX_SEC = 150;
/** Max calls aired in one tick, capping clock-jump catch-up. */
export const MAX_CALLS_PER_TICK = 4;
/** Consecutive segments over which identical text is suppressed. */
export const DEDUP_WINDOW = 8;
/** Deterministic redraws allowed before a colliding segment drops. */
export const MAX_PICK_ATTEMPTS = 24;

/** Salt so call-in draws never correlate with other features on a seed. */
const CALLIN_SALT = 0xca115;

// ---------------------------------------------------------------------------
// Show model
// ---------------------------------------------------------------------------

/**
 * The call-in show. Constructed over an optional loadout descriptor, a
 * session seed, and an injected session clock; tick() is the only output.
 * With no descriptor the show stays permanently silent.
 */
export class CallInShow {
  private readonly loadout: LoadoutDescriptor | null;
  private readonly rng: RNG;
  private readonly clock: SessionClock;
  private started = false;
  private nextCallAt = 0;
  private lastCallerIdx = -1;
  private recent: string[] = [];

  /**
   * @param loadout Player loadout callers describe, or null for no show.
   * @param seed Session seed driving every draw.
   * @param clock Injected session clock.
   * @throws When the descriptor is present but malformed (empty
   *   flashlightModel, unknown battery band, negative or fractional
   *   notesRead, blank district name).
   */
  constructor(
    loadout: LoadoutDescriptor | null,
    seed: number,
    clock: SessionClock,
  ) {
    if (loadout !== null) {
      if (loadout.flashlightModel.length === 0) {
        throw new Error('loadout.flashlightModel must be non-empty');
      }
      if (!(BATTERY_BANDS as readonly string[]).includes(loadout.batteryPctBand)) {
        throw new Error(`unknown battery band: ${String(loadout.batteryPctBand)}`);
      }
      if (!Number.isInteger(loadout.notesRead) || loadout.notesRead < 0) {
        throw new Error(`notesRead must be an integer >= 0: ${String(loadout.notesRead)}`);
      }
      for (const d of loadout.districtsVisited) {
        if (d.length === 0) throw new Error('districtsVisited entries must be non-empty');
      }
    }
    this.loadout = loadout;
    this.clock = clock;
    this.rng = new RNG((seed ^ CALLIN_SALT) >>> 0 || 0x9e3779b9);
  }

  /** True when no descriptor was injected; such a show never speaks. */
  get silentByDesign(): boolean {
    return this.loadout === null;
  }

  /**
   * Air every call whose scheduled time has arrived on the injected
   * clock. Junk clock readings (NaN, non-finite, backward movement) air
   * nothing and leave the schedule untouched. Clock jumps larger than
   * the per-tick cap fast-forward the schedule instead of looping.
   *
   * @returns Calls aired during this tick, in order.
   */
  tick(): readonly AiredCall[] {
    if (this.loadout === null) return [];
    const now = this.clock.nowSec();
    if (!Number.isFinite(now)) return [];
    if (!this.started) {
      this.started = true;
      this.nextCallAt = now + this.rng.range(5, FIRST_CALL_DELAY_SEC);
      return [];
    }
    if (now < this.nextCallAt) return [];
    const out: AiredCall[] = [];
    while (out.length < MAX_CALLS_PER_TICK && now >= this.nextCallAt) {
      const call = this.makeCall(this.nextCallAt);
      if (call !== null) out.push(call);
      this.nextCallAt += this.rng.range(CALL_GAP_MIN_SEC, CALL_GAP_MAX_SEC);
    }
    if (now >= this.nextCallAt) {
      // Catch-up exhausted: reschedule past the jump so a huge clock step
      // cannot spin the loop forever.
      this.nextCallAt = now + this.rng.range(CALL_GAP_MIN_SEC, CALL_GAP_MAX_SEC);
    }
    return out;
  }

  /** Snapshot of the current dedup window, oldest first. */
  recentWindow(): readonly string[] {
    return this.recent.slice();
  }

  /**
   * Assemble one call: pick a caller (never the previous one), an
   * opener, then 2-4 grounded topic segments drawn from the fields the
   * descriptor actually populates.
   *
   * @param tSec Session second the call airs at.
   * @returns The call, or null when dedup dropped every segment.
   */
  private makeCall(tSec: number): AiredCall | null {
    let callerIdx = -1;
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      const cand = this.rng.int(0, CALLERS.length);
      if (cand !== this.lastCallerIdx) { callerIdx = cand; break; }
    }
    if (callerIdx < 0) callerIdx = (this.lastCallerIdx + 1) % CALLERS.length;
    this.lastCallerIdx = callerIdx;

    const segments: CallerSegment[] = [];
    const opener = this.pickLine(OPENER_LINES);
    if (opener !== null) segments.push({ text: opener, claims: [] });

    const topics = this.availableTopics();
    const count = Math.min(2 + this.rng.int(0, 3), topics.length);
    const order = this.shuffled(topics).slice(0, count);
    for (const topic of order) {
      const seg = this.buildSegment(topic);
      if (seg !== null) segments.push(seg);
    }
    if (segments.length === 0) return null;
    const caller = CALLERS[callerIdx];
    return { callerId: caller.id, callerName: caller.name, tSec, segments };
  }

  /** Topics grounded in populated descriptor fields. */
  private availableTopics(): LoadoutField[] {
    const ld = this.loadout;
    if (ld === null) return [];
    const topics: LoadoutField[] = ['flashlightModel', 'batteryPctBand', 'hasCamcorder'];
    if (ld.notesRead > 0 || this.rng.chance(0.25)) topics.push('notesRead');
    if (ld.districtsVisited.length > 0) topics.push('districtsVisited');
    return topics;
  }

  /**
   * Build one equipment segment for a topic: the text is produced from
   * the real descriptor value and the claim records that same value, so
   * text and claim agree by construction.
   *
   * @param field Descriptor field the segment grounds in.
   * @returns The segment, or null when dedup exhausted redraws.
   */
  private buildSegment(field: LoadoutField): CallerSegment | null {
    const ld = this.loadout;
    if (ld === null) return null;
    switch (field) {
      case 'flashlightModel':
        return this.emitWithClaim(FLASHLIGHT_LINES, field, ld.flashlightModel, [['%M', ld.flashlightModel]]);
      case 'batteryPctBand':
        return this.emitFromPool(BATTERY_LINES[ld.batteryPctBand], field, ld.batteryPctBand);
      case 'hasCamcorder':
        return ld.hasCamcorder
          ? this.emitFromPool(CAMCORDER_YES_LINES, field, 'true')
          : this.emitFromPool(CAMCORDER_NO_LINES, field, 'false');
      case 'notesRead':
        return this.rng.chance(0.5)
          ? this.emitWithClaim(NOTES_COUNT_LINES, field, String(ld.notesRead), [['%N', String(ld.notesRead)]])
          : this.emitFromPool(NOTES_TIER_LINES[notesTier(ld.notesRead)], field, String(ld.notesRead));
      case 'districtsVisited': {
        const ds = ld.districtsVisited;
        if (ds.length >= 2 && this.rng.chance(0.35)) {
          const i = this.rng.int(0, ds.length);
          let j = this.rng.int(0, ds.length - 1);
          if (j >= i) j++;
          const a = ds[i] > ds[j] ? ds[j] : ds[i];
          const b = ds[i] > ds[j] ? ds[i] : ds[j];
          return this.emitWithClaims(DISTRICT_PAIR_LINES, field, [a, b], [['%A', a], ['%B', b]]);
        }
        const d = ds[this.rng.int(0, ds.length)];
        return this.emitWithClaim(DISTRICT_LINES, field, d, [['%D', d]]);
      }
    }
  }

  /**
   * Draw a line from a pool, substitute placeholders, honouring the
   * dedup window with deterministic redraws.
   *
   * @param pool Candidate lines containing the given substitutions.
   * @param subs Placeholder/value pairs applied in order.
   * @returns Final text, or null when redraws exhausted inside the
   *   dedup window.
   */
  private pickLine(pool: readonly string[], subs: readonly (readonly [string, string])[] = []): string | null {
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      const raw = pool[this.rng.int(0, pool.length)];
      let text = raw;
      for (const [ph, val] of subs) text = text.split(ph).join(val);
      if (!this.recent.includes(text)) {
        this.recent.push(text);
        if (this.recent.length > DEDUP_WINDOW) this.recent.shift();
        return text;
      }
    }
    return null;
  }

  /** Single-value wrapper producing one claim alongside the text. */
  private emitFromPool(pool: readonly string[], field: LoadoutField, value: string): CallerSegment | null {
    return this.emitWithClaims(pool, field, [value], []);
  }

  /** Single-placeholder wrapper building one substitution + one claim. */
  private emitWithClaim(
    pool: readonly string[],
    field: LoadoutField,
    value: string,
    subs: readonly (readonly [string, string])[],
  ): CallerSegment | null {
    return this.emitWithClaims(pool, field, [value], subs);
  }

  /**
   * Assemble a grounded segment: text from the pool with substitutions
   * applied, claims asserting exactly the supplied real values.
   *
   * @param pool Candidate lines.
   * @param field Descriptor field being claimed.
   * @param values Real descriptor values asserted (list members for
   *   districtsVisited).
   * @param subs Placeholder substitutions baked into the text.
   * @returns The segment, or null when dedup exhausted redraws.
   */
  private emitWithClaims(
    pool: readonly string[],
    field: LoadoutField,
    values: readonly string[],
    subs: readonly (readonly [string, string])[],
  ): CallerSegment | null {
    const text = this.pickLine(pool, subs);
    if (text === null) return null;
    return { text, claims: values.map((value) => ({ field, value })) };
  }

  /** Deterministic Fisher-Yates copy driven by the seeded stream. */
  private shuffled<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i + 1);
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }
}
