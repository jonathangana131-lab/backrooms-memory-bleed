/**
 * Director v2 fear-learning tests (F90) - pure Node, no renderer.
 * Verifies the F90 acceptance proof:
 *   1. uniform cold start - every known tag sits at exactly 0.5 before any
 *      event, and untouched tags stay exactly 0.5 while evidence lands elsewhere
 *   2. telemetry-to-pacing - after 100+ events the bias ordering matches the
 *      event-history weighting (pause-heavy tag > mixed tag > skip-heavy tag),
 *      with a hand-computed EMA (alpha = 0.2) matched exactly on a short feed
 *   3. decay proven - idle clock past DECAY_GRACE_SEC drifts affinities
 *      monotonically toward uniform 0.5; small in-grace advances are no-ops;
 *      many small ticks land identically to one large tick
 *   4. determinism - identical event/clock feeds replay byte-identical
 *      serialized state across separate model instances
 *   5. serialize round-trip - restore continues where the source left off,
 *      double round-trip is a fixpoint, malformed saves fail loud
 *
 * Run: node test/directorlearning-test.mjs  (prints DIRECTORLEARNING ALL PASS, exits 0)
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
  DirectorLearning,
  ALPHA, DECAY_GRACE_SEC, DECAY_TAU_SEC, KIND_SIGNAL,
} = await import('../src/director/learning.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Scare-response event factory. */
const ev = (kind, contextTag, intensity = 1) => ({ kind, contextTag, intensity });

// ---------------------------------------------------------------------------
console.log('1. Uniform cold start is exact');
{
  const m = new DirectorLearning(['hum-corridor', 'chase-hall', 'whisper-room']);
  const bias = m.suggestPhaseBias();
  ok(Object.keys(bias).length === 3, 'all known tags present before any event');
  ok(
    Object.values(bias).every((w) => w === 0.5),
    `every cold-start weight is exactly 0.5 (${JSON.stringify(bias)})`,
  );
  // Evidence on one tag leaves the others exactly uniform.
  m.record(ev('pause', 'hum-corridor', 1));
  const after = m.suggestPhaseBias();
  ok(after['chase-hall'] === 0.5 && after['whisper-room'] === 0.5,
    'untouched tags stay exactly 0.5');
  ok(after['hum-corridor'] === 0.5 + 0.2 * 0.5,
    'first pause moves its tag by exactly alpha*0.5 toward scary');
  // A tag first seen via an event registers at baseline for everyone else.
  m.record(ev('skip', 'brand-new-context', 1));
  ok(m.suggestPhaseBias()['whisper-room'] === 0.5,
    'late-seen contexts do not disturb existing baselines');
}

// ---------------------------------------------------------------------------
console.log('2. Telemetry-to-pacing ordering matches event history weighting');
{
  const m = new DirectorLearning();
  // A: confessed fear (pauses, high intensity). B: boredom (skips).
  // C: mild interest (lingers, mid intensity).
  for (let i = 0; i < 40; i++) {
    m.record(ev('pause', 'tag-fear', 1));
    m.record(ev('linger', 'tag-mixed', 0.5));
    m.record(ev('skip', 'tag-boring', 1));
  }
  for (let i = 0; i < 20; i++) {
    m.record(ev('hesitation', 'tag-fear', 0.9));
    m.record(ev('pause', 'tag-mixed', 0.4));
    m.record(ev('linger', 'tag-boring', 0.1));
  }
  ok(m.tags().length === 3, 'exactly three tags learned from 180 events');
  const bias = m.suggestPhaseBias();
  ok(bias['tag-fear'] > bias['tag-mixed'], `fear tag outranks mixed (${bias['tag-fear']} > ${bias['tag-mixed']})`);
  ok(bias['tag-mixed'] > bias['tag-boring'], `mixed outranks boring (${bias['tag-mixed']} > ${bias['tag-boring']})`);
  ok(bias['tag-fear'] > 0.8, `fear tag saturates high (${bias['tag-fear'].toFixed(3)})`);
  // Mild late lingers pull the boring tag partway back up, but it stays below
  // uniform while its history is dominated by skips.
  ok(bias['tag-boring'] < 0.55, `boring tag sags below uniform (${bias['tag-boring'].toFixed(3)})`);
  ok(Object.values(bias).every((w) => w >= 0 && w <= 1), 'every weight normalized 0..1');

  // Hand-computed EMA must match exactly on an arbitrary short feed.
  const m2 = new DirectorLearning();
  const feed = [
    ev('pause', 'x', 0.7), ev('skip', 'x', 0.4), ev('linger', 'x', 1),
    ev('hesitation', 'x', 0.25), ev('pause', 'x', 1), ev('skip', 'x', 0.9),
  ];
  let ema = 0;
  for (const e of feed) {
    m2.record(e);
    ema += ALPHA * (KIND_SIGNAL[e.kind] * Math.min(1, Math.max(0, e.intensity)) - ema);
  }
  ok(near(m2.suggestPhaseBias().x, 0.5 * (1 + ema), 1e-12),
    'six-event EMA matches hand computation exactly');
}

