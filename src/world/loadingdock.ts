/**
 * F60 The Loading Dock — an infinite exterior-look dock with an idling
 * engine that never arrives.
 *
 * The dock reads as the building's one honest exit: bay doors, an apron of
 * open air, a skybox where a ceiling should be. Somewhere down the approach
 * road an engine is coming to pick you up. You can hear it forever. The
 * approach intensity follows an asymptotic envelope — it rises every
 * cycle, and its ceiling sits strictly below the arrival threshold, so no
 * amount of waiting ever completes the pickup. The doors stay shut for the
 * same reason: nothing that arrives has ever been scheduled.
 *
 * Pure simulation logic (no Babylon imports). The caller mounts visuals/
 * audio and feeds the injected wait-clock: `waitSeconds` returns elapsed
 * seconds since the player entered the dock, so tests drive every reading
 * deterministically (same grounding as congregation.ts's dayPhase).
 *
 * Determinism law holds: every per-cycle draw flows through src/core/rng.ts
 * hashes keyed on (seed, cycleIndex); same seed reproduces byte-identical
 * bed parameters.
 */
import { hash2i } from '../core/rng';

// ---- tuning ------------------------------------------------------------------

/**
 * Intensity level that would mean the engine has arrived at the dock.
 * The envelope asymptotically approaches APPROACH_CEILING and can never
 * reach this value — that inequality IS the no-arrival guarantee.
 */
export const ARRIVAL_INTENSITY = 1.0;

/** Asymptotic ceiling of the approach envelope; strictly below arrival. */
export const APPROACH_CEILING = 0.85;

/**
 * Envelope time constant in seconds: intensity(t) =
 * APPROACH_CEILING * t / (t + APPROACH_TAU_SECONDS).
 */
export const APPROACH_TAU_SECONDS = 120;

/** Length of one approach swell cycle in seconds. */
export const APPROACH_CYCLE_SECONDS = 40;

/** Number of bay doors generated per dock descriptor. */
export const BAY_DOOR_COUNT = 3;

/** Salt for per-cycle engine-character draws. */
const CYCLE_SALT = 0xd0ca >>> 0;

// ---- descriptor model --------------------------------------------------------

/** One bay door on the dock's loading wall. */
export interface BayDoorDescriptor {
  /** Stable door id ('bay-0', 'bay-1', ...). */
  readonly id: string;
  /** Wall-plane position (metres, dock-local coords). */
  readonly x: number;
  readonly z: number;
  /** Facing yaw of the door (repo convention: atan2(dx, dz)). */
  readonly yaw: number;
  /** Clear opening size in metres; the door itself never opens. */
  readonly width: number;
  readonly height: number;
}

/**
 * The dock as a mountable place. `exteriorSkybox` marks that the dock
 * renders the outdoor sky instead of a ceiling — the promise of outside —
 * while every other field describes a room that behaves like inside.
 */
export interface LoadingDockDescriptor {
  /** Stable dock id ('dock-<seed hex>'). */
  readonly id: string;
  /** Seed driving door layout and engine-bed character. */
  readonly seed: number;
  /** True: render the exterior skybox above the apron. */
  readonly exteriorSkybox: boolean;
  /** Bay doors along the loading wall, ordered left to right. */
  readonly bayDoors: BayDoorDescriptor[];
  /** Open-apron depth before the skybox seam (metres). */
  readonly apronDepth: number;
}

/**
 * Build the canonical dock descriptor for a seed. Same seed returns a
 * deep-equal descriptor; different seeds jitter door placement.
 */
