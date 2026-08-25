# Integration Status Report — BACKROOMS: MEMORY BLEED

Generated: 2026-08-24 · Scope: src/{audio,director,entities,gfx,memory,player,story,ui,world} vs main game loop src/core/game.ts (+ chunk build path src/world/chunkManager.ts)
Method: grep of committed `HEAD` imports in `src/core/game.ts` cross-checked for real usages, plus the ChunkManager chunk build path (F24 aging ledger fold, F56 map-fragment scatter). **This file tracks docs only — no source files modified here.**

## Summary

| Status | Count | Meaning |
|---|---|---|
| WIRED (direct) | 96 module files | Imported and used by `src/core/game.ts` at main (35782b0) |
| WIRED (chunk build path) | +2 module files | `world/aging.ts` and `world/seasonrooms.ts` mounted into ChunkManager's chunk build path |
| UNWIRED | remainder | Implemented with passing tests but not yet reachable from game.ts or the chunk build path |

The 2026-06-era picture ("83% unwired") is obsolete: mount batches A-E alone moved ~25 modules onto the loop, including the entire audio ambience pack, journal/tracker/compass/minimap UI cluster, PostFX, day cycle, and the player-state systems below.

## Mount batches landed on main

- **Batch A** (`src/core/game.ts`): render clarity (`gfx/renderclarity`), player breath (`audio/breath`), area identity beds (`audio/areaidentity`).
- **Batch B** (862b229, `src/core/game.ts`): tremor (`player/tremor`), blinks (`player/blinks`), adrenaline (`player/adrenaline`), hunger (`player/hunger`), flicker battery (`player/flickerbattery`).
- **Batch C** (1437452, `src/core/game.ts`): gossip (`entities/gossip`), lying compass (`ui/lyingcompass`), journal font (`ui/journalfont`).
- **Chunk build path** (5ef8f59, 8d6a289, `src/world/chunkManager.ts`): F24 aging ledger fold + F56 map-fragment paper scatter.
- **Batch D** (a30f0b7, `src/world/chunkManager.ts`): F57 seasonal bleed rooms wired into landmark chunk builds.
- **Batch E** (35782b0, `src/core/game.ts`): F50 exit-that-isn't mount — ExitVoidTracker fed from frame-loop doorway crossings into the epilogue flow.

Feature-by-feature SHIPPED marks live in [GAME-PLAN.md](GAME-PLAN.md).

## Historical snapshot (2026-08-23)

The per-module WIRED/REACHABLE/UNWIRED listings below were generated against an older main and are superseded by the counts above; many "unwired" entries in sections 3 have since been mounted (doors, crowd, groans, loresting, batterycue, vents, echoes, fanaudio, postfx, daycycle, fogvariation, cracks, stains-growth, graffiti-evolution, minimap, compass, weatherui, journal cluster, tracker cluster, savescreen, gallery, endcapture, endstats, hints, settings/settingspanel/accessibility, checkpoints, beats, reread, watcherintro, gaze cluster, faunawiring). They are kept for provenance only.

## 1. WIRED — imported & used by src/core/game.ts

All of these are both imported *and* instantiated/invoked in the Game class:

### audio/
- audio/audio.ts — `AudioEngine` (core audio; field-initialized, updated every frame)
- audio/approach.ts — `WatcherSteps` (lazy ctx-gated; updated in frame())
- audio/exterior.ts — `ExteriorBleed` (lazy ctx-gated; weather/tension driven)
- audio/music.ts — `DynamicScore` (lazy ctx-gated; zone + tension driven)
- audio/positional.ts — `PositionalHum` (per-fixture hum voices)
- audio/surfaces.ts — `SurfaceFootsteps` (footstep material layering)

### entities/
- entities/humans.ts — `HumanFigure` (type-only import: `HumanType`; runtime figures flow through HumanManager)
- entities/manager.ts — `HumanManager` (spawn/update/proximity in frame loop)

### gfx/
- gfx/dust.ts — `DustMotes`
- gfx/lighting.ts — `LightingRig`
- gfx/materials.ts — `createMaterials` / `MaterialSet`

### story/
- story/story.ts — `StorySystem` (beacons, stages, serialization)

### ui/
- ui/ui.ts — `UI` (HUD, menus, subtitles, log)

### world/
- world/chunkManager.ts — `ChunkManager`
- world/collision.ts — `moveCircle`, `hasLineOfSight`
- world/constants.ts — `CELL`, `worldToChunk`

## 2. REACHABLE — indirect only

- world/architect.ts — via ChunkManager
- world/mesher.ts — via ChunkManager

These run in-game but only because a wired dependency imports them.

## 3. UNWIRED — never reachable from src/core/game.ts

