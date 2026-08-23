/**
 * Radio dial face tests (src/gfx/radiodial.ts): band/brand constants,
 * canvas spec, deterministic branding, needle geometry, rest frequency,
 * and the procedural painter's contract (deterministic, lit/dim twins).
 * Standalone in Node; transpiles the module (+ rng) into a temp dir.
 *
 *   node test/radiodial-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-radiodial-'));
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

const mod = await import(pathToFileURL(path.join(tmp, 'gfx', 'radiodial.mjs')).href);
const {

  FM_BAND_MIN, FM_BAND_MAX, DIAL_SALT, DIAL_BRANDS,
  dialCanvasSize, dialBrandFor, needleXFor, dialRestFreq,
  paintDial, paintDialLit, paintDialInto,
} = mod;

// ---------------------------------------------------------------------------
// Recording 2D-context stub
// ---------------------------------------------------------------------------
class GradientStub {
  constructor(kind, args) { this.kind = kind; this.args = args; this.stops = []; }
  addColorStop(t, color) { this.stops.push([t, color]); }
}

class RecordingCtx {
  constructor() {
    this.ops = [];
    this.font = '';
    this.textAlign = '';
    this.textBaseline = '';
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 1;
    this.shadowColor = '';
    this.shadowBlur = 0;
    this.saveCount = 0;
    this.restoreCount = 0;
  }
  _rec(name, args) {
    this.ops.push({ op: name, args: [...args], style: this.fillStyle, stroke: this.strokeStyle });
  }
  save() { this.saveCount++; this._rec('save', []); }
  restore() { this.restoreCount++; this._rec('restore', []); }
  fillRect(...a) { this._rec('fillRect', a); }
  strokeRect(...a) { this._rec('strokeRect', a); }
  beginPath() { this._rec('beginPath', []); }
  closePath() { this._rec('closePath', []); }
  moveTo(...a) { this._rec('moveTo', a); }
  lineTo(...a) { this._rec('lineTo', a); }
  arc(...a) { this._rec('arc', a); }
  fill() { this._rec('fill', []); }
  stroke() { this._rec('stroke', []); }
  fillText(...a) { this._rec('fillText', a); }
  createLinearGradient(...a) { return new GradientStub('linear', a); }
  createRadialGradient(...a) { return new GradientStub('radial', a); }
}

function paint(variant, seed, w = 512, h = 256, freq) {
  const ctx = new RecordingCtx();
  if (variant === 'lit') paintDialLit(ctx, w, h, seed, freq);
  else if (variant === 'dim') paintDial(ctx, w, h, seed, freq);
  else paintDialInto(ctx, w, h, seed, variant);
  return ctx;
}

const traceOf = (ctx) => JSON.stringify(ctx.ops);

// ---------------------------------------------------------------------------
 // Constants and canvas spec
// ---------------------------------------------------------------------------
check('band constants are 88/108 MHz', FM_BAND_MIN === 88 && FM_BAND_MAX === 108,
  FM_BAND_MIN + '/' + FM_BAND_MAX);
check('two brands declared HALCYON and REGENCY',
  DIAL_BRANDS.length === 2 && DIAL_BRANDS.includes('HALCYON') && DIAL_BRANDS.includes('REGENCY'),
  JSON.stringify(DIAL_BRANDS));

{
  const { width, height } = dialCanvasSize();
  check('canvas size positive ints, landscape, multiple of 4',
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width > height && width % 4 === 0 && height % 4 === 0,




    String(width + 'x' + height));
}

{
  // --- deterministic branding -------------------------------------------------
  check('dialBrandFor is deterministic per seed', dialBrandFor(7) === dialBrandFor(7)
    && dialBrandFor(1234) === dialBrandFor(1234));
  let sawHalcyon = false, sawRegency = false;
  for (let i = 0; i < 200; i++) {
    if (dialBrandFor(i) === 'HALCYON') sawHalcyon = true;
    if (dialBrandFor(i) === 'REGENCY') sawRegency = true;
  }
  check('both brands occur across the seed range', sawHalcyon && sawRegency);
}

{
  // --- needle geometry ----------------------------------------------------------
  const w = 512;
  const pad = w * 0.09;
  check('needle maps band edges onto the padded scale',
    Math.abs(needleXFor(FM_BAND_MIN, w) - pad) < 1e-9 &&
    Math.abs(needleXFor(FM_BAND_MAX, w) - (w - pad)) < 1e-9);
  check('needle x is linear in frequency',
    Math.abs(needleXFor(98, w) - (pad + ((98 - FM_BAND_MIN) / 20) * (w - 2 * pad))) < 1e-9);
  check('out-of-band frequencies clamp to the scale ends',
    needleXFor(10, w) === needleXFor(FM_BAND_MIN, w) &&
    needleXFor(900, w) === needleXFor(FM_BAND_MAX, w));

  let okRest = true;
  for (let seed = 0; seed < 60; seed++) {
    const f = dialRestFreq(seed);
    if (!(f >= FM_BAND_MIN + 1 && f <= FM_BAND_MAX - 1)) okRest = false;
    if (f !== Math.round(f * 10) / 10) okRest = false;
    if (f !== dialRestFreq(seed)) okRest = false;
  }
  check('rest frequency sits in-band at one decimal, deterministic', okRest);
}

{
  // --- painter contract -----------------------------------------------------------
  check('same seed paints a byte-identical face',
    traceOf(paint('dim', 42)) === traceOf(paint('dim', 42)));
  check('the lit twin differs from the resting face',
    traceOf(paint('dim', 42)) !== traceOf(paint('lit', 42)));
  check('aging differs between seeds',
    traceOf(paint('dim', 1)) !== traceOf(paint('dim', 2)));

  const ctx = paint('dim', 3);
  // the nameplate is letter-spaced: one fillText per glyph
  const joined = ctx.ops.filter((o) => o.op === 'fillText')
    .map((o) => String(o.args[0])).join('');
  check('the brand nameplate is painted on the face',
    DIAL_BRANDS.some((b) => joined.includes(b)),
    JSON.stringify(joined.slice(0, 40)));
  check('painter balances save/restore',
    ctx.saveCount === ctx.restoreCount && ctx.saveCount >= 1);

  // an explicit frequency moves the needle mark along the scale
  const freq = 101.5;
  const withFreq = new RecordingCtx();
  paintDialInto(withFreq, 512, 256, 9, { freq });
  const restCtx = new RecordingCtx();
  paintDialInto(restCtx, 512, 256, 9, {});
  check('explicit frequency shifts the needle from its rest position',
    traceOf(withFreq) !== traceOf(restCtx));
  const xs = withFreq.ops
    .filter((o) => o.op === 'moveTo' || o.op === 'lineTo')
    .map((o) => o.args[0]);
  const target = needleXFor(freq, 512);
  check('needle strokes land near the requested frequency',
    xs.some((x) => Math.abs(x - target) <= 24),
    'target=' + target.toFixed(1));
}

console.log(failures === 0 ? '\nALL RADIODIAL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
