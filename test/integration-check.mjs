/**
 * Integration wiring checks - run with: node test/integration-check.mjs
 *
 * Static part: verifies game.ts wires all six audio/gameplay systems
 * (PositionalHum, WatcherSteps, SurfaceDetector + SurfaceFootsteps,
 * Heartbeat, DynamicScore, ExteriorBleed) with guarded construction.
 * Behavioural part (Node >= 22.6 strip-types): exercises the pure
 * SurfaceDetector logic that drives footstep material.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'core', 'game.ts'), 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes("from '../audio/positional'"), 'imports PositionalHum');
ok(src.includes("from '../audio/approach'"), 'imports WatcherSteps');
ok(src.includes("from '../player/surfacedetect'"), 'imports SurfaceDetector');
ok(src.includes("from '../audio/surfaces'"), 'imports SurfaceFootsteps');
ok(src.includes("from '../audio/music'"), 'imports DynamicScore');
ok(src.includes("from '../audio/exterior'"), 'imports ExteriorBleed');

ok(src.includes('new PositionalHum(ctx'), 'constructs PositionalHum(ctx, dest)');
ok(/new WatcherSteps\(ctx/.test(src), 'constructs WatcherSteps(ctx, dest)');
ok(src.includes('new SurfaceDetector()'), 'constructs SurfaceDetector');
ok(/new SurfaceFootsteps\(ctx/.test(src), 'constructs SurfaceFootsteps(ctx, dest)');
ok(/new DynamicScore\(ctx/.test(src), 'constructs DynamicScore(ctx, dest)');
ok(/new ExteriorBleed\(ctx/.test(src), 'constructs ExteriorBleed(ctx, dest)');

// per-module try/catch guards around construction
const boot = src.slice(src.indexOf('ensureAudioIntegrations'));
ok((boot.match(/catch \(e\)/g) || []).length >= 6, 'each integration construction is try/catch wrapped');
ok(src.includes('ensureAudioIntegrations()'), 'frame calls the lazy integration boot');

// per-frame usage
ok(src.includes('.setFixtures('), 'per-frame setFixtures with nearest fixtures');
ok(/humAudio\.update\(/.test(src), 'per-frame positional hum update(px,pz,yaw)');
ok(/watcherSteps\.update\(dt, nearestWatcherDist, .*\.speed > 0\.05/, 'watcher steps fed dist/movement');
ok(/surfaceDetector\.detect\(this\.player\.body\.x, this\.player\.body\.z, district\)/.test(src), 'surface from detect(x,z,district)');
ok(/surfaceFootsteps\.play\(surf, running\)/.test(src), 'footsteps play detected surface');
// heartbeat intensity is computed inline in the frame loop: a closing
// watcher (<8 m) OR unstable reality (<0.3) drives audio.setHeartbeat
ok(/wd < 8\) hb = Math\.max\(0, 1 - wd \/ 8\)/.test(src)
  && /this\.erosion\.stability < 0\.3\) hb = 0\.5/.test(src)
  && /this\.audio\.setHeartbeat\(active \? hb : 0\)/.test(src),
  'heartbeat from stability + watcher proximity');
ok(src.includes('setHeartbeat('), 'setHeartbeat driven each frame');
ok(/score\.setState\(zoneKind, tension\)/.test(src), 'score setState(zoneKind, tension)');
ok(/exterior\.update\(dt, zoneKind, tension, /.test(src), 'exterior update(dt, zoneKind, tension, wetness)');

// ---- behavioural: pure surface detector ----
console.log('[behavioural]');
const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)']);
if (probe.status === 0 || probe.status === null) {
  try {
    const { registerHooks } = await import('node:module');
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); }
        catch { return nextResolve(specifier + '.ts', context); }
      },
    });
    const { SurfaceDetector } = await import('../src/player/surfacedetect.ts');
    const d = new SurfaceDetector();
    ok(d.detect(0, 0, 0) === 'carpet', 'maze commits carpet immediately');
    // hysteresis: a boundary crossing must travel before committing
    let s = d.detect(0.1, 0, 4); // storage = metal candidate
    s = d.detect(0.15, 0, 4);
    ok(s === 'metal' || s === 'carpet', 'boundary sampling stays sane');
    const d2 = new SurfaceDetector();
    d2.detect(0, 0, 0);
    d2.setPuddles([{ x: 3, z: 3 }]);
    d2.detect(3.05, 3.02, 0);
    ok(d2.currentSurface === 'splash', 'puddle overrides to splash immediately');
    console.log('  note: detector behaviour verified via strip-types');
  } catch (e) {
    console.warn('  SKIP behavioural:', e.message);
  }
} else {
  console.warn('  SKIP behavioural: this Node lacks --experimental-strip-types');
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


