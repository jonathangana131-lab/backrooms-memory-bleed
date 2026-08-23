/*
 * Fan dust shedding system test - runs headless in Node.
 *
 * src/gfx/fandust.ts imports Babylon classes as runtime values, so we
 * transpile it with the workspace TypeScript compiler and rewrite its
 * @babylonjs imports onto a lightweight stub module. Private fields are
 * TS-only, so the pooled particle arrays stay observable after transpile.
 *
 * Verifies:
 *   1. slow/off fans never shed (only MEDIUM+ sheds)
 *   2. medium-speed fans shed visible motes that fall and drift
 *   3. accumulation link: a long-running fan sheds far more than a fresh one
 *   4. global cap of 20 live motes holds under heavy multi-fan load
 *   5. pool recycling: hundreds of spawns reuse the same fixed pool
 *   6. proximity gate: nothing spawns or animates beyond ACTIVATE_DIST
 *   7. clear() unregisters fans and resets the pool completely
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/gfx/fandust.ts'), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  .replace(/from '@babylonjs\/core[^']*'/g, "from './.fandust-stub.gen.mjs'");
const genPath = join(root, 'test/.fandust.gen.mjs');
writeFileSync(genPath, out);

// ---- Babylon stub: just enough surface for fandust.ts ----------------------
const STUB_SRC = [
  "export class Color3 {",
  "  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }",
  "}",
  "export class StandardMaterial {",
  "  constructor(name) { this.name = name; this.alpha = 1; this.pointSize = 1; }",
  "}",
  "export class Mesh {",
  "  constructor(name, scene) {",
  "    this.name = name;",
  "    this.scene = scene;",
  "    this.material = null;",
  "    this.vertices = {};",
  "  }",
  "  setVerticesData(kind, data) { this.vertices[kind] = data; }",
  "}",
  "export class VertexData {",
  "  applyToMesh(mesh) { if (this.positions) mesh.setVerticesData('position', this.positions); }",
  "}",
].join('\n');
const stubPath = join(root, 'test/.fandust-stub.gen.mjs');
writeFileSync(stubPath, STUB_SRC);

const DT = 1 / 60;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

/** Drive n update frames at the player position; cb(i) observes each frame. */
function run(fd, frames, px, pz, cb) {
  for (let i = 0; i < frames; i++) {
    fd.update(DT, px, pz);
    if (cb) cb(i);
  }
}

