/* Minimap regression checks (static source assertions).
 *
 * Verifies src/ui/minimap.ts implements:
 *   1. canvas rendering — 150x150, top-right HUD placement, translucent bg
 *   2. explored chunks  — markVisited dark squares, lighter current chunk
 *   3. player marker    — yaw-oriented triangle at map center
 *   4. landmarks        — cyan dots via markLandmark(x, z, name)
 *   5. beacons          — pulsing white in-range dots via markBeacon(x, z)
 *   6. toggle           — M key + toggle(), starts hidden
 *
 * Run: node test/minimap-test.mjs   (no server or browser required)
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const src = readFileSync(ROOT + 'src/ui/minimap.ts', 'utf8');

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? '  ok  ' : ' FAIL ') + name);
  if (!cond) failures++;
};

console.log('[1] canvas rendering');
check('canvas is exactly 150x150', /width = SIZE/.test(src) && /height = SIZE/ .test(src) && /const SIZE = 150/.test(src));
check('anchored top-right of HUD container', /top = '10px'/.test(src) && /right = '10px'/.test(src));
check('positioned absolutely over the HUD', /position = 'absolute'/.test(src));
check('semi-transparent background fill', /fillStyle = 'rgba\(6, 8, 6, 0\.72\)'/.test(src));
check('uses pure Canvas 2D context', /getContext\('2d'\)/.test(src));
check('redraws every update call', /update\(px: number, pz: number, yaw: number\)/.test(src));

console.log('[2] explored chunk tracking');
check('markVisited(cx, cz) API present', /markVisited\(cx: number, cz: number\)/.test(src));
check('visited chunks stored in a Set keyed by cx,cz', /new Set<string>\(\)/.test(src) && /cx \+ ',' \+ cz/.test(src));
check('visited chunks drawn as dark squares', /rgba\(90, 110, 90, 0\.35\)/.test(src));
check('current chunk drawn lighter', /rgba\(150, 175, 150, 0\.45\)/.test(src));
check('current chunk derived from player position', /Math\.floor\(px \/ CHUNK_SIZE\)/.test(src));

console.log('[3] player marker');
check('triangle path drawn for the player', /moveTo\(c \+ fx \* nose/.test(src) && /closePath\(\)/.test(src));
check('orientation follows yaw forward vector (-sin, -cos)', /-Math\.sin\(this\.yaw\)/.test(src) && /-Math\.cos\(this\.yaw\)/.test(src));
check('marker centered on the map each frame', /update.*\{[\s\S]*?this\.px = px/.test(src));

console.log('[4] landmark markers');
check('markLandmark(x, z, name) API present', /markLandmark\(x: number, z: number, name: string\)/.test(src));
check('landmarks stored with names', /landmarks\.push\(\{ x, z, name \}\)/.test(src));
check('cyan dot fill', /#00e5ff/.test(src));

console.log('[5] beacon markers');
check('markBeacon(x, z) API present', /markBeacon\(x: number, z: number\)/.test(src));
check('beacons pulse over time', /Math\.sin\(t \* 4\)/.test(src) && /globalAlpha = pulse/.test(src));
check('white fill for beacons', /'#ffffff'/.test(src));
check('only unfound beacons within range shown', /BEACON_RANGE \* BEACON_RANGE/.test(src) && /continue;/.test(src));

console.log('[6] visibility toggle');
check('starts hidden', /display = 'none'; \/\/ starts hidden/.test(src));
check('M key toggles visibility', /key === 'm' \|\| e\.key === 'M'/.test(src) && /keydown/.test(src));
check('public toggle() method', /toggle\(\): void/.test(src));
check('toggle flips display block/none', /visible \? 'block' : 'none'/.test(src));


(Showing lines 1-60 of 61. Use offset=61 to continue.)

