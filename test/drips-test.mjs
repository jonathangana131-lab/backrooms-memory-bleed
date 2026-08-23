/*
 * Ceiling drips system test - runs headless in Node.
 *
 * src/gfx/drips.ts imports Babylon classes as runtime values (mesh
 * construction), so we transpile it with the workspace TypeScript compiler,
 * rewrite its @babylonjs imports onto a lightweight stub module, and drive
 * CeilingDrips against fake meshes and a fake AudioContext. Private fields
 * are TS-only, so the pooled meshes stay observable after transpile.
 *
 * Verifies:
 *   1. drip cadence: first drop appears within the per-point 3-8 s window
 *   2. drop falls ceiling -> floor in about CEIL_Y / FALL_SPEED seconds
 *   3. splash ring expands and fades out over SPLASH_DURATION (0.4 s)
 *   4. plink audio fires once on impact: sine 800 -> 400 Hz over 80 ms,
 *      panned toward the drip position, routed to the output
 *   5. plink attenuates with distance
 *   6. hard cap of MAX_ACTIVE simultaneous drips under heavy load
 *   7. nothing animates while the player is beyond ACTIVATE_DIST
 *   8. stop() halts everything permanently
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/gfx/drips.ts'), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  // Point Babylon runtime imports at our local stub (bundler resolution in
  // the real app; explicit relative path for Node ESM here).
  .replace(/from '@babylonjs\/core[^']*'/g, "from './.babylon-stub.gen.mjs'");
const genPath = join(root, 'test/.drips.gen.mjs');
writeFileSync(genPath, out);

// ---- Babylon stub: just enough surface for drips.ts -----------------------
const STUB_SRC = [
  "export class Color3 {",
  "  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }",
  "}",
  "export class StandardMaterial {",
  "  constructor(name) { this.name = name; this.opacityTexture = null; }",
  "}",
  "export class DynamicTexture {",
  "  constructor() { this.hasAlpha = false; this.updated = false; }",
  "  getContext() {",
  "    return {",
  "      clearRect() {}, beginPath() {}, arc() {}, stroke() {},",
  "      set strokeStyle(_) {}, set lineWidth(_) {},",
  "    };",
  "  }",
  "  update() { this.updated = true; }",
  "}",
  "function makeTransform() { return { x: 0, y: 0, z: 0 }; }",
  "export const MeshBuilder = {",
  "  CreateBox(name) {",
  "    return { name, position: makeTransform(), scaling: { x: 1, y: 1, z: 1 },",
  "      rotation: makeTransform(), isVisible: true, visibility: 1, material: null };",
  "  },",
  "  CreatePlane(name) {",
  "    return { name, position: makeTransform(), scaling: { x: 1, y: 1, z: 1 },",
  "      rotation: makeTransform(), isVisible: true, visibility: 1, material: null };",
  "  },",
  "};",
].join('\n');
const babylonStubPath = join(root, 'test/.babylon-stub.gen.mjs');
writeFileSync(babylonStubPath, STUB_SRC);

// ---- fake AudioContext capturing scheduled audio ---------------------------
class FakeAudioParam {
  constructor() {
    this.value = 0;
    this.events = [];
  }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); return this; }
  /** Largest ramp target seen (approximate envelope peak level). */
  peak() {
    let m = 0;
    for (const [kind, v] of this.events) {
      if ((kind === 'lin' || kind === 'exp') && v > m && v < 0.5) m = v;
    }
    return m;
  }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 12;
    this.destination = { node: 'destination' };
    this.oscillators = [];
    this.links = [];
  }
  createOscillator() {
    const ctx = this;
    const o = {
      type: '',
      frequency: new FakeAudioParam(),
      startedAt: null,
      connect(dest) { ctx.links.push([o, dest]); return dest; },
      start(t) { o.startedAt = t ?? ctx.currentTime; },
      stop() {},
    };
    ctx.oscillators.push(o);
    return o;
  }
  createGain() {
    const ctx = this;
    const g = { gain: new FakeAudioParam() };
    g.connect = (dest) => { ctx.links.push([g, dest]); return dest; };
    return g;
  }
  createStereoPanner() {
    const ctx = this;
    const p = { pan: new FakeAudioParam() };
    p.connect = (dest) => { ctx.links.push([p, dest]); return dest; };
    return p;
  }
}

const INTERVAL_LO = 3;
const INTERVAL_HI = 8;
const DT = 1 / 60;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

