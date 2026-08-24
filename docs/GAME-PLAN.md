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

- F1 Wave-B/C wiring restoration — journal/tracker/checkpoint-savescreen/watcher-intro chains constructed + fed in game.ts init/frame; frameUpdate + onChunkFixtures emergency hooks re-added. AC: wave-c + emergency suites exit 0 with ZERO DEFECT skips.
- F2 Central integration mounts — applyRenderClarity / breath / areaidentity / ShadowMesherPass consumers mounted from game.ts per report snippets. AC: clarity tiers visibly switch; breathing audible under sprint; district beds change on district change; playthrough unaffected.
- F3 Determinism audit — replace verbatim Math.random sites (relocation/camera-shake) with hash2i/RNG draws; add test/determinism-audit.mjs scanning sim/gen paths. AC: audit exits 0; relocation replays identical per seed.
- F4 Hardware-GL QA sweep — qa-shots + playthrough on real GPU (non-swiftshader); six screenshots into shots/. AC: zero console errors; crisp-render verified.

### CATEGORY B — embodiment

- F5 Binaural whisper field — HRTF-panned whispers fixed in world space while ears move. AC: panning inverts with 180° turn (graph test).
- F6 Dread silence — director-commanded total mix duck (<-24 dB, 8–20 s) before major anomalies + recovery exhale. AC: automation provable; capped 1/25 min.
- F7 Footstep DNA — per-archetype gait signatures identifiable before line-of-sight. AC: classifier ≥95% accuracy on synthetic trains.
- F8 Gait-synced dread — high tension drifts footstep micro-timing toward heartbeat interval. AC: phase-coherence metric monotone with tension.
- F9 Stamina embodiment — low stamina alters breath rate, stride sound, FOV pulse. AC: three outputs scale monotonically.
- F10 Lean/peek Q/E around doorframes — camera roll + parallax. AC: collision-safe lean envelope.
- F11 Torch view-model — visible flashlight hand, sway, battery-swap beat <1.2s. AC: light follows mesh.
- F12 Surface wading — puddles slow stride, splash, wet-footprint trail. AC: penalty + spawn tests.
- F13 Vault/mantle crates — choreographed camera dip. AC: no collider clip; dip curve test.
- F14 Fall stagger — postfx blur + control damp after hard falls. AC: recovery timeline test.

### CATEGORY C — deeper wrongness

- F15 Pocket dimensions — seeded doors open into interiors larger than the building. AC: interior byte-identical regen; exterior unchanged.
- F16 Blackout rearrangement — props drift one slot, one door bricks after blackouts. AC: deltas reversible.
- F17 Echo geography — halls return YOUR earlier footsteps/memos as distant echoes. AC: deterministic replay per site.
- F18 Time slippage — clocks/camcorder/session timer disagree inside saturation zones. AC: offsets consistent per zone seed.
- F19 Impossible windows — lit rooms visible where exterior should be. AC: registry + culling test.
- F20 Unobserved stairwell loop — loops only while gaze-away >2s. AC: trigger iff condition (reuses stretch logic).
- F21 Memory residue touch — tagged objects play ghost replays of prior tenants. AC: one-shot per visit.
- F22 Gravity ambivalence — saturation zones tilt balance ±5° with veering walk. AC: bounded, exits cleanly.
- F23 Door/wall swaps — door opens into wall; adjacent wall becomes a door. AC: nav+collision+mesh atomic swap test.
- F24 Aging corridors — revisits accumulate decay proportional to sessions since first seen. AC: persists via ChunkDeltas.

### CATEGORY D — entities & society

