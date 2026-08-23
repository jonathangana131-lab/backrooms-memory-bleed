/* UI polish regression checks (static source assertions).
 *
 * Verifies src/ui/ui.ts implements:
 *   1. ending screen — staggered fade (500ms), pulsing separator, SEED hex stamp
 *   2. toast queue   — max 3 visible, older fade faster, slide-in from right
 *   3. subtitles     — text-shadow, italic serif, letter-spacing 0.02em
 *   4. loading       — "RECONSTRUCTING" + animated dots between click and HUD
 *   5. battery HUD   — red pulse <20%, torch icon dims when off
 *
 * Run: node test/ui-polish.mjs   (no server or browser required)
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const src = readFileSync(ROOT + 'src/ui/ui.ts', 'utf8');

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? '  ok  ' : ' FAIL ') + name);
  if (!cond) failures++;
};

console.log('[1] ending screen');
check('per-line stagger index (--i) set on each paragraph', /p\.style\.setProperty\('--i'/.test(src));
check('500ms stagger via CSS var delay', /calc\(var\(--i,\s*0\)\s*\*\s*0\.5s\)/.test(src));
check('ending fade keyframes exist', /@keyframes bmbEndingFade/.test(src));
check('pulsing separator element', /className = 'ending-sep'/.test(src));
check('separator pulse animation defined', /@keyframes bmbSepPulse/.test(src));
check('seed stamp element with monospace class', /className = 'ending-seed'/.test(src));
check('seed stamp shows hex fingerprint', /SEED '\s*\+\s*this\.seedHex\(\)/.test(src));
check('seedHex returns 0x-prefixed hex', /return '0x' \+/.test(src));

console.log('[2] toast queue');
check('max visible toasts capped at 3', /MAX_TOASTS = 3/.test(src));
check('hard cap enforcement method', /enforceToastLimit/.test(src));
check('new toasts start offset to the right', /translateX\(64px\)/.test(src));
check('slide-in transition on arrival', /cubic-bezier/.test(src));
check('older toasts decay sooner (lifetime compression)', /\* 0\.65/.test(src));
check('older toasts fade faster (shrinking fade duration)', /Math\.max\(0\.15,\s*0\.6 - rank \* 0\.15\)/.test(src));

console.log('[3] subtitle styling');
check('italic serif font family', /fontFamily = "Georgia, 'Times New Roman', serif"/.test(src));
check('italic style applied', /fontStyle = 'italic'/.test(src));
check('letter-spacing 0.02em', /letterSpacing = '0\.02em'/.test(src));
check('layered text-shadow for readability', /textShadow =[\s\S]*?rgba\(0,\s*0,\s*0/.test(src));

console.log('[4] loading indicator');
check('RECONSTRUCTING label shown on new expedition', /showReconstructing\(\)/.test(src) && /RECONSTRUCTING/.test(src));
check('animated dots interval', /loadingDotsTimer = setInterval/.test(src));
check('dots cycle . .. ...', /'\.'\.repeat\(dots\)/.test(src));
check('hidden once HUD renders', /showHud\(\)[\s\S]*?hideReconstructing\(\)/.test(src));
check('safety timeout prevents stuck loader', /loadingSafetyTimer = setTimeout/.test(src));

console.log('[5] battery / torch HUD');
check('critical pulse below 20%', /v < 0\.2/.test(src) && /critical/.test(src));
check('red pulse keyframes defined', /@keyframes bmbBattCritical/.test(src));
check('torch icon element created', /torch-icon/.test(src));
check('torch icon is an SVG flashlight', /<svg viewBox="0 0 24 24"/.test(src));
check('icon dims when torch off (lit class toggle)', /torchIcon\.classList\.toggle\('lit',\s*this\.torchOn && v > 0\)/.test(src));
check('lit state carries glow filter', /drop-shadow/.test(src));

(Showing lines 1-60 of 66. Use offset=61 to continue.)

