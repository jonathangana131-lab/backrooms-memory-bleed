/**
 * Functional verification of the F97 bureaucratic achievements
 * (src/ui/formtoasts.ts): deterministic form numbers from the seeded id
 * hash, APPROVED/DENIED routing including the ironic denial table, the
 * slide-in/thunk/hold/file-away stamp phase machine, and a vertical
 * queue that never drops burst events.
 *
 * Standalone in Node; the TS module is bundled with esbuild (found in
 * the pnpm store, as in tracker-test.mjs) so its '../core/rng' import
 * resolves.
 *
 *   node test/formtoasts-test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const require_ = createRequire(import.meta.url);
// esbuild is a transitive dep of vite; hoisted installs expose it directly,
// pnpm-store layouts hide it under node_modules/.pnpm.
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ' :: ' + (e instanceof Error ? e.message : String(e)));
  }
}

const esbuild = loadEsbuild();
const SRC = process.cwd() + '/src/ui/formtoasts.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.formtoasts-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  FORM_SLIDE_MS,
  FORM_THUNK_MS,
  FORM_HOLD_MS,
  FORM_FILE_MS,
  FORM_QUEUE_VISIBLE,
  FORM_IRONIC_DENIALS,
  routeStamp,
  formNumber,
  formHeading,
  FormToasts,
} = await import('./.formtoasts-build.mjs');

/* ------------------------------------------------------------------ */
/* Stub document/container pair matching the sibling UI test idiom.    */
/* ------------------------------------------------------------------ */

function stubDoc() {
  const created = [];
  const doc = {
    createElement(tag) {
      const el = {
        tag,
        className: '',
        textContent: '',
        removed: false,
        styleProps: {},
        children: [],
        style: {
          setProperty(name, value) { el.styleProps[name] = String(value); },
        },
        appendChild(child) { el.children.push(child); return child; },
        remove() { el.removed = true; },
      };
      created.push(el);
      return el;
    },
    head: { appendChild(child) { return child; } },
  };
  const container = doc.createElement('div');
  return { doc, created, container };
}

/** Pump update(dt) until every pushed record has filed or budget ends. */
function drainAll(forms, filedTarget, dt = 60) {
  let filed = 0;
  const budget = Math.ceil(filedTarget / FORM_QUEUE_VISIBLE) *
    (FORM_SLIDE_MS + FORM_THUNK_MS + FORM_HOLD_MS + FORM_FILE_MS + dt) + 10_000;
  for (let t = 0; t < budget && forms.filedCount < filedTarget; t += dt) {
    filed += forms.update(dt);
  }
  return filed;
}

/* ------------------------------------------------------------------ */
/* Deterministic form numbers                                          */
/* ------------------------------------------------------------------ */

check('form numbers are stable per id and match the <3 digits>-<letter> shape', () => {
  for (const id of ['FIRST_STEPS', 'NOTE_HOARDER', 'PERMIT_TO_LEAVE', 'x']) {
    assert.equal(formNumber(id), formNumber(id), 'unstable for ' + id);
    assert.match(formNumber(id), /^\d{3}-[A-Z]$/, 'shape for ' + id);
  }
});

check('different ids produce distinct form number space coverage', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(formNumber('EVENT_' + i));
  assert.ok(seen.size > 30, 'too few distinct numbers: ' + seen.size);
});

check('heading prints as FORM <n>-<L> — REQUEST: <request>', () => {
  const h = formHeading('FIRST_STEPS', 'RECOGNITION OF MOVEMENT');
  assert.equal(h, 'FORM ' + formNumber('FIRST_STEPS') + ' \u2014 REQUEST: RECOGNITION OF MOVEMENT');
  assert.match(h, /^FORM \d{3}-[A-Z] \u2014 REQUEST: /);
});

/* ------------------------------------------------------------------ */
/* APPROVED / DENIED routing                                           */
/* ------------------------------------------------------------------ */

check('ironic requests are always DENIED', () => {
  assert.ok(FORM_IRONIC_DENIALS.length >= 2, 'irony table is populated');
  for (const id of FORM_IRONIC_DENIALS) {
    assert.equal(routeStamp(id), 'DENIED', 'ironic case approved: ' + id);
    assert.equal(routeStamp(id), 'DENIED', 'routing unstable for ' + id);
  }
});

