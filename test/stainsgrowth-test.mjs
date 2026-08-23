/**
 * Unit test for water stain growth (src/world/stains-growth.ts).
 * Standalone (no browser): transpiles the module into a temp dir and drives
 * it with a fake clock + fake localStorage.
 * Run: node test/stainsgrowth-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-stains-'));
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/world/stains-growth.ts', 'world/stains-growth.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'world', 'stains-growth.mjs')).href);
const { createStainGrowth, STAIN_STAGE_KEY, STAIN_AWAY_MS, MAX_STAIN_STAGE } = mod;

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

{
  // --- constants -----------------------------------------------------------
  check('localStorage key is bmb-stain-stages', STAIN_STAGE_KEY === 'bmb-stain-stages', STAIN_STAGE_KEY);
  check('away threshold is 5 minutes', STAIN_AWAY_MS === 5 * 60_000, String(STAIN_AWAY_MS));
  check('max stage is 3 (fully bloomed)', MAX_STAIN_STAGE === 3, String(MAX_STAIN_STAGE));
}

{
  // --- initial stage registration -----------------------------------------
  const sg = createStainGrowth(() => 0, new FakeStorage());
  check('unregistered stain starts at stage 0', sg.getStage('c1', 0) === 0);
  check('stage is per (chunkKey, stainIndex)', sg.getStage('c1', 2) === 0 && sg.getStage('c2', 0) === 0);
}

{
  // --- growth trigger: revisit after 5+ minutes advances one stage ---------
  let t = 0;
  const storage = new FakeStorage();
  const sg = createStainGrowth(() => t, storage);
  sg.getStage('chunkA', 0);
  sg.getStage('chunkA', 1);
  sg.getStage('chunkB', 0);

  check('first entry is not a return', sg.noteChunkEntry('chunkA') === false);
  t += STAIN_AWAY_MS - 1;
  check('quick revisit does not grow', sg.noteChunkEntry('chunkA') === false);
  check('stage unchanged before threshold', sg.getStage('chunkA', 0) === 0);

  // every entry refreshes the visit clock, so wait a full window from the
  // LAST entry before expecting growth
  t += STAIN_AWAY_MS;
  const grew = sg.noteChunkEntry('chunkA');
  check('revisit after >= 5min away grows stains', grew === true);
  check('every stain in the chunk advanced one stage',
    sg.getStage('chunkA', 0) === 1 && sg.getStage('chunkA', 1) === 1);
  check('other chunks are untouched', sg.getStage('chunkB', 0) === 0);

  // another full away period -> stage 2, then 3, then capped
  t += STAIN_AWAY_MS;
  sg.noteChunkEntry('chunkA');
  t += STAIN_AWAY_MS;
  sg.noteChunkEntry('chunkA');
  check('stain reaches fully bloomed stage 3', sg.getStage('chunkA', 0) === 3);
  t += STAIN_AWAY_MS;
  sg.noteChunkEntry('chunkA');
  check('growth caps at MAX_STAIN_STAGE', sg.getStage('chunkA', 0) === 3);
}

{
  // --- persistence across sessions -----------------------------------------
  const storage = new FakeStorage();
  let t = 0;
  const sg1 = createStainGrowth(() => t, storage);
  sg1.getStage('k', 7);
  t += STAIN_AWAY_MS;
  sg1.noteChunkEntry('k'); // first entry, registers the visit clock
  t += STAIN_AWAY_MS;
  sg1.noteChunkEntry('k'); // grows to stage 1
  t += STAIN_AWAY_MS;
  sg1.noteChunkEntry('k'); // grows to stage 2

  const sg2 = createStainGrowth(() => t, storage);
  check('stage survives a fresh session', sg2.getStage('k', 7) === 2);
  check('visit clock survives a fresh session', (() => {
    t += STAIN_AWAY_MS; // fresh instance sees persisted last-visit time
    return sg2.noteChunkEntry('k') === true;
  })());
  const raw = JSON.parse(storage.getItem(STAIN_STAGE_KEY));
  check('persisted bucket shape matches graffiti pattern',
    raw.v === 1 && typeof raw.stages === 'object' && typeof raw.visits === 'object' && raw.stages['k:7'] === 3);
}

{
  // --- visual spec ----------------------------------------------------------
  const sg = createStainGrowth(() => 0, new FakeStorage());
  const s0 = sg.getSpec(0.5, 0);
  const s1 = sg.getSpec(0.5, 1);
  const s2 = sg.getSpec(0.5, 2);
  const s3 = sg.getSpec(0.5, 3);

  check('stage 0 keeps base size', s0.radius === 1, String(s0.radius));
  check('stage 0 has no edge ring', s0.edgeDarkness === 0, String(s0.edgeDarkness));
  check('stage 3 radius multiplier is 1.6', Math.abs(s3.radius - 1.6) < 1e-9, String(s3.radius));
  check('stage 3 edge darkness is 0.4', Math.abs(s3.edgeDarkness - 0.4) < 1e-9, String(s3.edgeDarkness));
  check('radius interpolates linearly per stage',
    Math.abs(s1.radius - 1.2) < 1e-9 && Math.abs(s2.radius - 1.4) < 1e-9);
  check('edge darkness interpolates toward 0.4', s1.edgeDarkness < s2.edgeDarkness && s2.edgeDarkness < s3.edgeDarkness);
  check('colorShift spans 0..1', s0.colorShift === 0 && Math.abs(s3.colorShift - 1) < 1e-9);
  check('color shifts darker every stage', [s0.color, s1.color, s2.color, s3.color].every((c) => /^#[0-9a-f]{6}$/.test(c)));
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255); };
  check('fill color darkens monotonically',
    lum(s0.color) > lum(s1.color) && lum(s1.color) > lum(s2.color) && lum(s2.color) > lum(s3.color));

  const neg = sg.getSpec(0.5, -5);
  const big = sg.getSpec(0.5, 99);
  const frac = sg.getSpec(0.5, 2.7);
  check('out-of-range stages clamp to [0..3]', neg.radius === 1 && big.radius === 1.6);
  check('fractional stages floor', frac.radius === s2.radius && frac.edgeDarkness === s2.edgeDarkness);
}

{
  // --- robustness ------------------------------------------------------------
  const bad = new FakeStorage();
  bad.setItem(STAIN_STAGE_KEY, '{not json');
  const sg = createStainGrowth(() => 0, bad);
  check('corrupt persisted state recovers to empty', sg.getStage('x', 0) === 0);

  let t = 0;
  const sgT = createStainGrowth(() => t, new FakeStorage());
  sgT.getStage('z', 0);
  for (let i = 0; i < 5; i++) {
    t += STAIN_AWAY_MS;
    sgT.noteChunkEntry('z'); // keeps returning true; stage is what caps
  }
  check('stage stays pinned at MAX once saturated', sgT.getStage('z', 0) === 3);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


