/*
 * F49 Accessibility pack verification: off-state passthrough identity for
 * every toggle, on-state effect correctness + bounds, combined-mode
 * composition without interference, determinism, and loud failure on
 * junk options.
 *
 *   node test/accessibilitypack-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'ui', 'accessibilitypack.ts');
const outPath = path.join(here, '.accessibilitypack.transpiled.mjs');

const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(outPath, js);

let failed = 0;
let passed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

let mod;
try {
  mod = await import(outPath);
} finally {
  unlinkSync(outPath);
}
const {
  DEFAULT_ACCESSIBILITY_PACK_OPTIONS,
  validateAccessibilityPackOptions,
  ZERO_SHAKE,
  createShakeFilter,
  createTiltFilter,
  createSubtitleTagger,
  DEFAULT_SPEAKER_TAGS,
  UNKNOWN_SPEAKER_TAG,
  HIGH_CONTRAST_PALETTE,
  resolveHighContrastPalette,
  paletteCssText,
  createAccessibilityPack,
} = mod;

const ALL_OFF = { ...DEFAULT_ACCESSIBILITY_PACK_OPTIONS };
const SHAKE = Object.freeze({ x: 0.31, y: -0.17, z: 0.09 });

/* ------------------------------------------------------------------ */
console.log('AC1a motionSafety off-state identity');
{
  const shake = createShakeFilter(ALL_OFF);
  const tilt = createTiltFilter(ALL_OFF);
  const out = shake(SHAKE);
  check('off filter returns the argument by reference', out === SHAKE);
  check('off filter preserves every component',
    out.x === SHAKE.x && out.y === SHAKE.y && out.z === SHAKE.z);
  check('off tilt is the exact passthrough identity',
    [0.42, -1.25, 0, 3.7].every((r) => tilt(r) === r));
  const pack = createAccessibilityPack(ALL_OFF);
  check('composed pack matches raw factories when off',
    pack.filterShake(SHAKE) === SHAKE && pack.filterTilt(0.9) === 0.9);
}

console.log('AC1b speakerTags off-state identity');
{
  const tag = createSubtitleTagger(ALL_OFF);
  const lines = ['follow me', 'the walls breathe', '', 'it saw you'];
  check('off tagger passes every line through unchanged for known speakers',
    lines.every((l) => tag('helper', l) === l && tag('system', l) === l));
  check('off tagger passes unknown speakers through unchanged too',
    tag('nobody', 'lines') === 'lines' && tag('', 'x') === 'x');
  check('off tagger never mutates its inputs',
    tag('double', 'same') === 'same' && typeof tag('double', 'same') === 'string');
}

console.log('AC1c highContrast off-state identity');
{
  check('off resolves to no override (null)', resolveHighContrastPalette(ALL_OFF) === null);
  check('off CSS layer emits zero rules', paletteCssText(resolveHighContrastPalette(ALL_OFF)) === '');
  const pack = createAccessibilityPack(ALL_OFF);
  check('composed pack palette() is null when off', pack.palette() === null);
}

/* ------------------------------------------------------------------ */
console.log('AC2a motionSafety on-state effects + bounds');
{
  const ON = { ...ALL_OFF, motionSafety: true };
  const shake = createShakeFilter(ON);
  const tilt = createTiltFilter(ON);
  for (const junk of [SHAKE, { x: NaN, y: Infinity, z: -1e9 }, { x: 5, y: 5, z: 5 }]) {
    const out = shake(junk);
    if (!(out.x === 0 && out.y === 0 && out.z === 0)) { failed++; console.error('FAIL  shake not zeroed for ' + JSON.stringify(junk)); continue; }
    passed++;
    console.log('  ok  shake zeroed for input ' + JSON.stringify(junk));
  }
  check('zeroed output is the canonical frozen ZERO_SHAKE', shake(SHAKE) === ZERO_SHAKE);
  check('tilt collapses every angle to exactly 0 rad',
    [0.42, -1.25, 0, 100, -100].every((r) => tilt(r) === 0));
  const out = shake({ x: 1e6, y: -1e6, z: 1e-12 });
  check('output stays bounded at exact zero under extreme input',
    out.x === 0 && out.y === 0 && out.z === 0);
}

