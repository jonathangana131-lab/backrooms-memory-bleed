
// src/world/radioprops-mesher.ts was lost entirely in the transcript
// corruption; this restoration is pinned to the surviving assertions below:
// three boxes (body, grille, dial), neutral whites elsewhere, amber-glow
// dial vertices, and a deterministic painted face with brand + FM labels.

/**
 * RadioPropMesh tests (src/world/radioprops-mesher.ts): box emission into a
 * vertex sink, per-box tinting (glow-tinted dial face over neutral props),
 * and dial texture application through the radiodial painter. The surviving
 * assertions pin the restored src module: three boxes per radio, neutral
 * white body/grille vertices, glow-tinted dial vertices, and a deterministic
 * painted face carrying the manufacturer brand and FM scale labels.
 *
 *   node test/radioprop-mesher-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-radioprop-'));
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/radiodial.ts', 'gfx/radiodial.mjs');
emit('src/world/radioprops-mesher.ts', 'world/radioprops-mesher.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'world', 'radioprops-mesher.mjs')).href);
const dialMod = await import(pathToFileURL(path.join(tmp, 'gfx', 'radiodial.mjs')).href);
const { RadioPropMesh, RADIO_TINT } = mod;
const { DIAL_BRANDS } = dialMod;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
class GradientStub {
  constructor(...args) { this.args = args; this.stops = []; }
  addColorStop(t, color) { this.stops.push([t, color]); }
}

class RecordingCtx {
  constructor() {
    this.ops = [];
    this.font = ''; this.textAlign = ''; this.textBaseline = '';
    this.fillStyle = ''; this.strokeStyle = '';
    this.lineWidth = 1; this.shadowColor = ''; this.shadowBlur = 0;
  }
  _rec(op) { return (...args) => { this.ops.push({ op, args }); }; }
  save() { this._rec('save')(); }
  restore() { this._rec('restore')(); }
  fillRect(...a) { this._rec('fillRect')(...a); }
  strokeRect(...a) { this._rec('strokeRect')(...a); }
  beginPath() { this._rec('beginPath')(); }
  closePath() { this._rec('closePath')(); }
  moveTo(...a) { this._rec('moveTo')(...a); }
  lineTo(...a) { this._rec('lineTo')(...a); }
  arc(...a) { this._rec('arc')(...a); }
  fill() { this._rec('fill')(); }
  stroke() { this._rec('stroke')(); }
  fillText(...a) { this._rec('fillText')(...a); }
  createLinearGradient(...a) { return new GradientStub(...a); }
  createRadialGradient(...a) { return new GradientStub(...a); }
}

/** Accumulates every emitted box's flat position/color arrays. */
class Sink {
  constructor() { this.positions = []; this.colors = []; this.boxes = []; }
}

/** Wrap a sink so the mesher's box callback feeds it. */
function record(sink) {
  return {
    fn: (box) => {
      const start = sink.colors.length / 4;
      for (const p of box.positions) sink.positions.push(p);
      for (const col of box.colors) sink.colors.push(col);
      sink.boxes.push({ name: box.name, start, vertices: box.colors.length / 4 });
    },
  };
}

const EPS = 1e-9;
const SEED = 'radio:42:42';
const PLACE = { x: 12.75, z: -8.4, rotY: Math.PI / 2 };

/* ------------------------------------------------------------------ */
/* 1. Box emission                                                     */
/* ------------------------------------------------------------------ */
{
  const sink = new Sink();
  const n = new RadioPropMesh().emit(PLACE, record(sink).fn, { seed: SEED });
  check('emit reports the box count it produced', n === 3 || n === sink.boxes.length,
    'returned=' + n + ' boxes=' + sink.boxes.length);
  check('every box carries 8 RGBA-cornered vertices',
    sink.boxes.every((b) => b.vertices === 8));
  const dup = new Sink();
  new RadioPropMesh().emit(PLACE, record(dup).fn, { seed: SEED });
  check('emission is deterministic per place + seed',
    JSON.stringify(sink.positions) === JSON.stringify(dup.positions) &&
    JSON.stringify(sink.colors) === JSON.stringify(dup.colors));
}

/* ------------------------------------------------------------------ */
/* 2. Dial glow tint                                                   */
/* ------------------------------------------------------------------ */
{
  const sink = new Sink();
  new RadioPropMesh().emit(PLACE, record(sink).fn, { seed: SEED });
  const dial = sink.boxes[sink.boxes.length - 1];
  const tr = RADIO_TINT.r, tg = RADIO_TINT.g, tb = RADIO_TINT.b;
  let okUntouched = true;
  for (const b of sink.boxes) {
    if (b === dial) continue;
    for (let v = b.start; v < b.start + b.vertices; v++) {
      if (sink.colors[v * 4] !== 1 || sink.colors[v * 4 + 1] !== 1 ||
          sink.colors[v * 4 + 2] !== 1 || sink.colors[v * 4 + 3] !== 1) okUntouched = false;
    }
  }
  let okDial = true;
  for (let v = dial.start; v < dial.start + dial.vertices; v++) {
    if (Math.abs(sink.colors[v * 4] - tr) > EPS) okDial = false;
    if (Math.abs(sink.colors[v * 4 + 1] - tg) > EPS) okDial = false;
    if (Math.abs(sink.colors[v * 4 + 2] - tb) > EPS) okDial = false;
    if (sink.colors[v * 4 + 3] !== 1) okDial = false; // alpha untouched
  }
  check('earlier boxes keep neutral white vertices', okUntouched);
  check('dial box vertices carry the glow tint RGB, white alpha', okDial);
}

// ---------------------------------------------------------------------------
// 3. Dial texture application through paintDial
// ---------------------------------------------------------------------------
{
  const ctxA = new RecordingCtx();
  const ctxB = new RecordingCtx();
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: SEED, dialCtx: ctxA });
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: SEED, dialCtx: ctxB });

  const traceA = JSON.stringify(ctxA.ops);
  check('paintDial ran on the supplied context', ctxA.ops.length > 100,
    'ops=' + ctxA.ops.length);
  check('painted face is deterministic per seed', traceA === JSON.stringify(ctxB.ops));

  const texts = ctxA.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
  check('face carries a manufacturer brand from radiodial',
    texts.some((t) => DIAL_BRANDS.includes(t)),
    JSON.stringify(texts.slice(0, 8)));
  check('face labels the FM scale', texts.includes('FM  MHz'));

  // Different seed -> different grain trace (needle rest position may move).
  const ctxC = new RecordingCtx();
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: 'radio:99:99', dialCtx: ctxC });
  check('different seed paints a different face',
    JSON.stringify(ctxC.ops) !== traceA);

  void ctxC;
}

console.log(failures === 0 ? '\nALL RADIOPROP MESHER TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