check('ordinary ids route deterministically by hash', () => {
  for (let i = 0; i < 20; i++) {
    const id = 'PLAIN_' + i;
    assert.equal(routeStamp(id), routeStamp(id), 'unstable for ' + id);
  }
  // At least one approval exists among ordinary ids.
  const anyApproved = Array.from({ length: 20 }, (_, i) => routeStamp('PLAIN_' + i))
    .includes('APPROVED');
  assert.ok(anyApproved, 'no ordinary id ever approves');
});

check('pushed records carry the routed stamp and printed heading', () => {
  const forms = new FormToasts({});
  const rec = forms.push({ id: 'PERMIT_TO_LEAVE', request: 'PERMISSION TO LEAVE' });
  assert.equal(rec.stamp, 'DENIED');
  assert.equal(rec.heading, formHeading('PERMIT_TO_LEAVE', 'PERMISSION TO LEAVE'));
  assert.equal(rec.filed, false);
});

/* ------------------------------------------------------------------ */
/* Stamp phase machine                                                 */
/* ------------------------------------------------------------------ */

check('phase machine walks slide-in -> thunk -> hold -> file-away -> filed', () => {
  const forms = new FormToasts({});
  const rec = forms.push({ id: 'PHASE_TEST', request: 'STAMP LIFECYCLE REVIEW' });
  assert.equal(rec.phase, 'slide-in');
  assert.equal(rec.elapsedMs, 0);

  forms.update(FORM_SLIDE_MS - 1);
  assert.equal(rec.phase, 'slide-in', 'still sliding just before the boundary');

  forms.update(1);
  assert.equal(rec.phase, 'thunk', 'thunk starts exactly at the slide boundary');
  assert.equal(rec.elapsedMs, 0);

  forms.update(FORM_THUNK_MS);
  assert.equal(rec.phase, 'hold', 'hold follows the thunk');

  forms.update(FORM_HOLD_MS);
  assert.equal(rec.phase, 'file-away', 'filing starts after the hold');

  assert.equal(forms.update(FORM_FILE_MS - 1), 0, 'not counted until fully filed');
  assert.equal(rec.filed, false);
  assert.equal(forms.update(1), 1, 'the tick that completes filing reports it');
  assert.equal(rec.filed, true);
  assert.equal(forms.activeForms.length, 0, 'tray empties after filing');
});

check('update ignores junk deltas', () => {
  const forms = new FormToasts({});
  const rec = forms.push({ id: 'JUNK_DT', request: 'TEMPORAL ACCOUNTING AUDIT' });
  assert.equal(forms.update(NaN), 0);
  assert.equal(forms.update(-4), 0);
  assert.equal(forms.update(Infinity), 0);
  assert.equal(rec.phase, 'slide-in', 'junk frames do not advance the clock');
});

/* ------------------------------------------------------------------ */
/* Burst queue: nothing dropped                                        */
/* ------------------------------------------------------------------ */

check('a burst of 25 events queues instead of dropping', () => {
  const { doc, container } = stubDoc();
  const forms = new FormToasts({ document: doc, container });
  for (let i = 0; i < 25; i++) {
    forms.push({ id: 'BURST_' + i, request: 'RETROSPECTIVE FILING OF EVENT ' + i });
  }
  assert.equal(forms.pushedCount, 25, 'every event recorded');
  assert.ok(forms.activeForms.length <= FORM_QUEUE_VISIBLE, 'visible tray capped');
  assert.equal(forms.queuedCount, 25 - forms.activeForms.length, 'overflow waits below');
  assert.equal(forms.droppedAny, false);

  drainAll(forms, 25);
  assert.equal(forms.filedCount, 25, 'all bursts eventually filed');
  assert.equal(forms.droppedAny, false, 'invariant held through the whole drain');
  assert.equal(forms.queuedCount, 0, 'queue fully drained');
});

