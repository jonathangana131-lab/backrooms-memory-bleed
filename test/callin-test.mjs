/**
 * Call-in radio show tests (F86) - pure Node, no audio device.
 * Verifies the F86 loadout-grounding acceptance proof:
 *   1. descriptor injection + validation - malformed loadouts fail loud
 *      (empty flashlightModel, unknown battery band, negative/fractional
 *      notesRead)
 *   2. silence safety - null descriptor means the show never airs a call
 *      and silentByDesign reports true
 *   3. loadout grounding - across 300 generated calls, 100% of structured
 *      EquipmentClaims match the injected descriptor; battery segments come
 *      only from the real band's pool; camcorder-possessing lines never air
 *      on camera-less loadouts and vice versa; flashlight model is
 *      interpolated verbatim; unvisited district decoys are never named;
 *      no substitution placeholder leaks into aired text
 *   4. caller cadence - runs on the injected session clock: first call in
 *      the scheduled window, inter-call gaps inside [CALL_GAP_MIN_SEC,
 *      CALL_GAP_MAX_SEC], clock-jump catch-up capped at MAX_CALLS_PER_TICK,
 *      junk clocks (NaN, backward) safe
 *   5. dedup window - identical text never repeats within DEDUP_WINDOW
 *      consecutive segments; recentWindow() tracks the window
 *   6. determinism - same seed + loadout + clock feed replays the broadcast
 *      byte-identical; a different seed diverges
 *
 * Run: node test/callin-test.mjs  (prints CALLIN ALL PASS, exits 0)
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
  CallInShow, notesTier, CALLERS,
  FLASHLIGHT_LINES, BATTERY_LINES, CAMCORDER_YES_LINES, CAMCORDER_NO_LINES,
  NOTES_COUNT_LINES, NOTES_TIER_LINES, DISTRICT_LINES, DISTRICT_PAIR_LINES,
  FIRST_CALL_DELAY_SEC, CALL_GAP_MIN_SEC, CALL_GAP_MAX_SEC,
  MAX_CALLS_PER_TICK, DEDUP_WINDOW,
} = await import('../src/audio/callin.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Manual session clock driven by the test. */
function makeClock(start = 0) {
  let t = start;
  return {
    nowSec: () => t,
    step: (d) => { t += d; },
    jump: (v) => { t = v; },
  };
}

/** Run a show forward, returning {calls, segments} accumulated. */
function runShow(show, clock, secondsPerTick, ticks) {
  const calls = [];
  for (let i = 0; i < ticks; i++) {
    clock.step(secondsPerTick);
    for (const c of show.tick()) calls.push(c);
  }
  const segments = [];
  const segOwners = [];
  for (const c of calls) {
    for (const s of c.segments) { segments.push(s); segOwners.push(c); }
  }
  return { calls, segments, segOwners };
}

const LOADOUTS = [
  { flashlightModel: 'Ranger 2AA', batteryPctBand: 'full', hasCamcorder: true, notesRead: 42, districtsVisited: ['ROSEWATER', 'ASHFORD'] },
  { flashlightModel: 'Minimag LED', batteryPctBand: 'dying', hasCamcorder: false, notesRead: 0, districtsVisited: [] },
  { flashlightModel: 'Anglehead M900', batteryPctBand: 'fading', hasCamcorder: true, notesRead: 7, districtsVisited: ['GRAYDOCK'] },
  { flashlightModel: 'Lantern K55', batteryPctBand: 'steady', hasCamcorder: false, notesRead: 120, districtsVisited: ['TERMINUS', 'ASHFORD', 'ROSEWATER'] },
];

// --- 1. descriptor injection + validation ------------------------------------
console.log('[validation]');
{
  let threw = '';
  try { new CallInShow({ ...LOADOUTS[0], flashlightModel: '' }, 7, makeClock()); }
  catch (e) { threw = String(e); }
  ok(threw.includes('flashlightModel must be non-empty'), `empty flashlightModel fails loud (${threw.slice(0, 50)})`);

  threw = '';
  try { new CallInShow({ ...LOADOUTS[0], batteryPctBand: 'overcharged' }, 7, makeClock()); }
  catch (e) { threw = String(e); }
  ok(threw.includes('unknown battery band'), `unknown band fails loud (${threw.slice(0, 50)})`);

  threw = '';
  try { new CallInShow({ ...LOADOUTS[0], notesRead: -3 }, 7, makeClock()); }
  catch (e) { threw = String(e); }
  ok(threw.includes('notesRead'), `negative notesRead fails loud (${threw.slice(0, 50)})`);

  threw = '';
  try { new CallInShow({ ...LOADOUTS[0], notesRead: 2.5 }, 7, makeClock()); }
  catch (e) { threw = String(e); }
  ok(threw.includes('notesRead'), `fractional notesRead fails loud (${threw.slice(0, 50)})`);

  ok(notesTier(0) === 'barely any' && notesTier(5) === 'a handful of'
    && notesTier(20) === 'a stack of' && notesTier(50) === 'an archive of',
    'notesTier buckets follow the real count');
}

