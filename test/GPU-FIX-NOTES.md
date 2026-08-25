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
