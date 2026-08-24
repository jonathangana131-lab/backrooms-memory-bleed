/**
 * Watcher molt tests (src/entities/molt.ts, F62).
 * Standalone (no browser): transpiles rng.ts + molt.ts into a temp dir and
 * drives the pool directly, same idiom as longhall-test.
 *
 * Acceptance:
 *   1. decoy-iff-despawn  - a decoy exists exactly when a despawn fired;
 *   2. fear-math consumer - injected proximity fear sees the decoy while it
 *      lives and stops seeing it after decay or touch;
 *   3. lifetime + touch   - gone after its seeded 60-120 s lifetime, or
 *      immediately on direct touch;
 *   4. determinism        - same seed + same despawn timeline => identical
 *      lifetimes/removal times; different seed => different lifetimes;
 *   5. bounded            - at most MAX_ALIVE_MOLTS decoys alive at once.
 *
 * Run: node test/molt-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-molt-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/entities'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/entities/molt.ts', 'src/entities/molt.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const molt = await import(pathToFileURL(path.join(tmp, 'src/entities/molt.mjs')).href);

const SEED = 0x0ddba11;
const AWAY = { x: 9999, z: 9999 }; // player far away: no touches

function despawn(id, x, z, t) {
  return { watcherId: id, silhouetteId: 'watcher-tall-' + (id % 3), pos: { x, z }, timeS: t };
}

// ---- 1. decoy exists iff a despawn occurred --------------------------------
{
  const sys = new molt.MoltSystem(SEED);
  check('no despawns -> no decoys', sys.decoys.length === 0 && sys.fearSources().length === 0);
  const d = sys.onDespawn(despawn(7, 10, 20, 100));
  check('one despawn -> exactly one decoy with same silhouette at last pos',
    d !== null && sys.decoys.length === 1 &&
    sys.decoys[0].silhouetteId === 'watcher-tall-1' &&
    sys.decoys[0].pos.x === 10 && sys.decoys[0].pos.z === 20);
  const again = sys.onDespawn(despawn(7, 11, 21, 150));
  check('repeat despawn of same watcher is idempotent',
    again === null && sys.decoys.length === 1 && sys.decoys[0].pos.x === 10);
}

// ---- 2. fear-math consumer --------------------------------------------------
{
  // Injected consumer: sums inverse-distance fear over all watcher-presence
  // positions within RADIUS, exactly like live-watcher proximity math.
  const RADIUS = 12;
  function proximityFear(sys, nowS, playerPos) {
    let f = 0;
    for (const src of sys.fearSources()) {
      const dx = src.pos.x - playerPos.x;
      const dz = src.pos.z - playerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= RADIUS) f += 1 - dist / RADIUS;
    }
    return f;
  }
  const sys = new molt.MoltSystem(SEED);
  sys.onDespawn(despawn(11, 4, 3, 0)); // ~5 m from origin: inside radius
  const near = proximityFear(sys, 1, { x: 0, z: 0 });
  check('consumer feels fear from living decoy', near > 0, String(near));
  const far = proximityFear(sys, 1, { x: 100, z: 100 });
  check('consumer feels nothing when far outside radius', far === 0, String(far));
  // Decay past max band removes presence.
  sys.update(molt.MOLT_LIFETIME_MAX_S + 1e-6, AWAY);
  check('fear stops after decay', sys.fearSources().length === 0 && proximityFear(sys, 200, { x: 0, z: 0 }) === 0);
}

// ---- 3. lifetime band + touch ----------------------------------------------
{
  const sys = new molt.MoltSystem(SEED);
  const d = sys.onDespawn(despawn(21, 0, 0, 50));
  const life = d.expireTimeS - d.spawnTimeS;
  check('lifetime within seeded band [60,120]',
    life >= molt.MOLT_LIFETIME_MIN_S - 1e-9 && life <= molt.MOLT_LIFETIME_MAX_S + 1e-9,
    String(life));
  // Still alive just before expiry, gone after.
  const rBefore = sys.update(d.expireTimeS - 0.01, AWAY);
  check('decoy alive up to its expire time', rBefore.length === 0 && sys.decoys.length === 1);
  const rAfter = sys.update(d.expireTimeS + 0.01, AWAY);
  check('decoy decays after lifetime',
    rAfter.length === 1 && rAfter[0].reason === 'decayed' && sys.decoys.length === 0);
}
{
  const sys = new molt.MoltSystem(SEED);
  sys.onDespawn(despawn(31, 5, 5, 0));
  sys.onDespawn(despawn(32, 50, 50, 0));
  const removed = sys.update(1, { x: 5.2, z: 5 }); // within TOUCH_RADIUS of first only
  check('direct touch kills the touched decoy only, immediately',
    removed.length === 1 && removed[0].reason === 'touched' &&
    removed[0].decoy.watcherId === 31 && sys.decoys.length === 1 &&
    sys.decoys[0].watcherId === 32);
}

// ---- 4. determinism per seed -------------------------------------------------
{
  const timeline = [
    despawn(41, 1, 1, 0), despawn(42, 30, 30, 10), despawn(43, -5, 8, 25),
  ];
  function replay(seed) {
    const sys = new molt.MoltSystem(seed);
    for (const e of timeline) sys.onDespawn(e);
    return sys.decoys.map((d) => ({ id: d.watcherId, exp: d.expireTimeS }));
  }
  const a = replay(777);
  const b = replay(777);
  const c = replay(778);
  check('identical seed replays byte-identical lifetimes', JSON.stringify(a) === JSON.stringify(b));
  check('different seed yields different lifetimes', JSON.stringify(a) !== JSON.stringify(c));
  const livesA = a.map((d) => d.exp - timeline.find((e) => e.watcherId === d.id).timeS);
  check('lifetimes spread across the band across seeds (not constant)',
    new Set(
      [700, 701, 702, 123456, 987654].map((s) =>
        replay(s).map((d) => Math.round((d.exp - timeline.find((e) => e.watcherId === d.id).timeS) * 100)).join(','),
      ),
    ).size > 1,
  );
}

// ---- 5. bounded <= MAX_ALIVE_MOLTS -------------------------------------------
{
  const sys = new molt.MoltSystem(SEED);
  for (let i = 0; i < 8; i++) sys.onDespawn(despawn(100 + i, i * 10, i * 10, i));
  check('pool never exceeds MAX_ALIVE_MOLTS', sys.decoys.length === molt.MAX_ALIVE_MOLTS,
    String(sys.decoys.length));
  check('bound evicts oldest skins first (newest kept)',
    sys.decoys.every((d) => d.watcherId >= 105),
    sys.decoys.map((d) => d.watcherId).join(','));
  // Evictions do not break determinism: replay matches.
  const sys2 = new molt.MoltSystem(SEED);
  for (let i = 0; i < 8; i++) sys2.onDespawn(despawn(100 + i, i * 10, i * 10, i));
  check('bounded pool deterministic per seed',
    JSON.stringify(sys.decoys) === JSON.stringify(sys2.decoys));
}

console.log(failures === 0 ? '\nMOLT_PASS' : `\nMOLT_FAIL failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
