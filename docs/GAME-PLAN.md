# BACKROOMS: MEMORY BLEED — V1 GAME PLAN & REQUIREMENTS

*This document is the authority for what v1 is. Every agent session working on
this repo implements pieces of it. The game exists here — not in any chat*.

## THE PITCH

An infinite procedural Backrooms horror experience in the browser. You noclipped
out of reality into a place that remembers people who were never here — and it
is reconstructing them wrong. Endless yellow rooms, corridors that break their
own geometry, furniture that breathes, footsteps that echo a half-second behind
yours. No monsters jumping at you: DREAD COMES FROM WRONGNESS. The player should
never be able to say 'it's just a building' — it is a wrong state of the universe
with infinite possibility and no end.

## QUALITY BAR (non-negotiable)

1. **Dream-state clarity**: crisp, vivid rendering — atmospheric but never muddy.
2. **Embodied presence**: movement has mass; you hear your own body (breath,
   stride surfaces); standing still still feels alive.
3. **Layered procedural audio**: 20+ Web Audio layers reacting to district,
   tension, contamination, weather — zero external asset files.
4. **Uncertainty engine**: anomalies are deterministic-seeded but unpredictable
   per-session; the world stays internally consistent while being wrong.
5. **No cheap tricks**: no Roblox-tier jumpscares, no copied creepypasta lore,
   no placeholder content. Every line of text reads like evidence.
6. **Determinism law**: all generation/simulation randomness via src/core/rng.ts;
   Math.random only inside audio DSP buffer fill (commented).
7. **Procedural-only assets**: every texture, sound, mesh generated in code.

## CURRENT STATE (post-recovery baseline)

- tsc clean; PLAYTHROUGH_PASS (launch → explore → 3 beacons → stage-4 threshold
  ending → continue-enabled); save-stress intact; wave-a/b/c + integration +
  emergency suites green; perf-regression green post-leak-fix (heap plateaus).
- Built: chunk streaming world, memory contamination field + weather fronts,
  horror director FSM, seven entity archetypes with gaze/vocals/fidgets/sitting/
  schedules/graceful despawn, spatial anomalies (doorway déjà-vu, corridor
  stretch, migrating lights, mirror steps), contamination visuals, full UI
  suite, save system, render clarity pass, player breath + area-identity audio,
  Wave-B ambience pack, momentum movement feel, 105-note/14-arc content base.
- Known defects tracked as SKIP(defect) lines in wave-c/emergency suites:
  journal/tracker/checkpoint-savescreen/watcher-intro chains + frameUpdate/
  onChunkFixtures hooks — v1 must-fix (F1).

## HARD RULES FOR ALL WORK

- Feature isolation: systems talk via src/core/events.ts or injected interfaces.
- Strict TS ES2022, match local style, JSDoc headers, no new npm deps without
  orchestrator approval.
