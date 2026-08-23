/**
 * The Architect: decides the structure of every chunk deterministically
 * from (seed, chunk coords), warped by the Memory Contamination field.
 * Pure data - no Babylon dependencies.
 */
import { RNG, hash2i, fbm2, rand2 } from '../core/rng';
import { CELL, CHUNK_CELLS, SALTS, EdgeCode, District } from './constants';
import { MemoryField, MemoryKind } from '../memory/field';

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
  /** set when this chunk contains a named landmark room */
  landmark?: string;
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


