// State machine: notice freeze then flee
{
  const s = new ShadowReactions();
  const dt = 1 / 60;

  const r1 = s.update(dt, true, 0, 0, 0, 5, 0, 10);
  check('aligned entity starts reacting', r1.reacting === true);
  check('first phase is noticing', s.currentState === 'noticing');

  // Freeze lasts ~0.5s; still noticing just before it expires.
  for (let i = 0; i < 29; i++) s.update(dt, true, 0, 0, 0, 5, 0, 10);
  check('still frozen near end of freeze window', s.currentState === 'noticing');

  const rFlee = s.update(dt, true, 0, 0, 0, 5, 0, 10);
  check('transitions to fleeing after freeze', rFlee.reacting && s.currentState === 'fleeing');
  check(
    'flee direction points away from the shadow',
    approx(s.fleeDir.x, 0) && approx(s.fleeDir.z, -1),
  );

  for (let i = 0; i < 120; i++) s.update(dt, true, 0, 0, 0, 5, 0, 10);
  check('returns to idle after fleeing', s.currentState === 'idle');
  const rCool = s.update(dt, true, 0, 0, 0, 5, 0, 10);
  check('no instant re-trigger after fleeing', rCool.reacting === false);
}

// ------------------------------------------------------------------
// Freeze completes even if the player steps out of the line
{
  const s = new ShadowReactions();
  const dt = 1 / 60;
  s.update(dt, true, 0, 0, 0, 5, 0, 10);
  for (let i = 0; i < 40; i++) s.update(dt, true, 0, 0, 0, 5, 50, 10);
  check('freeze runs to completion despite misalignment', s.currentState !== 'idle');
  check(
    'still reacting during completed sequence',
    s.currentState === 'fleeing' || s.currentState === 'noticing',
  );
}


(Showing lines 50-89 of 137. Use offset=90 to continue.)

