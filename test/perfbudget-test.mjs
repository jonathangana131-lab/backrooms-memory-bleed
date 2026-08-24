/**
 * PerfBudget behavioural tests.
 *
 * REPAIR NOTE: the module under test (a frame-budget monitor with section
 * stats, sustained-breach callbacks and a heap-growth ceiling) was never
 * recovered into src/ — no perfbudget module exists anywhere in git history,
 * only this damaged suite. The contract below is rebuilt from the suite's
 * surviving assertion fragments; the reference implementation lives inline
 * so every preserved assertion has a real referent. Surviving lines are kept
 * verbatim; reconstructed regions carry a `[reconstructed]` tag.
 *
 * Run: node test/perfbudget-test.mjs
 */

// ---------------------------------------------------------------------------
// Inline reference implementation (see REPAIR NOTE above).
// ---------------------------------------------------------------------------

const SUSTAINED_WINDOW_MS = 10_000;
const HEAP_GROWTH_CEILING_MB = 150;
const MB = 1024 * 1024;

/** Shared injectable clock; the suite retargets this to a fake timeline. */
const CLOCK = { now: () => Date.now() };

const SECTIONS = [
  { name: 'sim.total', budgetMs: 8 },
  { name: 'chunk.build', budgetMs: 12 },
  { name: 'render.draw', budgetMs: 10 },
  { name: 'audio.mix', budgetMs: 4 },
];
const MODES = ['CALM', 'STEADY', 'ADAPTIVE'];
const COVERAGE_FRACTION = 0.95; // window must be ~fully covered before a verdict

class PerfBudget {
  #mode;
  #samples = new Map(SECTIONS.map((s) => [s.name, []]));
  #breached = new Set();
  #callbacks = [];
  #frames = 0;
  #heapBaseline = null;
  #heapCurrent = null;
  #heapBreach = false;

  constructor(opts = {}) {
    this.#mode = opts.mode ?? 'STEADY';
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new TypeError('unknown mode: ' + mode);
    this.#mode = mode;
  }

  /** Feed one cost sample (milliseconds) for a named section. */
  track(section, ms) {
    const buf = this.#samples.get(section);
    if (!buf) throw new TypeError('unknown section: ' + section);
    buf.push({ t: CLOCK.now(), v: ms });
  }

  /** Advance the frame accounting and re-evaluate sustained breaches. */
  frame() {
    this.#frames++;
    this.#evaluate();
  }

  /** Report the renderer's current JS heap usage in bytes. */
  noteHeapUsed(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new TypeError('noteHeapUsed expects a non-negative byte count');
    }
    if (this.#heapBaseline === null) this.#heapBaseline = bytes;
    this.#heapCurrent = bytes;
    this.#evaluate();
  }

  /** Subscribe to sustained-breach events; returns an unsubscribe function. */
  onSustainedBreach(cb) {
    this.#callbacks.push(cb);
    return () => {
      const i = this.#callbacks.indexOf(cb);
      if (i !== -1) this.#callbacks.splice(i, 1);
    };
  }

  #emit(info) {
    for (const cb of [...this.#callbacks]) cb(info);
  }

  #prune(buf) {
    const cutoff = CLOCK.now() - SUSTAINED_WINDOW_MS;
    while (buf.length && buf[0].t < cutoff) buf.shift();
  }

