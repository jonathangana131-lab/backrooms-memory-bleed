# BACKROOMS: MEMORY BLEED — V1.1 GAME PLAN & REQUIREMENTS

*This document begins where GAME-PLAN.md ends (completion checklist item 7):
v1 ends by beginning v1.1. Every agent session working on v1.1 implements
pieces of this file. The next hundred exist here — not in any chat*.

## WHAT V1.1 IS

Deepening, not bloat. v1 built the wrong place; v1.1 makes it wronger. Same
dread philosophy — DREAD COMES FROM WRONGNESS, never from jumpscares, monsters,
or copied lore — aimed at harder wrongness: anomalies that compose instead of
coexist, a society of entities with politics instead of spawn tables, a place
that carries evidence of the player across runs instead of resetting. Nothing
in v1.1 adds content the pitch cannot justify: if a feature could ship in a
lesser horror game without embarrassment, it does not belong here.

The QUALITY BAR and HARD RULES of GAME-PLAN.md carry forward verbatim and
remain non-negotiable: dream-state clarity, embodied presence, layered
procedural audio, uncertainty engine, no cheap tricks, determinism law,
procedural-only assets. Every v1.1 feature inherits them before its own AC.

## NUMBERING & SCOPE LAW

- Features are numbered F101+ continuing v1's F1–F100 without gaps or reuse.
- ALL of F101–F166 are v1.1 scope. There is no backlog parking lot. Each
  feature is 'PERFECT' when: its AC passes in a committed test, its result is
  judged against the QUALITY BAR in a real browser session, zero regressions
  exist, and an orchestrator review signs it off.
- Agents discovering new opportunities during development add them at the next
  free F-number with full AC — they join v1.1 scope automatically.
- When a feature is signed PERFECT, mark its line 'SHIPPED ✅' in this file
  with evidence, exactly as GAME-PLAN.md does.

### CATEGORY I — deeper anomaly families

- F101 Recursive rooms — a room contains a walkable scale replica of itself,
  nested at least three levels deep, smallest furnished. AC: byte-identical regen per level; interior/exterior isolation test.
- F102 Corridor recursion — a hallway whose far end is its own near end at
  0.9 scale, so walking it shrinks the walker's reference frame. AC: door-frame scale ratio monotone with traversal; exit restores exact pose.
- F103 Learning architecture — the layout generator down-weights corridor
  shapes the player over-used in prior sessions, so the building rebuilds
  against habit. AC: route-frequency histogram measurably shifts layout weights across sessions; same-seed replay unchanged within a session.
- F104 Route amnesia — doors traversed above a per-session threshold brick
  themselves shut in later sessions with fresh plaster evidence. AC: delta ledger records bricking; reversible under seed rotation.
- F105 Anomaly hybrids — pairs of shipped anomalies co-scheduled in one zone
  compose (stretch × déjà-vu yields a hallway you remember entering longer).
  AC: composition matrix test proves pairwise rule application and no triple-stack.
- F106 Anomaly fossils — prior anomalies leave petrified strata in walls:
  a stretched seam frozen mid-tear, a doorway outline bricked at the wrong height.
  AC: fossil registry keyed to anomaly history persists via ChunkDeltas.
- F107 Premonition geometry — rooms generate with furniture arranged for an
  anomaly scheduled days later, then fulfill it. AC: layout hash matches prophecy table keyed to future anomaly seed.
- F108 Photographed rooms drift — rooms the player photographs regenerate
  subtly altered next session, as if the camera took something. AC: alteration deltas deterministic per (save-id, photo set); untouched rooms bit-stable.
- F109 Signage loops — exit signs form a directed cycle that returns to its
  own first sign after N hops, all pointing somewhere impossible. AC: graph cycle detection test; sign text grounded to visited-site names.
- F110 Saturation tides — contamination zones breathe across real hours,
  advancing and retreating district borders with tide tables per save. AC: tide table deterministic per save-id; border chunks re-blend without leaks.
- F111 Wrong weather indoors — rain falls in one corridor from a dry ceiling;
  puddles reflect a sky where the ceiling should be. AC: particle column bounded to corridor volume; reflection cubemap claims open sky.
- F112 Delayed geometry — a wall the player heard being built appears finished
  only when looked at for the second time. AC: build-audio precedes mesh by fixed latency; gaze-count gating test.