async function main() {
  const { FanDust, MAX_PARTICLES, ACTIVATE_DIST, WARMUP_S }
    = await import(genPath + '?t=' + Date.now());

  // ---- 1. only MEDIUM+ sheds ---------------------------------------------
  {
    const slow = new FanDust({});
    slow.registerFan(0, 0, 3.05, 0.3); // FAN_SPEEDS.slow
    run(slow, Math.round((WARMUP_S + 10) / DT), 0.5, 0.5);
    check('slow fan never sheds', slow.totalSpawned === 0,
      'spawned=' + slow.totalSpawned);

    const off = new FanDust({});
    off.registerFan(0, 0, 3.05, 0);
    run(off, Math.round(20 / DT), 0.5, 0.5);
    check('stopped fan never sheds', off.totalSpawned === 0);
  }

  // ---- 2. medium fan sheds falling, drifting motes ------------------------
  {
    const fd = new FanDust({});
    fd.registerFan(0, 0, 3.05, 0.8); // FAN_SPEEDS.medium
    run(fd, Math.round((WARMUP_S + 8) / DT), 0.5, 0.5);
    check('medium fan sheds once warmed up',
      fd.activeCount > 0 || fd.totalSpawned > 0,
      'active=' + fd.activeCount + ' spawned=' + fd.totalSpawned);

    // observe matched particles across a short window: they fall AND drift
    let sawFall = false, sawDrift = false;
    for (let attempt = 0; attempt < 40 && !(sawFall && sawDrift); attempt++) {
      const snap = new Map();
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const buf = fd.mesh.vertices['position'];
        if (fd.alive[i]) snap.set(i, [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]);
      }
      if (snap.size === 0) { run(fd, 30, 0.5, 0.5); continue; }
      run(fd, Math.round(0.35 / DT), 0.5, 0.5);
      const buf = fd.mesh.vertices['position'];
      for (const [i, [x0, y0, z0]] of snap) {
        if (!fd.alive[i]) continue;
        const dy = buf[i * 3 + 1] - y0;
        const dh = Math.abs(buf[i * 3] - x0) + Math.abs(buf[i * 3 + 2] - z0);
        if (dy < -0.01) sawFall = true;
        if (dh > 0.005) sawDrift = true;
      }
      run(fd, Math.round(0.2 / DT), 0.5, 0.5); // breathe so slots churn
    }
    check('motes fall under gravity', sawFall);
    check('motes drift with residual blade rotation', sawDrift);

    // all live motes sit below the blade disc and above the floor
    let inBand = true;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (!fd.alive[i]) continue;
      const y = fd.mesh.vertices['position'][i * 3 + 1];
      if (y < 0.02 || y > 3.05) inBand = false;
    }
    check('live motes occupy the floor-to-blade band', inBand);
  }

  // ---- 3. accumulation link ------------------------------------------------
  {
    const fresh = new FanDust({});
    fresh.registerFan(0, 0, 3.05, 0.8);
    run(fresh, Math.round(10 / DT), 0.5, 0.5); // first 10 s of runtime
    const sFresh = fresh.totalSpawned;

    const aged = new FanDust({});
    aged.registerFan(0, 0, 3.05, 0.8);
    run(aged, Math.round((WARMUP_S * 2 + 10) / DT), 0.5, 0.5); // fully grimed
    const before = aged.totalSpawned;
    run(aged, Math.round(10 / DT), 0.5, 0.5); // same-length window
    const sAged = aged.totalSpawned - before;

    check('long-running fan sheds more than a fresh one', sAged > sFresh * 3,
      'fresh=' + sFresh + ' aged=' + sAged);
    check('fresh fan sheds little or nothing at first', sFresh < sAged * 0.5,
      'ratio=' + (sAged > 0 ? (sFresh / sAged).toFixed(2) : '?'));
  }

  // ---- 4+5. cap + recycling under load -------------------------------------
  {
    const fd = new FanDust({});
    fd.registerFan(0, 0, 3.05, 1.5);   // fast
    fd.registerFan(2, 0, 3.05, 1.5);
    fd.registerFan(0, 2, 3.05, 1.5);
    let peak = 0;
    run(fd, Math.round(120 / DT), 1, 1, () => {
      peak = Math.max(peak, fd.activeCount);
    });
    check('live motes never exceed MAX_PARTICLES (' + MAX_PARTICLES + ')',
      peak <= MAX_PARTICLES, 'peak=' + peak);
    check('cap actually engages under load', peak >= MAX_PARTICLES - 2,
      'peak=' + peak);
    check('pool recycles through many lifetimes',
      fd.totalSpawned > 200 && fd.mesh.vertices['position'].length === MAX_PARTICLES * 3,
      'spawned=' + fd.totalSpawned + ' verts=' + fd.mesh.vertices['position'].length);
  }

  // ---- 6. proximity gate ----------------------------------------------------
  {
    const fd = new FanDust({});
    fd.registerFan(ACTIVATE_DIST + 6, 0, 3.05, 1.5); // well beyond the gate
    run(fd, Math.round(40 / DT), 0, 0);
    check('nothing spawns beyond ACTIVATE_DIST', fd.totalSpawned === 0);

    // walk to within range -> shedding begins (after warm-up)
    let firstSeen = -1;
    run(fd, Math.round((WARMUP_S + 5) / DT), ACTIVATE_DIST - 6, 0, (i) => {
      if (firstSeen < 0 && fd.totalSpawned > 0) firstSeen = i * DT;
    });
    check('shedding starts once the player comes within range', firstSeen >= 0,
      firstSeen < 0 ? 'never' : 'after ' + firstSeen.toFixed(2) + 's');
  }

  // ---- 7. clear() ------------------------------------------------------------
  {
    const fd = new FanDust({});
    fd.registerFan(1, 1, 3.05, 1.5);
    run(fd, Math.round((WARMUP_S + 5) / DT), 1, 1);
    fd.clear();
    check('clear empties the pool', fd.activeCount === 0);
    const before = fd.totalSpawned;
    run(fd, Math.round(10 / DT), 1, 1);
    check('cleared fans no longer shed', fd.totalSpawned === before);
    fd.registerFan(1, 1, 3.05, 0.8);
    let revived = false;
    run(fd, Math.round((WARMUP_S + 5) / DT), 1, 1, () => {
      if (fd.totalSpawned > 0) revived = true;
    });
    check('re-registering after clear works', revived);
  }

  unlinkSync(genPath);
  unlinkSync(stubPath);
  console.log(failures === 0 ? 'ALL FANDUST TESTS PASSED' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { unlinkSync(join(root, 'test/.fandust.gen.mjs')); } catch { /* ignore */ }
  try { unlinkSync(join(root, 'test/.fandust-stub.gen.mjs')); } catch { /* ignore */ }
  process.exit(1);
});


