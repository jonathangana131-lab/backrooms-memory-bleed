# Integration Plan — Wave-Ordered Wiring of Unwired Modules

**BACKROOMS: MEMORY BLEED** · Generated 2026-08-23 · Owner: integration planning
Companion analysis: [`docs/integration-status.md`](./integration-status.md) (78 unwired modules, verified unreachable from `src/core/game.ts`).

> **Analysis only.** This plan proposes edits to `src/core/game.ts` (and thin call sites); **no source file was modified** while producing it. Every item below is a checkbox for the implementer.

---

## 0. Ground rules (read before wiring)

All call sites reference the current line layout of `src/core/game.ts` (1250 lines):

### Init-time anchor points in `Game.init()`
| Anchor | Lines | What exists there |
|---|---|---|
| **A0** engine + scene | 107–133 | `engine`, `scene`, clearColor/ambient |
| **A1** camera | 130–133 | `camera` (TargetCamera) |
| **A2** input/materials/lighting | 135–148 | `input`, `mats`, `lighting` |
| **A3** player/flashlight/chunks | 149–153 | `player`, `flashlight`, `chunks` |
| **A4** dust/humans/mem/weather | 154–166 | `dust`, `humans`, `mem`, `weather` |
| **A5** UI | 167–173 | `ui` (HUD host element lives here) |
| **A6** director/story | 175–188 | `director`, `story` |
| **A7** event handlers | 190–264 | footstep handler, keydown map, beforeunload |
| **LAZY** `ensureAudioIntegrations()` | 703–718 | ctx-gated lazy construction (`this.audio.started && this.audio.ctx`) |

### Per-run reset point
`beginRun()` (343–372): anything seeded per-expedition must be reset/reseeded here alongside `chunks.reset()` / `humans.reset()`.

### Frame-loop sections in `frame()`
| Section | Lines | Content |
|---|---|---|
| **F-menu** attract drift | 732–741 | title-screen camera walk |
| **F-sim** active simulation | 749–912 | mem.tick, landmark discovery, weather, director, `humans.update` (816), erosion, interaction |
| **F-world** chunk/story update | 914–919 | `chunks.update`, `story.update` |
| **F-fixture** blackout + fixture list | 921–957 | `fixtures` array assembly |
| **F-light** lighting+audio master | 958–965 | `lighting.update`, `audio.update` |
| **F-audio** integrated audio systems | 967–1064 | `ensureAudioIntegrations()` + per-module guarded `update` blocks (the template every new audio module copies) |
| **F-fx** dust/shake | 1067–1085 | `dust.update`, camera shake |
| **F-hud** HUD/log/save | 1086–1136 | ui setters, log, autosave |
| **F-render** | 1138 | `scene.render()` |

### Conventions every new wiring must follow
1. **Field-declare nullable** (`private fooX: X | null = null;`) next to the existing lazy-audio fields (lines 66–72).
2. **Wrap construction AND per-frame calls in try/catch** with a `console.warn('[bmb] <name> unavailable/failed', e)` — this is the established failure-isolation pattern (see `PositionalHum` at 707, 971–984).
3. **Audio modules go through `ensureAudioIntegrations()`** — never construct at init when they need `AudioContext`.
4. **No per-frame allocation** in hot sections where avoidable (the fixture-list code at 944–957 deliberately avoids it).
5. **Serialize new per-run state in `captureSlot()` (412–432)** only if it must survive continue; bump nothing — `version: 2` tolerates added optional keys (see `batteriesTaken` read-back pattern at 323–333).

---

## WAVE A — Pure logic, zero deps (can wire anytime)

No `Scene`, no `AudioContext`. Depends only on already-wired singletons (`SaveDB`, `localStorage`, `ui` DOM, plain math). These can land in any order, even all at once.

### A-1. Settings cluster (self-contained mini-chain — keep this internal order)
- [ ] **A-1a.** `src/ui/settings.ts` — `SettingsManager` · *ctor:* none/options. **Call site:** construct at **A5**, feed through `applySettings()` (271–280) so the two setting stores agree. **Frame:** none (event-driven). **~15 LOC**
- [ ] **A-1b.** `src/ui/accessibility.ts` — `AccessibilityManager`/`AccessibilityController` (consumes A-1a). **Call site:** **A5**. **Frame:** caption routing hook inside `F-hud` next to `ui.say` paths. **~20 LOC**
- [ ] **A-1c.** `src/ui/settingspanel.ts` — panel (consumes A-1a + A-1b). **Call site:** **A5**, mounted into the existing pause menu host. **Frame:** none. **~25 LOC**

