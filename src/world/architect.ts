/**
 * The Architect: decides the structure of every chunk deterministically
 * from (seed, chunk coords), warped by the Memory Contamination field.
 * Pure data - no Babylon dependencies. Authored content pools (waves,
 * arcs, graffiti) surface here through hash-selected, tag-filtered picks.
 */
import { RNG, hash2i, fbm2, rand2 } from '../core/rng';
import { CELL, CHUNK_CELLS, SALTS, EdgeCode, District } from './constants';
import { MemoryField, MemoryKind } from '../memory/field';
import { MORE_NOTES } from '../content/morenotes';
import { NOTE_WAVE3 as LEGACY_WAVE3_TEXTS } from '../content/notewave3';
import { NOTE_WAVE1 } from '../content/notes-wave1';
import { NOTE_WAVE2 } from '../content/notes-wave2';
import { NOTE_WAVE3_POOL } from '../content/notes-wave3';
import { STORY_ARCS } from '../content/clusters';
import { GRAFFITI_POOL } from '../content/graffiti-pool';
import { isEligible, pickEligible } from '../content/tags';
import type { TaggedEntry } from '../content/tags';
import { generatePocketInterior } from './pocketdim';
import type { PocketInterior, DoorFace } from './pocketdim';
import { createLongHall, rollLongHallChunk, HALL_LENGTH_M, DOOR_SPACING_M } from './longhall';
import type { LongHallDescriptor } from './longhall';
import { selectChunkGap } from './crawlspaces';
import type { GapCell } from './crawlspaces';