console.log('AC2b speakerTags on-state effects');
{
  const ON = { ...ALL_OFF, speakerTags: true };
  const tag = createSubtitleTagger(ON);
  const speakers = Object.keys(DEFAULT_SPEAKER_TAGS);
  const tagged = speakers.map((s) => tag(s, 'line'));
  check('all five default tags are distinct prefixes',
    new Set(tagged).size === 5 &&
    speakers.every((s, i) => tagged[i].startsWith(DEFAULT_SPEAKER_TAGS[s] + ' ') &&
      tagged[i].endsWith('line')));
  check('unknown speaker falls back to [???]',
    tag('stranger', 'hi') === UNKNOWN_SPEAKER_TAG + ' hi' && UNKNOWN_SPEAKER_TAG === '[???]');
  check('speaker lookup is case-insensitive', tag('Watcher', 'up') === '[WATCHER] up');
  const custom = createSubtitleTagger(ON, { helper: '[GUIDE]', system: '' });
  check('injected map overrides defaults per key',
    custom('helper', 'go') === '[GUIDE] go' && custom('system', 'beep') === ' beep' &&
    custom('believer', 'kneel') === '[BELIEVER] kneel');
  check('empty line still gets a prefix', tag('double', '') === '[DOUBLE] ');
}

console.log('AC2c highContrast on-state effects + bounds');
{
  const ON = { ...ALL_OFF, highContrast: true };
  const pal = resolveHighContrastPalette(ON);
  check('on resolves to the canonical descriptor',
    !!pal && pal.bgLift === HIGH_CONTRAST_PALETTE.bgLift &&
    pal.textBoost === HIGH_CONTRAST_PALETTE.textBoost &&
    pal.outlineStrength === HIGH_CONTRAST_PALETTE.outlineStrength);
  check('canonical descriptor sits inside documented bounds',
    pal !== null && pal.bgLift >= 0 && pal.bgLift <= 1 &&
    pal.textBoost >= 1 && pal.textBoost <= 2 &&
    pal.outlineStrength >= 0 && pal.outlineStrength <= 1);
  const clamped = resolveHighContrastPalette(ON, { bgLift: 9, textBoost: -3, outlineStrength: 0.5 });
  check('out-of-range injected fields clamp into bounds',
    clamped !== null && clamped.bgLift <= 1 && clamped.textBoost >= 1 && clamped.outlineStrength === 0.5);
  const css = paletteCssText(pal);
  check('CSS declarations carry every field with values in bounds',
    css.includes('--bmb-hc-bg-lift: 0.240;') &&
    css.includes('--bmb-hc-text-boost: 1.400;') &&
    css.includes('--bmb-hc-outline-strength: 0.850;'));
  check('null palette emits no CSS (identity preserved)',
    paletteCssText(null) === '');
}

