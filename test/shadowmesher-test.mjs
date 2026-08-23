/**
 * Unit tests for the shadow mesher emission pass (src/gfx/shadowmesher.ts).
 * Standalone (no browser): transpiles the module (+ its runtime deps) into
 * a temp dir and drives the pure generate()/emit() API.
 * Run: node test/shadowmesher-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-shadowmesher-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/contactshadow.ts', 'gfx/contactshadow.mjs');
emit('src/gfx/shadowmesher.ts', 'gfx/shadowmesher.mjs');

const csMod = await import(pathToFileURL(path.join(tmp, 'gfx/contactshadow.mjs')).href);
const smMod = await import(pathToFileURL(path.join(tmp, 'gfx/shadowmesher.mjs')).href);
const { generateForProps, SHADOW_Y, SHADOW_ALPHA, SHADOW_MARGIN } = csMod;
const { ShadowMesherPass, shadowVertexTint, SHADOW_STRENGTH } = smMod;

function close(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ---- helpers ---------------------------------------------------------------

/** Geometric normal of triangle (a,b,c) inside a flat positions array. */
function triNormal(p, a, b, c) {
  const ax = p[b * 3] - p[a * 3], ay = p[b * 3 + 1] - p[a * 3 + 1], az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3], by = p[c * 3 + 1] - p[a * 3 + 1], bz = p[c * 3 + 2] - p[a * 3 + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function centroid(q) {
  let x = 0, y = 0, z = 0;
  for (let v = 0; v < 4; v++) {
    x += q.positions[v * 3]; y += q.positions[v * 3 + 1]; z += q.positions[v * 3 + 2];
  }
  return [x / 4, y / 4, z / 4];
}

function makeProp(kind, x, z, rot = 0, variant = 0) {
  return { kind, x, z, rot, variant };
}

const pass = new ShadowMesherPass();

// ---- quad contract (CornerAO/moisture drop-in shape) -----------------------

{
  const props = [makeProp('chair', 3.25, -7.5), makeProp('desk', 10, 4)];
  const quads = pass.generate(props);
  check('one quad per shadow-bearing prop', quads.length === 2);

  let shapeOk = true;
  for (const q of quads) {
    if (!Array.isArray(q.positions) || q.positions.length !== 12) shapeOk = false;
    if (!Array.isArray(q.tints) || q.tints.length !== 12) shapeOk = false;
    if (!Array.isArray(q.normal) || q.normal.length !== 3) shapeOk = false;
    // per-corner RGB triplets must repeat one scalar
    for (let v = 0; v < 4; v++) {
      const r = q.tints[v * 3], g = q.tints[v * 3 + 1], b = q.tints[v * 3 + 2];
      if (!(r === g && g === b)) shapeOk = false;
    }
  }
  check('QuadInstance shape matches CornerAO contract', shapeOk);

  check('normal is straight up (0,1,0)',
    quads.every((q) => q.normal[0] === 0 && q.normal[1] === 1 && q.normal[2] === 0));
  check('all corners hover at SHADOW_Y',
    quads.every((q) => {
      for (let v = 0; v < 4; v++) {
        if (q.positions[v * 3 + 1] !== SHADOW_Y) return false;
      }
      return true;
    }));
  check('SHADOW_Y is the documented 0.003', SHADOW_Y === 0.003);

  // Winding: both triangles of each quad face along the up normal.
  const windOk = quads.every((q) => {
    const n1 = triNormal(q.positions, 0, 1, 2);
    const n2 = triNormal(q.positions, 0, 2, 3);
    return n1[1] > 0 && n2[1] > 0 && close(n1[0], 0) && close(n1[2], 0)
      && close(n2[0], 0) && close(n2[2], 0);
  });
  check('corners wind CCW seen from above (+y geometric normals)', windOk);
}

// ---- geometry --------------------------------------------------------------

{
  const prop = makeProp('planter', 12.5, -3.75);
  const [q] = pass.generate([prop]);
  const [cx, , cz] = centroid(q);
  check('quad is centered on its prop', close(cx, prop.x) && close(cz, prop.z));

  // planter footprint 0.65 x 0.65; rot jitter is tiny (< ROT_JITTER=0.06 rad),
  // so world-space extents match the jittered rx/rz to sub-millimetre noise.
  const shadows = generateForProps([prop]);
  const s = shadows[0];
  const xs = [], zs = [];
  for (let v = 0; v < 4; v++) { xs.push(q.positions[v * 3]); zs.push(q.positions[v * 3 + 2]); }
  const ex = (Math.max(...xs) - Math.min(...xs)) / 2;
  const ez = (Math.max(...zs) - Math.min(...zs)) / 2;
  // rot jitter tilts the quad, so the axis-aligned extent is
  // rx*|cos t| + rz*|sin t| (symmetric under 90-degree rotation).
  const c = Math.abs(Math.cos(s.rot)), sn = Math.abs(Math.sin(s.rot));
  check('half-extents equal the rotated shadow instance rx/rz',
    close(ex, s.rx * c + s.rz * sn, 1e-12) && close(ez, s.rx * sn + s.rz * c, 1e-12),
    ex + ',' + ez + ' vs ' + (s.rx * c + s.rz * sn) + ',' + (s.rx * sn + s.rz * c));
  const expectR = 0.65 * 0.5 * SHADOW_MARGIN;
  check('radius carries the documented margin scaling',
    s.rx > expectR * 0.9 && s.rx < expectR * 1.1,
    String(s.rx));

  // Rotation: quarter-turning a long prop swaps its footprint axes.
  const deskA = makeProp('desk', 5, 5, 0);
  const deskB = makeProp('desk', 5, 5, 1);
  const sa = generateForProps([deskA])[0];
  const sb = generateForProps([deskB])[0];
  check('quarter-turn swaps instance rx/rz',
    close(sb.rx, sa.rz) && close(sb.rz, sa.rx));
  const qa = pass.generate([deskA])[0];
  const qb = pass.generate([deskB])[0];
  const ext = (q) => {
    const xs = [], zs = [];
    for (let v = 0; v < 4; v++) { xs.push(q.positions[v * 3]); zs.push(q.positions[v * 3 + 2]); }
    return [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...zs) - Math.min(...zs)) / 2];
  };
  const ea = ext(qa), eb = ext(qb);
  check('rotated desk quad shades along its swapped axis',
    close(eb[0], ea[1], 0.05) && close(eb[1], ea[0], 0.05),
    JSON.stringify([ea, eb]));

  // Rot-jitter actually turns the quad (not axis-aligned to machine eps).
  const cornersRotated = (() => {
    const dxs = [], dzs = [];
    for (let v = 0; v < 4; v++) {
      dxs.push(qa.positions[v * 3] - deskA.x);
      dzs.push(qa.positions[v * 3 + 2] - deskA.z);
    }
    // if rot were exactly 0, |dx| would be identical across all corners
    return Math.abs(dxs[0]) !== Math.abs(dxs[1]) || Math.abs(dzs[0]) !== Math.abs(dzs[2]);
  })();
  check('rotation jitter perturbs corner layout', cornersRotated);
}

