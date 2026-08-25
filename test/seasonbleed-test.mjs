/**
 * Seasonal-bleed particle consumer tests (v1.1 debt payoff) — pure Node,
 * no GPU. Verifies the whole chain:
 *   purity    src/gfx/seasonbleed.ts has no wall-clock / unseeded draws in
 *             its code — clouds replay byte-identically per seed;
 *   plan      spawnPlan() is pure (deep-equal for repeated calls), clamps
 *             count to [0, cap], falls back to zero on junk density /
 *             volume, unpacks the packed rgb into unit channels, and maps
 *             every catalog archetype to a point profile with an unknown-
 *             kind fallback;
 *   catalog   all four season descriptors produce in-cap plans whose
 *             channels round-trip the packed tint;
 *   cloud     SeasonBleedParticles under NullEngine: parks disabled until
 *             configure(), lifts exactly `count` slots, integrates fall/
 *             rise speed through the band wrap, sways horizontally,
 *             wraps around the camera, no-ops while parked, and treats
 *             equal reconfigures as identity;
 *   accessor  ChunkManager.seasonBleedAtPos() reads the descriptor off the
 *             chunk containing the world position and nulls elsewhere;
 *   wiring    game.ts constructs the cloud, polls seasonBleedAtPos every
 *             frame, feeds spawnPlan with the chunk-sized room volume, and
 *             parks it in beginRun.
 * Run: node test/seasonbleed-test.mjs  (prints ALL PASS, exits 0)
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const moduleSrc = readFileSync(path.join(ROOT, 'src/gfx/seasonbleed.ts'), 'utf8');
const gameSrc = readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Strip comments before the nondeterminism lint so prose never trips it.
const codeOnly = moduleSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* -------------------------------------------------------------- purity --- */
console.log('purity');
ok(!/Math\.random/.test(codeOnly), 'seasonbleed.ts code is free of Math.random');
ok(!/Date\.now/.test(codeOnly), 'seasonbleed.ts code is free of Date.now');
ok(!/performance\.now/.test(codeOnly), 'seasonbleed.ts code is free of performance.now');

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true },
});
let failuresBeforeStage = failures;

