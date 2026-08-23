/*
 * NotePaperMesher test - runs headless in Node.
 *
 * Both src/gfx/notepaper.ts and src/gfx/notepaper-mesher.ts are pure canvas
 * work, so we transpile them with the workspace TypeScript compiler and run
 * the mesher against a recording 2d-context stub plus a
 * document.createElement('canvas') stub - no browser, no images.
 *
 * Verifies:
 *   1. wrapText word-wraps to maxWidth using measureText widths
 *   2. wrapText honours explicit newlines and preserves blank lines
 *   3. wrapText hard-breaks single words wider than maxWidth
 *   4. wrapText edge cases: empty string -> [''], non-positive maxWidth safe
 *   5. render returns a sized canvas; texture drawn first (drawImage before
 *      any fillText), text drawn after
 *   6. render is deterministic: same noteId/text/size -> identical op trace;
 *      different text -> different trace
 *   7. render honours styleFor: many ids spread over all four paper types,
 *      each render's texture matches NotePaper.styleFor(id).paperType
 *   8. overflow clipping: very long text draws at most maxLines lines
 *   9. wrapText passthrough on the class matches the standalone function
 */
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));

function transpile(rel) {
  const src = readFileSync(join(here, '..', 'src', 'gfx', rel), 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const modDir = mkdtempSync(join(tmpdir(), 'bmb-notepaper-mesher-'));
// notepaper.mjs first - the mesher's './notepaper' import is rewritten to it.
writeFileSync(join(modDir, 'notepaper.mjs'), transpile('notepaper.ts'));
const mesherJs = transpile('notepaper-mesher.ts').replace(
  /(['"])\.\/notepaper\1/g,
  '$1./notepaper.mjs$1',
);
writeFileSync(join(modDir, 'notepaper-mesher.mjs'), mesherJs);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

/* ------------------------- environment stubs ---------------------- */

/** Recording ctx whose measureText width = charCount * charW. */
function makeCtx(charW = 10) {
  const ops = [];
  const grad = { addColorStop() {} };
  return {
    ops,
    fillStyle: '', strokeStyle: '', font: '',
    lineWidth: 1, textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h]); },
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
      const s = String(t);
      // Deterministic pseudo-width so per-char cursor advances differ.
      const width = s.length * charW + ((s.charCodeAt(0) || 0) % 3);
      return { width };
    },
    createLinearGradient() { ops.push(['linGrad']); return grad; },
    createRadialGradient() { ops.push(['radGrad']); return grad; },
  };
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

const paper = await import(join(modDir, 'notepaper.mjs'));
const mesherMod = await import(join(modDir, 'notepaper-mesher.mjs'));
const { NotePaperMesher, wrapText } = mesherMod;

/* --------------------------- 1-2. wrapping ------------------------ */

{
  const ctx = makeCtx(10); // width == length * 10 exactly
  // "aaaa bb cccc" = widths 40+10+20+10+40 = 120 > 100 -> wraps.
  const w = wrapText(ctx, 'aaaa bb cccc', 100);
  check('wraps to fit maxWidth', JSON.stringify(w) === JSON.stringify(['aaaa bb', 'cccc']), JSON.stringify(w));
  check('every line fits', w.every((l) => ctx.measureText(l).width <= 100));

  const joined = w.join(' ');
  check('no words lost or changed', joined.replace(/\s+/g, ' ').trim() === 'aaaa bb cccc');
}