export function makeDockDescriptor(seed: number): LoadingDockDescriptor {
  const s = seed >>> 0;
  const bayDoors: BayDoorDescriptor[] = [];
  for (let i = 0; i < BAY_DOOR_COUNT; i++) {
    // deterministic jitter from rng.ts hashes only (no Math.random)
    const jx = (hash2i(s, i, 0x646f >>> 0) / 4294967296 - 0.5) * 2.0;
    const jz = (hash2i(s, i, 0x7a70 >>> 0) / 4294967296 - 0.5) * 0.8;
    bayDoors.push({
      id: `bay-${i}`,
      x: -6 + i * 6 + jx,
      z: jz,
      yaw: Math.PI,
      width: 3.2,
      height: 3.6,
    });
  }
  return {
    id: `dock-${s.toString(16)}`,
    seed: s,
    exteriorSkybox: true,
    bayDoors,
    apronDepth: 9 + (hash2i(s, BAY_DOOR_COUNT, 0x7072 >>> 0) % 40) / 10,
  };
}

/** Canonical plain-object projection used for serialize round-trips. */
function toPlain(d: LoadingDockDescriptor): unknown {
  return {
    id: d.id,
    seed: d.seed >>> 0,
    exteriorSkybox: d.exteriorSkybox === true,
    apronDepth: d.apronDepth,
    bayDoors: d.bayDoors.map((b) => ({
      id: b.id,
      x: b.x,
      z: b.z,
      yaw: b.yaw,
      width: b.width,
      height: b.height,
    })),
  };
}

/**
 * Serialize a descriptor to a canonical JSON string (fixed key order, so
 * equal descriptors serialize to identical bytes).
 */
export function serializeDock(d: LoadingDockDescriptor): string {
  return JSON.stringify(toPlain(d));
}

/**
 * Parse a descriptor serialized by serializeDock. Fails loud on any
 * missing field, wrong type, or non-finite number — never silently repairs.
 *
 * @throws Error when `json` is not a canonically valid dock serialization.
 */
export function deserializeDock(json: string): LoadingDockDescriptor {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('deserializeDock: not valid JSON');
  }
  const o = raw as Record<string, unknown>;
  const needNum = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`deserializeDock: bad ${field}`);
    }
    return v;
  };
  if (typeof o?.id !== 'string' || o.id.length === 0) {
    throw new Error('deserializeDock: bad id');
  }
  if (typeof o?.seed !== 'number' || !Number.isFinite(o.seed) || o.seed < 0) {
    throw new Error('deserializeDock: bad seed');
  }
  if (typeof o?.exteriorSkybox !== 'boolean') {
    throw new Error('deserializeDock: bad exteriorSkybox');
  }
  if (typeof o?.apronDepth !== 'number' || !Number.isFinite(o.apronDepth) || o.apronDepth <= 0) {
    throw new Error('deserializeDock: bad apronDepth');
  }
  if (!Array.isArray(o?.bayDoors) || o.bayDoors.length === 0) {
    throw new Error('deserializeDock: bad bayDoors');
  }
  const seen = new Set<string>();
  const bayDoors = o.bayDoors.map((b: Record<string, unknown>, i: number) => {
    if (typeof b?.id !== 'string' || b.id.length === 0) {
      throw new Error(`deserializeDock: bad bayDoors[${i}].id`);
    }
    if (seen.has(b.id)) throw new Error(`deserializeDock: duplicate bay id ${b.id}`);
    seen.add(b.id);
    return {
      id: b.id,
      x: needNum(b.x, `bayDoors[${i}].x`),
      z: needNum(b.z, `bayDoors[${i}].z`),
      yaw: needNum(b.yaw, `bayDoors[${i}].yaw`),
      width: needNum(b.width, `bayDoors[${i}].width`),
      height: needNum(b.height, `bayDoors[${i}].height`),
    };
  });
  return {
    id: o.id,
    seed: o.seed >>> 0,
    exteriorSkybox: o.exteriorSkybox,
    bayDoors,
    apronDepth: o.apronDepth,
  };
}

// ---- approach envelope ---------------------------------------------------------

/**
 * The asymptotic approach envelope at `t` seconds of waiting.
 *
 * Strictly increasing in t (derivative APPROACH_CEILING * TAU / (t+TAU)^2
 * > 0) and bounded above by APPROACH_CEILING < ARRIVAL_INTENSITY, so for
 * ANY t the engine is still approaching and has not arrived. This is the
 * mathematical form of "the engine never arrives despite indefinite
 * waiting".
 */