/* ------------------------------------------------------------------ */
console.log('AC3 combined modes compose without interference');
{
  const pairs = [
    ['motionSafety+speakerTags', { motionSafety: true, speakerTags: true, highContrast: false }],
    ['motionSafety+highContrast', { motionSafety: true, speakerTags: false, highContrast: true }],
    ['speakerTags+highContrast', { motionSafety: false, speakerTags: true, highContrast: true }],
  ];
  const soloMotion = createShakeFilter({ motionSafety: true, speakerTags: false, highContrast: false });
  const soloTag = createSubtitleTagger({ motionSafety: false, speakerTags: true, highContrast: false });
  const soloPal = () => resolveHighContrastPalette({ motionSafety: false, speakerTags: false, highContrast: true });
  for (const [name, opts] of pairs) {
    const pack = createAccessibilityPack(opts);
    // Each toggle's expected output is its solo-on effect when enabled in
    // the pair, and the off-state passthrough when disabled there.
    const expectShake = opts.motionSafety ? soloMotion(SHAKE) : SHAKE;
    const expectTilt = opts.motionSafety ? 0 : 0.7;
    const expectTag = opts.speakerTags ? soloTag('helper', 'go') : 'go';
    const expectPal = opts.highContrast ? soloPal() : null;
    const same =
      JSON.stringify(pack.filterShake(SHAKE)) === JSON.stringify(expectShake) &&
      pack.filterTilt(0.7) === expectTilt &&
      pack.tagSubtitle('helper', 'go') === expectTag &&
      JSON.stringify(pack.palette()) === JSON.stringify(expectPal);
    check(name + ': each toggle output identical to its solo state', same === true);
  }
  const allOn = createAccessibilityPack({ motionSafety: true, speakerTags: true, highContrast: true });
  check('all-on pack zeroes motion, tags subtitles, and overrides palette together',
    allOn.filterShake({ x: 3, y: 3, z: 3 }).x === 0 &&
    allOn.filterTilt(2) === 0 &&
    allOn.tagSubtitle('watcher', 'seen').startsWith('[WATCHER] ') &&
    allOn.palette() !== null);
  check('all-off composed pack is pure passthrough everywhere',
    JSON.stringify(createAccessibilityPack(ALL_OFF)) !== '{}' &&
    createAccessibilityPack(ALL_OFF).filterShake(SHAKE) === SHAKE &&
    createAccessibilityPack(ALL_OFF).tagSubtitle('helper', 'raw') === 'raw' &&
    createAccessibilityPack(ALL_OFF).palette() === null);
}

/* ------------------------------------------------------------------ */
console.log('AC4 determinism');
{
  const opts = { motionSafety: true, speakerTags: true, highContrast: true };
  const a = createAccessibilityPack(opts);
  const b = createAccessibilityPack(opts);
  const run = (pack) => JSON.stringify([
    pack.filterShake(SHAKE), pack.filterTilt(-0.33),
    pack.tagSubtitle('believer', 'the light lies'),
    pack.palette(),
  ]);
  check('two fresh packs with equal options produce byte-identical outputs',
    run(a) === run(b));
  check('repeated calls on one pack are stable', run(a) === run(a));
  const offA = run(createAccessibilityPack(ALL_OFF));
  const offB = run(createAccessibilityPack(ALL_OFF));
  check('off-state outputs are deterministic too', offA === offB);
}

/* ------------------------------------------------------------------ */
console.log('AC5 junk options fail loud');
{
  const junkInputs = [
    ['null', null],
    ['string', 'motionSafety'],
    ['number', 7],
    ['array', [true, true, true]],
    ['missing field', { motionSafety: true, speakerTags: true }],
    ['non-boolean field', { motionSafety: true, speakerTags: false, highContrast: 'yes' }],
  ];
  for (const [name, bad] of junkInputs) {
    let threw = null;
    try { validateAccessibilityPackOptions(bad); } catch (e) { threw = e; }
    check(name + ' throws TypeError naming the contract',
      threw instanceof TypeError && /accessibilitypack/.test(threw.message));
  }
  let composeThrew = null;
  try { createAccessibilityPack({ motionSafety: 1, speakerTags: false, highContrast: false }); }
  catch (e) { composeThrew = e; }
  check('createAccessibilityPack fails loud before building effectors',
    composeThrew instanceof TypeError && /non-boolean option fields/.test(composeThrew.message));
  try {
    validateAccessibilityPackOptions({ motionSafety: true, speakerTags: false, highContrast: false });
    passed++;
    console.log('  ok  valid options pass the gate unchanged');
  } catch {
    failed++;
    console.error('FAIL  valid options rejected by the gate');
  }
}

console.log('ACCESSIBILITYPACK_PASS checks=' + passed + ' failures=' + failed);
process.exit(failed === 0 ? 0 : 1);
