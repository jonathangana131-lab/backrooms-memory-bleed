/*
 * Note paper variety test - runs headless in Node.
 *
 * src/gfx/notepaper.ts is pure canvas generation, so we transpile it with the
 * workspace TypeScript compiler and run it against a recording 2d-context
 * stub plus a document.createElement('canvas') stub - no browser, no images.
 *
 * Verifies:
 *   1. styleFor returns in-range (paperType 0..3, handStyle 0..2)
 *   2. styleFor is deterministic: same id -> same pair
 *   3. ids spread across every paper type AND every handwriting style
 *   4. getTexture generates a sized canvas per type; repeat calls return the
 *      cached instance; each type paints differently (distinct op traces)
 *   5. out-of-range / negative / fractional type ids are handled safely
 *   6. applyToCanvas(ctx, w, h) draws the texture scaled to exactly w x h,
 *      honouring the optional paperType option
 *   7. drawText: neat print uses one fillText per line and no rotation;
 *      rushed scrawl rotates per line; shaky elderly fills per character
 *      with a wobbling baseline; all three return a usable next-y
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'gfx', 'notepaper.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modDir = mkdtempSync(join(tmpdir(), 'bmb-notepaper-'));
const modPath = join(modDir, 'notepaper.mjs');
writeFileSync(modPath, js);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

/* ------------------------- environment stubs ---------------------- */

/** Recording CanvasRenderingContext2D stub. */
function makeCtx() {
  const ops = [];
  const grad = { addColorStop() {} };
  const ctx = {
    ops,
    fillStyle: '', strokeStyle: '', font: '',
    lineWidth: 1, textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h]); },
    strokeRect() { ops.push(['strokeRect']); },
    beginPath() { ops.push(['beginPath']); },
    moveTo(x, y) { ops.push(['moveTo', x, y]); },
    lineTo(x, y) { ops.push(['lineTo', x, y]); },
    closePath() { ops.push(['closePath']); },
    arc(x, y, r) { ops.push(['arc', x, y, r]); },
    fill() { ops.push(['fill']); },
    stroke() { ops.push(['stroke']); },
    save() { ops.push(['save']); },
    restore() { ops.push(['restore']); },
    translate(x, y) { ops.push(['translate', x, y]); },
    rotate(a) { ops.push(['rotate', a]); },
    drawImage(img, x, y, w, h) { ops.push(['drawImage', img, x, y, w, h]); },
    fillText(t, x, y) { ops.push(['fillText', String(t), x, y]); },
    measureText(t) {
      // Deterministic pseudo-width so per-char cursor advances differ.
      const width = 6 + (String(t).charCodeAt(0) % 7);
      ops.push(['measureText', String(t)]);
      return { width };
    },
    createLinearGradient() { ops.push(['linGrad']); return grad; },
    createRadialGradient() { ops.push(['radGrad']); return grad; },
  };
  return ctx;
}

function makeCanvasEl() {
  const el = {
    width: 0, height: 0,
    __ctx: null,
    getContext() { if (!el.__ctx) el.__ctx = makeCtx(); return el.__ctx; },
  };
  return el;
}

globalThis.document = { createElement(tag) { return makeCanvasEl(); } };

/* ------------------------------ load ------------------------------ */

const mod = await import(modPath);
const { NotePaper, hashNoteId, PAPER_TYPES, HAND_STYLES } = mod;

/* --------------------------- 1-3. styleFor ------------------------ */

{
  const s = NotePaper.styleFor('note-07');
  check('styleFor paperType in range', Number.isInteger(s.paperType) && s.paperType >= 0 && s.paperType < PAPER_TYPES, JSON.stringify(s));
  check('styleFor handStyle in range', Number.isInteger(s.handStyle) && s.handStyle >= 0 && s.handStyle < HAND_STYLES, JSON.stringify(s));

  const again = NotePaper.styleFor('note-07');
  check('styleFor deterministic', s.paperType === again.paperType && s.handStyle === again.handStyle);

  const papers = new Set(), hands = new Set();
  for (let i = 0; i < 200; i++) {
    const st = NotePaper.styleFor('note-' + i);
    papers.add(st.paperType);
    hands.add(st.handStyle);
  }
  check('paper types all used', papers.size === PAPER_TYPES, [...papers].join(','));
  check('hand styles all used', hands.size === HAND_STYLES, [...hands].join(','));
}

/* -------------------------- 4. getTexture ------------------------- */

