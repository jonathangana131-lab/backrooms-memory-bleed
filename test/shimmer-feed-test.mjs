/**
 * Heat shimmer feed tests.
 *
 * Two layers:
 *  1. RUNTIME - transpiles src/gfx/heatshimmer.ts (same trick as
 *     emergency-wiring-test) behind a minimal DOM stub, then drives
 *     HeatShimmer.update() against projected-style screen rects:
 *     nearest-first claiming, intensity clamping, malformed-rect
 *     rejection, MAX_SHIMMER_ZONES pooling and stop() permanence.
 *  2. WIRING  - static assertions over src/core/game.ts proving the
 *     frame loop feeds the shimmer: playing-state gate, try/catch,
 *     Vector3.Project projection with the camera viewport/transform,
 *     CSS-pixel {left,top,width} rects, behind-camera cull and a
 *     daycycle-derived intensity with a 0.5 default.
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

// ---- minimal DOM stub for heatshimmer.ts -----------------------------------

function makeElement(tag) {
  return {
    tagName: tag,
    id: '',
    className: '',
    textContent: '',
    children: [],
    style: { display: 'none', left: '', top: '', width: '', height: '', opacity: '', animationDelay: '' },
    appendChild(c) { this.children.push(c); if (c.id) registry.set(c.id, c); return c; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] ?? null; },
  };
}

const registry = new Map(); // id -> element (shared-style dedup path)

globalThis.document = {
  createElement(tag) { return makeElement(tag); },
  createElementNS(ns, tag) {
    const el = makeElement(tag);
    el.ns = ns;
    const attrs = {};
    el.setAttribute = function (k, v) { attrs[k] = v; };
    el.getAttribute = function (k) { return attrs[k] ?? null; };
    return el;
  },
  getElementById(id) { return registry.get(id) ?? null; },
  appendChild(c) { if (c.id) registry.set(c.id, c); return c; },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-shimmerfeed-'));

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const outPath = path.join(tmp, outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, js);
}
emit('src/gfx/heatshimmer.ts', 'gfx/heatshimmer.mjs');

const hm = await import(pathToFileURL(path.join(tmp, 'gfx', 'heatshimmer.mjs')).href);
const { HeatShimmer, MAX_SHIMMER_ZONES } = hm;

check('MAX_SHIMMER_ZONES is 4', MAX_SHIMMER_ZONES === 4);

let counter = 0;
function freshContainer() {
  const el = makeElement('div');
  el.id = 'container-' + (++counter);
  registry.set(el.id, el);
  return el;
}

function zoneRects(hs, container) {
  void hs;
  return container.children.filter((c) => c.className === 'bmb-heat-shimmer');
}

// ---- runtime: update() behavior --------------------------------------------

{
  const c = freshContainer();
  const hs = new HeatShimmer(c);
  check('starts pooled and hidden', zoneRects(hs, c).length === MAX_SHIMMER_ZONES
    && hs.activeZones === 0);

  // feed like the frame loop would: nearest-first projected rects
  const rects = [
    { left: 100, top: 40, width: 120 },
    { left: 500, top: 60, width: 80 },
  ];
  hs.update(rects, 0.7);
  const z = zoneRects(hs, c);
  check('two rects claim two columns', hs.activeZones === 2);
  check('column 0 tracks rect 0',
    z[0].style.left === '100px' && z[0].style.top === '40px' && z[0].style.width === '120px');
  check('column 1 tracks rect 1',
    z[1].style.left === '500px' && z[1].style.top === '60px' && z[1].style.width === '80px');
  const o = parseFloat(z[0].style.opacity);
  check('intensity raises opacity within band', o >= 0.05 && o <= 0.19, String(o));

  // empty feed hides every column (all fixtures dead / none on screen)
  hs.update([], 0.5);
  check('empty feed hides all columns', hs.activeZones === 0);

  // more rects than zones: only first MAX survive, order preserved
  const many = [1, 2, 3, 4, 5, 6].map((i) => ({ left: i * 10, top: i, width: 50 }));
  hs.update(many, 1);
  check('caps at MAX_SHIMMER_ZONES', hs.activeZones === MAX_SHIMMER_ZONES);
  check('nearest-first order kept', zoneRects(hs, c)[0].style.left === '10px'
    && zoneRects(hs, c)[3].style.left === '40px');

  // malformed entries skipped without displacing good ones
  const messy = [
    null,
    { left: 200, top: 10, width: NaN },  // NaN width fails the > 0 guard
    { left: 300, top: 10, width: -5 },   // negative width
    { left: 300, top: 10 },              // no width at all
    { left: 300, top: 10, width: 70 },   // the one good rect
  ];
  hs.update(messy, 0.5);
  check('malformed rects rejected', hs.activeZones === 1
    && zoneRects(hs, c)[0].style.width === '70px'
    && zoneRects(hs, c)[0].style.left === '300px');

  // intensity clamps both ways
  hs.update([{ left: 10, top: 10, width: 50 }], 42);
  const hi = parseFloat(zoneRects(hs, c)[0].style.opacity);
  hs.update([{ left: 10, top: 10, width: 50 }], -3);
  const lo = parseFloat(zoneRects(hs, c)[0].style.opacity);
  check('clamps intensity > 1', hi <= 0.19, String(hi));
  check('clamps intensity < 0', lo >= 0.05 - 1e-9, String(lo));

  // stop() is permanent
  hs.stop();
  check('stop freezes columns', hs.isStopped && hs.activeZones === 0);
  hs.update([{ left: 99, top: 99, width: 90 }], 0.9);
  check('update ignored after stop', hs.activeZones === 0
    && zoneRects(hs, c)[0].style.left !== '99px');

  // defensive: update(null, ...) must not throw even post-stop
  let threw = false;
  try { hs.update(null, 0.5); } catch { threw = true; }
  check('null feed tolerated post-stop', !threw);
}

// second instance reuses shared style/filter without duplicating ids
{
  const c = freshContainer();
  new HeatShimmer(c);
  const dupIds = c.children.filter((k) => k.id === 'bmb-heat-shimmer-style').length;
  check('shared style not duplicated per instance', dupIds === 0);
}

// ---- wiring: static checks over game.ts ------------------------------------

const gameSrc = fs.readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');

const gateIdx = gameSrc.indexOf("if (this.state === 'playing' && this.heatShimmer)");
check('frame loop gates shimmer on playing state + instance', gateIdx > 0);
if (gateIdx > 0) {
  const block = gameSrc.slice(gateIdx, gateIdx + 4200);

  check('feed wrapped in try/catch', block.includes('try {') && block.includes('catch'));
  check('projects via Vector3.Project', block.includes('Vector3.Project('));
  check('uses camera viewport toGlobal', block.includes('this.camera.viewport.toGlobal('));
  check('uses scene transform matrix', block.includes('scene.getTransformMatrix()'));
  check('behind-camera forward-dot cull present', block.includes('fwd.x') && block.includes('fwd.z'));
  check('emits {left,top,width} rects', block.includes('{ left:') || block.includes('left:'));
  check('feeds heatShimmer with projected rects', block.includes('.update(rects,'));
  check('daycycle intensity via shimmerIntensity', block.includes('shimmerIntensity('));
  check('0.5 default when no day phase data', block.includes('= 0.5'));
  check('alive-only fixture filter', block.includes('(f) => f.alive'));
}

// constants exist and reference the mesher ceiling plane
check('WALL_H imported for head height', gameSrc.includes('WALL_H') && gameSrc.includes("from '../world/constants'"));
check('FixtureScreen type used for rect array', gameSrc.includes('FixtureScreen[]'));

console.log(failures === 0 ? '\nSHIMMER_FEED_PASS' : '\nSHIMMER_FEED_FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);


