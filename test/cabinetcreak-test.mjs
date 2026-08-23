  cc2.update(1 / 60, 0.25, 0);
  check('two simultaneous entries both fire', oscsSince(ctx2, 0).length === 2,
    String(oscsSince(ctx2, 0).length));
}

// ---- 6/7/8: creak character -------------------------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  // Approach from the left so pan must be negative.
  cc.update(1 / 60, CAB.x - 1.2, CAB.z);
  const o = oscsSince(ctx, 0)[0];
  check('voice exists', !!o);
  check('hinge whine is a sine', o.type === 'sine', o.type);

  const f = o.frequency.events;
  const setEv = f.find((e) => e[0] === 'set');
  const linEvs = f.filter((e) => e[0] === 'lin');
  check('starts around 400 Hz', Math.abs(setEv[1] - 400) <= 10, String(setEv[1]));
  check('sweeps up to around 600 Hz', linEvs.length === 1 && Math.abs(linEvs[0][1] - 600) <= 10,
    JSON.stringify(linEvs));
  check('sweep lasts ~300 ms', close(linEvs[0][2] - setEv[2], 0.3, 1e-9),
    String(linEvs[0][2] - setEv[2]));
  check('sweep rises upward', linEvs[0][1] > setEv[1]);

  const g = downstream(o, 'gain');
  check('graph reaches destination via panner',
    !!downstream(o, 'panner') && downstream(o, 'panner').edges.includes(ctx.destination));
  // Peak gain: the loudest linear ramp target.
  const peaks = g.gain.events.filter((e) => e[0] === 'lin').map((e) => e[1]);


