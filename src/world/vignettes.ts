/**
 * Environmental storytelling vignettes: small prop scenes that imply a
 * human micro-story without any text.
 *
 * Each builder is pure data - it returns PropInstances laid out in a
 * local frame around (x, z) and oriented by a quarter-turn 'rot',
 * reusing ONLY prop geometry the chunk mesher already renders (see
 * addProp in mesher.ts for footprints):
 *
 *   desk    1.50 x 0.75, top at y 0.70     chair   0.46 x 0.46
 *   bench   1.70 x 0.48                    bedframe 1.0 x 2.0 low slab
 *   crate   0.5..0.89 cube                 locker  0.45 x 0.50 x 1.92
 *   tv      0.50 x 0.45 base + screen box  cabinet 0.95 x 0.50 x 1.12
 *
 * The expanded set (10 scenes) still reuses only these kinds. Scenes that
 * would read better with dedicated geometry document their desired new
 * PropKinds inline (see NEW-KIND NOTES below); none are required today.
 */
import { CELL, CHUNK_CELLS, District, EdgeCode } from './constants';
import { RNG } from '../core/rng';
import type { ChunkLayout, PropInstance, PropKind } from './architect';
import { EXPANDED_VIGNETTE_CHANCE, districtEligibility } from './placement-expansion';

type Rot = 0 | 1 | 2 | 3;

/** One prop in the vignette local frame; (ox, oz) is the unrotated offset. */
interface Part {
  kind: PropKind;
  ox: number;
  oz: number;
  rot: Rot;
  variant?: number;
}

/** Quarter-turn a local offset and compose rotations. */
function assemble(x: number, z: number, rot: Rot, parts: readonly Part[]): PropInstance[] {
  return parts.map((p) => {
    let wx: number, wz: number;
    switch (rot) {
      case 0: wx = p.ox; wz = p.oz; break;

(Showing lines 1-40 of 345. Use offset=41 to continue.)

      case 1: wx = -p.oz; wz = p.ox; break;
      case 2: wx = -p.ox; wz = -p.oz; break;
      default: wx = p.oz; wz = -p.ox; break;
    }
    return {
      kind: p.kind,
      x: x + wx,
      z: z + wz,
      rot: ((p.rot + rot) % 4) as Rot,
      variant: p.variant ?? 0,
    };
  });
}

/**
 * Abandoned meal: a table still set, a chair shoved back and turned, a
 * second one toppled further out. Someone stood up fast and did not
 * come back for their things.
 */
export function abandonedMeal(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    { kind: 'desk', ox: 0, oz: 0, rot: 0, variant: 0 },
    // pushed back from the table, spun to face away
    { kind: 'chair', ox: 0.32, oz: 1.18, rot: 2, variant: 0 },
    // knocked over entirely
    { kind: 'chair', ox: -0.92, oz: -0.82, rot: 1, variant: 1 },
    // overturned cup / fallen plate by the table edge
    { kind: 'crate', ox: 0.94, oz: 0.34, rot: 1, variant: 0 },
  ]);
}

/**
 * Makeshift bed: a low bedframe dragged into open floor as a blanket
 * pile, with the small personal items someone kept within arm reach.
 */
export function makeshiftBed(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    { kind: 'bedframe', ox: 0, oz: 0, rot: 0, variant: 0 },
    // kept belongings, close enough to touch lying down
    { kind: 'crate', ox: 0.86, oz: 0.58, rot: 0, variant: 1 },
    { kind: 'crate', ox: 0.78, oz: -0.38, rot: 2, variant: 0 },
  ]);
}

/**
 * Research station: work desk with the chair still tucked in, records
 * cabinet alongside, paper boxes fanned across the floor. Whatever was
 * being studied, the study stopped mid-sentence.
 */
