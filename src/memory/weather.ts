/**
 * Memory Weather.
 *
 * Contamination is not static: fronts of specific human memory roll
 * across the infinite plane, strengthening, masking and rewriting
 * regions. Chunks regenerate under the new weather when the player is
 * not looking - places change behind your back.
 *
 * Depth systems:
 *  - Forecast:       nextFront() peeks at the already-planned next front.
 *  - Super-storms:   rare (every ~20 min) violet fronts, intensity >= 0.9,
 *                    90 s long, three times the normal radius.
 *  - Micro-climates: enclosed spaces dampen the bleed - corridors cut it
 *                    by 40%, generic indoors by 20%.
 *  - Residual echo:  for 60 s after a front passes, its tint fades out
 *                    over whatever came next.
 *  - Seasonal drift: past 45 min of session time the base memory
 *                    intensity climbs +0.1/hour, capped.
 */
import { RNG, hash32 } from '../core/rng';
import { MemoryKind } from './field';

const FRONTS: { kind: MemoryKind; weight: number }[] = [
  { kind: MemoryKind.RESIDENCE, weight: 3 },
  { kind: MemoryKind.OFFICE, weight: 3 },
  { kind: MemoryKind.HOSPITAL, weight: 2 },
  { kind: MemoryKind.SCHOOL, weight: 2 },
  { kind: MemoryKind.MALL, weight: 2 },
  { kind: MemoryKind.TRANSIT, weight: 2 },
  { kind: MemoryKind.PERSONAL, weight: 1 },
];

/** Fog tint per dominant front kind (r,g,b multipliers on existing fog). */
const TINTS: Record<number, [number, number, number]> = {
  [MemoryKind.NONE]: [1, 1, 1],
  [MemoryKind.RESIDENCE]: [1.0, 0.96, 0.9],
  [MemoryKind.OFFICE]: [1.02, 1.0, 0.88],
  [MemoryKind.HOSPITAL]: [0.88, 0.97, 1.04],
  [MemoryKind.SCHOOL]: [0.95, 1.0, 0.95],
  [MemoryKind.MALL]: [1.05, 0.98, 0.92],
  [MemoryKind.TRANSIT]: [0.92, 0.94, 1.0],
  [MemoryKind.PERSONAL]: [1.0, 0.93, 0.85],
};

/** Deep violet super-storm tint - nothing natural looks like this. */
const STORM_TINT: [number, number, number] = [0.58, 0.32, 1.12];

/** Micro-climate zones and how much of the weather bleeds indoors. */
export type WeatherZone = 'open' | 'indoor' | 'corridor';

/** Fraction of weather influence that reaches each zone. */
export const ZONE_DAMPEN: Record<WeatherZone, number> = {
  open: 1.0,
  indoor: 0.8,
  corridor: 0.6, // corridors dampen by 40%
};

/** Super-storm cadence and shape. */
const STORM_PERIOD_MIN = 1140; // seconds (~19 min) ...
const STORM_PERIOD_MAX = 1380; // ... to ~23 min between storms
const STORM_STRENGTH_MIN = 0.9;
const STORM_DURATION = 90; // seconds

/** Residual echo lasts this long after a front passes. */
const RESIDUAL_SECS = 60;
/** How strongly the echo tints the fog at full strength. */
const RESIDUAL_WEIGHT = 0.45;

/** Seasonal drift: delay, hourly rate, cap. */
const DRIFT_DELAY_SECS = 45 * 60; // only past 45 minutes
const DRIFT_PER_HOUR = 0.1;
const DRIFT_CAP = 0.4;

export interface WeatherFront {
  kind: MemoryKind;
  /** 0..1 strength */
  strength: number;
  /** front center world coords */
  cx: number;
  cz: number;
  /** drift velocity m/s */
  vx: number;
  vz: number;
  radiusM: number;
  /** true for super-storm fronts */
  storm: boolean;
}

/** What the next front will look like once the current one expires. */
export interface WeatherForecast {
  kind: MemoryKind;
  /** 0..1 strength the incoming front will arrive with */
  intensity: number;
  /** seconds until the current front hands over to this one */
  etaSec: number;
  /** incoming front is a super-storm (UI warning banner material) */
  storm: boolean;
}


(Showing lines 88-99 of 369. Use offset=100 to continue.)

interface FrontPlan {
  kind: MemoryKind;
  strength: number;
  storm: boolean;
}

interface ResidualEcho {
  kind: MemoryKind;
  strength: number;
  /** seconds since the front handed over */
  age: number;
}

/** Full serializable weather state. */
export interface WeatherState extends WeatherFront {
  t: number;
  dur: number;
  /** accumulated weather-clock seconds (also drives seasonal drift) */
  clock: number;
  /** front counter, keys the deterministic forecast RNG stream */
  seq: number;
  nextStormAt: number;
  nextPlan: FrontPlan | null;
  residual: ResidualEcho | null;
}