- F25 Believer congregations — chapel landmarks host kneeling night services. AC: formation/dispersal tests.
- F26 The Archivist — harmless cataloguer; photographing it changes next-session behavior. AC: reaction table test.
- F27 Watcher packs — coordinated multi-watcher stalks at stage ≥3, spacing discipline. AC: spacing + shared-aggression tests.
- F28 Mimic props — furniture that is an entity until observed. AC: observation-freeze consistent with watcher rules.
- F29 Entity gossip — vocals reference places the PLAYER actually visited. AC: grounding test vs journal feed.
- F30 Your Double — doppelgänger learns route habits across saves, walks YOUR paths. AC: path-replay fidelity.
- F31 Roach ecosystems — colonies migrate moisture→food; cabinets infest over sessions. AC: migration stability.
- F32 The Custodian — removes graffiti/markings overnight; cart squeak precedes removals. AC: removal ledger test.

### CATEGORY E — audio dread

- F33 Infrasound beds — sub-20Hz per-district beds expressed via harmonic proxies. AC: proxy test.
- F34 Self-tuning radio — drifts toward broadcasts describing the player's own discoveries/loadout. AC: selection grounding test.
- F35 Camcorder voice memos — recordable, degraded playback scaled by zone gen. AC: degradation curve test.
- F36 Hum melody leaks — hum harmonics quote motifs from prior-run seeds. AC: motif persistence test.
- F37 Room-tone drops — granular silence preceding ANY anomaly type. AC: pre-anomaly silence correlation test.

### CATEGORY F — visual expansion

- F38 Volumetric god-rays — shafts through missing ceiling tiles, dust lit per-shaft. AC: ≤2ms/frame cost.
- F39 Raymarched wet floors — moisture-zone screen-space reflections. AC: quality-tier gated off on low.
- F40 Breathing wallpaper — saturation-band vertex displacement (~0.5cm inhale). AC: amplitude test.
- F41 Anomaly photography — photos reveal entities invisible live; gallery displays them. AC: reveal pipeline test.
- F42 Night-vision camcorder — IR mode with gain noise + audio artifacts. AC: drain + artifact tests.
- F43 Ceiling tile ecosystem — missing tiles accumulate; nesting skitter cues beneath. AC: persistence test.

### CATEGORY G — meta, endings, accessibility

- F44 Save-file scarring — long-lived saves grow phantom cracks shaped like your routes. AC: determinism per save-id.
- F45 New Game+ : the place remembers — prior-run graffiti appears in fresh runs. AC: provenance test.
- F46 Expedition ledger — meta-archive of discovered notes/clusters between runs. AC: round-trip test.
- F47 Daily rite — shared daily seed + discovery checklist overlay. AC: date-derived seed test.
- F48 Director personalities — per-run temperament (patient/vindictive/theatrical) altering pacing curves. AC: differentiation test.
- F49 Accessibility pack — motion-safety mode, speaker-tagged subtitles, high-contrast palette. AC: each toggle zeroes its effect.
- F50 The Exit that isn't — ultra-rare fire-exit into white void epilogue room. AC: ≤1 per 8h expected; flow test.

### CATEGORY H — second hundred (added by community directive)

