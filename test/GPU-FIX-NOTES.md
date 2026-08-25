# WORKING NOTES — Defect pair fix run (2026-08-24)

## DEFECT 1 — settings panel traps user — FIXED
- Root cause: shared `#settings-panel` host (src/ui/ui.ts buildTitle) is filled by
  game.ts with the schema-driven bmb-settings-panel whose only buttons are the four
  per-section RESETs; no dismissal existed and Escape was unbound on the title screen.
- Fix (src/ui/ui.ts):
  - BACK button added as first row of the panel (`btn` styling), closes via closeSettingsPanel().
  - openSettingsPanel()/closeSettingsPanel() centralize show/hide + reset pause-context
    repositioning; Escape keydown closes when visible (settingsPanelOpen getter).
  - Pause-menu SETTINGS now toggles through the same path.
  - src/style.css `.settings-panel` got max-height:86vh + overflow-y:auto (panel was
    taller than viewports; BACK sat above the visible top).
- Proof: test/settings-dismiss-test.mjs → all OK / SETTINGS_DISMISS_PASS on dev :5178.
  node test/settings-test.mjs still exits 0.

## DEFECT 2 — WebGPU world renders black — ROOT-CAUSED, FIXED
### Mechanism
Babylon WebGPU binds ONE uniform buffer per bound light PER SHADER STAGE (+3 fixed
bindings scene/mesh/material). src/gfx/materials.ts sets maxSimultaneousLights=16
(chunk wall/carpet/ceiling, prop, paper, puddle, stain materials; others 8).
16 lights + 3 = **19 vertex-stage UBOs > WebGPU hard limit 12**:
`GPUValidationError: The number of uniform buffers (19) in the Vertex stage exceeds
the maximum per-stage limit (12)` → render-pipeline creation rejected → EVERY world
mesh silently fails to draw → clear-color-only frames (measured 0.1–1.9/255).
WebGL has no per-stage UBO limit → unaffected.
### Fix
- src/gfx/renderclarity.ts: `WEBGPU_MAX_SIMULTANEOUS_LIGHTS = 8` (8+3=11 ≤ 12) and
  `enforceWebGPULightBudget(scene, engine)` — clamps existing materials AND installs
  scene.onNewMaterialAddedObservable so chunk-streamed/prop materials stay clamped;
  no-op on non-WebGPU engines. Returns disposer.
- src/core/game.ts init(): calls it right after createMaterials(); stores disposer in
  webgpuLightBudgetDisposer.
### Evidence trail (probes test/gpu-probe*.mjs, screenshots /tmp/bmb-gpu/)
- probe2/6/7/8: error text capture; only ≤2-light boot configs were clean pre-fix;
  live light-count toggles DON'T recover (invalid pipeline layouts are cached) → fix
  must be active before first compile (it is: installed at init).
- post-fix: validation errors 0 (webgpu-acceptance.mjs TORCH maxSimulLights=[8,4]).
- A/B same-protocol (probe11, long settle, torch ON):
  - BEFORE fix WebGPU: 0.10–1.9 brightness, drawCalls=1, fps 0–11.
  - AFTER fix: webgpu avgFull=2.35 centerAvg=3.88 p99=26 vs webgl avgFull=2.27
    centerAvg=3.02 p99=26 → backend parity restored (WebGPU slightly brighter).
  - One post-fix webgpu sample hit centerAvg 17.66 (≥15 target) — spawn-dependent.
### Caveats / honest limits
- Headless absolute brightness (~2–4/255 typical, both backends) is dominated by
  scene darkness + vignette + grain + headless compositing; the ≥15 cone target is
  reachable but seed/spawn-dependent (17.66 observed). Flash F-delta on WebGL ref
  measured +1.52 (probe14) — direction correct on reference too.
- Shared-box load (other writer's Voltline suite, load avg >400) made late probes
  flaky; parity numbers above are from quiet windows.
- probe13's aim failed because world meshes aren't isPickable; probe14 aimed at floor.

## PENDING AT SAVE TIME
- Gates blocked by machine load: tsc/playthrough/run-all must be run when Voltline
  suite quiets down. tsc passed earlier (TSC_OK) before the other writer's last edits.
- Commits NOT yet made. Stage ONLY:
  - D1: src/ui/ui.ts, src/style.css, test/settings-dismiss-test.mjs
  - D2: src/gfx/renderclarity.ts, src/core/game.ts, test/webgpu-acceptance.mjs
  (game.ts also carries another writer's StomachAudio work — coordinate before
  staging game.ts! Consider `git add -p` hunk selection.)
- After commits: push origin+github (fetch/rebase-retry ≤5x), rebuild dist, re-smoke :4178.
- Probe files test/gpu-probe*.mjs + gpu-parity.mjs are working notes, not committed.

## ADDENDUM — v1.0.1 regression hunt (2026-08-25)

Report: "c8bdc82 measures 5.4 GOOD; current main measures 1.9 BLACK-ish; bisect
it." Findings from the automated bisect (c8bdc82..bc003c2, production builds,
title-click probe) plus instrumented probes:

### The bisect signal was a metric artifact, not a render change
- First bad commit: **1074d8d** (F2 central mounts). Parent e8e1f9a = B=5.3;
  1074d8d = B=1.6. Reproduced three times.
- Mechanism: applyRenderClarity() defaults film grain OFF and hides the
  #bmb-grain-overlay CSS node. That overlay is opacity-0.04 ~50%-gray noise
  and contributes ≈ +3.7 to whole-frame average luminance over an empty
  clear-color canvas. Every commit BEFORE 1074d8d measured "bright" only
  because the grain overlay sat on top of a black world.
- Proof: e8e1f9a with the overlay hidden pre-start reads B=1.6 — identical to
  post-1074d8d "black" readings. Disabling every scene mutation inside
  applyRenderClarity individually and together changed nothing; removing the
  call restored 5.3 (the overlay stayed visible).

### The real black screen predates c8bdc82 and is already fixed on main
- At c8bdc82 AND its parent, WebGPU throws 23-27x
  `GPUValidationError: number of uniform buffers (19) in the Vertex stage
  exceeds the maximum per-stage limit (12)` (materials at
  maxSimultaneousLights=16 + 3 fixed bindings) — pipelines rejected, world
  draws clear-color only. This is DEFECT 2 above; it simply predates the
  reported "good" commit.
- Fixed mid-wave by **8b2a903** (enforceWebGPULightBudget clamp to 8).
  Current main (bc003c2): 0 validation errors, WebGPU engine active, 200+
  streamed meshes. Backend parity confirmed against the WebGL control on the
  same build (WebGPU mean 2.8-3.9 vs WebGL 3.3).

### Why the gate no longer uses a brightness threshold
Composite-screenshot luminance cannot distinguish broken from healthy here:
the dark-by-design scene plus DOM overlays dominate it. Measured on fixed
seed 'gate': healthy build B=2.8/p99=54; broken build B=5.3/p99=64 (grain-era
overlay over black world); broken-with-hidden-overlay B=1.6. Load also skews
streaming (quiet-window readings run brighter than load-35 windows).
test/webgpu-gate.mjs therefore asserts the failure class directly:
WebGPU engine active + ZERO GPUValidationErrors during boot/play + >100
active meshes; brightness is printed as information only. Verified PASS x2 on
main and FAIL (exit 1, errors=26) against the pre-fix build.
