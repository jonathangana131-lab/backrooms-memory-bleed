/**
 * F3 Determinism audit.
 *
 * a. STATIC: every .ts file under src/ must be free of Math.random EXCEPT
 *    inside src/audio/ where the containing line or either neighbor carries
 *    a comment mentioning DSP / audio buffer fill (GAME-PLAN quality bar #6
 *    carve-out). Any other occurrence FAILS with file:line. Sites inside a
 *    small RESIDUE_LEDGER of files owned by other agents / the orchestrator
 *    print KNOWN_RESIDUE lines instead; shrink the ledger as domains
 *    convert, and any site outside it fails immediately.
 *    src/core/game.ts relocation/camera-shake is the orchestrator's F3
 *    follow-up half.
 *
 * b. BEHAVIOURAL: same-seed HorrorDirectors replay identical phase-duration
 *    sequences; same-seed DifficultyHints pick identically; sign-grime and
 *    graffiti-tilt dressing are pure functions of their inputs.
 *
 * Run: node test/determinism-audit.mjs   (exit 0 = ALL PASS)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];

function pass(name) {
  passes.push(name);
  console.log('PASS', name);
}
function fail(name, detail) {
  failures.push(name);
  console.log('FAIL', name + (detail ? ' -- ' + detail : ''));
}

// ---------------------------------------------------------------- static ---
const RESIDUE_COMMENT = /DSP|audio buffer fill/i;
/**
 * Files with known unconverted Math.random sites owned by other agents or
 * the orchestrator (game.ts relocation/camera-shake is F3's own follow-up).
 * Their sites print KNOWN_RESIDUE lines instead of failing this suite; a
 * site appearing in ANY OTHER file fails immediately. Shrink this set as
 * domains convert; never grow it without noting the owner.
 */
const RESIDUE_LEDGER = new Set([
  'src/core/game.ts', // orchestrator: relocation/camera-shake conversion
  'src/audio/approach.ts',
  'src/audio/audio.ts',
  'src/audio/boundaries.ts',
  'src/audio/creakvariety.ts',
  'src/audio/crowd.ts',
  'src/audio/doors.ts',
  'src/audio/echoes.ts',
  'src/audio/exterior.ts',
  'src/audio/fanaudio.ts',
  'src/audio/groans.ts',
  'src/audio/humharmonics.ts',
  'src/audio/landmarkbreath.ts',
  'src/audio/music.ts',
  'src/audio/pairvocals.ts',
  'src/audio/radio.ts',
  'src/audio/surfaces.ts',
  'src/audio/whisperfield.ts',
  'src/entities/fauna.ts', // creature vocal DSP fills
  'src/entities/humans.ts', // walkPhase init
  'src/gfx/ceilingfan.ts',
  'src/gfx/drips.ts',
  'src/gfx/dust.ts',
  'src/gfx/fandust.ts',
  'src/gfx/lighting.ts',
  'src/gfx/paperflutter.ts',
  'src/gfx/postfx.ts',
  'src/gfx/reflections.ts',
  'src/gfx/sway.ts',
  'src/ui/radiotune.ts', // static-noise buffer fill
]);

function* walkTs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkTs(p);
    else if (e.isFile() && e.name.endsWith('.ts')) yield p;
  }
}

/** Strip line and block comments so prose mentions never match the scan. */
function codeOnly(lines) {
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    let rest = line;
    while (rest.length > 0) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          rest = '';
        } else {
          inBlock = false;
          rest = rest.slice(end + 2);
        }
      } else {
        const start = rest.indexOf('/*');
        const slash = rest.indexOf('//');
        if (slash !== -1 && (start === -1 || slash < start)) {
          out += rest.slice(0, slash);
          rest = '';
        } else if (start !== -1) {
          out += rest.slice(0, start);
          rest = rest.slice(start + 2);
          inBlock = true;
        } else {
          out += rest;
          rest = '';
        }
      }
    }
    return out;
  });
}

function staticScan() {
  const offenders = [];
  const residue = [];
  let dspAllowed = 0;
  for (const file of walkTs(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const raw = fs.readFileSync(file, 'utf8').split('\n');
    const code = codeOnly(raw);
    code.forEach((codeLine, i) => {
      if (!/Math\.random\s*\(/.test(codeLine)) return;
      if (rel.startsWith('src/audio')) {
        const neighborhood = [raw[i - 1] ?? '', raw[i], raw[i + 1] ?? ''];
        const commented = neighborhood.some((l) => l.includes('//') || l.includes('/*'));
        if (commented && neighborhood.some((l) => RESIDUE_COMMENT.test(l))) {
          dspAllowed++;
          return;
        }
      }
      const entry = `${rel}:${i + 1}`;
      if (RESIDUE_LEDGER.has(rel)) {
        residue.push(entry);
        return;
      }
      offenders.push(`${entry}: ${codeLine.trim()}`);
    });
  }
  if (residue.length) {
    console.log(
      `KNOWN_RESIDUE (${residue.length} site(s) across ${new Set(residue.map((r) => r.split(':')[0])).size} ledgered files; not gating):`,
    );
    for (const r of residue) console.log('  ', r);
  }
  if (offenders.length === 0) {
    pass(`static: no ungated, unledgered Math.random under src/ (${dspAllowed} audio-DSP carve-out site(s))`);
  } else {
    fail('static: no ungated, unledgered Math.random under src/', offenders.join(' | '));
  }
}

// ----------------------------------------------------------- transpile io ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-determinism-'));
for (const d of ['src/core', 'src/ui', 'src/world', 'src/director']) {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
}
function emit(relSrc, outRel) {
  const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, relSrc), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best effort */
  }
});
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/core/events.ts', 'src/core/events.mjs');
emit('src/director/director.ts', 'src/director/director.mjs');
emit('src/ui/hints.ts', 'src/ui/hints.mjs');
emit('src/world/textureDressing.ts', 'src/world/textureDressing.mjs');