### A-2. Text/state machines
- [ ] **A-2a.** `src/story/reread.ts` — `NoteReread(opts)` (highlight/synonym distortion of re-read notes). **Call site:** **A7**, wrap the note-open branch of `handleInteraction()` (1153–1160). **Frame:** none. **~10 LOC**
- [ ] **A-2b.** `src/ui/hints.ts` — `DifficultyHints(opts)`. **Call site:** **A6**. **Frame:** one throttled check in **F-hud** beside `objectiveTimer` (1090–1094). **~12 LOC**
- [ ] **A-2c.** `src/story/beats.ts` — `StoryBeats` (beat table + state). **Call site:** **A6**, constructed with `this.seed`; reset in `beginRun()`. **Frame:** `update(dt)` once in **F-sim** after `director.update` (815). **~18 LOC**

### A-3. Ending upgrade (replaces inline code — see risk R-1)
- [ ] **A-3a.** `src/ui/endstats.ts` — `EndStats(container, opts)` + `computeRank`. **Call site:** **A5**. **Frame:** none (invoked at ending). **~10 LOC**
- [ ] **A-3b.** `src/ui/endcapture.ts` — `EndCapture(delayMs)` (whiteout + frame grab). **Call site:** rework `triggerEnding()` (1203–1247) to delegate. **Frame:** none. **~25 LOC**

### A-4. Persistence stage helpers (world decay bookkeeping)
- [ ] **A-4a.** `src/world/cracks.ts` — `createWallCracks` stage tracking (localStorage-keyed). **Call site:** helper import; consumed by chunk build in Wave C-2. **~8 LOC** when stubbed in
- [ ] **A-4b.** `src/world/stains-growth.ts` — `createStainGrowth`. Same pattern as A-4a. **~8 LOC**
- [ ] **A-4c.** `src/world/graffiti-evolution.ts` — `createGraffitiEvolution`/`evolveGraffiti`. Same pattern. **~8 LOC**

### A-5. Pure tables/functions consumed by Wave B/C
- [ ] **A-5a.** `src/gfx/daycycle.ts` — `DayCycle` (**zero-arg ctor** — genuinely dependency-free; its *consumers* are scene values, hooked in C-1). **Call site:** field-init OK. **Frame:** `update(dt, blackout)` in **F-sim** (freezes during blackout — pass `playtimeSec < blackoutUntil`). **~8 LOC**
- [ ] **A-5b.** `src/audio/humharmonics.ts` — pure harmonic tables/`dbToGain`. No runtime wiring alone; imported by B-1j. **~2 LOC**
- [ ] **A-5c.** `src/entities/entitysurfaces.ts` — district→surface data. Imported by B-2 entity work; no standalone wiring. **~2 LOC**
- [ ] **A-5d.** `src/audio/surface-wiring.ts` — `SurfaceWiring` helpers. ⚠️ Its job was re-implemented inline at 190–202; wire as **refactor-only** item or leave documented-dead (risk R-2). **~15 LOC if refactored**
- [ ] **A-5e.** `src/gfx/fogvariation.ts` — `chunkFogDensity` pure function. **Call site:** called from lighting path in C-1. **~5 LOC**

**Wave A total: ≈ 200 LOC of wiring across 16 files.**

---

## WAVE B — Needs AudioContext or Scene (wire after audio init / scene setup)

Two independent sub-tracks; B-1 and B-2 can proceed in parallel once Wave A lands.

### B-1. Audio pack — extend `ensureAudioIntegrations()` (703–718)
Every item: construct lazily with `(ctx, dest)` inside its own try/catch; add a nullable field; update in **F-audio** (967–1064) using the `PositionalHum` block as the template.