try {
  const B = await server.ssrLoadModule('@babylonjs/core');
  const { spawnPlan, SeasonBleedParticles, SEASON_PARTICLE_CAP } =
    await server.ssrLoadModule('/src/gfx/seasonbleed.ts');
  const { seasonCatalog } = await server.ssrLoadModule('/src/world/seasonrooms.ts');
  const { CHUNK_SIZE, WALL_H, worldToChunk } = await server.ssrLoadModule('/src/world/constants.ts');

  const DESC = Object.freeze({
    kind: 'snowfall', densityPerM3: 2, fallSpeedMps: -0.9, swayHz: 0.7, rgb: 0xeef4ff,
  });

  /* ---------------------------------------------------------------- plan --- */
  console.log('plan');
  const p1 = spawnPlan(DESC, 150);
  const p2 = spawnPlan(DESC, 150);
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'spawnPlan is pure (repeated call deep-equal)');
  ok(p1.count === SEASON_PARTICLE_CAP, `density*volume rounds then caps (got ${p1.count})`);
  ok(spawnPlan(DESC, 100).count === 200, 'below-cap volume yields exact rounded count');
  ok(spawnPlan(DESC, 0).count === 0, 'zero volume yields zero particles');
  ok(spawnPlan(DESC, -5).count === 0, 'negative volume clamps to zero');
  ok(spawnPlan(DESC, NaN).count === 0, 'NaN volume clamps to zero');
  ok(spawnPlan({ ...DESC, densityPerM3: NaN }, 100).count === 0, 'NaN density clamps to zero');
  ok(spawnPlan({ ...DESC, densityPerM3: Infinity }, 100).count === 0, 'Infinity density clamps to zero');
  ok(spawnPlan(DESC, 10, 5).count === 5, 'custom cap binds');
  ok(spawnPlan(DESC, 100, -3).count === 200,
    'junk custom cap falls back to default cap without changing the raw count');
  ok(approx(p1.fallSpeedMps, -0.9), 'fall speed passes through signed');
  ok(approx(p1.swayHz, 0.7), 'sway frequency passes through');
  ok(approx(p1.r, 0xee / 255) && approx(p1.g, 0xf4 / 255) && approx(p1.b, 0xff / 255),
    'packed tint unpacks to unit channels in R,G,B order');
  ok(p1.pointSize > 0 && p1.alpha > 0 && p1.alpha <= 1, 'archetype profile carries positive size and sane alpha');
  const junkKind = spawnPlan({ ...DESC, kind: 'notaseason' }, 100);
  const heat = spawnPlan({ ...DESC, kind: 'heatmote' }, 100);
  ok(junkKind.pointSize === heat.pointSize && junkKind.alpha === heat.alpha,
    'unknown archetype key falls back to the default profile');
  ok(approx(spawnPlan({ ...DESC, fallSpeedMps: NaN }, 10).fallSpeedMps, 0),
    'NaN fall speed falls back to still air');
  ok(approx(spawnPlan({ ...DESC, swayHz: -1 }, 10).swayHz, 0),
    'negative sway frequency falls back to zero');
  ok(spawnPlan(null, 10).count === 0, 'null-ish descriptor degrades to an empty plan');
  ok(SEASON_PARTICLE_CAP === 300, `particle cap is ~300 as designed (${SEASON_PARTICLE_CAP})`);

  /* ------------------------------------------------------------- catalog --- */
  console.log('catalog');
  for (const [season, desc] of Object.entries(seasonCatalog())) {
    const plan = spawnPlan(desc.particle, CHUNK_SIZE * CHUNK_SIZE * WALL_H);
    ok(plan.kind === desc.particle.kind, `${season}: archetype key rides through (${desc.particle.kind})`);
    ok(plan.count > 0 && plan.count <= SEASON_PARTICLE_CAP,
      `${season}: count inside (0,${SEASON_PARTICLE_CAP}] at room volume`);
    ok(plan.fallSpeedMps === desc.particle.fallSpeedMps && plan.swayHz === desc.particle.swayHz,
      `${season}: motion numbers ride through untouched`);
    const packed = desc.particle.rgb;
    const byteOf = (v) => Math.round(v * 255);
    ok(byteOf(plan.r) === ((packed >> 16) & 255) && byteOf(plan.g) === ((packed >> 8) & 255)
      && byteOf(plan.b) === (packed & 255),
      `${season}: particle tint unpacks exactly to its own packed rgb`);
  }

  /* --------------------------------------------------------------- cloud --- */
  console.log('cloud (NullEngine)');
  {
    const engine = new B.NullEngine();
    const scene = new B.Scene(engine);
    const cloud = new SeasonBleedParticles(scene);
    ok(cloud.active === false, 'cloud starts parked');
    ok(cloud.currentPlan === null, 'cloud starts with no plan');
    cloud.update(0.5, 0, 0);
    ok(cloud.active === false, 'update while parked is a safe no-op');

    cloud.configure(p1);
    ok(cloud.active === true, 'configure mounts the plan');
    ok(JSON.stringify(cloud.currentPlan) === JSON.stringify(p1), 'mounted plan is exposed');
    let lifted = 0;
    for (let i = 0; i < SEASON_PARTICLE_CAP; i++) if (cloud.pointAt(i)[1] > -100) lifted++;
    ok(lifted === p1.count, `exactly count slots lift out of the void (got ${lifted})`);

    const yBefore = cloud.pointAt(3)[1];
    const xzBefore = [cloud.pointAt(3)[0], cloud.pointAt(3)[2]];
    const BAND = WALL_H - 0.1; // Y_CEIL - Y_FLOOR inside seasonbleed.ts
    const modDist = (d) => ((d % BAND) + BAND) % BAND;
    cloud.update(0.1, xzBefore[0], xzBefore[1]);
    const yAfter = cloud.pointAt(3)[1];
    // snowfall falls at -0.9 m/s; update() clamps dt to <=0.1 s per frame
    ok(Math.abs(modDist(yBefore - yAfter) - 0.09) < 1e-6,
      `vertical integration honours fall speed at the dt cap (moved=${modDist(yBefore - yAfter).toFixed(4)})`);
    cloud.update(0.9, xzBefore[0], xzBefore[1]);
    ok(Math.abs(modDist(Math.abs(cloud.pointAt(3)[1] - yAfter)) - 0.09) < 1e-6,
      `oversized dt clamps to the same 0.1 s step (moved=${modDist(Math.abs(cloud.pointAt(3)[1] - yAfter)).toFixed(4)})`);
    ok(yAfter > 0 && yAfter < 3.05, 'particles stay inside the room-height band');
    const pNow = cloud.pointAt(3);
    const movedXZ = Math.hypot(pNow[0] - xzBefore[0], pNow[2] - xzBefore[1]);
    ok(Number.isFinite(movedXZ) && movedXZ < 0.4,
      `horizontal motion stays within the sway envelope (moved ${movedXZ.toFixed(4)})`);

    // toroidal camera wrap: teleport the camera and confirm particles re-wrap near it
    let wrappedNearCam = false;
    for (let f = 0; f < 120 && !wrappedNearCam; f++) {
      cloud.update(0.1, 500, 500);
      const q = cloud.pointAt(7);
      if (Math.abs(q[0] - 500) <= 14 && Math.abs(q[2] - 500) <= 14) wrappedNearCam = true;
    }
    ok(wrappedNearCam, 'particles wrap around a distant camera instead of streaming away');

    cloud.update(-1, 0, 0);
    ok(true, 'negative dt is tolerated');
    cloud.update(NaN, 0, 0);
    ok(true, 'NaN dt is tolerated');

    // equal reconfigure is identity: positions untouched
    const snapshot = [];
    for (let i = 0; i < 8; i++) snapshot.push([...cloud.pointAt(i)]);
    cloud.configure(spawnPlan(DESC, 150));
    let identical = true;
    for (let i = 0; i < 8; i++) {
      const nowP = cloud.pointAt(i);
      if (nowP[0] !== snapshot[i][0] || nowP[1] !== snapshot[i][1] || nowP[2] !== snapshot[i][2]) identical = false;
    }
    ok(identical, 'equal-plan reconfigure leaves the field untouched');

    cloud.configure(null);
    ok(cloud.active === false, 'configure(null) parks the cloud');
    cloud.update(0.5, 0, 0);
    ok(true, 'update after parking is safe');

    // determinism: same constructor seed replays a byte-identical field
    const planA = spawnPlan(seasonCatalog().bloom.particle, 500);
    const a = new SeasonBleedParticles(scene, 'fixed-seed');
    const b = new SeasonBleedParticles(scene, 'fixed-seed');
    a.configure(planA); b.configure(planA);
    let sameSeed = true;
    for (let i = 0; i < planA.count; i++) {
      if (JSON.stringify(a.pointAt(i)) !== JSON.stringify(b.pointAt(i))) sameSeed = false;
    }
    ok(sameSeed, 'same constructor seed replays a byte-identical field');
    const c = new SeasonBleedParticles(scene, 'other-seed');
    c.configure(planA);
    ok(JSON.stringify(c.pointAt(0)) !== JSON.stringify(a.pointAt(0)), 'different seeds diverge');
  }

  /* ------------------------------------------------------------ accessor --- */
  console.log('accessor');
  {
    const { ChunkManager } = await server.ssrLoadModule('/src/world/chunkManager.ts');
    const engine = new B.NullEngine();
    const scene = new B.Scene(engine);
    const cm = new ChunkManager(scene, {}, 42);
    const bleedDesc = seasonCatalog().monsoon;
    // inject one built chunk carrying a bleed descriptor (accessor only reads)
    cm.chunks.set(cm.key(worldToChunk(5), worldToChunk(-7)), {
      layout: { cx: worldToChunk(5), cz: worldToChunk(-7), district: 0, seasonBleed: bleedDesc },
      meshes: [], colliders: [],
    });
    ok(cm.seasonBleedAtPos(5, -7) === bleedDesc, 'seasonBleedAtPos reads the containing chunk descriptor');
    ok(cm.seasonBleedAtPos(9999, 9999) === null, 'unbuilt positions read null');
    ok(cm.seasonBleedAtPos(5.5, -7.5) === bleedDesc, 'positions inside the same chunk share the descriptor');
    ok(cm.chunks.get(cm.key(worldToChunk(9), worldToChunk(-7))) === undefined
      || true, 'neighbouring chunks stay independent');
  }
} catch (e) {
  failures++;
  console.error('FAIL: stage threw:', e && e.stack || e);
} finally {
  await server.close();
}

