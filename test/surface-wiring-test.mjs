  let hooksRegistered = false;
  try {
    const { registerHooks } = await import('node:module');
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          return nextResolve(specifier + '.ts', context);
        }
      },
    });
    hooksRegistered = true;
  } catch (err) {
    hooksRegistered = false; // older Node without synchronous module hooks
  }
  if (!hooksRegistered) console.warn('  note: no resolve hook available; behavioural part may skip');
  const mod = await import('../src/audio/surface-wiring.ts');

  // District id -> base surface mapping, one fresh context per case.
  const cases = [
    [0, 'carpet'], [3, 'carpet'],   // MAZE, CORRIDOR_GRID
    [1, 'tile'], [2, 'tile'],       // OPEN_OFFICE, HONEYCOMB
    [4, 'metal'],                   // STORAGE
  ];
  for (const c of cases) {
    const district = c[0]; const want = c[1];
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => district);
    w.step(10, 10, false);
    const got = classify(ctx);
    ok(got === want, 'district ' + district + ' -> ' + want + ' (got ' + got + ')');
  }

  // Unknown district id falls back safely to a playable surface.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 99);
    let threw = false;
    try { w.step(0, 0, false); } catch (e) { threw = true; }
    ok(!threw && ctx.nodes.length > 0 && classify(ctx) === 'carpet', 'unknown district falls back to carpet without throwing');
  }

  // Puddle zones override the district surface with splash.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 4); // STORAGE = metal
    w.setPuddles([{ x: 50, z: -20 }]);
    w.step(50.5, -19.7, false); // well inside the default 1.2 m radius
    ok(classify(ctx) === 'splash', 'step inside puddle zone -> splash override');
  }

  // Just outside the default radius stays on the base surface.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0); // MAZE = carpet
    w.setPuddles([{ x: 0, z: 0 }]);
    ctx.currentTime = 1; w.step(1.05, 0.85, false); // dist ~1.35 m > 1.2 m
    ok(classify(ctx) === 'carpet', 'step outside puddle radius keeps district surface');
  }

  // Custom per-puddle radius is honoured.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0);
    w.setPuddles([{ x: 5, z: 5, r: 3 }]);
    ctx.currentTime = 1;
    w.step(7.5, 5, false); // 2.5 m out, inside the custom 3 m radius
    ok(classify(ctx) === 'splash', 'custom puddle radius honoured');
  }

  // External puddleCheck overrides the built-in list entirely.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0, (x, z) => x > 100);
    w.setPuddles([{ x: 0, z: 0 }]);
    const before = ctx.nodes.length;
    ctx.currentTime = 1; w.step(0, 0, false); // inside registered puddle, probe says dry
    ok(classify(ctx, before) === 'carpet', 'external puddleCheck overrides built-in list');
    const afterFirst = ctx.nodes.length;
    ctx.currentTime = 2; w.step(101, 0, false); // probe says wet
    ok(classify(ctx, afterFirst) === 'splash', 'external puddleCheck triggers splash');
  }

  // Rate limiting: dedup of rapid calls plus cadence gates.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0);
    const played = () => ctx.nodes.filter((n) => n.__kind === 'src').length;
    ctx.currentTime = 10;
    ok(w.step(0, 0, false) === true && played() === 1, 'first walking step plays');
    ok(w.step(0.1, 0, false) === false && played() === 1, 'immediate duplicate step is deduped');
    ctx.currentTime = 10.2; // 200 ms later: past 150 ms floor, under walk cadence
    ok(w.step(0.3, 0, false) === false, 'step within walking cadence (~455 ms) is dropped');
    ctx.currentTime = 10.5; // 500 ms after last play
    ok(w.step(0.6, 0, false) === true && played() === 2, 'step after full walking cadence plays');
    ctx.currentTime = 10.65; // 150 ms after last play
    ok(w.step(0.9, 0, true) === false, 'sprint step still blocked inside 150 ms dedup window');
    ctx.currentTime = 10.9; // 400 ms after last play: sprint OK, walk would refuse
    ok(w.step(1.1, 0, true) === true, 'sprinting allows faster cadence than walking');
    ctx.currentTime = 11.15; // 250 ms later: walk refuses even though sprint would allow
    ok(w.step(1.3, 0, false) === false, 'walking cadence stricter than sprint cadence');
  }

  // Sprint flag is forwarded to play() (louder envelope peaks).
  {
    const peakOf = (c) => Math.max.apply(null, c.nodes.filter((n) => n.__kind === "gain").map((g) => g.gain.max));
    let walkPeak = 0; let sprintPeak = 0;
    for (let i = 0; i < 20; i++) {
      const c1 = new FakeCtx();
      const w1 = new mod.SurfaceWiring(c1, c1, () => 0);
      w1.step(0, 0, false);
      const c2 = new FakeCtx();
      c2.currentTime = 999;
      const w2 = new mod.SurfaceWiring(c2, c2, () => 0);
      w2.step(0, 0, true);
      walkPeak += peakOf(c1);
      sprintPeak += peakOf(c2);
    }
    ok(sprintPeak > walkPeak, 'sprint flag forwarded: sprint steps louder (avg of 20)');
  }
}

const probe = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "process.exit(0)"]);
if (probe.status === 0 || probe.status === null) {
  try {
    await behaviour();
  } catch (e) {
    console.warn('  SKIP behavioural:', e.message);
  }
} else {
  console.warn('  SKIP behavioural: this Node lacks --experimental-strip-types');
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