const { RNG, hash2i } = await import(path.join(tmp, 'src/core/rng.mjs'));
const { HorrorDirector } = await import(path.join(tmp, 'src/director/director.mjs'));
const { DifficultyHints, BRAVE_HINTS, TIMID_HINTS } = await import(
  path.join(tmp, 'src/ui/hints.mjs')
);
const { signGrimeRects, graffitiTilt } = await import(path.join(tmp, 'src/world/textureDressing.mjs'));

// ------------------------------------------------------------ behavioural ---

/** Stub host: clock advances exactly with the dt we feed update(). */
function stubHost() {
  let t = 0;
  return {
    elapsed() {
      return t;
    },
    lightingStress() {},
    killNearbyLight() {
      return true;
    },
    blackoutPulse() {},
    whisperSurge() {},
    distantThreat() {},
    nonEuclideanNudge() {},
    armDoorwayLoop() {},
    requestEntitySpawn() {},
    playerPosition() {
      return { x: 0, z: 0 };
    },
    tick(dt) {
      t += dt;
    },
  };
}

function directorPhaseTimeline(seed, steps, dt) {
  const host = stubHost();
  const d = new HorrorDirector(host, seed);
  const timeline = [];
  let prev = d.phase;
  for (let i = 0; i < steps; i++) {
    host.tick(dt);
    d.update(dt);
    if (d.phase !== prev) {
      timeline.push([d.phase, +(host.elapsed().toFixed(6))]);
      prev = d.phase;
    }
  }
  return timeline;
}

function directorBehaviour() {
  const name = 'behavioural: same-seed directors share the phase-duration sequence';
  try {
    const SEED = hash2i(20260823, 77);
    const steps = 60000; // ~10 simulated minutes at 100ms frames: many phase laps
    const a = directorPhaseTimeline(SEED, steps, 0.1);
    const b = directorPhaseTimeline(SEED, steps, 0.1);
    assert.ok(a.length >= 8, 'timeline crosses enough phases (' + a.length + ')');
    assert.deepEqual(b, a);
    const other = directorPhaseTimeline(SEED ^ 0x5eed, steps, 0.1);
    assert.notDeepEqual(other, a, 'different seed must diverge');
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

function stubDoc() {
  const makeEl = () => ({
    className: '',
    style: { setProperty() {} },
    appendChild() {},
    remove() {},
    textContent: '',
  });
  const head = { children: [], appendChild(c) { this.children.push(c); } };
  return { doc: { createElement: () => makeEl(), head } };
}

function hintSequence(seed) {
  const { doc } = stubDoc();
  const hints = new DifficultyHints({ document: doc, seed });
  const seq = [];
  let t = 0;
  while (t < 200000 && seq.length < 12) {
    t += 1;
    // alternate pools so every reveal needs a fresh shift + fresh interval roll
    const cautiousness = Math.floor(t / 400) % 2 === 0 ? 0.1 : 0.9;
    const out = hints.update(1, cautiousness);
    if (out !== null) seq.push([out, +hints.secondsUntilEligible.toFixed(6)]);
  }
  hints.dispose();
  return seq;
}

function hintsBehaviour() {
  const name = 'behavioural: same-seed hint streams pick identically';
  try {
    const SEED = 0xa11ce >>> 0;
    const a = hintSequence(SEED);
    const b = hintSequence(SEED);
    assert.ok(a.length >= 4, 'enough reveals (' + a.length + ')');
    assert.deepEqual(b, a);
    for (const [text] of a) {
      assert.ok(BRAVE_HINTS.includes(text) || TIMID_HINTS.includes(text), 'fragment from a pool');
    }
    const other = hintSequence((SEED ^ 0xb0b) >>> 0);
    assert.notDeepEqual(other, a, 'different seed must shift cadence');
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

function grimeBehaviour() {
  const name = 'behavioural: texture dressing is deterministic per (chunk seed, text)';
  try {
    const rectsA = signGrimeRects('BOILER ROOM 3', 1);
    const rectsB = signGrimeRects('BOILER ROOM 3', 1);
    assert.equal(rectsA.length, 40, 'same speckle count as the original brush loop');
    assert.deepEqual(rectsB, rectsA);
    for (const r of rectsA) {
      assert.ok(r.x >= 0 && r.x < 512 && r.y >= 0 && r.y < 128, 'speckle inside 512x128 canvas');
      assert.equal(r.w, 3);
      assert.equal(r.h, 2);
    }
    assert.notDeepEqual(signGrimeRects('EXIT', 0), signGrimeRects('EXIT', 1), 'kind salts stream');
    assert.equal(graffitiTilt('it watches the brave'), graffitiTilt('it watches the brave'));
    assert.ok(graffitiTilt('x') >= -0.05 && graffitiTilt('x') < 0.05, 'tilt range preserved');
    // independent cross-check: first EXIT(kind 0) speckle == raw hash+RNG math
    let h = 2166136261;
    for (const c of 'EXIT') {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    const rawRng = new RNG(hash2i(h >>> 0, 0, 0x67e1ce));
    assert.equal(rawRng.next() * 512, signGrimeRects('EXIT', 0)[0].x, 'first draw matches raw idiom');
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

staticScan();
directorBehaviour();
hintsBehaviour();
grimeBehaviour();

console.log(failures.length === 0 ? `ALL PASS (${passes.length} checks)` : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