Each entry lists exported classes/factories (grep pattern `^export class|^export function create`). "Chain" notes mean the file is referenced only by other orphan files, forming dead clusters.

### audio/ (14 unwired)
| File | Exports | Notes |
|---|---|---|
| batterycue.ts | `BatteryCues` | orphan |
| boundaries.ts | `BoundaryCue` | orphan |
| crowd.ts | `CrowdAmbience` | orphan |
| doors.ts | `DoorCreaks` | orphan |
| echoes.ts | `EchoSites` | orphan |
| emzones.ts | `EMZones` | orphan |
| fanaudio.ts | `FanAudio` | orphan (would pair with gfx ceiling fans) |
| groans.ts | `StructureGroans` | orphan |
| humharmonics.ts | `HumHarmonics` | orphan |
| humspatial.ts | `HumSpatial` | orphan |
| landmarkbreath.ts | `LandmarkBreath` | orphan |
| loresting.ts | `LoreStings` | orphan |
| radio.ts | `RadioChatter` | orphan (name appears as a comment in crowd.ts; no real import) |
| surface-wiring.ts | `SurfaceWiring` | orphan — its purpose (wiring footsteps) was instead done inline in game.ts |

### entities/ (12 unwired)
| File | Exports | Notes |
|---|---|---|
| avoidance.ts | `PropAvoidance` | orphan |
| entitysurfaces.ts | `EntitySurfaces` | orphan |
| fauna.ts | `FaunaManager`, `Roach`, `DustDevil`, `Moth` | orphan |
| fidgets.ts | `IdleFidgets` | orphan |
| gaze-wiring.ts | `GazeWiring` | chain root: gaze-wiring → gaze |
| gaze.ts | `GazeController` | only used by unwired gaze-wiring.ts |
| graceful.ts | (helpers) | orphan |
| schedules.ts | `PatrolSchedule` | orphan |
| sitting.ts | `SittingBehavior` | orphan |
| spawneffects.ts | (helpers) | orphan |
| vocalcontent.ts | (data) | orphan |
| vocals.ts | `EntityVocals`, `HumVoice`, `MutterVoice` | orphan |

### gfx/ (21 unwired)
| File | Exports | Notes |
|---|---|---|
| ceilingfan.ts | `CeilingFan` | only used by unwired fanwiring.ts |
| cornerao.ts | `CornerAO` | only used by unwired moisture.ts |
| crossfade.ts | `BoundaryCrossfade` | orphan |
| daycycle.ts | `DayCycle` | orphan |
| doorstyles.ts | (factories/helpers) | orphan |
| drips.ts | `CeilingDrips` | orphan |
| fanwiring.ts | `FanWiring` | chain root: fanwiring → ceilingfan |
| flickevents.ts | `FlickerEvents` | orphan |
| fogvariation.ts | `createFogVariation` | orphan |
| footprints.ts | `Footprints` | orphan |
| lightpools.ts | `LightPools` | orphan |
| moisture.ts | `createWallMoisture` | chain root: moisture → cornerao |
| notepaper.ts | `NotePaper` | orphan |
| paperflutter.ts | `PaperFlutter` | orphan |
| postfx.ts | `PostFX` | orphan |
| projections.ts | (helpers) | orphan |
| reflections.ts | `WetReflections` | orphan |
| shadows.ts | `TorchShadows` | orphan |
| sway.ts | `FixtureSway` | orphan |
| tiledisplace.ts | (helpers) | orphan |

### story/ (7 unwired)
| File | Exports | Notes |
|---|---|---|
| beats.ts | `StoryBeats` | orphan |
| checkpoints.ts | `CheckpointManager` | orphan |
| firstwatcher.ts | `FirstWatcher` | orphan |
| journal-feed.ts | `JournalFeed` | only used by unwired journal-wiring.ts |
| journal-wiring.ts | `JournalWiring` | chain root: journal-wiring → journal-feed → ui/journal |
| reread.ts | `NoteReread` | orphan |
| watcherintro.ts | `WatcherIntroController` | orphan |

