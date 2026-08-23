# BACKROOMS: MEMORY BLEED

A browser-native, PC-quality first-person horror game built with TypeScript,
Vite and Babylon.js (WebGPU-first, WebGL fallback). The Backrooms does not
store human memories — it replays them with errors. The errors are
load-bearing now.

## Run

```bash
pnpm install
pnpm run dev        # http://127.0.0.1:5178
pnpm run build      # production bundle -> dist/
pnpm run preview    # serve dist/ at http://127.0.0.1:4178
pnpm run typecheck  # strict TS check
```

Requires a browser with WebGL2 (or WebGPU). All assets — textures, sounds,
signage text — are generated procedurally at boot; there are no downloads.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Look (pointer lock) |
| WASD / Arrow keys | Move |
| Shift (hold) | Sprint (stamina) |
| C or Ctrl (hold) | Crouch |
| E | Interact with research beacons / pick up battery cells |
| F | Toggle flashlight |
| Tab | Toggle expedition log; hold to view the discovery/achievement tracker |
| J | Open/close the lore journal |
| M | Toggle the minimap |
| T | Toggle the speedrun timer overlay |
| G | Open/close the photo gallery |
| F5 | Quick-save checkpoint (cycles quick slots 1-3) |
| F9 | Quick-load most recent checkpoint |
| F3 | Toggle debug overlay |
| Esc | Release pointer lock and pause (autosaves) |

While an overlay is open it takes over the keyboard:

| Overlay | Keys |
| --- | --- |
| Lore journal | J or Esc closes |
| Photo gallery | D deletes selected photo, E exports it as PNG, Esc closes viewer/gallery |
| Save-slot browser | Up/Down select slot, Enter loads, D or Delete deletes, E exports JSON, Esc closes |
| Radio tuner | Left/Right arrows tune the frequency |
| Settings panel | Up/Down adjust the highlighted setting |
| Debrief screen | Esc dismisses |

## Systems

- **Infinite procedural architecture** — deterministic hash-seeded chunk
  streaming in four district grammars (maze, open office, honeycomb,
  corridor grid) with guaranteed corridor lattice, doorways, pillars,
  blackout fields and fluorescent light simulation.
- **Memory Contamination Engine** — seven kinds of wrongly-reconstructed
  human memory pool in regions, blend, decay, spread and reconsolidate.
  They dress the world with wrong furniture, wrong signage, dying lights —
  and, through Memory Weather fronts, whole regions rewrite themselves
  behind your back while their eternal structure stays consistent.
- **Horror Director** — a calm/build/peak/release pacing engine that kills
  lights near you, pulses blackouts, whispers, authorizes reconstructed
  humans and occasionally bends space (non-Euclidean displacement).
- **Reconstructed humans** — faceless figures with persistent behaviours:
  watchers that vanish when approached, wanderers, helpers that point you
  toward beacons and speak once, incompletes that stand in dead-light zones.
- **Reality Erosion** — peaks, blackouts and close watchers erode stability;
  at zero during a peak the space relocates you elsewhere entirely. Death is
  not an end here; it is an edit.
- **Landmark rooms** — every ~60th chunk becomes a sealed named set-piece
  (Executive Office, Laundry, Chapel, Playroom, Canteen, Archive) with full
  lighting override, type-specific furniture, signage, a stationed watcher
  attendant, one-time discovery subtitles, and its own ambient audio layer.
  Each room crossfades the reverb bus to its own space size.
- **Flashlight** — recovered at the first camp. F toggles a focused beam;
  ~85 s of charge drains in use and trickle-recharges under working
  fluorescents; dying batteries dim and flicker. Battery cells found in the
  world restore +35% and stay consumed across saves.
- **Torch tactical layer** — watchers caught in the beam freeze then turn
  away; doubles halt mid-stride under it; incompletes slowly rotate toward
  it; believers ask you to put it away.
- **Path echo** — your movement trail persists in save slots; revisiting
  footprints from a previous session whispers "...your footsteps from before
  are still here...".
- **Sector names** — stable per-seed sector identifiers (e.g. "SECTOR K-7")
  shown in the expedition log and pause summary.
- **Landmark rooms** — every ~40th chunk becomes a sealed named set-piece
  (Executive Office, Laundry, Chapel, Playroom, Canteen, Archive, Security
  Station, Medical Bay) with full lighting override, type-specific furniture,
  signage, a stationed watcher attendant (chapel gets a believer), one-time
  discovery subtitles + A-minor chord, and its own ambient audio layer.
  Revisited rooms have subtly rearranged furniture; discovered signs gain a
  cyan tick stripe persisted across saves. Each room crossfades the reverb
  bus to its own space size.
