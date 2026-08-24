/**
 * Functional verification of adaptive entity spawning (src/entities/manager.ts):
 * behavior profiling, difficulty bias, spawn memory, group-dynamics variety,
 * and backward compatibility of the legacy spawn() path.
 *
 * Pure-logic phase under Node: the manager is bundled with esbuild while the
 * Babylon mesh layer is replaced by permissive stubs (we verify spawn policy,
 * not rendering).
 */
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  // npm layout installs esbuild at node_modules/esbuild; pnpm layout only
  // exposes it inside the node_modules/.pnpm store. Try direct resolution
  // first, then fall back to scanning the store.
  try { return require_('esbuild'); } catch { /* not a directly resolvable dependency */ }
  let entries = [];
  try { entries = readdirSync(process.cwd() + '/node_modules/.pnpm'); } catch { /* no pnpm store directory */ }
  const entry = entries.find((d) => d.startsWith('esbuild@'));
  if (!entry) throw new Error('esbuild not found in node_modules/esbuild or node_modules/.pnpm');
  return require_(process.cwd() + '/node_modules/.pnpm/' + entry + '/node_modules/esbuild');
}
const esbuild = loadEsbuild();

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// ---- shared Babylon stubs -----------------------------------------------------
const STUBS = process.cwd() + '/test/.smart-spawn-stubs.mjs';
// Permissive Scene stand-in: humans.ts consults getMaterialByName for its
// shared-material cache before creating one; the spawn-policy phase never
// needs real materials, so always answer "none cached".
const sceneStub = () => ({ getMaterialByName: () => null });
const node = (name) => ({
  name,
  position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  rotation: { x: 0, y: 0, z: 0 },
  scaling: { x: 1, y: 1, z: 1 },
  isVisible: true,
  isPickable: false,
  material: null,
  parent: null,
  getChildMeshes: () => [],
  dispose() {},
});
writeFileSync(STUBS, [
  'const node = ' + node.toString() + ';',
  'export class TransformNode { constructor(n) { Object.assign(this, node(n)); } }',
  'export const MeshBuilder = { CreateBox: (n) => node(n), CreateSphere: (n) => node(n) };',
  'export class StandardMaterial { constructor(n) { this.name = n; } }',
  'export class Color3 {}',
  'export class Vector3 {}',
].join('\n'), 'utf8');

// ---- bundle manager.ts with @babylonjs/* mapped onto the stubs -----------------
const result = await esbuild.build({
  entryPoints: [process.cwd() + '/src/entities/manager.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  plugins: [{
    name: 'babylon-stub',
    setup(build) {
      build.onResolve({ filter: /@babylonjs\// }, (args) => ({ path: args.path, namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
        const mod = args.path.split('/').pop();
        const map = {
          transformNode: ['TransformNode'],
          meshBuilder: ['MeshBuilder'],
          'standardMaterial': ['StandardMaterial'],
          'math.color': ['Color3'],
          'math.vector': ['Vector3'],
        };
        const names = map[mod] ?? [];
        const reexports = names.map((n) => 'export { ' + n + " } from '" + STUBS + "';").join('\n');
        // resolveDir is required for the absolute STUBS import to resolve
        // (esbuild >= 0.21 refuses onLoad contents without a resolve directory).
        return { contents: reexports || 'export default {};', loader: 'js', resolveDir: process.cwd() };
      });
    },


  }],
});
const BUILD = process.cwd() + '/test/.smart-spawn-build.mjs';
writeFileSync(BUILD, result.outputFiles[0].text, 'utf8');

const { HumanManager } = await import('./.smart-spawn-build.mjs');

// ---- A. backward compatibility -----------------------------------------------
try {
  const m = new HumanManager(sceneStub());
  const f = m.spawn('watcher', 40, 40, 7);
  check('spawn() returns a live figure at the requested spot', !!f && typeof f.update === 'function' && m.count === 1);
  check('legacy placement is exact on a fresh tile', f.body.x === 40 && f.body.z === 40, f.body.x + ',' + f.body.z);
  m.reset();
  check('reset() clears figures', m.count === 0);

  // ---- B. behavior profiling ----
  const p = new HumanManager(sceneStub());
  p.update(1, 0, 0, 0, []);                    // stationary frame
  p.update(1, 8, 0, 0, [], { on: true });       // ~8 m/s: sprinting, torch on
  p.update(1, 8, 0, 0, [], { on: true });       // holding still, torch on
  const prof = p.getPlayerProfile();
  check('profile tracks observed time', Math.abs(prof.observedSec - 3) < 1e-9, String(prof.observedSec));
  check('profile counts standing-still time', Math.abs(prof.stillTimeSec - 2) < 1e-9, String(prof.stillTimeSec));
  check('profile counts sprint time (>=3.4 m/s)', Math.abs(prof.sprintTimeSec - 1) < 1e-9, String(prof.sprintTimeSec));
  check('torch-on ratio reflects beam usage', Math.abs(prof.torchOnRatio - 2 / 3) < 1e-9, String(prof.torchOnRatio));
  check('confident profile: high confidence, low cautiousness',
    prof.confidence > 0.5 && prof.cautiousness < 0.5,
    'c=' + prof.confidence.toFixed(2) + ' k=' + prof.cautiousness.toFixed(2));

  const q = new HumanManager(sceneStub());
  for (let i = 0; i < 6; i++) q.update(1, 0, 0, 0, []);
  const qp = q.getPlayerProfile();
  check('stationary/torch-off profile reads as cautious', qp.cautiousness > qp.confidence,
    'c=' + qp.confidence.toFixed(2) + ' k=' + qp.cautiousness.toFixed(2));
} catch (e) {
  check('phase A/B threw', false, String(e));
}