export function researchStation(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    { kind: 'desk', ox: 0, oz: 0, rot: 0, variant: 2 },
    { kind: 'chair', ox: 0, oz: 0.98, rot: 0, variant: 0 },
    { kind: 'cabinet', ox: -1.32, oz: 0, rot: 0, variant: 0 },
    // fanned-out paperwork
    { kind: 'crate', ox: 1.02, oz: 0.52, rot: 1, variant: 0 },
    { kind: 'crate', ox: 0.62, oz: -0.88, rot: 3, variant: 0 },
  ]);
}

/**
 * Waiting room: three benches in a row, one still holding a coat nobody
 * reclaimed, outdated magazines scattered where they slid to the floor.
 */
export function waitingRoom(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    { kind: 'bench', ox: -1.9, oz: 0, rot: 0, variant: 0 },
    { kind: 'bench', ox: 0, oz: 0, rot: 0, variant: 1 },
    { kind: 'bench', ox: 1.9, oz: 0, rot: 0, variant: 0 },
    // the coat left behind on the middle bench
    { kind: 'crate', ox: 0.32, oz: 0.56, rot: 2, variant: 0 },
    // outdated magazines, scattered
    { kind: 'crate', ox: 1.24, oz: 0.88, rot: 1, variant: 0 },
    { kind: 'crate', ox: -0.86, oz: 1.04, rot: 3, variant: 0 },
  ]);
}

/**
 * Signal shrine: a radio boxed in by a ring of unlit candles, a wire
 * mast rising behind it. Somebody believed this corner could still
 * hear something.
 */
export function signalShrine(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // the radio
    { kind: 'tv', ox: 0, oz: 0, rot: 0, variant: 0 },
    // wire-and-scrap antenna mast
    { kind: 'locker', ox: 0, oz: -0.88, rot: 0, variant: 0 },
    // unlit candles ringing the front
    { kind: 'crate', ox: -0.66, oz: 0.62, rot: 0, variant: 0 },
    { kind: 'crate', ox: -0.22, oz: 0.8, rot: 1, variant: 0 },
    { kind: 'crate', ox: 0.22, oz: 0.8, rot: 3, variant: 0 },
    { kind: 'crate', ox: 0.66, oz: 0.62, rot: 0, variant: 1 },
  ]);
}

/**
 * Bathroom stall: three tall partitions boxing a stall corner, the door
 * swung open against the entrance and never latched again.
 *
 * NEW-KIND NOTES: real stalls want 'stall_partition' (thin tall panel,
 * hip-height gap underneath) and 'stall_door' (panel hung so it can sit
 * ajar at an angle); quarter-turn 'locker' slabs stand in for both.
 */
export function bathroomStall(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // back and side partitions
    { kind: 'locker', ox: 0, oz: -0.85, rot: 0, variant: 0 },
    { kind: 'locker', ox: -0.95, oz: 0, rot: 1, variant: 0 },
    { kind: 'locker', ox: 0.95, oz: 0, rot: 1, variant: 0 },
    // door ajar: swung out perpendicular to the front opening
    { kind: 'locker', ox: -0.55, oz: 0.8, rot: 1, variant: 1 },
    // cistern block left inside
    { kind: 'crate', ox: 0, oz: -0.35, rot: 0, variant: 0 },
  ]);
}

/**
 * Elevator lobby: two closed doors meeting in a hairline seam, a call
 * button panel beside them, an out-of-service screen propped where the
 * last rider would see it.
 *
 * NEW-KIND NOTES: 'elevator_door' (wide flush metal panel) and
 * 'call_panel' (small wall-mounted button plate) plus 'hanging_sign'
 * (suspended placard) would sell this better than locker slabs, a
 * floor-standing crate and a face-down tv.
 */
export function elevatorLobby(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // paired doors, closed
    { kind: 'locker', ox: -0.52, oz: -1.15, rot: 0, variant: 0 },
    { kind: 'locker', ox: 0.52, oz: -1.15, rot: 0, variant: 0 },
    // call button panel on the wall between them
    { kind: 'crate', ox: 0, oz: -0.68, rot: 0, variant: 0 },
    // out-of-service sign facing the lobby
    { kind: 'tv', ox: 0, oz: 0.08, rot: 2, variant: 0 },
    // somebody's box, abandoned while waiting
    { kind: 'crate', ox: 0.94, oz: 0.42, rot: 1, variant: 1 },
  ]);
}