- **Flashlight** — recovered at the first camp. F toggles a focused beam;
  ~85 s of charge drains in use and trickle-recharges under working
  fluorescents; dying batteries dim and flicker. Battery cells found in the
  world restore +35% and stay consumed across saves.
- **Torch tactical layer** — watchers caught in the beam freeze then turn
  away; doubles halt mid-stride under it; incompletes slowly rotate toward
  it; believers ask you to put it away. The beam attracts watchers during
  peaks.
- **Path echo** — your movement trail persists in save slots; revisiting
  footprints from a previous session whispers "...your footsteps from before
  are still here..." with visible scuff marks on the carpet.
- **Sector names** — stable per-seed sector identifiers (e.g. "SECTOR K-7")
  shown in the expedition log and pause summary.
- **Story & ending** — deterministic research-beacon chain with lore logs,
  clustered micro-stories, a Threshold ending sequence with discovery-count
  flavors, objective HUD, IndexedDB autosave/continue.
- **Audio depth** — a fully procedural sound bed beyond the fluorescent hum:
  a heartbeat that rises as watchers close in or reality thins,
  zone-transition stingers, per-district hum character (pristine office
  wing vs. dying deep Backrooms wiring), distant crowd murmur built from
  stacked formant voices, radio static near Archive rooms plus beacon
  chatter babble within 30 m, surface-aware footsteps, a three-layer
  ambient score whose drone follows each memory zone's pentatonic root,
  lore-discovery stings, structural groans, door creaks, exterior sound
  bleed (birdsong and traffic bleeding through walls), ceiling-fan audio,
  and fixture-buzz harmonics that warble harder the older the district.
- **Entity depth** — peripheral gaze tracking (heads orient before they
  see you), patrol routines on hash-fixed loops with shift work, idle
  fidgets, sitting behaviour, prop-avoidance steering, graceful
  look-aware despawns that fade instead of glitching out while you
  stare, supernatural spawn transitions (figures condense out of
  nothing and dissolve back into it), and adaptive-difficulty spawn bias.
- **World decay & dressing** — evolving wall cracks, growing water
  stains, escalating graffiti that rewrites itself across visits,
  spreading moisture sheen, displaced ceiling tiles, corner ambient
  occlusion, varied light pools, per-chunk fog density, EM interference
  zones that detune nearby buzz harmonics, ten one-off environmental
  vignette scenes implying human micro-stories, neon signs, per-district
  door frame styles, and hidden ceiling writing you only find looking up.
- **Player feel** — sprint-crouch slides, head bob, hard-landing camera
  impacts, strafe lean, surface-aware footstep sounds.
- **Meta layer** — commemorative Threshold photo capture persisted into
  an in-game screenshot gallery (IndexedDB, oldest-evicted past 24), a
  discovery/achievement tracker with toast unlocks, a lore journal, a
  minimap, a save-slot browser with load/delete/JSON import-export, an
  end-game stats screen, and weather-front warning banners ("THE AIR
  SHIFTS", pulsing violet storm alerts).

## Testing

Headless QA harness (Playwright + Chromium, SwiftShader):

```bash
node test/playthrough.mjs   # full critical path: launch->beacons->ending->continue
node test/travel.mjs        # multi-km streaming stress: bounded chunks, determinism
node test/seeds.mjs         # 12-seed generation variety audit
node test/pause-test.mjs    # pause/resume, erosion relocation, settings
node test/db-size.mjs       # autosave size stays bounded
node test/log-test.mjs      # expedition log overlay + personal-memory cues
node test/settings-test.mjs # FOV + subtitles settings apply and persist
node test/webgpu-game.mjs   # boots and plays on the WebGPU engine path
node test/prod-boot.mjs     # boots the production bundle
node test/gallery.mjs       # captures the multi-region release gallery
node test/shot.mjs [menu|play|walk]   # screenshot capture
node test/analyze.mjs shots/x.png     # ASCII-luminance + region color stats
```
## Verified performance envelope

Headless SwiftShader (software GL) sustains full simulation at 2-3 FPS with a bounded working set (<=33 chunks resident, <=90MB heap over multi-km traversals). Real-GPU browsers render the same scene far faster. WebGPU is preferred when available; WebGL2 is the fallback.

Known environment limits: visual output of the WebGPU path cannot be captured headless (logic verified error-free); soaks beyond ~3km crash software-rendered Chromium and need accelerated hardware.