export class MemoryWeather {
  front: WeatherFront;
  /**
   * Ambient micro-climate the player currently stands in. Callers may
   * set this once per frame; per-sample overrides go through apply().
   */
  zone: WeatherZone = 'open';
  private t = 0;
  private dur: number;
  private clock = 0;
  private seq = 0;
  private nextStormAt: number;
  private nextPlan: FrontPlan | null = null;
  private residual: ResidualEcho | null = null;

  constructor(public seed: number) {
    const rng = new RNG(seed ^ 0x3eaF00d);
    this.front = this.makeFront(rng, 0, 0);
    this.dur = 120 + rng.next() * 150;
    this.nextStormAt = STORM_PERIOD_MIN + rng.next() * (STORM_PERIOD_MAX - STORM_PERIOD_MIN);
    this.planNext();
  }

  private pickKind(rng: RNG): MemoryKind {
    let total = 0;
    for (const f of FRONTS) total += f.weight;
    let pick = rng.next() * total;
    for (const f of FRONTS) {
      pick -= f.weight;
      if (pick <= 0) return f.kind;
    }
    return MemoryKind.OFFICE;
  }

  private makeFront(rng: RNG, cx: number, cz: number, opts?: { strength?: number; storm?: boolean }): WeatherFront {
    const ang = rng.next() * Math.PI * 2;
    const speed = 0.25 + rng.next() * 0.55;
    const storm = opts?.storm ?? false;
    return {
      kind: this.pickKind(rng),
      strength: opts?.strength ?? 0.35 + rng.next() * 0.65,
      cx,
      cz,
      vx: Math.cos(ang) * speed,
      vz: Math.sin(ang) * speed,
      radiusM: (260 + rng.next() * 420) * (storm ? 3 : 1),
      storm,
    };
  }

  /**
   * Deterministically plan the front that will follow the current one.
   * Keyed off (seed, seq) so forecasts survive save/load identically.
   */
  private planNext(): void {
    const rng = new RNG(hash32((this.seed ^ ((this.seq + 1) * 0x9e3779b1 + 0x51ec7)) >>> 0));
    // A storm fires when its predicted hand-over time crosses the schedule.
    const predictedStart = this.clock + Math.max(0, this.dur - this.t);
    const storm = predictedStart >= this.nextStormAt;
    this.nextPlan = {
      kind: this.pickKind(rng),
      strength: storm ? STORM_STRENGTH_MIN + rng.next() * 0.1 : 0.35 + rng.next() * 0.65,
      storm,
    };
  }

  /**
   * Peek at the incoming front without advancing anything - safe to call
   * every frame for HUD warning banners.
   */
  nextFront(): WeatherForecast {
    const plan = this.nextPlan ?? { kind: this.front.kind, strength: this.front.strength, storm: false };
    return {
      kind: plan.kind,
      intensity: plan.storm ? Math.max(plan.strength, STORM_STRENGTH_MIN) : plan.strength,
      etaSec: Math.max(0, this.dur - this.t),
      storm: plan.storm,
    };
  }

  /** The fading echo of the previous front, or null when none is active. */
  residualEcho(): { kind: MemoryKind; strength: number; fade: number } | null {
    if (!this.residual) return null;
    return {
      kind: this.residual.kind,
      strength: this.residual.strength,
      fade: Math.max(0, 1 - this.residual.age / RESIDUAL_SECS),
    };
  }

  /** Seasonal drift bonus to base memory intensity at the current clock. */
  seasonalDrift(): number {
    if (this.clock <= DRIFT_DELAY_SECS) return 0;
    return Math.min(DRIFT_CAP, ((this.clock - DRIFT_DELAY_SECS) / 3600) * DRIFT_PER_HOUR);
  }

  /** Advance fronts; returns true once when the front changed. */
  update(dt: number, px: number, pz: number): boolean {
    dt = Math.max(0, dt);
    this.t += dt;
    this.clock += dt;
    this.front.cx += this.front.vx * dt;
    this.front.cz += this.front.vz * dt;
    // keep the front near the player so its influence is felt
    const dx = px - this.front.cx;
    const dz = pz - this.front.cz;
    const d = Math.hypot(dx, dz);
    if (d > this.front.radiusM) {
      this.front.cx += dx * 0.02 * dt;
      this.front.cz += dz * 0.02 * dt;
    }
    // fade out the residual echo of the previous front
    if (this.residual) {
      this.residual.age += dt;
      if (this.residual.age >= RESIDUAL_SECS) this.residual = null;
    }
    if (this.t >= this.dur) {
      const prev = this.front;
      const plan = this.nextPlan ?? { kind: prev.kind, strength: prev.strength, storm: false };
      this.seq++;
      const rng = new RNG(hash32((this.seed ^ (this.seq * 0x2545F491 + 0xC0FFEE)) >>> 0));
      this.front = this.makeFront(
        rng,
        px + rng.range(-100, 100),
        pz + rng.range(-100, 100),
        { strength: plan.strength, storm: plan.storm },
      );
      // keep the announced kind honest - the forecast already showed it
      this.front.kind = plan.kind;
      this.dur = plan.storm ? STORM_DURATION : 120 + rng.next() * 150;
      if (plan.storm) {
        this.nextStormAt = this.clock + STORM_PERIOD_MIN + rng.next() * (STORM_PERIOD_MAX - STORM_PERIOD_MIN);
      }
      this.t = 0;
      // the outgoing front leaves a 60 s fading tint echo behind
      if (prev.strength > 0.05) {
        this.residual = { kind: prev.kind, strength: prev.strength, age: 0 };
      }
      this.planNext();
      return true;
    }
    return false;
  }