export function approachEnvelope(t: number): number {
  const tt = Math.max(0, t);
  return APPROACH_CEILING * (tt / (tt + APPROACH_TAU_SECONDS));
}

/** One audio-frame snapshot of the engine bed for mounting. */
export interface EngineBedParams {
  /** Asymptotic approach intensity in [0, APPROACH_CEILING). */
  readonly intensity: number;
  /** Cycle-relative swell multiplier in [0.55, 1] (idle-vs-swell texture). */
  readonly swell: number;
  /** Per-cycle engine detune in cents (deterministic per seed+cycle). */
  readonly detuneCents: number;
  /** Idle LFO rate in Hz for the low rumble. */
  readonly lfoHz: number;
  /** Bay-door rattle excitation in [0, 1] (peaks mid-cycle). */
  readonly doorRattle: number;
  /** Index of the current approach cycle. */
  readonly cycleIndex: number;
  /** Always false by construction; kept explicit for callers. */
  readonly arrived: boolean;
}

/**
 * The dock's distant engine audio bed. Construct one per session; query
 * `params()` each frame with the injected wait-clock supplying elapsed
 * seconds since dock entry. Every value is a pure function of
 * (seed, wait time), so the bed replays identically per seed.
 */
export class EngineApproachBed {
  private readonly seed: number;
  private readonly clock: () => number;

  constructor(descriptor: LoadingDockDescriptor, waitSeconds: () => number) {
    this.seed = descriptor.seed >>> 0;
    this.clock = waitSeconds;
  }

  /** Seconds waited so far, straight from the injected clock. */
  get waitSeconds(): number {
    return Math.max(0, this.clock());
  }

  /** Current asymptotic approach intensity (never reaches arrival). */
  get intensity(): number {
    return approachEnvelope(this.waitSeconds);
  }

  /** Whether the engine has arrived. False for every finite t. */
  get arrived(): boolean {
    return false;
  }

  /**
   * Envelope sampled at the END of approach cycle `n` (n >= 0). Sampling
   * once per cycle gives the AC series: strictly increasing across cycles,
   * always < APPROACH_CEILING < ARRIVAL_INTENSITY.
   */
  sampleCycleEnd(n: number): number {
    return approachEnvelope((n + 1) * APPROACH_CYCLE_SECONDS);
  }

  /**
   * Full audio-frame parameters at the current clock reading. Per-cycle
   * character draws come from hash2i(seed, cycleIndex), so two beds built
   * from equal descriptors emit byte-identical parameter streams.
   */
  params(): EngineBedParams {
    const t = this.waitSeconds;
    const cycleIndex = Math.floor(t / APPROACH_CYCLE_SECONDS);
    // swell rises through each cycle then hands off to the next: the
    // sound of an engine that keeps almost getting closer
    const phase = t / APPROACH_CYCLE_SECONDS - cycleIndex;
    const swell = 0.55 + 0.45 * phase;
    const rollA = hash2i(this.seed, cycleIndex, CYCLE_SALT);
    const rollB = hash2i(this.seed, cycleIndex, CYCLE_SALT ^ 0x1b73);
    const detuneCents = ((rollA / 4294967296) - 0.5) * 24;
    const lfoHz = 0.7 + (rollB / 4294967296) * 0.9;
    // rattle peaks when the swell peaks — the doors answer the approach
    const doorRattle = intensityPeakShape(phase) * this.intensity;
    return { intensity: this.intensity, swell, detuneCents, lfoHz, doorRattle, cycleIndex, arrived: false };
  }
}

/** Smooth peak-shaped curve in [0, 1] over phase [0, 1), peaking near 0.75. */
function intensityPeakShape(phase: number): number {
  const x = Math.min(1, Math.max(0, phase));
  return Math.pow(Math.sin(Math.PI * Math.pow(x, 0.8)), 2);
}
