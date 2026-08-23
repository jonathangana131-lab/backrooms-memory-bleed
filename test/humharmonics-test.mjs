/*
 * Hum harmonic enrichment tests — pure Node, no browser.
 * Drives HumHarmonics against a minimal WebAudio mock and checks:
 *   1. the layer builds fundamental + odd harmonics at 60/180/300/420 Hz
 *      with -12/-18/-24 dB relative gains
 *   2. it starts silent and only speaks after setFixtureCount + update
 *   3. one fixture: lead voice only; two fixtures: twin voice fades in
 *      with its fundamental detuned 0.5-2 Hz (the beat window)
 *   4. age warble: a slow LFO feeds both fundamentals, depth scales with
 *      district age and never exceeds +/-0.5% of 60 Hz
 *   5. older districts grow hotter harmonics; unknown districts fall back
 *   6. update() drifts the beat but keeps it inside the window;
 *      setFixtureCount(0) mutes everything again; stop() silences
 */
import {
  HumHarmonics,
  HUM_FUNDAMENTAL,
  HUM_REF_LEVEL,
  ODD_HARMONICS,
  dbToGain,
} from '../src/audio/humharmonics.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.sets = [];    // {v}
    this.ramps = [];   // {v, kind}
    this.targets = []; // {v, tau}
    this.out = null;   // node/param connected TO us via connect()
  }
  setValueAtTime(v) { this.value = v; this.sets.push({ v }); }
  linearRampToValueAtTime(v) { this.ramps.push({ v, kind: 'lin' }); }
  exponentialRampToValueAtTime(v) { this.ramps.push({ v, kind: 'exp' }); }
  setTargetAtTime(v, _t, tau) { this.targets.push({ v, tau }); }
  cancelScheduledValues() {}
}
/** Most recent setTargetAtTime target, or the static value. */
const lastTarget = (p) => (p.targets.length ? p.targets[p.targets.length - 1].v : p.value);


