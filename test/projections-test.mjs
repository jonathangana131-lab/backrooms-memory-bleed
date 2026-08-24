/*
 * Projected wall text test - runs headless in Node.
 *
 * src/gfx/projections.ts imports Babylon classes as runtime values, so we
 * transpile it with the workspace TypeScript compiler and rewrite its
 * @babylonjs imports onto a lightweight stub module (same trick as
 * drips-test.mjs).
 *
 * Verifies:
 *   1. gating: only districts 1/2 pass; hash gate fires on ~1/12 of chunks
 *   2. determinism: identical inputs -> identical placement
 *   3. text pool validity: every returned text is in PROJECTION_TEXTS
 *   4. wall lookup: placement lands on the solid edge line, facing into
 *      the open corridor side
 *   5. canvas texture spec: 512x128, transparent-capable, soft-edged
 *      warm-white passes drawn twice, monospace font
 *   6. material spec: additive-ish blending, unlit emissive, alpha from texture
 *   7. mesh geometry: quad floats 0.02 m off the wall along its normal
 *   8. setFlicker modulates visibility deterministically within [0,1]
 *
 * tryPlace / PROJECTION_TEXTS / PROJECTION_PERIOD / PROJECTION_SALT were
 * restored to src/gfx/projections.ts from the dca1114 recovery snapshot
 * after a truncated recovery pass dropped them; this suite runs unmodified
 * against the restored exports.
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/gfx/projections.ts'), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  // Point Babylon runtime imports at our stub, and the sibling rng import at
  // its own transpiled copy (bundler resolution in the app; explicit ESM here).
  .replace(/from '@babylonjs\/core[^']*'/g, "from './.projections-stub.gen.mjs'")
  .replace(/from '..\/core\/rng'/g, "from './.rng.gen.mjs'")
  .replace(/from '..\/world\/constants'/g, "from './.constants.gen.mjs'");
{
  // constants.ts is pure data - transpile verbatim
  const cSrc = readFileSync(join(root, 'src/world/constants.ts'), 'utf8');
  writeFileSync(
    join(root, 'test/.constants.gen.mjs'),
    ts.transpileModule(cSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  );
}
writeFileSync(join(root, 'test/.projections.gen.mjs'), out);

// ---- Babylon stub: just enough surface for projections.ts -----------------
const STUB_SRC = [
  "export const Constants = { ALPHA_ADD: 1 };",
  "export class Color3 {",
  "  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }",
  "}",
  "export class StandardMaterial {",
  "  constructor(name) { this.name = name; this.alpha = 1; this.diffuseTexture = null;",
  "    this.useAlphaFromDiffuseTexture = false; this.disableLighting = false;",
  "    this.emissiveColor = null; this.specularColor = null; this.alphaMode = 0;",
  "    this.backFaceCulling = true; }",
  "}",
  "export class DynamicTexture {",
  "  constructor(name, opts) { this.name = name; this.opts = opts; this.hasAlpha = false;",
  "    this.updated = false; this.draws = [];",
  "    const self = this;",
  "    this.ctx = {",
  "      cleared: false, saveCalls: 0, restoreCalls: 0, translateTo: null,",
  "      clearRect() { self.ctx.cleared = true; },",
  "      save() { self.ctx.saveCalls++; },",
  "      restore() { self.ctx.restoreCalls++; },",
  "      translate(x, y) { self.ctx.translateTo = [x, y]; },",
  "      fillText(text) { self.draws.push({ text, font: self.ctx.font, style: self.ctx.fillStyle, blur: self.ctx.shadowBlur }); },",
  "      beginPath() {}, arc() {}, stroke() {},",
  "    };",
  "    self.ctx.font = ''; self.ctx.fillStyle = ''; self.ctx.shadowBlur = 0;",
  "    self.ctx.textAlign = ''; self.ctx.textBaseline = ''; self.ctx.shadowColor = '';",
  "  }",
  "  getContext() { return this.ctx; }",
  "  update() { this.updated = true; }",
  "}",
  "export const MeshBuilder = {",
  "  CreatePlane(name, opts, scene) {",
  "    void scene;",
  "    return {",
  "      name, opts, material: null, isPickable: true, frozen: false,",
  "      px: NaN, py: NaN, pz: NaN, ry: NaN,",
  "      position: {",
  "        set(x, y, z) { this.x = x; this.y = y; this.z = z; },",
  "      },",
  "      rotation: {},",
  "      freezeWorldMatrix() { this.frozen = true; },",
  "    };",
  "  },",
  "};",
].join('\n');
writeFileSync(join(root, 'test/.projections-stub.gen.mjs'), STUB_SRC);

// transpile rng.ts too so the test can cross-check gate math independently
{
  const rngSrc = readFileSync(join(root, 'src/core/rng.ts'), 'utf8');
  writeFileSync(
    join(root, 'test/.rng.gen.mjs'),
    ts.transpileModule(rngSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
  );
}

const mod = await import(join(root, 'test/.projections.gen.mjs').replace(/\\/g, '/'));
const {
  tryPlace, makeProjectionMesh, flickerAlpha,
  PROJECTION_TEXTS, PROJECTION_PERIOD, PROJECTION_OFFSET, PROJECTION_SALT,
} = mod;
const { hash2i } = await import(join(root, 'test/.rng.gen.mjs').replace(/\\/g, '/'));

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}
const SEED = 0xbeef;

// ---- 1+2+3: gating, determinism, text pool --------------------------------
let placed = 0, total = 0;
const textsSeen = new Set();
let mismatch = false;
for (let cz = 0; cz < 24; cz++) {
  for (let cx = 0; cx < 24; cx++) {
    total++;
    const p = tryPlace(cx, cz, 1, SEED);
    const again = tryPlace(cx, cz, 1, SEED);
    if (JSON.stringify(p) !== JSON.stringify(again)) mismatch = true;
    if (p) {
      placed++;
      textsSeen.add(p.text);
      if (!PROJECTION_TEXTS.includes(p.text)) check('text pool', false, p.text);
    }
  }
}
check('determinism: repeat calls identical', !mismatch);
const ratio = placed / total;
check('gate rate ~1/' + PROJECTION_PERIOD + ' (' + (ratio * 100).toFixed(1) + '%)',
  ratio > 0.04 && ratio < 0.15);
check('texts all from pool', [...textsSeen].every((t) => PROJECTION_TEXTS.includes(t)),
  [...textsSeen].join(','));
check('pool itself is the four projector sentences',
  PROJECTION_TEXTS.length === 4 &&
  ['FORGET', 'REMEMBER', 'IT KNOWS', "DON'T LOOK"].every((t) => PROJECTION_TEXTS.includes(t)));

// ---- district gating ------------------------------------------------------
let gateHit = null;
for (let cz = 0; cz < 24 && !gateHit; cz++) {
  for (let cx = 0; cx < 24 && !gateHit; cx++) {
    if ((hash2i(cx, cz, SEED ^ PROJECTION_SALT) % PROJECTION_PERIOD) === 0) gateHit = [cx, cz];
  }
}
check('a gated chunk exists in scan range', !!gateHit);
if (gateHit) {
  const [gx, gz] = gateHit;
  check('gated chunk places in OPEN_OFFICE(1)', tryPlace(gx, gz, 1, SEED) !== null);
  check('gated chunk places in HONEYCOMB(2)', tryPlace(gx, gz, 2, SEED) !== null);
  check('district MAZE(0) rejected', tryPlace(gx, gz, 0, SEED) === null);
  check('district CORRIDOR_GRID(3) rejected', tryPlace(gx, gz, 3, SEED) === null);
  check('district STORAGE(4) rejected', tryPlace(gx, gz, 4, SEED) === null);
}
check('ungated chunk rejected even in allowed district',
  (() => {
    for (let cz = 0; cz < 24; cz++) for (let cx = 0; cx < 24; cx++) {
      if ((hash2i(cx, cz, SEED ^ PROJECTION_SALT) % PROJECTION_PERIOD) !== 0) {
        return tryPlace(cx, cz, 1, SEED) === null;
      }
    }
    return false;
  })());

// ---- 4: wall-adjacent placement -------------------------------------------
{
  // synthetic layout: everything solid except three openings around cell
  // (5,5), making it the unique cell whose solid north wall fronts an open
  // corridor side -> exactly one open-face candidate, deterministic pick
  const N = 12, CELLW = 2.5;
  const walls = {
    hEdges: new Uint8Array((N + 1) * N).fill(1),
    vEdges: new Uint8Array(N * (N + 1)).fill(1),
  };
  walls.hEdges[6 * N + 5] = 0;       // opening south of cell (5,5)
  walls.vEdges[5 * (N + 1) + 5] = 0; // opening west of cell (5,5)
  walls.vEdges[5 * (N + 1) + 6] = 0; // opening east of cell (5,5)
  const [cx, cz] = gateHit ?? [0, 0];
  const p = tryPlace(cx, cz, 1, SEED, walls);
  check('placement exists with synthetic wall', p !== null);
  if (p) {
    const wallZ = (cz * N + 5) * CELLW;
    const cellMinX = (cx * N + 5) * CELLW;
    const cellMaxX = cellMinX + CELLW;
    check('z sits on the solid edge line', Math.abs(p.z - wallZ) < 1e-6, p.z + ' vs ' + wallZ);
    check('x inside the wall cell span', p.x >= cellMinX && p.x <= cellMaxX, p.x);
    check('rotY faces into corridor (-PI for -z face)', Math.abs(p.rotY - Math.PI) < 1e-9, String(p.rotY));
    // east-wall variant
    const wallsE = {
      hEdges: new Uint8Array((N + 1) * N),
      vEdges: new Uint8Array(N * (N + 1)),
    };
    wallsE.vEdges[5 * (N + 1) + 6] = 1; // SOLID on +x side of cell (5,5)
    const pe = tryPlace(cx, cz, 1, SEED, wallsE);
    check('east-face variant lands on vEdge line', pe !== null &&
      Math.abs(pe.x - ((cx * N + 6) * CELLW)) < 1e-6 &&
      Math.abs(pe.rotY - Math.PI / 2) < 1e-9, JSON.stringify(pe));
  }
}

// ---- 5+6+7+8: mesh / texture / flicker ------------------------------------
{
  const cx = gateHit ? gateHit[0] : 0, cz = gateHit ? gateHit[1] : 0;
  const place = tryPlace(cx, cz, 1, SEED);
  check('placement available for mesh stage', place !== null);
  if (place) {
    const mesh = makeProjectionMesh({}, place);
    const mat = mesh.material;
    const tex = mat.diffuseTexture;

    check('texture is 512x128', tex.opts.width === 512 && tex.opts.height === 128,
      JSON.stringify(tex.opts));
    check('texture alpha-enabled and uploaded', tex.hasAlpha && tex.updated);
    check('canvas cleared before drawing (transparent bg)', tex.ctx.cleared);
    check('text drawn twice (bloom + core)', tex.draws.length >= 2 &&
      tex.draws.every((d) => d.text === place.text),
      JSON.stringify(tex.draws.map((d) => d.text)));
    check('monospace projector font', tex.draws.every((d) => d.font.includes('monospace')),
      tex.draws[0] && tex.draws[0].font);
    const styles = tex.draws.map((d) => d.style);
    const warmWhite = (s) => /^rgba\(255,(2[0-4][0-9]|25[0-5]),(2[0-8][0-9]|19[0-9]|2[0-4][0-9]),/.test(s);
    check('warm-white fills on every pass', styles.every(warmWhite), styles.join(' | '));
    const blurs = tex.draws.map((d) => d.blur);
    check('soft edge falloff (decreasing shadowBlur)', blurs.length >= 2 &&
      blurs[0] > blurs[blurs.length - 1] && blurs[blurs.length - 1] > 0, blurs.join(','));
    check('centered draw', Array.isArray(tex.ctx.translateTo) &&
      tex.ctx.translateTo[0] === 256 && tex.ctx.translateTo[1] === 64);

    check('additive-ish blending mode', mat.alphaMode === 1 /* ALPHA_ADD */);
    check('unlit emissive material', mat.disableLighting && mat.useAlphaFromDiffuseTexture);
    const em = mat.emissiveColor;
    check('emissive is warm white', em.r > 0.9 && em.g > 0.85 && em.b > 0.7 && em.r >= em.g && em.g > em.b,
      JSON.stringify(em));

    const nx = Math.sin(place.rotY), nz = Math.cos(place.rotY);
    const dx = mesh.position.x - place.x, dz = mesh.position.z - place.z;
    const off = dx * nx + dz * nz;
    const perp = Math.abs(dx * nz - dz * nx);
    check('quad offset 0.02 m along wall normal',
      Math.abs(off - PROJECTION_OFFSET) < 1e-9 && perp < 1e-9,
      'off=' + off + ' perp=' + perp);
    check('quad at projection height', Math.abs(mesh.position.y - 1.55) < 1e-9);
    check('yaw preserved', mesh.rotation.y === place.rotY);
    check('frozen + unpickable', mesh.frozen && mesh.isPickable === false);

    // flicker
    const typeofSet = typeof mesh.setFlicker;
    check('setFlicker method present', typeofSet === 'function');
    const a1 = flickerAlpha(1000), a2 = flickerAlpha(40000), a3 = flickerAlpha(40000);
    check('flicker deterministic per timestamp', a2 === a3);
    check('flicker modulates over time', a1 !== a2 || mat.alpha !== a1 ||
      (() => { mesh.setFlicker(40000); return mesh.material.alpha === a2; })());
    let bounded = true;
    for (let t = 0; t < 600000; t += 137) {
      const a = flickerAlpha(t);
      if (!(a >= 0 && a <= 1)) { bounded = false; break; }
    }
    check('flicker stays within [0,1] across 10 min sweep', bounded);
    mesh.setFlicker(40000);
    check('setFlicker writes clamped alpha into material',
      mesh.material.alpha === flickerAlpha(40000));
  }
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


