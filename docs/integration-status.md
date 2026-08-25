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
- 2026-08-24 (F73 hunger-clock persistence): pang schedule now rides the save slot — `HungerPangsState {v,clockMin,nextPangAtMin,rngState}` serialized via new `HungerPangs.serialize()/restore()` (src/player/hunger.ts; restore validates strictly and pushes corrupt behind-clock next-pang times one full interval past resume so continued runs never insta-fire), optional `SaveSlot.hunger` field (src/save/db.ts; migrateSlot passes it through verbatim, legacy slots simply lack it), RNG stream snapshot enabled by a new `RNG.state` getter/setter (src/core/rng.ts), and game.ts wiring in `captureSlot()` + both load sites (`continueGame()`, `restoreCheckpoint()`) with soft fallback to a fresh schedule on malformed payloads. Evidence: node test/hunger-save-test.mjs 27 checks ALL PASS (round-trip identity incl. seeded durations, grace-not-restarted, malformed rejection, behind-clock quieting, migrateSlot passthrough); regression green: hunger-test ALL PASS, hungerpangs-consumer 43/0, save-test PASS, save-robustness 8/8, checkpoints 12/0, ledger 13/0, slotghosts 29/0, full-persist PERSIST_ALL_PASS (headless Chrome env recovered); live-game round-trip test/hunger-persist-test.mjs HUNGER_PERSIST_PASS (slot carries clock 45.00 min, continued run resumes at 45.02 with identical nextPang 47.09 — no grace restart, no instant-fire storm); pnpm typecheck + pnpm build green. Next step: V1.1 debt audit's remaining item after F73/F95 — re-audit docs/GAME-PLAN-V1.1.md debt bullets against HEAD and pick the highest value-per-effort survivor.
- 2026-08-24 (F100 credits motion-safety + skip): debt re-audit done via 5 parallel read-only audits (speedrun ghost persistence, adrenaline hearing gain, season-bleed particle descriptor, director-learning consume side, credits scene) — the credits bullet was stale (the F100 mount itself was already live) but carried a real residual defect, now fixed in game.ts: `beginCreditsWalk()` early-returns under `motionSafetyOn()` (reduced-motion players keep the static ending overlay, mirroring the wake-cinematic posture), any key/click during a mounted walk skips straight into the natural-finish title hand-off via new private `finishCreditsWalk()` (also used by the walker clock) / public `skipCreditsWalk()` exposed as `__BMB__.skipCreditsWalk` in main.ts with an F3 exemption for debug overlays, and the RETURN TO TITLE button exit now calls `setState('menu')` like every other hand-off (it previously parked state at 'credits' — pre-existing asymmetry caught by the new suite). Docs corrected: GAME-PLAN-V1.1.md credits bullet marked RESOLVED ✅; endcapture/endstats/gallery removed from this file's ui/ orphan table (all three verified wired: EndCapture armed game.ts ~L1017 feeding gallery.addPhoto, EndStats constructed ~L1002 and shown in the onDone debrief, PhotoGallery constructed ~L879 and read by beginCreditsWalk). Audit hand-offs recorded for future waves: adrenaline hearing-gain consumer = next highest value-per-effort (dedicated ambience bus between occlusion lowpass and master — never master.gain, DreadSilence owns it; `setHearingMul(m)` clamp [1,2], τ≈0.25; one-line game.ts feed of `adrenalineHearingGainMul`; proving test mirrors hungerpangs-consumer fake-AudioContext pattern); then season-bleed particle consumer (S–M, spawnPlan pure helper + DustMotes-style point cloud, cap ≈300, positive fallSpeedMps = RISES), then director-learning consume side (setFearBias mount at calm→build duration + build→peak coin, no new RNG draws). Evidence: node test/creditswalk-safety-test.mjs 7/7 ALL PASS (browser tier, real triggerEnding path both motion-safety states); creditswalk-test 34/0, wakemount-test 34/0, endcapture-test ALL PASS; pnpm typecheck green; pnpm build green; playthrough PLAYTHROUGH_PASS PAGE_ERRORS=0. Next step: implement the adrenaline hearing-gain consumer exactly per the audit design above (src/audio/audio.ts listener bus + src/core/game.ts one-line feed + test/adrenaline-hearing-consumer-test.mjs).


