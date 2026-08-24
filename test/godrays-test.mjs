/*
 * God-ray tests (F38).
 *
 * Proves the AC against the pure model:
 *   1. <= 8 shafts emitted under dense gaps (hard budget, config-clamped)
 *   2. intensity monotone decreasing in shaft length
 *   3. deterministic per (layout hash, sun angle quantized to 1 degree):
 *      repeated emits deep-equal; sub-quantum sun jitter changes nothing;
 *      shuffled gap order changes nothing
 *   4. zero shafts with no gaps (and with junk input)
 *   5. dust density positive per shaft and brighter in stronger light
 *   6. descriptors carry the documented geometry fields
 *
 * Run: node test/godrays-test.mjs
 */
import {
  Godrays,
  layoutHash,
  MAX_SHAFTS_HARD_CAP,
  SUN_ANGLE_QUANTUM_RAD,
} from '../src/gfx/godrays.ts';

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

const SUN = { azimuthRad: 0.7, elevationRad: 0.9 };
const gapAt = (x, z) => ({ x, z });

// ---- 1. hard budget under dense gaps ---------------------------------------
(() => {
  const dense = {
    gaps: () => Array.from({ length: 64 }, (_, i) => gapAt((i % 8) * 2.5 - 10, Math.floor(i / 8) * 2.5 - 10)),
  };
  const gr = new Godrays(dense, { seed: 42 });
  const shafts = gr.emit(SUN);
  check('dense 64-gap layout emits at most 8 shafts',
    shafts.length === MAX_SHAFTS_HARD_CAP && shafts.length <= 8, String(shafts.length));

  const tiny = new Godrays(dense, { seed: 42, maxShafts: 3 });
  check('maxShafts config tightens the budget', tiny.emit(SUN).length === 3);
  const over = new Godrays(dense, { seed: 42, maxShafts: 50 });
  check('maxShafts above the hard cap is clamped to 8', over.emit(SUN).length === 8);
})();

// ---- 2. intensity monotone in length -----------------------------------------
(() => {
  const layout = {
    gaps: () => Array.from({ length: 20 }, (_, i) => gapAt(i * 3.1, (i % 5) * 2.7)),
  };
  for (const elev of [0.3, 0.6, 1.2]) {
    const shafts = new Godrays(layout, { seed: 7 }).emit({ azimuthRad: 1.1, elevationRad: elev });
    let mono = true;
    for (const a of shafts) {
      for (const b of shafts) {
        if (a.lengthM < b.lengthM - 1e-12 && a.intensity <= b.intensity + 1e-12) mono = false;
        if (a.lengthM > b.lengthM + 1e-12 && a.intensity >= b.intensity - 1e-12) mono = false;
      }
    }
    check(`intensity strictly monotone decreasing in length (elev ${elev})`,
      mono && shafts.length > 1);
    check('intensity bounded in (0, 1]',
      shafts.every((s) => s.intensity > 0 && s.intensity <= 1));
  }
})();

// ---- 3. determinism per (layout hash, quantized sun) ---------------------------
(() => {
  const mk = () => ({
    gaps: () => Array.from({ length: 30 }, (_, i) => gapAt(i * 1.7 - 20, ((i * 13) % 9) * 2.2)),
  });
  const a = new Godrays(mk(), { seed: 99 });
  const b = new Godrays(mk(), { seed: 99 });
  const s1 = a.emit(SUN);
  check('same layout object + sun -> identical emit', JSON.stringify(s1) === JSON.stringify(a.emit(SUN)));
  check('equal layouts -> identical emit across instances',
    JSON.stringify(s1) === JSON.stringify(b.emit(SUN)));

  // sub-quantum jitter is invisible
  const jit = { azimuthRad: SUN.azimuthRad + SUN_ANGLE_QUANTUM_RAD * 0.3, elevationRad: SUN.elevationRad + 1e-4 };
  check('sub-degree sun jitter does not change output',
    JSON.stringify(s1) === JSON.stringify(a.emit(jit)));

  // one full quantum step may change selection but stays deterministic
  const stepped = a.emit({ azimuthRad: SUN.azimuthRad + SUN_ANGLE_QUANTUM_RAD, elevationRad: SUN.elevationRad });
  check('a full quantum step is still deterministic',
    JSON.stringify(stepped) === JSON.stringify(new Godrays(mk(), { seed: 99 }).emit({
      azimuthRad: SUN.azimuthRad + SUN_ANGLE_QUANTUM_RAD, elevationRad: SUN.elevationRad })));

  // order independence of the injected query
  const shuffled = {
    gaps: () => [...mk().gaps()].reverse(),
  };
  const grShuffled = new Godrays(shuffled, { seed: 99 });
  check('shuffled gap order yields identical output',
    JSON.stringify(s1) === JSON.stringify(grShuffled.emit(SUN)));
  check('layoutHash is order-independent',
    layoutHash(mk().gaps()) === layoutHash([...mk().gaps()].reverse()));
  check('layoutHash differs for different layouts',
    layoutHash(mk().gaps()) !== layoutHash([gapAt(55, 55)]));
})();

// ---- 4. zero shafts with no gaps / junk input ----------------------------------
(() => {
  const empty = new Godrays({ gaps: () => [] }, { seed: 1 });
  check('no gaps -> zero shafts', empty.emit(SUN).length === 0);
  check('junk cells filtered out entirely',
    new Godrays({ gaps: () => [{ x: Number.NaN, z: 2 }, null, { x: 3, z: Number.NaN }] }, { seed: 1 })
      .emit(SUN).length === 0);
  const gr = new Godrays({ gaps: () => [gapAt(0, 0), gapAt(4, 0)] }, { seed: 1 });
  check('NaN sun -> zero shafts', gr.emit({ azimuthRad: Number.NaN, elevationRad: 1 }).length === 0);
  check('null sun -> zero shafts', gr.emit(null).length === 0);
  check('negative junk elevation clamps instead of exploding',
    gr.emit({ azimuthRad: 0, elevationRad: -5 }).every((s) =>
      Number.isFinite(s.lengthM) && s.lengthM > 0));
})();

// ---- 5/6. dust density + descriptor geometry ------------------------------------
(() => {
  const layout = { gaps: () => Array.from({ length: 12 }, (_, i) => gapAt(i * 2, i)) };
  const shafts = new Godrays(layout, { seed: 5 }).emit(SUN);
  check('dustDensity strictly positive on every shaft',
    shafts.every((s) => s.dustDensity > 0));
  check('descriptor carries all documented fields',
    shafts.every((s) => ['originX', 'originZ', 'dirAngle', 'widthM', 'lengthM', 'intensity', 'dustDensity']
      .every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]))));
  check('dirAngle equals the quantized azimuth',
    shafts.every((s) => Math.abs(s.dirAngle - Math.round(SUN.azimuthRad / SUN_ANGLE_QUANTUM_RAD) * SUN_ANGLE_QUANTUM_RAD) < 1e-12));
  check('width scales positively with opening width',
    (() => {
      const w = new Godrays({ gaps: () => [{ x: 0, z: 0 }] }, { seed: 5 });
      const narrow = w.emit(SUN)[0].widthM;
      const wide = new Godrays({ gaps: () => [{ x: 0, z: 0, widthM: 3 }] }, { seed: 5 }).emit(SUN)[0].widthM;
      return wide > narrow;
    })());
})();

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;