/** Drive n update frames; cb(i) observes after each frame. */
function run(drips, frames, px, pz, cb) {
  for (let i = 0; i < frames; i++) {
    drips.update(DT, px, pz);
    if (cb) cb(i);
  }
}

async function main() {
  const { CeilingDrips, MAX_ACTIVE, ACTIVATE_DIST, SPLASH_DURATION, FALL_SPEED, CEIL_Y }
    = await import(genPath + '?t=' + Date.now());

  // ---- 1-4: full lifecycle of one drip ---------------------------------
  {
    const ctx = new FakeAudioContext();
    const drips = new CeilingDrips({}, ctx);
    check('starts idle', drips.activeCount === 0 && drips.pointCount === 0);

    drips.registerStain(1, 1);
    check('registerStain tracks the point', drips.pointCount === 1);

    // one continuous simulation observes cadence, fall, splash and plink
    let firstSeen = -1, fallStart = -1, impactAt = -1;
    let sawSpawnY = false, monotonicDown = true, lastY = Infinity;
    let splashShown = false, fadeMonotonic = true, lastVis = Infinity;
    let splashStart = -1, splashEnd = -1;
    const drop = drips.dropMeshes[0];
    const splash = drips.splashMeshes[0];
    const TOTAL = Math.round((INTERVAL_HI + 2) / DT);
    for (let i = 0; i < TOTAL; i++) {
      drips.update(DT, 0, 0);
      if (firstSeen < 0 && drips.activeCount > 0) firstSeen = i * DT;
      // observe only the FIRST cycle: later drips reuse the pooled meshes
      if (impactAt < 0) {
        if (drop.isVisible && fallStart < 0) fallStart = i * DT;
        if (drop.isVisible) {
          if (!sawSpawnY && Math.abs(drop.position.y - CEIL_Y) < 0.25) sawSpawnY = true;
          if (drop.position.y > lastY + 1e-9) monotonicDown = false;
          lastY = drop.position.y;
        } else if (fallStart >= 0) {
          impactAt = i * DT; // first cycle's drop just landed
        }
      }
      if (splashEnd < 0) {
        if (splash.isVisible && !splashShown) { splashShown = true; splashStart = i * DT; }
        if (splash.isVisible) {
          if (splash.visibility > lastVis + 1e-9) fadeMonotonic = false;
          lastVis = splash.visibility;
        } else if (splashShown) {
          splashEnd = i * DT;
        }
      }
    }
    check('first drop appears within the 3-8 s interval',
      firstSeen >= INTERVAL_LO - 0.05 && firstSeen <= INTERVAL_HI,
      'after ' + (firstSeen < 0 ? 'never' : firstSeen.toFixed(2) + 's'));
    check('drop starts at ceiling height', sawSpawnY);
    check('drop descends monotonically', monotonicDown);
    const fallDur = fallStart >= 0 && impactAt >= 0 ? impactAt - fallStart : NaN;
    check('fall takes about CEIL_Y / FALL_SPEED',
      isFinite(fallDur) && Math.abs(fallDur - CEIL_Y / FALL_SPEED) < 0.08,
      'fall=' + (isFinite(fallDur) ? fallDur.toFixed(3) : '?') + 's expected~' + (CEIL_Y / FALL_SPEED).toFixed(3));

    // a plink fired on that impact (a 10 s window can legitimately hold two
    // drips, so assert >= 1 and inspect the first)
    check('plink oscillator fired on impact', ctx.oscillators.length >= 1,
      'n=' + ctx.oscillators.length);
    if (ctx.oscillators.length >= 1) {
      const osc = ctx.oscillators[0];
      check('plink oscillator is a sine', osc.type === 'sine', osc.type);
      const sets = osc.frequency.events.filter((e) => e[0] === 'set');
      const ramps = osc.frequency.events.filter((e) => e[0] === 'exp');
      check('plink starts at 800 Hz', sets.length >= 1 && sets[0][1] === 800,
        sets.length ? String(sets[0][1]) : 'none');
      check('plink sweeps down to 400 Hz over ~80 ms',
        ramps.length === 1 && ramps[0][1] === 400 && Math.abs(ramps[0][2] - sets[0][2] - 0.08) < 0.001,
        ramps.length ? 'dt=' + (ramps[0][2] - sets[0][2]).toFixed(3) : 'no ramp');
    }

    // stereo pan points toward the drip (+x of listener -> positive pan)
    const panNode = ctx.links.find(([snd]) => snd && snd.pan);
    check('plink panned toward drip position',
      !!panNode && panNode[0].pan.value > 0.5 && panNode[0].pan.value <= 1,
      'pan=' + (panNode ? panNode[0].pan.value.toFixed(2) : 'none'));
    check('plink routes to output', ctx.links.some(([a, b]) => b === ctx.destination));

    check('splash ring shows on impact', splashShown);
    check('splash fades out monotonically', fadeMonotonic);
    const splashDur = splashShown && splashEnd >= 0 ? splashEnd - splashStart : NaN;
    check('splash lasts about SPLASH_DURATION',
      isFinite(splashDur) && Math.abs(splashDur - SPLASH_DURATION) < 0.08,
      'dur=' + (isFinite(splashDur) ? splashDur.toFixed(3) : '?') + 's expected~' + SPLASH_DURATION);

    drips.stop();
  }

  // ---- 5. distance attenuation ------------------------------------------
  {
    const mkVol = (dist) => {
      const ctx = new FakeAudioContext();
      const drips = new CeilingDrips({}, ctx);
      drips.registerStain(dist, 0);
      run(drips, Math.round((INTERVAL_HI + 1.5) / DT), 0, 0);
      drips.stop();
      const gLink = ctx.links.find(([snd]) => snd && snd.gain);
      return gLink ? gLink[0].gain.peak() : 0;
    };
    const near = mkVol(1.0);
    const far = mkVol(15.0);
    check('plink attenuates with distance', far > 0 && far < near * 0.3,
      'near=' + near.toFixed(3) + ' far=' + far.toFixed(3));
  }

  // ---- silent without AudioContext ---------------------------------------
  {
    const drips = new CeilingDrips({});
    drips.registerStain(0.5, 0.5);
    let ok = true;
    try {
      run(drips, Math.round((INTERVAL_HI + 1.5) / DT), 0, 0);
    } catch {
      ok = false;
    }
    check('runs silent and safe without an AudioContext', ok);
    drips.stop();
  }

  // ---- 6. MAX_ACTIVE cap ---------------------------------------------------
  {
    const drips = new CeilingDrips({}, null);
    for (let i = 0; i < 24; i++) drips.registerStain(i * 0.4 - 4.6, i % 2 ? 3 : -3);
    let peak = 0;
    run(drips, Math.round(90 / DT), 0, 0, () => {
      peak = Math.max(peak, drips.activeCount);
    });
    check('active drips never exceed MAX_ACTIVE (' + MAX_ACTIVE + ')',
      peak <= MAX_ACTIVE, 'peak=' + peak);
    check('cap actually engages under load', peak >= MAX_ACTIVE - 1, 'peak=' + peak);
    drips.stop();
  }

  // ---- 7. distance gate ----------------------------------------------------
  {
    const drips = new CeilingDrips({}, null);
    drips.registerStain(ACTIVATE_DIST + 6, 0); // well beyond the gate
    run(drips, Math.round(40 / DT), 0, 0);
    check('nothing spawns beyond ACTIVATE_DIST', drips.activeCount === 0);
    let seen = -1;
    run(drips, Math.round((INTERVAL_HI + 1) / DT), ACTIVATE_DIST + 5, 0, (i) => {
      if (seen < 0 && drips.activeCount > 0) seen = i * DT;
    });
    check('drips start once the player comes within range', seen >= 0,
      seen < 0 ? 'never' : 'after ' + seen.toFixed(2) + 's');
    drips.stop();
  }

  // ---- 8. stop() ------------------------------------------------------------
  {
    const drips = new CeilingDrips({}, null);
    drips.registerStain(1, 1);
    run(drips, Math.round((INTERVAL_HI + 1) / DT), 0, 0);
    drips.stop();
    check('stop clears active drips', drips.activeCount === 0 && drips.pointCount === 0);
    let revived = false;
    run(drips, Math.round(30 / DT), 0, 0, () => {
      if (drips.activeCount > 0) revived = true;
    });
    check('updates after stop are no-ops', !revived);
  }

  unlinkSync(genPath);
  unlinkSync(babylonStubPath);
  console.log(failures === 0 ? 'ALL DRIPS TESTS PASSED' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { unlinkSync(join(root, 'test/.drips.gen.mjs')); } catch { /* ignore */ }
  try { unlinkSync(join(root, 'test/.babylon-stub.gen.mjs')); } catch { /* ignore */ }
  process.exit(1);
});