/**
 * Storage cage: three chain-link shelving runs form a U-shaped enclosure,
 * boxes still stacked inside, a padlocked hasp hanging at the open face.
 *
 * NEW-KIND NOTES: 'chainlink_panel' (open-weave wall, taller and thinner
 * than the shelf unit) and 'padlock' (fist-sized shackle box) are wanted;
 * open-backed 'shelf' runs and a small floor crate stand in.
 */
export function storageCage(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // U enclosure of mesh panels
    { kind: 'shelf', ox: 0, oz: -1.02, rot: 0, variant: 0 },
    { kind: 'shelf', ox: -1.12, oz: 0, rot: 1, variant: 0 },
    { kind: 'shelf', ox: 1.12, oz: 0, rot: 1, variant: 0 },
    // contents nobody inventoried
    { kind: 'crate', ox: -0.32, oz: -0.42, rot: 0, variant: 1 },
    { kind: 'crate', ox: 0.38, oz: -0.28, rot: 2, variant: 0 },
    // padlocked hasp at the open face
    { kind: 'crate', ox: 0, oz: 0.64, rot: 0, variant: 0 },
  ]);
}

/**
 * Break room: humming vending machine against the wall, a counter with
 * its microwave shoved alongside, chairs pushed back mid-break and one
 * turned to face nothing in particular.
 *
 * NEW-KIND NOTES: a true 'microwave' (boxy appliance with a dark window)
 * belongs on the countertop, which needs per-prop y offsets; the water-
 * cooler silhouette stands in on the floor until then.
 */
export function breakRoom(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // vending machine against the back wall
    { kind: 'vending', ox: -1.35, oz: -0.55, rot: 0, variant: 0 },
    // serving counter
    { kind: 'desk', ox: 0.65, oz: -0.55, rot: 0, variant: 0 },
    // microwave displaced off the counter onto the floor
    { kind: 'cooler', ox: 1.58, oz: -0.55, rot: 0, variant: 0 },
    // one chair tucked in, one spun away
    { kind: 'chair', ox: 0.65, oz: 0.18, rot: 0, variant: 0 },
    { kind: 'chair', ox: 0.02, oz: 0.78, rot: 2, variant: 0 },
  ]);
}

/**
 * Janitor closet: a supply shelf, the mop bucket parked half-full, spare
 * stock boxed beside it and the keyring dropped right where it slipped.
 *
 * NEW-KIND NOTES: 'mop_bucket' (cylinder on castors with a wringer post)
 * and 'keys_hanging' (hook-mounted jingling cluster at chest height,
 * needing y placement) are the honest shapes; a chunky crate variant and
 * a floor-level battery-sized glint substitute here.
 */
export function janitorCloset(x: number, z: number, rot: Rot): PropInstance[] {
  return assemble(x, z, rot, [
    // shelf of supplies
    { kind: 'shelf', ox: 0, oz: -0.92, rot: 0, variant: 0 },
    // mop bucket parked out front-left
    { kind: 'crate', ox: -0.86, oz: -0.12, rot: 1, variant: 1 },
    // boxed stock waiting to be shelved
    { kind: 'crate', ox: 0.78, oz: -0.5, rot: 0, variant: 2 },
    // the keyring, dropped just outside the door swing
    { kind: 'battery', ox: -0.38, oz: 0.34, rot: 0, variant: 0 },
  ]);
}

export interface VignetteDef {
  id: string;
  /** Builds the scene centred at (x, z), oriented by quarter-turn rot. */
  build: (x: number, z: number, rot: Rot) => PropInstance[];
}

