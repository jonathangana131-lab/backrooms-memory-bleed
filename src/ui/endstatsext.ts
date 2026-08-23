/**
 * Extended end-game analytics for BACKROOMS: MEMORY BLEED.
 *
 * Deepens the Expedition debrief (see endstats.ts) with second-order
 * statistics: torch dependency, director pacing, territorial patterns,
 * beacon droughts, and watcher near-misses. Also derives narrative
 * "debrief whisper" lines keyed to stat patterns, so a run reads back
 * like a story instead of a spreadsheet.
 *
 * Pure module: no DOM, no game state. formatExtended(stats) returns
 * plain display lines shaped to sit alongside the endstats.ts row
 * pattern (DIM LABEL + amber value, one line per row).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** District visit tallies, district name -> times entered. */
export type DistrictVisits = Record<string, number>;

/** The deeper telemetry collected alongside ExpeditionStats. */
export interface ExtendedStats {
  /** Percentage of run time with the torch lit (0-100). */
  torchUsePct: number;
  /** Number of distinct continuous director-phase stretches this run. */
  phaseSessions: number;
  /** Seconds survived this run (mirrors ExpeditionStats.durationSec). */
  durationSec: number;
  /** Relocations (entity takings) survived (mirrors base stats). */
  relocations: number;
  /** Research beacons discovered this run (mirrors base stats). */
  discoveries: number;
  /** Times the watcher fully froze you this run. */
  freezes: number;
  /**
   * Near-miss encounters: the watcher came within five metres but the
   * run ended (or the encounter ended) without it ever freezing you.
   */
  nearMisses: number;
  /** Longest distance walked between two beacon contacts, metres. */
  longestWalkNoBeaconM: number;
  /** District name -> entry count for this run. */
  districtVisits: DistrictVisits;
}

/** One derived analytic value with its display label. */
export interface ExtendedMetric {
  label: string;
  value: string;
}

/* ------------------------------------------------------------------ */
/* Derived analytics                                                   */
/* ------------------------------------------------------------------ */

/** Torch usage as a clamped 0-100 percentage. */
export function torchUsagePct(stats: ExtendedStats): number {
  return Math.min(100, Math.max(0, Math.round(stats.torchUsePct)));
}

/**
 * Average length of one continuous director-phase stretch, seconds.
 * A run that never lets the player settle has many short sessions.
 */
export function avgPhaseSessionSec(stats: ExtendedStats): number {
  const sessions = Math.max(1, Math.floor(stats.phaseSessions));
  return Math.max(0, Math.round(stats.durationSec / sessions));
}

/** Most-visited district and its visit count, or null on empty runs. */
export function mostVisitedDistrict(
  stats: ExtendedStats
): { district: string; visits: number } | null {
  let best: { district: string; visits: number } | null = null;
  for (const district of Object.keys(stats.districtVisits)) {
    const visits = Math.max(0, Math.floor(stats.districtVisits[district]));
    if (
      best === null ||
      visits > best.visits ||
      (visits === best.visits && district < best.district)
    ) {
      if (visits > 0) best = { district, visits };
    }
  }
  return best;
}

/** Share of all district entries spent in the most-visited district. */
export function dominantDistrictPct(stats: ExtendedStats): number {
  const top = mostVisitedDistrict(stats);
  if (!top) return 0;
  let total = 0;
  for (const d of Object.keys(stats.districtVisits)) {
    total += Math.max(0, Math.floor(stats.districtVisits[d]));
  }
  if (total <= 0) return 0;
  return Math.round((top.visits / total) * 100);
}

/** Longest walk without beacon contact, whole metres. */
export function longestBeaconDroughtM(stats: ExtendedStats): number {
  return Math.max(0, Math.round(stats.longestWalkNoBeaconM));
}

/** Watcher came within five metres without ever freezing you: count. */
export function nearMissCount(stats: ExtendedStats): number {
  return Math.max(0, Math.floor(stats.nearMisses));
}

/* ------------------------------------------------------------------ */
/* Narrative lines                                                     */
/* ------------------------------------------------------------------ */

/**
 * Stat-driven flavor lines, ordered by how strongly the pattern
 * defines the run. Returns at most four; an unremarkable run earns
 * none. Each condition is independent; several may fire together.
 */
export function narrativeLines(stats: ExtendedStats): string[] {
  const out: string[] = [];

  // Heavy torch dependence.
  if (torchUsagePct(stats) >= 60) {
    out.push('You feared the dark more than what watches from it.');
  }

  // Zero relocations: the space never had to intervene.
  if (Math.max(0, stats.relocations) === 0) {
    out.push('It never had to move you. You moved yourself.');
  }

  // Many close encounters, never caught.
  if (nearMissCount(stats) >= 3 && Math.max(0, stats.freezes) === 0) {
    out.push(
      'It was close enough to touch ' + nearMissCount(stats) +
        ' times. It never saw you.'
    );
  }

  // Territorial repetition: half of all entries in one district.
  const dom = dominantDistrictPct(stats);
  const top = mostVisitedDistrict(stats);
  if (dom >= 50 && top) {
    out.push('You wore a groove into ' + top.district + '. It started wearing back.');
  }

  // Long beacon drought.
  if (longestBeaconDroughtM(stats) >= 400) {
    out.push(
      String(longestBeaconDroughtM(stats)) +
        ' metres from the last beacon. You trusted the hum anyway.'
    );
  }

  // Frantic pacing: the director cycled fast.
  if (stats.phaseSessions >= 12 && avgPhaseSessionSec(stats) <= 45) {
    out.push('The director never let you settle. Neither did the walls.');
  }

  return out.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

/** Integer formatting with thousands separators (matches endstats.ts). */
function fmtInt(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Duration as H:MM:SS (matches endstats.ts footer pattern). */
function fmtDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/**
 * Every extended metric as one DIM LABEL + amber VALUE display line,
 * compatible with the endstats.ts row pattern.
 */
export function extendedMetrics(stats: ExtendedStats): ExtendedMetric[] {
  const metrics: ExtendedMetric[] = [
    { label: 'TORCH USAGE', value: torchUsagePct(stats) + '%' },
    {
      label: 'AVG PHASE LENGTH',
      value: fmtDuration(avgPhaseSessionSec(stats)),
    },
  ];
  const top = mostVisitedDistrict(stats);
  metrics.push({
    label: 'MOST-VISITED DISTRICT',
    value: top ? top.district + ' (' + top.visits + ')' : 'NONE',
  });
  metrics.push({
    label: 'LONGEST WALK WITHOUT BEACON',
    value: fmtInt(longestBeaconDroughtM(stats)) + ' m',
  });
  metrics.push({ label: 'NEAR MISSES', value: String(nearMissCount(stats)) });
  return metrics;
}

/**
 * Additional debrief display lines for endstats.ts: metric rows first,
 * then a separator header, then any earned narrative whispers.
 */
export function formatExtended(stats: ExtendedStats): string[] {
  const lines: string[] = [];
  for (const m of extendedMetrics(stats)) {
    lines.push(m.label + ' ' + m.value);
  }
  const narrative = narrativeLines(stats);
  if (narrative.length > 0) {
    lines.push('DEBRIEF WHISPERS //');
    for (const n of narrative) lines.push(n);
  }
  return lines;
}


