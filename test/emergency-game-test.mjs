/**
 * Integration tests for the emergency-lights GAME wiring
 * (src/core/game.ts blackout section). Standalone (no browser):
 *
 *   A. SOURCE CONTRACT - game.ts must
 *      1. call emergencyWiring.frameUpdate(dt, blackout) inside try/catch
 *         right where the frame blackout flag is computed,
 *      2. announce each freshly built chunk ceiling fixtures to
 *         emergencyWiring.onChunkFixtures(cx, cz, lights) from the same
 *         per-chunk loop that feeds FaunaWiring (grouped by chunk bounds,
 *         not one flat dump),
 *      3. reset() the wiring in beginRun() so a fresh expedition starts
 *         with no stale battery state,
 *      4. guard every touch behind null-optional + try/catch so a broken
 *         rig can never take the frame down;
 *   B. BEHAVIOR - drives the real EmergencyWiring (transpiled with the
 *      same Babylon-stub trick as emergency-wiring-test.mjs) through the
 *      exact sequence game.ts performs:
 *      construct -> ensureLights -> per-chunk onChunkFixtures ->
 *      frameUpdate(dt,false) parks dark -> frameUpdate(dt,true) pulses
 *      -> beginRun-style reset hard-offs -> next run re-binds cleanly.
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

// =========================== A. source contract ==============================

const gameSrc = fs.readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');

// guarded call helper: try { this.emergencyWiring...X } catch (e) { warn }
const guarded = (body) => new RegExp(
  'try \\{ this\\.emergencyWiring' + body + ' \\}' +
  '\\s*catch \\(e\\) \\{ console\\.warn\\(\\'[^\\']*\\', e\\); \\}');

// 1+4. frameUpdate fed with the frame blackout flag under try/catch,
// sitting AFTER the blackout computation
const frameRe = guarded('\\?\\.frameUpdate\\(dt, blackout\\);');
const boIdx = gameSrc.indexOf('const blackout = this.playtimeSec < this.blackoutUntil;');
const fuIdx = gameSrc.search(frameRe);
check('game.ts calls frameUpdate(dt, blackout) in try/catch', fuIdx !== -1);
check('frameUpdate sits after the blackout computation',
  boIdx !== -1 && fuIdx > boIdx);

// 2+4. per-chunk fixture announcement guarded in noteBuiltChunks
const feedRe = /if \(this\.emergencyWiring\) \{\s*try \{ this\.emergencyWiring\.onChunkFixtures\(cx, cz, lights\); \}\s*catch \(e\) \{ console\.warn\('[^']*', e\); \}\s*\}/;
check('noteBuiltChunks feeds onChunkFixtures(cx, cz, lights) in try/catch',
  feedRe.test(gameSrc));
// fixtures must be grouped per chunk (bbox filter), never one flat dump
check('fixtures are grouped by chunk bounds before announcing',
  gameSrc.includes('onChunkFixtures(cx, cz, lights)')
  && !gameSrc.includes('onChunkFixtures(0, 0, this.chunks.allFixtures'));

// 3+4. beginRun reset, guarded, before the director can re-arm blackouts
const resetRe = guarded('\\?\\.reset\\(\\);');
const beginRunIdx = gameSrc.indexOf('private beginRun(');
const resetIdx = gameSrc.search(resetRe);
check('beginRun resets the emergency wiring in try/catch', resetIdx !== -1);
check('reset lives inside beginRun', beginRunIdx !== -1 && resetIdx > beginRunIdx);
const pulseIdx = gameSrc.indexOf('blackoutPulse: (sec)', Math.max(resetIdx, 0));

(Showing lines 1-70 of 168. Use offset=71 to continue.)

