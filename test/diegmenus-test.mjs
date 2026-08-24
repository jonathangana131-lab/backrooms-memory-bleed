/**
 * Diegetic menu tests (F93) - pure Node, no DOM.
 * Verifies the F93 acceptance proof:
 *   1. AC projection mount - every projected quad (title, items, highlight)
 *      is exactly coplanar on the injected wall plane and stays inside the
 *      menu extents; raycastPlane() mounts the anchor at the expected hit
 *      point and rejects parallel/behind/junk rays
 *   2. readable orientation - quads run left-to-right along the viewer's
 *      right vector on the readable side; faceTowards() flips a wall whose
 *      normal points away so text reads correctly from the player side
 *   3. cursor wrap exact at ends - 'down' from the last row lands on row 0,
 *      'up' from row 0 lands on the last row; the highlight quad tracks the
 *      virtual cursor center after every move
 *   4. label aspect ratios preserved within tolerance - quad width/height
 *      equals labelAspectRatio for short and over-long labels alike (over-
 *      long labels shrink glyph height instead of stretching)
 *   5. determinism - identical injections replay byte-identical projections
 *      across instances and wrap states
 *   6. junk planes rejected (documented) - non-finite entries, zero-length
 *      normal/up and collinear normal/up throw 'degenerate wall plane';
 *      empty item lists, duplicate ids and non-string labels fail loud
 *
 * Run: node test/diegmenus-test.mjs  (prints DIEGMENUS ALL PASS, exits 0)
 */
import { register } from 'node:module';

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