// ---- tint scaling ----------------------------------------------------------

{
  check('default strength constant is 0.85', SHADOW_STRENGTH === 0.85);

  // tint formula at reference alpha and beyond
  check('tint at reference alpha equals 1 - strength',
    close(shadowVertexTint(SHADOW_ALPHA, 0.85), 0.15, 1e-12));
  check('zero alpha leaves tint neutral', shadowVertexTint(0, 0.85) === 1);
  check('alpha above reference clamps to full darkening',
    close(shadowVertexTint(SHADOW_ALPHA * 5, 0.85), 0.15));
  check('negative alpha clamps to neutral',
    shadowVertexTint(-1, 0.85) === 1);
  check('strength option is honored',
    close(shadowVertexTint(SHADOW_ALPHA, 0.5), 0.5));
  check('strength clamps into 0..1',
    new ShadowMesherPass({ strength: 9 }).strength === 1 &&
    new ShadowMesherPass({ strength: -3 }).strength === 0);

  // Quads carry the alpha-scaled darkening on every vertex.
  const props = [];
  for (let i = 0; i < 24; i++) {
    props.push(makeProp(i % 2 ? 'chair' : 'crate', i * 1.37 + 0.5, -i * 2.11 - 0.25, 0, i % 4));
  }
  const shadows = generateForProps(props);
  const quads = pass.generate(props);
  let tintsTrackAlpha = true;
  for (let i = 0; i < quads.length; i++) {
    const expected = shadowVertexTint(shadows[i].alpha, pass.strength);
    const t = quads[i].tints;
    for (let c = 0; c < 12; c++) {
      if (!close(t[c], expected, 1e-12)) { tintsTrackAlpha = false; }
    }
  }
  check('vertex tints scale with each instance\'s alpha', tintsTrackAlpha);

  // Across many props the deterministic size jitter must produce a spread of
  // alphas -> a spread of tints, monotonically ordered with alpha.
  const pairs = shadows.map((s, i) => ({ a: s.alpha, t: quads[i].tints[0] }))
    .sort((p, q) => p.a - q.a);
  let monotonic = true;
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i].t > pairs[i - 1].t + 1e-12) monotonic = false;
  }
  const spread = pairs[pairs.length - 1].t < pairs[0].t - 1e-6;
  check('darker tint always pairs with larger alpha', monotonic);
  check('jitter produces a real tint spread across props', spread,
    JSON.stringify([pairs[0], pairs[pairs.length - 1]]));
  check('tints stay in (0, 1]',
    pairs.every((p) => p.t > 0 && p.t <= 1));
}