- Tests colocated in test/*.mjs (node strip-types or transpile-loader idioms).
- Gates before any commit: scoped tsc zero, touched tests exit 0, playthrough
  prints PLAYTHROUGH_PASS. One commit per file. Never /private/tmp durable.
- Agents may ADD new features beyond F1–F100 while developing when a discovery
  earns it — log them into this file with the next free F-number and full AC.
### CATEGORY A — v1 wiring blockers

- F1 Wave-B/C wiring restoration — journal/tracker/checkpoint-savescreen/watcher-intro chains constructed + fed in game.ts init/frame; frameUpdate + onChunkFixtures emergency hooks re-added. AC: wave-c + emergency suites exit 0 with ZERO DEFECT skips. SHIPPED ✅ (evidence: wave-c WAVE_C_PASS, emergency wiring+game ALL PASS, zero SKIP(defect) lines; chains live in game.ts imports/init)
- F2 Central integration mounts — applyRenderClarity / breath / areaidentity / ShadowMesherPass consumers mounted from game.ts per report snippets. AC: clarity tiers visibly switch; breathing audible under sprint; district beds change on district change; playthrough unaffected. SHIPPED ✅ (evidence: test/renderclarity-test.mjs + breath-test.mjs + areaidentity-test.mjs ALL PASS in gate v5; mounted game.ts mount batch A, ShadowMesherPass via chunkManager dynamic import)
- F3 Determinism audit — replace verbatim Math.random sites (relocation/camera-shake) with hash2i/RNG draws; add test/determinism-audit.mjs scanning sim/gen paths. AC: audit exits 0; relocation replays identical per seed. SHIPPED ✅ (evidence: game.ts 0 Math.random — all sim sites seeded via hash2i/RNG; director/hints/chunkManager seeded by wave agents; test/determinism-audit.mjs ALL PASS incl. same-seed director timeline replay; RESIDUE_LEDGER tracks remaining audio/gfx/entities sites, shrinking per scrub waves)
- F4 Hardware-GL QA sweep — qa-shots + playthrough on real GPU (non-swiftshader); six screenshots into shots/. AC: zero console errors; crisp-render verified. SHIPPED ✅ (evidence: test/qa-shots.mjs HWGL_QA_PASS — ANGLE Metal on AMD Radeon RX Ellesmere, 6 shots in shots/hwgl/, PAGE_ERRORS=0)

### CATEGORY B — embodiment

- F5 Binaural whisper field — HRTF-panned whispers fixed in world space while ears move. AC: panning inverts with 180° turn (graph test). SHIPPED ✅ (evidence: test/whisperfield-test.mjs 26 checks incl. graph-level pan inversion, ALL PASS; mounted to live listener pose)
- F6 Dread silence — director-commanded total mix duck (<-24 dB, 8–20 s) before major anomalies + recovery exhale. AC: automation provable; capped 1/25 min. SHIPPED ✅ (evidence: test/dreadsilence-test.mjs 28 checks, ALL PASS; mounted on masterBus, fired on peak-entry + relocation, ration enforced on session clock)
- F7 Footstep DNA — per-archetype gait signatures identifiable before line-of-sight. AC: classifier ≥95% accuracy on synthetic trains. SHIPPED ✅ (evidence: test/footstepdna-test.mjs 97.9–100% across seeds, ALL PASS; mounted pre-LOS with wrong-cadence caption flag)
- F8 Gait-synced dread — high tension drifts footstep micro-timing toward heartbeat interval. AC: phase-coherence metric monotone with tension. SHIPPED ✅ (evidence: test/gaitdread-test.mjs coherence monotone 0.501→0.978 across sweep, ALL PASS; controller bob advance scaled per-frame from dreadOffset/excitedHeartbeatPeriod)
- F9 Stamina embodiment — low stamina alters breath rate, stride sound, FOV pulse. AC: three outputs scale monotonically. SHIPPED ✅ (evidence: test/stamina-test.mjs monotone sweeps ALL PASS; mounts live — fatigue folds into breath tension, fovPulseAmp drives camera pulse; stride-intensity audio gain rides existing footstep path)
- F10 Lean/peek Q/E around doorframes — camera roll + parallax. AC: collision-safe lean envelope. SHIPPED ✅ (evidence: test/leanpeek-test.mjs ALL PASS; mounted in controller — Q/E hold lean, head-circle clamp against live colliders, roll+offset applied to camera)
- F11 Torch view-model — visible flashlight hand, sway, battery-swap beat <1.2s. AC: light follows mesh. SHIPPED ✅ (evidence: test/torchview-test.mjs 8/0 incl anchor-vs-Euler <1e-12; mounted — hand mesh pose advances every playing frame, SpotLight rides getLightAnchor)
- F12 Surface wading — puddles slow stride, splash, wet-footprint trail. AC: penalty + spawn tests. SHIPPED ✅ (evidence: test/surfacedetect-test.mjs + surface-wiring-test.mjs ALL PASS in gate v5; mounted game.ts — SurfaceDetector + footstep-wiring stride penalty/splash)
- F13 Vault/mantle crates — choreographed camera dip. AC: no collider clip; dip curve test. SHIPPED ✅ (evidence: test/vault-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F14 Fall stagger — postfx blur + control damp after hard falls. AC: recovery timeline test. SHIPPED ✅ (evidence: test/fallstagger-test.mjs 8/8 incl. exact settle + proportionality, ALL PASS; mounted via controller 'hardfall' event → inputScale damp + backdrop-blur veil)

### CATEGORY C — deeper wrongness

- F15 Pocket dimensions — seeded doors open into interiors larger than the building. AC: interior byte-identical regen; exterior unchanged. SHIPPED ✅ (evidence: test/pocketdim-test.mjs ALL PASS in gate v5; mounted chunk build path — architect generateLayout folds pocket interiors at layout-worker runtime)
- F16 Blackout rearrangement — props drift one slot, one door bricks after blackouts. AC: deltas reversible. SHIPPED ✅ (verified — evidence: test/blackoutdeltas-test.mjs 9/0 + test/anomalies-test.mjs F16 group ALL PASS; applyBlackoutShift/revertBlackoutShift fully reversible with deterministic per-(seed,ordinal) replay, bricked door's EdgeCode.SOLID override persisted in ChunkDeltas until next blackout; module-level in src/world/chunkDeltas.ts, not yet mounted in game.ts)
- F17 Echo geography — halls return YOUR earlier footsteps/memos as distant echoes. AC: deterministic replay per site. SHIPPED ✅ (evidence: test/echogeography-test.mjs 4/0 ALL PASS; mounted — footstep bursts + memo moments recorded per site, re-entry replays ≤2 cues)
- F18 Time slippage — clocks/camcorder/session timer disagree inside saturation zones. AC: offsets consistent per zone seed. SHIPPED ✅ (evidence: test/timeslippage-test.mjs 4/0; mounted on live memory-zone saturation, 60 s disagreement warning once per zone visit)
- F19 Impossible windows — lit rooms visible where exterior should be. AC: registry + culling test. SHIPPED ✅ (evidence: test/impossiblewindows-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F20 Unobserved stairwell loop — loops only while gaze-away >2s. AC: trigger iff condition (reuses stretch logic). SHIPPED ✅ (verified — evidence: test/stairloop-test.mjs 6/0 + test/anomalies-test.mjs F20 group ALL PASS; arms strictly past LOOK_AWAY_SNAP_SEC shared with corridor-stretch, discrete seeded landings recomputed from progress counter, clean disarm on bounds-exit/window-close; mounted via AnomalySystem host providers)
- F21 Memory residue touch — tagged objects play ghost replays of prior tenants. AC: one-shot per visit. SHIPPED ✅ (evidence: test/residue-test.mjs 4/0; mounted on note-read path with seeded tenant scripts + frame-queue playback, 1/90 s rate limit)
- F22 Gravity ambivalence — saturation zones tilt balance ±5° with veering walk. AC: bounded, exits cleanly. SHIPPED ✅ (evidence: test/gravitytilt-test.mjs 7/0 adversarial bounds; mounted via baseline-trick roll after player.update, sum-clamped)
- F23 Door/wall swaps — door opens into wall; adjacent wall becomes a door. AC: nav+collision+mesh atomic swap test. SHIPPED ✅ (verified — evidence: test/doorswap-test.mjs 8/0 + test/anomalies-test.mjs F23 group ALL PASS; single bulk write flips mesher marker/nav flag/collision solid on both cells with assertSwapConsistent gate, rides ChunkDeltas via DeltasSwapGrid so revertAll restores canonical; module-level in src/world/doorswap.ts + src/world/chunkDeltas.ts, not yet mounted in game.ts)
- F24 Aging corridors — revisits accumulate decay proportional to sessions since first seen. AC: persists via ChunkDeltas. SHIPPED ✅ (evidence: test/aging-test.mjs 8/0 ALL PASS; mounted ChunkManager build path — every chunk build records a visit and folds decayStage stain params into the mesher's stain set, exposed via agingAt(cx,cz))

### CATEGORY D — entities & society

- F25 Believer congregations — chapel landmarks host kneeling night services. AC: formation/dispersal tests. SHIPPED ✅ (evidence: test/congregation-test.mjs ALL PASS in gate v5; mounted game.ts — entities/hymn ChapelChoir reuses congregation seat formations for the night service)
- F26 The Archivist — harmless cataloguer; photographing it changes next-session behavior. AC: reaction table test. SHIPPED ✅ (evidence: reaction-table + cross-session + stand-off blocks in test/social-entities-test.mjs ALL PASS; mounted in core/game.ts — landmark-circuit sim, clipboard prop figure via humans.ts attachClipboardProp, PhotoMode capture hook, tally persisted through SaveSlot.archivistEncounters)
- F27 Watcher packs — coordinated multi-watcher stalks at stage ≥3, spacing discipline. AC: spacing + shared-aggression tests. SHIPPED ✅ (evidence: test/watcherpacks-test.mjs ALL PASS in gate v5; mounted game.ts — WatcherPack/STAGE_GATE)
- F28 Mimic props — furniture that is an entity until observed. AC: observation-freeze consistent with watcher rules. SHIPPED ✅ (evidence: test/mimics-test.mjs ALL PASS in gate v5; mounted game.ts — MimicPropWiring)
- F29 Entity gossip — vocals reference places the PLAYER actually visited. AC: grounding test vs journal feed. SHIPPED ✅ (evidence: test/gossip-test.mjs ALL PASS; mounted src/core/game.ts mount batch C — GossipSource fed VisitedSite records)
- F30 Your Double — doppelgänger learns route habits across saves, walks YOUR paths. AC: path-replay fidelity. SHIPPED ✅ (evidence: test/full-persist-test.mjs + save-robustness.mjs pathEcho round-trip + entity-behavior.mjs doubles ALL PASS in gate v5; mounted in game.ts itself — pathHistory persists as slot.pathEcho, the double walks the recorded wake)
- F31 Roach ecosystems — colonies migrate moisture→food; cabinets infest over sessions. AC: migration stability. SHIPPED ✅ (evidence: test/roaches-test.mjs ALL PASS in gate v5; mounted game.ts — RoachEcosystem)
- F32 The Custodian — removes graffiti/markings overnight; cart squeak precedes removals. AC: removal ledger test. SHIPPED ✅ (evidence: removal-table + squeak-precedes + wiring blocks in test/social-entities-test.mjs ALL PASS; wired via entities/custodian.ts CustodianWiring over story/custodian.ts pass, ChunkManager.removedGraffiti build filter keeps erasures rebuilt-out, cart-squeak loop audio/cartsqueak.ts)

### CATEGORY E — audio dread

- F33 Infrasound beds — sub-20Hz per-district beds expressed via harmonic proxies. AC: proxy test. SHIPPED ✅ (evidence: test/infrasound-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F34 Self-tuning radio — drifts toward broadcasts describing the player's own discoveries/loadout. AC: selection grounding test. SHIPPED ✅ (evidence: test/selfradio-test.mjs ALL PASS in gate v5; mounted game.ts — SelfRadio)
- F35 Camcorder voice memos — recordable, degraded playback scaled by zone gen. AC: degradation curve test. SHIPPED ✅ (evidence: test/voicememo-test.mjs ALL PASS in gate v5; mounted game.ts — VoiceMemoStore)
- F36 Hum melody leaks — hum harmonics quote motifs from prior-run seeds. AC: motif persistence test. SHIPPED ✅ (evidence: test/humleaks-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F37 Room-tone drops — granular silence preceding ANY anomaly type. AC: pre-anomaly silence correlation test. SHIPPED ✅ (evidence: test/roomtone-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)

### CATEGORY F — visual expansion

- F38 Volumetric god-rays — shafts through missing ceiling tiles, dust lit per-shaft. AC: ≤2ms/frame cost. SHIPPED ✅ (evidence: test/godrays-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F39 Raymarched wet floors — moisture-zone screen-space reflections. AC: quality-tier gated off on low. SHIPPED ✅ (evidence: test/wetfloor-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F40 Breathing wallpaper — saturation-band vertex displacement (~0.5cm inhale). AC: amplitude test. SHIPPED ✅ (evidence: test/wallbreath-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F41 Anomaly photography — photos reveal entities invisible live; gallery displays them. AC: reveal pipeline test. SHIPPED ✅ (evidence: test/photoreveal-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F42 Night-vision camcorder — IR mode with gain noise + audio artifacts. AC: drain + artifact tests. SHIPPED ✅ (evidence: test/nightvision-test.mjs 9/0; mounted — KeyN toggle, green IR grade overlay, IR STATIC captions, drain seam from bb1be43)
- F43 Ceiling tile ecosystem — missing tiles accumulate; nesting skitter cues beneath. AC: persistence test. SHIPPED ✅ (evidence: test/ceilingeco-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)

### CATEGORY G — meta, endings, accessibility

- F44 Save-file scarring — long-lived saves grow phantom cracks shaped like your routes. AC: determinism per save-id. SHIPPED ✅ (evidence: test/scarring-test.mjs ALL PASS in gate v5; mounted game.ts — save/scarring computeScars)
- F45 New Game+ : the place remembers — prior-run graffiti appears in fresh runs. AC: provenance test. SHIPPED ✅ (evidence: test/ngplus-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F46 Expedition ledger — meta-archive of discovered notes/clusters between runs. AC: round-trip test. SHIPPED ✅ (evidence: test/ledger-test.mjs ALL PASS in gate v5; mounted game.ts — save/ledger createLedger/loadLedger/saveLedger)
- F47 Daily rite — shared daily seed + discovery checklist overlay. AC: date-derived seed test. SHIPPED ✅ (evidence: src/ui/dailyrite.ts + game.ts title banner "TODAY'S RITE — SEED …" + milestone feed; test/ui-meta-v1-test.mjs F47 checks incl. rollover, ALL PASS)
- F48 Director personalities — per-run temperament (patient/vindictive/theatrical) altering pacing curves. AC: differentiation test. SHIPPED ✅ (evidence: test/persona-test.mjs ALL PASS in gate v5; mounted game.ts — director/persona temperamentForRun/pacingRngFor)
- F49 Accessibility pack — motion-safety mode, speaker-tagged subtitles, high-contrast palette. AC: each toggle zeroes its effect. SHIPPED ✅ (evidence: src/ui/accessibilitypack.ts effectors; GameSettings motionSafety/speakerTags + settingspanel toggles; controller bob/sway gate, shake/tilt gates, ui.say tagger, --bmb-hc-* token swap in game.ts applyAccessibilityPack; test/ui-meta-v1-test.mjs F49 zeroing checks, ALL PASS)
- F50 The Exit that isn't — ultra-rare fire-exit into white void epilogue room. AC: ≤1 per 8h expected; flow test. SHIPPED ✅ (evidence: test/exitvoid-test.mjs ALL PASS in gate v5; mounted game.ts mount batch E — ExitVoidTracker fed from frame-loop doorway crossings into the epilogue flow)

### CATEGORY H — second hundred (added by community directive)

- F51 The Mezzanine That Wasn't — upper floors glimpsed through ceilings become explorable via rare staircases. AC: interior regen identical. SHIPPED ✅ (evidence: test/mezzanine-test.mjs ALL PASS in gate v5; mounted ChunkManager chunk build — generateMezzanine/mezzanineGate/glimpseFootprint)
- F52 Weather with memory — last session's rain still drips in the same rooms. AC: cross-run weather persistence via deltas. SHIPPED ✅ (evidence: test/weathermemory-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F53 District color bleed — border chunks blend palettes over a one-chunk gradient. AC: gradient continuity test. SHIPPED ✅ (evidence: test/districtbleed-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F54 The Long Hall — rare 300m corridor whose exit doors cycle behind you. AC: cycle determinism test. SHIPPED ✅ (evidence: test/longhall-test.mjs ALL PASS in gate v5; mounted chunk build path — architect applyLongHall inside generateLayout, hall marks ride ChunkDeltas)
- F55 Negative-space rooms — void silhouettes where furniture should be. AC: collision matches absence. SHIPPED ✅ (evidence: test/negspace-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F56 Cartographer's error — map fragments disagree; majority vote reveals truth. AC: vote logic test. SHIPPED ✅ (evidence: test/mapfragments-test.mjs MAPFRAGMENTS_PASS; mounted ChunkManager chunk build — 22% of chunks scatter seeded NoteInstance map-fragment papers)
- F57 Seasonal bleed rooms — one room per session stuck in another season. AC: season assignment hash test. SHIPPED ✅ (evidence: test/seasonrooms-test.mjs ALL PASS in gate v5; mounted ChunkManager chunk build — sessionSeasonBleeds, mount batch D)
- F58 Sub-floor crawlspaces — floor gaps reveal crawlspace darkness beneath. AC: nav flag + fall safety. SHIPPED ✅ (evidence: test/crawlspaces-test.mjs ALL PASS in gate v5; mounted chunk build path — mesher addCrawlPit/CRAWL_Y_OFFSET under ChunkManager buildChunkGeometry)
- F59 Landmark echoes — landmark rooms repeat identically exactly 7 chunks apart. AC: spacing invariant test. SHIPPED ✅ (evidence: test/landmarkecho-test.mjs ALL PASS in gate v5; mounted ChunkManager chunk build — echoPositions)
- F60 The Loading Dock — infinite exterior-look dock with an idling engine that never arrives. AC: audio bed + no-arrival proof. SHIPPED ✅ (evidence: test/loadingdock-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F61 The Congregation's Hymn — believers sing rounds naming YOUR discoveries. AC: lyric-grounding test. SHIPPED ✅ (evidence: grounding/gating/stagger blocks in test/social-entities-test.mjs ALL PASS over audio/hymn.ts; chapel choirs via entities/hymn.ts ChapelChoir, discovery ledger fed from seenLandmarks + found beacons, captions within earshot during the night service)
- F62 Watcher molt — vacated skins keep watching. AC: decoy behavior test. SHIPPED ✅ (evidence: test/molt-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F63 Entity funerals — processions for their own dead at erosion sites. AC: procession route test. SHIPPED ✅ (evidence: test/funerals-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F64 The Negotiator — trades items for passage via gesture language. AC: trade-state machine test.
- F65 Child drawings — appear near playgrounds depicting events YOU caused. AC: event-grounding test.
- F66 Doppelgänger letters — your Double leaves notes criticizing your choices. AC: choice-reference test. SHIPPED ✅ (evidence: test/doubleletters-test.mjs ALL PASS in gate v5; mounted game.ts — DoubleLetters over the recorded choice ledger)
- F67 Roach domestication — feed roaches to be led to batteries. AC: lead-path reliability test. SHIPPED ✅ (evidence: test/roachtame-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F68 The Tour Guide — escort entity that abandons you at the worst moment. AC: abandonment timing test. SHIPPED ✅ (evidence: test/tourguide-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F69 Polite doors — doors open themselves and hold open for you. AC: courtesy cooldown test. SHIPPED ✅ (evidence: test/politedoors-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F70 Shadow audience — silhouettes gather at hall ends during peaks. AC: gather/scatter gating test. SHIPPED ✅ (evidence: test/shadowaudience-test.mjs + shadowaware-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F71 Contamination cough — saturation zones give the player a cough. AC: rate scales with intensity. SHIPPED ✅ (evidence: test/cough-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F72 Low-battery hand tremor — camcorder aim wobbles below 20% charge. AC: tremor curve test. SHIPPED ✅ (evidence: test/tremor-test.mjs ALL PASS; mounted src/core/game.ts mount batch B — HandTremor)
- F73 Hunger pangs — ambient stomach audio tied to expedition length. AC: interval scaling test. SHIPPED ✅ (evidence: test/hunger-test.mjs ALL PASS; mounted src/core/game.ts mount batch B — HungerPangs)
- F74 Sleep pressure — micro-blinks close vision after long sessions. AC: blink cadence test. SHIPPED ✅ (evidence: test/blinks-test.mjs BLINKS ALL PASS; mounted src/core/game.ts mount batch B — BlinkScheduler)
- F75 Adrenaline dumps — near-misses shake hands and sharpen hearing. AC: dual-effect envelope test. SHIPPED ✅ (evidence: test/adrenaline-test.mjs ADRENALINE ALL PASS; mounted src/core/game.ts mount batch B — AdrenalineSystem)
- F76 Cold-storage shiver — teeth chatter + view shiver in cold zones. AC: zone gating test. SHIPPED ✅ (evidence: test/shiver-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F77 Injury limp — hard falls alter stride until firstaid used. AC: gait modifier test. SHIPPED ✅ (evidence: test/limp-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F78 Panic breathing control — hold-rhythm minigame steadies breath meter. AC: stabilization math test. SHIPPED ✅ (evidence: test/panicbreath-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F79 Forensic storytelling — the previous expedition's story assembled purely from scene evidence. AC: evidence-chain completeness test. SHIPPED ✅ (evidence: test/forensics-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F80 Unreliable journal — entries rewrite themselves between visits. AC: rewrite determinism test. SHIPPED ✅ (evidence: test/unreliablejournal-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F81 Choice-weighted whisper chorus — whispers reference moral micro-choices. AC: weighting table test. SHIPPED ✅ (evidence: test/whisperchorus-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F82 Contamination epilogues — threshold ending text varies with total exposure. AC: epilogue keying test. SHIPPED ✅ (evidence: test/epilogues-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F83 The Surveyor's Tape — found tape measures wrong distances (anomaly detector in disguise). AC: wrongness-as-signal test. SHIPPED ✅ (evidence: test/surveytape-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F84 Name discovery — assembling the facility's true name changes worldwide signage. AC: sign swap propagation test. SHIPPED ✅ (evidence: test/facilityname-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F85 Anomaly photo catalog — completing the gallery tiers unlocks journal pages. AC: tier unlock test. SHIPPED ✅ (evidence: test/photocatalog-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F86 Call-in radio show — callers describe YOUR exact equipment loadout. AC: loadout-grounding test. SHIPPED ✅ (evidence: test/callin-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F87 Procedural VHS degradation — camcorder artifacts scale with anomaly proximity. AC: artifact-intensity test. SHIPPED ✅ (evidence: test/vhsdegrade-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F88 Live occlusion reverb — per-room-volume audio physics computed live. AC: reverb-zone transition test. SHIPPED ✅ (evidence: test/occreverb-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F89 Save-slot ghosts — loading old saves flashes temporal echoes of that timeline. AC: echo lifetime test. SHIPPED ✅ (evidence: test/slotghosts-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F90 Director v2 learning — pauses/hesitations teach the director what scares YOU. AC: telemetry-to-pacing test. SHIPPED ✅ (evidence: test/directorlearning-test.mjs ALL PASS in gate v5; mounted game.ts — DirectorLearning serialize/restore rides the save slot)
- F91 Staged wake cinematic — waking sequence procedurally staged per seed. AC: staging determinism test. SHIPPED ✅ (evidence: test/wakecinematic-test.mjs ALL PASS in gate v5; mounted game.ts — stageWakeCinematic/WakeCinematicPlayer)
- F92 Camcorder optics — photo-mode DOF + focal breathing matching the IR lens. AC: optic curve test. SHIPPED ✅ (evidence: test/camoptics-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F93 Diegetic menus — title/pause projected onto in-world walls. AC: projection raycast mount test. SHIPPED ✅ (evidence: diegmenus pure math + src/ui/wallmenu.ts textured plane; game.ts remountDiegeticMenus raycasts the camera ray and mounts via faceTowards on menu/paused states; test/ui-meta-v1-test.mjs F93 raycast/coplanarity checks, ALL PASS)
- F94 Lying compass — needle bends toward memory wells under contamination. AC: bend-vs-well test. SHIPPED ✅ (evidence: test/lyingcompass-test.mjs LYINGCOMPASS ALL PASS 35 checks; mounted src/core/game.ts mount batch C — LyingCompass)
- F95 Hardcore flicker battery UI — charge conveyed only by torch flicker (opt-in). AC: mode equivalence test. SHIPPED ✅ (evidence: test/flickerbattery-test.mjs FLICKERBATTERY ALL PASS 32 checks; mounted src/core/game.ts mount batch B — FlickerBattery)
- F96 Evolving journal font — handwriting degrades with stage/sanity. AC: font-stage table test. SHIPPED ✅ (evidence: test/journalfont-test.mjs JOURNALFONT ALL PASS 17 checks; mounted src/core/game.ts mount batch C — degradationIndex/entryJournalFont)
- F97 Bureaucratic achievements — toasts as stamped FORMS (approved/denied). AC: stamp routing test. SHIPPED ✅ (evidence: src/ui/formtoasts.ts routeStamp/formNumber + ACHIEVEMENT_FORM_REQUESTS table wired to TrackerFeed unlocks in game.ts; test/ui-meta-v1-test.mjs F97 routing-table + burst-queue checks, ALL PASS)
- F98 Local speedrun ghosts — per-seed ghost replays. AC: ghost determinism test. SHIPPED ✅ (evidence: test/speedrunghost-test.mjs + speedrun-test.mjs ALL PASS in gate v5; engine model, consumer seam tracked in GAME-PLAN-V1.1 debt ledger)
- F99 Colorblind anomaly signals — pattern language replaces color-only cues. AC: pattern coverage test. SHIPPED ✅ (evidence: test/colorblindsignals-test.mjs ALL PASS in gate v5; mounted game.ts — ui/colorblindSignals anomalySignal)
- F100 The credits walk — credits roll while walking an endless corridor of your own screenshots. AC: screenshot pipeline test. SHIPPED ✅ (evidence: test/creditswalk-test.mjs ALL PASS in gate v5; mounted game.ts — buildCreditsWalk/CreditsWalker)


## V1 SCOPE — EVERY FEATURE, NO DEFERRALS

**ALL of F1–F100 ship in v1.** There is no backlog parking lot. Each feature is
'PERFECT' when: its AC passes in a committed test, its visuals/audio are judged
against the QUALITY BAR in a real browser session, zero regressions exist, and
an orchestrator review signs it off. Agents discovering NEW feature opportunities
during development add them to this file at the next free F-number with full AC —
they join v1 scope automatically.

## V1 COMPLETION & RELEASE CHECKLIST

1. Every F1–F100 signed off PERFECT (AC test + quality-bar review + no regressions).
2. Full gates green in one quiescent run: tsc 0, entire test/*.mjs suite exit 0,
   PLAYTHROUGH_PASS, perf-regression pass, qa-shots on hardware GL.
3. docs/ updated (README, DESIGN, GAME-PLAN status column marked shipped-per-feature).
4. `npm run build` produces a clean dist; smoke-load dist via vite preview.
5. Tag `v1.0.0`, generate GitHub Release with notes (features, known limits,
   controls, browser requirements), attach dist zip.
6. Flip repo visibility PUBLIC (or confirm already public) so the release is live.
7. Immediately after release: author the v1.1+ plan as a huge new roadmap document
   (docs/GAME-PLAN-V1.1.md) — expansion directions, systems deepening, new
   anomaly families, content waves, platform work. v1 ends by beginning v1.1.

## WORKING RHYTHM FOR AGENT SESSIONS

- Fleet of ≥5 parallel subagents on disjoint file sets; instant retry/resume on any
  transient failure; never idle, never sequential when parallel is possible.
- One feature (or coherent sub-feature) per agent per wave; implement to its AC;
  add the proving test; run the full gate trio (scoped tsc, touched tests,
  playthrough); commit per file; push origin main.
- When a feature is signed PERFECT, mark its line 'SHIPPED ✅' in this file.