const {
  DiegeticMenu, planeFrame, faceTowards, raycastPlane, labelAspectRatio,
  MENU_WIDTH_M, MENU_HEIGHT_M,
} = await import('../src/ui/diegmenus.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near_ = (a, b, eps) => Math.abs(a - b) <= eps;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Wall facing +z anchored near the world origin, up = +y. */
const wall = () => ({ origin: [2, 1.5, -3], normal: [0, 0, 1], up: [0, 1, 0] });
const content = () => ({
  id: 'pause', title: 'PAUSED — THE HALL REMEMBERS',
  items: [
    { id: 'resume', label: 'RESUME' },
    { id: 'save', label: 'SAVE EXPEDITION' },
    { id: 'settings', label: 'SETTINGS' },
    { id: 'quit', label: 'QUIT TO TITLE' },
  ],
});
const allQuads = (p) => [p.titleQuad, ...p.items.map((i) => i.quad), p.highlightQuad].filter(Boolean);

// ---------------------------------------------------------------------------
console.log('1. AC projection mount: coplanar quads inside extents');
{
  const w = wall();
  const m = new DiegeticMenu(content(), w);
  const f = planeFrame(w);
  const p = m.project();
  let coplanar = true;
  let inExtents = true;
  for (const q of allQuads(p)) {
    for (const c of q) {
      if (Math.abs(dot(sub(c, f.origin), f.normal)) > 1e-9) coplanar = false;
      const du = dot(sub(c, f.origin), f.right);
      const dv = dot(sub(c, f.origin), f.up);
      if (!(Math.abs(du) <= MENU_WIDTH_M / 2 + 1e-9 && Math.abs(dv) <= MENU_HEIGHT_M / 2 + 1e-9)) inExtents = false;
    }
  }
  ok(coplanar, `all ${allQuads(p).length} quads coplanar on the wall plane`);
  ok(inExtents, 'every corner inside the menu wall extents');
  ok(p.items.length === 4 && p.highlightQuad !== null, 'items projected in order with a highlight quad');

  // Raycast mounting: aim from the player eye at the anchor, expect the hit
  // at the anchor itself.
  const eye = [2, 1.7, 2];
  const dir = [-0, Math.sin(-0.02), Math.cos(Math.PI)]; // toward origin along -z-ish
  const hit = raycastPlane(eye, dir, w);
  ok(hit !== null && near_(hit[0], 2, 1e-6) && near_(hit[2], -3, 1e-6), `raycast mounts anchor (${hit?.map((v) => v.toFixed(3))})`);
  // A tilted ray still hits the infinite plane at the predicted crossing.
  const hit2 = raycastPlane([0, 0, 0], [2, 3, 4], { origin: [0, 0, 10], normal: [0, 0, 1], up: [0, 1, 0] });
  ok(hit2 !== null && near_(hit2[2], 10, 1e-9), 'tilted ray hits the plane where it crosses');
  ok(raycastPlane(eye, [0, 0, 1], w) === null, 'ray pointing away rejected');
  ok(raycastPlane(eye, [1, 0, 0], w) === null, 'parallel ray rejected');
  ok(raycastPlane([NaN, 0, 0], [0, 0, 1], w) === null, 'junk ray rejected (null, not throw)');
}
// ---------------------------------------------------------------------------
console.log('2. Readable orientation from the player side');
{
  const w = wall();
  const playerPos = [2, 1.5, 1]; // on the +normal side
  const m = new DiegeticMenu(content(), w);
  const f = planeFrame(w);
  let ltr = true;
  let ttb = true;
  for (const q of allQuads(m.project())) {
    if (!(dot(sub(q[1], q[0]), f.right) > 0)) ltr = false;   // TR right of TL
    if (!(dot(sub(q[3], q[0]), f.up) < 0)) ttb = false;      // BL below TL
  }
  ok(ltr && ttb, 'text runs left-to-right, top-to-bottom on the readable side');
  // Wall mounted back-to-front: flip makes it readable without moving quads
  // off the plane.
  const backwards = { origin: [0, 1.5, 0], normal: [0, 0, -1], up: [0, 1, 0] };
  const fixed = faceTowards(backwards, playerPos);
  const toPlayer = sub(playerPos, fixed.origin);
  ok(dot(toPlayer, planeFrame(fixed).normal) > 0, 'faceTowards flips the normal to face the player');
  const mf = new DiegeticMenu(content(), fixed);
  const ff = planeFrame(fixed);
  let coplanarAfterFlip = true;
  for (const q of allQuads(mf.project())) {
    for (const c of q) if (Math.abs(dot(sub(c, ff.origin), ff.normal)) > 1e-9) coplanarAfterFlip = false;
  }
  ok(coplanarAfterFlip, 'flipped mount keeps every quad coplanar');
}
// ---------------------------------------------------------------------------
console.log('3. Cursor wrap exact at ends; highlight tracks cursor');
{
  const m = new DiegeticMenu(content(), wall());
  const n = 4;
  ok(m.cursor === 0 && m.selectedId === 'resume', 'starts on row 0');
  m.move(-1);
  ok(m.cursor === n - 1 && m.selectedId === 'quit', 'up from first wraps exactly to last');
  m.move(1);
  ok(m.cursor === 0, 'down from last wraps exactly to first');
  for (let i = 0; i < n * 3 + 2; i++) m.input('down');
  ok(m.cursor === 2, `${n * 3 + 2} downs land modulo ${n}`);
  ok(m.input('left') === false && m.cursor === 2, 'unknown input ignored');
  // Highlight quad centers on the cursor row.
  const centerOf = (q) => [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, (q[0][2] + q[2][2]) / 2];
  let tracked = true;
  for (let i = 0; i < n; i++) {
    m.move(1);
    const p = m.project();
    const hl = centerOf(p.highlightQuad);
    const it = centerOf(p.items[m.cursor].quad);
    if (!near_(hl[1], it[1], 1e-9) || !near_(hl[0], it[0], 1e-9)) tracked = false;
  }
  ok(tracked, 'highlight quad stays centered on the selected row through wraps');
}
// ---------------------------------------------------------------------------
console.log('4. Label aspect ratios preserved within tolerance');
{
  const labels = ['A', 'OK', 'SETTINGS', 'a'.repeat(30), 'b'.repeat(60)];
  const c = { id: 't', title: '', items: labels.map((l, i) => ({ id: String(i), label: l })) };
  const p = new DiegeticMenu(c, wall()).project();
  let exact = true;
  let longShrunkNotStretched = true;
  for (let i = 0; i < labels.length; i++) {
    const it = p.items[i];
    if (!near_(it.aspect, labelAspectRatio(labels[i]), 1e-12)) exact = false;
    const w = Math.hypot(...sub(it.quad[1], it.quad[0]));
    const h = Math.hypot(...sub(it.quad[3], it.quad[0]));
    if (!near_(w / h, it.aspect, 1e-9)) exact = false;
    if (w > (MENU_WIDTH_M * 0.86) + 1e-9) longShrunkNotStretched = false;
  }
  ok(exact, 'quad width/height equals labelAspectRatio to float noise for all lengths');
  ok(longShrunkNotStretched, 'over-long labels shrink height instead of stretching past the width budget');
}
// ---------------------------------------------------------------------------
console.log('5. Determinism');
{
  const snap = () => {
    const m = new DiegeticMenu(content(), wall());
    const frames = [];
    for (let i = 0; i < 5; i++) { frames.push(JSON.stringify(m.project())); m.input('down'); }
    return JSON.stringify(frames);
  };
  ok(snap() === snap(), 'identical injections replay byte-identical projections incl. cursor states');
}
// ---------------------------------------------------------------------------
console.log('6. Junk planes and content fail loud (documented)');
{
  const cases = [
    ['zero normal', { origin: [0, 0, 0], normal: [0, 0, 0], up: [0, 1, 0] }],
    ['zero up', { origin: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 0] }],
    ['collinear normal/up', { origin: [0, 0, 0], normal: [0, 1, 0], up: [0, 2, 0] }],
    ['NaN entry', { origin: [NaN, 0, 0], normal: [0, 0, 1], up: [0, 1, 0] }],
    ['missing object', null],
  ];
  let allThrew = true;
  for (const [name, plane] of cases) {
    try {
      new DiegeticMenu(content(), plane).project();
      allThrew = false;
      console.error('   no throw:', name);
    } catch (e) {
      if (!/degenerate wall plane/.test(String(e))) { allThrew = false; console.error('   wrong error:', name, String(e)); }
    }
  }
  ok(allThrew, 'all junk planes throw "degenerate wall plane"');
  try { new DiegeticMenu({ id: 'x', title: 'T', items: [] }, wall()); ok(false, 'empty items should throw'); }
  catch { ok(true, 'empty item list fails loud'); }
  try { new DiegeticMenu({ id: 'x', title: 'T', items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, wall()); ok(false, 'duplicate ids should throw'); }
  catch { ok(true, 'duplicate ids fail loud'); }
  try { new DiegeticMenu({ id: 'x', title: 'T', items: [{ id: 'a', label: 7 }] }, wall()); ok(false, 'non-string label should throw'); }
  catch { ok(true, 'non-string label fails loud'); }
  // Junk rays never throw (null contract), unlike junk planes.
  const f0 = planeFrame(wall());
  ok(near_(Math.hypot(...f0.right), 1, 1e-12) && near_(Math.hypot(...f0.up), 1, 1e-12) && near_(Math.hypot(...f0.normal), 1, 1e-12)
    && near_(dot(f0.right, f0.normal), 0, 1e-12) && near_(dot(f0.up, f0.normal), 0, 1e-12),
    'frame vectors orthonormal');
}
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`DIEGMENUS FAIL: ${failures}/${check} checks failed`);
  process.exit(1);
}
console.log(`DIEGMENUS ALL PASS (${check} checks)`);
