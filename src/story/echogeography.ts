/**
 * F17 Echo Geography — the halls remember YOUR passage.
 *
 * Footstep bursts and voice-memo moments are recorded per site key as they
 * happen (injected calls from the movement/audio mount). When the player later
 * re-enters a recorded site's radius, `enterSite` produces a deterministic,
 * time-compressed replay schedule of those events as distant echoes: delays
 * and falloff derive from RNG keyed by (seed, siteKey), so two instances fed
 * identically produce byte-identical schedules. Each recorded event echoes
 * exactly once per visit; sites with no recording always yield empty
 * schedules. Pure simulation core — no Babylon, no game imports.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';

/** Kinds of player-made sound the halls can learn and give back. */
export type EchoKind = 'footstep' | 'memo';

/** One scheduled echo cue handed to the audio mount. */
export interface EchoCue {
  kind: EchoKind;
  /** seconds after re-entry at which the distant echo should play */
  delaySec: number;
  /** 0..1 loudness after distance falloff */
  gain: number;
  /** simulated distance in meters (pan/reverb hint for the audio mount) */
  distanceM: number;
  /** verbatim memo text; undefined for footsteps */
  memoText?: string;
}

interface SiteEchoEvent {
  seq: number;
  kind: EchoKind;
  /** absolute session seconds when the event was recorded */
  atSec: number;
  memoText?: string;
  /** true once this event has been included in an echo schedule */
  echoed: boolean;
}

interface SiteRecord {
  events: SiteEchoEvent[];
  visits: number;
}

/** Longest real-time span of a replay; longer recordings are compressed harder. */
export const ECHO_MAX_WINDOW_SEC = 6;
/** Distant echoes never arrive instantly. */
export const ECHO_MIN_DELAY_SEC = 1.2;
/** Hard cap on cues in one visit's schedule (oldest kept beyond this). */
export const ECHO_MAX_CUES = 24;
/** Falloff reference distance: gain reaches its floor here. */
export const ECHO_FALLOFF_M = 34;
/** Gain floor so echoes never fully vanish. */
export const ECHO_GAIN_FLOOR = 0.07;

const SITE_SALT = 0x3c40;

function clampGain(d: number): number {
  return Math.max(ECHO_GAIN_FLOOR, Math.min(1, 1 - d / ECHO_FALLOFF_M));
}

/**
 * Deterministic per-(seed, siteKey) stream used for all schedule randomness.
 * The visit index salts the stream so successive visits differ while staying
 * reproducible for any identical feed.
 */
function siteRng(seed: number, siteKey: string, visitIndex: number): RNG {
  return new RNG(hash2i(seedFromString(siteKey), visitIndex + 1, seed ^ SITE_SALT));
}

/** Pure schedule builder shared by EchoGeography.enterSite. */
export function buildEchoSchedule(
  seed: number,
  siteKey: string,
  visitIndex: number,
  events: ReadonlyArray<{ kind: EchoKind; atSec: number; memoText?: string }>,
): EchoCue[] {
  if (events.length === 0) return [];
  const picked = events.slice(-ECHO_MAX_CUES);
  const t0 = picked[0].atSec;
  const rawWindow = picked[picked.length - 1].atSec - t0;
  const scale = rawWindow > ECHO_MAX_WINDOW_SEC ? ECHO_MAX_WINDOW_SEC / rawWindow : 1;
  const rng = siteRng(seed, siteKey, visitIndex);
  const baseDelay = rng.range(1.4, 2.6);
  const out: EchoCue[] = [];
  for (const ev of picked) {
    const jitter = rng.range(-0.18, 0.18);
    const distanceM = rng.range(9, 28);
    out.push({
      kind: ev.kind,
      delaySec: Math.max(ECHO_MIN_DELAY_SEC, baseDelay + (ev.atSec - t0) * scale + jitter),
      gain: clampGain(distanceM),
      distanceM,
      ...(ev.kind === 'memo' ? { memoText: ev.memoText ?? '' } : {}),
    });
  }
  return out;
}

export class EchoGeography {
  private sites = new Map<string, SiteRecord>();
  private nextSeq = 0;

  constructor(public readonly seed: number) {}

  private site(siteKey: string): SiteRecord {
    let s = this.sites.get(siteKey);
    if (!s) {
      s = { events: [], visits: 0 };
      this.sites.set(siteKey, s);
    }
    return s;
  }

  /**
   * Records one footstep burst (several strides) made by the player at a site.
   * @param steps number of strides in the burst (>= 1)
   */
  recordFootstepBurst(siteKey: string, atSec: number, steps = 4): void {
    const s = this.site(siteKey);
    for (let i = 0; i < Math.max(1, steps); i++) {
      s.events.push({ seq: this.nextSeq++, kind: 'footstep', atSec: atSec + i * 0.55, echoed: false });
    }
  }

  /** Records one voice-memo moment made by the player at a site. */
  recordMemoMoment(siteKey: string, atSec: number, text: string): void {
    this.site(siteKey).events.push({ seq: this.nextSeq++, kind: 'memo', atSec, memoText: text, echoed: false });
  }

  /**
   * Called when the player re-enters the site's radius. Returns the
   * deterministic echo schedule for every not-yet-echoed event and marks those
   * events as echoed, so a repeat entry before any new recording yields [].
   */
  enterSite(siteKey: string): EchoCue[] {
    const s = this.site(siteKey);
    const visitIndex = s.visits++;
    const pending = s.events.filter((e) => !e.echoed);
    if (pending.length === 0) return [];
    for (const e of pending) e.echoed = true;
    return buildEchoSchedule(this.seed, siteKey, visitIndex, pending);
  }

  /** Number of times enterSite has fired for a site. */
  visits(siteKey: string): number {
    return this.sites.get(siteKey)?.visits ?? 0;
  }

  /** Events recorded for a site that have not echoed yet. */
  pendingCount(siteKey: string): number {
    return this.sites.get(siteKey)?.events.filter((e) => !e.echoed).length ?? 0;
  }
}