// --- 2. silence safety --------------------------------------------------------
console.log('[silence]');
{
  const clock = makeClock();
  const show = new CallInShow(null, 99, clock);
  ok(show.silentByDesign === true, 'null descriptor flags silentByDesign');
  let aired = 0;
  for (let i = 0; i < 200; i++) { clock.step(60); aired += show.tick().length; }
  ok(aired === 0, `no descriptor -> show stays silent over 200 ticks (aired ${aired})`);
}

// --- 3. loadout grounding over 300 generated calls -----------------------------
console.log('[grounding]');
{
  const FIELDS = ['flashlightModel', 'batteryPctBand', 'hasCamcorder', 'notesRead', 'districtsVisited'];
  let totalCalls = 0;
  let totalClaims = 0;
  let mismatches = [];
  let placeholderLeaks = 0;
  let camcorderContradictions = 0;
  let batteryPoolViolations = 0;
  let decoyMentions = 0;
  const DECOYS = ['GRAYDOCK', 'TERMINUS'];

  let seed = 1000;
  while (totalCalls < 300) {
    const ld = LOADOUTS[seed % LOADOUTS.length];
    const decoyFree = ld.districtsVisited.filter((d) => !DECOYS.includes(d));
    // Guarantee decoy districts stay unvisited for this loadout.
    const probe = { ...ld, districtsVisited: decoyFree };
    const clock = makeClock();
    const show = new CallInShow(probe, seed, clock);
    const { calls } = runShow(show, clock, 400, 8); // coarse steps, cap-bounded
    for (const c of calls) {
      totalCalls++;
      if (!CALLERS.some((k) => k.id === c.callerId)) mismatches.push(`caller id ${c.callerId}`);
      for (const s of c.segments) {
        for (const ph of ['%M', '%N', '%D', '%A', '%B']) {
          if (s.text.includes(ph)) placeholderLeaks++;
        }
        for (const d of DECOYS) if (s.text.includes(d)) decoyMentions++;
        for (const claim of s.claims) {
          totalClaims++;
          if (!FIELDS.includes(claim.field)) { mismatches.push(`unknown field ${claim.field}`); continue; }
          const real = probe[claim.field];
          let good = false;
          if (claim.field === 'districtsVisited') good = Array.isArray(real) && real.includes(claim.value);
          else good = String(real) === claim.value;
          if (!good) mismatches.push(`${claim.field}=${claim.value} vs ${JSON.stringify(real)}`);
        }
        // Pool containment checks against the REAL descriptor fields.
        if (BATTERY_LINES[probe.batteryPctBand].includes(s.text) === false
          && Object.values(BATTERY_LINES).flat().includes(s.text)
          && s.claims.some((k) => k.field === 'batteryPctBand')) batteryPoolViolations++;
        if (!probe.hasCamcorder && CAMCORDER_YES_LINES.includes(s.text)) camcorderContradictions++;
        if (probe.hasCamcorder && CAMCORDER_NO_LINES.includes(s.text)) camcorderContradictions++;
      }
    }
    seed++;
  }

  ok(totalCalls >= 300, `generated ${totalCalls} calls (>= 300)`);
  ok(totalClaims > 0, `structured claims present (${totalClaims})`);
  ok(mismatches.length === 0, `100% of equipment claims match descriptor (0/${totalClaims} bad${mismatches.length ? ': ' + mismatches[0] : ''})`);
  ok(placeholderLeaks === 0, `no %M/%N/%D/%A/%B placeholder leaks into aired text`);
  ok(camcorderContradictions === 0, `camcorder pool matches real hasCamcorder flag`);
  ok(batteryPoolViolations === 0, `battery lines come only from the real band's pool`);
  ok(decoyMentions === 0, `unvisited district decoys never named`);

  // Verbatim flashlight interpolation: every FLASHLIGHT_LINES-derived text
  // contains the exact model string of its loadout.
  const ld = LOADOUTS[0];
  const clock = makeClock();
  const show = new CallInShow(ld, 4242, clock);
  const { segments } = runShow(show, clock, 160, 4000 / 160 | 0 || 30);
  const flashTexts = segments.filter((s) => FLASHLIGHT_LINES.some((l) => l.replace('%M', ld.flashlightModel) === s.text));
  ok(flashTexts.length > 0 && flashTexts.every((s) => s.text.includes(ld.flashlightModel)),
    `flashlight model interpolated verbatim (${flashTexts.length} hits)`);
  ok(flashTexts.every((s) => s.claims.length === 1 && s.claims[0].field === 'flashlightModel'
    && s.claims[0].value === ld.flashlightModel), 'flashlight segments carry exactly one matching claim');

  // Numeric + tiered notes claims both assert the real count.
  const notesSegs = segments.filter((s) => s.claims.some((k) => k.field === 'notesRead'));
  ok(notesSegs.length > 0 && notesSegs.every((s) => s.claims.every((k) => k.value === String(ld.notesRead))),
    `notes claims assert real count ${ld.notesRead}`);
  const numericNotes = notesSegs.filter((s) => NOTES_COUNT_LINES.some((l) => l.replace('%N', String(ld.notesRead)) === s.text));
  ok(numericNotes.every((s) => s.text.includes(String(ld.notesRead))),
    'numeric notes lines interpolate the exact count');
}