export interface Box2 {
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export interface LightFixture {
  x: number; z: number;
  flicker: number;
  alive: boolean;
}

export type PropKind =
  | 'desk' | 'chair' | 'cabinet' | 'sofa' | 'bed' | 'locker'
  | 'gurney' | 'bench' | 'planter' | 'turnstile' | 'crate'
  | 'stacked_chairs' | 'tv' | 'bedframe'
  | 'vending' | 'whiteboard' | 'cooler' | 'couch_l' | 'shelf'
  | 'battery';

export interface PropInstance {
  kind: PropKind;
  x: number; z: number;
  /** quarter-turn rotation */
  rot: 0 | 1 | 2 | 3;
  variant: number;
}

export interface SignInstance {
  text: string;
  x: number; z: number;
  /** wall normal direction: 0=-z 1=+z 2=-x 3=+x */
  face: 0 | 1 | 2 | 3;
  y: number;
  kind: MemoryKind;
}

export interface PuddleInstance {
  x: number; z: number; r: number;
}

export interface CeilingStainInstance {
  x: number; z: number; r: number;
}

export interface WireInstance {
  x: number; z: number; len: number;
}

export interface GraffitiInstance {
  x: number; z: number;
  face: 0 | 1 | 2 | 3;
  y: number;
  text: string;
}

export interface NoteInstance {
  x: number; z: number;
  rot: number;
  text: string;
}

/** Multi-note micro-stories found clustered in a single room. */
export const CLUSTER_STORIES: string[][] = [
  [
    'FIELD NOTE A-1: We are mapping the east wing. Reyes says the corridors repeat. I say Reyes needs sleep.',
    'FIELD NOTE A-2: The map is wrong. Or the east wing moved. We pinned the map to the wall and the wall moved the pins.',
    'FIELD NOTE A-3: I am inside the map now. The paper corridor smells like toner. If you read this, do not fold us back up.',
  ],
  [
    'INVENTORY: 14 chairs, identical. Stacked by someone with more patience than me.',
    'UPDATE: 15 chairs. I counted twice.',
    'DO NOT COUNT THE CHAIRS.',
  ],
  [
    'To the maintenance staff: the break-room fridge has been humming for nine years. Today it hummed my name.',
    'It hummed it in my mother’s cadence. She has never worked here. She has never been anywhere.',
    'Final entry: I opened the fridge. There was nothing inside but the hum, and it was mine now.',
  ],
  [
    'ORIENTATION PACKET (page 1 of 1): Welcome aboard! Your badge opens every door that remembers being locked.',
    'ORIENTATION PACKET (continued): Do not laminate your badge. Laminated badges remember being wallpaper.',
    'ORIENTATION PACKET (final): HR is in the room behind you in every photograph taken today.',
  ],
  [
    'SURVEY STATION 12 LOG: Puddles here never dry. Reyes dipped a finger in and came back with wet from a rainy day in 1996.',
    'STATION 12: The water table is a memory table. Every flood up here is someones worst afternoon leaking through.',
    'STATION 12 (last): I fell in. I am dry. But somewhere it is raining me.',
  ],
  [
    'MAINTENANCE REQUEST 88: Fluorescent unit 3F detaches nightly and patrols corridor C. Requesting backup.',
    'REQUEST 88 ADDENDUM: Backup arrived. Backup is now corridor Cs problem.',
    'REQUEST 88 CLOSED: Unit 3F has settled. It hums lower now. We think it found what it was looking for.',
  ],
  [
    'DAY ONE of the vending diet: The machine takes exact change and exact memories. Small ones only.',
    'VENDING DIET DAY NINE: I traded the smell of my grandfathers garage for a bag of chips. Worth it. I was running out of small memories.',
    'VENDING DIET DAY THIRTY: The machine returned my grandfathers garage today, unopened, plus interest. I am afraid to eat again.',
  ],
  [
    'ELEVATOR INSPECTION FORM 22-C: Car 3 answers calls from floors that do not exist. Requesting floor inventory.',
    'FORM 22-C ADDENDUM: Floor inventory complete. The building has one more floor outside than inside. Or the reverse.',
    'FORM 22-C CLOSED: We stopped calling car 3. It keeps stopping at our floor anyway. Doors open. No car.',
  ],
  [
    'NOTE FOUND IN A DESK DRAWER (not mine): The fire escape lets out onto the fire escape. Bring rope anyway.',
    'ANOTHER NOTE, SAME DRAWER: Rope was taken by prior tenant. He climbed down. The window below him was his own, from an hour earlier.',
    'LAST NOTE, DIFFERENT HANDWRITING: He is still climbing. We can hear him through the walls when we are on the stairs.',
  ],
  [
    'POOL MAINTENANCE: The water level rises 2cm per day. There is no plumbing on this level.',
    'POOL MAINTENANCE DAY 40: Swam the length. The tiles on the deep end spell a word underwater. Do not read it while swimming.',
    'POOL CLOSED: Water reached the ceiling lights today. From underneath, they look like the surface of somewhere else.',
  ],
  [
    'SECURITY LOG, NIGHT 1: Camera 9 shows a break room we demolished in 2011. The feed keeps recording it anyway. Nothing else on the loop is wrong.',
    'NIGHT 12: The monitors show rooms that do not exist yet. I started taking notes so the rooms would have somewhere to come from.',
    'NIGHT 30: Room 4-C finished building itself tonight. It matches my notebook exactly. Including the page where I wrote DO NOT.',
    'FINAL SHIFT: I am watching camera 9. Camera 9 is watching me watch it. Someone has to stay until the footage ends.',
  ],
  [
    'I found my childhood bedroom behind the vending alcove. The glow stars are in the right constellation. Nobody alive knows that but me.',
    'The bedroom again. The poster on the wall is one year older than last time. It is aging in here. I did not bring it.',
    'Measured the doorframe with my hand like when I was seven. Four hands tall, same as ever. My hand has not grown either.',
    'I slept in the bed once. For eleven seconds I woke up eight years old. Long enough to forget something important.',
  ],
  [
    'RESEARCH PROTOCOL R: Today we begin leaving written questions in occupied rooms. Sample query: WHAT ARE YOU.',
    'R-DAY 6: A reply appeared overnight, written in my handwriting: WHAT ARE YOU. Either it mocked me or it asked honestly.',
    'R-DAY 15: Revised protocol. We leave small memories on purpose, labeled. It builds gentler rooms from labeled memories. The corridors near camp have softened.',
    'R-DAY FINAL: It answered with a room instead of words. The room felt like an apology, or a copy of one. We are keeping it.',
  ],
  [
    'Heard a cough two corridors east tonight. First other person in weeks. I knocked three times on the wall, the way we did at my sister\u2019s place.',
    'The wall knocked back. Three times, then the pause, then the rhythm we used for dinner. Her name is Ada. She still remembers the signal.',
    'Nine days walking the walls toward each other. Every corridor between us was already a hallway from her old school. It was clearing a path, or rehearsing one.',
    'We met at the junction. She looked wrong the way family photos look wrong. We held hands anyway. Two memories are harder to rewrite than one.',
  ],
];

export const NOTE_TEXTS: string[] = [
  'Day 3: the vending machine only dispenses cups of warm saliva. I did not write that sentence. It appeared in my log.',
  'If you found my camp: the door I came in through is behind you now.',
  'The wallpaper pattern repeats every 41 rolls. Count them. Then stop counting them.',
  'I saw myself cross the far junction an hour before I reached it. I waved. I did not wave back.',
  'RULE: if a room feels safe, leave immediately.',
  'The hum is not electrical. It is the space rehearsing electricity.',
  'Found a photo of the parking lot. My car is in it. I have never owned a car.',
  'Do not read the notes aloud. It collects voices last.',
  'The exits are load-bearing rumors.',
  'It rebuilt her kitchen down to the chip in the mug. The chip spelled HELP.',
  'Stability protocol: count doorframes, not steps.',
  'Someone keeps folding this note into a shape I have not folded yet.',
  'Beacon crews: the cyan light is honest. Nothing else out here is.',
  'My shadow stayed in the last corridor. It looked comfortable.',
  'If the carpet is warm, you were here. If it is warm twice, you are still here.',
  'Field log, day 11: the water cooler bubbles every 9 seconds. Our office had 7.',
  'Beacon 4 went dark. Not broken. Dark, like a light someone remembered wrong.',
  'To whoever finds this: the stairwell goes down 13 steps and up 12. Trust neither count.',
  'The copier prints documents that never existed. My termination letter is dated next year.',
  'Inventory: 3 torches, 2 pens, 47m of string, one memory of a beach we all share.',
  'The hospital ward smells right but the plan is mirrored. I keep reaching left for doors.',
  'Day ??: we voted to stop naming rooms. The names kept arriving without us.',
  'Found a child\u2019s drawing of this exact corridor. Signed with my name, in her hand.',
  'The mall directory lists a store called EVERYTHING WE BROUGHT. It is on every level.',
  'Protocol amendment: if a room feels fully familiar, mark it. Recognition is how it learns.',
  'The school bell rings at 3:15 exactly. Nothing else keeps time here. We set watches by it.',
  'Reyes swears his flat had two windows. It gave him three. He has stopped correcting it.',
  'Future readers: beacons sit where the hum is loudest. Do not move them. They answer now.',
  'The platform announces stations from my old commute. One closed before I was born.',
  'We measured the same hallway twice. Both times different. Chen says memory does that too.',
  'Someone rebuilt the break room fridge exactly. Including the yogurt I threw out on day one.',
  'The waiting chairs face inward now. In my memory they faced a TV. There is no TV.',
  'If a sign knows your name, walk on. The walls only hold what we told them.',
  'Kim\u2019s ring came back wrong. She wears it anyway. Says the wrong fits better now.',
  'It takes our memories secondhand. Lately it invents its own. Check yours against a beacon.',
  'Base camp was real. I checked. Then it was elsewhere. Still real. I checked again.',
  'The library wing shelves books nobody read, in languages nobody spoke. It is guessing at us.',
  'Never sleep beside reconstructed bedrooms. You wake carrying details that are not yours.',
  'If found: crew of six, four accounted, beacons lit through sector K. Follow the cyan.',
  'It built her grandmother\u2019s porch perfectly, except the view. The view is this place.',
  'Night shift note: monitor 9 shows tomorrow\u2019s corridor already littered with our footprints. We have not walked it yet.',
  'I taped a question to a wall in an occupied room. Morning brought an answer in my own handwriting. I disagree with it.',
  'It rebuilt a bedroom from someone\u2019s childhood. Glow stars, wrong constellation. Whose childhood? Asking for a friend. The friend is me.',
  'Warning: rooms built from happy memories hum softer. Do not trust the soft ones yet.',
  'Supply list, revised: batteries, pens, one photo each. Do not let it see the photos you love most.',
  'If two of you find this separately: knock three times on the nearest wall. Keep walking. The walls carry it.',
  'Confession: I fed it a false memory on purpose. It built the lie perfectly. Now I remember the lie too.',
  'Protocol R works. Leave small labeled memories where it can reach them. The halls near my camp have stopped rearranging at night.',
  'Day count lost. The bell still rings at 3:15 whether or not there is a school.',
  'To whoever keeps replying in my handwriting: stop agreeing with me. You are confusing the archive.',
  'We found two sleeping bags zipped into one and no people. We did not unzip them.',
  'Observation: doors here open about half a second before your hand arrives. Politeness or prediction.',
  'The water fountains run colder near remembered summers.',
  'It copied my apartment radiator\u2019s clank and plays it in empty rooms, like a recording of being lived in.',
  'Memo to future crews: if you meet someone you know, verify a detail only the real one would get wrong.',
  'The ceiling tiles spell nothing. I checked for six days. Reyes says checking is how it learns to spell.',
  'Found a note addressed to me describing this exact moment. Handwriting is mine, aged twenty years.',
  'The exit signs point along the route you already walked. Behind you. Always behind you.',
  'Last personal inventory: name intact, mother\u2019s face intact, the smell of our first car gone. Fair trade. Fair trade.',
  'Ada says the space is not stealing our memories. It is practicing them. I liked it better as a thief.'
];

export interface ChunkLayout {
  cx: number;
  cz: number;
  hEdges: Uint8Array;
  vEdges: Uint8Array;
  district: District;
  lights: LightFixture[];
  props: PropInstance[];
  signs: SignInstance[];
  notes: NoteInstance[];
  puddles: PuddleInstance[];
  wires: WireInstance[];
  stains: CeilingStainInstance[];
  graffiti: GraffitiInstance[];
  /** landmark-only dressing: small flat quads (prayer cards, stains, chalk...) */
  details?: LandmarkDetailInstance[];
  /** previous-session trail points falling inside this chunk (volatile dressing) */
  pathEcho?: Array<{ x: number; z: number }>;
  shadowQuads?: Array<{ positions: number[]; normal: number[]; tints: number[] }>;
  /**
   * F24 crack-density consumer: floor-crack decals generated at build time
   * by generateFloorCrackQuads() (src/gfx/floorcracks.ts), already scaled
   * by the chunk's aging crackDensityMul. The mesher folds these into the
   * debris bucket at LOD < 1, same tint-pass contract as shadowQuads.
   */
  floorCracks?: Array<{ positions: number[]; normal: number[]; tints: number[] }>;
  /** set when this chunk contains a named landmark room */
  landmark?: string;
  /**
   * Seasonal-bleed descriptor when this landmark chunk is the session's
   * elected bleed room (see seasonrooms.ts). The mesher folds the packed
   * tint into its vertex tint pass; the particle descriptor awaits an
   * ambient-particle consumer and is exposed here for it.
   */
  seasonBleed?: import('./seasonrooms').SeasonDescriptor;
  /**
   * F51 mezzanine mount: staircase + interior descriptor when this chunk
   * passes the ~1-in-25 rarity gate (see mezzanine.ts). DATA ONLY — the
   * mesher does not consume it yet; full 3D geometry mounting (stair risers,
   * balcony ring, upper floor) is a later render pass. Generation is cached
   * by (worldSeed, chunkKey) in ChunkManager so rebuilds reuse one pair.
   */
  mezzanine?: import('./mezzanine').MezzaninePair;
  /**
   * F51 glimpse footprint: what this base chunk reserves of the upper level
   * seen through ceilings. Seed- and interior-independent (derived from the
   * chunk key alone); set on every streamed base chunk as ceiling-crack
   * view-through metadata for whichever decal pass consumes it first.
   */
  mezzGlimpse?: import('./mezzanine').GlimpseFootprint;
  /**
   * F59 landmark echo registrations for this chunk's landmark room: the
   * accepted (+/-7, +/-7) echo slots carrying the SAME descriptor object as
   * the base registration (see landmarkecho.ts). DATA ONLY — echoes are
   * registered here for consumers (minimap, journal, director); no geometry
   * is generated at the echo chunks, which render their canonical generation.
   */
  landmarkEcho?: import('./landmarkecho').LandmarkEcho[];
  /**
   * F15 pocket-dimension mount: set when this chunk hosts a seeded pocket
   * door (~1-in-40 hash gate). Carries the door identity, the constant
   * exterior footprint, and the interior laid out on its own offset sub-grid
   * (see {@link PocketMount} for the coordinate-frame transform). The mesher
   * renders the interior; the exterior edges of the chunk are untouched.
   */
  pocket?: PocketMount;
  /** F19 impossible windows on this chunk's solid walls (rare hash gate). */
  windows?: WindowInstance[];
  /** F58 sub-floor crawlspace gap selected for this chunk, when any. */
  crawlGap?: GapCell;
  /**
   * F54 Long Hall mount: set when this chunk lies inside a 300 m straight
   * corridor spawned at a gated chunk up to HALL_CHUNK_SPAN segments away.
   * Exit-door slots are carved as DOORWAY edges; which door identity hangs
   * on each BEHIND slot cycles deterministically with walked distance (see
   * longhall.ts + ChunkDeltas hall marks).
   */
  longHall?: LongHallMount;
  /** memory contamination sampled for this chunk */
  memKind: MemoryKind;
  memIntensity: number;
}

export function districtAt(seed: number, wx: number, wz: number): District {
  const n = fbm2(wx * 0.011, wz * 0.011, 3, 2, 0.55, seed ^ SALTS.district);
  // storage pockets can intrude into any large region
  const s = fbm2(wx * 0.027, wz * 0.027, 2, 2, 0.5, seed ^ SALTS.district + 41);
  if (s > 0.74) return District.STORAGE;
  if (n < 0.34) return District.MAZE;
  if (n < 0.52) return District.OPEN_OFFICE;
  if (n < 0.72) return District.HONEYCOMB;
  return District.CORRIDOR_GRID;
}

function edgeDensity(seed: number, district: District, wx: number, wz: number): number {
  const n = fbm2(wx * 0.06, wz * 0.06, 3, 2, 0.5, seed ^ SALTS.density);
  switch (district) {
    case District.MAZE: return 0.34 + n * 0.28;
    case District.OPEN_OFFICE: return 0.04 + n * 0.07;
    case District.HONEYCOMB: return 0.26 + n * 0.18;
    case District.CORRIDOR_GRID: return 0.16 + n * 0.14;
    case District.STORAGE: return 0.42 + n * 0.2; // dense canyon walls
  }
}

function decideEdge(
  seed: number, wx: number, wz: number, vertical: boolean,
  spawnSafe: boolean, memBoost: number,
): EdgeCode {
  if (spawnSafe) return EdgeCode.OPEN;
  const district = districtAt(seed, wx, wz);
  let pClose = edgeDensity(seed, district, wx, wz);

  const lat = 7;
  const gx = ((wx % lat) + lat) % lat;
  const gz = ((wz % lat) + lat) % lat;
  const onCorridorX = gx === 3 || gx === 4;
  const onCorridorZ = gz === 3 || gz === 4;

  if (district === District.CORRIDOR_GRID) {
    if (onCorridorX !== onCorridorZ) pClose *= 0.08;
    else pClose *= 1.25;
  } else {
    if (onCorridorX && !onCorridorZ && vertical) pClose *= 0.25;
    if (onCorridorZ && !onCorridorX && !vertical) pClose *= 0.25;
  }

  // memory contamination rewrites structure: more partitions, more doors
  pClose *= 1 + memBoost * 0.5;

  const prevSame = vertical
    ? rand2(wx, wz - 1, seed ^ SALTS.edgeV)
    : rand2(wx - 1, wz, seed ^ SALTS.edgeH);
  if (prevSame < pClose) pClose = Math.min(0.97, pClose * 1.6);

  const r = vertical
    ? rand2(wx, wz, seed ^ SALTS.edgeV)
    : rand2(wx, wz, seed ^ SALTS.edgeH);

  if (r >= pClose) return EdgeCode.OPEN;

  const r2 = rand2(wx, wz, seed ^ SALTS.door);
  let doorChance = district === District.HONEYCOMB ? 0.42 : 0.24;
  doorChance += memBoost * 0.25;
  if (r2 < doorChance && pClose < 0.85) return EdgeCode.DOORWAY;
  return EdgeCode.SOLID;
}

const SIGN_TEXTS: Record<number, string[]> = {
  [MemoryKind.OFFICE]: ['SUITE 214', 'CONFERENCE B', 'HR DEPT', 'EXIT ->', 'FAX ROOM', 'Q4 TARGETS', 'MEETING IN PROGRESS', 'RECORDS ANNEX', 'PARKING LEVEL B2', 'OVERTIME TONIGHT'],
  [MemoryKind.RESIDENCE]: ['KITCHEN', 'MOM IS SLEEPING', 'DO NOT ENTER', 'YOUR ROOM', 'BATH', 'LAUNDRY', 'DINING ROOM', 'THE GOOD CHINA', 'BACKYARD ->', 'WASH YOUR HANDS'],
  [MemoryKind.HOSPITAL]: ['WARD 3', 'RADIOLOGY', 'QUIET PLEASE', 'VISITING HOURS END', 'MORGUE ->', 'EMERGENCY', 'PHARMACY', 'INTENSIVE CARE', 'CHAPEL', 'NO CELL PHONES'],
  [MemoryKind.SCHOOL]: ['ROOM 112', 'GYM', 'LOCKERS', 'SCIENCE WING', 'NO RUNNING', 'LIBRARY', 'AUDITORIUM', 'PRINCIPAL', 'BUS LOOP', 'DETENTION'],
  [MemoryKind.MALL]: ['FOOD COURT', 'SEARS', 'RESTROOMS', 'CLOSED FOR REMODEL', '2ND LEVEL', 'CINEMA 8', 'ELEVATORS', 'LOST & FOUND', 'OPEN TIL 9', 'DIRECTORY'],
  [MemoryKind.TRANSIT]: ['PLATFORM 2', 'DO NOT BOARD', 'LAST TRAIN 3:33', 'EXIT ONLY', 'WAY OUT', 'STAND BEHIND LINE', 'NO EXIT', 'ARRIVALS', 'MIND THE GAP', 'TICKETS'],
  [MemoryKind.PERSONAL]: ['YOU WERE HERE', 'YOU AGAIN', 'THIS WAY HOME', 'REMEMBER?', 'YOU LIVE HERE', 'ALMOST HOME', 'STILL YOURS', 'WELCOME BACK', 'NOT YOUR HOUSE', 'YOU FORGOT THIS'],
};

/** Plain-data generation context gating stage-tagged authored content. */
export interface LayoutContext {
  /** Current StorySystem.stage; defaults to 0 when absent. */
  stage?: number;
}

export function generateLayout(seed: number, cx: number, cz: number, mem?: MemoryField, ctx?: LayoutContext): ChunkLayout {
  const N = CHUNK_CELLS;
  const centerX = (cx + 0.5) * N * CELL;
  const centerZ = (cz + 0.5) * N * CELL;

  // STRUCTURE must be eternal (seed+coords only) so chunk borders agree
  // across builds; volatile memory dresses props/lights/signs instead.
  const memStruct = mem ? mem.sampleBaseAt(centerX, centerZ) : { kind: MemoryKind.NONE as MemoryKind, intensity: 0 };
  const memSample = mem ? mem.sampleAt(centerX, centerZ) : memStruct;
  void memSample;
  const layout: ChunkLayout = {
    cx, cz,
    hEdges: new Uint8Array((N + 1) * N),
    vEdges: new Uint8Array(N * (N + 1)),
    district: districtAt(seed, centerX / CELL, centerZ / CELL),
    lights: [],
    props: [],
    signs: [],
    notes: [],
    puddles: [],
    wires: [],
    stains: [],
    graffiti: [],
    memKind: memSample.kind,
    memIntensity: memSample.intensity,
  };

  // strong STRUCTURAL memories bend districts toward enclosed room grammar
  if (memStruct.intensity > 0.45 && (memStruct.kind === MemoryKind.RESIDENCE || memStruct.kind === MemoryKind.HOSPITAL)) {
    layout.district = District.HONEYCOMB;
  }
  ensureConnectivity(layout);
  applyLandmark(seed, cx, cz, layout);

  const baseX = cx * N;
  const baseZ = cz * N;
  const spawnSafeDist = 2.2;
  // structural edge-density bias follows the eternal layer only
  const boost = Math.min(1, memStruct.intensity);

  for (let lz = 0; lz <= N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      const safe = Math.hypot(wx + 0.5, wz) < spawnSafeDist;
      layout.hEdges[lz * N + lx] = decideEdge(seed, wx, wz, false, safe, boost);
    }
  }
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx <= N; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      const safe = Math.hypot(wx, wz + 0.5) < spawnSafeDist;
      layout.vEdges[lz * (N + 1) + lx] = decideEdge(seed, wx, wz, true, safe, boost);
    }
  }

  generateLights(seed, layout);
  generateProps(seed, layout);
  generateSigns(seed, layout);
  generateNotes(seed, layout, ctx);
  generateBatteries(seed, layout);
  generatePuddles(seed, layout);
  generateWires(seed, layout);
  generateCables(seed, layout);
  generateStains(seed, layout);
  generateGraffiti(seed, layout, ctx);
  generateBleedDecals(seed, layout);
  applyLongHall(seed, layout);
  applyPocketDoors(seed, layout);
  applyWindows(seed, layout);
  applyCrawlGap(seed, layout);
  return layout;
}

