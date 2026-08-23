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

(Showing lines 196-211 of 267. Use offset=212 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
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

(Showing lines 218-237 of 267. Use offset=238 to continue.)


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


(Showing lines 238-255 of 267. Use offset=256 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
    if (i % 3 === 0) pb.frame();
  }
  pb.frame();
  ok(pb.report().frames === before + Math.ceil(5000 / 3), 'hot-path churn keeps frame accounting exact');
}

console.log(failures === 0 ? '
ALL PERFBUDGET TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


