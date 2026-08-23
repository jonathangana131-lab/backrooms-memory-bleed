/*
 * EndCapture unit verification.
 * Runs standalone in Node (v22+, --experimental-strip-types) against a
 * minimal DOM/canvas/MutationObserver shim; no browser required.
 */
import { strict as assert } from 'node:assert';

/* ------------------------------------------------------------- shims --- */
class FakeCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ops = [];
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.strokeStyle = '';
    this.fillStyle = '';
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
  }
  fillRect(...a) { this.ops.push(['fillRect', ...a]); }
  clearRect(...a) { this.ops.push(['clearRect', ...a]); }
  drawImage(...a) { this.ops.push(['drawImage', ...a]); }
  strokeRect(...a) { this.ops.push(['strokeRect', ...a]); }
  fillText(...a) { this.ops.push(['fillText', ...a]); }
}

/** Minimal stand-in for an HTMLCanvasElement. */
class FakeCanvas {
  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
    this._ctx = new FakeCtx(this);
  }
  getContext(kind) { return kind === '2d' ? this._ctx : null; }
  toBlob(done, mime = 'image/png') {
    setTimeout(() => done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: mime })), 0);
  }
}

let observerCallback = null;
class FakeMutationObserver {
  constructor(cb) { observerCallback = cb; }
  observe() { this.observed = true; }
  disconnect() { this.disconnected = true; }
}

globalThis.document = {
  body: { style: { background: '' } },
  createElement: () => new FakeCanvas(),
};
globalThis.MutationObserver = FakeMutationObserver;
/* test helper: simulate the style mutation firing */
function fireWhiteout() { observerCallback([], null); }
void fireWhiteout;
globalThis.__BMB__ = undefined;

/* ------------------------------------------------------------ module --- */
import {
  formatSeedHex, formatStampLine, isWhiteoutBackground, resolveSeed,
  composeCommemorativeFrame, blobFromFrame,
} from '../src/ui/endcapture.ts';

let failures = 0;
const pending = [];
function check(name, fn) { pending.push([name, fn]); }

check('whiteout detector matches only the exact paint', () => {
  assert.equal(isWhiteoutBackground('#efe9d8'), true);
  assert.equal(isWhiteoutBackground('#EFE9D8'), true);
  assert.equal(isWhiteoutBackground('#ffffff'), false);
  assert.equal(isWhiteoutBackground(''), false);
  assert.equal(isWhiteoutBackground(null), false);
});

check('resolveSeed falls back to null without a game global', () => {
  assert.equal(resolveSeed(), null);
  globalThis.__BMB__ = { stats: () => ({ seed: 3735928559 }) };
  assert.equal(resolveSeed(), 0xdeadbeef >>> 0);
  globalThis.__BMB__ = undefined;
});

check('formatSeedHex pads to 8 hex chars', () => {
  assert.equal(formatSeedHex(0xdeadbeef), 'deadbeef');
  assert.equal(formatSeedHex(0), '00000000');
  assert.equal(formatSeedHex(-1 >>> 0 ? -1 : -1), 'ffffffff'); // -1 coerces via >>>0 path? guard below
});

check('stamp line contains marker, seed and ISO-ish date', () => {
  const line = formatStampLine(3735928559, new Date(2026, 7, 23));
  assert.match(line, /THRESHOLD CROSSED/);
  assert.match(line, /SEED deadbeef/);
  assert.match(line, /2026-08-23/);
});

check('stamp renders question marks when seed is missing', () => {
  const line = formatStampLine(null, new Date(2026, 7, 23));
  assert.match(line, /SEED \?\?\?\?\?\?\?\?/);
});

check('composited frame draws source, border and stamp footer', async () => {
  const source = new FakeCanvas(480, 270);
  const out = composeCommemorativeFrame(source, { seed: 0x0000cafe, date: new Date(2026, 7, 23) });
  assert.ok(out && out.width === 480 && out.height === 270);
  const ctx = out.getContext('2d');
  assert.equal(ctx.ops.filter((o) => o[0] === 'drawImage').length, 1);
  const border = ctx.ops.find((o) => o[0] === 'strokeRect');
  assert.ok(border, 'border strokeRect recorded');
  const stamp = ctx.ops.find((o) => o[0] === 'fillText');
  assert.ok(stamp, 'stamp fillText recorded');
  assert.match(String(stamp[1]), /THRESHOLD CROSSED/);
  assert.match(String(stamp[1]), /SEED 0000cafe/);
  const blob = await blobFromFrame(out);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
});

check('compositing degrades to null on missing context or zero size', () => {
  // the frame canvas itself has no 2d context -> null, never throws
  const blind = composeCommemorativeFrame(new FakeCanvas(10, 10), {
    createCanvas: () => ({ width: 10, height: 10, getContext: () => null }),
  });
  assert.equal(blind, null);
  const tiny = new FakeCanvas(0, 0);
  assert.equal(composeCommemorativeFrame(tiny), null);
});

check('blobFromFrame resolves null when toBlob throws', async () => {
  const boom = { width: 4, height: 4, getContext: () => ({}), toBlob: () => { throw new Error('nope'); } };
  assert.equal(await blobFromFrame(boom), null);
});

/* ------------------------------------------------------------- runner --- */
for (const [name, fn] of pending) {
  try {
    await fn();
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL - ' + name + ' :: ' + e.message);
  }
}
console.log(failures === 0 ? '\nALL END_CAPTURE TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
