/* F100 motion-safety follow-up: credits walk gate + skip verification.
 *
 * Browser tier (playwright-core against the dev/preview server):
 *   Phase A — motion safety OFF (default):
 *     A1 ending -> credits state mounts the auto-scrolling column
 *     A2 the column actually scrolls (transform advances)
 *     A3 any press skips straight to the title (natural-finish hand-off)
 *   Phase B — motion safety ON (via the canonical settings store):
 *     B1 ending -> credits state mounts NO scrolling column
 *     B2 keys are inert while no walk is mounted (state stays 'credits')
 *     B3 RETURN TO TITLE still exits into the debrief/title
 *   Plus: __BMB__.skipCreditsWalk harness hook exists.
 *
 * Run: node test/creditswalk-safety-test.mjs   (prints CREDITS_SAFETY ALL PASS, exit 0)
 */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 200)));

// Patient boot: domcontentloaded + __BMB__ flag (networkidle never settles).
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 300000 });

const startRunAndDismissWake = async (seed) => {
  await page.evaluate((s) => (window).__BMB__.startNew(s), seed);
  await page.waitForTimeout(1500);
  // Dismiss the F91 wake cinematic, then poll until the controller owns
  // the camera again (SwiftShader sim time lags wall time).
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    if (g.wakePlaying ? g.wakePlaying() : false) g.dismissWakeCinematic();
  });
  await page.waitForFunction(() => {
    const g = (window).__BMB__.game;
    return !!g.player && g.player.enabled === true && !g.wakeMount;
  }, null, { timeout: 180000 });
};

/** Drive a live run into the credits state via the real ending path. */
const enterEnding = async () => {
  await page.evaluate(() => { (window).__BMB__.game.triggerEnding(); });
  // triggerEnding holds a 1400 ms whiteout beat before setState('credits'),
  // and beginCreditsWalk resolves the gallery asynchronously after that.
  await page.waitForFunction(() => {
    const g = (window).__BMB__.game;
    return g.state === 'credits' || document.getElementById('bmb-creditswalk') !== null;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(1200); // let loadShots().then(raiseCreditsOverlay) settle
};

console.log('0. harness hook surface');
{
  const hooks = await page.evaluate(() => ({
    skip: typeof (window).__BMB__.skipCreditsWalk,
    game: typeof (window).__BMB__.game,
  }));
  ok(hooks.game === 'object' && hooks.skip === 'function', '__BMB__.skipCreditsWalk exposed');
}

// ---------------------------------------------------------------------------
console.log('1. Phase A — motion safety OFF: column mounts, scrolls, skips');
await startRunAndDismissWake('credsafe-a');
await enterEnding();

{
  const mounted = await page.evaluate(() => {
    const el = document.getElementById('bmb-creditswalk');
    return { present: el !== null, state: (window).__BMB__.game.state };
  });
  ok(mounted.present && mounted.state === 'credits',
    'A1 scroll column mounted in credits state (state=' + mounted.state + ')');

  const t0 = await page.evaluate(() =>
    document.getElementById('bmb-creditswalk')?.querySelector('div[style*="will-change"]')?.style.transform ?? null);
  await page.waitForTimeout(900);
  const t1 = await page.evaluate(() =>
    document.getElementById('bmb-creditswalk')?.querySelector('div[style*="will-change"]')?.style.transform ?? null);
  ok(t0 !== null && t1 !== null && t0 !== t1,
    'A2 column scrolls between samples (' + String(t0) + ' -> ' + String(t1) + ')');

  await page.keyboard.press('Space');
  const skipped = await page.waitForFunction(() => {
    const g = (window).__BMB__.game;
    return g.state === 'menu' && document.getElementById('bmb-creditswalk') === null;
  }, null, { timeout: 10000 }).then(() => true, () => false);
  ok(skipped, 'A3 any-key skip hands off to the title');
}

// ---------------------------------------------------------------------------
console.log('2. Phase B — motion safety ON via canonical settings store');
await startRunAndDismissWake('credsafe-b');
await page.evaluate(() => { (window).__BMB__.game.settingsManager.set({ motionSafety: true }); });
await page.waitForFunction(() => {
  const g = (window).__BMB__.game;
  return !!g.a11yPack && g.a11yPack.options.motionSafety === true;
}, null, { timeout: 15000 });
await enterEnding();

{
  const st = await page.evaluate(() => ({
    present: document.getElementById('bmb-creditswalk') !== null,
    state: (window).__BMB__.game.state,
    walker: (window).__BMB__.game.creditsWalker !== null && (window).__BMB__.game.creditsWalker !== undefined,
  }));
  ok(st.state === 'credits' && !st.present && !st.walker,
    'B1 no scroll column / walker under motion safety (state=' + st.state + ')');

  await page.keyboard.press('KeyW');
  await page.waitForTimeout(600);
  const still = await page.evaluate(() => (window).__BMB__.game.state);
  ok(still === 'credits', 'B2 keys inert without a mounted walk (state=' + still + ')');

  // The static ending overlay must still offer its exit into the debrief.
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent === 'RETURN TO TITLE');
    if (!b) return false;
    b.click();
    return true;
  });
  const exited = await page.waitForFunction(() => {
    const g = (window).__BMB__.game;
    const title = document.querySelector('.title-screen');
    return g.state === 'menu' &&
      title && getComputedStyle(title).display !== 'none';
  }, null, { timeout: 10000 }).then(() => true, () => false);
  ok(clicked && exited, 'B3 RETURN TO TITLE exits cleanly under motion safety');
}

await browser.close();
if (failures === 0) {
  console.log(`CREDITS_SAFETY ALL PASS (${check} checks)`);
} else {
  console.error(`CREDITS_SAFETY FAILED (${failures}/${check} failed)`);
  process.exit(1);
}