// ---- WORLD WRONGNESS PASSES (F15 / F19 / F54 / F58) ------------------------
//
// Each pass is a pure function of (seed, cx, cz) plus the freshly generated
// layout: every draw flows through src/core/rng.ts hashes, so any chunk
// regenerates byte-identically in any session order. Passes only ADD
// mounts/instances - exterior edge structure decided above stays canonical
// unless the pass itself carves documented exceptions (Long Hall corridor).

/**
 * Hash-gate denominator: roughly one chunk in {@link POCKET_CHUNK_GATE}
 * hosts a seeded pocket door (F15).
 */
export const POCKET_CHUNK_GATE = 40;

/** Salt isolating pocket-door gating from every other hashed feature. */
const POCKET_GATE_SALT = 0x70d1;

/** Salt isolating the interior sub-grid origin offset from other hashes. */
const POCKET_ORIGIN_SALT = 0x0ff5;

/**
 * Base offset in world cells pushing a pocket's interior sub-grid clear of
 * the exterior world, so interior geometry can never overlap facade chunks.
 */
export const POCKET_OFFSET_CELLS = 4096;

/**
 * F15 mount for one pocket dimension hanging off a seeded door.
 *
 * Coordinate-frame transform (documented contract for player entry):
 * the interior lives on its OWN offset sub-grid. A local interior cell
 * (lx, lz) maps to world coordinates as
 *   wx = (originX + lx + 0.5) * CELL
 *   wz = (originZ + lz + 0.5) * CELL
 * Crossing the threshold re-bases the player frame by pure translation:
 *   enter(p) = entryWorld + (p - doorWorld)
 *   exit(p') = doorWorld + (p' - entryWorld)
 * where doorWorld is the door-cell centre on the exterior face and
 * entryWorld is the interior grid's border floor cell on the matching face
 * ({@link pocketEntryWorld}). Translation only - no rotation - so the
 * transform is exactly invertible for all four faces, and identical inputs
 * always yield identical frames (determinism law).
 */
export interface PocketMount {
  /** Door identity "<doorX>,<doorZ>:<face>" driving the interior stream. */
  readonly doorKey: string;
  /** Door cell along x (world cells). */
  readonly doorX: number;
  /** Door cell along z (world cells). */
  readonly doorZ: number;
  /** Exterior wall the door sits on. */
  readonly face: DoorFace;
  /** Interior layout: pure function of (worldSeed, doorKey). */
  readonly interior: PocketInterior;
  /** World-cell origin of the offset sub-grid hosting the interior. */
  readonly originX: number;
  readonly originZ: number;
}

/**
 * Border floor cell of a pocket interior for the given mount face - the
 * cell a player stands on just inside the pocket. Scans the matching border
 * row/column in ascending coordinate order, so the answer is deterministic.
 */
export function pocketEntryCell(mount: PocketMount): { x: number; z: number } {
  const it = mount.interior;
  const borderCell = (x: number, z: number) =>
    it.cells[z * it.width + x].kind === 'floor';
  switch (mount.face) {
    case 'n':
      for (let x = 0; x < it.width; x++) if (borderCell(x, 0)) return { x, z: 0 };
      break;
    case 's':
      for (let x = 0; x < it.width; x++) if (borderCell(x, it.depth - 1)) return { x, z: it.depth - 1 };
      break;
    case 'w':
      for (let z = 0; z < it.depth; z++) if (borderCell(0, z)) return { x: 0, z };
      break;
    case 'e':
      for (let z = 0; z < it.depth; z++) if (borderCell(it.width - 1, z)) return { x: it.width - 1, z };
      break;
  }
  throw new Error('pocket mount has no walkable border cell on face ' + mount.face);
}

/** World-space centre of the interior entry cell (see PocketMount transform). */
export function pocketEntryWorld(mount: PocketMount): { x: number; z: number } {
  const e = pocketEntryCell(mount);
  return { x: (mount.originX + e.x + 0.5) * CELL, z: (mount.originZ + e.z + 0.5) * CELL };
}

/**
 * Re-base a world position through the pocket threshold onto the interior
 * frame. Pure translation; see the PocketMount transform contract.
 * @param mount The chunk's pocket mount.
 * @param wx World x of the crossing position (near the exterior door).
 * @param wz World z of the crossing position.
 */
export function pocketEnter(mount: PocketMount, wx: number, wz: number): { x: number; z: number } {
  const door = { x: (mount.doorX + 0.5) * CELL, z: (mount.doorZ + 0.5) * CELL };
  const entry = pocketEntryWorld(mount);
  return { x: entry.x + (wx - door.x), z: entry.z + (wz - door.z) };
}

/**
 * Inverse of {@link pocketEnter}: map an interior-frame position back to
 * the exterior frame at the door. Exact float inverse (same translation).
 */
export function pocketExit(mount: PocketMount, wx: number, wz: number): { x: number; z: number } {
  const door = { x: (mount.doorX + 0.5) * CELL, z: (mount.doorZ + 0.5) * CELL };
  const entry = pocketEntryWorld(mount);
  return { x: door.x + (wx - entry.x), z: door.z + (wz - entry.z) };
}

/**
 * Seed and mount a pocket dimension when this chunk passes the ~1-in-40
 * gate and hosts a doorway to hang it on. The interior generates as a pure
 * function of (seed, doorKey); its furniture and lights are re-based onto
 * the offset sub-grid and pushed into the regular prop/light lists so the
 * existing mesher passes render them unchanged. Exterior edges never move.
 */
