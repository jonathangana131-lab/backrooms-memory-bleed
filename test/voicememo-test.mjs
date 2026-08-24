/**
 * Functional verification of the F35 camcorder voice memos
 * (src/audio/voicememo.ts): capture round-trip text fidelity, seeded
 * render identity per memo id, monotone degradation across the zone
 * generation sweep, and identical storage serialize/deserialize.
 *
 * Standalone in Node; the TS module is bundled with esbuild (found in
 * the pnpm store, as in formtoasts-test.mjs) so its '../core/rng'
 * import resolves.
 *
 *   node test/voicememo-test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ' :: ' + (e instanceof Error ? e.message : String(e)));
  }
}

const esbuild = loadEsbuild();
const SRC = process.cwd() + '/src/audio/voicememo.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.voicememo-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  VoiceMemoStore,
  recordMemo,
  memoCharacter,
  degradationFor,
  ZONE_GEN_MAX,
} = await import('./.voicememo-build.mjs');

/* ------------------------------------------------------------------ */
/* Capture model                                                       */
/* ------------------------------------------------------------------ */

check('recording round-trip preserves the text payload', () => {
  const text = 'Day one. The yellow rooms hum in B flat. I marked the vending machine.';
  const memo = recordMemo('memo-001', text, 2.5, 12.3, 'run-seed-1');
  assert.equal(memo.text, text);
  assert.equal(memo.id, 'memo-001');
  assert.equal(memo.zoneGenAtCapture, 2.5);
  assert.ok(memo.durationSec > 0);
});

check('capture model carries seeded waveform parameters', () => {
  const a = recordMemo('m', '', 0, 5, 'seed-a').waveform;
  assert.equal(a.pitchHz, recordMemo('m', '', 0, 5, 'seed-a').waveform.pitchHz,
    'same runSeed+id -> same waveform');
  const b = recordMemo('m', '', 0, 5, 'seed-b').waveform;
  assert.notEqual(a.pitchHz, b.pitchHz, 'different runSeed -> different waveform');
  for (const w of [a, b]) {
    assert.ok(w.pitchHz > 80 && w.pitchHz < 160, 'pitch inside voiced band');
    assert.ok(w.wobbleRateHz > 0, 'wobble rate positive');
    assert.ok(w.hissColor >= 0 && w.hissColor <= 1, 'hiss colour normalized');
  }
});

check('duration clamps to a sane minimum', () => {
  assert.ok(recordMemo('short', '', 0, -4, 's').durationSec >= 0.25);
});

/* ------------------------------------------------------------------ */
/* Degradation curve                                                   */
/* ------------------------------------------------------------------ */

check('degradation is monotone across the zone generation sweep', () => {
  let prevDrop = -1;
  let prevWobble = -1;
  let prevNoise = -1;
  let prevClarity = Infinity;
  let strictSomewhere = false;
  for (let gen = 0; gen <= ZONE_GEN_MAX + 2; gen += 0.5) { // sweep past the clamp
    const memo = recordMemo('sweep-memo', 'payload', gen, 6, 'sweep-seed');
    const d = degradationFor(memo, 'sweep-seed');
    assert.ok(d.dropoutRate >= prevDrop - 1e-12, `dropouts nondecreasing at gen ${gen}`);
    assert.ok(d.pitchWobbleCents >= prevWobble - 1e-12, `wobble nondecreasing at gen ${gen}`);
    assert.ok(d.noiseFloor >= prevNoise - 1e-12, `noise floor nondecreasing at gen ${gen}`);
    assert.ok(d.clarity <= prevClarity + 1e-12, `clarity nonincreasing at gen ${gen}`);
    if (d.dropoutRate > prevDrop || d.noiseFloor > prevNoise || d.clarity < prevClarity) {
      strictSomewhere = true;
    }
    prevDrop = d.dropoutRate;
    prevWobble = d.pitchWobbleCents;
    prevNoise = d.noiseFloor;
    prevClarity = d.clarity;
  }
  assert.ok(strictSomewhere, 'the curve actually degrades somewhere');
});

check('pristine zones stay clean; deep zones are badly damaged', () => {
  const clean = degradationFor(recordMemo('edge', '', 0, 5, 'e'), 'e');
  const ruined = degradationFor(recordMemo('edge', '', ZONE_GEN_MAX, 5, 'e'), 'e');
  assert.equal(clean.dropoutRate, 0);
  assert.equal(clean.pitchWobbleCents, 0);
  assert.equal(clean.noiseFloor, 0);
  assert.equal(clean.clarity, 1);
  assert.ok(ruined.dropoutRate > clean.dropoutRate * 10, 'dropouts explode with depth');
  assert.ok(ruined.clarity < clean.clarity / 2, 'clarity collapses with depth');
  // out-of-range generations clamp instead of exploding
  const beyond = degradationFor(recordMemo('edge', '', 99, 5, 'e'), 'e');
  assert.equal(beyond.dropoutRate, ruined.dropoutRate, 'clamped above ZONE_GEN_MAX');
  const below = degradationFor(recordMemo('edge', '', -7, 5, 'e'), 'e');
  assert.equal(below.clarity, 1, 'clamped below zero');
});

check('same memo id renders identical degraded params', () => {
  const a = degradationFor(recordMemo('same-id', 'one', 5.5, 8, 'render-seed'), 'render-seed');
  const b = degradationFor(
    recordMemo('same-id', 'recorded again later', 5.5, 3, 'render-seed'),
    'render-seed',
  );
  assert.deepEqual(b, a, 'full render parameter set identical per id');
  // and a different id under the same seed renders differently
  const c = degradationFor(recordMemo('other-id', 'one', 5.5, 8, 'render-seed'), 'render-seed');
  assert.notEqual(c.character.pitchHz, a.character.pitchHz);
});

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

check('serialize -> deserialize reproduces the store identically', () => {
  const store = new VoiceMemoStore('store-seed');
  store.record('sv-1', 'Found a door that opens into the room behind it.', 3, 9.5);
  store.record('sv-2', 'The camcorder timestamp disagrees with my watch.', 7.5, 4);
  store.record('sv-3', 'If anyone finds this: do not follow the humming.', 0.5, 15);
  assert.ok(store.remove('sv-3'), 'removal works before serialization');

  const restored = VoiceMemoStore.deserialize(store.serialize());
  assert.equal(restored.runSeed, 'store-seed');
  assert.deepEqual(restored.all(), store.all(), 'deep-equal memos after round-trip');
  // renders match too, not just stored fields
  for (const memo of store.all()) {
    assert.deepEqual(degradationFor(restored.get(memo.id), restored.runSeed),
      degradationFor(memo, store.runSeed));
  }
  // serialized bytes are stable across repeated dumps
  assert.equal(store.serialize(), store.serialize());
});

check('deserialize rejects foreign formats loudly', () => {
  assert.throws(() => VoiceMemoStore.deserialize('{"version":9,"runSeed":"x","memos":[]}'));
  assert.throws(() => VoiceMemoStore.deserialize('not json at all'));
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
