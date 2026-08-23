/**
 * Functional verification of the discovery/achievement tracker
 * (src/ui/tracker.ts). Two phases:
 *   A. Pure logic (checkUnlocks / progress / persistence) under Node,
 *      transpiling the TS module with vite's bundled esbuild.
 *   B. DOM behavior (toasts, Tab-hold panel, localStorage persistence)
 *      under headless Chromium.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
// esbuild ships as a pnpm-store transitive dep of vite; find it in .pnpm.
function loadEsbuild() {
  const pnpmDir = process.cwd() + '/node_modules/.pnpm';
  const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
  if (!entry) throw new Error('esbuild not found in node_modules/.pnpm');
  return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
}
const esbuild = loadEsbuild();

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// ---- transpile src/ui/tracker.ts -------------------------------------------
const src = readFileSync(process.cwd() + '/src/ui/tracker.ts', 'utf8');
const { code } = await esbuild.transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
const BUILD = process.cwd() + '/test/.tracker-build.mjs';
writeFileSync(BUILD, code + '\nif (typeof window !== \'undefined\') window.__TR__ = { Discovery, checkUnlocks, progressFor, loadUnlocked, saveUnlocked, Tracker, STORAGE_KEY, TOTAL_BEACONS, NOTE_TARGET, SURVIVOR_SECONDS }\n', 'utf8');
const buildJs = () => readFileSync(BUILD, 'utf8');

try {
  // ---- phase A: pure logic --------------------------------------------------
  const mod = await import('./.tracker-build.mjs');
  const { Discovery, checkUnlocks, progressFor, TOTAL_BEACONS, NOTE_TARGET, SURVIVOR_SECONDS } = mod;

  const ALL_IDS = Object.values(Discovery);
  check('enum has exactly 8 discoveries', ALL_IDS.length === 8, JSON.stringify(ALL_IDS));
  const expected = ['first_steps', 'first_beacon', 'half_way', 'all_beacons', 'landmark_visitor', 'note_collector', 'survivor', 'threshold_crosser'];
  check('enum members complete', expected.every((id) => ALL_IDS.includes(id)), JSON.stringify(ALL_IDS));

  const BLANK = { discoveries: 0, notesRead: 0, landmarksSeen: [], playtimeSec: 0, completed: false };

  check('blank state unlocks nothing', checkUnlocks(BLANK, []).length === 0);
  check('FIRST_STEPS at 30s', checkUnlocks({ ...BLANK, playtimeSec: 30 }, []).includes(Discovery.FIRST_STEPS));
  check('FIRST_STEPS not at 29s', !checkUnlocks({ ...BLANK, playtimeSec: 29 }, []).includes(Discovery.FIRST_STEPS));
  check('FIRST_BEACON at 1 discovery', checkUnlocks({ ...BLANK, discoveries: 1 }, []).includes(Discovery.FIRST_BEACON));

  check('HALF_WAY at 4 beacons', checkUnlocks({ ...BLANK, discoveries: 4 }, []).includes(Discovery.HALF_WAY));
  check('ALL_BEACONS only at 8',
    !checkUnlocks({ ...BLANK, discoveries: TOTAL_BEACONS - 1 }, []).includes(Discovery.ALL_BEACONS) &&
    checkUnlocks({ ...BLANK, discoveries: TOTAL_BEACONS }, []).includes(Discovery.ALL_BEACONS));

  const lm8 = ['EXECUTIVE OFFICE', 'LAUNDRY', 'CHAPEL', 'PLAYROOM', 'CANTEEN', 'ARCHIVE', 'SECURITY STATION', 'MEDICAL BAY'];
  check('LANDMARK_VISITOR needs all 8 distinct types (dupes do not count)',
    !checkUnlocks({ ...BLANK, landmarksSeen: [...lm8.slice(0, 7), lm8[0]] }, []).includes(Discovery.LANDMARK_VISITOR) &&
    checkUnlocks({ ...BLANK, landmarksSeen: lm8 }, []).includes(Discovery.LANDMARK_VISITOR));

  check('NOTE_COLLECTOR at 20 notes',
    !checkUnlocks({ ...BLANK, notesRead: NOTE_TARGET - 1 }, []).includes(Discovery.NOTE_COLLECTOR) &&
    checkUnlocks({ ...BLANK, notesRead: NOTE_TARGET + 3 }, []).includes(Discovery.NOTE_COLLECTOR));

  check('SURVIVOR at 30min',
    !checkUnlocks({ ...BLANK, playtimeSec: SURVIVOR_SECONDS - 1 }, []).includes(Discovery.SURVIVOR) &&
    checkUnlocks({ ...BLANK, playtimeSec: SURVIVOR_SECONDS }, []).includes(Discovery.SURVIVOR));

  check('THRESHOLD_CROSSER on completion', checkUnlocks({ ...BLANK, completed: true }, []).includes(Discovery.THRESHOLD_CROSSER));
  check('already-unlocked ids are never re-emitted',
    checkUnlocks({ ...BLANK, completed: true }, [Discovery.THRESHOLD_CROSSER]).length === 0);

  const full = checkUnlocks({ discoveries: 8, notesRead: 99, landmarksSeen: lm8, playtimeSec: 9999, completed: true }, []);
  check('full state unlocks all 8', full.length === 8, JSON.stringify(full));

  const p = progressFor(Discovery.NOTE_COLLECTOR, { ...BLANK, notesRead: 12 });
  check('progress hint format "12/20 notes"', p.hint === '12/20 notes', p.hint);
  check('progress clamps at max', progressFor(Discovery.NOTE_COLLECTOR, { ...BLANK, notesRead: 55 }).cur === NOTE_TARGET);
  check('survivor progress in minutes', progressFor(Discovery.SURVIVOR, { ...BLANK, playtimeSec: 600 }).hint === '10/30 min');

  // ---- phase B: DOM behavior -------------------------------------------------
  const { chromium } = require_('playwright-core');
  const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<html><head></head><body></body></html>' }));
    await page.goto('http://bmb.tracker-test/', { waitUntil: 'load' });
    await page.addScriptTag({ type: 'module', content: buildJs() });

    const dom = await page.evaluate(() => {
      const { Tracker, STORAGE_KEY } = window.__TR__;
      const t = new Tracker(document.body);
      const out = { storageKey: STORAGE_KEY };
      out.panelHiddenInitially = t.panelEl.hidden;

      // unlock two achievements -> toasts + persistence
      const fresh = t.update({ discoveries: 1, notesRead: 12, landmarksSeen: [], playtimeSec: 40, completed: false });
      out.fresh = fresh.slice().sort();
      out.toastCount = document.querySelectorAll('.bmb-ach-toast').length;
      out.toastIconPresent = !!document.querySelector('.bmb-ach-toast .bmb-toast-icon');
      out.toastTitleText = document.querySelector('.bmb-ach-toast .bmb-toast-title')?.textContent ?? '';
      out.toastDescPresent = !!document.querySelector('.bmb-ach-toast .bmb-toast-desc');
      out.savedRaw = window.localStorage.getItem(STORAGE_KEY);

      // no duplicate unlocks on subsequent updates
      out.refreshZero = t.update({ discoveries: 2, notesRead: 13, landmarksSeen: [], playtimeSec: 50, completed: false }).length;
      return out;
    });

    check('storage key is bmb-achievements', dom.storageKey === 'bmb-achievements');
    check('panel starts hidden', dom.panelHiddenInitially);
    check('update returns freshly unlocked ids',
      JSON.stringify(dom.fresh) === JSON.stringify(['first_beacon', 'first_steps']), JSON.stringify(dom.fresh));
    check('one toast per new achievement', dom.toastCount === 2, String(dom.toastCount));
    check('toast has icon area', dom.toastIconPresent);
    check('toast has title element', dom.toastTitleText.length > 0);
    check('toast has description', dom.toastDescPresent);
    const saved = JSON.parse(dom.savedRaw);
    check('unlocks persisted to localStorage as JSON array', Array.isArray(saved) && saved.length === 2, String(dom.savedRaw));
    check('no duplicate re-unlock', dom.refreshZero === 0);

    // Tab-hold panel
    await page.keyboard.down('Tab');
    await page.waitForTimeout(80);
    let panel = await page.evaluate(() => {
      const panelEl = document.querySelector('.bmb-ach-panel');
      const rows = [...document.querySelectorAll('.bmb-ach-row')];
      return {
        visible: !!panelEl && !panelEl.hidden,
        rowCount: rows.length,
        unlockedRows: rows.filter((r) => r.classList.contains('unlocked')).length,
        lockedRows: rows.filter((r) => r.classList.contains('locked')).length,
        lockedTitlesQ: rows.filter((r) => r.classList.contains('locked')).every((r) => r.querySelector('.bmb-row-title').textContent === '???'),
        noteHint: rows.filter((r) => r.classList.contains('locked')).map((r) => r.textContent).find((s) => s.includes('/20 notes')) ?? '',
        countText: document.querySelector('.bmb-ach-count')?.textContent ?? '',
      };
    });
    check('Tab-hold shows panel', panel.visible);
    check('panel lists all 8 achievements', panel.rowCount === 8, String(panel.rowCount));
    check('two bright unlocked rows', panel.unlockedRows === 2, String(panel.unlockedRows));
    check('six dimmed locked rows', panel.lockedRows === 6, String(panel.lockedRows));
    check('locked rows show ???', panel.lockedTitlesQ);
    check('locked note row shows live progress fraction', panel.noteHint.includes('13/20 notes'), panel.noteHint);
    check('count line shows 2 / 8 found', panel.countText.includes('2 / 8'), panel.countText);

    await page.keyboard.up('Tab');
    await page.waitForTimeout(60);
    panel = await page.evaluate(() => {
      const el = document.querySelector('.bmb-ach-panel');
      return { hiddenAfterRelease: !el || el.hidden };
    });
    check('panel hides on Tab release', panel.hiddenAfterRelease);

    // reload -> persistence survives
    await page.reload();
    await page.addScriptTag({ type: 'module', content: buildJs() });
    const persisted = await page.evaluate(() => {
      const { Tracker } = window.__TR__;
      const t = new Tracker(document.body);
      return t.unlocked.size;
    });
    check('unlocks survive page reload', persisted === 2, String(persisted));

    // auto-dismiss: toasts removed after ~4s
    await page.evaluate(() => {
      const { Tracker } = window.__TR__;
      window.__t2 = new Tracker(document.body);
      window.__t2.update({ discoveries: 0, notesRead: 0, landmarksSeen: ['CHAPEL'], playtimeSec: 0, completed: true });
    });
    const early = await page.evaluate(() => document.querySelectorAll('.bmb-ach-toast').length);
    await page.waitForTimeout(5200);
    const late = await page.evaluate(() => document.querySelectorAll('.bmb-ach-toast').length);
    check('toasts appear immediately', early >= 1, String(early));
    check('toasts auto-dismiss (~4s)', late === 0, String(late));
  } finally {
    await browser.close();
  }
} finally {
  rmSync(BUILD, { force: true });
}

console.log(failures === 0 ? 'TRACKER_TEST_ALL_PASS' : 'TRACKER_TEST_FAILURES=' + failures);
process.exit(failures === 0 ? 0 : 1);