- [ ] **B-1a.** `audio/doors.ts` — `DoorCreaks(ctx, dest)` · **frame:** call in the cell-crossing block (894–911) where `edgeCodeBetweenCell` already fires `audio.doorway()`. **~12 LOC**
- [ ] **B-1b.** `audio/batterycue.ts` — `BatteryCues(ctx, dest)` · **frame:** event-driven from battery pickup (247–255) + low-battery branch of flashlight update (826–827). **~10 LOC**
- [ ] **B-1c.** `audio/emzones.ts` — `EMZones(ctx, dest)` · **frame:** zone query in **F-audio** using `chunks.districtAtPos` + player pos. **~15 LOC**
- [ ] **B-1d.** `audio/crowd.ts` — `CrowdAmbience(ctx, dest)` · district-gated (`OPEN_OFFICE_DISTRICT = 1`); reuse `dist` computed at 813. **~12 LOC**
- [ ] **B-1e.** `audio/groans.ts` — `StructureGroans(ctx, dest)` · tension-driven; feed `director.tension` (996). **~10 LOC**
- [ ] **B-1f.** `audio/echoes.ts` — `EchoSites(ctx?, dest?)` (nullable args — most defensive) · position-seeded sites; update in **F-audio** with focus coords. **~15 LOC**
- [ ] **B-1g.** `audio/boundaries.ts` — `BoundaryCue(ctx, dest)` · fires on district change; piggyback the `dist !== null` check (813–814). **~10 LOC**
- [ ] **B-1h.** `audio/landmarkbreath.ts` — `LandmarkBreath(ctx, dest)` · gated on `inLandmark` already computed at 777. **~12 LOC**
- [ ] **B-1i.** `audio/loresting.ts` — `LoreStings(ctx, dest)` · stage-gated (`stageCutoff(this.story.stage)`); hook `handleInteraction` lore branch (1181–1200). **~12 LOC**
- [ ] **B-1j.** `audio/humspatial.ts` — `HumSpatial(ctx, dest)` + A-5b harmonics · supersedes/augments `setFixtures` feed at 971–984. **~18 LOC**
- [ ] **B-1k.** `audio/radio.ts` — `RadioChatter(audio: AudioEngine)` (note: takes the **engine**, not raw ctx) · pair with B-2 radio props for placement. **~12 LOC**
- [ ] **B-1l.** `entities/vocals.ts` + `entities/vocalcontent.ts` — `EntityVocals(ctx, dest)` (+ `HumVoice`/`MutterVoice` per-figure voices seeded per figure id) · **frame:** distance-check each `humans.figures` entry in **F-audio**. **~30 LOC**

**B-1 subtotal: ≈ 170 LOC.**

### B-2. Scene pack — construct in `Game.init()` between **A3** and **A4** (or right after **A4**)
Each needs `scene` (and usually `mats`/`chunks`/`flashlight`), so construct eagerly like `DustMotes` (154); reset/reseed in `beginRun()` where positional.

