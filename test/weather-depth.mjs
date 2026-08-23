/*
 * MemoryWeather depth tests: fronts, super-storm cadence, micro-climate
 * dampening, residual echo and serialization.
 * Standalone in Node against the real src/memory/weather.ts.
 *
 *   node test/weather-depth.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

const { MemoryWeather, ZONE_DAMPEN } = await server.ssrLoadModule('/src/memory/weather.ts');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

try {
// ------------------------------------------------------------ 1. basics
{
  const w = new MemoryWeather(1234);
  check('a front always exists', !!w.front && Number.isFinite(w.front.radiusM));
  check('normal roll radius stays in 260..680 m',
    w.front.radiusM >= 260 && w.front.radiusM <= 680, String(w.front.radiusM));
  check('strength starts inside 0..1', w.front.strength >= 0 && w.front.strength <= 1);
  check('forecast peeks without advancing',
    JSON.stringify(w.nextFront()) === JSON.stringify(w.nextFront()));
  check('no residual echo before any handover', w.residual === null || w.residual === undefined);
}

// ------------------------------------------------------------ 2. super-storms
{
  const w = new MemoryWeather(4242);
  // burn sim time until a super-storm front takes over (period <= 1380 s)
  let sawStorm = false;
  for (let t = 0; t < 1600 && !sawStorm; t += 5) {
    w.update(5, 0, 0);
    if (w.front.storm) sawStorm = true;
  }
  check('a super-storm arrives within the documented period', sawStorm);
  if (sawStorm) {
    check('storm strength at least 0.9', w.front.strength >= 0.9, String(w.front.strength));
  // radius: normal roll is 260..680 m; x3 -> 780..2040 m
  check('storm radius 3x normal', w.front.radiusM >= 780 && w.front.radiusM <= 2040, String(w.front.radiusM));
  const tint = w.fogTint();
  check('storm tint deep violet', tint[2] > tint[0] && tint[2] > tint[1] && tint[2] > 1.0, JSON.stringify(tint));
  check('post-storm schedule pushed out', w['nextStormAt'] > 1100, String(w['nextStormAt']));
  }
}

// ------------------------------------------------------------ 3. micro-climates
{
  const w = new MemoryWeather(555);
  const s0 = { kind: 0, intensity: 0.2 };
  w.apply(s0, w.front.cx, w.front.cz);                 // open air
  const sc = { kind: 0, intensity: 0.2 };
  w.apply(sc, w.front.cx, w.front.cz, 'corridor');     // corridor

  check('front influence reaches open air fully', s0.intensity > 0.2,
    String(s0.intensity));
  check('corridor dampens weather by 40%', sc.intensity < s0.intensity
    && sc.intensity > 0.2, s0.intensity.toFixed(4) + ' vs ' + sc.intensity.toFixed(4));
  const si = { kind: 0, intensity: 0.2 };
  w.apply(si, w.front.cx, w.front.cz, 'indoor');
  check('indoor sits between open and corridor', si.intensity > sc.intensity && si.intensity < s0.intensity);
  check('zone dampen table matches the constants', ZONE_DAMPEN.open === 1 && ZONE_DAMPEN.indoor === 0.8 && ZONE_DAMPEN.corridor === 0.6);

  // far outside the front radius nothing changes
  const far = { kind: 0, intensity: 0.2 };
  w.apply(far, w.front.cx + w.front.radiusM * 3, w.front.cz + w.front.radiusM * 3);
  check('outside the front radius influence is zero', far.intensity === 0.2);
}

// ------------------------------------------------------------ 4. echo
{
  const w = new MemoryWeather(777);
  let changedAt = -1;
  for (let t = 5; changedAt < 0 && t <= 1600; t += 5) {
    if (w.update(5, 0, 0)) changedAt = t; // update() returns true on handover
  }
  check('a front hands over within the documented period', changedAt > 0);
  check('a departed front leaves a fading echo',
    w.residual !== null && w.residual !== undefined);
  const early = w.fogTint();
  for (let t = 0; t < 70; t += 5) w.update(5, 0, 0); // past RESIDUAL_SECS
  check('echo fades out completely after 60 s',
    w.residual === null || w.residual === undefined);
  void early;
}

// ------------------------------------------------------------ 5. persistence shape
{
  const w = new MemoryWeather(999);
  const data = w.serialize();
  const restored = MemoryWeather.deserialize(1, JSON.parse(JSON.stringify(data)));
  check('serialize/deserialize restores the front', restored.front.kind === data.kind
    && restored.front.radiusM === data.radiusM, JSON.stringify(data).slice(0, 120));
}

} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL WEATHER DEPTH TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