// ---- C. adaptive difficulty ----------------------------------------------------
try {
  const m = new HumanManager(sceneStub());
  m.setDifficultyBias(0); // aggressive: watchers pull close
  check('bias 0 scales distances down (0.7x)', Math.abs(m.scaledDistance(20) - 14) < 1e-9, String(m.scaledDistance(20)));
  m.setDifficultyBias(1); // passive: everything pushed far
  check('bias 1 scales distances up (1.45x)', Math.abs(m.scaledDistance(20) - 29) < 1e-9, String(m.scaledDistance(20)));
  let monotonic = true;
  let prev = -Infinity;
  for (let b = 0; b <= 1.0001; b += 0.25) {
    m.setDifficultyBias(b);
    const d = m.scaledDistance(20);
    if (d <= prev) monotonic = false;
    prev = d;
  }
  check('distance scale rises monotonically with cautiousness', monotonic);
  m.setDifficultyBias(0.2);
  const near = m.suggestSpawnPosition(0, 0, Math.PI / 2, 10, 30);
  m.setDifficultyBias(0.9);
  const far = m.suggestSpawnPosition(0, 0, Math.PI / 2, 10, 30);
  const dn = Math.hypot(near.x, near.z);
  const df = Math.hypot(far.x, far.z);
  check('aggressive bias suggests closer spawns than passive bias', df > dn, dn.toFixed(1) + ' vs ' + df.toFixed(1));
  check('setDifficultyBias clamps out-of-range input', (() => { m.setDifficultyBias(42); return m.difficultyBias === 1; })());
} catch (e) {
  check('phase C threw', false, String(e));
}

// ---- D. spawn memory ------------------------------------------------------------
try {
  const m = new HumanManager(sceneStub());
  m.clock = 0;
  m.spawn('watcher', 50, 50, 1);
  check('fresh spawn recorded in memory', m.recentlySpawned('watcher', 50, 50));
  const f2 = m.spawn('watcher', 50, 50, 2); // same archetype + tile inside 120s
  check('repeat spawn within 120s is nudged off the tile',
    !(Math.round(f2.body.x) === 50 && Math.round(f2.body.z) === 50),
    Math.round(f2.body.x) + ',' + Math.round(f2.body.z));
  check('nudged respawn still registered where it landed',
    m.recentlySpawned('watcher', Math.round(f2.body.x), Math.round(f2.body.z)));
  const f3 = m.spawn('believer', 50, 50, 3); // different archetype, same tile: allowed
  check('different archetype at same tile is NOT suppressed', Math.round(f3.body.x) === 50 && Math.round(f3.body.z) === 50);
  // age past the TTL without reset(): push the player far so figures despawn cleanly
  m.lastPx = null; m.lastPz = null;
  m.update(121, 500, 500, 0, []);
  check('same tile becomes spawnable again after 120s', !m.recentlySpawned('watcher', 50, 50));
} catch (e) {
  check('phase D threw', false, String(e));
}

// ---- E. group dynamics -----------------------------------------------------------
try {
  const m = new HumanManager(sceneStub());
  m.clock = 0;
  m.spawn('watcher', 60, 60, 11);
  m.spawn('watcher', 63, 60, 12); // pair within 15m -> cluster
  check('pair of same type within 15m detected as cluster', m.isTypeClustered('watcher', 61, 60));
  const alt = m.suggestType('watcher', 61, 60);
  check('clustered type is diversified on suggestion', alt !== 'watcher', alt);
  const smart = m.smartSpawn('watcher', 62, 60, 13);
  check('smartSpawn honors variety enforcement', smart.type !== 'watcher', smart.type);
  check('smartSpawn places the diversified figure', m.count === 3 && m.figures.includes(smart.figure));

  const far = new HumanManager(sceneStub());
  far.spawn('watcher', 0, 0, 21);
  far.spawn('watcher', 40, 0, 22); // 40m apart: no cluster
  check('same-type pair beyond 15m is not a cluster', !far.isTypeClustered('watcher'));
  check('unclustered preference passes through untouched', far.suggestType('watcher', 5, 0) === 'watcher');
} catch (e) {
  check('phase E threw', false, String(e));
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


