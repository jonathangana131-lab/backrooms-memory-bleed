/**
 * Headless tests for the relocation echo system.
 *
 * EchoSites runs logic-only without an AudioContext (proximity, visit
 * escalation, getIntensity), so these run in plain Node. Node >= 22.18
 * strips types from .ts imports natively; run with:
 *
 *   node --test test/echoes-test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoSites, positionSeed } from '../src/audio/echoes.ts';

test('markSite registers relocation points', () => {
  const es = new EchoSites();
  es.markSite(100, 200);
  assert.equal(es.sites.length, 1);
  assert.equal(es.sites[0].x, 100);
  assert.equal(es.sites[0].z, 200);
  assert.equal(es.sites[0].visits, 0);
});

test('marks near an existing site are absorbed, distinct sites kept', () => {
  const es = new EchoSites();
  es.markSite(0, 0);
  es.markSite(5, 3);   // ~5.8m away: absorbed
  es.markSite(40, 0);  // far away: kept
  assert.equal(es.sites.length, 2);
});

test('site seeds are deterministic per position', () => {
  assert.equal(positionSeed(12.5, -7.25), positionSeed(12.5, -7.25));
  assert.notEqual(positionSeed(1, 2), positionSeed(2, 1));
});

test('getIntensity is 0 with no sites or outside the ring', () => {
  const es = new EchoSites();
  assert.equal(es.getIntensity(0, 0), 0);
  es.markSite(0, 0);
  // never visited yet -> no bleed
  assert.equal(es.getIntensity(3, 4), 0);
  es.update(0.016, 3, 4); // first entry counts visit 1
  assert.equal(es.sites[0].visits, 1);
  assert.equal(es.getIntensity(50, 50), 0); // far away
});

test('getIntensity grows with proximity and revisits', () => {
  const es = new EchoSites();
  es.markSite(0, 0);
  const at = (px, pz) => es.getIntensity(px, pz);

  // visit 1
  es.update(0.016, 2, 0);
  const v1near = at(0.5, 0);
  const v1far = at(10, 0);
  assert.ok(v1near > 0, "inside ring has intensity");
  assert.ok(v1near > v1far, "closer is stronger");
  assert.ok(v1near <= 1, "clamped to 0..1");

  // leave past hysteresis radius, come back: visit 2
  es.update(0.016, 30, 0);
  es.update(0.016, 2, 0);
  assert.equal(es.sites[0].visits, 2);
  const v2 = at(0.5, 0);
  assert.ok(v2 > v1near, "second visit escalates");

  // third visit reaches full escalation weight
  es.update(0.016, 30, 0);
  es.update(0.016, 0.5, 0);
  assert.equal(es.sites[0].visits, 3);
  const v3 = at(0.5, 0);
  assert.ok(v3 > v2, "third visit escalates again");
  assert.ok(v3 <= 1);
});

test('hysteresis: jitter around 15m does not inflate visits', () => {
  const es = new EchoSites();
  es.markSite(0, 0);
  for (let i = 0; i < 20; i++) {
    es.update(0.016, i % 2 === 0 ? 14 : 16, 0);
  }
  assert.equal(es.sites[0].visits, 1);
});

test('escalating audio cues: single, then overlapping pair, then murmur', () => {
  const es = new EchoSites();
  es.markSite(0, 0);

  // helper: advance the clock in 50ms frames until the next cue fires
  const advance = (es2, px, pz, maxFrames) => {
    for (let i = 0; i < maxFrames; i++) {
      const before = es2.lastCueAt;
      es2.update(0.05, px, pz);
      if (es2.lastCueAt !== before) return true;
    }
    return false;
  };

  // first entry (cue fires within ~0.55s): one lone fragment
  es.update(0.05, 3, 0);
  assert.ok(advance(es, 3, 0, 20), "entry cue fired on first visit");
  assert.equal(es.lastCueCount, 1);
  // fragments do not machine-gun while standing still
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    const before = es.lastCueAt;
    es.update(0.05, 3, 0);
    if (es.lastCueAt !== before) fired++;
  }
  const msg = "sparse pacing, saw " + fired + " refires";
  assert.ok(fired <= 3, msg);

  // second visit: two overlapping fragments
  es.update(0.05, 30, 0);
  es.update(0.05, 3, 0);
  assert.ok(advance(es, 3, 0, 20), "entry cue fired on second visit");
  assert.equal(es.lastCueCount, 2);

  // third visit: continuous murmur flag engages
  assert.equal(es.murmurActive, false);
  es.update(0.05, 30, 0);
  es.update(0.05, 3, 0);
  assert.equal(es.murmurActive, true);

  // murmur drops when leaving range again
  es.update(0.05, 30, 0);
  assert.equal(es.murmurActive, false);
});

test('update ignores non-positive dt and stop() halts everything', () => {
  const es = new EchoSites();
  es.markSite(0, 0);
  es.update(0, 3, 0);
  es.update(-1, 3, 0);
  assert.equal(es.sites[0].visits, 0, "no time passes, no visits counted");

  es.update(0.016, 3, 0);
  es.stop();
  const visits = es.sites[0].visits;
  es.update(0.016, 3, 0);
  assert.equal(es.sites[0].visits, visits, "stopped instance stops counting");
  assert.equal(es.murmurActive, false);
});

test('multiple sites report independently', () => {
  const es = new EchoSites();
  es.markSite(0, 0);
  es.markSite(100, 0);
  es.update(0.016, 3, 0);      // visit site A once
  assert.ok(es.getIntensity(0, 0) > 0);
  assert.equal(es.getIntensity(97, 0), 0); // B untouched
});