// ---------------------------------------------------------------------------
console.log('3. Decay toward uniform over long idle stretches');
{
  const m = new DirectorLearning();
  m.record(ev('pause', 'hot', 1));     // -> weight 0.6
  m.record(ev('skip', 'cold', 1));     // -> weight 0.4
  // In-grace advances change nothing.
  for (let t = 0; t < DECAY_GRACE_SEC; t += 30) m.advanceClock(30);
  ok(m.suggestPhaseBias().hot === 0.6 && m.suggestPhaseBias().cold === 0.4,
    `no decay inside grace window (${m.suggestPhaseBias().hot})`);
  // Past grace: hot decays down toward 0.5, cold decays up, monotonically.
  const trace = [{ hot: 0.6, cold: 0.4 }];
  for (let i = 0; i < 12; i++) {
    m.advanceClock(DECAY_TAU_SEC / 4);
    trace.push({ hot: m.suggestPhaseBias().hot, cold: m.suggestPhaseBias().cold });
  }
  let monotoneDown = true;
  let monotoneUp = true;
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].hot >= trace[i - 1].hot) monotoneDown = false;
    if (trace[i].cold <= trace[i - 1].cold) monotoneUp = false;
  }
  ok(monotoneDown && trace[trace.length - 1].hot < 0.51,
    `hot affinity decays monotonically toward 0.5 (final ${trace[trace.length - 1].hot.toFixed(4)})`);
  ok(monotoneUp && trace[trace.length - 1].cold > 0.49,
    `cold affinity recovers monotonically toward 0.5 (final ${trace[trace.length - 1].cold.toFixed(4)})`);
  ok(trace.every((s) => s.hot !== s.cold), 'decayed tags never cross mid-run');

  // Chunked decay equals one-shot decay of the same total excess.
  const chunked = new DirectorLearning();
  chunked.record(ev('pause', 't', 1));
  const oneshot = new DirectorLearning();
  oneshot.record(ev('pause', 't', 1));
  chunked.advanceClock(DECAY_GRACE_SEC);           // burn the grace window
  oneshot.advanceClock(DECAY_GRACE_SEC);
  for (let i = 0; i < 10; i++) chunked.advanceClock(24);
  oneshot.advanceClock(240);
  const c = JSON.parse(chunked.serialize()).tags.t;
  const o = JSON.parse(oneshot.serialize()).tags.t;
  ok(near(c, o, 1e-12),
    `ten 24s ticks decay identically to one 240s tick (${c} vs ${o})`);

  // Fresh evidence ends the idle stretch.
  chunked.record(ev('linger', 't', 0.5));
  chunked.advanceClock(10);
  ok(chunked.suggestPhaseBias().t > 0.5, 'recording resets the idle clock');
}

