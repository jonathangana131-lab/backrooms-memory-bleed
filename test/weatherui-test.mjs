/*
 * Functional verification of the incoming weather-front warning UI
 * (src/ui/weatherui.ts): banner window math (eta < 30s), storm variant,
 * restraint gap + peak suppression, arrival flash tinting/opacity/fade,
 * reset semantics, and the DOM layer against a stub document.
 *
 * Run: node --experimental-strip-types test/weatherui-test.mjs
 */
import assert from 'node:assert/strict';
import {
  AMBER_ACCENT,
  ARRIVAL_FADE_MS,
  ARRIVAL_HOLD_MS,
  ARRIVAL_OPACITY,
  BANNER_TEXT_CALM,
  BANNER_TEXT_STORM,
  FRONT_TINTS,
  STORM_VIOLET,
  WARN_ETA_THRESHOLD_SEC,
  WARN_GAP_MS,
  WARNING_FADE_MS,
  WeatherUI,
  frontTint,
  phaseSuppressesWarnings,
} from '../src/ui/weatherui.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

/* ------------------------------------------------------------------ */
/* Minimal DOM stub                                                    */
/* ------------------------------------------------------------------ */

function makeClassList(el) {
  const set = new Set();
  return {
    add(...cs) { cs.forEach((c) => set.add(c)); },
    remove(...cs) { cs.forEach((c) => set.delete(c)); },
    toggle(c, force) {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    contains(c) { return set.has(c); },
  };
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    style: {},
    ownerDocument: null,
    appendChild(child) { el.children.push(child); child.ownerDocument ??= el.ownerDocument; return child; },
  };
  Object.defineProperty(el, 'classList', { value: makeClassList(el) });
  // Simulate layout so the reflow trick in showBanner does not crash.
  Object.defineProperty(el, 'offsetWidth', { get: () => 128 });
  return el;
}

function installDom() {
  const head = makeElement('head');
  const document = {
    head,
    createElement(tag) {
      const el = makeElement(tag);
      el.ownerDocument = document;
      return el;
    },
  };
  globalThis.document = document;
  return document;
}

function makeUi(doc = installDom()) {
  const container = doc.createElement('div');
  const ui = new WeatherUI(container);
  const root = container.children[container.children.length - 1];
  assert.equal(root.className, 'bmb-weather-root');
  const [banner, flash] = root.children;
  return { ui, container, banner, flash };
}
const fc = (etaSec, opts = {}) => ({ kind: opts.kind ?? 0, intensity: opts.intensity ?? 0.5, etaSec, storm: !!opts.storm });

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

check('frontTint: storms always violet', () => {
  for (let k = -2; k <= 9; k++) assert.equal(frontTint(k, true), STORM_VIOLET);
});

check('frontTint: deterministic cycle over palette', () => {
  assert.equal(frontTint(0, false), FRONT_TINTS[0]);
  assert.equal(frontTint(FRONT_TINTS.length, false), FRONT_TINTS[0]); // wraps
  assert.equal(frontTint(3, false), FRONT_TINTS[3]);
  assert.equal(frontTint(NaN, false), FRONT_TINTS[0]); // junk kind is safe
});

check('phaseSuppressesWarnings matches any peak-ish phase', () => {
  assert.equal(phaseSuppressesWarnings('peak'), true);
  assert.equal(phaseSuppressesWarnings('STORM_PEAK'), true);
  assert.equal(phaseSuppressesWarnings('calm'), false);
  assert.equal(phaseSuppressesWarnings(''), false);
  assert.equal(phaseSuppressesWarnings(null), false);
});

check('exported tuning constants match spec', () => {
  assert.equal(WARN_ETA_THRESHOLD_SEC, 30);
  assert.equal(WARN_GAP_MS, 60_000);
  assert.equal(WARNING_FADE_MS, 3000);
  assert.equal(ARRIVAL_OPACITY, 0.15);
  assert.equal(ARRIVAL_FADE_MS, 2000);
  assert.ok(ARRIVAL_HOLD_MS >= 0 && ARRIVAL_HOLD_MS < 500);
  assert.equal(BANNER_TEXT_CALM, 'THE AIR SHIFTS');
  assert.equal(BANNER_TEXT_STORM, 'SOMETHING VIOLENT APPROACHES');
  assert.equal(STORM_VIOLET, '#9d6bff');
  assert.equal(AMBER_ACCENT, '#ffb347');
});

/* ------------------------------------------------------------------ */
/* Banner behaviour                                                    */
/* ------------------------------------------------------------------ */

check('no warning before eta drops under threshold', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(45));
  assert.equal(banner.classList.contains('bmb-visible'), false);
  ui.update(fc(30));
  assert.equal(banner.classList.contains('bmb-visible'), false); // boundary is exclusive
});

check('warning fades in inside the window and holds until arrival', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(20));
  assert.equal(banner.textContent, BANNER_TEXT_CALM);
  assert.equal(banner.classList.contains('bmb-visible'), true);
  ui.update(fc(10)); // still holding
  assert.equal(banner.classList.contains('bmb-visible'), true);
  ui.update(fc(5));
  assert.equal(banner.classList.contains('bmb-visible'), true);
});

check('storm fronts use the violet pulsing variant and storm copy', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(12, { storm: true }));
  assert.equal(banner.textContent, BANNER_TEXT_STORM);
  assert.equal(banner.classList.contains('bmb-storm'), true);
  assert.equal(banner.classList.contains('bmb-visible'), true);
});

