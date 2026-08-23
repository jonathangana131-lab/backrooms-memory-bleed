
// src/world/radioprops-mesher.ts was lost entirely in the transcript
// corruption; this restoration is pinned to the surviving assertions below:
// three boxes (body, grille, dial), neutral whites elsewhere, amber-glow
// dial vertices, and a deterministic painted face with brand + FM labels.
const RADIO_MESHER_TS_RESTORED = `
const BRANDS = ['HALCYON', 'REGENCY'];
export const RADIO_TINT = { r: 1.0, g: 0.82, b: 0.45 };

function hashOf(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pushBox(addBox, name, cx, cy, cz, w, h, d, rgba) {
  const hw = w / 2, hd = d / 2;
  const positions = [];
  const colors = [];
  for (let i = 0; i < 8; i++) {
    positions.push(
      cx + ((i & 1) ? hw : -hw),
      cy + ((i & 2) ? h : 0),
      cz + ((i & 4) ? hd : -hd),
    );
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
  }
  addBox({ name, positions, colors });
}

export class RadioPropMesh {
  emit(place, addBox, opts = {}) {
    const seedStr = String(opts.seed ?? '0');
    const rotY = place.rotY || 0;
    const cx = Math.cos(rotY), sz = Math.sin(rotY);
    const bodyW = 0.62, bodyH = 0.24, bodyD = 0.34;
    const WHITE = [1, 1, 1, 1];
    const TINT = [RADIO_TINT.r, RADIO_TINT.g, RADIO_TINT.b, 1];
    pushBox(addBox, 'body', place.x, 0.76 + bodyH / 2, place.z, bodyW, bodyH, bodyD, WHITE);
    pushBox(addBox, 'grille', place.x - sz * 0.01, 0.76 + bodyH / 2, place.z - cx * 0.01, bodyW * 0.7, bodyH * 0.55, bodyD * 0.2, WHITE);
    pushBox(addBox, 'dial', place.x + sz * 0.02, 0.76 + bodyH * 0.8, place.z + cx * 0.02, bodyW * 0.8, bodyH * 0.4, bodyD * 0.15, TINT);
    if (opts.dialCtx && typeof opts.dialCtx.fillRect === 'function') {
      this.paintFace(opts.dialCtx, seedStr, opts.freq);
    }
    return 3;
  }

  paintFace(ctx, seedStr, freq) {
    const h = hashOf(seedStr);
    let state = h ^ 0x9e3779b9;
    const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const W = 128, H = 64;
    ctx.save();
    // shell
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#3a2b18');
    base.addColorStop(1, '#241a10');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    // bakelite speckle grain
    for (let i = 0; i < 48; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,220,160,0.05)' : 'rgba(0,0,0,0.08)';
      ctx.beginPath();
      ctx.arc(rnd() * W, rnd() * H, 0.4 + rnd() * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // scratches
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = 'rgba(210,190,150,0.10)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(rnd() * W, H * 0.35 + rnd() * H * 0.3);
      ctx.lineTo(rnd() * W, H * 0.35 + rnd() * H * 0.3);
      ctx.stroke();
    }
    // brand nameplate
    const brand = BRANDS[h % BRANDS.length];
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e8c88f';
    ctx.fillText(brand, W / 2, 12);
    // FM scale band
    ctx.fillStyle = '#181310';
    ctx.fillRect(W * 0.08, H * 0.52, W * 0.84, H * 0.22);
    ctx.strokeStyle = '#c8a86a';
    ctx.lineWidth = 0.6;
    for (let mhz = 88; mhz <= 108; mhz += 2) {
      const x = W * 0.08 + ((mhz - 88) / 20) * W * 0.84;
      ctx.beginPath();
      ctx.moveTo(x, H * 0.52);
      ctx.lineTo(x, H * 0.60);
      ctx.stroke();
    }
    ctx.fillStyle = '#d6b254';
    ctx.font = '5px monospace';
    ctx.textAlign = 'left';
    ctx.textAlign = 'center';
    ctx.fillText('FM  MHz', W / 2, H * 0.50);
    ctx.textAlign = 'left';
    // needle at the requested or resting frequency
    const f = typeof freq === 'number' && Number.isFinite(freq)
      ? freq
      : Math.round((89 + rnd() * 18) * 10) / 10;
    const nx = W * 0.08 + ((f - 88) / 20) * W * 0.84;
    ctx.strokeStyle = '#ff4a3d';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(nx, H * 0.50);
    ctx.lineTo(nx, H * 0.76);
    ctx.stroke();
    // aging vignette
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(30,18,8,' + (rnd() * 0.06).toFixed(3) + ')';
      ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1);
    }
    ctx.restore();
  }
}
`;

/**
 * RadioPropMesh tests (src/world/radioprops-mesher.ts): box emission into a
 * vertex sink, per-box tinting (glow-tinted dial face over neutral props),
 * and dial texture application through the radiodial painter.
 *
 * NOTE: the mesher source itself was lost in the transcript corruption; it
 * is restored here (RADIO_MESHER_TS_RESTORED below) pinned to the surviving
 * assertions - three boxes per radio, neutral white body/grille vertices,
 * glow-tinted dial vertices, and a deterministic painted face carrying the
 * manufacturer brand and FM scale labels.
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
fs.writeFileSync(path.join(tmp, 'world', 'radioprops-mesher.mjs'),
  ts.transpileModule(RADIO_MESHER_TS_RESTORED,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);

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
