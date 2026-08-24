/**
 * Landmark echoes (F59): landmark rooms repeat identically exactly 7 chunks
 * apart.
 *
 * Pure model, no Babylon imports. Given a landmark descriptor, its base
 * chunk, a placement seed, and an injected occupancy check, this module
 * derives the landmark's echo placements: every candidate chunk at exactly
 * +/- ECHO_SPACING_CHUNKS on BOTH axes from the base that passes the
 * occupancy check. Each echo reuses the SAME descriptor object byte-for-byte
 * — same id, name, props, and lights — so echoed rooms render identically to
 * the original by construction. Candidates that fail the occupancy check are
 * skipped; the visit order of the candidates is shuffled deterministically
 * from (seed, descriptor id, base chunk), so the accepted set and its order
 * replay identically for the same seed.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';
import { CHUNK_SIZE } from './constants';

/** Echo distance in chunks, per axis. Fixed by F59's spacing invariant. */
export const ECHO_SPACING_CHUNKS = 7;

/** Salt so echo-order draws never correlate with any other feature. */
const ORDER_SALT = 0x3c40;

/** One light fixture as a descriptor carries it. Positions are room-local meters. */
export interface LightSpec {
  /** Fixture kind, e.g. 'fluoro' or 'bare-bulb'. */
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Full identity of a landmark room. Echoes reuse one instance of this
 * byte-for-byte; nothing here is re-rolled per echo.
 */
export interface LandmarkDescriptor {
  /** Stable landmark identity threaded into placement seeds. */
  readonly id: string;
  /** Display name, identical at base and echoes. */
  readonly name: string;
  /** Prop manifest, identical at base and echoes. */
  readonly props: readonly string[];
  /** Light fixtures, identical at base and echoes. */
  readonly lights: readonly LightSpec[];
}

/** Injected occupancy gate deciding whether a chunk may host an echo. */
export interface OccupancyCheck {
  /**
   * True when chunk (chunkX, chunkZ) can host a landmark echo without
   * conflicting with already-placed world content. Pure predicate.
   */
  canHost: (chunkX: number, chunkZ: number) => boolean;
}

/** A landmark's base placement before echoes are derived. */
export interface LandmarkPlacement {
  /** The landmark's full descriptor, reused verbatim at every echo. */
  readonly descriptor: LandmarkDescriptor;
  /** Base chunk coordinate along x. */
  readonly baseChunkX: number;
  /** Base chunk coordinate along z. */
  readonly baseChunkZ: number;
}

/** One accepted echo of a landmark. */
export interface LandmarkEcho {
  /** The SAME descriptor object as the base placement (reference-equal). */
  readonly descriptor: LandmarkDescriptor;
  /** Chunk coordinate along x; exactly baseChunkX +/- ECHO_SPACING_CHUNKS. */
  readonly chunkX: number;
  /** Chunk coordinate along z; exactly baseChunkZ +/- ECHO_SPACING_CHUNKS. */
  readonly chunkZ: number;
  /** World-space x of the chunk origin in meters (chunkX * CHUNK_SIZE). */
  readonly worldX: number;
  /** World-space z of the chunk origin in meters (chunkZ * CHUNK_SIZE). */
  readonly worldZ: number;
}

/**
 * True when (chunkX, chunkZ) sits exactly ECHO_SPACING_CHUNKS away from the
 * base on BOTH axes — the F59 spacing invariant any accepted echo satisfies.
 * @param baseChunkX Base chunk along x.
 * @param baseChunkZ Base chunk along z.
 * @param chunkX Candidate chunk along x.
 * @param chunkZ Candidate chunk along z.
 */
export function isEchoSpaced(
  baseChunkX: number,
  baseChunkZ: number,
  chunkX: number,
  chunkZ: number,
): boolean {
  return (
    Math.abs(chunkX - baseChunkX) === ECHO_SPACING_CHUNKS &&
    Math.abs(chunkZ - baseChunkZ) === ECHO_SPACING_CHUNKS
  );
}

/**
 * Derive all accepted echoes for a landmark. The eight candidate chunks at
 * (+/-7, +/-7) around the base are visited in an order shuffled
 * deterministically from (seed, descriptor id, base chunk); each candidate
 * that passes the injected occupancy check becomes an echo carrying the
 * base's descriptor object itself.
 * @param placement The landmark's base placement.
 * @param occupancy Injected occupancy gate.
 * @param seed Master run seed.
 * @returns Accepted echoes in the deterministic visit order.
 * @throws When occupancy.canHost is missing or base chunk coords are not
 *   integers.
 */
export function echoPositions(
  placement: LandmarkPlacement,
  occupancy: OccupancyCheck,
  seed: number,
): LandmarkEcho[] {
  if (!placement || typeof placement.descriptor !== 'object' || placement.descriptor === null) {
    throw new Error('landmarkecho: placement.descriptor must be an object');
  }
  const { descriptor, baseChunkX, baseChunkZ } = placement;
  if (
    !Number.isInteger(baseChunkX) || !Number.isInteger(baseChunkZ)
  ) {
    throw new Error(
      `landmarkecho: base chunk (${baseChunkX}, ${baseChunkZ}) must be integer coordinates`,
    );
  }
  if (!occupancy || typeof occupancy.canHost !== 'function') {
    throw new Error('landmarkecho: occupancy.canHost must be a function');
  }
  const orderSeed = hash2i(
    hash2i(baseChunkX, baseChunkZ, seed ^ ORDER_SALT),
    seedFromString(descriptor.id),
    seed,
  );
  const rr = new RNG(orderSeed);
  // Fixed candidate set: all four diagonal offsets at exactly +/-7 chunks.
  // Fisher-Yates-shuffled with the seeded RNG before visiting.
  const candidates: Array<readonly [number, number]> = [];
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      candidates.push([sx * ECHO_SPACING_CHUNKS, sz * ECHO_SPACING_CHUNKS]);
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rr.int(0, i + 1);
    const t = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = t;
  }
  const echoes: LandmarkEcho[] = [];
  for (const [dx, dz] of candidates) {
    const chunkX = baseChunkX + dx;
    const chunkZ = baseChunkZ + dz;
    if (!occupancy.canHost(chunkX, chunkZ)) continue;
    echoes.push({
      descriptor, // same reference: byte-for-byte reuse, never a copy
      chunkX,
      chunkZ,
      worldX: chunkX * CHUNK_SIZE,
      worldZ: chunkZ * CHUNK_SIZE,
    });
  }
  return echoes;
}
