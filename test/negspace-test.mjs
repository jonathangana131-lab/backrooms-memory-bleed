/**
 * Negative-space room tests (src/world/negspace.ts, F55).
 * Standalone (no browser): transpiles rng.ts + negspace.ts into a temp dir
 * and drives the classifier directly, same idiom as longhall-test.
 *
 * Acceptance:
 *   1. collision-matches-absence - in negative rooms EVERY furniture rect
 *      blocks nothing (walkable, no collider) while flagged silhouette;
 *   2. non-negative rooms unchanged - furniture cells block movement and
 *      render no silhouette;
 *   3. seeded subset - which rooms go negative is deterministic per world
 *      seed and varies across seeds;
 *   4. serialize round-trip - JSON round trip restores deep-equal queries;
 *   5. fail loud - malformed layouts throw without partial classification.
 *
 * Run: node test/negspace-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-negspace-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/negspace.ts', 'src/world/negspace.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const ns = await import(pathToFileURL(path.join(tmp, 'src/world/negspace.mjs')).href);

// Injected layout: 6m x 4m room with three furniture footprints.
const LAYOUT = {
  roomId: 101,
  w: 6,
  h: 4,
  furnitureRects: [
    { x: 0.5, z: 0.5, w: 2, h: 1 },   // bed footprint
    { x: 4, z: 2.5, w: 1.5, h: 1 },   // desk footprint
    { x: 1, z: 3, w: 0.5, h: 0.5 },   // stool footprint
  ],
};

const WORLD_SEED = 0xabad1dea;

// Find seeds making this exact room negative and non-negative.
let negSeed = -1;
let posSeed = -1;
for (let s = 1; s < 100000 && (negSeed < 0 || posSeed < 0); s++) {
  if (negSeed < 0 && ns.isNegativeSpace(s, LAYOUT.roomId)) negSeed = s;
  if (posSeed < 0 && !ns.isNegativeSpace(s, LAYOUT.roomId)) posSeed = s;
}
check('found both a negative and non-negative seed for the room',
  negSeed > 0 && posSeed > 0);

const negCls = ns.classifyRoom(LAYOUT, negSeed);
const posCls = ns.classifyRoom(LAYOUT, posSeed);

check('classification reports its own polarity',
  negCls.negative === true && posCls.negative === false);

// ---- 1. collision matches absence ----------------------------------------
function rectCells(r) {
  const out = [];
  const nx = Math.ceil(LAYOUT.w / ns.CELL_M);
  const nz = Math.ceil(LAYOUT.h / ns.CELL_M);
  for (let cx = 0; cx < nx; cx++) {
    for (let cz = 0; cz < nz; cz++) {
      const px = cx * ns.CELL_M;
      const pz = cz * ns.CELL_M;
      if (r.x < px + ns.CELL_M && r.x + r.w > px && r.z < pz + ns.CELL_M && r.z + r.h > pz) {
        out.push([cx, cz]);
      }
    }
  }
  return out;
}

let absenceOk = true;
let silhouetteSeen = false;
let emptyOk = true;
for (const r of LAYOUT.furnitureRects) {
  for (const [cx, cz] of rectCells(r)) {
    const c = ns.cellAt(negCls, cx, cz);
    if (!c || !c.walkable || c.collider || !c.silhouette) {
      absenceOk = false;
      console.log(`  bad furniture cell ${cx},${cz}: ${JSON.stringify(c)}`);
    }
    silhouetteSeen = true;
  }
}
for (const [k, c] of Object.entries(negCls.cells)) {
  const [cx, cz] = k.split(',').map(Number);
  let covered = false;
  for (const r of LAYOUT.furnitureRects) {
    const px = cx * ns.CELL_M, pz = cz * ns.CELL_M;
    if (r.x < px + ns.CELL_M && r.x + r.w > px && r.z < pz + ns.CELL_M && r.z + r.h > pz) covered = true;
  }
  if (!covered && (c.collider || c.silhouette || !c.walkable)) emptyOk = false;
}
check('every furniture rect blocks nothing while flagged silhouette', absenceOk && silhouetteSeen);
check('empty cells are plain walkable floor (no collider, no silhouette)', emptyOk);

// ---- 2. non-negative rooms unchanged --------------------------------------
let posOk = true;
let posFurnitureSeen = false;
let posSilhouette = false;
for (const r of LAYOUT.furnitureRects) {
  for (const [cx, cz] of rectCells(r)) {
    const c = ns.cellAt(posCls, cx, cz);
    posFurnitureSeen = true;
    if (!c || c.walkable || !c.collider || c.silhouette) posOk = false;
  }
}
for (const c of Object.values(posCls.cells)) if (c.silhouette) posSilhouette = true;
check('non-negative rooms: furniture blocks movement, no silhouettes anywhere',
  posOk && posFurnitureSeen && !posSilhouette);
check('cellAt outside bounds returns undefined', ns.cellAt(negCls, 999, 999) === undefined);

// ---- 3. seeded subset determinism + variance -------------------------------
const detA = ns.classifyRoom(LAYOUT, WORLD_SEED);
const detB = ns.classifyRoom(LAYOUT, WORLD_SEED);
check('classifyRoom deterministic per world seed',
  JSON.stringify(detA) === JSON.stringify(detB));

let agree = 0;
const ROOMS = 300;
for (let roomId = 1; roomId <= ROOMS; roomId++) {
  if (ns.isNegativeSpace(WORLD_SEED, roomId) === ns.isNegativeSpace(WORLD_SEED, roomId)) agree++;
}
check('subset gate deterministic across many rooms', agree === ROOMS);

let differingSeeds = false;
for (let s2 = WORLD_SEED + 1; s2 < WORLD_SEED + 50 && !differingSeeds; s2++) {
  for (let roomId = 1; roomId <= 40; roomId++) {
    if (ns.isNegativeSpace(WORLD_SEED, roomId) !== ns.isNegativeSpace(s2, roomId)) { differingSeeds = true; break; }
  }
}
check('subset draw actually varies across world seeds', differingSeeds);

// ---- 4. serialize round-trip -------------------------------------------------
for (const cls of [negCls, posCls]) {
  const round = ns.deserializeClassification(JSON.parse(JSON.stringify(ns.serializeClassification(cls))));
  let equal = round.roomId === cls.roomId && round.negative === cls.negative && round.worldSeed === cls.worldSeed;
  if (equal) {
    for (const [k, v] of Object.entries(cls.cells)) {
      const rv = ns.cellAt(round, ...k.split(',').map(Number));
      if (!rv || rv.walkable !== v.walkable || rv.collider !== v.collider || rv.silhouette !== v.silhouette) { equal = false; break; }
    }
  }
  check(`serialize round-trip deep-equal (negative=${cls.negative})`, equal);
}

// ---- 5. fail loud on malformed layouts ---------------------------------------
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
check('non-positive extent throws', throws(() => ns.classifyRoom({ ...LAYOUT, w: 0 }, 1)));
check('rect escaping bounds throws', throws(() =>
  ns.classifyRoom({ ...LAYOUT, furnitureRects: [{ x: 5.8, z: 0, w: 2, h: 1 }] }, 1)));
check('degenerate rect throws', throws(() =>
  ns.classifyRoom({ ...LAYOUT, furnitureRects: [{ x: 0, z: 0, w: 0, h: 0 }] }, 1)));

console.log(failures === 0 ? '\nNEGSPACE_PASS' : `\nNEGSPACE_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
