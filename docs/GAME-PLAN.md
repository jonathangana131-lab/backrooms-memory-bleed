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
- Built: chunk streaming world (architect/mesher/chunkManager), memory
  contamination field + weather fronts, horror director FSM, entities (watcher/
  wanderer/helper/believer/incomplete/double/fauna) with gaze/vocals/fidgets/
  sitting/schedules/graceful despawn, spatial anomalies (doorway déjà-vu,
  corridor stretch, migrating lights, mirror steps), contamination visuals
  (tint drift, bleed decals, warm murk fog), full UI suite (journal/gallery/
  endstats/compass/minimap/tracker/savescreen/settings/radiotune/weatherui),
  save system (IndexedDB + checkpoints), render clarity pass, player breath +
  area-identity audio, Wave-B ambience pack, momentum movement feel.
- Known gaps tracked as DEFECT skips in wave-c/emergency suites: journal chain,
  tracker chain, checkpoint-save-screen mount, watcher-intro mount,
  frameUpdate/onChunkFixtures hooks — these wirings are v1 must-fix items (F1).

## HARD RULES FOR ALL WORK

- Feature isolation: systems talk via src/core/events.ts or injected interfaces.
- Strict TS ES2022, match local style, JSDoc headers, no new npm deps without
  orchestrator approval.