// ---- prop-type radius variation --------------------------------------------

{
  const area = (q) => {
    const xs = [], zs = [];
    for (let v = 0; v < 4; v++) { xs.push(q.positions[v * 3]); zs.push(q.positions[v * 3 + 2]); }
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
  };
  const sofaQ = pass.generate([makeProp('sofa', 0, 0)])[0];
  const chairQ = pass.generate([makeProp('chair', 0, 0)])[0];
  check('sofa blob covers far more floor than chair blob',
    area(sofaQ) > area(chairQ) * 4,
    JSON.stringify([area(sofaQ), area(chairQ)]));

  const kinds = ['desk', 'cabinet', 'bench', 'vending', 'cooler', 'turnstile'];
  const areas = kinds.map((k) => area(pass.generate([makeProp(k, k.length * 3.1, -k.charCodeAt(0))])[0]));
  const distinct = new Set(areas.map((a) => Math.round(a * 1000))).size;
  check('distinct footprints per prop kind (' + kinds.join('/') + ')', distinct >= kinds.length - 1,
    JSON.stringify(areas));

  // battery casts no blob -> no quad
  const mixed = pass.generate([
    makeProp('battery', 1, 1),
    makeProp('battery', 2, 2, 2, 3),
    makeProp('locker', 3, 3),
  ]);
  check('battery emits nothing; blob props still do', mixed.length === 1);
  check('empty prop list yields empty batch', pass.generate([]).length === 0);
}

// ---- batching & determinism -------------------------------------------------

{
  const props = [];
  for (let i = 0; i < 200; i++) {
    const kind = ['desk', 'sofa', 'crate', 'gurney', 'shelf'][i % 5];
    props.push(makeProp(kind, ((i * 73) % 400) / 16, ((i * 131) % 400) / 16, i % 4, i % 4));
  }
  const shadows = generateForProps(props);
  const quads = pass.generate(props);
  check('single call batches the whole prop list',
    quads.length === shadows.length && shadows.length > 150,
    String(quads.length));

  // Deterministic: byte-identical regeneration.
  const again = pass.generate([...props].reverse());
  const firstReversed = [...quads].reverse();
  let stable = again.length === firstReversed.length;
  if (stable) {
    for (let i = 0; i < again.length; i++) {
      for (let c = 0; c < 12; c++) {
        if (again[i].positions[c] !== firstReversed[i].positions[c]) stable = false;
        if (again[i].tints[c] !== firstReversed[i].tints[c]) stable = false;
      }
    }
  }
  check('regeneration is order-stable and byte-identical', stable);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