// ---------------------------------------------------------------------------
console.log('4. Determinism across identical feeds');
{
  const build = () => {
    const m = new DirectorLearning(['a', 'b']);
    for (let i = 0; i < 60; i++) {
      m.record(ev(i % 3 === 0 ? 'pause' : i % 3 === 1 ? 'hesitation' : 'skip', i % 2 ? 'a' : 'b', (i % 7) / 7));
      if (i % 5 === 0) m.advanceClock(i * 1.5);
    }
    return m.serialize();
  };
  ok(build() === build(), 'two independent models serialize byte-identically');
}

// ---------------------------------------------------------------------------
console.log('5. Serialize round-trip + fail-loud restores');
{
  const src = new DirectorLearning(['base']);
  src.record(ev('pause', 'learned', 0.8));
  src.record(ev('skip', 'base', 0.5));
  src.advanceClock(DECAY_GRACE_SEC + 50);
  const snap = src.serialize();

  const restored = DirectorLearning.deserialize(snap);
  ok(restored.suggestPhaseBias().learned === src.suggestPhaseBias().learned &&
    restored.suggestPhaseBias().base === src.suggestPhaseBias().base,
    'restored biases match source exactly');
  ok(restored.serialize() === snap, 'serialize(deserialize(x)) is a fixpoint');

  // Both continue identically under new evidence.
  const contSrc = DirectorLearning.deserialize(snap);
  const contDst = DirectorLearning.deserialize(snap);
  contSrc.record(ev('pause', 'learned', 1));
  contDst.record(ev('pause', 'learned', 1));
  contSrc.advanceClock(30);
  contDst.advanceClock(30);
  ok(contSrc.serialize() === contDst.serialize(),
    'restored and original continue identically');

  // Malformed payloads fail loud without touching the target model.
  const junk = [
    'not json at all{',
    JSON.stringify({ v: 999, tags: {}, idleSec: 0 }),
    JSON.stringify({ v: 1, idleSec: 0 }),
    JSON.stringify({ v: 1, tags: [], idleSec: 0 }),
    JSON.stringify({ v: 1, tags: { x: 'high' }, idleSec: 0 }),
    JSON.stringify({ v: 1, tags: { x: 7 }, idleSec: 0 }),
    JSON.stringify({ v: 1, tags: { '': 0.2 }, idleSec: 0 }),
    JSON.stringify({ v: 1, tags: { x: NaN }, idleSec: 0 }),
    JSON.stringify({ v: 1, tags: { x: 0.1 }, idleSec: -3 }),
    JSON.stringify({ v: 1, tags: { x: 0.1 } }),
  ];
  let allThrew = true;
  for (const j of junk) {
    try { DirectorLearning.deserialize(j); allThrew = false; } catch { /* expected */ }
  }
  ok(allThrew, `all ${junk.length} malformed saves fail loud`);

  // Junk events never crash the recorder.
  const m = new DirectorLearning();
  try { m.record(ev('stare', 'x')); ok(false, 'unknown kind should throw'); }
  catch { ok(true, 'unknown event kind fails loud'); }
  try { m.record(ev('pause', '')); ok(false, 'empty tag should throw'); }
  catch { ok(true, 'empty contextTag fails loud'); }
  ok(!m.record(ev('pause', 'x', NaN)), 'non-finite intensity dropped, not applied');
  ok(!m.record(ev('pause', 'x', Infinity)), 'infinite intensity dropped, not applied');
  ok(m.tags().length === 0, 'dropped junk never registered a tag');
  m.record(ev('pause', 'x', 0.5));
  ok(m.suggestPhaseBias().x === 0.5 * (1 + ALPHA * KIND_SIGNAL.pause * 0.5),
    'tag still starts from uniform once real evidence lands');
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? `DIRECTORLEARNING ALL PASS (${check} checks)` : `${failures}/${check} FAILED`);
process.exit(failures === 0 ? 0 : 1);