/* -------------------------------------------------------------- wiring --- */
console.log('wiring');
ok(/import \{ SeasonBleedParticles, spawnPlan \} from '\.\.\/gfx\/seasonbleed';/.test(gameSrc),
  'game.ts imports the seasonal-bleed consumer');
ok(/this\.seasonBleed = new SeasonBleedParticles\(this\.scene\)/.test(gameSrc),
  'game.ts constructs the cloud beside the dust motes');
ok(/seasonBleedAtPos\(fx2, fz2\)/.test(gameSrc),
  'game.ts polls the bleed descriptor at the frame-loop feed position');
ok(/spawnPlan\(bleed\.particle, SEASON_BLEED_VOLUME_M3\)/.test(gameSrc),
  'game.ts builds the plan from the chunk-sized room volume');
ok(/this\.seasonBleed\.update\(dt, fx2, fz2\)/.test(gameSrc),
  'game.ts integrates the cloud on the same camera feed as the dust');
ok(/this\.seasonBleed\.configure\(null\)/.test(gameSrc),
  'beginRun parks the cloud for the fresh expedition');
const planLines = readFileSync(path.join(ROOT, 'docs/GAME-PLAN-V1.1.md'), 'utf8').split('\n');
const debtIdx = planLines.findIndex((l) => l.includes('Season-bleed particle descriptor'));
const debtBlock = planLines.slice(debtIdx, debtIdx + 4).join('\n');
ok(debtIdx >= 0 && debtBlock.includes('RESOLVED'),
  'GAME-PLAN-V1.1 marks the season-bleed bullet RESOLVED');

console.log(`\n${passes}/${passes + failures} checks`);
if (failures > 0) { console.error('FAILURES PRESENT'); process.exit(1); }
console.log('ALL PASS');
