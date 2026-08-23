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

(Showing lines 1-80 of 132. Use offset=81 to continue.)

