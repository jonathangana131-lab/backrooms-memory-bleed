/**
 * Unit test for the ambient story beat system (src/story/beats.ts).
 * Standalone (no browser): transpiles beats.ts at runtime and drives
 * StoryBeats against synthetic state. Run: node test/story-beats.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// --- transpile src/story/beats.ts into a temp dir -------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-story-beats-'));
const rel = 'src/story/beats.ts';
const full = path.join(ROOT, rel);
const js = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
  fileName: full,
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const outPath = path.join(tmp, 'beats.mjs');
fs.writeFileSync(outPath, js);
const { BEATS, StoryBeats } = await import(pathToFileURL(outPath).href);

const EARLY = {
  playtimeSec: 0,
  discoveries: 0,
  notesRead: 0,
  landmarksSeen: new Set(),
  stability: 1,
  phase: 'calm',
};
const step = (sb, dt, patch = {}) => sb.update(dt, { ...EARLY, ...patch });

// ---- catalog shape --------------------------------------------------------
check('exactly 12 beats defined', BEATS.length === 12, String(BEATS.length));
check('beat ids unique', new Set(BEATS.map((b) => b.id)).size === 12);
for (const b of BEATS) {
  check(`beat ${b.id} has nonempty text`, typeof b.text === 'string' && b.text.length > 10);
  check(`beat ${b.id} has numeric priority`, typeof b.priority === 'number' && isFinite(b.priority));
  check(
    `beat ${b.id} condition false on fresh state`,
    !b.condition(EARLY),
    JSON.stringify({ p: b.playtimeSec ?? null }),
  );
}

// ---- nothing fires on a fresh state --------------------------------------
{
  const sb = new StoryBeats();
  let fired = null;
  for (let i = 0; i < 600; i++) {
    const t = step(sb, 1); // 10 minutes of quiet early-game time
    if (t) { fired = t; break; }
  }
  check('no beat fires on untouched early state', fired === null, String(fired));
}

// ---- one-shot + cooldown --------------------------------------------------
{
  const sb = new StoryBeats();
  const first = step(sb, 1, { notesRead: 1 }); // first-note fires
  check('first note read triggers a beat', typeof first === 'string' && first.length > 10);
  const again = step(sb, 1, { notesRead: 1 });
  check('cooldown blocks immediate second beat', again === null);
  // burn the 90s cooldown; no other condition holds, so still nothing.
  let late = null;
  for (let i = 0; i < 200; i++) late = step(sb, 1, { notesRead: 1, playtimeSec: 100 + i });
  check('no second beat until another condition holds', late === null);

  // Now satisfy two conditions at once; highest priority must win, once.
  const text = step(sb, 91, { playtimeSec: 400, notesRead: 8, discoveries: 2, landmarksSeen: new Set(['a', 'b']) });
  check('a beat fires when new conditions hold after cooldown', typeof text === 'string');
}

// ---- priority ordering ------------------------------------------------------
{
  const sb = new StoryBeats();
  // first-note (priority 12) and warm-lamp (13) become true on the same tick;
  // the scheduler must surface only the higher-priority beat.
  const state = { ...EARLY, notesRead: 1, discoveries: 2 };
  const text = step(sb, 1, { notesRead: 1, discoveries: 2 });
  const winner = BEATS.find((b) => b.text === text);
  const contenders = BEATS.filter((b) => b.condition(state));
  check('highest-priority beat wins a contested tick',
    !!winner && winner.id === 'warm-lamp',
    JSON.stringify(contenders.map((b) => b.id)));
}

// ---- once-per-session ---------------------------------------------------------
{
  const sb = new StoryBeats();
  step(sb, 1, { notesRead: 1 });
  // burn far past the cooldown while first-note stays true forever after
  let repeat = false;
  for (let i = 0; i < 300; i++) {
    if (step(sb, 1, { notesRead: 1 }) !== null) repeat = true;
  }
  check('a beat never fires twice in one session', !repeat);
  check('firedIds records exactly what has shown',
    sb.firedIds().length === 1 && sb.firedIds()[0] === 'first-note');
  check('cooldownRemaining drains back to zero', sb.cooldownRemaining === 0);
}

// ---- full narrative arc --------------------------------------------------------
{
  const sb = new StoryBeats();
  const seen = [];
  // give the quietest beat a clean early window before the loud ones pile on
  const humText = sb.update(46, { ...EARLY, playtimeSec: 46 });
  if (humText) seen.push(humText);
  for (let pt = 90; pt <= 1560; pt += 30) {
    const state = {
      ...EARLY,
      playtimeSec: pt,
      notesRead: 8,
      discoveries: 4,
      landmarksSeen: new Set(['a', 'b', 'c', 'd', 'e']),
      stability: 0.4,
      phase: pt < 420 ? 'calm' : 'peak',
    };
    const t = sb.update(30, state);
    if (t) seen.push(t);
  }
  check('all 12 beats eventually fire across a long expedition',
    seen.length === 12, String(seen.length));
  check('no beat text ever repeats', new Set(seen).size === seen.length);
}

// ---- reset ----------------------------------------------------------------------
{
  const sb = new StoryBeats();
  step(sb, 1, { notesRead: 1 });
  sb.reset();
  check('reset clears the fired set and any pending cooldown',
    sb.firedIds().length === 0 && sb.cooldownRemaining === 0);
  const again = step(sb, 1, { notesRead: 1 });
  check('after reset the same beat may fire again', typeof again === 'string');
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
} else {
  console.log('\nAll story-beats tests passed.');
}