{
  const texes = [];
  const traces = new Set();
  for (let t = 0; t < PAPER_TYPES; t++) {
    const c = NotePaper.getTexture(t);
    check(`texture type ${t} is sized canvas`, c && typeof c.width === 'number' && c.width > 0 && c.height > 0);
    check(`texture type ${t} painted`, c.__ctx.ops.length >= 20, 'ops=' + c.__ctx.ops.length);
    texes.push(c);
    const trace = JSON.stringify(c.__ctx.ops);
    check(`texture type ${t} paints distinctly`, !traces.has(trace));
    traces.add(trace);
  }
}
{
  const a = NotePaper.getTexture(1);
  const b = NotePaper.getTexture(1);
  check('getTexture cached identity', a === b);
}

/* -------------------- 5. out-of-range robustness ------------------ */

{
  let ok = true;
  try {
    for (const bad of [-7, -1, 99, 4.7]) {
      const c = NotePaper.getTexture(bad);
      if (!c) ok = false;
    }
  } catch { ok = false; }
  check('out-of-range type ids safe', ok);

  let ok2 = true;
  try { NotePaper.drawText(makeCtx(), 'x', 5, 5, 42); } catch { ok2 = false; }
  check('out-of-range hand id safe', ok2);
}

/* ------------------------- 6. applyToCanvas ----------------------- */

{
  const ctx = makeCtx();
  NotePaper.applyToCanvas(ctx, 128, 96);
  const img = ctx.ops.find((o) => o[0] === 'drawImage');
  check('applyToCanvas default draws texture', !!img);
  check('applyToCanvas scales to w x h', img && img[2] === 0 && img[3] === 0 && img[4] === 128 && img[5] === 96, JSON.stringify(img?.slice(2)));

  const legal = NotePaper.getTexture(0);
  check('default paper is legal pad', img && img[1] === legal);

  const ctx2 = makeCtx();
  NotePaper.applyToCanvas(ctx2, 64, 64, { paperType: 3 });
  const img2 = ctx2.ops.find((o) => o[0] === 'drawImage');
  check('applyToCanvas honours paperType option', img2 && img2[1] === NotePaper.getTexture(3));
}

/* ---------------------------- 7. drawText ------------------------- */

{
  // Neat print: one fillText per line, zero rotate.
  const p = makeCtx();
  const ny = NotePaper.drawText(p, 'line one\nline two', 10, 20, 0, { lineHeight: 24 });
  const fills = p.ops.filter((o) => o[0] === 'fillText');
  check('print: one fillText per line', fills.length === 2, 'got ' + fills.length);
  check('print: no rotation', !p.ops.some((o) => o[0] === 'rotate'));
  check('print: lines on straight baseline', fills[0][3] === 20 && fills[1][3] === 44, JSON.stringify(fills.map((f) => f[3])));
  check('print: next y returned', ny === 68, 'ny=' + ny);

  // Scrawl: rotates once per line.
  const s = makeCtx();
  NotePaper.drawText(s, 'a\nb\nc', 0, 10, 1, {});
  const rots = s.ops.filter((o) => o[0] === 'rotate');
  check('scrawl: rotation per line', rots.length === 3, 'got ' + rots.length);
  const rotAngles = new Set(rots.map((r) => Math.abs(r[1])));
  check('scrawl: rotations vary per line', rotAngles.size > 1, [...rotAngles].join(','));
  const saves = s.ops.filter((o) => o[0] === 'save');
  check('scrawl: transform bracketed by save/restore', saves.length === 3);

  // Shaky: per-character fills with wobbling baselines.
  const h = makeCtx();
  NotePaper.drawText(h, 'hello', 8, 30, 2, {});
  const hfills = h.ops.filter((o) => o[0] === 'fillText');
  check('shaky: per-character fillText', hfills.length === 5, 'got ' + hfills.length);
  const ys = hfills.map((f) => f[3]);
  check('shaky: baseline wobbles', new Set(ys).size > 1, ys.join(','));
  const xs = hfills.map((f) => f[2]);
  check('shaky: x advances monotonically', xs.every((v, i) => i === 0 || v > xs[i - 1]));

  // Determinism of the hand jitter itself.
  const h2 = makeCtx();
  NotePaper.drawText(h2, 'hello', 8, 30, 2, {});
  check('shaky: reproducible strokes', JSON.stringify(h.ops) === JSON.stringify(h2.ops));

  check('hashNoteId stable', hashNoteId('abc') === hashNoteId('abc') && typeof hashNoteId('x') === 'number');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


