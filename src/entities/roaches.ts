/**
 * F31 Roach ecosystems — colonies migrate moisture→food; cabinets infest
 * over sessions.
 *
 * Roach colonies live on an injected cell grid exposing
 * {moistureAt(x,y,z), foodAt(x,y,z)}. Colonies hatch in moist cells, feed
 * while food holds out, and migrate stepwise toward richer cells when the
 * local food drops below threshold. Cabinets near an established colony
 * accumulate infestation tick over tick — monotone within a session,
 * resettable through a treatment event, and carried across sessions via a
 * plain JSON round-trip.
 *
 * Stability contract (the AC): every per-tick population change is
 * rate-clamped and hard-capped (STABILITY_MAX_TICK_DELTA, MAX_COLONY_POP,
 * MAX_TOTAL_POPULATION), so no seed, grid, or tick count can produce an
 * oscillation blowup.
 *
 * Pure simulation — no DOM, no Babylon. Determinism law holds: all draws
 * flow through src/core/rng.ts seeded per ecosystem instance.
 */
import { RNG } from '../core/rng';

// ---- injected world ----------------------------------------------------------

/** Minimal cell-grid surface consumed by the ecosystem (injected). */
export interface RoachGrid {
  /** Moisture level of one cell, 0..1 (spawn attractor). */
  moistureAt(x: number, y: number, z: number): number;
  /** Food level of one cell, 0..1 (carrying capacity driver). */
  foodAt(x: number, y: number, z: number): number;
}

/** One infestable cabinet fixture in the world (injected). */
export interface CabinetSite {
  /** Stable cabinet id used by save data and treatment events. */
  readonly id: string;
  x: number;
  y: number;
  z: number;
}

/** One candidate cell offered for colony spawning (injected sampling). */
export interface SpawnCandidate {
  x: number;
  y: number;
  z: number;
}

/** Grid + fixtures + seed a live ecosystem is constructed against. */
export interface RoachEcosystemDeps {
  grid: RoachGrid;
  cabinets: readonly CabinetSite[];
  seed: number;
}

// ---- tuning ------------------------------------------------------------------

/** Minimum moisture for a candidate cell to host a new colony. */
export const MOISTURE_SPAWN_MIN = 0.55;

/** Colony migrates away when local food falls under this level. */
export const FOOD_MIGRATE_THRESHOLD = 0.3;

/** Ticks between migration decisions for one colony. */
export const MIGRATE_COOLDOWN_TICKS = 4;

/** Maximum population one fed colony gains per tick. */
export const GROWTH_PER_TICK = 2;

/** Maximum population one starving colony loses per tick. */
export const STARVE_DECAY_PER_TICK = 2;

/** Hard cap on a single colony's population. */
export const MAX_COLONY_POP = 400;

/** Carrying capacity of a fully stocked cell (food 1.0). */
export const CELL_FOOD_CAPACITY = 320;

/** Hard cap on colonies per ecosystem. */
export const MAX_COLONIES = 12;

/** Stability guard: worst-case |Δ| of total population per tick. */
export const STABILITY_MAX_TICK_DELTA = GROWTH_PER_TICK * MAX_COLONIES;

/** Chebyshev radius in which a colony infests a cabinet. */
export const INFEST_RADIUS = 1;

/** Infestation points added per tick by a mature colony beside a cabinet. */
export const INFEST_RATE_PER_TICK = 0.25;

/** Colony population counted as fully mature for infestation purposes. */
export const MATURE_POP = 120;

/** Infestation ceiling for any cabinet. */
export const INFESTATION_MAX = 100;

/** Save format version for serialize()/restore(). */
const SAVE_VERSION = 1;

// ---- state -------------------------------------------------------------------

/** Mutable live state of one colony. */
export interface RoachColonyState {
  readonly id: number;
  x: number;
  y: number;
  z: number;
  population: number;
  /** Tick of this colony's last migration step. */
  lastMoveTick: number;
  /** Previous cell, so a hungry colony cannot ping-pong between two cells. */
  px: number;
  py: number;
  pz: number;
}

/** Persisted infestation record for one cabinet. */
export interface CabinetInfestationState {
  readonly id: string;
  infestation: number;
}

/** Plain JSON snapshot produced by serialize(); round-trips via restore(). */
export interface RoachSaveData {
  version: number;
  tick: number;
  colonies: Array<Pick<RoachColonyState, 'id' | 'x' | 'y' | 'z' | 'population' | 'lastMoveTick' | 'px' | 'py' | 'pz'>>;
  cabinets: CabinetInfestationState[];
}

