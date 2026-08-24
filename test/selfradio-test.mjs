/**
 * Functional verification of the F34 self-tuning radio
 * (src/audio/selfradio.ts): deterministic station construction and
 * scripts, grounding-weighted selection beating decoys within the drift
 * ramp, monotone dial drift toward the best-matching station, and
 * silence safety on an empty feed.
 *
 * Standalone in Node; the TS module is bundled with esbuild (found in
 * the pnpm store, as in formtoasts-test.mjs) so its '../core/rng'
 * import resolves.
 *
 *   node test/selfradio-test.mjs
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
const SRC = process.cwd() + '/src/audio/selfradio.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.selfradio-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  SelfRadio,
  buildStations,
  assembleScript,
  groundingScore,
  stationFreqFor,
  designationFor,
  RAMP_SECONDS,
  DECOY_COUNT,
} = await import('./.selfradio-build.mjs');

/** Convenience feed factory. */
function feed(id, kind = 'note', textSeed = 'ts-' + id) {
  return { id, kind, textSeed };
}

/* ------------------------------------------------------------------ */
/* Station construction                                                */
/* ------------------------------------------------------------------ */

check('stations cover feed entries, loadout and fixed decoys', () => {
  const st = buildStations('run-a', [feed('n1'), feed('n2')], ['torch', 'tape']);
  assert.equal(st.filter((s) => !s.decoy).length, 4);
  assert.equal(st.filter((s) => s.decoy).length, DECOY_COUNT);
  const keys = new Set(st.map((s) => s.key));
  assert.ok(keys.has('discovery:n1') && keys.has('loadout:torch'));
});

check('carrier frequencies are deterministic, in band, one decimal', () => {
  for (const key of ['discovery:x', 'decoy:0', 'loadout:tape']) {
    const f = stationFreqFor('seed-1', key);
    assert.equal(stationFreqFor('seed-1', key), f, 'same seed+key -> same freq');
    assert.ok(f >= 89 && f <= 107, 'in padded band: ' + f);
    assert.equal(f, Math.round(f * 10) / 10, 'one decimal');
  }
});

check('grounding scores count only live refs; decoys always zero', () => {
  const live = buildStations('run-b', [feed('real-1')], []);
  const decoy = live.find((s) => s.decoy);
  const grounded = live.find((s) => s.key === 'discovery:real-1');
  const feedIds = new Set(['real-1']);
  assert.equal(groundingScore(grounded, feedIds, new Set()), 1);
  assert.equal(groundingScore(decoy, feedIds, new Set()), 0);
  // once the discovery leaves the feed its station grounds no more
  assert.equal(groundingScore(grounded, new Set(), new Set()), 0);
});

check('scripts are deterministic per (seed, referenced entries)', () => {
  const f = [feed('n9', 'anomaly', 'weird-hall')];
  const a = buildStations('run-c', f, [])[0];
  const again = buildStations('run-c', f, [])[0];
  assert.deepEqual(assembleScript('run-c', a, f), assembleScript('run-c', again, f));
  // same entries under a different run seed reword the script
  const other = assembleScript('run-d', buildStations('run-d', f, [])[0], f);
  assert.notDeepEqual(assembleScript('run-c', a, f), other);
  // identical seeds rebuild identical scripts from scratch
  assert.deepEqual(
    [...assembleScript('run-c', a, f)].join('|'),
    [...assembleScript('run-c', a, f)].join('|'),
  );
});

check('scripts ground their wording in the referenced textSeed', () => {
  const f = [feed('n5', 'note', 'dead-drop-44')];
  const st = buildStations('run-e', f, []).find((s) => s.key === 'discovery:n5');
  const script = assembleScript('run-e', st, f).join(' ');
  assert.ok(script.includes(designationFor('dead-drop-44')), 'spoken code matches textSeed');
  assert.ok(script.length > 40, 'reads as prose, not an empty stub');
});

check('script bodies follow the discovery kind pool', () => {
  const anomalyFeed = [feed('a1', 'anomaly', 'k1')];
  const noteFeed = [feed('n1', 'note', 'k2')];
  const pickScript = (f) => {
    const st = buildStations('run-f', f, []).find((s) => !s.decoy);
    return assembleScript('run-f', st, f).join(' ');
  };
  const anomalyText = pickScript(anomalyFeed);
  const noteText = pickScript(noteFeed);
  // anomaly pool vocabulary vs note pool vocabulary differ
  assert.match(anomalyText, /witnessed|geometry|irregularity/);
  assert.match(noteText, /note|handwriting|transcribed/);
});

/* ------------------------------------------------------------------ */
/* Grounding beats decoys within the ramp                              */
/* ------------------------------------------------------------------ */