### ui/ (17 unwired)
| File | Exports | Notes |
|---|---|---|
| accessibility.ts | `AccessibilityManager`, `AccessibilityController` | only used by unwired settingspanel.ts |
| compass.ts | `Compass` | orphan (name string appears in doors/vocalcontent comments only) |
| endcapture.ts | `EndCapture` | orphan — endings are handled inline in game.ts triggerEnding() |
| endstats.ts | `EndStats` | orphan |
| gallery.ts | `PhotoGallery` | orphan (references UI type in a comment/type sense only) |
| highlight.ts | `InteractionHighlighter` | orphan |
| hints.ts | `DifficultyHints` | orphan (references UI type only) |
| journal.ts | `Journal` | only used by unwired journal-feed.ts |
| minimap.ts | `Minimap` | orphan |
| radiotune.ts | `RadioTuner`, `createWebAudioStatic`, `WebAudioStatic` | orphan |
| savescreen.ts | `SaveScreen` | orphan — saves go straight to SaveDB from game.ts |
| settings.ts | `SettingsManager` | only used by unwired accessibility/settingspanel |
| settingspanel.ts | (panel) | chain root: settingspanel → accessibility → settings |
| tracker-wiring.ts | `TrackerFeed` | chain root: tracker-wiring → tracker |
| tracker.ts | `Tracker` | only used by unwired tracker-wiring.ts |
| weatherui.ts | `WeatherUI` | orphan |
| whispercue.ts | `WhisperCue`, `WhisperCueState` | orphan |

### world/ (10 unwired)
| File | Exports | Notes |
|---|---|---|
| ceiling-details.ts | (helpers) | orphan |
| cracks.ts | `createWallCracks` | orphan |
| graffiti-evolution.ts | `createGraffitiEvolution` | orphan |
| neonsign.ts | `NeonSign`, `createNeonBuzz` | orphan |
| placement-expansion.ts | (helpers) | only used by unwired vignettes.ts |
| radiogeometry.ts | `RadioGeometry` | only used by unwired radioprops.ts |
| radioprops.ts | `RadioProps` | chain root: radioprops → radiogeometry |
| staindrips.ts | `StainDripSync` | orphan |
| stains-growth.ts | `createStainGrowth` | orphan |
| vignettes.ts | (helpers) | chain root: vignettes → placement-expansion |

## Observations

1. **Wiring pattern divergence.** Wired systems are constructed inside `Game.init()` / `beginRun()` or lazily via `ensureAudioIntegrations()`. Several dedicated "*-wiring" modules (`SurfaceWiring`, `GazeWiring`, `FanWiring`, `JournalWiring`, `TrackerFeed`) were built as integration glue but were themselves never instantiated — their jobs were either re-implemented inline in game.ts (footsteps) or left undone (gaze, fans, journal, tracker).
2. **Feature duplication risk.** Inline implementations in game.ts overlap with unwired modules: ending sequence (`triggerEnding()`) vs ui/endcapture.ts + ui/endstats.ts; landmark discovery lines vs story/beats.ts; save/settings handling vs ui/savescreen.ts + ui/settings.ts.
3. **Whole feature tiers missing at runtime:** ambient fauna (entities/fauna.ts), entity vocals/gaze/schedules, post-processing (gfx/postfx.ts), day/night cycle, weather UI, minimap/compass, photo gallery, radio props + tuner — all fully implemented but invisible to players.
4. **No test coverage bridges the gap:** nothing under test/ imports the orphan modules either.

## Recommended wiring order (highest player impact first)

1. gfx/postfx.ts (`PostFX`) — single attach point after scene setup.
2. ui/minimap.ts + ui/compass.ts — feed from existing player position in frame().
3. entities/fauna.ts (`FaunaManager`) — tick alongside `this.humans.update(dt, ...)`.
4. entities/vocals.ts + gaze cluster via `GazeWiring` — enrich existing HumanManager figures.
5. story/journal-wiring.ts + ui/journal.ts — replace/augment the inline TAB expedition log.
6. Audio ambience pack: emzones, doors, crowd, radio, groans — same lazy ctx-gated pattern as `ensureAudioIntegrations()`.
7. gfx/daycycle.ts + ui/weatherui.ts — hooks already exist via `MemoryWeather`.

## Progress log

