    if (Math.abs(sink.colors[v * 4 + 2] - tb) > EPS) okDial = false;
    if (sink.colors[v * 4 + 3] !== 1) okDial = false; // alpha untouched
  }
  check('earlier boxes keep neutral white vertices', okUntouched);
  check('dial box vertices carry the glow tint RGB, white alpha', okDial);
}

// ---------------------------------------------------------------------------
// 3. Dial texture application through paintDial
// ---------------------------------------------------------------------------
{
  const ctxA = new RecordingCtx();
  const ctxB = new RecordingCtx();
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: SEED, dialCtx: ctxA });
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: SEED, dialCtx: ctxB });

  const traceA = JSON.stringify(ctxA.ops);
  check('paintDial ran on the supplied context', ctxA.ops.length > 100,
    'ops=' + ctxA.ops.length);
  check('painted face is deterministic per seed', traceA === JSON.stringify(ctxB.ops));

  const texts = ctxA.ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
  check('face carries a manufacturer brand from radiodial',
    texts.some((t) => DIAL_BRANDS.includes(t)),
    JSON.stringify(texts.slice(0, 8)));
  check('face labels the FM scale', texts.includes('FM  MHz'));

  // Different seed -> different grain trace (needle rest position may move).
  const ctxC = new RecordingCtx();
  new RadioPropMesh().emit(PLACE, record(new Sink()).fn, { seed: 'radio:99:99', dialCtx: ctxC });