- 2026-08-24 (adrenaline hearing-gain consumer): the last v1.1 debt audit hand-off landed — AudioEngine now carries a dedicated ambience gain bus wired `occlusion lowpass -> ambience -> master` (src/audio/audio.ts; new public `setHearingMul()` clamps to [1, HEARING_GAIN_MUL_MAX] with NaN/Infinity falling back to identity, automates via setTargetAtTime tau HEARING_MUL_TAU_S=0.25, seeds pre-unlock requests into the bus on unlock, exposes `ambienceBus`/`hearingMulLevel` getters) and game.ts consumes the previously dormant `adrenalineHearingGainMul`: frame-loop feed right where the field is refreshed plus a beginRun reset to unity. master.gain is untouched by design — DreadSilence owns whole-mix ducks. Evidence: node test/hearinggain-test.mjs 31/31 ALL PASS (clamp/storage, graph shape occlusion->ambience->master, live automation target + tau + master ownership, envelope mapping, wiring greps, reset semantics); regression adrenaline-test/dreadsilence-test/hungerpangs-consumer-test 43/0 ALL PASS; in-browser audio-occlusion suite ALL PASS against the rewired graph (occlusion sweep + reverb wet + whisper pan intact, no page errors); live end-to-end probe (test/_hg-live-probe.mjs): injected near-miss drove game.adrenaline -> frame loop -> hearingMulLevel=2 with ambienceBus param converging 1.68->1.88 while masterBus stayed pinned at 0.8, PAGE_ERRORS=0 (the 5.2s sample still read 1.875 because the game's own watcher-proximity arming accepted further dumps — correct gameplay); pnpm typecheck green; pnpm build green (1m29s). Docs: GAME-PLAN-V1.1.md bullet marked RESOLVED ✅. Next step: remaining V1.1 debt survivor — season-bleed particle consumer (S-M: spawnPlan pure helper + DustMotes-style point cloud, cap ~300, positive fallSpeedMps = RISES), then director-learning consume side (setFearBias mount at calm->build duration + build->peak coin, no new RNG draws).
- 2026-08-25 (season-bleed particle consumer): the F57 descriptor's long-dormant consumer landed — new `src/gfx/seasonbleed.ts` with pure `spawnPlan()` (count = round(densityPerM3 x volumeM3) clamped to SEASON_PARTICLE_CAP=300, junk density/volume/cap falling back safe, packed rgb unpacked to unit channels, per-archetype point size/alpha with unknown-kind fallback) and `SeasonBleedParticles` (DustMotes-style updatable points cloud, seeded via src/core/rng so fields replay byte-identically, band-wrapped fall/rise honouring positive fallSpeedMps = RISES, sinusoidal sway at the descriptor's swayHz, toroidal X/Z wrap around the camera, equal-plan reconfigure is identity); ChunkManager grew `seasonBleedAtPos(x,z)` reading the containing chunk's layout.seasonBleed; game.ts constructs the cloud beside DustMotes, polls the descriptor every frame on the same fx2/fz2 feed, mounts the season's particles while the player stands in the elected bleed room and parks the cloud elsewhere, and beginRun resets it. Evidence: node test/seasonbleed-test.mjs 67/67 ALL PASS (purity lint / plan purity+clamps / all four catalog seasons / NullEngine cloud behaviour incl. dt clamp + camera re-wrap + seed determinism / accessor hit-miss / wiring greps); live probe against served dist (test/_sb-live-probe.mjs): parked at spawn, active path renders monsoon strokes in the real scene (finite, in-band, camera-wrapped), parks again clean, PAGE_ERRORS=0, SB_LIVE_PROBE_PASS; regression seasonrooms STOMACH/hungerpangs-consumer 43/0 and f95 33/33 green; pnpm typecheck green; pnpm build green. GAME-PLAN-V1.1.md bullet marked RESOLVED ✅. Next step: last V1.1 debt audit survivor — director-learning consume side (mount setFearBias at calm->build duration + build->peak coin per the 2026-08-24 audit hand-off, no new RNG draws), then re-audit remaining debt bullets (crack-density mesher seam, whisper spatial authority) for a fresh wave.
- 2026-08-25 (director-learning consume side): the last V1.1 debt audit survivor landed — director.ts grew pure `fearLevelFromWeights()`/`fearBuildDurationMul()`/`fearPeakCoinChance()` (clamped-mean weight aggregation into one [0,1] level, FEAR_LEVEL_NEUTRAL=0.5 baseline, junk -> neutral, out-of-range levels clamp to span ends) plus `setFearBias(weights|null)` + `fearBias` getter; consumed at exactly two sites — calm→build scales the already-drawn base duration by ×0.7 feared…×1.3 bored, build→peak shifts the existing coin threshold on the SAME single draw (legacy 0.55 → 0.35…0.75) — zero new RNG draws, unfed/neutral directors byte-identical to legacy timelines; game.ts feeds `this.director.setFearBias(this.learning.suggestPhaseBias())` every learning tick beside advanceClock (the feed side has been live since F90) and beginRun resets the bias to neutral. Nuance proven in-test: the coin draw seeds off elapsed-at-build-end, which the scaled build shifts, so cross-bias dominance holds on the threshold function over a fixed u (unit level) with aggregate counts confirming direction (feared 294 > neutral 222 > bored 148 peaks / 400 seeds; neutral empirical 0.555). Evidence: node test/fearbias-consume-test.mjs ALL PASS (helpers/clamps, parity + replay determinism, scaling incl. calm untouched, coin dominance, draw-profile identity for identical feeds, wiring greps); regression directorlearning-test 29 checks ALL PASS, persona-test PASS; pnpm typecheck green, pnpm build green (3m36s); playthrough PLAYTHROUGH_PASS PAGE_ERRORS=0 on :5178. GAME-PLAN-V1.1.md bullet marked RESOLVED ✅. Fresh-wave audit hand-offs recorded via 2 parallel read-only audits: (1) crack-density seam = LIVE DEBT — src/world/crackmesher.ts + src/gfx/floorcracks.ts have zero importers, agingAt() uncalled, chunkManager.ts:258-262 still carries the seam comment; minimal S-effort mount = fold `generateFloorCrackQuads(layout, crackDensityMul)` into main-thread buildFromLayoutInner reusing the mesher.ts:1198-1210 decal bucket (hash-salted RNG, never Math.random; watch LOD skip ≥1 on the debris bucket), pure-node test like floorcracks-test. (2) whisper spatial authority = real three-way duplication (WhisperField per-voice HRTF chain bypassing master/occlusion/DreadSilence, PositionalHum parallel StereoPanner chain, third panner in AudioEngine); M-effort adapter consolidation injecting a destination bus into both ctors (game.ts:2405/:2468 → ambienceBus ?? masterBus); CRITICAL side-defect: whisperfield voiceGain.gain initialized 0 at :322 and never retargeted — WhisperField likely inaudible live today (stub contexts don't model DSP); sequence the gain fix deliberately, not inside the refactor. Next step: claim the crack-density floor-crack fold (S, pure-node verifiable) or open the wave with both hand-offs split across agents; shared-trunk game.ts integration stays single-owner.
- 2026-08-25 (whisper trim defect + spatial bus authority): both sequenced hand-offs from the F24 entry landed — first the CRITICAL side-defect: `WhisperField.voiceGain.gain` was initialized to 0 at build and retargeted nowhere, structurally muting every whisper in-game while all prior graph-level tests passed (they assert ear-gain ratios only, which a dead upstream node cannot change); the trim is now exported `VOICE_TRIM=1` (documented as pure structure — the whole level/undulation solve lives on the ear gains) with a new `voiceTrims()` diagnostic. Then the consolidation: `game.ts` `ensureAudioIntegrations()` derives `spatialBus = audio.ambienceBus ?? dest` and constructs `PositionalHum(ctx, spatialBus)` + `WhisperField(..., { destination: spatialBus })`, so fixture hum and binaural whispers now ride the adrenaline hearing-gain envelope with the rest of the ambience pack; `master.gain` untouched (DreadSilence's). New `WhisperFieldOptions.destination` (default `ctx.destination`) carries the injection. Evidence: node test/whisperfield-test.mjs 33/33 ALL PASS (legacy 26 + new trim/bus/wiring stages); live positional-test PASS against :5178 (attenuation/cap/pan/stop clean); audio-occlusion ALL PASS incl. "whisper audible and panned" acoustically + no page errors; hearinggain-test 31/31; pnpm typecheck green, pnpm build green (1m9s). Commit f1aca3b. Next step: fresh audit wave — no V1.1 debt survivors remain, so pick the next open item from GAME-PLAN.md SHIPPED/UNSHIPPED marks or mount another orphan cluster (recommended order in this file still lists fauna/vocals/journal tiers), and consider a live probe asserting humAudio/whispers output connectivity reaches audio.ambienceBus at runtime.
- 2026-08-25 (F24 crack-density consumer): the crack-density seam is closed — `src/gfx/floorcracks.ts` grew pure `generateFloorCrackQuads(cx, cz, district, crackDensityMul)` (densityMul scales every slot's district activation chance; junk mul < 1 — NaN/Infinity/0/negative — falls back to legacy 1, mul above new CRACK_DENSITY_MUL_MAX=4 clamps; default arg keeps legacy call sites byte-identical) and `ChunkLayout.floorCracks` (src/world/architect.ts); chunkManager's buildFromLayoutInner now feeds it aging's previously-dormant `crackDensityMul` right at the old seam comment site, and mesher's buildChunkGeometry folds the quads into the debris bucket behind the LOD < 1 gate with the exact shadowQuads tint-pass contract (per-corner RGB multipliers, alpha 1) — revisited chunks now visibly worsen with more floor cracks, deterministic per (chunkKey, visits, seed). Evidence: node test/floorcrack-fold-test.mjs ALL PASS (31 checks: purity/determinism, quad shape @ CRACK_Y with up normal, monotone density scaling across 120-chunk aggregates, junk fallback table incl. explicit no-suppress-path for mul=0, cap clamp, real fold of a 355-quad aged chunk, LOD>=1 skips the fold, wiring greps); regressions green: floorcracks-test, aging-test, ledger-test 13/0, crackmesher-test; pnpm typecheck green, pnpm build green (1m38s). GAME-PLAN-V1.1.md bullet marked RESOLVED ✅. Next step: remaining fresh-wave debt survivor — whisper spatial authority consolidation (M-effort adapter injecting a destination bus into WhisperField + PositionalHum ctors at game.ts:2405/:2468 → ambienceBus ?? masterBus), sequenced AFTER the CRITICAL side-defect fix: whisperfield voiceGain.gain initialized 0 and never retargeted (likely inaudible live today) — fix the gain deliberately first, not inside the refactor.