### CATEGORY J — society depth

- F113 Faction treaties — watcher packs and believer congregations maintain
  territorial boundaries; crossing them triggers staged standoffs, not combat.
  AC: standoff state machine covers approach/hold/withdraw; no overlap spawns inside treaty lines.
- F114 The Custodian's union — multiple custodians work shifts, log removals
  in a shared ledger, and refuse duty (carts parked, lights off) during strikes.
  AC: shift roster deterministic per week-seed; strike halts F32 removals and leaves ledger entries.
- F115 Economy of memories — entities trade recorded moments as currency;
  the Negotiator (F64) prices passage in moments the player actually lived.
  AC: price quotes grounded to journal feed; payment removes the moment from echo geography (F17) until repurchased.
- F116 Border graffiti — factions mark boundaries with distinct glyph styles;
  the Custodian erases rival marks preferentially. AC: glyph style classifier ≥95% on synthetic sets; removal order favors rival marks.
- F117 Entity tribunals — congregations hold motionless proceedings over a
  seated accused; verdict changes local vocal tone for sessions. AC: proceeding formation valid; verdict-to-tone mapping table test.
- F118 Diplomacy glimpses — player can witness (never join) exchange rituals:
  mirrored bows, object passes at exact distances. AC: ritual scripts play only outside player aggro radius; interrupt-safe.
- F119 Player standing — factions track the player's interference history and
  adjust gaze-grace and vocal address accordingly. AC: reputation table monotone per action class; effects bounded.
- F120 Memory black market — a rotating stall where spent moments are resold
  degraded, so buying back your own memory returns a worse copy. AC: degradation compounds per resale; stock rotation deterministic per day-seed.
- F121 Succession — when an Archivist or Custodian despawns permanently, a
  successor arrives with different fidgets, routes, and handwriting. AC: successor trait draw seeded per (landmark, generation); old traits retired.
- F122 Refugee columns — erosion events displace entity groups that then
  migrate through player districts over multiple sessions. AC: migration path avoids occupied territory; arrival registers in gossip (F29).

### CATEGORY K — player legacy systems

- F123 Scar inheritance — injuries untreated at run end carry into New Game+
  as old wounds: a limp in cold zones, an ache before storms. AC: scar table round-trips saves; effect gated to inherited flag.
- F124 Expedition lineage — successive runs are descendants; journals quote
  the ancestor's final entry in the waking cinematic. AC: lineage depth persisted; quotation grounded to actual last entry.
- F125 Annotated maps persist — player-marked map fragments survive into
  later runs as found objects, ink faded, sometimes corrected wrongly. AC: mark fidelity degrades monotonically per generation; corrections drawn from majority-vote pool (F56).
- F126 Lent-back habits — the place returns small movement fluencies early
  in descendant runs, then quietly withdraws them at stage 3. AC: fluency curve peaks mid-run; withdrawal deterministic per stage.
- F127 Inherited dread sites — locations of prior-run traumas register to
  descendants: unease captions, breath catch on approach, no explanation given.
  AC: proximity trigger fires once per visit; intensity scales with trauma severity record.
- F128 The locker that stays — one storage locker persists across all runs of
  a save; contents shift by exactly one item per run, uninvited. AC: cross-run item delta ledger; single-item invariant.
- F129 Authored marks — graffiti the player writes (preset phrases, chosen
  placement) reappear in future runs attributed to 'the previous tenant'.
  AC: provenance metadata survives save/export; attribution line renders only in descendant runs.
- F130 Portable hauntings — an exportable save-code lets another browser
  import a ghost of your run: footsteps, memo fragments, no body. AC: code round-trip lossless; ghost plays ≤2 cues per site like F17 echoes.

### CATEGORY L — audio frontier

- F131 Binaural weather — weather fronts arrive as a wall of sound with true
  inter-aural delay: rain sweeps past the head ear-by-ear. AC: L/R onset delay matches swept-source model within 1 ms; front direction audible in graph taps.
- F132 Choir of prior echoes — opt-in aggregation of anonymous local play
  traces rendered as a distant choir humming motifs from other seeds' runs.
  AC: motif set provably disjoint from current-session hum (F36) unless merged by design; opt-out zeroes every node.