function applyPocketDoors(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  if (hash2i(layout.cx, layout.cz, seed ^ POCKET_GATE_SALT) % POCKET_CHUNK_GATE !== 11) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x9d00));
  const doors: Array<{ edge: 'h' | 'v'; lz: number; lx: number }> = [];
  for (let lz = 0; lz <= N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      if (layout.hEdges[lz * N + lx] === EdgeCode.DOORWAY) doors.push({ edge: 'h', lz, lx });
    }
  }
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx <= N; lx++) {
      if (layout.vEdges[lz * (N + 1) + lx] === EdgeCode.DOORWAY) doors.push({ edge: 'v', lz, lx });
    }
  }
  if (!doors.length) return;
  const d = doors[rng.int(0, doors.length)];
  let face: DoorFace;
  let doorX: number;
  let doorZ: number;
  if (d.edge === 'h') {
    // horizontal edge (lz,lx) separates cell (lz-1,lx) from cell (lz,lx);
    // face names which side the player approaches from
    face = rng.chance(0.5) ? 'n' : 's';
    doorX = baseX + d.lx;
    doorZ = baseZ + d.lz + (face === 'n' ? -1 : 0);
  } else {
    face = rng.chance(0.5) ? 'w' : 'e';
    doorX = baseX + d.lx + (face === 'w' ? -1 : 0);
    doorZ = baseZ + d.lz;
  }
  const doorKey = doorX + ',' + doorZ + ':' + face;
  const interior = generatePocketInterior(seed, doorKey);
  const originX =
    doorX + POCKET_OFFSET_CELLS + hash2i(doorX, doorZ, seed ^ POCKET_ORIGIN_SALT) % 2048;
  const originZ =
    doorZ + POCKET_OFFSET_CELLS + hash2i(doorZ, doorX, seed ^ (POCKET_ORIGIN_SALT ^ 1)) % 2048;
  layout.pocket = { doorKey, doorX, doorZ, face, interior, originX, originZ };
  // re-base furniture and lights onto the interior sub-grid so the regular
  // prop/fixture passes render them without special-casing
  for (const p of interior.props) {
    layout.props.push({
      kind: p.kind,
      x: (originX + p.x) * CELL,
      z: (originZ + p.z) * CELL,
      rot: p.rot,
      variant: p.variant,
    });
  }
  for (const l of interior.lights) {
    layout.lights.push({
      x: (originX + l.x) * CELL,
      z: (originZ + l.z) * CELL,
      flicker: l.flicker,
      alive: l.alive,
    });
  }
}

// ---- F19 IMPOSSIBLE WINDOWS ------------------------------------------------

/** Hash-gate denominator: roughly one chunk in 12 shows impossible windows. */
export const WINDOW_CHUNK_GATE = 12;

/** Salt isolating window gating/placement from every other hashed feature. */
const WINDOW_GATE_SALT = 0x51ad;

/** Warm lit-interior tints seen through the windows. */
const WINDOW_TINTS: readonly number[] = [
  0xffdca0, 0xf7e6c4, 0xe8f0d8, 0xd8e8f0, 0xf0d8c0,
];

/** One wall window showing a lit room interior where exterior should be. */
export interface WindowInstance {
  /** Window centre in world metres, on the wall plane. */
  readonly x: number;
  readonly z: number;
  /** Outward wall normal (SignInstance convention: 0=-z 1=+z 2=-x 3=+x). */
  readonly face: 0 | 1 | 2 | 3;
  /** Which edge array hosts the opening ('h' = hEdges, 'v' = vEdges). */
  readonly edge: 'h' | 'v';
  /** Local edge indices inside the chunk. */
  readonly lz: number;
  readonly lx: number;
  /** Packed tint of the lit interior beyond the glass. */
  readonly rgb: number;
  /** Seeded phase for whichever flicker consumer drives the glow. */
  readonly litPhase: number;
}

/**
 * Pick impossible windows for this chunk: rare by hash gate, placed only on
 * SOLID edges (a window never replaces a wall opening), at most two per
 * chunk, never near the spawn plaza. Pure function of (seed, cx, cz).
 */
function applyWindows(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  if (hash2i(layout.cx, layout.cz, seed ^ WINDOW_GATE_SALT) % WINDOW_CHUNK_GATE !== 5) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x1abd));
  const windows: WindowInstance[] = [];
  const tryEdge = (edge: 'h' | 'v', lz: number, lx: number): void => {
    if (windows.length >= 2) return;
    if ((lx + 2) * CELL + (lz + 2) * CELL < 12) return; // spawn plaza margin
    if (edge === 'h') {
      if (layout.hEdges[lz * N + lx] !== EdgeCode.SOLID) return;
      const face: 0 | 1 = rng.chance(0.5) ? 0 : 1;
      windows.push({
        x: ((layout.cx * N + lx) + 0.5) * CELL,
        z: (layout.cz * N + lz) * CELL,
        face,
        edge, lz, lx,
        rgb: WINDOW_TINTS[hash2i(lz, lx, seed ^ 0x71ab) % WINDOW_TINTS.length],
        litPhase: hash2i(lx, lz, seed ^ 0x93b1) % 8,
      });
    } else {
      if (layout.vEdges[lz * (N + 1) + lx] !== EdgeCode.SOLID) return;
      const face: 2 | 3 = rng.chance(0.5) ? 2 : 3;
      windows.push({
        x: (layout.cx * N + lx) * CELL,
        z: ((layout.cz * N + lz) + 0.5) * CELL,
        face,
        edge, lz, lx,
        rgb: WINDOW_TINTS[hash2i(lz, lx, seed ^ 0x71ab) % WINDOW_TINTS.length],
        litPhase: hash2i(lx, lz, seed ^ 0x93b1) % 8,
      });
    }
  };
  for (let attempt = 0; attempt < 24 && windows.length < 2; attempt++) {
    tryEdge('h', rng.int(0, N), rng.int(0, N));
    if (windows.length >= 2) break;
    tryEdge('v', rng.int(0, N), rng.int(0, N));
  }
  if (windows.length) layout.windows = windows;
}

// ---- F58 SUB-FLOOR CRAWLSPACES ---------------------------------------------

/**
 * Select this chunk's crawlspace gap via crawlspaces.ts selection (same
 * rate/salt as the model, so model queries agree with rendered gaps). The
 * floor predicate treats a cell as floor when any of its four edges is not
 * SOLID - sealed cells are never chosen. Gaps too close to the spawn plaza
 * are discarded: falling at first spawn would be cruelty, not wrongness.
 */
function applyCrawlGap(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  const isFloor = (wx: number, wz: number): boolean => {
    const lx = wx - baseX;
    const lz = wz - baseZ;
    if (lx < 0 || lz < 0 || lx >= N || lz >= N) return false;
    const top = lz > 0 ? layout.hEdges[lz * N + lx] : EdgeCode.SOLID;
    const bot = lz < N - 1 ? layout.hEdges[(lz + 1) * N + lx] : EdgeCode.SOLID;
    const left = lx > 0 ? layout.vEdges[lz * (N + 1) + lx] : EdgeCode.SOLID;
    const right = lx < N - 1 ? layout.vEdges[lz * (N + 1) + lx + 1] : EdgeCode.SOLID;
    return (
      top !== EdgeCode.SOLID || bot !== EdgeCode.SOLID ||
      left !== EdgeCode.SOLID || right !== EdgeCode.SOLID
    );
  };
  const gap = selectChunkGap({ chunksX: 0, chunksZ: 0, isFloor }, layout.cx, layout.cz, seed);
  if (!gap) return;
  if (Math.hypot((gap.cellX + 0.5) * CELL, (gap.cellZ + 0.5) * CELL) < 9) return;
  layout.crawlGap = gap;
}

// ---- F54 THE LONG HALL -----------------------------------------------------

/** Chunk span of one Long Hall: 300 m straight corridor over 30 m chunks. */
export const HALL_CHUNK_SPAN = HALL_LENGTH_M / (CELL * CHUNK_CELLS);

/** Stable integer index feeding rollLongHallChunk for a spawn chunk. */
function hallIndexFor(cx: number, cz: number): number {
  return ((cx & 0xffff) | ((cz & 0xffff) << 16)) | 0;
}

/** F54 mount for the segment of a Long Hall passing through this chunk. */
export interface LongHallMount {
  /** Chunk whose rarity gate spawned the hall. */
  readonly spawnCx: number;
  readonly spawnCz: number;
  /** This chunk's distance from the spawn chunk along the hall (0..span-1). */
  readonly segment: number;
  /** Halls run east-west across chunk rows. */
  readonly axis: 'x';
  /** Local row carrying the corridor inside this chunk. */
  readonly rowLz: number;
  /** Shared descriptor: seeded door order + fixed slots (see longhall.ts). */
  readonly descriptor: LongHallDescriptor;
}

/**
 * Detect and carve the Long Hall (F54). A gated spawn chunk extends a 300 m
 * straight corridor east across up to {@link HALL_CHUNK_SPAN} chunks; every
 * chunk in the span independently detects membership by probing the gates
 * of the chunks west of it, so detection is order-free and rebuild-safe.
 * Carving pins the corridor row's side walls SOLID, opens the row end to
 * end, and cuts DOORWAY exits at each slot boundary - exit positions are
 * eternal; which door identity hangs behind you cycles with walked distance
 * (longhall.ts currentExits/cycleLog, high-water mark in ChunkDeltas).
 */
function applyLongHall(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  if (layout.landmark) return;
  for (let k = 0; k < HALL_CHUNK_SPAN; k++) {
    const scx = layout.cx - k;
    const idx = hallIndexFor(scx, layout.cz);
    if (!rollLongHallChunk(seed, idx)) continue;
    const descriptor = createLongHall(seed, idx);
    if (!descriptor) continue;
    const rowLz = 3 + hash2i(scx, layout.cz, seed ^ 0x1a11) % (N - 6);
    // pin side walls, open the corridor end to end
    for (let lx = 0; lx < N; lx++) {
      layout.hEdges[rowLz * N + lx] = EdgeCode.SOLID;
      layout.hEdges[(rowLz + 1) * N + lx] = EdgeCode.SOLID;
    }
    for (let lx = 0; lx <= N; lx++) {
      layout.vEdges[rowLz * (N + 1) + lx] = EdgeCode.OPEN;
    }
    // exit-door slots every DOOR_SPACING_M from the spawn chunk's west
    // edge; slots landing on this chunk's boundary columns become DOORWAYs
    const slotCellSpacing = Math.round(DOOR_SPACING_M / CELL);
    for (let s = 0; s <= descriptor.slots.length; s++) {
      const localLx = s * slotCellSpacing - k * N;
      if (localLx !== 0 && localLx !== N) continue;
      layout.vEdges[rowLz * (N + 1) + localLx] = EdgeCode.DOORWAY;
    }
    layout.longHall = { spawnCx: scx, spawnCz: layout.cz, segment: k, axis: 'x', rowLz, descriptor };
    return;
  }
}