- [ ] **B-2a.** `gfx/postfx.ts` — `PostFX({ camera })` (auto-adopts LightingRig's pipeline). **Construct after `lighting` (137–138).** **Frame:** `update(dt)` in **F-light** after 961. **~15 LOC**
- [ ] **B-2b.** `gfx/shadows.ts` — `TorchShadows(light)` — needs `Flashlight`'s SpotLight; construct at **A3+.** **Frame:** none (shadow-gen auto) or per-frame refresh in **F-light**. **~8 LOC**
- [ ] **B-2c.** `gfx/sway.ts` — `FixtureSway` · **frame:** **F-light**, fed from `fixtures`. **~12 LOC**
- [ ] **B-2d.** `gfx/fanwiring.ts` → `gfx/ceilingfan.ts` — `FanWiring(scene)`; **pair with B-1k/B-1x `FanAudio(ctx,dest)`** for spin-up whir. **Frame:** `update(dt, focus)` in **F-world** after `chunks.update`. **~20 LOC**
- [ ] **B-2e.** `gfx/footprints.ts` — `Footprints(scene, surfaceType)` · hook the existing `footstep` event (190–202). **~15 LOC**
- [ ] **B-2f.** `gfx/drips.ts` — `CeilingDrips(scene, ctx?)` · **frame:** **F-fx** beside `dust.update` (1069). **~12 LOC**
- [ ] **B-2g.** `gfx/lightpools.ts` · pool decals under alive fixtures from `fixtures` (944–957). **Frame:** **F-light**. **~15 LOC**
- [ ] **B-2h.** `gfx/reflections.ts` — `WetReflections(scene)` · puddle-chunk gated; **frame:** **F-light**. **~15 LOC**
- [ ] **B-2i.** `gfx/paperflutter.ts` + `gfx/notepaper.ts` — note-mesh paper variants + proximity flutter; hook `nearestNote` path in `handleInteraction` (1163). **~20 LOC**
- [ ] **B-2j.** `gfx/crossfade.ts` — `BoundaryCrossfade` · consumes A-5e fog variation; **frame:** **F-light**. **~12 LOC**
- [ ] **B-2k.** `gfx/flickevents.ts` — `FlickerEvents()` · ripple cascades from fixture deaths; hook `lighting.onLightDied` (145–148) + blackout ghost-lights (930–943). **~15 LOC**
- [ ] **B-2l.** `gfx/moisture.ts` → `gfx/cornerao.ts` — `createWallMoisture` sheen decals. **~18 LOC**
- [ ] **B-2m.** `entities/fauna.ts` — `FaunaManager(scene)` (+ its internal `AudioContext` voice) · **frame:** `fauna.update(dt, px, pz, colliders)` directly after `humans.update` (816). Reset in `beginRun()`. **~20 LOC**
- [ ] **B-2n.** `entities/gaze-wiring.ts` → `entities/gaze.ts` — `GazeWiring`; attach a `GazeController` per figure on spawn (call sites: `humans.spawn` wrappers at 522, 683, 692). **Frame:** update offsets before `humans.update`. **~25 LOC**
- [ ] **B-2o.** `entities/fidgets.ts` — `IdleFidgets(seed)` · per-figure idle poses; **frame:** with B-2n. **~12 LOC**
- [ ] **B-2p.** `entities/schedules.ts` — `PatrolSchedule(spawnX, spawnZ, seed)` · per-wanderer patrol paths; construct at spawn sites. **~15 LOC**
- [ ] **B-2q.** `entities/sitting.ts` — `SittingBehavior` · chapel-believer poses (ties into staffed-landmarks block 503–526). **~12 LOC**
- [ ] **B-2r.** `entities/spawneffects.ts` + `entities/graceful.ts` + `entities/avoidance.ts` — spawn fade-in/dissolve helpers + prop avoidance circles · hook `spawnEntity` (662–693) and `moveCircle` calls. **~25 LOC**
- [ ] **B-2s.** `world/neonsign.ts` — `NeonSign` + `createNeonBuzz` (buzz is ctx-gated ⇒ half-B-1) · landmark/district decoration. **~18 LOC**
- [ ] **B-2t.** `world/radioprops.ts` → `world/radiogeometry.ts` — `RadioProps` desk radios; placement pairs with B-1k chatter sources. **~18 LOC**
- [ ] **B-2u.** `world/vignettes.ts` → `world/placement-expansion.ts` — prop vignette factories; consumed by chunk build (ChunkManager/architect layer). **~20 LOC**
- [ ] **B-2v.** `world/ceiling-details.ts`, `gfx/tiledisplace.ts`, `gfx/doorstyles.ts`, `gfx/projections.ts` — mesh-detail helpers for the mesher/architect layer (REACHABLE files). Wire inside chunk build, not game.ts. **~30 LOC**
- [ ] **B-2w.** `world/staindrips.ts` — `StainDripSync` · bridges A-4b stains ↔ B-2f drips (order: after both). **~12 LOC**

### B-3. UI overlays — need DOM host (mount at **A5**) + live data
- [ ] **B-3a.** `ui/minimap.ts` — `Minimap(container)` · **frame:** throttled (≥10 Hz) update in **F-hud** with player pos/yaw + `chunks` data. **~15 LOC**
- [ ] **B-3b.** `ui/compass.ts` — `Compass(container)` · same feed as B-3a; landmark markers from `chunks.landmarkCentersNear`. **~15 LOC**
- [ ] **B-3c.** `ui/weatherui.ts` — `WeatherUI(container)` · feed `weather.front` forecast (data already used at 1011–1013). **~12 LOC**

**Wave B total: ≈ 480 LOC of wiring across 40 files.**

---

## WAVE C — Ordered chain (needs other systems wired first)

Strictly sequential; each step names what must already exist.

- [ ] **C-1. Day/night lighting hookup** *(needs A-5a DayCycle + A-5e fogvariation + B-2a PostFX)*
      Apply `daycycle.currentTint()` into `lighting.setWeatherTint` path (810) and fog multiplier into district fog (813–814). **Order: A-5a → A-5e → B-2a → this. ~20 LOC**
- [ ] **C-2. World-decay composition** *(needs A-4a/b/c stage helpers + B-2u vignettes + B-2v mesher details)*
      Chunk build applies crack/stain/graffiti stages + vignette props. Touches `world/chunkManager.ts`/`architect.ts` call path, not game.ts. **~35 LOC**
- [ ] **C-3. Journal feature** *(chain root: journal-wiring → journal-feed → ui/journal)*
      - [ ] `ui/journal.ts` `Journal` mount (DOM, **A5**)
      - [ ] `story/journal-feed.ts` `JournalFeed(journalApi)`
      - [ ] `story/journal-wiring.ts` `JournalWiring(feed)` — feed events from beacon discovery (1181–1200), landmark discovery (753–772), ending.
      - [ ] Then decide replace-vs-augment for the inline TAB log (1110–1131). **⚠️ risk R-3. Total ~45 LOC**
- [ ] **C-4. Achievement tracker** *(tracker-wiring → tracker)*
      - [ ] `ui/tracker.ts` `Tracker`
      - [ ] `ui/tracker-wiring.ts` `TrackerFeed(tracker, opts)` — wire `setAchievementToastSink` to `ui.toast`; feed discoveries/relocations/notes-read counters. **~25 LOC**
- [ ] **C-5. Save/checkpoint screen** *(needs A-1 settings cluster + existing SaveDB flows)*
      - [ ] `story/checkpoints.ts` `CheckpointManager(opts)` (quick slots over SaveDB)
      - [ ] `ui/savescreen.ts` `SaveScreen(container, actions)` mounted from pause menu; actions call `saveNow`/`continueGame`. **⚠️ risk R-4. ~35 LOC**
- [ ] **C-6. Watcher intro cinematics** *(needs humans manager + audio pack + subtitles)*
      - [ ] `story/firstwatcher.ts` `FirstWatcher` OR `story/watcherintro.ts` `WatcherIntroController` — **pick ONE** (same storage key `bmb-firstwatcher` and nearly identical behavior; shipping both double-fires the intro).
      - Hook first watcher spawn (entityScheduler 479–481 / 491–493); duck score via `score` (999–1006). **~20 LOC**
- [ ] **C-7. Gallery** *(needs A-3b EndCapture producing frames)*
      - `ui/gallery.ts` `PhotoGallery(container)` — title-screen gallery of captured endings. **~20 LOC**
- [ ] **C-8. Ending pipeline swap** *(needs A-3a, A-3b, C-4 stats, C-7)*
      Re-route `triggerEnding()` (1203–1247) fully through EndCapture → EndStats rank card → JournalFeed final entry → gallery save. Keep the current inline path behind a flag until R-1 tests pass. **~30 LOC**

**Wave C total: ≈ 230 LOC of wiring across 12 files. Grand total ≈ 900 LOC of glue.**

---

## Risk notes — integrations that can break existing tests

| # | Integration | Test files at risk | Why / mitigation |
|---|---|---|---|
| **R-1** | A-3b + C-8 replacing inline `triggerEnding()` | `test/post-ending-test.mjs`, `test/full-persist-test.mjs`, `test/save-test.mjs` | Inline ending performs a final `SaveDB.saveGame(captureSlot())` (1234) and whiteout timing (1236–1245). EndCapture's own `WHITEOUT_CAPTURE_DELAY_MS` (1300ms default) races the 1400ms setTimeout. Mitigation: keep final save synchronous-before-capture; keep 1400ms beat intact. |
| **R-2** | A-5d `SurfaceWiring` refactor of inline footsteps | `test/footstep-wiring-test.mjs`, `test/surfaces-test.mjs`, `test/surfacedetect-test.mjs` | game.ts already wires `SurfaceDetector + SurfaceFootsteps` inline (190–202); tests assert THAT behavior. Only refactor if the wiring module reproduces district detection identically; otherwise leave dead and document. |
| **R-3** | C-3 journal vs inline TAB expedition log | `test/log-test.mjs`, `test/journal-test.mjs`, `test/journal-feed-test.mjs`, `test/journal-wiring-test.mjs` | `log-test` asserts current `ui.setLog` payload format (1115–1128). Ship journal as an additional view keyed off Tab long-press, or gate the swap until log-test is updated. |
| **R-4** | C-5 SaveScreen/Checkpoints over direct SaveDB calls | `test/save-test.mjs`, `test/save-stress.mjs`, `test/save-robustness.mjs`, `test/savescreen-test.mjs`, `test/full-persist-test.mjs`, `test/db-size.mjs` | Autosave cadence (1133–1136) and `beforeunload` save (262–264) are load-bearing. CheckpointManager adds slots — verify IDB quota assumptions in db-size still hold. |
| **R-5** | B-2a PostFX attaching a rendering pipeline | `test/postfx-check.mjs`, `test/webgpu-game.mjs`, `test/perf.mjs`, `test/probe-fx.mjs` | Pipeline adoption interacts with WebGPU fallback path (110–124) and hardware-scaling quality setting (278). Guard: skip PostFX when `engine` is WebGPU and pipeline attach throws; perf budget check in perf.mjs. |
| **R-6** | B-2m fauna + B-1l vocals sharing the audio graph | `test/fauna-test.mjs`, `test/vocals-test.mjs`, `test/vocalcontent-test.mjs`, `test/audio-check.mjs` | Both construct voices on the shared `ctx.destination`; simultaneous node creation on unlock can trip autoplay policies in headless runs. Construct strictly inside `ensureAudioIntegrations`. |
| **R-7** | C-6 FirstWatcher vs WatcherIntroController double-fire | `test/firstwatcher-test.mjs`, `test/watcherintro-test.mjs`, `test/attendant-test.mjs` | Both use storage key `bmb-firstwatcher`; wiring BOTH corrupts the one-shot flag. Choose one (plan says FirstWatcher). |
| **R-8** | B-2n/o/p/q entity-behavior additions to HumanManager flow | `test/entity-behavior.mjs`, `test/gaze-test.mjs`, `test/gaze-wiring-test.mjs`, `test/schedules-test.mjs`, `test/sitting-test.mjs`, `test/fidgets-test.mjs`, `test/smart-spawn.mjs`, `test/avoidance-test.mjs` | Tests pin spawn counts and update ordering around `humans.update` (816). Insert gaze/fidget updates BEFORE the humans.update call and never mutate figure counts there. |
| **R-9** | C-1 day-cycle tint overriding weather tint | `test/weather-depth.mjs`, `test/probe-weather.mjs`, `test/daycycle-test.mjs` | `lighting.setWeatherTint(weather.fogTint())` (810) is asserted; multiply daycycle tint INTO it rather than replacing the call. |
| **R-10** | B-2s/t neon buzz + radio chatter node leaks | `test/neonsign-test.mjs`, `test/radioprops-test.mjs`, `test/radiogeometry-test.mjs`, `test/console-audit.mjs` | Chunk rebuild (`rebuildChunk` at 249) disposes props; buzz oscillators must stop on dispose or console-audit flags leaked nodes. |

**General regression gate:** run the full `test/*.mjs` suite (plus `npx tsc --noEmit`) after EACH wave, not just each item — the highest-blast-radius waves are B-1 (audio graph) and C-5/R-4 (save paths).

---

## Suggested execution order (one PR per checklist group)

```
Week-shape (dependency-safe):
  1. Wave A (all groups)            → typecheck + full test suite
  2. B-2a PostFX alone              → R-5 verification
  3. B-3 minimap/compass/weatherui  → visible player value fast
  4. B-1 audio pack (a→l)           → one module per commit
  5. B-2 remainder (c→w)            → visual packs in pairs
  6. C-1 → C-2                      → world cohesion
  7. C-3 → C-4 → C-5                → meta features (R-3/R-4 care)
  8. C-6 → C-7 → C-8                → narrative finish (R-1/R-7 care)
```

*Status tracker:* see [`docs/integration-status.md`](./integration-status.md) §Recommended wiring order — this plan supersedes that ordering with explicit dependencies and call sites. Mark checkboxes here as waves land.


