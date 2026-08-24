/**
 * F27 Watcher pack tests.
 *
 * Verifies against src/entities/watcherpacks.ts:
 *   1. spacing discipline: across long simulated chases (seeded player
 *      random walks, members adopting commanded targets), no two pack
 *      members ever come closer than MIN_MEMBER_SPACING; with speed-capped
 *      pursuit the spacing never drops below the 0.9x hard floor
 *   2. ring formation: commanded targets sit on the injected radius bands
 *      around the player and spread around them
 *   3. stage gating: below STAGE_GATE the coordinator refuses activation —
 *      state stays 'inactive', commands hold position, sightings raise nothing
 *   4. shared aggression: ONE member's sighting raises stalkLevel for ALL
 *      commands; level decays linearly over time back to zero
 *   5. determinism per seed: identical inputs => identical command streams;
 *      different seeds rotate the formation differently
 *
 * TypeScript sources are transpiled on the fly (same idiom as fauna-test).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.watcherpacks-build');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const srcTxt = readFileSync(join(ROOT, relSrc), 'utf8');
  const out = ts.transpileModule(srcTxt, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
    isolatedModules: true,
  }).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.js'");
  const outPath = join(BUILD, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
}
rmSync(BUILD, { recursive: true, force: true });
transpile('src/core/rng.ts', 'src/core/rng.js');
transpile('src/entities/watcherpacks.ts', 'src/entities/watcherpacks.js');

const W = await import(join(BUILD, 'src/entities/watcherpacks.js'));
const { RNG } = await import(join(BUILD, 'src/core/rng.js'));

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Seeded player random walk; returns iterator of {x,z}. */
function playerWalk(seed, steps, stepLen = 3.5) {
  const rng = new RNG(seed);
  const pts = [{ x: 0, z: 0 }];
  let x = 0, z = 0;
  for (let i = 0; i < steps; i++) {
    const ang = rng.next() * Math.PI * 2;
    x += Math.cos(ang) * stepLen;
    z += Math.sin(ang) * stepLen;
    pts.push({ x, z });
  }
  return pts;
}

// ---- 1. spacing invariant across simulated chases ----------------------------
{
  let worst = Infinity;
  let worstCapped = Infinity;
  for (let sim = 0; sim < 20; sim++) {
    const N = 2 + (sim % 5);
    const stage = () => 4;
    // teleport-pursuit mode: members adopt commanded targets directly
    const packA = new W.WatcherPack({ memberIds: Array.from({ length: N }, (_, i) => i), stage, seed: 1000 + sim });
    let bodies = Array.from({ length: N }, (_, i) => ({ id: i, x: 60 + i * 7, z: -40 + i * 3 }));
    const walk = playerWalk(500 + sim, 400);
    for (const p of walk) {
      const cmds = packA.update(0.05, p.x, p.z, bodies.map((b, i) => ({ ...b, sawPlayer: i === 0 && sim % 7 === 0 })));
      bodies = cmds.map((c) => ({ id: c.id, x: c.tx, z: c.tz }));
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          worst = Math.min(worst, dist(bodies[i], bodies[j]));
        }
      }
    }
    // speed-capped mode: bodies move toward tx/tz at the commanded velocity
    const packB = new W.WatcherPack({ memberIds: Array.from({ length: N }, (_, i) => i), stage, seed: 2000 + sim });
    bodies = Array.from({ length: N }, (_, i) => ({ id: i, x: -30 + i * 4, z: 25 - i * 6 }));
    for (const p of playerWalk(900 + sim, 400)) {
      const cmds = packB.update(0.05, p.x, p.z, bodies.map((b) => ({ ...b })));
      bodies = cmds.map((c) => {
        const b = bodies.find((bb) => bb.id === c.id);
        return { id: c.id, x: b.x + c.vx * 0.05, z: b.z + c.vz * 0.05 };
      });
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          worstCapped = Math.min(worstCapped, dist(bodies[i], bodies[j]));
        }
      }
    }
  }
  check(`spacing invariant (teleport chase): worst pair ${worst.toFixed(4)}m >= ${W.MIN_MEMBER_SPACING}`, worst >= W.MIN_MEMBER_SPACING - 1e-6);
  check(`spacing floor held under capped pursuit: ${worstCapped.toFixed(4)}m >= ${(W.MIN_MEMBER_SPACING * 0.9).toFixed(2)}m`, worstCapped >= W.MIN_MEMBER_SPACING * 0.9 - 1e-6);
}

// ---- 2. ring formation bands ---------------------------------------------------
{
  const stage = () => 4;
  const pack = new W.WatcherPack({ memberIds: [0, 1, 2, 3], stage, seed: 77 });
  const px = 12, pz = -8;
  // run to convergence so targets sit at band radii
  let bodies = [0, 1, 2, 3].map((i) => ({ id: i, x: px + 20 + i, z: pz + 20 }));
  let cmds = null;
  for (let i = 0; i < 600; i++) {
    cmds = pack.update(0.05, px, pz, bodies.map((b) => ({ ...b })));
    bodies = cmds.map((c) => ({ id: c.id, x: c.tx, z: c.tz }));
  }
  const radii = bodies.map((b) => Math.hypot(b.x - px, b.z - pz)).sort((a, b) => a - b);
  check(
    `converged targets sit on band radii (${radii.map((r) => r.toFixed(2)).join(', ')})`,
    Math.abs(radii[0] - W.RING_BANDS[0]) < 0.01 && Math.abs(radii[3] - W.RING_BANDS[1]) < 0.01,
  );
  // inner/outer split: ceil(4/2)=2 per band
  check('band split is ceil(n/2) / rest', Math.abs(radii[1] - W.RING_BANDS[0]) < 0.01 && Math.abs(radii[2] - W.RING_BANDS[1]) < 0.01);
  // spread: angular gaps between inner-band slots are even
  const angs = bodies
    .map((b) => Math.atan2(b.z - pz, b.x - px))
    .sort((a, b) => a - b);
  check('members encircle the player (>2 rad total spread)', Math.abs(angs[angs.length - 1] - angs[0]) > 2);
}

