/*
 * EndCapture unit verification.
 * Runs standalone in Node (v22+, --experimental-strip-types) against a
 * minimal DOM/canvas/MutationObserver shim; no browser required.
 */
import { strict as assert } from 'node:assert';

/* ------------------------------------------------------------- shims --- */
class FakeCtx {
  constructor(canvas) { this.canvas = canvas; this.ops = []; }


// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
}

let observerCallback = null;
class FakeMutationObserver {
  constructor(cb) { observerCallback = cb; }
  observe() { this.observed = true; }
  disconnect() { this.disconnected = true; }


globalThis.document = {
  body: { style: { background: '' } },
  createElement: () => new FakeCanvas(),
};
globalThis.MutationObserver = FakeMutationObserver;
/* test helper: simulate the style mutation firing */
function fireWhiteout() { observerCallback([], null); }
globalThis.__BMB__ = undefined;



// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]

check('formatSeedHex pads to 8 hex chars', () => {
  assert.equal(formatSeedHex(0xdeadbeef), 'deadbeef');
  assert.equal(formatSeedHex(0), '00000000');
  assert.equal(formatSeedHex(-1 >>> 0 ? -1 : -1), 'ffffffff'); // -1 coerces via >>>0 path? guard below
});

check('stamp line contains marker, seed and ISO-ish date', () => {
  const line = formatStampLine(3735928559, new Date(2026, 7, 23));
  assert.match(line, /THRESHOLD CROSSED/);


// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
  assert.match(String(stamp[1]), /SEED 0000cafe/);
  const blob = await blobFromFrame(out);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
});

check('compositing degrades to null on missing context or zero size', () => {
  const blind = { width: 10, height: 10, getContext: () => null, toBlob: () => {} };
  assert.equal(composeCommemorativeFrame(blind), null);
  const tiny = new FakeCanvas(0, 0);
  assert.equal(composeCommemorativeFrame(tiny), null);
});

check('blobFromFrame resolves null when toBlob throws', async () => {