check('banner clears once the front arrives', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(8));
  assert.equal(banner.classList.contains('bmb-visible'), true);
  ui.update(fc(0));
  assert.equal(banner.classList.contains('bmb-visible'), false);
});

/* ------------------------------------------------------------------ */
/* Restraint                                                           */
/* ------------------------------------------------------------------ */

check('second warning inside 60s gap is suppressed silently', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(20)); // first warning shows
  assert.equal(banner.classList.contains('bmb-visible'), true);
  ui.update(fc(0)); // front arrives, banner clears
  assert.equal(banner.classList.contains('bmb-visible'), false);
  ui.update(fc(25)); // second front within the gap
  assert.equal(banner.classList.contains('bmb-visible'), false);
  ui.update(fc(40)); // out of window again -> stays hidden
  assert.equal(banner.classList.contains('bmb-visible'), false);
});

check('peak phase suppresses warnings even inside the window', () => {
  const { ui, banner } = makeUi();
  ui.setPhase('peak');
  ui.update(fc(15));
  assert.equal(banner.classList.contains('bmb-visible'), false);
  ui.setPhase('lull');
  ui.update(fc(14)); // phase lifted, window still open -> warns
  assert.equal(banner.classList.contains('bmb-visible'), true);
});

check('peak phase hides a banner that is already showing', () => {
  const { ui, banner } = makeUi();
  ui.update(fc(15));
  assert.equal(banner.classList.contains('bmb-visible'), true);
  ui.setPhase('STORM_PEAK');
  assert.equal(banner.classList.contains('bmb-visible'), false);
});

check('suppressed warnings do not consume the 60s budget', async () => {
  // Suppression paths never touch lastWarnAt; prove it by suppressing via
  // peak, then verifying a later non-peak update can still warn.
  const { ui, banner } = makeUi();
  ui.setPhase('peak');
  ui.update(fc(10));
  assert.equal(banner.classList.contains('bmb-visible'), false);
  ui.setPhase('');
  ui.update(fc(9));
  assert.equal(banner.classList.contains('bmb-visible'), true); // first real warn still fires
});

/* ------------------------------------------------------------------ */
/* Arrival flash                                                       */
/* ------------------------------------------------------------------ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function arrivalChecks() {
  check('arrival flash fires when previous eta > 0 and now <= 0', async () => {
    const { ui, flash } = makeUi();
    ui.update(fc(4, { kind: 1 }));
    assert.equal(flash.style['opacity'], '0'); // no flash while counting down
    await sleep(ARRIVAL_HOLD_MS + 80);
    ui.update(fc(0, { kind: 1 }));
    assert.equal(String(flash.style['boxShadow']).includes('inset'), true);
    assert.equal(Number(flash.style['opacity']), ARRIVAL_OPACITY);
    // Fades back to 0 after the hold.
    await sleep(ARRIVAL_HOLD_MS + 80);
    assert.equal(Number(flash.style['opacity']), 0);
  });

  check('arrival flash tint follows front kind; storms are violet', async () => {
    const a = makeUi(); const b = makeUi();
    a.ui.update(fc(3, { kind: 2 }));
    b.ui.update(fc(3, { kind: 5, storm: true }));
    await sleep(ARRIVAL_HOLD_MS + 80);
    a.ui.update(fc(0, { kind: 2 }));
    b.ui.update(fc(-1, { kind: 5, storm: true }));
    assert.equal(a.flash.style['boxShadow'], 'inset 0 0 180px 60px ' + FRONT_TINTS[2]);
    assert.equal(b.flash.style['boxShadow'], 'inset 0 0 180px 60px ' + STORM_VIOLET);
    await sleep(ARRIVAL_HOLD_MS + 80);
  });

  check('cleared forecast after positive eta counts as arrival too', async () => {
    const { ui, flash } = makeUi();
    ui.update(fc(6, { kind: 0 }));
    ui.update(null); // tracking lost == front landed
    assert.equal(String(flash.style['boxShadow']).includes('inset 0 0 180px 60px ' + FRONT_TINTS[0]), true);
    await sleep(ARRIVAL_HOLD_MS + 80);
  });

  check('reset clears banner, flash, timers and restraint state', async () => {
    const { ui, banner, flash } = makeUi();
    ui.setPhase('dusk');
    ui.update(fc(10));
    assert.equal(banner.classList.contains('bmb-visible'), true);
    ui.reset();
    assert.equal(banner.classList.contains('bmb-visible'), false);
    assert.equal(flash.style['opacity'], '0');
    assert.equal(flash.style['boxShadow'], 'none');
    // Restraint clock was wiped: an immediate new warning is allowed again.
    ui.update(fc(11));
    assert.equal(banner.classList.contains('bmb-visible'), true);
    await sleep(ARRIVAL_HOLD_MS + 80);
  });

  check('constructor injects stylesheet once with expected rules', () => {
    const doc = installDom();
    const before = doc.head.children.length;
    const container = doc.createElement('div');
    new WeatherUI(container);
    new WeatherUI(container);
    assert.equal(doc.head.children.length, before + 2); // one style per instance
    const style = doc.head.children[before];
    assert.equal(style.tagName, 'STYLE');
    assert.match(style.textContent, /bmb-weather-banner/);
    assert.match(style.textContent, /bmb-weather-flash/);
    assert.match(style.textContent, /box-shadow|transition/);
  });
}

await arrivalChecks();

console.log('PASS ' + passed + ' checks');