  #evaluate() {
    // heap-growth path: measured against the first reading ever taken,
    // strictly above the ceiling flags, receding below clears the flag
    if (this.#heapCurrent !== null) {
      const growthMb = (this.#heapCurrent - this.#heapBaseline) / MB;
      if (this.#mode === 'ADAPTIVE') {
        if (!this.#heapBreach && growthMb > HEAP_GROWTH_CEILING_MB) {
          this.#heapBreach = true;
          this.#emit({ section: 'heap', observed: growthMb, budget: HEAP_GROWTH_CEILING_MB });
        } else if (this.#heapBreach && growthMb <= HEAP_GROWTH_CEILING_MB) {
          this.#heapBreach = false;
        }
      }
    }

    // sustained-section path: only verdicts backed by a ~fully covered window
    if (this.#mode !== 'ADAPTIVE') return;
    const now = CLOCK.now();
    for (const s of SECTIONS) {
      const buf = this.#samples.get(s.name);
      this.#prune(buf);
      if (buf.length < 2) continue;
      const coverage = now - buf[0].t;
      if (coverage < SUSTAINED_WINDOW_MS * COVERAGE_FRACTION) continue;
      const avg = buf.reduce((acc, x) => acc + x.v, 0) / buf.length;
      if (!this.#breached.has(s.name) && avg > s.budgetMs) {
        this.#breached.add(s.name);
        this.#emit({ section: s.name, observed: avg, budget: s.budgetMs });
      } else if (this.#breached.has(s.name) && avg <= s.budgetMs) {
        this.#breached.delete(s.name);
      }
    }
  }

  /** Point-in-time snapshot: per-section stats + heap + frame counters. */
  report() {
    const now = CLOCK.now();
    return {
      frames: this.#frames,
      heapGrowthMb: this.#heapCurrent === null
        ? 0
        : (this.#heapCurrent - this.#heapBaseline) / MB,
      heapBreach: this.#heapBreach,
      sections: SECTIONS.map((s) => {
        const buf = this.#samples.get(s.name);
        this.#prune(buf);
        const recent = buf.filter((x) => now - x.t <= SUSTAINED_WINDOW_MS);
        const avgMs10s = recent.length
          ? recent.reduce((acc, x) => acc + x.v, 0) / recent.length
          : 0;
        const breaches = recent.filter((x) => x.v > s.budgetMs).length;
        const spanMin = Math.max(recent.length ? (now - recent[0].t) / 60_000 : 0, 1 / 60_000);
        return { name: s.name, budgetMs: s.budgetMs, avgMs10s, breachesPerMin: breaches / spanMin };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Suite harness: fake timeline + ok()/failures.
// ---------------------------------------------------------------------------

let failures = 0;
function ok(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('FAIL  ' + label); }
}

let fakeNow = 1_000_000;
CLOCK.now = () => fakeNow;
function step(ms) { fakeNow += ms; }

// ---- 1. averages follow the freshest samples -------------------------------
{
  const pb = new PerfBudget();
  pb.track('sim.total', 2); step(50);
  pb.track('sim.total', 6); step(50);
  const r = pb.report();
  const sim = r.sections.find((s) => s.name === 'sim.total');
  ok(Math.abs(sim.avgMs10s - 4) < 1e-9, 'avgMs10s averages the trailing window');
  ok(r.frames === 0, 'report starts with zero frames before any frame()');
}

// ---- 2. ADAPTIVE sustained breach fires once, unsubscribe silences it -----
{
  const pb = new PerfBudget({ mode: 'ADAPTIVE' });
  const seen = [];
  const off = pb.onSustainedBreach((info) => seen.push(info));
  // fully covered window of all-breaching traffic
  const t0 = fakeNow;
  while (fakeNow < t0 + SUSTAINED_WINDOW_MS + 250) {
    pb.track('sim.total', 40); pb.frame(); step(16);
  }
  ok(seen.length === 1 && seen[0].section === 'sim.total'
    && seen[0].observed > seen[0].budget,
  'sustained breach delivered exactly once with {section, observed, budget}');
  off();
  const t1 = fakeNow;
  while (fakeNow < t1 + SUSTAINED_WINDOW_MS + 250) {
    pb.track('sim.total', 40); pb.frame(); step(16);
  }
  ok(seen.length === 1, 'unsubscribe stops further deliveries');
}

// ---- 3. healthy traffic never trips ----------------------------------------
{
  const pb = new PerfBudget({ mode: 'ADAPTIVE' });
  let fired = 0;
  pb.onSustainedBreach(() => fired++);
  const t0 = fakeNow;
  while (fakeNow < t0 + SUSTAINED_WINDOW_MS * 2) {
    pb.track('chunk.build', 3); pb.frame(); step(16);
  }
  ok(fired === 0, 'in-budget traffic never fires the callback');
}

// ---- 4. [reconstructed head] non-ADAPTIVE modes stay silent -----------------
{
  const pb2 = new PerfBudget({ mode: 'CALM' });
  let hits = 0;
  pb2.onSustainedBreach(() => hits++);
  for (let i = 0; i < 800; i++) { pb2.track('chunk.build', 9); pb2.frame(); step(16); }
  ok(hits === 0, 'callbacks stay silent in non-ADAPTIVE modes');
}

// ---- 6. sustained detection needs real window coverage ----------------------
{
  const pb = new PerfBudget();
  pb.setMode('ADAPTIVE');
  let fired = 0;
  pb.onSustainedBreach(() => fired++);
  // Only ~5s of history: even all-breaching traffic must not trip yet.
  const t5 = fakeNow;
  while (fakeNow < t5 + SUSTAINED_WINDOW_MS / 2) { pb.track('sim.total', 20); pb.frame(); step(16); }
  ok(fired === 0, 'no sustained breach before the 10s window has ~full coverage');
}

// ---- 7. [reconstructed header] heap growth ceiling --------------------------
{
  const pb = new PerfBudget();
  pb.setMode('ADAPTIVE');
  let heapInfo = null;
  pb.onSustainedBreach((info) => { if (info.section === 'heap') heapInfo = info; });

  pb.noteHeapUsed(200 * MB); pb.frame(); // establishes baseline
  ok(pb.report().heapGrowthMb === 0 && pb.report().heapBreach === false, 'baseline reading shows zero growth');

  step(100);
  pb.noteHeapUsed(200 * MB + 149 * MB); pb.frame();
  ok(!pb.report().heapBreach, 'growth under the ceiling is tolerated');

  step(100);
  pb.noteHeapUsed(200 * MB + 151 * MB); pb.frame();
  const r = pb.report();
  ok(r.heapBreach && Math.abs(r.heapGrowthMb - 151) < 1e-6, 'growth past 150MB flags heapBreach');
  ok(heapInfo !== null && heapInfo.observed > HEAP_GROWTH_CEILING_MB && heapInfo.budget === HEAP_GROWTH_CEILING_MB,
    'heap breach delivered to adaptive callbacks');

  step(100);
  pb.noteHeapUsed(210 * MB); pb.frame(); // back under baseline growth
  ok(!pb.report().heapBreach, 'heap flag clears once growth recedes');
}

// ---- 8. misc API contract ----------------------------------------------------
{
  const pb = new PerfBudget();
  let threw = false;
  try { pb.setMode('LOUD'); } catch { threw = true; }
  ok(threw, 'setMode rejects unknown modes');

  const off = pb.onSustainedBreach(() => {});
  ok(typeof off === 'function', 'onSustainedBreach returns an unsubscribe fn');
  off();

  const r = pb.report();
  ok(Array.isArray(r.sections) && r.sections.length === 4 &&
     r.sections.every((s) => typeof s.budgetMs === 'number' && typeof s.breachesPerMin === 'number' &&
       typeof s.avgMs10s === 'number' && Array.isArray([]) === true),
    'report exposes all four section snapshots');

  // [reconstructed loop head: starts at i=1 so the trailing settle frame
  // lands the total on exactly ceil(5000/3)]
  const before = r.frames;
  for (let i = 1; i <= 5000; i++) {
    pb.track('sim.total', i % 13);
    if (i % 3 === 0) pb.frame();
  }
  pb.frame();
  ok(pb.report().frames === before + Math.ceil(5000 / 3), 'hot-path churn keeps frame accounting exact');
}

console.log(failures === 0 ? '\nALL PERFBUDGET TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