function inBlackout(seed: number, wx: number, wz: number): boolean {
  const n = fbm2(wx * 0.021, wz * 0.021, 2, 2, 0.5, seed ^ SALTS.blackout);
  return n > 0.76;
}

/**
 * Connectivity repair: flood-fill from the chunk centre across non-SOLID
 * edges; any unreachable interior cell gets one wall carved toward a
 * reachable neighbour. Guarantees no sealed pockets inside any district.
 * Only interior edges are touched - boundary edges stay hash-consistent.
 */
function ensureConnectivity(layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const passable = (code: number) => code !== EdgeCode.SOLID;
  const key = (lz: number, lx: number) => lz * N + lx;

  const reach = new Set<number>([key(N >> 1, N >> 1)]);
  const queue: Array<[number, number]> = [[N >> 1, N >> 1]];
  while (queue.length) {
    const [lz, lx] = queue.shift()!;
    const visit = (nlz: number, nlx: number): void => {
      const k = key(nlz, nlx);
      if (reach.has(k)) return;
      reach.add(k);
      queue.push([nlz, nlx]);
    };
    if (lz > 0 && passable(layout.hEdges[lz * N + lx])) visit(lz - 1, lx);
    if (lz < N - 1 && passable(layout.hEdges[(lz + 1) * N + lx])) visit(lz + 1, lx);
    if (lx > 0 && passable(layout.vEdges[lz * (N + 1) + lx])) visit(lz, lx - 1);
    if (lx < N - 1 && passable(layout.vEdges[lz * (N + 1) + lx + 1])) visit(lz, lx + 1);
  }

  // carve interior walls until every interior cell is reachable
  let progress = true;
  while (progress) {
    progress = false;
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        const k = key(lz, lx);
        if (reach.has(k)) continue;
        // candidate carves: interior edges only
        const candidates: Array<() => void> = [];
        if (lz > 0 && reach.has(key(lz - 1, lx)) && layout.hEdges[lz * N + lx] !== EdgeCode.OPEN) {
          candidates.push(() => { layout.hEdges[lz * N + lx] = EdgeCode.OPEN; });
        }
        if (lz < N - 1 && reach.has(key(lz + 1, lx)) && layout.hEdges[(lz + 1) * N + lx] !== EdgeCode.OPEN) {
          candidates.push(() => { layout.hEdges[(lz + 1) * N + lx] = EdgeCode.OPEN; });
        }
        if (lx > 0 && reach.has(key(lz, lx - 1)) && layout.vEdges[lz * (N + 1) + lx] !== EdgeCode.OPEN) {
          candidates.push(() => { layout.vEdges[lz * (N + 1) + lx] = EdgeCode.OPEN; });
        }
        if (lx < N - 1 && reach.has(key(lz, lx + 1)) && layout.vEdges[lz * (N + 1) + lx + 1] !== EdgeCode.OPEN) {
          candidates.push(() => { layout.vEdges[lz * (N + 1) + lx + 1] = EdgeCode.OPEN; });
        }
        if (candidates.length) {
          candidates[0]();
          reach.add(k);
          progress = true;
        }
      }
    }
  }
}

function generateLights(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const landmarkLit = !!layout.landmark;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  const deadBias = layout.memIntensity * 0.35;
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      const r = rand2(wx, wz, seed ^ SALTS.light);
      const gx = ((wx % 7) + 7) % 7;
      const gz = ((wz % 7) + 7) % 7;
      const corridor = (gx === 3 || gx === 4) !== (gz === 3 || gz === 4);
      // landmark rooms are fully lit
      if (landmarkLit) {
        layout.lights.push({ x: (wx + 0.5) * CELL, z: (wz + 0.5) * CELL, flicker: r * 100 | 0, alive: true });
        continue;
      }
      const distOrigin = Math.hypot(wx + 0.5, wz + 0.5);
      // district-specific lighting grammar
      let cellLit: boolean;
      switch (layout.district) {
        case District.OPEN_OFFICE:
          // regular bright grid with occasional gaps
          cellLit = (gx % 2 === 0 && gz % 2 === 0) || r < 0.12;
          break;
        case District.HONEYCOMB:
          // rooms lit from within: lit cells cluster near room centers
          cellLit = corridor ? r < 0.85 : r < 0.22;
          break;
        case District.CORRIDOR_GRID:
          cellLit = corridor || r < 0.15;
          break;
        default:
          cellLit = corridor ? r < 0.9 : r < 0.26;
      }
      if (distOrigin > 3.5 && !cellLit) continue;
      let alive = !inBlackout(seed, wx, wz);
      const storageDeadBias = layout.district === District.STORAGE ? 0.3 : 0;
      if (alive && rand2(wx, wz, seed ^ 0xd34d) < deadBias + storageDeadBias) alive = false;
      const flickerSeed = hash2i(wx, wz, seed ^ SALTS.flicker) % 100;
      const flicker = alive && rand2(wx, wz, seed ^ 0xf11) < layout.memIntensity * 0.5
        ? flickerSeed % 12
        : flickerSeed;
      layout.lights.push({ x: (wx + 0.5) * CELL, z: (wz + 0.5) * CELL, flicker, alive: alive || landmarkLit });
    }
  }
}

const KIND_PROPS: Record<number, PropKind[]> = {
  [MemoryKind.OFFICE]: ['desk', 'chair', 'cabinet', 'stacked_chairs', 'tv', 'crate', 'whiteboard', 'cooler'],
  [MemoryKind.RESIDENCE]: ['sofa', 'bed', 'bedframe', 'tv', 'cabinet'],
  [MemoryKind.HOSPITAL]: ['gurney', 'cabinet', 'bench', 'shelf'],
  [MemoryKind.SCHOOL]: ['locker', 'desk', 'stacked_chairs', 'bench', 'vending', 'shelf'],
  [MemoryKind.MALL]: ['bench', 'planter', 'crate', 'couch_l', 'vending'],
  [MemoryKind.TRANSIT]: ['bench', 'turnstile', 'crate'],
  [MemoryKind.NONE]: ['crate'],
  [MemoryKind.PERSONAL]: ['chair', 'tv'],
};

/** Sparse torch batteries: 1-2 per chunk, ~40% of chunks. */
function generateBatteries(seed: number, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  if ((hash2i(layout.cx, layout.cz, seed ^ 0xba77) % 100) >= 40) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0xba77));
  const count = 1 + rng.int(0, 2);
  for (let i = 0; i < count; i++) {
    const lx = rng.int(1, N - 1);
    const lz = rng.int(1, N - 1);
    layout.props.push({
      kind: 'battery',
      x: (layout.cx * N + lx + rng.range(0.3, 0.7)) * CELL,
      z: (layout.cz * N + lz + rng.range(0.3, 0.7)) * CELL,
      rot: 0,
      variant: rng.int(0, 3),
    });
  }
}

function generateProps(seed: number, layout: ChunkLayout): void {
  // landmark rooms carry their own furniture
  if (layout.landmark) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ SALTS.prop));
  let kinds = KIND_PROPS[layout.memKind] ?? ['crate'];
  // STORAGE districts impose their own hoard regardless of memory kind
  if (layout.district === District.STORAGE) {
    kinds = ['shelf', 'shelf', 'crate', 'crate', 'cabinet', 'vending', 'stacked_chairs'];
  }
  const density = layout.district === District.STORAGE ? 0.09 : 0.02 + layout.memIntensity * 0.10;
  const N = CHUNK_CELLS;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  for (let lz = 1; lz < N - 1; lz++) {
    for (let lx = 1; lx < N - 1; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      if (!rng.chance(density)) continue;
      // keep spawn plaza clear
      if (Math.hypot((wx + 0.5) * CELL, (wz + 0.5) * CELL) < 9) continue;
      // STORAGE: keep lattice corridor cells clear so canyons stay walkable
      if (layout.district === District.STORAGE) {
        const gx2 = ((wx % 7) + 7) % 7;
        const gz2 = ((wz % 7) + 7) % 7;
        if (gx2 === 3 || gx2 === 4 || gz2 === 3 || gz2 === 4) continue;
      }
      // never block doorways: skip cells touching a doorway edge
      const touchesDoorway =
        layout.hEdges[lz * N + lx] === EdgeCode.DOORWAY ||
        layout.hEdges[(lz + 1) * N + lx] === EdgeCode.DOORWAY ||
        layout.vEdges[lz * (N + 1) + lx] === EdgeCode.DOORWAY ||
        layout.vEdges[lz * (N + 1) + lx + 1] === EdgeCode.DOORWAY;
      if (touchesDoorway) continue;
      const kind = rng.pick(kinds);
      layout.props.push({
        kind,
        x: (wx + rng.range(0.28, 0.72)) * CELL,
        z: (wz + rng.range(0.28, 0.72)) * CELL,
        rot: rng.int(0, 4) as 0 | 1 | 2 | 3,
        variant: rng.int(0, 3),
      });
      // reconsolidation signature: personal memories rebuild the player's
      // own desk-and-chair somewhere far from where they were formed
      if (layout.memKind === MemoryKind.PERSONAL && rng.chance(0.4)) {
        const bx = (wx + rng.range(0.2, 0.8)) * CELL;
        const bz = (wz + rng.range(0.2, 0.8)) * CELL;
        layout.props.push({ kind: 'desk', x: bx, z: bz, rot: 0, variant: 2 });
        layout.props.push({ kind: 'chair', x: bx, z: bz - 0.75, rot: 2, variant: 0 });
      }
    }
  }
}

/** Water stains on ceilings in wet zones. */
function generateStains(seed: number, layout: ChunkLayout): void {
  if (layout.memKind !== MemoryKind.TRANSIT && layout.memKind !== MemoryKind.HOSPITAL) return;
  const srng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x57a19));
  const sCount = srng.int(2, 6);
  const N = CHUNK_CELLS;
  for (let i = 0; i < sCount; i++) {
    layout.stains.push({
      x: (layout.cx * N + srng.range(0.5, N - 0.5)) * CELL,
      z: (layout.cz * N + srng.range(0.5, N - 0.5)) * CELL,
      r: srng.range(0.5, 1.6),
    });
  }
}