// --- 4. caller cadence ---------------------------------------------------------
console.log('[cadence]');
{
  const clock = makeClock();
  const show = new CallInShow(LOADOUTS[0], 77, clock);
  ok(show.tick().length === 0, 'first tick schedules without airing');

  // Fine-grained 1s stepping: find first air time.
  let firstT = -1;
  for (let t = 0; t <= FIRST_CALL_DELAY_SEC + 5; t++) {
    clock.step(1);
    const out = show.tick();
    if (out.length > 0) { firstT = out[0].tSec; break; }
  }
  ok(firstT > 0 && firstT <= FIRST_CALL_DELAY_SEC + 1,
    `first call airs within the scheduled window (t=${firstT}s)`);

  // Continue fine-grained; collect air times and check gaps.
  const times = [firstT];
  for (let t = 0; t < 2000; t++) {
    clock.step(1);
    for (const c of show.tick()) times.push(c.tSec);
  }
  let gapsOk = true;
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g < CALL_GAP_MIN_SEC - 1 || g > CALL_GAP_MAX_SEC) gapsOk = false;
  }
  ok(times.length > 5 && gapsOk,
    `inter-call gaps inside [${CALL_GAP_MIN_SEC}, ${CALL_GAP_MAX_SEC}] (${times.length} calls)`);

  // Clock-jump catch-up: cap respected.
  const clock2 = makeClock();
  const show2 = new CallInShow(LOADOUTS[0], 77, clock2);
  clock2.step(FIRST_CALL_DELAY_SEC + 1);
  show2.tick(); // schedule primed
  clock2.jump(100000);
  const burst = show2.tick().length;
  ok(burst === MAX_CALLS_PER_TICK, `clock jump airs exactly the per-tick cap (${burst})`);
  const afterJump = show2.tick().length;
  ok(afterJump === 0, `schedule fast-forwarded past the jump (next tick airs ${afterJump})`);

  // Junk clocks: NaN and backward movement air nothing, never throw.
  const clock3 = makeClock();
  const show3 = new CallInShow(LOADOUTS[0], 78, clock3);
  clock3.step(FIRST_CALL_DELAY_SEC + 1);
  show3.tick();
  clock3.jump(NaN);
  ok(show3.tick().length === 0, 'NaN clock reading airs nothing');
  clock3.jump(10000);
  show3.tick(); // reschedule from a healthy reading
  clock3.jump(5000);
  ok(show3.tick().length === 0, 'backward clock airs nothing and leaves schedule intact');
}

// --- 5. dedup window ------------------------------------------------------------
console.log('[dedup]');
{
  const clock = makeClock();
  const show = new CallInShow({ ...LOADOUTS[3], districtsVisited: ['ROSEWATER'] }, 555, clock);
  const { segments } = runShow(show, clock, 200, 250);
  ok(segments.length > 100, `long stream generated (${segments.length} segments)`);
  let dup = 0;
  for (let i = 1; i < segments.length; i++) {
    for (let j = Math.max(0, i - DEDUP_WINDOW + 1); j < i; j++) {
      if (segments[j].text === segments[i].text) dup++;
    }
  }
  ok(dup === 0, `no text repeats within DEDUP_WINDOW=${DEDUP_WINDOW} (${dup} violations)`);
  ok(show.recentWindow().length <= DEDUP_WINDOW && show.recentWindow().every((t) => typeof t === 'string'),
    'recentWindow() tracks the window bounded');
}

// --- 6. determinism ----------------------------------------------------------------
console.log('[determinism]');
{
  const feed = () => {
    const clock = makeClock();
    const show = new CallInShow(LOADOUTS[2], 31337, clock);
    return JSON.stringify(runShow(show, clock, 90, 600).calls);
  };
  const a = feed();
  const b = feed();
  const clockC = makeClock();
  const c = JSON.stringify(runShow(new CallInShow(LOADOUTS[2], 31338, clockC), clockC, 90, 600).calls);
  ok(a === b, 'same seed + loadout + clock feed replays byte-identical');
  ok(a !== c, 'different seed diverges');
}

console.log(failures === 0 ? `CALLIN ALL PASS (${check} checks)` : `CALLIN FAILURES: ${failures}/${check}`);
process.exit(failures === 0 ? 0 : 1);