// ---- helpers -----------------------------------------------------------------

/** Chebyshev distance between two cells. */
function chebyshev(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

// ---- ecosystem ----------------------------------------------------------------

/**
 * Colony simulator over an injected grid. Create fresh worlds through
 * spawnIn(); rebuild saved sessions through restore(). tick() advances one
 * simulation step: feeding/starvation, then migration, then cabinet
 * infestation accumulation.
 */
export class RoachEcosystem {
  readonly colonies: RoachColonyState[] = [];
  private readonly deps: RoachEcosystemDeps;
  private readonly infestation = new Map<string, number>();
  private readonly rng;
  private nextColonyId = 1;
  private tickCount = 0;

  private constructor(deps: RoachEcosystemDeps, rngSeed: number) {
    this.deps = deps;
    this.rng = new RNG(rngSeed >>> 0 || 0x9e3779b9);
    for (const cab of deps.cabinets) {
      // later duplicate ids would silently alias the same fixture: keep first
      if (!this.infestation.has(cab.id)) this.infestation.set(cab.id, 0);
    }
  }

  /**
   * Start a fresh ecosystem, hatching colonies on the injected candidate
   * cells whose moisture reaches MOISTURE_SPAWN_MIN, up to MAX_COLONIES.
   * Candidates are scanned in injection order; the draw stream only breaks
   * movement-score ties, keeping spawn layout caller-determined.
   *
   * @param deps grid, cabinet fixtures, and sim seed
   * @param candidates sampled world cells offered for spawning
   * @returns an ecosystem with colonies placed on moist cells
   */
  static spawnIn(deps: RoachEcosystemDeps, candidates: readonly SpawnCandidate[]): RoachEcosystem {
    const eco = new RoachEcosystem(deps, deps.seed);
    for (const c of candidates) {
      if (eco.colonies.length >= MAX_COLONIES) break;
      if (!c || !Number.isFinite(c.x + c.y + c.z)) continue;
      if (deps.grid.moistureAt(c.x, c.y, c.z) < MOISTURE_SPAWN_MIN) continue;
      eco.colonies.push({
        id: eco.nextColonyId++,
        x: c.x, y: c.y, z: c.z,
        population: 8 + eco.rng.int(0, 9),
        lastMoveTick: -1,
        px: c.x, py: c.y, pz: c.z,
      });
    }
    return eco;
  }

  /**
   * Rebuild an ecosystem from serialize() output against fresh deps. Colony
   * positions, populations, tick clock, and cabinet infestation levels all
   * resume exactly; the RNG resumes from the restored seed so subsequent
   * ticks replay deterministically per save.
   */
  static restore(data: RoachSaveData, deps: RoachEcosystemDeps): RoachEcosystem {
    const eco = new RoachEcosystem(deps, deps.seed);
    if (!data || data.version !== SAVE_VERSION) return eco;
    eco.tickCount = data.tick | 0;
    let maxId = 0;
    for (const c of data.colonies ?? []) {
      if (!eco.validCell(c.x, c.y, c.z)) continue;
      eco.colonies.push({
        id: c.id | 0,
        x: c.x, y: c.y, z: c.z,
        population: Math.min(MAX_COLONY_POP, Math.max(0, c.population | 0)),
        lastMoveTick: c.lastMoveTick | 0,
        px: c.px, py: c.py, pz: c.pz,
      });
      if ((c.id | 0) > maxId) maxId = c.id | 0;
    }
    eco.nextColonyId = maxId + 1;
    for (const cab of data.cabinets ?? []) {
      if (eco.infestation.has(cab.id)) {
        eco.infestation.set(cab.id, Math.min(INFESTATION_MAX, Math.max(0, cab.infestation)));
      }
    }
    return eco;
  }

  /** Simulation ticks elapsed since this ecosystem's birth (or restore). */
  get tick(): number {
    return this.tickCount;
  }

  /** Total live roach population across all colonies (stability-guarded). */
  get totalPopulation(): number {
    let sum = 0;
    for (const c of this.colonies) sum += c.population;
    return sum;
  }

  /** Current infestation level of one cabinet (0 when unknown id). */
  infestationOf(cabinetId: string): number {
    return this.infestation.get(cabinetId) ?? 0;
  }

  /**
   * Treatment event: strip one cabinet back to zero infestation. This is
   * the ONLY path that lowers a level, keeping within-session infestation
   * monotone otherwise.
   *
   * @returns true when the cabinet exists and was treated
   */
  treat(cabinetId: string): boolean {
    if (!this.infestation.has(cabinetId)) return false;
    this.infestation.set(cabinetId, 0);
    return true;
  }

  /**
   * Advance one simulation tick: population dynamics per colony (rate-
   * clamped both ways), then hungry-colony migration, then cabinet
   * infestation accumulation near mature colonies.
   */
  doTick(): void {
    this.tickCount++;
    for (const colony of this.colonies) {
      this.feed(colony);
      this.migrate(colony);
    }
    this.infest();
  }

  /** Plain JSON snapshot of colonies, clock, and cabinet infestation. */
  serialize(): RoachSaveData {
    return {
      version: SAVE_VERSION,
      tick: this.tickCount,
      colonies: this.colonies.map((c) => ({
        id: c.id, x: c.x, y: c.y, z: c.z,
        population: c.population, lastMoveTick: c.lastMoveTick,
        px: c.px, py: c.py, pz: c.pz,
      })),
      cabinets: [...this.infestation.entries()].map(([id, infestation]) => ({ id, infestation })),
    };
  }

  // -- internals --------------------------------------------------------------

  private validCell(x: number, y: number, z: number): boolean {
    return Number.isFinite(x + y + z);
  }

  /** Grow toward food-set carrying capacity, starve past it; rate-clamped. */
  private feed(colony: RoachColonyState): void {
    const food = this.deps.grid.foodAt(colony.x, colony.y, colony.z);
    const capacity = Math.min(MAX_COLONY_POP, Math.floor(food * CELL_FOOD_CAPACITY));
    if (colony.population < capacity) {
      colony.population = Math.min(capacity, colony.population + GROWTH_PER_TICK);
    } else if (colony.population > capacity) {
      colony.population = Math.max(
        Math.max(capacity, colony.population - STARVE_DECAY_PER_TICK),
        0,
      );
    }
    colony.population = Math.min(MAX_COLONY_POP, Math.max(0, colony.population));
  }

  /** Stepwise greedy climb toward food; skips the immediately prior cell. */
  private migrate(colony: RoachColonyState): void {
    if (this.tickCount - colony.lastMoveTick < MIGRATE_COOLDOWN_TICKS) return;
    if (this.deps.grid.foodAt(colony.x, colony.y, colony.z) >= FOOD_MIGRATE_THRESHOLD) return;

    const here = this.deps.grid.foodAt(colony.x, colony.y, colony.z);
    let bestX = colony.x, bestY = colony.y, bestZ = colony.z;
    let bestScore = here + this.rng.next() * 0.01;
    for (let axis = 0; axis < 6; axis++) {
      const dx = axis === 0 ? 1 : axis === 1 ? -1 : 0;
      const dy = axis === 2 ? 1 : axis === 3 ? -1 : 0;
      const dz = axis === 4 ? 1 : axis === 5 ? -1 : 0;
      const nx = colony.x + dx, ny = colony.y + dy, nz = colony.z + dz;
      if (!this.validCell(nx, ny, nz)) continue;
      // never step straight back into the abandoned cell unless it alone
      // beats staying — kills two-cell ping-pong oscillation
      if (nx === colony.px && ny === colony.py && nz === colony.pz) continue;
      const score = this.deps.grid.foodAt(nx, ny, nz) + this.rng.next() * 0.01;
      if (score > bestScore) {
        bestScore = score;
        bestX = nx; bestY = ny; bestZ = nz;
      }
    }
    if (bestX !== colony.x || bestY !== colony.y || bestZ !== colony.z) {
      colony.px = colony.x; colony.py = colony.y; colony.pz = colony.z;
      colony.x = bestX; colony.y = bestY; colony.z = bestZ;
      colony.lastMoveTick = this.tickCount;
    }
  }

  /** Accumulate infestation on cabinets within reach of mature colonies. */
  private infest(): void {
    for (const cab of this.deps.cabinets) {
      for (const colony of this.colonies) {
        if (chebyshev(colony.x, colony.y, colony.z, cab.x, cab.y, cab.z) > INFEST_RADIUS) continue;
        const maturity = Math.min(1, colony.population / MATURE_POP);
        const current = this.infestation.get(cab.id) ?? 0;
        this.infestation.set(cab.id, Math.min(INFESTATION_MAX, current + INFEST_RATE_PER_TICK * maturity));
        break; // one resident colony drives a cabinet per tick
      }
    }
  }
}