- F133 Measured impulse responses — per-room-geometry IR estimation upgrades
  F88 occlusion reverb from heuristic volumes to derived ones. AC: IR tail length correlates with measured room volume; transition test at doorways.
- F134 Infrasound narrative band — story beats carried exclusively by
  sub-harmonic motifs the player feels rather than hears. AC: proxy-band energy rises only on beat events; harmonic proxies stay under masking threshold.
- F135 Acoustic shadowing — walls cast sound shadows with diffracted edges,
  so a voice around a corner arrives bent, not blocked. AC: shadow-depth map test; bent-path arrival within tolerance of wedge diffraction model.
- F136 Recording age — voice memos audibly age in storage: tape hiss grows,
  words soften, per year of save time. AC: degradation curve monotone with saved elapsed days; original recoverable in photo catalog tier.
- F137 Silence taxonomy — the director classifies silences (held breath,
  vacated room, pre-anomaly) and scores them differently. AC: classifier labels match ground truth on synthetic beds; F37 correlation preserved per class.

### CATEGORY M — visual frontier

- F138 Seasonal lighting evolution — a save's light temperature drifts across
  real weeks: colder keys, lower sun implication, longer shadows in winter phases.
  AC: lighting phase derives from save calendar; palette continuity test across phase borders.
- F139 Volumetric fog volumes — fog exists as bounded bodies with density
  fields: a bank of it standing in a stairwell, thinning where you walk through.
  AC: density sampling matches render; player displacement carves visible wakes.
- F140 Wallpaper eras — pattern generations date construction layers; seams
  between eras expose the building was built in the wrong order. AC: era assignment per cell region; seam rendering only at mismatch edges.
- F141 Wet optics — entering moisture zones lays a water film on the lens
  that dries with streaks. AC: film opacity tracks zone entry/exit; streak pattern deterministic per visit id.
- F142 Implied sun — a fake exterior sun position reconstructed purely from
  interior shadow directions, and it moves wrong (retrograde once per session).
  AC: shadow vectors consistent per frame; retrograde interval deterministic per seed.
- F143 Depth-stratified grain — film grain resolves differently near vs far,
  giving flat corridors a false parallax of texture. AC: grain layer split at depth threshold; near-plane grain stable during motion.
- F144 Mirror-grade rooms — a handful of rooms hold true planar mirrors that
  reflect entities correctly even when they lag reality elsewhere. AC: reflection parity with entity pose; rare-room gate ~1-in-60 chunks.

### CATEGORY N — platform & performance

- F145 WebGPU compute particles — dust, spores, and weather move to compute
  shaders with millions-particle budgets on WebGPU, WebGL2 fallback intact.
  AC: visual parity on fallback; frame cost ≤2 ms at target counts on HWGL rig.
- F146 Worker-threaded world gen v2 — full chunk pipeline (layout, mesher
  prep, dressing) off-thread under a deadline scheduler that never starves the
  frame. AC: main-thread gen calls drop to zero in steady state; perf-regression suite green with plateaus.
- F147 Save cloud schema — versioned, merge-capable save schema prepared for
  future sync: CRDT-friendly ledgers, explicit conflict rows. AC: schema version bump test; adversarial merge fixtures converge or fail loud, never silently fork.
- F148 Virtualized texture atlas — procedural atlas pages stream in/out by
  visibility with page-fault-free sampling. AC: no visible pop on page swap; VRAM ceiling respected under stress flythrough.
- F149 Frame telemetry recorder — in-game trace of frame times, draw calls,
  GC pauses exportable as JSON for regression triage. AC: exported trace parses; totals reconcile with perfmarks counters.
- F150 Crowd-scale instancing — entity LOD batching supports 40+ simultaneous
  figures (refugee columns, services) inside the draw-call budget. AC: draw calls flat vs count; footstep DNA (F7) accuracy unaffected at range.

### CATEGORY O — accessibility wave 2

- F151 Cognitive safety mode — a paced profile that caps concurrent anomaly
  pressure and lengthens dread silence recovery while keeping determinism law
  and all content present. AC: mode equivalence test — same seed, same events, widened spacing; toggle zeroes only pacing multipliers.
- F152 Full controller remap — every input rebindable with chord support and
  conflict reporting, persisted per profile. AC: remap round-trip; conflicting binds rejected loud.
- F153 Entomology filter — replaces roach swarms with stationary shadow
  colonies; ecosystem logic untouched beneath. AC: filter swaps render/voice layer only; simulation hashes identical on/off.