check('grounded stations outrank every decoy within N minutes of drift', () => {
  const f = [feed('found-1'), feed('found-2'), feed('found-3')];
  let radio;
  const advance = (seconds) => {
    for (let i = 0; i < seconds / 0.5; i++) radio.update(0.5);
  };
  radio = new SelfRadio({ seed: 'race-seed', getFeed: () => f, getLoadout: () => [] });
  advance(RAMP_SECONDS); // full ramp reached
  const weights = radio.weights();
  for (const [key, w] of weights) {
    if (key.startsWith('decoy:')) continue;
    for (let d = 0; d < DECOY_COUNT; d++) {
      assert.ok(w > (weights.get('decoy:' + d) ?? -1),
        `${key} (${w}) outranks decoy:${d}`);
    }
  }
});

check('selection weight rises with drift time while grounded', () => {
  const f = [feed('rise-1')];
  const radio = new SelfRadio({ seed: 'ramp-seed', getFeed: () => f, getLoadout: () => [] });
  radio.update(1);
  const early = radio.weights().get('discovery:rise-1');
  radio.update(RAMP_SECONDS);
  const late = radio.weights().get('discovery:rise-1');
  assert.ok(late > early, `late ${late} > early ${early}`);
  assert.equal(radio.weights().get('decoy:0'), 0, 'decoy never rises');
});

check('bestStation locks onto a real discovery, never a decoy', () => {
  const f = [feed('best-1', 'landmark', 'lm')];
  const radio = new SelfRadio({ seed: 'lock-seed', getFeed: () => f, getLoadout: () => ['camcorder'] });
  for (let i = 0; i < 300; i++) radio.update(0.5);
  const best = radio.bestStation();
  assert.ok(best, 'a best station exists');
  assert.ok(!best.decoy, 'dominant station is grounded');
  const air = radio.onAir();
  assert.ok(air && !air.station.decoy, 'onAir reports the grounded broadcast');
  assert.ok(air.clarity > 0.99, 'clarity saturates after full ramp');
  assert.equal(air.script.length, 3, 'three-line broadcast');
});

/* ------------------------------------------------------------------ */
/* Drift monotonicity                                                  */
/* ------------------------------------------------------------------ */

check('dial drift is monotone toward the dominant station', () => {
  const f = [feed('drift-1', 'landmark', 'long-corridor')];
  const radio = new SelfRadio({ seed: 'drift-seed', getFeed: () => f, getLoadout: () => [] });
  radio.update(30); // establish the target before measuring
  const target = radio.bestStation().freq;
  let prevDist = Math.abs(target - radio.dialMhz);
  for (let i = 0; i < 400; i++) {
    radio.update(0.25);
    const d = Math.abs(target - radio.dialMhz);
    assert.ok(d <= prevDist + 1e-12, `distance shrank or held at step ${i}: ${d} vs ${prevDist}`);
    prevDist = d;
  }
  assert.ok(prevDist < 0.01, `converged onto the carrier (residual ${prevDist})`);
});

check('dial travel per step respects the drift rate cap', () => {
  const f = [feed('speed-1')];
  const radio = new SelfRadio({ seed: 'speed-seed', getFeed: () => f, getLoadout: () => [] });
  const start = radio.dialMhz;
  // two half-second steps early in the ramp: real movement, far from target
  radio.update(0.5);
  radio.update(0.5);
  const travelled = Math.abs(radio.dialMhz - start);
  assert.ok(travelled > 0, 'drift actually moved the dial');
  assert.ok(travelled <= 0.4 * 1.0 + 1e-9,
    `one second of drift stays inside DRIFT_RATE_MHZ: ${travelled}`);
});

/* ------------------------------------------------------------------ */
/* Silence safety                                                      */
/* ------------------------------------------------------------------ */

check('empty feed keeps the dial frozen and the receiver silent', () => {
  const radio = new SelfRadio({ seed: 'quiet-seed', getFeed: () => [], getLoadout: () => [] });
  for (let i = 0; i < 200; i++) radio.update(1);
  assert.equal(radio.bestStation(), null, 'no dominant station');
  assert.equal(radio.onAir(), null, 'nothing on air');
  for (const w of radio.weights().values()) assert.equal(w, 0, 'all weights pinned at zero');
  // loadout-only discoveries still ground without any feed entries
  const lo = new SelfRadio({ seed: 'lo-seed', getFeed: () => [], getLoadout: () => ['torch'] });
  lo.update(RAMP_SECONDS);
  assert.ok(lo.bestStation() && !lo.bestStation().decoy);
});

check('non-positive dt and stop() leave state untouched', () => {
  const f = [feed('guard-1')];
  const radio = new SelfRadio({ seed: 'guard-seed', getFeed: () => f, getLoadout: () => [] });
  const t0 = radio.driftSeconds;
  const dial0 = radio.dialMhz;
  radio.update(0);
  radio.update(-3);
  assert.equal(radio.driftSeconds, t0);
  assert.equal(radio.dialMhz, dial0);
  radio.update(1);
  radio.stop();
  const frozenDrift = radio.driftSeconds;
  const frozenDial = radio.dialMhz;
  radio.update(10);
  assert.equal(radio.driftSeconds, frozenDrift);
  assert.equal(radio.dialMhz, frozenDial);
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
