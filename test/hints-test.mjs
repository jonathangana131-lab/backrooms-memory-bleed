check('rollInterval stays inside the 3-5 minute window', () => {
  let lo = Infinity;
  let hi = -Infinity;
  const rng = (min, max) => { lo = Math.min(lo, min); hi = Math.max(hi, max); return min; };
  for (let i = 0; i < 50; i++) rollInterval(rng);
  assert.equal(lo, HINT_MIN_INTERVAL_S);
  assert.equal(hi, HINT_MAX_INTERVAL_S);
  assert.ok(HINT_MIN_INTERVAL_S === 180 && HINT_MAX_INTERVAL_S === 300);
});

function makeHints(rng) {
  return new DifficultyHints({ document: stubDoc().doc, rng });
}

/** Advance in 1s steps until a hint fires or the budget runs out. */
function runUntilHint(hints, cautiousness) {
  const need = HINT_MAX_INTERVAL_S + 10;
  for (let t = 0; t < need; t += 1) {
    const out = hints.update(1, cautiousness);
    if (out !== null) return out;
  }
  throw new Error('no hint within budget');
}

/** Hold the system in the silent middle for total seconds. */
function drainMiddle(hints, total) {
  for (let t = 0; t < total; t += 1) hints.update(1, 0.5);
}

check('first hint fires only after the jittered cooldown', () => {
  const hints = makeHints(() => HINT_MAX_INTERVAL_S);
  for (let t = 0; t < HINT_MAX_INTERVAL_S - 1; t += 1) {
    assert.equal(hints.update(1, 0.1), null, 'no hint before cooldown at t=' + t);
  }
  const text = hints.update(1, 0.1);
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(BRAVE_HINTS.includes(text), 'brave state draws from brave pool');
});

check('steady-state pool never hints twice without a shift', () => {
  const hints = makeHints(() => HINT_MIN_INTERVAL_S);
  assert.ok(runUntilHint(hints, 0.2));
  for (let i = 0; i < 3600; i++) {
    assert.equal(hints.update(1, 0.2), null, 'steady brave must stay silent');
  }
});

check('ambiguous middle disarms; re-entry counts as a fresh shift', () => {
  const hints = makeHints(() => HINT_MIN_INTERVAL_S);
  assert.ok(runUntilHint(hints, 0.2)); // brave
  drainMiddle(hints, 10000);          // long ambiguity
  // Silence must hold through the whole pre-boundary window...
  for (let i = 0; i < HINT_MIN_INTERVAL_S - 2; i++) {
    assert.equal(hints.update(1, 0.2), null, 're-entry still respects cooldown');
  }
  // ...and the fresh shift then speaks within one jittered window.
  const rearmed = runUntilHint(hints, 0.2);
  assert.ok(typeof rearmed === 'string', 're-entering a pool re-arms the walls');
});

check('crossing to the opposite pool produces the other pool text', () => {
  const hints = makeHints(() => HINT_MIN_INTERVAL_S);
  const braveText = runUntilHint(hints, 0.1);
  assert.ok(braveText);
  drainMiddle(hints, HINT_MIN_INTERVAL_S + 1);
  const timidText = runUntilHint(hints, 0.8);
  assert.ok(timidText, 'timid shift reveals text');
  assert.ok(TIMID_HINTS.includes(timidText));
  assert.notEqual(timidText, braveText);
});

check('consecutive fragments differ across pool flips (no repeats)', () => {
  const hints = makeHints(() => HINT_MIN_INTERVAL_S);
  let current = 0.1;
  const seen = [runUntilHint(hints, current)];
  for (let k = 0; k < 12; k++) {
    current = current < 0.5 ? 0.9 : 0.1; // flip pools each time
    drainMiddle(hints, HINT_MIN_INTERVAL_S + 1);
    seen.push(runUntilHint(hints, current));
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], 'repeat at flip ' + i);
  }
});

check('update is robust to junk dt', () => {
  const hints = makeHints(() => HINT_MIN_INTERVAL_S);
  assert.equal(hints.update(NaN, 0.1), null);
  assert.equal(hints.update(-5, 0.1), null);
  assert.equal(hints.update(Infinity, 0.1), null);
});

check('pickFrom round-robins and rejects empty pools', () => {
  assert.equal(pickFrom(['a'], 99), 'a');
  assert.equal(pickFrom(['a', 'b', 'c'], 4), 'b');
  assert.equal(pickFrom(['a', 'b', 'c'], -4), 'c');
  assert.throws(() => pickFrom([], 0));
});

/* ------------------------------------------------------------------ */
/* Presentation constants + DOM layer                                  */
/* ------------------------------------------------------------------ */

check('presentation arc matches the 4s spec', () => {
  assert.equal(HINT_FADE_MS, 4000);
});

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
  return { doc, created };
}

function opacityOf(el) {
  return el.styleProps.opacity;
}

check('DOM layer mounts stylesheet + element and fades per update clock', () => {
  const { doc, created } = stubDoc();
  const hints = new DifficultyHints({ document: doc, rng: () => HINT_MIN_INTERVAL_S });
  assert.equal(created.length, 2, 'style + p elements');
  const styleEl = created[0];
  const pEl = created[1];
  assert.equal(styleEl.className, 'bmb-hints-style');
  assert.match(String(styleEl.textContent), /[.]bmb-hint [{]/);
  assert.match(String(styleEl.textContent), /font-style: italic/);
  assert.match(String(styleEl.textContent), /monospace/);
  assert.match(String(styleEl.textContent), /position: fixed/);
  assert.match(String(styleEl.textContent), /transition: opacity 4000ms/);
  assert.equal(pEl.className, 'bmb-hint');
  assert.equal(opacityOf(pEl), '0', 'born invisible');

  const text = runUntilHint(hints, 0.1);
  assert.equal(pEl.textContent, text);
  const op = Number(opacityOf(pEl));
  assert.ok(op > 0 && op < 0.5, 'revealed at dim peak, got ' + op);

  // Two realistic frames cross the hold window -> fade-out half begins.
  hints.update(1.05, 0.5);
  hints.update(1.05, 0.5);
  assert.equal(opacityOf(pEl), '0', 'faded back out after the hold');

  hints.dispose();
  assert.equal(pEl.removed, true, 'dispose removes the subtree');
  assert.equal(hints.update(1, 0.1), null, 'disposed update is a no-op');
});

check('constructor demands a usable document', () => {
  assert.throws(() => new DifficultyHints({ document: null }));
  assert.throws(() => new DifficultyHints({ document: {} }));
});

console.log('passed:', passed);