// ---- LANDMARK ROOMS: rare named set-pieces (~1 per 60 chunks) ----
const LANDMARK_KINDS = ['EXECUTIVE OFFICE', 'LAUNDRY', 'CHAPEL', 'PLAYROOM', 'CANTEEN', 'ARCHIVE', 'SECURITY STATION', 'MEDICAL BAY'] as const;
type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export function landmarkFor(cx: number, cz: number, seed: number): LandmarkKind | null {
  if ((hash2i(cx, cz, seed ^ 0x14bd) % 40) !== 7) return null;
  return LANDMARK_KINDS[hash2i(cx, cz, seed ^ 0x14be) % LANDMARK_KINDS.length];
}

/**
 * Room-specific dressing quads emitted by applyLandmark. Rendered by the
 * chunk mesher as small flat geometry; `tag` selects texture/behaviour
 * (e.g. 'static' renders emissive noise, 'flame' flickers) and `rgb` is a
 * packed 0xRRGGBB tint.
 * Horizontal decals omit `face`; wall-mounted ones use the SignInstance
 * convention for `face` (0=-z 1=+z 2=-x 3=+x wall normal).
 */
export type LandmarkDetailTag =
  | 'card' | 'blood' | 'static' | 'paper' | 'chalk' | 'book'
  | 'plate' | 'cup' | 'photo' | 'pen' | 'lint' | 'dust' | 'flame';

export interface LandmarkDetailInstance {
  x: number; z: number;
  /** quad center height above the floor */
  y: number;
  /** full width / depth of the quad */
  w: number; h: number;
  /** yaw in radians (horizontal decals only) */
  rot: number;
  /** wall normal direction for wall-mounted quads; omit for horizontal */
  face?: 0 | 1 | 2 | 3;
  /** packed tint 0xRRGGBB */
  rgb: number;
  tag: LandmarkDetailTag;
}

/** Readable prayer-card texts scattered through CHAPEL rooms. */
const PRAYER_CARDS: string[] = [
  '[PRAYER CARD] Saint of thresholds, watch whoever walks this corridor next.',
  '[PRAYER CARD] For the ones the building kept: rest somewhere else, finally.',
  '[PRAYER CARD] Deliver us from exact copies. Amen.',
];

function applyLandmark(seed: number, cx: number, cz: number, layout: ChunkLayout): void {
  const lm = landmarkFor(cx, cz, seed);
  if (!lm) return;
  layout.landmark = lm;
  const N = CHUNK_CELLS;
  // seal the perimeter, open the interior
  for (let i = 0; i < N; i++) {
    layout.hEdges[i] = EdgeCode.SOLID;                 // north boundary row
    layout.hEdges[N * N + i] = EdgeCode.SOLID;         // south boundary row
    layout.vEdges[i] = EdgeCode.SOLID;                 // west boundary col
    layout.vEdges[N * (N + 1) + i] = EdgeCode.SOLID;   // east boundary col
  }
  for (let lz = 1; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) layout.hEdges[lz * N + lx] = EdgeCode.OPEN;
  }
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 1; lx < N; lx++) layout.vEdges[lz * (N + 1) + lx] = EdgeCode.OPEN;
  }
  // two doorways on opposite walls
  const rng = new RNG(hash2i(cx, cz, seed ^ 0xd00a));
  const dn = rng.int(2, N - 3);
  layout.hEdges[dn] = EdgeCode.DOORWAY;                       // north wall
  const de = rng.int(1, N - 1);
  layout.vEdges[de * (N + 1) + N] = EdgeCode.DOORWAY;         // east wall

  const bx = cx * N * CELL;
  const bz = cz * N * CELL;

  // signage naming the room, hung inside near the doorway wall
  layout.signs.push({
    x: bx + (dn + 0.5) * CELL,
    z: bz + CELL,
    face: 0,
    y: 1.9,
    text: lm,
    kind: MemoryKind.OFFICE,
  });

  const put = (kind: PropKind, wx: number, wz: number, rot: 0 | 1 | 2 | 3 = 0, variant = 0): void => {
    layout.props.push({ kind, x: wx, z: wz, rot, variant });
  };

  // room-specific dressing quads, driven by their own deterministic rng
  const det = layout.details ?? (layout.details = []);
  const drng = new RNG(hash2i(cx, cz, seed ^ 0xdeca));
  const decal = (tag: LandmarkDetailTag, x: number, z: number, y: number,
    w: number, h: number, rgb: number, rot = 0): void => {
    det.push({ tag, x, z, y, w, h, rot, rgb });
  };
  const wallDecal = (tag: LandmarkDetailTag, face: 0 | 1 | 2 | 3, x: number,
    z: number, y: number, w: number, h: number, rgb: number): void => {
    det.push({ tag, x, z, y, w, h, rot: 0, face, rgb });
  };

  if (lm === 'EXECUTIVE OFFICE') {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const dx = bx + (3.5 + c * 3.2) * CELL / 2.5;
        const dz = bz + (3.5 + r * 2.2) * CELL / 2.5;
        put('desk', dx, dz, 0, r);
        put('chair', dx, dz + 0.85, 0, 1);
      }
    }
    put('cooler', bx + CELL, bz + CELL * (N - 1.5));
    put('cooler', bx + CELL * (N - 1.5), bz + CELL);
    for (let c = 0; c < 3; c++) put('cabinet', bx + (2 + c * 2.4) * CELL / 2.5 + CELL, bz + CELL * 0.9, 0, 1);
    // a family photo lies face-down on the corner desk: nobody wants to
    // look at it, nobody will pick it up
    const edx = bx + 3.5 * CELL / 2.5;
    const edz = bz + 3.5 * CELL / 2.5;
    decal('photo', edx + 0.44, edz - 0.16, 0.765, 0.17, 0.13, 0x2e2620, drng.range(0.2, 0.7));
    // its pen rolled off the edge and is still on the carpet
    decal('pen', edx + 0.95, edz + 0.36, 0.012, 0.14, 0.022, 0x191921, drng.range(0.8, 2.4));
  } else if (lm === 'LAUNDRY') {
    for (let r = 0; r < 4; r++) {
      put('cooler', bx + CELL * 1.4, bz + (2 + r * 1.9) * CELL / 2.5, 0, r % 3);
      put('cooler', bx + CELL * (N - 1.4), bz + (2 + r * 1.9) * CELL / 2.5, 2, (r + 1) % 3);
    }
    put('bench', bx + CELL * (N / 2), bz + CELL * (N / 2), 1, 1);
    // the second washer has been leaking since forever
    const washz = bz + (2 + 1 * 1.9) * CELL / 2.5;
    layout.puddles.push({ x: bx + CELL * 1.95, z: washz + 0.35, r: 0.85 });
    // dryer lint drifted into drifts along the machine row
    for (let i = 0; i < 9; i++) {
      decal('lint',
        bx + CELL * (1.1 + drng.range(0, 2.6)),
        bz + CELL * (1.6 + drng.range(0, N - 3.4)),
        0.012, drng.range(0.05, 0.11), drng.range(0.04, 0.09),
        0xb8b2a2, drng.next() * Math.PI);
    }
  } else if (lm === 'CHAPEL') {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        put('bench', bx + (2.5 + c * 1.9) * CELL / 2.5, bz + (3.5 + r * 1.7) * CELL / 2.5, 0, r % 3);
      }
    }
    put('shelf', bx + CELL * (N / 2), bz + CELL * 1.2, 0, 2);
    put('shelf', bx + CELL * (N / 2 + 1.2), bz + CELL * 1.2, 0, 1);
    // one votive candle by the altar shelves: flicker 13 lands in
    // LightingRig's slow-sine band, so its point light breathes warm
    const candX = bx + CELL * (N / 2 + 2.1);
    const candZ = bz + CELL * 1.5;
    layout.lights.push({ x: candX, z: candZ, flicker: 13, alive: true });
    decal('flame', candX, candZ, 0.52, 0.07, 0.1, 0xffb042);
    // prayer cards left open on the pews mid-plea
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        if (hash2i(cx * 4 + c, cz + r, seed ^ 0xca2d) % 3 !== 0) continue;
        decal('card',
          bx + (2.5 + c * 1.9) * CELL / 2.5 + drng.range(-0.28, 0.28),
          bz + (3.5 + r * 1.7) * CELL / 2.5 + drng.range(-0.1, 0.1),
          0.525, 0.1, 0.14, 0xe8e2cf, drng.range(0, Math.PI));
      }
    }
    // two legible cards dropped in the aisle
    layout.notes.push({
      x: bx + CELL * (N / 2 - 2.2), z: bz + CELL * (N / 2 + 0.8),
      rot: drng.next() * Math.PI,
      text: PRAYER_CARDS[hash2i(cx, cz, seed ^ 0x6a3d) % PRAYER_CARDS.length],
    }, {
      x: bx + CELL * (N / 2 - 1.6), z: bz + CELL * (N / 2 + 1.5),
      rot: drng.next() * Math.PI,
      text: PRAYER_CARDS[hash2i(cx, cz, seed ^ 0x6a3e) % PRAYER_CARDS.length],
    });
  } else if (lm === 'CANTEEN') {
    // two long table runs with chairs on both sides
    for (let r = 0; r < 2; r++) {
      const tz = bz + (3.5 + r * 3.4) * CELL / 2.5;
      for (let c = 0; c < 5; c++) {
        put('desk', bx + (2.2 + c * 1.9) * CELL / 2.5, tz, 0, r);
        // a few chairs were shoved back carelessly and never straightened
        const askewN = r === 0 && c === 3;
        const askewS = r === 1 && c === 1;
        put('chair', bx + (2.2 + c * 1.9) * CELL / 2.5 + (askewN ? 0.28 : askewS ? -0.24 : 0),
          tz - 0.85, askewN ? 1 : 2, c % 2);
        put('chair', bx + (2.2 + c * 1.9) * CELL / 2.5, tz + 0.85 + (askewS ? 0.26 : 0),
          askewS ? 3 : 0, c % 2);
      }
    }
    // one place still set: plate and cup untouched, waiting for someone
    const mx = bx + (2.2 + 2 * 1.9) * CELL / 2.5;
    const mz = bz + 3.5 * CELL / 2.5;
    decal('plate', mx, mz, 0.772, 0.26, 0.26, 0xdad4c8);
    decal('cup', mx + 0.24, mz - 0.14, 0.778, 0.075, 0.075, 0xbdb2a0);
    put('vending', bx + CELL * 1.3, bz + CELL * (N - 1.6), 0, 0);
    put('vending', bx + CELL * 2.4, bz + CELL * (N - 1.6), 0, 1);
    put('cooler', bx + CELL * (N - 1.4), bz + CELL * 1.4, 0, 2);
  } else if (lm === 'PLAYROOM') {
    // scattered soft shapes
    for (let i = 0; i < 10; i++) {
      put('crate', bx + rng.range(CELL * 1.5, CELL * (N - 1.5)), bz + rng.range(CELL * 1.5, CELL * (N - 1.5)), 0, i % 4);
    }
    for (let i = 0; i < 4; i++) {
      put('stacked_chairs', bx + rng.range(CELL * 2, CELL * (N - 2)), bz + rng.range(CELL * 2, CELL * (N - 2)), 0, i % 4);
    }
    for (const [px, pz] of [[1.2, 1.2], [N - 1.2, 1.2], [1.2, N - 1.2], [N - 1.2, N - 1.2]]) {
      put('planter', bx + px * CELL, bz + pz * CELL, 0, 2);
    }
    // chalk drawings at child height: bright waxy strokes on the walls,
    // none of them drawn by any child who was ever here
    const chalks: number[][] = [
      [0xe86a9a, 0x7fd84f, 0xf2c53d],   // north wall trio
      [0x6fa8f2, 0xef8f3e],             // west wall pair
      [0xc06ad8, 0x8fe05a],             // east wall pair
    ];
    chalks[0].forEach((rgb, i) => wallDecal('chalk', 1,
      bx + CELL * (1.8 + i * 2.3), bz, 0.85, 0.55, 0.42, rgb));
    chalks[1].forEach((rgb, i) => wallDecal('chalk', 3,
      bx, bz + CELL * (2.4 + i * 2.4), 0.78, 0.5, 0.38, rgb));
    chalks[2].forEach((rgb, i) => wallDecal('chalk', 2,
      bx + N * CELL, bz + CELL * (3.1 + i * 2.5), 0.92, 0.52, 0.4, rgb));
    // one crate overturned mid-play, its spilling still frozen in place
    put('crate', bx + CELL * (N / 2 + drng.range(-1, 1)), bz + CELL * (N / 2 + drng.range(-1, 1)), 0, 3);
  } else if (lm === 'SECURITY STATION') {
    for (let c = 0; c < 3; c++) put('whiteboard', bx + (2.5 + c * 1.8) * CELL / 2.5, bz + CELL * 1.1, 0, c % 3);
    // one monitor has given up on footage and shows pure static, mounted
    // on the board wall facing the duty desk
    wallDecal('static', 1, bx + (2.5 + 1 * 1.8) * CELL / 2.5, bz + CELL * 1.1, 1.42, 0.66, 0.5, 0xd8d8d8);
    // shift paperwork nobody filed, drifted across the desk top
    for (let i = 0; i < 5; i++) {
      decal('paper',
        bx + CELL * (N / 2) + drng.range(-0.55, 0.55),
        bz + CELL * 2.0 + drng.range(-0.28, 0.28),
        0.772, drng.range(0.16, 0.24), drng.range(0.22, 0.3),
        0xd9d3c2, drng.next() * Math.PI);
    }
    put('desk', bx + CELL * (N / 2), bz + CELL * 2.0, 0, 1);
    put('chair', bx + CELL * (N / 2), bz + CELL * 2.9, 0, 0);
    put('cabinet', bx + CELL * (N - 1.6), bz + CELL * (N - 1.6), 0, 1);
    put('cooler', bx + CELL * 1.3, bz + CELL * (N - 1.4), 0, 1);
  } else if (lm === 'MEDICAL BAY') {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        put('gurney', bx + (2.6 + c * 2.3) * CELL / 2.5, bz + (3.2 + r * 2.6) * CELL / 2.5, 0, (r + c) % 3);
      }
    }
    // one gurney tells the whole ward's story: dried blood pooled beneath,
    // soaked through the pad on top
    const bgx = bx + (2.6 + 1 * 2.3) * CELL / 2.5;
    const bgz = bz + 3.2 * CELL / 2.5;
    decal('blood', bgx + 0.15, bgz + 0.55, 0.006, 1.15, 0.7, 0x4a0d0d, drng.range(0, Math.PI));
    decal('blood', bgx - 0.5, bgz + 1.05, 0.007, 0.5, 0.35, 0x3c0909, drng.range(0, Math.PI));
    decal('blood', bgx, bgz - 0.1, 0.905, 0.5, 0.85, 0x571010, 0.3);
    put('cabinet', bx + CELL * (N - 1.5), bz + CELL * 1.4, 0, 1);
    // supply cabinet swung ajar: rotated footprint reads as an open door
    put('cabinet', bx + CELL * (N - 1.5), bz + CELL * (N - 1.5), 1, 2);
  } else {
    // ARCHIVE: dense shelf rows with narrow aisles
    for (let r = 0; r < 3; r++) {
      const sz = bz + (3 + r * 2.6) * CELL / 2.5;
      for (let c = 0; c < 4; c++) {
        put('shelf', bx + (2.2 + c * 1.05) * CELL / 2.5, sz, 0, (r + c) % 3);
      }
    }
    for (let c = 0; c < 3; c++) put('cabinet', bx + (2 + c * 2.6) * CELL / 2.5, bz + CELL * 1.3, 0, 2);
    // shelving casualties: spines slumped face-down into the aisles
    const bookCols = [0x6b3f2a, 0x3d5a44, 0x584a6e, 0x803430];
    for (let i = 0; i < 7; i++) {
      const r = i % 3;
      decal('book',
        bx + (2.2 + drng.range(0, 3.4)) * CELL / 2.5,
        bz + ((3 + r * 2.6) * CELL / 2.5) + (drng.chance(0.5) ? 0.45 : -0.45),
        0.009, 0.3, 0.21, bookCols[i % 4], drng.range(0, Math.PI));
    }
    // the air in here hangs thick: dense motes suspended over the stacks
    for (let i = 0; i < 16; i++) {
      decal('dust',
        bx + CELL * drng.range(1.5, N - 1.5),
        bz + CELL * drng.range(1.5, N - 1.5),
        drng.range(0.4, 2.4), 0.035, 0.035, 0xd8d2c0);
    }
  }

  // landmark rooms are fully lit, and hold a torch cell + a field note
  for (const l of layout.lights) l.alive = true;
  const crng2 = new RNG(hash2i(cx, cz, seed ^ 0xbe11));
  const story = CLUSTER_STORIES[hash2i(cx, cz, seed ^ 0x5703) % CLUSTER_STORIES.length];
  const noteIdx = hash2i(cx, cz, seed ^ 0x5704) % story.length;
  layout.props.push({ kind: 'battery', x: bx + CELL * (N / 2 + 1.4), z: bz + CELL * (N - 2), rot: 0, variant: 1 });
  layout.notes.push({
    x: bx + CELL * (N / 2 - 1.4),
    z: bz + CELL * (N - 2),
    rot: crng2.next() * Math.PI,
    text: '[FIELD NOTE] ' + story[noteIdx],
  });
}

