/**
 * Unit test for render clarity pass (src/gfx/renderclarity.ts).
 * Standalone (no browser): transpiles the module into a temp dir with stub
 * modules standing in for the Babylon value imports, then drives the pure
 * policy functions and a faked engine/scene through applyRenderClarity().
 * Run: node test/renderclarity-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-renderclarity-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
const NL = String.fromCharCode(10);

// transpile the module; rewrite @babylonjs/core/* imports to local stubs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  // walk the single-quoted string literals and remap Babylon specifiers
  const parts = js.split(String.fromCharCode(39));
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].startsWith('@babylonjs/core/')) {
      parts[i] = '../babylon/' + parts[i].slice('@babylonjs/core/'.length) + '.mjs';
    }
  }
  const out = path.join(tmp, outRel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, parts.join(String.fromCharCode(39)));
}

function stub(rel, lines) {
  const out = path.join(tmp, 'babylon', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join(NL) + NL);
}

emit('src/gfx/renderclarity.ts', 'gfx/renderclarity.mjs');
stub('Materials/Textures/texture.mjs', [
  'export class Texture {}',
  'Texture.NEAREST_SAMPLINGMODE = 1;',
  'Texture.TRILINEAR_SAMPLINGMODE = 3;',
]);
stub('Materials/colorCurves.mjs', [
  'export class ColorCurves {',
  '  constructor() { this.globalHue = 30; this.globalDensity = 0; this.globalSaturation = 0; }',
  '}',
]);
stub('PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.mjs', [
  'export class DefaultRenderingPipeline {}',
]);

const rc = await import(pathToFileURL(path.join(tmp, 'gfx/renderclarity.mjs')).href);

// ---- tier normalization ---------------------------------------------------
{
  check('low stays low', rc.normalizeQualityTier('low') === 'low');
  check('medium stays medium', rc.normalizeQualityTier('medium') === 'medium');
  check('high stays high', rc.normalizeQualityTier('high') === 'high');
  check('unknown reads as medium', rc.normalizeQualityTier('ultra') === 'medium');
  check('missing reads as medium', rc.normalizeQualityTier(undefined) === 'medium');
}

// ---- scaling math ---------------------------------------------------------
{
  check('low tier leaves scaling untouched', rc.clarityResolutionScale('low') === null);
  check('low tier leaves hardware level untouched', rc.clarityHardwareScalingLevel('low') === null);
  check('medium targets 0.85x native', rc.clarityResolutionScale('medium') === 0.85);
  check('high targets native', rc.clarityResolutionScale('high') === 1);
  const m = rc.clarityHardwareScalingLevel('medium');
  const h = rc.clarityHardwareScalingLevel('high');
  check('medium hardware level is 1/scale', Math.abs(m - 1 / 0.85) < 1e-12, String(m));
  check('high hardware level is 1.0', h === 1, String(h));
  check('higher tier renders more pixels', h < m);
}

// ---- fog caps -------------------------------------------------------------
{
  const cap = rc.MAX_CLARITY_FOG_DENSITY;
  check('cap trims the storage district preset', rc.clampFogDensity(0.046) === cap, String(rc.clampFogDensity(0.046)));
  check('cap trims the maze district preset', rc.clampFogDensity(0.040) === cap);
  check('clear districts pass through unchanged', rc.clampFogDensity(0.021) === 0.021);
  check('cap is idempotent', rc.clampFogDensity(rc.clampFogDensity(0.5)) === cap);
  check('NaN collapses to clear air', rc.clampFogDensity(NaN) === 0);
  check('negative collapses to clear air', rc.clampFogDensity(-0.01) === 0);
  check('cap sits below the deepest district preset', cap < 0.046);
  check('cap sits above the clearest district preset', cap > 0.021);
  check('fog variation peak still capped after boost', rc.clampFogDensity(0.032 * 1.15) <= cap);
}

// ---- grade tables ----------------------------------------------------------
{
  const bands = rc.GRADE_BANDS;
  check('five district bands', bands.length === 5, String(bands.length));
  let subtle = true;
  for (const b of bands) {
    if (!(b.density >= 1 && b.density <= 10)) subtle = false;
    if (!(b.saturation >= -10 && b.saturation <= 10)) subtle = false;
    if (!(b.hue >= 0 && b.hue <= 360)) subtle = false;
  }
  check('every grade stays subtle (tint, not LUT)', subtle);
  check('corridor grid grades cool', bands[3].hue > 150, String(bands[3].hue));
  check('other bands keep fluorescent warmth', bands[0].hue < 120 && bands[2].hue < 120);
  const fb = rc.gradeBandFor(-1) === rc.GRADE_BAND_FALLBACK && rc.gradeBandFor(99) === rc.GRADE_BAND_FALLBACK;
  check('out-of-range falls back', fb);
  check('fractional index falls back', rc.gradeBandFor(1.5) === rc.GRADE_BAND_FALLBACK);
  check('fallback matches open office', rc.gradeBandFor(1).hue === bands[1].hue);
}

// ---- fakes ------------------------------------------------------------------
const dpMod = await import(pathToFileURL(path.join(tmp,
  'babylon/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.mjs')).href);
const BabylonPipe = dpMod.DefaultRenderingPipeline;

class FakeEngine {
  constructor() { this.isWebGPU = false; this._level = 1; this.scalingCalls = 0; }
  setHardwareScalingLevel(v) { this._level = v; this.scalingCalls++; }
  getHardwareScalingLevel() { return this._level; }
}

class FakePipe extends BabylonPipe {
  getClassName() { return 'DefaultRenderingPipeline'; }
  constructor() {
    super();
    this.fxaaEnabled = false;
    this.sharpenEnabled = false;
    this.sharpen = { edgeAmount: 0, colorAmount: 1 };
  }
}

function fakeScene(opts = {}) {
  const pipe = new FakePipe();
  const scene = {
    fogDensity: opts.fogDensity === undefined ? 0.028 : opts.fogDensity,
    textures: [{ anisotropicFilteringLevel: 1, samplingMode: 1 }],
    imageProcessingConfiguration: {
      grainEnabled: true, grainIntensity: 9, grainAnimated: true,
      colorCurves: null, colorCurvesEnabled: false,
    },
    postProcessRenderPipelineManager: { supportedPipelines: [pipe] },
    _pipe: pipe,
  };
  if (opts.noPipelineManager) {
    Object.defineProperty(scene, 'postProcessRenderPipelineManager', {
      get() { throw new Error('pipeline manager not built yet'); },
    });
  }
  return scene;
}

// ---- tier gating: low keeps legacy behavior ----------------------------------
{
  const e = new FakeEngine();
  const s = fakeScene({ fogDensity: 0.05 });
  const h = rc.applyRenderClarity(e, s, { quality: 'low' });
  check('low tier reports unapplied', h.report.applied === false);
  check('low tier never touches scaling', e.scalingCalls === 0 && e.getHardwareScalingLevel() === 1);
  check('low tier never touches textures', s.textures[0].anisotropicFilteringLevel === 1 && s.textures[0].samplingMode === 1);
  h.update();
  check('low tier never caps fog', s.fogDensity === 0.05, String(s.fogDensity));
  check('low tier never disables grain', s.imageProcessingConfiguration.grainEnabled === true);
  h.setGrain(false);
  check('low tier ignores grain toggle', s.imageProcessingConfiguration.grainEnabled === true);
}

// ---- medium tier: full anti-mud pass ----------------------------------------
{
  const e = new FakeEngine();
  const s = fakeScene({ fogDensity: 0.046 });
  const h = rc.applyRenderClarity(e, s, { quality: 'medium' });
  check('medium tier applies', h.report.applied === true);
  check('scaling driven toward native', Math.abs(e.getHardwareScalingLevel() - 1 / 0.85) < 1e-12, String(e.getHardwareScalingLevel()));
  check('aniso raised on textures', s.textures[0].anisotropicFilteringLevel === 4);
  check('nearest sampling upgraded to trilinear', s.textures[0].samplingMode === 3 && h.report.samplingUpgraded === 1);
  check('webgl path adopts FXAA', h.report.antiAliasing === 'fxaa' && s._pipe.fxaaEnabled === true);
  check('sharpen reserved for high tier', h.report.sharpen === false && s._pipe.sharpenEnabled === false);
  check('boot-time fog breach recorded', h.report.fogDensityCappedFrom === 0.046, String(h.report.fogDensityCappedFrom));
  check('boot fog capped', s.fogDensity === rc.MAX_CLARITY_FOG_DENSITY && h.report.fogDensityAfter === rc.MAX_CLARITY_FOG_DENSITY);
  check('grain defaults OFF', s.imageProcessingConfiguration.grainEnabled === false && h.report.grainEnabled === false);
  // lighting rig eases density back up every frame; update() must re-cap
  s.fogDensity = 0.046;
  h.update();
  check('update() re-caps eased-up fog', s.fogDensity === rc.MAX_CLARITY_FOG_DENSITY);
  // grain toggle round-trip
  h.setGrain(true);
  check('grain ON restores faint intensity', s.imageProcessingConfiguration.grainEnabled === true && s.imageProcessingConfiguration.grainIntensity === 4);
  h.setGrain(false);
  check('grain OFF again', s.imageProcessingConfiguration.grainEnabled === false && h.report.grainEnabled === false);
  // district grading
  h.update(2);
  const cc = s.imageProcessingConfiguration.colorCurves;
  check('band 2 grade applied', s.imageProcessingConfiguration.colorCurvesEnabled === true && cc.globalHue === 68 && cc.globalDensity === 7 && cc.globalSaturation === 8);
  check('grade band recorded', h.report.gradeBand === 2);
  h.update(99);
  check('unknown band falls back to canonical', cc.globalHue === rc.GRADE_BAND_FALLBACK.hue);
  h.dispose();
}

// ---- high tier + WebGPU backend ----------------------------------------------
{
  const e = new FakeEngine();
  e.isWebGPU = true;
  const s = fakeScene();
  const h = rc.applyRenderClarity(e, s, { quality: 'high' });
  check('high tier drives native resolution', e.getHardwareScalingLevel() === 1);
  check('high tier raises aniso to 8', s.textures[0].anisotropicFilteringLevel === 8);
  check('WebGPU keeps hardware MSAA', h.report.antiAliasing === 'msaa-hardware');
  check('FXAA left off under MSAA', s._pipe.fxaaEnabled === false);
  check('subtle sharpen enabled on high', h.report.sharpen === true && s._pipe.sharpen.edgeAmount === 0.18);
}

// ---- silent degradation -------------------------------------------------------
{
  const e = new FakeEngine();
  const s = fakeScene({ noPipelineManager: true });
  let threw = false;
  try {
    const h = rc.applyRenderClarity(e, s, { quality: 'high' });
    h.update(0);
  } catch { threw = true; }
  check('missing pipeline manager degrades silently', !threw);
}

console.log(failures ? '' + failures + ' FAILURE(S)' : 'RENDERCLARITY_PASS');
process.exitCode = failures ? 1 : 0;