- Tests colocated in test/*.mjs (node strip-types or transpile-loader idioms —
  copy an existing healthy sibling).
- Gates before any commit: scoped tsc zero for touched files, touched tests exit 0,
  'node test/playthrough.mjs' prints PLAYTHROUGH_PASS.
- One commit per file. Never /private/tmp for anything durable.

## ROADMAP — 50 FEATURES (tiers; F-numbers are stable ids)

### TIER A — v1 completion blockers (do first)

- **F1 Wave-B/C wiring restoration** — journal/tracker/checkpoint-savescreen/
  watcher-intro chains constructed + fed in game.ts init/frame; frameUpdate +
  onChunkFixtures emergency hooks re-added. AC: wave-c + emergency suites exit 0
  with ZERO DEFECT skips.
- **F2 Central integration mounts** — applyRenderClarity/breath/areaidentity/
  ShadowMesherPass consumers mounted from game.ts per their report snippets.
  AC: visible clarity tiers + breathing audible under sprint + district beds on
  district change; playthrough unaffected.
- **F3 Determinism audit** — replace verbatim Math.random sites in relocation/
  camera-shake with hash2i/RNG draws; add test/determinism-audit.mjs scanning
  sim/gen paths. AC: audit exits 0; relocation replays identical per seed.
- **F4 Hardware-GL QA sweep** — qa-shots + playthrough on real GPU (non-
  swiftshader); capture 6 screenshots into shots/. AC: zero console errors.

### TIER B — atmosphere & embodiment deepening

- **F5 Binaural whisper field** — HRTF-panned whispers tied to head rotation
  (they stay put in world space while your ears move). AC: panning inverts with
  180° turn in headless audio-graph test.
- **F6 Dread silence** — director-commanded total mix duck (<-24 dB, 8–20 s)
  immediately before major anomalies; recovery exhale afterward. AC: mix automation
  provable in graph test; frequency capped 1/25 min.
- **F7 Footstep DNA** — each archetype gets a gait signature (interval/ratio/
  surface bias) identifiable before line-of-sight. AC: classifier test over
  synthetic step trains ≥95% kind accuracy.
- **F8 Gait-synced dread** — under high tension, footstep micro-timing drifts
  toward the heartbeat interval (the place entrains you). AC: phase-coherence metric.
- **F9 Stamina embodiment** — low stamina alters breath rate, stride sound, FOV
  pulse. AC: three observable outputs scale monotonically with stamina.
- **F10 Lean/peek** — Q/E lean around doorframes with camera roll + parallax.
  AC: collision-safe lean envelope test.
- **F11 Torch view-model** — visible flashlight hand with sway, battery-swap beat
  (procedural mesh, no assets). AC: swap animation completes <1.2s; light follows.
- **F12 Surface wading** — puddle zones slow stride, splash steps, wet-footprint
  trail via existing footprints.ts. AC: speed penalty + trail spawn tests.
- **F13 Vault/mantle** — hop low crates with choreographed camera dip. AC: no clip
  through colliders; dip curve test.
- **F14 Fall stagger** — vision blur (postfx) + control damp after hard falls.
  AC: recovery timeline test.

### TIER C — deeper wrongness (the vibe core)

- **F15 Pocket dimensions** — seeded doors open into interiors larger than the
  building (non-Euclidean sub-chunk). AC: interior regenerates byte-identical;
  exterior footprint unchanged.
- **F16 Blackout rearrangement** — rooms settle subtly WRONG after blackouts
  (props drifted one slot, one door now bricked). AC: deltas reversible.
- **F17 Echo geography** — certain halls return YOUR earlier footsteps/voice
  memos as distant echoes. AC: replay buffer deterministic per site.
- **F18 Time slippage** — wall clocks, camcorder timestamp, and session timer
  disagree inside saturation zones. AC: offsets consistent per zone seed.
- **F19 Impossible windows** — rare windows show lit rooms where exterior should
  be. AC: window registry + culling test.
- **F20 Unobserved stairwell loop** — a stairwell loops only while unwatched.
  AC: loop triggers iff gaze-away >2s (reuse corridor-stretch logic).
- **F21 Memory residue touch** — interacting with tagged objects plays ghost
  replays (audio vignettes from prior 'tenants'). AC: one-shot per visit.
- **F22 Gravity ambivalence** — saturation-band zones tilt balance: subtle camera
  roll pressure + veering walk. AC: tilt bounded ±5°, exits cleanly.
- **F23 Door/wall swaps** — rare event: door opens into wall; the wall beside it
  becomes a door. AC: nav+collision+mesh all swap atomically.
- **F24 Aging corridors** — revisited hallways accumulate decay proportional to
  sessions since first seen. AC: decay state persists via ChunkDeltas.

### TIER D — entities & society

- **F25 Believer congregations** — chapel landmarks host kneeling groups mid-
  service at night-cycle. AC: group formation + dispersal tests.
- **F26 The Archivist** — harmless entity cataloguing rooms; photographing it
  changes its behavior next session. AC: reaction table test.
- **F27 Watcher packs** — coordinated multi-watcher stalks at stage ≥3 with
  spacing discipline. AC: min-spacing + shared-aggression test.
- **F28 Mimic props** — furniture pieces that are entities until observed; freeze
  mechanic consistent with watcher rules. AC: observation-freeze test.
- **F29 Entity gossip** — vocals reference actual places the PLAYER visited
  (journal feed feeds vocal selection). AC: reference-grounding test.
- **F30 Your Double** — doppelgänger learns route habits across saves; appears
  walking YOUR recorded paths. AC: path-replay fidelity test.
- **F31 Roach ecosystems** — colonies migrate moisture→food scraps; cabinets
  infest over sessions. AC: migration model stability test.
- **F32 The Custodian** — overnight entity removes your graffiti/markings; its
  cart squeak is audible before you see the removals. AC: removal ledger test.

### TIER E — audio/dread expansion

- **F33 Infrasound beds** — sub-20Hz beds per district expressed via harmonic
  proxies (felt not heard). AC: harmonic-proxy test.
- **F34 Self-tuning radio** — radio drifts toward broadcasts describing the
  player's own discoveries. AC: script-selection grounding test.
- **F35 Camcorder voice memos** — recordable, played back degraded by zone gen.
  AC: degradation curve test.
- **F36 Hum melodies leak across sessions** — hum harmonics quote motifs from
  prior-run seeds. AC: motif persistence test.
- **F37 Room-tone drops** — granular silence events preceding ANY anomaly type
  (generalizing F6). AC: pre-anomaly silence correlation test.

### TIER F — visual/atmosphere expansion

- **F38 Volumetric shafts** — god-rays through missing ceiling tiles with dust
  (dust.ts particles lit per-shaft). AC: perf budget ≤2ms/frame.
- **F39 Raymarched wet floors** — moisture-zone floor reflections (screen-space).
  AC: quality-tier gated; low tier off.
- **F40 Breathing wallpaper** — vertex displacement breathing at saturation band
  (walls inhale ~0.5cm). AC: displacement amplitude test.
- **F41 Anomaly photography** — camcorder photos reveal entities invisible live;
  gallery displays them. AC: photo-entity reveal pipeline test.
- **F42 Night-vision camcorder** — IR mode with gain noise + audio artifacts.
  AC: battery drain + artifact tests.
- **F43 Ceiling tile ecosystem** — missing tiles accumulate; things nest above
  (skitter audio cue when beneath). AC: accumulation persistence test.

### TIER G — meta, endings, accessibility

- **F44 Save-file scarring** — long-lived saves grow phantom geometry scars
  (cracks shaped like your routes). AC: scar determinism per save-id.
- **F45 New Game+ : the place remembers** — prior-run graffiti appears in new
  runs. AC: cross-run graffiti provenance test.
- **F46 Expedition ledger** — meta-progression archive of discovered notes/
  clusters between runs. AC: ledger round-trip test.
- **F47 Daily rite** — shared daily seed + discovery checklist overlay. AC:
  date-derived seed test.
- **F48 Director personalities** — each run's director rolls a temperament
  (patient/vindictive/theatrical) altering pacing curves. AC: temperament curve
  differentiation test.
- **F49 Accessibility pack** — motion-safety mode (no shake/tilt/anomalies that
  displace), speaker-tagged subtitles, high-contrast palette. AC: each toggle
  provably zeroes its effect.
- **F50 The Exit that isn't** — ultra-rare fire-exit doors open onto a white void
  epilogue room (mirror of threshold ending; no escape). AC: encounter rate ≤1
  per 8h expected; epilogue flow test.

## SEQUENCING

v1.0 = F1→F4 + polish sweep (current defects closed, screenshots captured).
v1.1 = Tier B complete. v1.2 = Tier C flagship anomalies expanded.
v1.3 = Tier D entities society. v1.4 = Tiers E/F. v2 = Tier G + endings matrix.

Agents: pick ONE feature per session-wave, implement to its AC, keep every gate
green, commit per file. The game ships when the quality bar stops being met only
in snapshots and starts being met everywhere at once.