/**
 * Selection context for authored-content filtering: the chunk's eternal
 * district and contamination kind plus the caller's story stage.
 */
function selectionContextFor(layout: ChunkLayout, ctx?: LayoutContext) {
  return { district: layout.district, memKind: layout.memKind, stage: ctx?.stage ?? 0 };
}

/** Tag-filtered arc pool: embedded stories always, tagged arcs when eligible. */
function eligibleArcTexts(layout: ChunkLayout, ctx?: LayoutContext): string[][] {
  const selCtx = selectionContextFor(layout, ctx);
  return [
    ...CLUSTER_STORIES,
    ...STORY_ARCS
      .filter((arc) => arc.beats.every((beat) => isEligible(beat, selCtx)))
      .map((arc) => arc.beats.map((beat) => beat.text)),
  ];
}

/** Untagged legacy notes restated as tag-free entries so one picker covers them. */
const LEGACY_NOTES: readonly TaggedEntry[] = [
  ...NOTE_TEXTS,
  ...MORE_NOTES,
  ...LEGACY_WAVE3_TEXTS,
].map((text) => ({ text }));

/**
 * Every standalone field document in deterministic pick order: legacy
 * untagged texts first (always eligible, so ambient notes never run dry),
 * then the three authored waves whose tags filter per chunk.
 */
const TAGGED_NOTES: readonly TaggedEntry[] = [
  ...LEGACY_NOTES,
  ...NOTE_WAVE1,
  ...NOTE_WAVE2,
  ...NOTE_WAVE3_POOL,
];

/** Salt isolating authored-note selection from every other hashed feature. */
const NOTE_SALT = 0x7e3c;

/** Salt isolating authored-graffiti selection from every other hash. */
const GRAFFITI_POOL_SALT = 0x67a1;

function generateNotes(seed: number, layout: ChunkLayout, ctx?: LayoutContext): void {
  const N = CHUNK_CELLS;
  // every ~9 chunks: a clustered micro-story (3-4 notes in one room)
  if ((hash2i(layout.cx, layout.cz, seed ^ 0xc105) % 9) === 0) {
    const crng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x57a7));
    const arcs = eligibleArcTexts(layout, ctx);
    const story = arcs[hash2i(layout.cx, layout.cz, seed ^ 0x5702) % arcs.length];
    const bx = (layout.cx * N + crng.range(3, N - 3)) * CELL;
    const bz = (layout.cz * N + crng.range(3, N - 3)) * CELL;
    for (let i = 0; i < story.length; i++) {
      layout.notes.push({
        x: bx + crng.range(-1.6, 1.6),
        z: bz + crng.range(-1.6, 1.6),
        rot: crng.next() * Math.PI * 2,
        text: '[NOTE ' + (i + 1) + '/' + story.length + '] ' + story[i],
      });
    }
    return;
  }
  // otherwise: single ambient note ~1 per 4 chunks
  if ((hash2i(layout.cx, layout.cz, seed ^ 0x0e7e) % 4) !== 0) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x4e07));
  const lx = rng.int(1, N - 1);
  const lz = rng.int(1, N - 1);
  // one hash picks across legacy + authored waves; tag filtering happens
  // inside pickEligible and the untagged head keeps the pick non-null
  const picked = pickEligible(
    TAGGED_NOTES,
    selectionContextFor(layout, ctx),
    hash2i(layout.cx, layout.cz + 91, seed ^ NOTE_SALT),
  );
  layout.notes.push({
    x: (layout.cx * N + lx + rng.range(0.3, 0.7)) * CELL,
    z: (layout.cz * N + lz + rng.range(0.3, 0.7)) * CELL,
    rot: rng.next() * Math.PI * 2,
    text: picked ? picked.text : LEGACY_NOTES[0].text,
  });
}


