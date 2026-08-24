/**
 * Memory residue tests (F21): deterministic scripts per tenantSeed, one-shot
 * discipline per visit with markLeft() re-arming, and archetype consistency
 * against the kind table.
 *
 * The TypeScript module is transpiled to a temp dir (extensionless relative
 * imports rewritten for Node ESM), then imported. Run:
 *
 *   node test/residue-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-residue-'));
fsMod.mkdirSync(path.join(tmp, 'src/memory'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    // Node ESM needs explicit extensions on the relative cross-file import.
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/memory/residue.ts', 'src/memory/residue.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  ResidueField,
  buildResidueScript,
  RESIDUE_KINDS,
  TENANT_VOICES,
} = await import('file://' + path.join(tmp, 'src/memory/residue.mjs'));

const KINDS = Object.keys(RESIDUE_KINDS);

test('same tenantSeed -> byte-identical script across instances; timing is sane', () => {
  for (const kind of KINDS) {
    const a = buildResidueScript(kind, 4242);
    const b = buildResidueScript(kind, 4242);
    assert.deepEqual(b, a, 'script not deterministic for kind ' + kind);
    assert.ok(a.length >= 3 && a.length <= 5, 'beat count out of band for ' + kind);
    // beats arrive in increasing time order; first beat lands quickly
    assert.ok(a[0].atSec > 0 && a[0].atSec <= 1.5 + 1e-9);
    for (let i = 1; i < a.length; i++) {
      assert.ok(a[i].atSec > a[i - 1].atSec, 'beat times not strictly increasing');
    }
    // opening beat always anchors the archetype object
    assert.equal(a[0].channel, 'presence');
    assert.ok(a[0].text.includes(RESIDUE_KINDS[kind].object));
  }
});

test('different tenantSeeds (or kinds) produce different scripts', () => {
  const base = JSON.stringify(buildResidueScript('armchair', 1));
  let diverged = false;
  for (let seed = 2; seed <= 40 && !diverged; seed++) {
    if (JSON.stringify(buildResidueScript('armchair', seed)) !== base) diverged = true;
  }
  assert.ok(diverged, 'all seeds produced identical armchair scripts');
  assert.notDeepEqual(
    buildResidueScript('armchair', 77),
    buildResidueScript('rotaryphone', 77),
  );
});

test('archetype consistency: action/voice beats come from the kind table pools', () => {
  for (const kind of KINDS) {
    const arch = RESIDUE_KINDS[kind];
    for (const beat of buildResidueScript(kind, 909)) {
      if (beat.channel === 'action') {
        assert.ok(arch.actions.includes(beat.text), 'foreign action in ' + kind);
        assert.ok(!beat.text.includes(TENANT_VOICES[0]));
      } else if (beat.channel === 'voice') {
        assert.ok(TENANT_VOICES.includes(beat.text), 'foreign voice line in ' + kind);
      }
      // no repeated back-to-back action fragments
    }
    const script = buildResidueScript(kind, 5150);
    for (let i = 1; i < script.length; i++) {
      if (script[i].channel === 'action' && script[i - 1].channel === 'action') {
        assert.notEqual(script[i].text, script[i - 1].text, 'repeated adjacent action');
      }
    }
  }
});

test('one-shot per visit: second touch null, markLeft() re-arms exactly once per visit', () => {
  const f = new ResidueField(1337);
  f.add({ id: 'chair-7', x: 3.5, z: -8, kind: 'armchair', tenantSeed: 4242 });
  f.add({ id: 'phone-1', x: 10, z: 12, kind: 'rotaryphone', tenantSeed: 99 });

  const first = f.interact('chair-7');
  assert.ok(Array.isArray(first) && first.length > 0);
  assert.deepEqual(f.interact('chair-7'), null); // same visit -> null
  assert.ok(f.wasTouched('chair-7'));

  // other objects still play independently during the same visit
  const phone = f.interact('phone-1');
  assert.ok(Array.isArray(phone) && phone.length > 0);

  f.markLeft();
  assert.ok(!f.wasTouched('chair-7'));
  const again = f.interact('chair-7');
  assert.deepEqual(again, first); // same seed -> identical script next visit

  // unknown ids never play
  assert.equal(f.interact('ghost-id'), null);
  assert.equal(new ResidueField(1).interact('chair-7'), null);
});

console.log('residue-test: all checks passed');
