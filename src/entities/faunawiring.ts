/**
 * Fauna wiring: bridges the game loop to the ambient-fauna simulation.
 *
 * FaunaManager (see ./fauna) speaks the mesher's language -- corridor
 * flags and fixture lists -- but the streaming layer announces chunks as
 * architectural districts. This adapter owns the translation:
 *
 *   - onChunkBuilt(cx, cz, district, lights) maps the district to the
 *     manager's corridor flag (only CORRIDOR_GRID counts; see
 *     isCorridorDistrict) and feeds the freshly built chunk to the
 *     population lottery;
 *   - updateAll(dt, ...) forwards the per-frame tick with the player's
 *     pose, the shared collider set, the torch state wrapped into the
 *     manager's beam object, and the live fixture list;
 *   - attachAudio(ctx) hands the WebAudio context through for skitters;
 *   - resetOnNewExpedition() drops every entity between runs.
 *
 * Pure forwarding otherwise: spawning rules, budgets, and culling stay
 * in FaunaManager so the sim remains testable without the game loop.
 */

import type { Scene } from '@babylonjs/core/scene';
import { FaunaManager, type FixtureRef } from './fauna';
import type { Box2 } from '../world/architect';

/** District index whose layouts read as corridors (District.CORRIDOR_GRID). */
const CORRIDOR_DISTRICT = 3;

/**
 * Pure district -> corridor mapping. Dust devils only weather corridor
 * chunks, so this single predicate decides whether a built chunk is
 * eligible for them; roaches and moths ignore it.
 */
export function isCorridorDistrict(district: number): boolean {
  return district === CORRIDOR_DISTRICT;
}

export class FaunaWiring {
  /** The simulated fauna; exposed for census/debug overlays. */
  readonly manager: FaunaManager;
  /**
   * Seed mixed into every per-chunk placement hash. Settable so the game
   * can assign it once per expedition before chunks stream in.
   */
  worldSeed: number;

  constructor(scene: Scene, worldSeed = 0) {
    this.manager = new FaunaManager(scene);
    this.worldSeed = worldSeed;
  }

  /**
   * Called by the streaming layer after chunk (cx, cz) built as "district"
   * with its "lights". Maps district -> corridor flag and runs the
   * manager's spawn lottery for the chunk (budget caps apply).
   */
  onChunkBuilt(cx: number, cz: number, district: number, lights: ReadonlyArray<FixtureRef>): void {
    this.manager.onChunkBuilt(cx, cz, this.worldSeed, {
      corridor: isCorridorDistrict(district),
      lights,
    });
  }

  /** Optional audio hook: forwards the game's AudioContext for skitters. */
  attachAudio(ctx: AudioContext | null): void {
    this.manager.attachAudio(ctx);
  }

  /**
   * One frame. Wraps "torchOn" into the manager's beam object and forwards
   * everything else verbatim: colliders constrain roaches and dust devils;
   * "fixtures" evicts moths whose light died.
   */
  updateAll(
    dt: number,
    px: number,
    pz: number,
    yaw: number,
    colliders: readonly Box2[],
    torchOn: boolean,
    fixtures?: ReadonlyArray<FixtureRef>,
  ): void {
    this.manager.update(dt, px, pz, yaw, colliders, { on: torchOn === true }, fixtures);
  }

  /** Drop every entity for a fresh expedition; optionally reseed first. */
  resetOnNewExpedition(newSeed?: number): void {
    if (newSeed !== undefined) this.worldSeed = newSeed;
    this.manager.reset();
  }
}