// ---- 3. stage gating ------------------------------------------------------------
{
  let stage = 2;
  const pack = new W.WatcherPack({ memberIds: [0, 1, 2], stage: () => stage, seed: 5 });
  const bodies = [0, 1, 2].map((i) => ({ id: i, x: 10 + i * 2, z: 10 }));
  const cmds = pack.update(0.1, 0, 0, bodies.map((b) => ({ ...b, sawPlayer: true })));
  check('below gate: state refuses activation', pack.state === 'inactive');
  check('below gate: hold commands', cmds.every((c) => c.vx === 0 && c.vz === 0 && c.speed === 0));
  check('below gate: sighting raises nothing', pack.stalkLevel === 0);

  const before = cmds.map((c) => ({ id: c.id, x: c.tx, z: c.tz }));
  stage = 3;
  const cmds2 = pack.update(0.1, 0, 0, bodies.map((b) => ({ ...b, sawPlayer: false })));
  check('at gate: activates', pack.state === 'stalking');
  check('activation issues movement orders', cmds2.some((c) => Math.hypot(c.vx, c.vz) > 0));
  check('hold targets were current positions', before.every((c, i) => c.x === bodies[i].x && c.z === bodies[i].z));

  // sightings still ignored while inactive (stage drops back mid-stalk)
  stage = 1;
  pack.update(0.1, 0, 0, bodies.map((b) => ({ ...b, sawPlayer: true })));
  check('deactivated pack ignores sightings again', pack.state === 'inactive');
}

// ---- 4. shared aggression + decay timeline --------------------------------------
{
  const stage = () => 4;
  const pack = new W.WatcherPack({ memberIds: [0, 1, 2, 3], stage, seed: 9 });
  let bodies = [0, 1, 2, 3].map((i) => ({ id: i, x: 40 + i * 8, z: -15 }));
  // settle into stalking
  for (let i = 0; i < 5; i++) {
    pack.update(0.05, 0, 0, bodies.map((b) => ({ ...b })));
  }
  // exactly ONE member sees the player
  const cmds = pack.update(0.05, 0, 0, bodies.map((b, i) => ({ ...b, sawPlayer: i === 2 })));
  check('one sighting lifts the shared level', Math.abs(pack.stalkLevel - W.AGGRESSION_RISE) < 1e-9);
  check('ALL members carry the same aggression', cmds.every((c) => c.aggression === pack.stalkLevel));
  // repeated sightings stack toward 1 but never past it
  for (let i = 0; i < 10; i++) pack.update(0.05, 0, 0, bodies.map((b, k) => ({ ...b, sawPlayer: k === 0 })));
  check('repeated sightings saturate at 1', pack.stalkLevel === 1);

  // decay timeline: linear AGGRESSION_DECAY_PER_SEC back to zero
  const samples = [];
  let last = pack.stalkLevel;
  while (last > 0) {
    pack.update(0.25, 0, 0, bodies.map((b) => ({ ...b })));
    last = pack.stalkLevel;
    samples.push(last);
  }
  const expectedSteps = Math.ceil(1 / (W.AGGRESSION_DECAY_PER_SEC * 0.25));
  check(
    `decay reaches zero in ~${expectedSteps} ticks (${samples.length} taken), monotone`,
    samples.length <= expectedSteps && samples.every((v, i) => i === 0 || v < samples[i - 1]),
  );

  // decay rate is exact between sightings
  const pack2 = new W.WatcherPack({ memberIds: [0], stage, seed: 10 });
  pack2.update(0.05, 0, 0, [{ id: 0, x: 50, z: 50 }]);
  pack2.update(0.05, 0, 0, [{ id: 0, x: 50, z: 50, sawPlayer: true }]);
  const lv0 = pack2.stalkLevel;
  pack2.update(1, 0, 0, [{ id: 0, x: 50, z: 50 }]);
  check(
    `decay per second is exact (${lv0.toFixed(4)} -> ${pack2.stalkLevel.toFixed(4)})`,
    Math.abs(pack2.stalkLevel - (lv0 - W.AGGRESSION_DECAY_PER_SEC)) < 1e-9 || pack2.stalkLevel === 0,
  );
}

// ---- 5. determinism per seed -----------------------------------------------------
{
  function replay(seed) {
    const stage = () => 4;
    const pack = new W.WatcherPack({ memberIds: [0, 1, 2, 3, 4], stage, seed });
    let bodies = [0, 1, 2, 3, 4].map((i) => ({ id: i, x: 80 + i * 5, z: -70 + i * 4 }));
    const trace = [];
    for (const p of playerWalk(31337, 300)) {
      const cmds = pack.update(0.05, p.x, p.z, bodies.map((b) => ({ ...b })));
      trace.push(cmds.map((c) => [+c.tx.toFixed(9), +c.tz.toFixed(9), +c.vx.toFixed(9), +c.aggression.toFixed(9)]));
      bodies = cmds.map((c) => ({ id: c.id, x: c.tx, z: c.tz }));
    }
    return JSON.stringify(trace);
  }
  check('same seed replays identical command streams', replay(0xabcd) === replay(0xabcd));
  let differing = 0;
  for (let k = 0; k < 8; k++) if (replay(k) !== replay(0xabcd)) differing++;
  check(`different seeds diverge (${differing}/8 differ)`, differing >= 7);
}

console.log(failures.length === 0 ? `ALL PASS (${passed} checks)` : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
