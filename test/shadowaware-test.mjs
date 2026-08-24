/**
 * Shadow awareness tests - pure Node, no renderer.
 *
 * NOTE: the original file tested a legacy ShadowReactions
 * notice-freeze-then-flee state machine; no such module exists in src/
 * (or anywhere in history). Rebuilt as an honest smoke of the surviving
 * shadow-behavior surface, ShadowAudience (F70,
 * src/entities/shadowaudience.ts): silhouettes that react to the player's
 * presence and direct approach.
 *
 *   1. peak gathering - rising tension above the threshold gathers
 *      silhouettes at hall ends, each spawned already facing the player.
 *   2. approach scatter - walking straight into a silhouette scatters
 *      exactly that one; the rest of the audience holds.
 *   3. tension drop scatter - dropping below the threshold scatters
 *      everyone instantly; no re-gather until tension rises again.
 *   4. fresh crowds - the next peak re-gathers with new ids and new
 *      positions, while identical seeds + timelines replay identically.
 *
 * Run: node test/shadowaware-test.mjs  (prints SHADOWAWARE ALL PASS, exits 0)
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const { ShadowAudience } = await import('../src/entities/shadowaudience.ts');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}

// State machine: tension peak gathers a watching audience
{
  let tension = 0;
  const s = new ShadowAudience(() => tension, [{ x: 20, z: 0 }, { x: -20, z: 0 }], 1234, {
    gatherThreshold: 0.5, maxCount: 2, scatterRadius: 3.5,
  });
  const dt = 1 / 60;

  // Below threshold: nothing gathers.
  for (let i = 0; i < 30; i++) s.update(dt, 0, 0);
  check('no audience below gather threshold', !s.gathered && s.silhouettes.length === 0);

  // Rising above threshold: silhouettes appear, already facing the player.
  tension = 1;
  s.update(dt, 0, 0);
  check('peak tension starts gathering', s.gathered && s.silhouettes.length > 0);
  const faced = s.silhouettes.every(
    (sil) => Math.abs(sil.yaw - Math.atan2(0 - sil.x, 0 - sil.z)) < 1e-9,
  );
  check('every silhouette spawns facing the player', faced);
  const nearEnds = s.silhouettes.every(
    (sil) => Math.min(Math.abs(sil.x - 20), Math.abs(sil.x + 20)) <= 0.61 &&
             Math.abs(sil.z) <= 0.61,
  );
  check('silhouettes sit at hall ends within jitter', nearEnds);

  // Crowd holds while the peak holds.
  for (let i = 0; i < 60; i++) s.update(dt, 0, 0);
  check('audience holds through the peak', s.gathered && s.silhouettes.length === 2);

  // Direct approach: exactly the silhouette walked into scatters.
  const victim = s.silhouettes[0];
  const survivorCount = s.silhouettes.length;
  s.update(dt, victim.x, victim.z);
  check('direct approach scatters the approached silhouette',
    s.silhouettes.length === survivorCount - 1 &&
    s.silhouettes.every((sil) => sil.id !== victim.id));

  // Tension drop: everyone scatters instantly.
  tension = 0;
  s.update(dt, 0, 100); // far from any remaining silhouette
  check('tension drop scatters everyone instantly', !s.gathered && s.silhouettes.length === 0);

  // No instant re-gather on the same peak...
  tension = 1;
  s.update(dt, 0, 0);
  check('spent peak does not re-gather', !s.gathered);

  // ...but dropping back down re-arms, and the next peak is fresh.
  tension = 0;
  s.update(dt, 0, 0);
  tension = 1;
  s.update(dt, 0, 0);
  check('next peak gathers a fresh audience', s.gathered && s.silhouettes.length > 0);
  check('fresh crowd uses fresh ids', s.silhouettes.every((sil) => sil.id > victim.id));
}

// Determinism: same seed + same timeline -> byte-identical gatherings.
{
  const run = (seed) => {
    let tension = 0;
    const s = new ShadowAudience(() => tension, [{ x: 15, z: 8 }, { x: -15, z: -8 }], seed, {
      gatherThreshold: 0.5, maxCount: 3,
    });
    const poses = [];
    for (let f = 0; f < 120; f++) {
      if (f === 10) tension = 0.9;
      s.update(1 / 60, Math.cos(f / 40) * 4, Math.sin(f / 40) * 4);
      poses.push(s.silhouettes.map((sil) => [sil.id, sil.x.toFixed(6), sil.z.toFixed(6), sil.yaw.toFixed(6)].join(',')).join(';'));
    }
    return poses;
  };
  const a = run(77);
  const b = run(77);
  const c = run(78);
  check('same seed replays identically', JSON.stringify(a) === JSON.stringify(b));
  check('different seed diverges', JSON.stringify(a) !== JSON.stringify(c));
}

// Fail loud: an audience needs at least one hall end.
{
  assert.throws(() => new ShadowAudience(() => 1, [], 1), /at least one hall end/);
  check('empty hall-end list throws', true);
}

if (failures > 0) {
  console.error('SHADOWAWARE FAILURES: ' + failures);
  process.exit(1);
}
console.log('SHADOWAWARE ALL PASS');
