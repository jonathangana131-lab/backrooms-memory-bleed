/*
 * Accessibility system verification: option schema/validation, motion
 * reduction math, interaction hold, tokens/CSS generation, manager
 * persistence + change notification, and the DOM controller.
 *
 *   node test/accessibility-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'ui', 'accessibility.ts');
const outPath = path.join(here, '.accessibility.transpiled.mjs');

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
  mod = await import('./.accessibility.transpiled.mjs');
} finally {
  unlinkSync(outPath);
}

const {
  ACCESSIBILITY_KEY, DEFAULT_ACCESSIBILITY_OPTIONS, CAPTION_KINDS,
  captionLabel, motionScale, shakeIntensity, headBobAmplitude, fovKickDeg,
  REDUCED_EFFECT_SCALE, screenEffectStrength, interactionHoldMs,
  validateAccessibilityOptions, accessibilityTokens, accessibilityCssText,
  CAPTION_FLASH_MS, AccessibilityManager, AccessibilityController,
} = mod;

console.log('constants & defaults');
check('storage key is bmb-accessibility', ACCESSIBILITY_KEY === 'bmb-accessibility');
check('every aid defaults OFF', Object.values(DEFAULT_ACCESSIBILITY_OPTIONS).every((v) => v === false));
check('three known caption kinds', JSON.stringify(CAPTION_KINDS) === JSON.stringify(['THUNDER', 'SCREAM', 'IMPACT']));
check('caption flash duration is 1400 ms', CAPTION_FLASH_MS === 1400);

console.log('captions');
check('bracketed labels upper-case kinds', captionLabel('thunder') === '[THUNDER]');
check('unknown kinds are upper-cased, not rejected', captionLabel('explosion') === '[EXPLOSION]');
check('label wrapping is deterministic per kind', captionLabel('scream') === captionLabel('SCREAM'));

console.log('motion reduction');
const ALL_ON = { motionReduction: true, highContrast: true, subtitleBackground: true, instantInteract: true, audioCaptions: true };
const ALL_OFF = { ...DEFAULT_ACCESSIBILITY_OPTIONS };
check('motion scale zeroes under reduction', motionScale(ALL_ON) === 0);
check('motion scale is one otherwise', motionScale(ALL_OFF) === 1);
check('camera shake silenced when reduced', shakeIntensity(ALL_ON, 0.5) === 0);
check('head bob silenced when reduced', headBobAmplitude(ALL_ON, 0.25) === 0);
check('FOV kick silenced when reduced', fovKickDeg(ALL_ON, 8) === 0);
check('shake passes through untouched when off', shakeIntensity(ALL_OFF, 0.5) === 0.5);
check('screen effects scale down to 35%', Math.abs(screenEffectStrength(ALL_ON, 1) - 0.35) < 1e-9 && REDUCED_EFFECT_SCALE === 0.35);
check('screen effects full strength when off', screenEffectStrength(ALL_OFF, 1) === 1);
check('instant interact zeroes the hold', interactionHoldMs({ ...ALL_OFF, instantInteract: true }, 600) === 0);
check('normal hold preserved otherwise', interactionHoldMs(ALL_OFF, 600) === 600);

console.log('validation');
{
  const v = validateAccessibilityOptions('garbage');
  check('non-object input yields defaults', JSON.stringify(v) === JSON.stringify(DEFAULT_ACCESSIBILITY_OPTIONS));
  const p = validateAccessibilityOptions({ highContrast: true, audioCaptions: 'yes', extra: 1 });
  check('boolean fields kept, non-booleans fall back',
    p.highContrast === true && p.audioCaptions === false
    && p.motionReduction === false && p.instantInteract === false
    && p.subtitleBackground === false);
}

console.log('tokens & stylesheet');
check('tokens map each enabled aid', JSON.stringify(accessibilityTokens({
  motionReduction: true, highContrast: false, subtitleBackground: true,
  instantInteract: false, audioCaptions: true,
})) === JSON.stringify(['motion-reduced', 'subtitle-bg', 'audio-captions']));
{
  const cssOff = accessibilityCssText(ALL_OFF);
  check('no a11y rules while every option is off',
    !cssOff.includes('high-contrast') && !cssOff.includes('subtitle-bg') && !cssOff.includes('motion-reduced'));
  const cssOn = accessibilityCssText({ ...ALL_OFF, highContrast: true, subtitleBackground: true });
  check('high contrast rules emitted', cssOn.includes('data-bmb-a11y~="high-contrast"'));
  check('subtitle backing rules emitted', cssOn.includes('data-bmb-a11y~="subtitle-bg"'));
  const cssMotion = accessibilityCssText({ ...ALL_OFF, motionReduction: true });
  check('frozen transitions/animations under motion reduction',
    cssMotion.includes('transition-duration: 0s') && cssMotion.includes('animation-duration: 0s'));
  check('caption overlay chrome always ships', cssOn.includes('.bmb-a11y-caption-layer'));
}

console.log('manager');
{
  const store = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
  })();
  const mgr = new AccessibilityManager(store);
  check('fresh manager starts at defaults', mgr.options.motionReduction === false && mgr.options.highContrast === false);
  let notified = null;
  const unsub = mgr.onChange((o) => { notified = o; });
  const snap = mgr.set({ motionReduction: true, instantInteract: true });
  check('set merges, validates and returns a full snapshot',
    snap.motionReduction === true && snap.highContrast === false && snap.audioCaptions === false);
  check('listeners see the applied snapshot', !!notified && notified.motionReduction === true);
  unsub();
  mgr.set({ motionReduction: false });
  check('unsubscribed listeners stop firing', notified === null || notified.motionReduction === true);

  const mgr2 = new AccessibilityManager(store);
  check('options persist across managers via the storage bucket',
    mgr2.options.motionReduction === false && store.getItem(ACCESSIBILITY_KEY) !== null);
  store.setItem(ACCESSIBILITY_KEY, '{broken json');
  check('corrupt persisted data falls back to defaults', mgr2.load().motionReduction === false);
  const r = mgr2.reset();
  check('reset restores factory defaults', JSON.stringify(r) === JSON.stringify(DEFAULT_ACCESSIBILITY_OPTIONS));
}

console.log('controller');
{
  const mgr = new AccessibilityManager();
  const html = makeElement();
  const doc = {
    createElement: () => makeElement(),
    head: makeElement(),
    documentElement: html,
  };
  const { controller, dispose } = AccessibilityController.attach(mgr, doc);
  check('attach applies current options to the root dataset',
    typeof html.dataset.bmbA11y === 'string');
  mgr.set({ audioCaptions: true });
  check('root data attributes follow option changes',
    html.dataset.bmbA11y.includes('audio-captions'));
  const cap = controller.showCaption('THUNDER');
  check('enabled captions flash labeled elements',
    !!cap && cap.textContent === '[THUNDER]'
    && typeof cap.style._props.left === 'string' && cap.style._props.left.endsWith('%'));
  check('preformatted labels are accepted verbatim',
    controller.showCaption('[IMPACT]').textContent === '[IMPACT]');
  // captions disabled mid-flight: showCaption no-ops
  mgr.set({ audioCaptions: false });
  check('disabling captions stops new flashes', controller.showCaption('THUNDER') === null);
  dispose();
  check('detach clears root attributes', html.dataset.bmbA11y === undefined);
}

/* ------------------------------------------------------------------ */

function makeElement() {
  const el = {
    tagName: 'div',
    className: '',
    dataset: {},
    textContent: '',
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = value; },
    },
    children: [],
    _parent: null,
    appendChild(c) { c._parent = el; el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    remove() {
      if (el._parent) {
        const i = el._parent.children.indexOf(el);
        if (i >= 0) el._parent.children.splice(i, 1);
        el._parent = null;
      }
    },
  };
  return el;
}

console.log(failed === 0 ? '\nALL ACCESSIBILITY TESTS PASSED' : '\n' + failed + ' FAILURE(S)');
process.exit(failed === 0 ? 0 : 1);