- 2026-08-24 (F91 v1.1 debt): wake cinematic mounted for real — `src/story/wakemount.ts` `WakeMount` driver + `game.ts` `beginWakeSequence()` plays the seeded waking shots at every fresh-run start before control hands off (any key/click or `__BMB__.dismissWakeCinematic` dismisses into the existing rise; motion-safety keeps the plain rise; beginRun aborts stale mounts). Evidence: test/wakemount-test.mjs 34/0, PLAYTHROUGH_PASS PAGE_ERRORS=0, interaction-matrix/save-stress/full-persist/console-audit green, pnpm build green. Next step: V1.1 debt bullet "Stomach audio stand-in" — growl synth consuming `drainEvents()` (src/audio hungerpangs-consumer ← src/player/hungerpangs.ts), ranked highest value-per-effort in the 2026-08-24 debt audit.
- 2026-08-24 (F73 v1.1 debt): stomach audio landed — `src/audio/hungerpangs-consumer.ts` (`StomachAudio`, pure `planGrowl()`; falling-pitch sawtooth rumble → resonant lowpass, intensity-graded peak/brightness, seeded gurgle dips, per-voice failure islands) wired into game.ts: field + ensureAudioIntegrations failure island + frame-loop drain site now feeds drained pang events to the synth with the >= 20 s HUNGER caption kept as muted fallback. Evidence: node test/hungerpangs-consumer-test.mjs 43/0 ALL PASS; pnpm typecheck+build green; interaction-matrix 6/6 PASS and console-audit errors=0 with the wiring live. BLOCKER (environmental, pre-existing at clean HEAD): after ~15:32 this session the box took a huge load spike and headless Chrome-for-Testing now gets SIGKILLed at launch, so the 480x270-viewport suites (save-stress, full-persist-test) cannot currently boot `__BMB__`; retry them when the environment recovers. Gate nuance: typecheck+build went green on this increment's code, after which only ONE comment line in hungerpangs-consumer.ts changed; the 43/0 suite imported those exact final bytes, but the tsc/vite re-run could not complete inside the degraded window — re-run `pnpm run typecheck && pnpm run build` as step zero of the next mission. Next step: V1.1 debt bullet "F95 hardcore flicker battery" — settingspanel/a11y schema toggle wired to `setHardcore` (src/ui/settingspanel.ts ← src/player/flickerbattery.ts), headless-verifiable while the browser env is degraded.
- 2026-08-24 (F95 v1.1 debt): hardcore flicker battery toggle landed end-to-end — canonical `hardcoreBattery` boolean in GameSettings (persisted via validateSettings, src/ui/settings.ts) surfaced as a HARDCORE BATTERY toggle row in the VISUALS section (src/ui/settingspanel.ts mirror defaults + defaultSections); game.ts routes settings-store changes through new `applyHardcoreBattery()` onto `FlickerBattery.setHardcore`, re-applies the persisted mode in beginRun, samples the seeded per-tick drive every playing frame into NEW Flashlight external fields `flickerCut`/`flickerDim` (cut parks the light like torch-off, dim scales brightness, junk dim falls back to identity), and suppresses the HUD battery readout while `hudSuppressed`. The battery's frames now have a real consumer for the first time. Evidence: test/f95-hardcore-toggle-test.mjs 33/33 ALL PASS (schema/store/battery/NullEngine-torch/wiring stages); FLICKERBATTERY 32 checks ALL PASS; settings-persist 26/0; pnpm typecheck green (incl. re-run closing the F73 gate nuance) and pnpm build green (664 modules, 6m50s under load avg ~900); boot probe on served dist: PAGE_ERRORS=0, __BMB__ ready (~220 s under load). PRE-EXISTING FAILURES ATTRIBUTED TO CLEAN HEAD (git worktree build 5acb345 + serve on :4179): test/settings-test.mjs FOV_BAD (camFovRad 1.063 vs expected 1.92 — F91 wake cinematic owns camera fov after startNew until dismissed; test predates the handoff) and SUBS_BAD (ui.say renders with ui.subtitlesOn=false — suppression seam). test/settings-test.mjs goto hardened to patient boot (domcontentloaded + 300 s __BMB__ wait; networkidle can never settle under load). Next step: fix the SUBS_BAD suppression seam (ui.say vs subtitlesOn/a11y pack, src/ui/ui.ts) then update settings-test.mjs to dismiss the wake cinematic before FOV assertions.
- 2026-08-24 (SUBS suppression seam): canonical subtitle off-switch landed end-to-end — new `UI.setSubtitlesOn()` clears the live line (timer/text/opacity), `Game.applySettings` maps the new optional `SettingsData.subtitles` (src/save/db.ts, absent = on) onto it and mirrors the flag into both the panel-store patch and the legacy checkbox via `UI.syncSubtitlesCheckbox()`; the legacy pause-menu checkbox now routes through `pushSettings()` and its slider payloads carry `subtitles`, closing the clobber where any unrelated slider move silently re-enabled (and persisted) subtitles-off — defect caught by an independent review pass and regression-asserted in-test as SUBS_SLIDER_OK; settings-test.mjs also dismisses the F91 wake cinematic before FOV assertions (clearing the pre-existing FOV_BAD attribution). Evidence: pnpm typecheck green, pnpm build green (dist rebuilt post-fix), node test/settings-test.mjs ALL OK (FOV_OK, SUBS_OK, SUBS_SUPPRESS_OK, SUBS_SLIDER_OK, PERSIST_OK), console-audit errors=0, settings-persist 26/0, interaction-matrix 6/6, wakemount 34/0. Next step: serialize the hunger pang clock into the save slot so continued expeditions stop restarting the grace period (src/save/db.ts slot schema ← game.ts hunger/HungerPangs fields), headless-verifiable via the save suites.


