/**
 * F29 Entity gossip — vocals that reference places the PLAYER actually visited.
 *
 * Reconstructed humans talk about the building, but the building they
 * describe is assembled from stolen memory: theirs and yours. This module
 * turns an injected visit ledger (every site the player has actually been,
 * in journal-feed spirit) into grounded gossip lines. Every line slots a
 * real site name chosen by a seeded draw weighted by recency — a place you
 * stood in an hour ago is talked about more than one from yesterday.
 *
 * Grounding guarantee (the AC): a line can never name a site absent from
 * the ledger. With an empty ledger the source is silence-safe: it emits
 * nothing rather than inventing rooms.
 *
 * Pure logic — no DOM, no Babylon, no audio graph. Determinism law holds:
 * every draw flows through src/core/rng.ts seeded per source instance.
 */
import { RNG } from '../core/rng';
import type { HumanType } from './humans';

// ---- injected ledger ---------------------------------------------------------

/** One player-visited site as recorded by the caller's visit tracking. */
export interface VisitedSite {
  /** Stable site id (chunk/landmark key); echoed on every generated line. */
  readonly siteKey: string;
  /** Free-form site classification ('corridor', 'landmark', 'utility', ...). */
  readonly kind: string;
  /** Human-readable name templates slot verbatim into gossip lines. */
  readonly name: string;
  /**
   * Simulation tick of the player's most recent visit; larger is more
   * recent. Sites default to 0 (ancient) when omitted.
   */
  readonly lastVisitedAt?: number;
}

/** One generated gossip utterance. */
export interface GossipLine {
  /** Archetype of the speaking figure. */
  readonly speaker: HumanType;
  /** Full line; contains exactly the chosen site's `name` verbatim. */
  readonly text: string;
  /** Ledger key of the referenced site (grounding provenance). */
  readonly siteKey: string;
}

// ---- tuning ------------------------------------------------------------------

/**
 * Dedup horizon: a generated line text may not repeat within this many
 * consecutive draws from one source.
 */
export const GOSSIP_DEDUP_WINDOW = 8;

/** Redraw attempts allowed before dedup concedes and returns null. */
const MAX_DEDUP_ATTEMPTS = 24;

/** Recency weight exponent: weight(age) = 1 / (1 + age)^RECENCY_FALLOFF. */
const RECENCY_FALLOFF = 2;

// ---- templates ---------------------------------------------------------------

/**
 * Line templates per speaker archetype; `{site}` is replaced by the drawn
 * site name. Register follows CLUSTER_STORIES tone: evidence, not gore;
 * denial stated plainly, then repeated.
 */
const TEMPLATES: Readonly<Record<HumanType, readonly string[]>> = {
  watcher: [
    'you left your shadow behind at {site}. it still points the way you went.',
    'i was told to watch {site}. nobody told me what for. i watch it anyway.',
    '{site} again. it is always {site} when someone is missing.',
    'the footprints near {site} were mine an hour before i made them.',
  ],
  wanderer: [
    'there is water dripping somewhere inside {site}. i follow it. it moves.',
    'if you are going toward {site}, walk on the left. the right side counts.',
    'i slept standing up outside {site}. when i woke, i was already inside it.',
    'someone wrote EXIT under the wall by {site}. the wall kept it.',
  ],
  helper: [
    '{site} is safe for now. i hold the door until you get there.',
    'take the long way around {site}. the short way takes longer than it says.',
    'i cleaned {site} this morning. it was dirty again before noon. i will clean it tomorrow.',
    'if the lights die near {site}, keep talking. the dark listens for quiet ones.',
  ],
  incomplete: [
    '{site}... i was in {site}... was that me?',
    'they sent me to {site}. i have not arrived yet. i am still going there.',
    'the part of me that remembers {site} is missing. ask the rest.',
    '{site} is on my schedule. my schedule is from before i had a face.',
  ],
  believer: [
    'we swept {site} on Thursday. it came back clean. it is never clean.',
    '{site} is where the hum forgives you. once. only once.',
    'do not pray facing {site}. it prays back with better posture.',
    'the blessed ones pass through {site} without leaving prints. try to be blessed.',
  ],
  double: [
    'i walked past {site} while you were walking past {site}. one of us was early.',
    'your footsteps echo half a second late around {site}. mine arrive on time.',
    'i know the way you hesitated at {site}. i hesitate there too. better.',
    'when you return to {site}, check the corner first. i would.',
  ],
};

// ---- selection ---------------------------------------------------------------

/** Recency-weighted draw over the ledger: recent sites dominate, none vanish. */
function drawSiteWeighted(
  ledger: readonly VisitedSite[],
  rng: RNG,
  nowTick: number,
): VisitedSite {
  let total = 0;
  const weights = new Array<number>(ledger.length);
  for (let i = 0; i < ledger.length; i++) {
    const age = Math.max(0, nowTick - (ledger[i].lastVisitedAt ?? 0));
    weights[i] = 1 / Math.pow(1 + age, RECENCY_FALLOFF);
    total += weights[i];
  }
  if (!(total > 0)) return ledger[rng.int(0, ledger.length)];
  let roll = rng.next() * total;
  for (let i = 0; i < ledger.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return ledger[i];
  }
  return ledger[ledger.length - 1];
}

/**
 * Gossip generator over one player-visit ledger. Construct one per session
 * (or per figure knot); each generate() call draws deterministically from
 * the seed and keeps a rolling dedup window so a knot of figures never
 * repeats itself within GOSSIP_DEDUP_WINDOW consecutive lines.
 */
export class GossipSource {
  private readonly ledger: readonly VisitedSite[];
  private readonly rng: RNG;
  /** Rolling window of recently emitted texts, most recent last. */
  private readonly recent: string[] = [];

  constructor(ledger: readonly VisitedSite[], seed: number) {
    // Only well-formed sites enter the pool: grounding requires both a key
    // and a non-empty name to slot into templates.
    this.ledger = ledger.filter((s) => !!s && typeof s.name === 'string' && s.name.length > 0);
    this.rng = new RNG(seed >>> 0 || 0x9e3779b9);
  }

  /** Number of groundable sites currently in the pool. */
  get siteCount(): number {
    return this.ledger.length;
  }

  /**
   * Generate one grounded gossip line for `speaker` at simulation tick
   * `nowTick` (drives recency weighting). Returns null when the ledger is
   * empty (silence-safe) or when dedup cannot find an unused line within
   * MAX_DEDUP_ATTEMPTS redraws.
   *
   * @param speaker archetype whose template pool is used
   * @param nowTick current simulation tick for recency weighting
   * @returns a grounded line, or null when nothing groundable is available
   */
  generate(speaker: HumanType, nowTick: number): GossipLine | null {
    if (this.ledger.length === 0) return null;
    const templates = TEMPLATES[speaker];
    for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS; attempt++) {
      const site = drawSiteWeighted(this.ledger, this.rng, nowTick);
      const body = templates[this.rng.int(0, templates.length)];
      // replaceAll: several templates slot the site name more than once
      const text = body.replaceAll('{site}', site.name);
      if (this.recent.includes(text)) continue;
      this.recent.push(text);
      if (this.recent.length > GOSSIP_DEDUP_WINDOW) this.recent.shift();
      return { speaker, text, siteKey: site.siteKey };
    }
    return null;
  }
}
