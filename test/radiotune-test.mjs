  return { doc };
}

/** Depth-first search for the first element with a given class. */
function findByClass(root, cls) {
  if (root.className === cls) return root;
  for (const child of root.children) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

/** Audio backend that records every intention for assertions. */
function audioRecorder() {
  const rec = {
    staticLevels: [],
    voiceLevels: [],
    pings: 0,
    suspended: 0,
    resumed: 0,
    lastStatic: -1,
    setStatic(v) {
      rec.lastStatic = v;
      rec.staticLevels.push(v);
    },
    setVoice(v) { rec.voiceLevels.push(v); },
    ping() { rec.pings++; },
    suspend() { rec.suspended++; },
    resume() { rec.resumed++; },
  };
  return rec;
}

/** Hold a tune direction until update() reports discovery or budget dies. */
function tuneUntilFound(tuner, key) {
  tuner.pressKey(key);
  try {
    const seen = [];
    for (let i = 0; i < 400; i++) {
      const out = tuner.update(0.05);
      if (out !== null) return seen.concat([out]);
      seen.push(out);
    }
    throw new Error('never locked onto hidden station');
  } finally {
    tuner.releaseKey(key);
  }
}

const readoutOf = (t) => findByClass(t.root, 'bmb-radiotune-freq').textContent;

/* ------------------------------------------------------------------ */
/* Lore pool                                                           */
/* ------------------------------------------------------------------ */

check('lore pool holds ten fragments', () => {
  assert.equal(LORE_POOL.length, 10);
});

check('every fragment is short, non-empty prose (1-2 sentences)', () => {
  for (const f of LORE_POOL) {
    assert.ok(f.trim().length > 20, 'too short: ' + f);
    const sentences = f.split(/[.!?]/).map((s) => s.trim()).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 3,
      'sentence count ' + sentences.length + ': ' + f);
  }
});

check('pool mixes coordinates, corridor warnings, personal mail', () => {
  const joined = LORE_POOL.join(' ').toLowerCase();
  assert.match(joined, /grid|degrees north|datum/, 'coordinates');
  assert.match(joined, /corridor/, 'corridor warning');
  assert.match(joined, /jamie|mara/, 'personal message');
});

/* ------------------------------------------------------------------ */
/* Pure band math                                                      */
/* ------------------------------------------------------------------ */


(Showing lines 100-179 of 419. Use offset=180 to continue.)