- F51 The Mezzanine That Wasn't — upper floors glimpsed through ceilings become explorable via rare staircases. AC: interior regen identical.
- F52 Weather with memory — last session's rain still drips in the same rooms. AC: cross-run weather persistence via deltas.
- F53 District color bleed — border chunks blend palettes over a one-chunk gradient. AC: gradient continuity test.
- F54 The Long Hall — rare 300m corridor whose exit doors cycle behind you. AC: cycle determinism test.
- F55 Negative-space rooms — void silhouettes where furniture should be. AC: collision matches absence.
- F56 Cartographer's error — map fragments disagree; majority vote reveals truth. AC: vote logic test.
- F57 Seasonal bleed rooms — one room per session stuck in another season. AC: season assignment hash test.
- F58 Sub-floor crawlspaces — floor gaps reveal crawlspace darkness beneath. AC: nav flag + fall safety.
- F59 Landmark echoes — landmark rooms repeat identically exactly 7 chunks apart. AC: spacing invariant test.
- F60 The Loading Dock — infinite exterior-look dock with an idling engine that never arrives. AC: audio bed + no-arrival proof.
- F61 The Congregation's Hymn — believers sing rounds naming YOUR discoveries. AC: lyric-grounding test.
- F62 Watcher molt — vacated skins keep watching. AC: decoy behavior test.
- F63 Entity funerals — processions for their own dead at erosion sites. AC: procession route test.
- F64 The Negotiator — trades items for passage via gesture language. AC: trade-state machine test.
- F65 Child drawings — appear near playgrounds depicting events YOU caused. AC: event-grounding test.
- F66 Doppelgänger letters — your Double leaves notes criticizing your choices. AC: choice-reference test.
- F67 Roach domestication — feed roaches to be led to batteries. AC: lead-path reliability test.
- F68 The Tour Guide — escort entity that abandons you at the worst moment. AC: abandonment timing test.
- F69 Polite doors — doors open themselves and hold open for you. AC: courtesy cooldown test.
- F70 Shadow audience — silhouettes gather at hall ends during peaks. AC: gather/scatter gating test.
- F71 Contamination cough — saturation zones give the player a cough. AC: rate scales with intensity.
- F72 Low-battery hand tremor — camcorder aim wobbles below 20% charge. AC: tremor curve test.
- F73 Hunger pangs — ambient stomach audio tied to expedition length. AC: interval scaling test.
- F74 Sleep pressure — micro-blinks close vision after long sessions. AC: blink cadence test.
- F75 Adrenaline dumps — near-misses shake hands and sharpen hearing. AC: dual-effect envelope test.
- F76 Cold-storage shiver — teeth chatter + view shiver in cold zones. AC: zone gating test.
- F77 Injury limp — hard falls alter stride until firstaid used. AC: gait modifier test.
- F78 Panic breathing control — hold-rhythm minigame steadies breath meter. AC: stabilization math test.
- F79 Forensic storytelling — the previous expedition's story assembled purely from scene evidence. AC: evidence-chain completeness test.
- F80 Unreliable journal — entries rewrite themselves between visits. AC: rewrite determinism test.
- F81 Choice-weighted whisper chorus — whispers reference moral micro-choices. AC: weighting table test.
- F82 Contamination epilogues — threshold ending text varies with total exposure. AC: epilogue keying test.
- F83 The Surveyor's Tape — found tape measures wrong distances (anomaly detector in disguise). AC: wrongness-as-signal test.
- F84 Name discovery — assembling the facility's true name changes worldwide signage. AC: sign swap propagation test.
- F85 Anomaly photo catalog — completing the gallery tiers unlocks journal pages. AC: tier unlock test.
- F86 Call-in radio show — callers describe YOUR exact equipment loadout. AC: loadout-grounding test.
- F87 Procedural VHS degradation — camcorder artifacts scale with anomaly proximity. AC: artifact-intensity test.
- F88 Live occlusion reverb — per-room-volume audio physics computed live. AC: reverb-zone transition test.
- F89 Save-slot ghosts — loading old saves flashes temporal echoes of that timeline. AC: echo lifetime test.
- F90 Director v2 learning — pauses/hesitations teach the director what scares YOU. AC: telemetry-to-pacing test.
- F91 Staged wake cinematic — waking sequence procedurally staged per seed. AC: staging determinism test.
- F92 Camcorder optics — photo-mode DOF + focal breathing matching the IR lens. AC: optic curve test.
- F93 Diegetic menus — title/pause projected onto in-world walls. AC: projection raycast mount test.
- F94 Lying compass — needle bends toward memory wells under contamination. AC: bend-vs-well test.
- F95 Hardcore flicker battery UI — charge conveyed only by torch flicker (opt-in). AC: mode equivalence test.
- F96 Evolving journal font — handwriting degrades with stage/sanity. AC: font-stage table test.
- F97 Bureaucratic achievements — toasts as stamped FORMS (approved/denied). AC: stamp routing test.
- F98 Local speedrun ghosts — per-seed ghost replays. AC: ghost determinism test.
- F99 Colorblind anomaly signals — pattern language replaces color-only cues. AC: pattern coverage test.
- F100 The credits walk — credits roll while walking an endless corridor of your own screenshots. AC: screenshot pipeline test.


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