check('forms mount FIFO: earliest events file away first', () => {
  const filedOrder = [];
  const forms = new FormToasts({ onFiled: (rec) => filedOrder.push(rec.request) });
  for (let i = 0; i < 8; i++) {
    forms.push({ id: 'FIFO_' + i, request: 'SEQ-' + i });
  }
  drainAll(forms, 8);
  assert.equal(filedOrder.length, 8);
  for (let i = 0; i < 8; i++) {
    assert.equal(filedOrder[i], 'SEQ-' + i, 'out of order at slot ' + i);
  }
});

check('freed tray slots backfill from the queue mid-burst', () => {
  const { doc, container } = stubDoc();
  const forms = new FormToasts({ document: doc, container });
  for (let i = 0; i < FORM_QUEUE_VISIBLE + 2; i++) {
    forms.push({ id: 'BACKFILL_' + i, request: 'R' + i });
  }
  assert.equal(forms.activeForms.length, FORM_QUEUE_VISIBLE);
  // Pump exactly past the first filing tick: the freed slot must pull
  // BACKFILL_4 up immediately.
  const cycle = FORM_SLIDE_MS + FORM_THUNK_MS + FORM_HOLD_MS + FORM_FILE_MS;
  let filed = 0;
  for (let t = 0; t < cycle + 500 && filed === 0; t += 40) {
    filed = forms.update(40);
  }
  assert.equal(filed, 1, 'first wave files');
  assert.equal(forms.activeForms.length, FORM_QUEUE_VISIBLE, 'slot refilled from queue');
  assert.ok(forms.activeForms.some((r) => r.id === 'BACKFILL_4'), 'next queued record mounted');
});

/* ------------------------------------------------------------------ */
/* DOM presentation                                                    */
/* ------------------------------------------------------------------ */

check('DOM layer mounts stylesheet + vertical queue root', () => {
  const { doc, created, container } = stubDoc();
  new FormToasts({ document: doc, container });
  const styleEl = created.find((c) => c.className === 'bmb-formq-style');
  const rootEl = created.find((c) => c.className === 'bmb-formq');
  assert.ok(styleEl && rootEl, 'style + root created');
  assert.match(String(styleEl.textContent), /[.]bmb-formq [{]/);
  assert.match(String(styleEl.textContent), /flex-direction: column/, 'vertical stack');
  assert.match(String(styleEl.textContent), /monospace/);
  assert.ok(container.children.includes(rootEl));
});

check('mounted forms render heading + stamp, colored by outcome', () => {
  const { doc, created, container } = stubDoc();
  const forms = new FormToasts({ document: doc, container });
  forms.push({ id: 'DOM_APPROVE_1', request: 'CERTIFICATION OF WANDERING' });
  forms.push({ id: 'PERMIT_TO_LEAVE', request: 'PERMISSION TO LEAVE' });
  const rootEl = created.find((c) => c.className === 'bmb-formq');
  const rows = rootEl.children.filter((c) => c.className.startsWith('bmb-form '));
  assert.equal(rows.length, 2);
  const approvedRow = rows.find((r) => r.className.includes('approved'));
  const deniedRow = rows.find((r) => r.className.includes('denied'));
  assert.ok(approvedRow && deniedRow, 'both outcomes rendered');
  assert.match(approvedRow.textContent, /^FORM \d{3}-[A-Z] \u2014 REQUEST: CERTIFICATION OF WANDERING\n\[ APPROVED \]$/);
  assert.match(deniedRow.textContent, /\[ DENIED \]$/);
  assert.ok(deniedRow.textContent.includes(formHeading('PERMIT_TO_LEAVE', 'PERMISSION TO LEAVE')));
});

check('headless mode runs model-only without a document', () => {
  const forms = new FormToasts({});
  const rec = forms.push({ id: 'HEADLESS_1', request: 'RECOGNITION OF ABSENCE' });
  assert.equal(rec.stamp, 'APPROVED');
  assert.doesNotThrow(() => { forms.update(16); forms.dispose(); });
  assert.equal(forms.pushedCount, 1);
});

console.log('passed:', passed);
rmSync(BUILT, { force: true });
process.exit(failures === 0 ? 0 : 1);