  /**
   * Modify a memory sample under the current front.
   * Inside the front: intensity pushed up, kind biased toward front kind.
   * Micro-climates dampen the influence (corridors by 40%), and the
   * seasonal drift raises the base intensity floor on long sessions.
   */
  apply(sample: { kind: MemoryKind; intensity: number }, x: number, z: number, zoneOverride?: WeatherZone): void {
    const zn = zoneOverride ?? this.zone;
    const damp = ZONE_DAMPEN[zn] ?? 1;
    // seasonal drift lifts the baseline everywhere, however gently
    const drift = this.seasonalDrift();
    if (drift > 0) {
      sample.intensity = Math.min(1, sample.intensity + drift * 0.2);
    }
    const d = Math.hypot(x - this.front.cx, z - this.front.cz);
    const w = this.front.strength * damp * Math.max(0, 1 - d / this.front.radiusM);
    if (w <= 0.01) return;
    sample.intensity = Math.min(1, sample.intensity + w * 0.45);
    if (w > 0.22 && sample.kind !== MemoryKind.PERSONAL) {
      sample.kind = this.front.kind;
    }
  }

  fogTint(): [number, number, number] {
    // super-storms carry their own unnatural deep violet
    let tint: [number, number, number] = this.front.storm
      ? [STORM_TINT[0], STORM_TINT[1], STORM_TINT[2]]
      : TINTS[this.front.kind] ?? [1, 1, 1];
    // blend in the fading echo of the departed front
    const res = this.residual;

(Showing lines 100-299 of 369. Use offset=300 to continue.)

    if (res) {
      const a = res.strength * Math.max(0, 1 - res.age / RESIDUAL_SECS) * RESIDUAL_WEIGHT;
      const echo = res.kind === this.front.kind && !this.front.storm
        ? tint
        : TINTS[res.kind] ?? [1, 1, 1];
      tint = [
        tint[0] * (1 - a) + echo[0] * a,
        tint[1] * (1 - a) + echo[1] * a,
        tint[2] * (1 - a) + echo[2] * a,
      ];
    }
    return tint;
  }

  describe(): string {
    return 'front=' + this.front.kind + ' s=' + this.front.strength.toFixed(2)
      + (this.front.storm ? ' SUPERSTORM' : '')
      + (this.residual ? ' echo(' + this.residual.kind + ')' : '');
  }

  serialize(): WeatherState {
    return {
      kind: this.front.kind,
      strength: this.front.strength,
      cx: this.front.cx,
      cz: this.front.cz,
      vx: this.front.vx,
      vz: this.front.vz,
      radiusM: this.front.radiusM,
      storm: this.front.storm,
      t: this.t,
      dur: this.dur,
      clock: this.clock,
      seq: this.seq,
      nextStormAt: this.nextStormAt,
      nextPlan: this.nextPlan,
      residual: this.residual,
    };
  }

  static deserialize(seed: number, data: ReturnType<MemoryWeather['serialize']> | null): MemoryWeather {
    const w = new MemoryWeather(seed);
    if (!data) return w;
    w.front = {
      kind: data.kind,
      strength: data.strength,
      cx: data.cx,
      cz: data.cz,
      vx: data.vx,
      vz: data.vz,
      radiusM: data.radiusM,
      storm: data.storm ?? false,
    };
    w['t'] = data.t ?? 0;
    w['dur'] = data.dur ?? 150;
    w['clock'] = data.clock ?? 0;
    w['seq'] = data.seq ?? 0;
    if (data.nextStormAt === undefined) {
      // pre-depth saves: re-derive a sane storm schedule from the seed
      const rng = new RNG(seed ^ 0x57a2ff);
      w['nextStormAt'] = STORM_PERIOD_MIN + rng.next() * (STORM_PERIOD_MAX - STORM_PERIOD_MIN);
    } else {
      w['nextStormAt'] = data.nextStormAt;
    }
    w['nextPlan'] = data.nextPlan ?? null;
    w['residual'] = data.residual ?? null;
    if (!data.nextPlan) w.planNext();
    return w;
  }
}


