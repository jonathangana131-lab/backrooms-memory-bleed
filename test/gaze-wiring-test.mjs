/**
 * Gaze wiring tests.
 *
 * Self-contained harness: no test runner is configured in this repo,
 * so this script transpiles the two entity modules with the local
 * TypeScript compiler into a temp dir and imports the plain JS.
 *
 * Run: node test/gaze-wiring-test.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// --- transpile src/entities/{gaze,gaze-wiring}.ts to temp JS ---
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "gaze-wiring-test-"));
for (const name of ["gaze", "gaze-wiring"]) {
  const srcPath = join(root, "src", "entities", name + ".ts");
  const src = require("node:fs").readFileSync(srcPath, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outPath = join(outDir, name + ".mjs");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
}
const { GazeWiring } = await import(pathToFileURL(join(outDir, "gaze-wiring.mjs")).href);
const { GazeController } = await import(pathToFileURL(join(outDir, "gaze.mjs")).href);

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log("ok - " + label);
  } else {
    failures++;
    console.error("FAIL - " + label);
  }
}

// --- 1. getOffset is undefined before any update / after detach ---
{
  const w = new GazeWiring();
  w.attach("a", new GazeController());
  check("getOffset undefined before first updateAll", w.getOffset("a") === undefined);
  w.detach("a");
  check("getOffset undefined after detach", w.getOffset("a") === undefined);
}

// --- 2. updateAll drives every attached controller and stores offsets ---
{
  const w = new GazeWiring();
  w.attach("h1", new GazeController({ watcher: true, seed: 1 }));
  w.attach("h2", new GazeController({ seed: 2 }));
  const results = w.updateAll(1 / 60, 3, 0); // player close to origin figure
  check("updateAll returns Map with one entry per id", results instanceof Map && results.size === 2);
  for (const id of ["h1", "h2"]) {
    const v = results.get(id);
    check(
      "offset for " + id + " is a finite number matching getOffset",
      typeof v === "number" && Number.isFinite(v) && v === w.getOffset(id)
    );
  }
  // Second frame: stored offsets refresh.
  const again = w.updateAll(1 / 60, 3, 0);
  check("getOffset tracks latest updateAll result", again.get("h1") === w.getOffset("h1"));
}

// --- 3. offsets match calling GazeController.update directly ---
{
  const w = new GazeWiring();
  const direct = new GazeController({ watcher: true, seed: 7 });
  w.attach("fig", new GazeController({ watcher: true, seed: 7 }));
  let directOffset;
  for (let i = 0; i < 30; i++) {
    directOffset = direct.update(1 / 60, 4, 0, 0, 0, 0);
    w.updateAll(1 / 60, 4, 0);
  }
  check(
    "wired offset equals direct controller update",
    w.getOffset("fig") === directOffset
  );
}

// --- 4. attach replaces, dispose clears everything ---
{
  const w = new GazeWiring();
  w.attach("x", new GazeController());
  w.attach("x", new GazeController()); // replace, not duplicate
  w.updateAll(1 / 60, 5, 5);
  check("single entry after re-attach of same id", w.updateAll(1 / 60, 5, 5).size === 1);
  w.dispose();
  check("dispose clears cached offsets", w.getOffset("x") === undefined);
}

if (failures > 0) {
  console.error(failures + " failure(s)");
  process.exitCode = 1;
} else {
  console.log("all gaze-wiring tests passed");
}