// ---- CONTAMINATION BLEED DECALS ------------------------------------------

/** Salt isolating bleed-decal scattering from every other hashed feature. */
const BLEED_SALT = 0x6eed;

/** Bleed-decal budget at full contamination (density scales as intensity^2). */
const BLEED_MAX_DECALS = 12;

/**
 * Stain blooms and wallpaper-peel curls where the memory field runs hot.
 * Density is proportional to memIntensity - zero contamination adds nothing,
 * saturated reconstruction zones read visibly diseased. Reuses the landmark
 * detail decal pipeline (layout.details consumed by the mesher's addDetails)
 * and the seeded-scatter placement pattern of generateStains/generateGraffiti.
 */
function generateBleedDecals(seed: number, layout: ChunkLayout): void {
  const intensity = layout.memIntensity;
  if (intensity <= 0) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ BLEED_SALT));
  const N = CHUNK_CELLS;
  const budget = intensity * intensity * BLEED_MAX_DECALS;
  let count = Math.floor(budget);
  if (rng.next() < budget - count) count++;
  const det = layout.details ?? (layout.details = []);
  for (let i = 0; i < count; i++) {
    const lx = rng.int(1, N - 1);
    const lz = rng.int(1, N - 1);
    const x = (layout.cx * N + lx + rng.range(0.2, 0.8)) * CELL;
    const z = (layout.cz * N + lz + rng.range(0.2, 0.8)) * CELL;
    // keep the spawn plaza clean like every other dressing pass
    if (Math.hypot(x, z) < 9) continue;
    if (rng.chance(0.55)) {
      // stain bloom: memory bleed soaking through the carpet
      const r = rng.range(0.22, 0.85) * (0.5 + intensity);
      det.push({
        tag: 'blood',
        x, z,
        y: 0.005,
        w: r * 2,
        h: r * rng.range(0.7, 1.4),
        rot: rng.next() * Math.PI,
        rgb: rng.chance(0.5) ? 0x241019 : 0x30160e, // bruised purple / rust brown
      });
      continue;
    }
    // wallpaper peel: pale backing curl clinging to a solid wall face
    const heIdx = lz * N + lx;
    const veIdx = lz * (N + 1) + lx;
    if (layout.hEdges[heIdx] === EdgeCode.SOLID) {
      det.push({
        tag: 'lint',
        x: x + rng.range(-0.4, 0.4),
        z: (layout.cz * N + lz) * CELL,
        y: rng.range(0.4, 1.8),
        w: rng.range(0.08, 0.26),
        h: rng.range(0.06, 0.2),
        rot: 0,
        face: rng.chance(0.5) ? 0 : 1,
        rgb: 0x8a7c55,
      });
    } else if (layout.vEdges[veIdx] === EdgeCode.SOLID) {
      det.push({
        tag: 'lint',
        x: (layout.cx * N + lx) * CELL,
        z: z + rng.range(-0.4, 0.4),
        y: rng.range(0.4, 1.8),
        w: rng.range(0.08, 0.26),
        h: rng.range(0.06, 0.2),
        rot: 0,
        face: rng.chance(0.5) ? 2 : 3,
        rgb: 0x8a7c55,
      });
    }
  }
}

/** Damp floors in transit/hospital corridors: reflective puddles. */
function generatePuddles(seed: number, layout: ChunkLayout): void {
  const wet = layout.memKind === MemoryKind.TRANSIT || layout.memKind === MemoryKind.HOSPITAL;
  if (!wet) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x9d61));
  const count = rng.int(2, 6);
  const N = CHUNK_CELLS;
  for (let i = 0; i < count; i++) {
    const lx = rng.int(0, N);
    const lz = rng.int(0, N);
    layout.puddles.push({
      x: (layout.cx * N + lx + rng.range(0.15, 0.85)) * CELL,
      z: (layout.cz * N + lz + rng.range(0.15, 0.85)) * CELL,
      r: rng.range(0.35, 1.1),
    });
  }
}

/** Dangling wire bundles: common where lights have died. */
/** Ceiling cables and pipes in STORAGE canyon chunks. */
function generateCables(seed: number, layout: ChunkLayout): void {
  if (layout.district !== District.STORAGE) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0xca61));
  const count = rng.int(3, 8);
  const N = CHUNK_CELLS;
  for (let i = 0; i < count; i++) {
    const wx = rng.int(1, N - 1);
    const wz = rng.int(0, N);
    layout.wires.push({
      x: (layout.cx * N + wx + rng.range(0.2, 0.8)) * CELL,
      z: (layout.cz * N + wz + rng.range(0.2, 0.8)) * CELL,
      len: rng.range(0.6, 2.2),
    });
  }
}

function generateWires(seed: number, layout: ChunkLayout): void {
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x817e3));
  void rng;
  // wires follow dead lights: reuse light data
  for (const l of layout.lights) {
    if (l.alive) continue;
    const r = rand2(Math.floor(l.x * 7), Math.floor(l.z * 13), seed ^ SALTS.flicker);
    if (r > 0.45) continue;
    layout.wires.push({ x: l.x + (r - 0.5) * 0.6, z: l.z + (0.5 - r) * 0.5, len: 0.5 + r * 1.4 });
  }
}

const GRAFFITI_TEXTS = [
  'GET OUT', 'IT LEARNS', 'STILL HERE', 'NOT YOUR HOME', 'WAKE UP',
  'DONT SLEEP', 'I WAS SOMEONE', 'THE WALLS COPIED ME', 'NO EXIT',
  'WHO REMEMBERS ME', 'COPIED POORLY', 'CHECK YOUR MEMORY',
  'WE COUNTED WRONG', 'THE HUM KNOWS MY NAME',
];

const KIND_GRAFFITI: Record<number, string[]> = {
  [MemoryKind.HOSPITAL]: ['WARD 6 LIES', 'NO ONE DIES HERE', 'CHECKOUT IS FOREVER', 'VISITING HOURS OVER', 'THE MIRRORS WARD BACK'],
  [MemoryKind.SCHOOL]: ['DETENTION FOREVER', 'THE BELL RANG FOR YOU', 'SHOW YOUR WORK', 'CLASS DISMISSED US', 'RECESS NEVER ENDS'],
  [MemoryKind.OFFICE]: ['Q4 NEVER ENDS', 'MEETING ROOM INFINITE', 'REPLY ALL', 'CLOCKED OUT FOREVER', 'PERFECT ATTENDANCE'],
  [MemoryKind.MALL]: ['EVERYTHING MUST GO', 'STOREWIDE CLOSING', 'YOU ARE THE DISPLAY', 'SALE ENDS NEVER', 'DIRECTORY LIES'],
  [MemoryKind.TRANSIT]: ['MIND THE GAP', 'LAST TRAIN LEFT', 'PLATFORM 0', 'NEXT STOP YOU', 'WRONG PLATFORM AGAIN'],
};

/** Scrawled marks in strongly-personal or high-contamination chunks. */
function generateGraffiti(seed: number, layout: ChunkLayout, ctx?: LayoutContext): void {
  const strong = layout.memKind === MemoryKind.PERSONAL && layout.memIntensity > 0.3;
  const heavy = layout.memIntensity > 0.62;
  if (!strong && !heavy) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x6c61));
  const count = strong ? rng.int(1, 2) : rng.chance(0.5) ? 1 : 0;
  const N = CHUNK_CELLS;
  for (let i = 0; i < count; i++) {
    const lx = rng.int(1, N - 1);
    const lz = rng.int(1, N - 1);
    // find a solid wall to scrawl on (horizontal edges preferred)
    const heIdx = lz * N + lx;
    const veIdx = lz * (N + 1) + lx;
    // authored wall texts first (tag-filtered per chunk); legacy kind
    // graffiti keeps the scrawl legible when nothing eligible remains
    const pool = KIND_GRAFFITI[layout.memKind] ?? GRAFFITI_TEXTS;
    const authored = pickEligible(
      GRAFFITI_POOL,
      selectionContextFor(layout, ctx),
      hash2i(layout.cx * 8 + i, layout.cz, seed ^ GRAFFITI_POOL_SALT),
    );
    const legacyText = pool[hash2i(layout.cx + i, layout.cz, seed) % pool.length];
    const text = authored ? authored.text : legacyText;
    if (layout.hEdges[heIdx] === EdgeCode.SOLID) {
      layout.graffiti.push({
        x: (layout.cx * N + lx + rng.range(0.25, 0.75)) * CELL,
        z: (layout.cz * N + lz) * CELL,
        face: rng.chance(0.5) ? 0 : 1,
        y: rng.range(1.2, 1.9),
        text,
      });
    } else if (layout.vEdges[veIdx] === EdgeCode.SOLID) {
      layout.graffiti.push({
        x: (layout.cx * N + lx) * CELL,
        z: (layout.cz * N + lz + rng.range(0.25, 0.75)) * CELL,
        face: rng.chance(0.5) ? 2 : 3,
        y: rng.range(1.2, 1.9),
        text,
      });
    }
  }
}

function generateSigns(seed: number, layout: ChunkLayout): void {
  if (layout.memIntensity < 0.18) return;
  const rng = new RNG(hash2i(layout.cx, layout.cz, seed ^ 0x51a1));
  const texts = SIGN_TEXTS[layout.memKind];
  if (!texts || !texts.length) return;
  const count = rng.chance(layout.memIntensity) ? rng.int(1, 3) : 0;
  const N = CHUNK_CELLS;
  for (let i = 0; i < count; i++) {
    // find an interior wall edge to hang the sign on
    const lx = rng.int(1, N - 1);
    const lz = rng.int(1, N - 1);
    const heIdx = lz * N + lx;
    const veIdx = lz * (N + 1) + lx;
    if (layout.hEdges[heIdx] === EdgeCode.SOLID) {
      layout.signs.push({
        text: rng.pick(texts),
        x: (layout.cx * N + lx + 0.5) * CELL,
        z: layout.cz * N * CELL + lz * CELL,
        face: rng.chance(0.5) ? 0 : 1,
        y: rng.range(1.5, 2.2),
        kind: layout.memKind,
      });
    } else if (layout.vEdges[veIdx] === EdgeCode.SOLID) {
      layout.signs.push({
        text: rng.pick(texts),
        x: layout.cx * N * CELL + lx * CELL,
        z: (layout.cz * N + lz + 0.5) * CELL,
        face: rng.chance(0.5) ? 2 : 3,
        y: rng.range(1.5, 2.2),
        kind: layout.memKind,
      });
    }
  }
}