/** All ten environmental micro-stories. */
export const VIGNETTES: readonly VignetteDef[] = [
  { id: 'abandoned_meal', build: abandonedMeal },
  { id: 'makeshift_bed', build: makeshiftBed },
  { id: 'research_station', build: researchStation },
  { id: 'waiting_room', build: waitingRoom },
  { id: 'signal_shrine', build: signalShrine },
  { id: 'bathroom_stall', build: bathroomStall },
  { id: 'elevator_lobby', build: elevatorLobby },
  { id: 'storage_cage', build: storageCage },
  { id: 'break_room', build: breakRoom },
  { id: 'janitor_closet', build: janitorCloset },
];

/** Per-suitable-chunk placement probability (rare, deliberate finds).
 * Retuned from 0.02 to 0.03 when the catalog doubled to ten scenes;
 * single source of truth lives in placement-expansion.ts. */
export const VIGNETTE_CHANCE = EXPANDED_VIGNETTE_CHANCE;

/** Districts open enough for a vignette to sit in open floor. */
const OPEN_DISTRICTS: ReadonlySet<number> = new Set([
  District.OPEN_OFFICE,
  District.HONEYCOMB,
  District.CORRIDOR_GRID,
]);

/** True when the district is eligible for a vignette at all. */
function districtOpen(district: number): boolean {
  return districtEligibility(district) > 0 && OPEN_DISTRICTS.has(district);
}

/** True when cell (lx, lz) has no closing or door edge on any side. */
function fullyOpenCell(layout: ChunkLayout, lx: number, lz: number): boolean {
  const N = CHUNK_CELLS;
  if (lx < 0 || lz < 0 || lx >= N || lz >= N) return false;
  return (
    layout.hEdges[lz * N + lx] === EdgeCode.OPEN &&
    layout.hEdges[(lz + 1) * N + lx] === EdgeCode.OPEN &&
    layout.vEdges[lz * (N + 1) + lx] === EdgeCode.OPEN &&
    layout.vEdges[lz * (N + 1) + lx + 1] === EdgeCode.OPEN
  );
}

/**
 * Rarely drops one vignette into an open area of a chunk. Deterministic
 * given (layout identity, rng state): call once per generated chunk with
 * the chunk-seeded RNG, right after generateProps. Returns true when a
 * vignette was added to layout.props.
 */
export function placeVignette(layout: ChunkLayout, rng: RNG): boolean {
  // 3 percent chance per suitable chunk - gate first, before any scanning.
  if (!rng.chance(VIGNETTE_CHANCE)) return false;
  if (layout.landmark) return false;
  if (!districtOpen(layout.district)) return false;

  const N = CHUNK_CELLS;
  const wx0 = layout.cx * N;
  const wz0 = layout.cz * N;

  // Candidate anchors: interior cells whose whole 3x3 neighbourhood is
  // open floor, far enough from spawn and clear of existing props.
  const candidates: Array<{ x: number; z: number }> = [];
  for (let lz = 2; lz < N - 2; lz++) {
    for (let lx = 2; lx < N - 2; lx++) {
      let ok = true;
      for (let dz = -1; dz <= 1 && ok; dz++) {
        for (let dx = -1; dx <= 1 && ok; dx++) {
          if (!fullyOpenCell(layout, lx + dx, lz + dz)) ok = false;
        }
      }
      if (!ok) continue;
      const x = (wx0 + lx + 0.5) * CELL;
      const z = (wz0 + lz + 0.5) * CELL;
      // keep the spawn plaza clear, mirroring generateProps (metres)
      if (Math.hypot((wx0 + lx + 0.5) * CELL, (wz0 + lz + 0.5) * CELL) < 9) continue;
      // widest vignette half-extent is ~2.8 m; demand headroom
      const crowded = layout.props.some(
        (p) => Math.abs(p.x - x) < 3.4 && Math.abs(p.z - z) < 3.4,
      );
      if (crowded) continue;
      candidates.push({ x, z });
    }
  }
  if (candidates.length === 0) return false;

  const spot = rng.pick(candidates);
  const def = rng.pick(VIGNETTES);
  const rot = rng.int(0, 4) as Rot;
  for (const p of def.build(spot.x, spot.z, rot)) layout.props.push(p);
  return true;
}