- F154 Hearing-aid mix presets — frequency-shaped master chains and dynamic
  range options for cochlear compression profiles. AC: preset EQ curves measurable on master tap; speech-band intelligibility band protected.
- F155 Photosensitivity guard — hard limiter enforcing a flash-rate ceiling
  across every postfx, lightning, and UI strobe source. AC: limiter clamps worst-case composed output under WCAG flash thresholds; per-source audit test.
- F156 Described ambience — optional directional captions naming soundscape
  sources and bearings ('hum, ahead-left'), driven by the live mixer graph.
  AC: captions match active layer + pan state; throttle respects subtitle stacking rules.

### CATEGORY P — community hooks

- F157 Seed sharing codes — compact, checksummed seed+constraint codes
  pasteable at title; decoding never touches Math.random. AC: code round-trip exact; bad checksum rejected loud.
- F158 Ghost leaderboards — opt-in per-daily-seed ghost replays ranked
  locally against imported ghost files (F98 stores made portable). AC: leaderboard ordering deterministic; ghost replay byte-identical per code.
- F159 Discovery bounties — weekly seeded rites ('find the room where the
  clocks disagree') verified entirely offline against the world model. AC: verification uses only local sim state; bounty target existence proven per seed.
- F160 Postcard frames — procedurally composed share screenshots stamped
  with seed and session day, no external asset files. AC: frame compositing deterministic per (shot, seed); EXIF-free PNG output.

### CATEGORY Q — narrative arcs

- F161 The Archivist's catalogue complete — filling the final gallery tier
  (F85) triggers the Archivist's last entry: a photograph of the player, taken
  from behind. AC: trigger keyed to tier archive; entry text grounded to catalog contents; fires once per save.
- F162 The Custodian's union charter — found documents assemble the union's
  demands, and meeting/removing their conditions changes strike behavior (F114).
  AC: document set completeness test; condition-toggle flips strike state deterministically.
- F163 The survivor — forensic verdicts (F79) can resolve 'alive', opening a
  slow arc of supply caches and notes dated after the expedition ended.
  AC: cache dates strictly post-expedition; discovery chain completeness test.
- F164 The name spoken — after F84's signage change, entities begin using the
  facility's true name in vocals, and the hum develops a syllabic edge.
  AC: vocal corpus swap propagation test; hum spectral signature shift measurable.
- F165 Void correspondence — after the fire-exit epilogue (F50), subsequent
  runs find letters describing the white room from inside it. AC: letters gated on epilogue flag; text pool deterministic per save.
- F166 The Double's confession — confronting your Double (F30) on your own
  most-walked route forces a dialogue built entirely from your journal edits.
  AC: dialogue lines cite real edit diffs; confrontation fires once per lineage generation.

## V1.1 INTEGRATION DEBT

Known v1 seams and gaps, each owed to the module that awaits it. These are
first-class v1.1 work: a deepening release lands on a complete foundation.

- F95 hardcore flicker battery has no settings/a11y schema toggle, so
  `setHardcore(false)` ships default with its frames unused — awaits a
  settingspanel entry wired to FlickerBattery (src/ui/settingspanel.ts ← src/player/flickerbattery.ts).
- Stomach audio stand-in: hunger pangs surface as throttled HUNGER captions
  because the growl synth never landed — awaits a stomach audio layer
  consuming `drainEvents()` (src/audio/hungerpangs-consumer ← src/core/game.ts caption path, src/player/hungerpangs.ts).
- Season-bleed particle descriptor rides layouts with no consumer:
  `layout.seasonBleed.particle` is unread — awaits the game-side ambient
  particle pass that mounts it (src/core/game.ts particle passes ← src/world/chunkManager.ts, src/world/architect.ts).
- Crack-density decal seam: aging's `crackDensityMul` has no build-path count
  site; wall cracks remain runtime decals driven by game.ts while the
  FloorCracks pass is unwired into chunk builds — awaits mesher integration
  (src/world/mesher.ts buildChunkGeometry ← src/world/aging.ts).
- Whisper/spatial authority split: WhisperField carries its own PannerNode +
  merger chain beside the positional voice scaler — awaits one spatial
  authority owning listener-relative gain and panning
  (src/audio/positional.ts ← src/audio/whisperfield.ts).
- Roach grid adaptation: taming lead-paths assume open floor grids while
  colony migration needs nav-aware routing — awaits navigation-grid
  adaptation of roach locomotion (src/entities/roachtame.ts, src/entities/faunawiring.ts ← colony migration model).
- Credits scene wiring: the credits-walk corridor renderer has never been
  mounted into the ending flow — awaits the ending overlay hand-off that
  launches the walk with captured screenshots (src/story/creditswalk.ts ← src/core/game.ts ending path).
- Photoreveal capture site: silhouette reveals exist but nothing feeds them —
  awaits the camcorder capture event routing photos into the reveal pipeline
  (src/gfx/photoreveal.ts ← camcorder/photo capture path, src/ui/photocatalog.ts).
- Ceiling-ecosystem skitter audio: nesting cues render visually with no route
  into the ambience mixer — awaits an audio bridge registering colony activity
  as layered skitter voices (src/audio surfaces/mixer ← src/gfx/ceilingeco.ts).
- Hunger schedule is not serialized, so continued expeditions restart the
  grace period — awaits a save slot for the pang clock (src/save ← src/core/game.ts hunger field).
- SpeedrunGhostStore is in-memory only — awaits localStorage/persistence
  wiring behind the store interface (src/save/speedrunghost.ts).
- Mezzanine interiors are pure model: no chunkManager/mesher/game mount builds
  staircase collision or the detached upper floor — awaits the world-mount
  described in its agent report (src/world/chunkManager.ts, src/world/mesher.ts ← src/world/mezzanine.ts).
- DirectorLearning is unfed: no scare-response events reach it and no phase
  consumes suggestPhaseBias() — awaits the director feed/consume wiring
  (src/director/director.ts ← src/director/learning.ts).
- Wake-cinematic shot lists are staged but unplayed — RESOLVED ✅
  (2026-08-24): mounted via `src/story/wakemount.ts` (`WakeMount` headless
  driver) + `game.ts` `beginWakeSequence()`/`dismissWakeCinematic()`; the
  seeded shots now play at every fresh-run start before control hands off,
  any key/click dismisses instantly into the existing rise, motion-safety
  bypasses to the plain rise, and `__BMB__.dismissWakeCinematic` serves as
  the harness hook. Evidence: test/wakemount-test.mjs 34/0 ALL PASS,
  PLAYTHROUGH_PASS with PAGE_ERRORS=0, pnpm build green.
- Adrenaline hearing gain is stored but unconsumed: `adrenalineHearingGainMul`
  waits for an audio-layer multiplier (src/audio master chain ← src/core/game.ts field).
- Sanity remains proxied by zone saturation for journal-font degradation —
  awaits either a dedicated sanity stat or a documented permanent adoption of
  the proxy (src/ui/journalfont.ts consumers ← decision owner).

## WORKING RHYTHM FOR AGENT SESSIONS

- Fleet of ≥5 parallel subagents on disjoint file sets; instant retry/resume on
  any transient failure; never idle, never sequential when parallel is possible.
- One feature (or coherent sub-feature) per agent per wave; implement to its
  AC; add the proving test; run the full gate trio (scoped tsc, touched tests,
  playthrough); commit per file; push origin main and github main.
- Integration-debt items are claimable like any feature; the claiming agent
  owns both sides of the seam (consumer and awaited module) for the commit.
- When a feature is signed PERFECT, mark its line 'SHIPPED ✅' in this file
  with evidence tails, matching GAME-PLAN.md's convention.
- Shared-trunk files (src/core/game.ts above all) integrate one batch at a
  time under a single owner; parallel agents never edit them concurrently.

## GATES BEFORE ANY COMMIT

- Scoped `npx tsc --noEmit` exits 0 on the touched tree.
- Touched suites exit 0; any SKIP must name a tracked defect or debt line.
- `node test/playthrough.mjs` prints PLAYTHROUGH_PASS with PAGE_ERRORS=0
  (known harness races retry per protocol).
- Perf-touching features additionally pass test/perf-regression.mjs.
- Determinism law holds: no new Math.random outside the audio DSP carve-out;
  test/determinism-audit.mjs residue ledger shrinks or stays flat, never grows.
- One commit per file; never durable writes outside the repo; docs updated in
  the same PR they describe.
