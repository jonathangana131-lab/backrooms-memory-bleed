# DESIGN - Backrooms: Memory Bleed

Systems design document generated from source inspection (`src/`). All values cited verbatim from code.

## 0. Foundations

### 0.1 Deterministic RNG core (`core/rng.ts`)

All world generation is a pure function of integer hashes of `(seed, coords[, salt])`:

- `hash32(x)` - murmur-style finalizer (`0x85ebca6b`, `0xc2b2ae35`).
- `hash2i(x, y, salt)` / `hash3i` / `hash4i` - integer coordinate hashes; `rand2(x,y,salt) = hash2i(...)/4294967296` yields [0,1).
- `valueNoise2`, `fbm2(x, y, octaves, lacunarity, gain, salt)` - smooth noise built on `rand2` with per-octave salt offsets of `+ i * 1013`.
- `RNG` - stateful splitmix-style stream (`s += 0x6d2b79f5`) used for *sequential* draws within one generation pass; seeded from `hash2i` so it is reproducible per chunk/entity.
- `seedFromString(s)` - FNV-1a (`2166136261`, `16777619`) for user-typed seeds.

**Determinism contract:** any feature addressed by world coordinates uses `rand2/fbm2/hash2i`; only features owned by a single generation pass (props inside one chunk, one entity's gait) use an `RNG` stream. Anything using bare `Math.random()` is intentionally non-reproducible (director timing, audio, some texture strokes, relocation vectors).

### 0.2 World scale (`world/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `CELL` | 2.5 m | grid cell size |
| `CHUNK_CELLS` | 12 | cells per chunk side |
| `CHUNK_SIZE` | `CELL * CHUNK_CELLS` = 30 m | chunk side |
| `WALL_H` | 3.05 m | floor(0) to ceiling |
| `WALL_T` | 0.16 m | wall thickness (half = 0.08) |

`EdgeCode`: `OPEN=0`, `SOLID=1`, `DOORWAY=2`. `District`: `MAZE=0`, `OPEN_OFFICE=1`, `HONEYCOMB=2`, `CORRIDOR_GRID=3`.

`SALTS` decouple independent hash domains: `district 0x11`, `density 0x22`, `edgeH 0x33`, `edgeV 0x44`, `door 0x55`, `pillar 0x66`, `light 0x77`, `blackout 0x88`, `prop 0x99`, `flicker 0xaa`, `room 0xbb`. Ad-hoc salts elsewhere: light dead-draw `^ 0xd34d`, flicker draw `^ 0xf11`, notes `^ 0x0e7e` / `^ 0x4e07`, puddles `^ 0x9d61`, wires `^ 0x817e3`, graffiti `^ 0x6c61`, signs `^ 0x51a1`.

Helpers: `worldToCell(w) = floor(w / CELL)`, `cellToWorld(c) = (c + 0.5) * CELL`, `worldToChunk(w) = floor(w / CHUNK_SIZE)`.

## 1. Memory Contamination Field (`memory/field.ts`)

**Purpose:** tracks where human memories have "bled" into the space: what kind, how strong, how they evolve (blend, decay, spread).

**Data:** `MemoryKind` enum `NONE=0 ... TRANSIT=6, PERSONAL=7`; `MemoryNode {region, kind, intensity, bornAt, lastSeenAt}`; world divided into regions of `REGION_SIZE = 24` m keyed `"rx,rz"`. Mutable state: `nodes: Map<regionKey, Map<nodeId, MemoryNode>>`, `trail: Map<regionKey, seconds>`, `nowSec` clock, optional `weather` hook.

**Determinism split - the central invariant:**

- `sampleBaseAt(x, z)` is **pure**: `baseKindAt` (fbm at freq 0.008 and 0.033, salts `^0x5eed` / `^0xbeef`; index bands n < 0.35 -> kinds 1-3, n < 0.7 -> 3-4, else 5-7) + `baseIntensityAt` (fbm 0.02, salt `^0x1777`, `clamp((n - 0.32) * 2.1)`). Depends only on seed + coords.
- `sampleAt(x, z)` starts from that base layer, then overlays **mutable** state: injected nodes in the 3x3 surrounding region buckets (`w = intensity * max(0, 1 - d*0.8)`, d in region units; node wins if `w > 0.05 && w > bestI * 0.75`), then trail presence (trail > 6 s in region biases PERSONAL, weight capped at 0.65), then weather front mutation via `weather.apply`.

**Why this matters:** `architect.generateLayout` samples the *eternal* layer (`sampleBaseAt`) for structural decisions so two neighboring chunks always agree about their shared border regardless of when each was built or what the player has done since. The volatile `sampleAt` result is stored as `layout.memKind/memIntensity` and drives only **dressing**: prop tables, light death/flicker rates, sign texts, puddles, graffiti. It also keys the audio engine's zone beds (`setZoneAmbient`, see §12).

**Dynamics (`tick(dt)`):** body runs once per accumulated 10 s window (RNG seeded `hash2i(floor(nowSec/10), 77, seed)`): node decay `intensity -= dt * 0.004`, deletion at <= 0.02, 3 % chance to spread into a neighboring region at 0.7x intensity; 15 % chance to spawn a wandering PERSONAL node near a trailed region. `recordPresence` accumulates dt into `trail`, pruning oldest entries when size > 1600 (drops 300).

## 2. Memory Weather (`memory/weather.ts`)

**Purpose:** a moving contamination front that strengthens/masks memory samples - places change behind your back. Chunks regenerate under the new weather when out of view.

**Data:** `WeatherFront {kind, strength 0..1, cx, cz, vx, vz, radiusM}`. One active front. Kind picked from weights RESIDENCE/OFFICE 3, HOSPITAL/SCHOOL/MALL/TRANSIT 2, PERSONAL 1; speed `0.25 + rng*0.55` m/s; radius `260 + rng*420` m; duration `120 + rng*150` s. Constructor seeds from `seed ^ 0x3eaF00d`.

**Update (`update(dt, px, pz)`):** integrates drift; soft-leashes the front toward the player (`+= d * 0.02 * dt` when beyond radius); on expiry reseeds from `(seed ^ floor(t*7)) >>> 0` near the player +/-100 m and returns `true` once (game toasts if playtime > 45 s). Not reproducible relative to playthrough - depends on elapsed time and player position.

`apply(sample, x, z)`: inside the front (`w = strength * max(0, 1 - d/radius)` > 0.01): `intensity += w * 0.45` capped at 1; if `w > 0.22` and kind != PERSONAL, kind is rewritten to the front kind. The field invokes this inside `sampleAt` via its `weather` hook, so every consumer of the volatile layer sees the front. `fogTint()` returns per-kind RGB multipliers consumed by the lighting rig (`setWeatherTint`). Serialized whole (front + `t`, `dur`) into the save slot as `slot.weather`; restored under seed `seed ^ 0x5179`.

## 3. The Architect (`world/architect.ts`)

**Purpose:** pure structural generator: `generateLayout(seed, cx, cz, mem?) -> ChunkLayout`. No Babylon dependencies.

**ChunkLayout data:** `hEdges: Uint8Array((N+1)*N)` (walls along X at integer-z boundaries), `vEdges: Uint8Array(N*(N+1))` (walls along Z at integer-x boundaries), `district`, `lights/props/signs/notes/puddles/wires/graffiti` arrays, plus the volatile `memKind` / `memIntensity` sample.

**Structure pipeline (all eternal-layer driven unless noted):**

1. `memStruct = mem.sampleBaseAt(centerX, centerZ)` - **only** the pure layer touches structure. The volatile `sampleAt` is computed but explicitly unused for edges (`void memSample`); it fills `memKind/memIntensity` for dressing.
2. Strong structural memories bend grammar: `memStruct.intensity > 0.45 && (RESIDENCE || HOSPITAL)` forces `District.HONEYCOMB`.
3. District from `districtAt`: storage pockets first (fbm freq 0.027, salt district+41 > 0.74 -> `STORAGE`), then fbm(freq 0.011, salt district) thresholds 0.34 / 0.52 / 0.72.
4. Edge density per district from `edgeDensity` (fbm freq 0.06, salt density): MAZE `0.34+n*0.28`, OPEN_OFFICE `0.04+n*0.07`, HONEYCOMB `0.26+n*0.18`, CORRIDOR_GRID `0.16+n*0.14`, STORAGE `0.42+n*0.2` (dense canyons).
5. `decideEdge`: corridor lattice period 7 (corridor cells gx/gz in {3,4}) multiplies close-probability x0.08 on corridors and x1.25 off-corridor in CORRIDOR_GRID (x0.25 directional bias in other districts); memory boost `pClose *= 1 + memBoost * 0.5` where `memBoost = min(1, sampleBaseAt.intensity)`; run-length reinforcement (previous same-axis edge closed -> x1.6, capped 0.97); doorway roll `doorChance = 0.42` (HONEYCOMB) else `0.24`, `+ memBoost * 0.25`, gated `pClose < 0.85`.
6. Spawn safety: edges within `hypot(wx + 0.5, wz) < 2.2` cells of origin are forced OPEN.

**Border-consistency invariant:** every edge is indexed by *global cell coordinates* and decided by `decideEdge(seed, wx, wz, vertical, ...)` reading only global hashes. A chunk stores boundary rows including its outer edge ((N+1) entries per axis); the identical edge is recomputed identically when the adjacent chunk builds. `edgeCodeBetweenCell` exploits this: it maps an adjacent-cell step to the owning chunk's array (comment: "both neighboring chunks store this border edge identically").

**Dressing (volatile-sample driven):**
- Lights: one candidate per cell, kept under a **district-specific grammar** switch on `layout.district`: OPEN_OFFICE regular grid (`gx % 2 === 0 && gz % 2 === 0`, or `r < 0.12` gap fill); HONEYCOMB rooms lit from within (corridor cells `r < 0.85`, interior `r < 0.22`); CORRIDOR_GRID rows (`corridor || r < 0.15`); MAZE default sparse (`corridor ? r < 0.9 : r < 0.26`). Candidates beyond 3.5 cells from origin are dropped unless lit; alive unless `inBlackout` (fbm freq 0.021 > 0.76) or killed by `deadBias = memIntensity * 0.35`; flicker value biased by `memIntensity * 0.5`.
- Props: per-chunk `RNG(hash2i(cx, cz, ^SALTS.prop))`, density `0.02 + memIntensity * 0.10` per interior cell, kind table keyed by `memKind` (KIND_PROPS), spawn plaza cleared within 9 m. `PropKind` includes `vending`, `whiteboard`, `cooler`, `couch_l`, `shelf` alongside the original furniture (wired into KIND_PROPS per district: OFFICE gains whiteboard/cooler, SCHOOL/MALL gain vending, HOSPITAL shelf, MALL couch_l). PERSONAL chunks get the reconsolidation signature: 40 % chance to also emit desk + chair pair (variant 2 / rot 2).
- Signs: only when `memIntensity >= 0.18`; text pool selected by `memKind` (SIGN_TEXTS holds 9-10 texts per kind - office suite labels, residence room names, hospital wards, school rooms, mall directories, transit platforms, and PERSONAL second-person taunts like "YOU WERE HERE"); hung only on SOLID edges found in the layout arrays; y in [1.5, 2.2].
- Notes: every ~9 chunks a **clustered micro-story** spawns (3-4 sequential notes within a ~3 m room radius, texts from `CLUSTER_STORIES` - four arcs: the map that ate its cartographers, the counting-the-chairs descent, the fridge that hums names, the orientation packet); otherwise single ambient notes ~1 per 4 chunks drawn from `NOTE_TEXTS` (**40 entries**) by stable hash. Reading any note injects a trace of OFFICE memory into its region.
- Puddles (`generatePuddles`): TRANSIT/HOSPITAL chunks only; `RNG(hash2i(cx,cz,^0x9d61))` places 2-6 patches (r 0.35-1.1 m) anywhere in the chunk.
- Wires (`generateWires`): follow dead lights - for each dead fixture, `rand2(^SALTS.flicker) <= 0.45` spawns a dangling bundle offset +/-0.3 m with length `0.5 + r*1.4`.
- Graffiti (`generateGraffiti`): scrawled wall marks in strongly-PERSONAL chunks (intensity > 0.3) or any chunk with intensity > 0.62; per-kind pools (`KIND_GRAFFITI`: hospital/school/office/mall/transit taunts) falling back to the 9-text existential pool, placed on SOLID edges at y 1.2-1.9 with alpha textures cached per text.
- Ceiling stains (`generateStains`): TRANSIT/HOSPITAL wet zones; 2-6 dark blooms (r 0.5-1.6 m) on the ceiling plane at `WALL_H - 0.004`, specular catch material.
- Batteries (`generateBatteries`): ~40% of chunks place 1-2 torch cells (kind `battery`, no collider); consumption tracked in `Game.consumedBatteries` keyed `"cx:cz:idx"` and filtered at build so pickups stay taken across rebuilds; persisted in slot v2 as `batteriesTaken[]`.
- **Landmark rooms** (`applyLandmark`): every 60th chunk (`hash2i(cx,cz,^0x14bd) % 60 === 7`) becomes a sealed named set-piece — EXECUTIVE OFFICE / LAUNDRY / CHAPEL / PLAYROOM / CANTEEN / ARCHIVE / SECURITY STATION / MEDICAL BAY — with solid perimeter, two doorways, full interior lighting override, type-specific furniture, and an interior name sign. Landmark chunks suppress generic prop generation; discovery triggers a one-time subtitle + A-minor chord, injects a PERSONAL memory at the room (`mem.inject`, 0.3), guarantees a battery cell + field note inside, and records the name in `seenLandmarks` (persisted as `landmarksSeen[]`; discovered signs gain a cyan tick). The expedition log shows a ROOMS count via `ChunkManager.landmarkAtPos`.

## 4. Mesher (`world/mesher.ts`)

**Purpose:** ChunkLayout -> triangle soup in eight material groups: `floor, ceiling, walls, fixtures, fixturesDead, props, debris, puddles`.

**Key mechanics:**
- World-space UVs (`CARPET_SCALE = 1/1.7`, `CEIL_SCALE = 1/0.61`, `WALL_UV_SCALE = 1/2.7`) keep textures seamless across chunk borders - there is no per-chunk UV offset.
- Doorways: opening width `DOOR_W = 1.24`, height `DOOR_H = 2.14`; lintel box above; `doorFrame` adds jambs (`jT = 0.09`, `jOut = 0.05`, `jW = 0.11`) protruding past both wall faces plus head casing, all in the wall material.
- Fixture styles chosen by `l.flicker % 25`: style 7 while dead -> hanging broken panel (drop 0.34); style < 15 -> flat panel (half extents 0.56 x 0.28 at `WALL_H - 0.03`); otherwise twin tubes at `WALL_H - 0.06` with dark housings emitted into `fixturesDead`.
- New prop kinds carry box geometry in `addProp` (vending machine, whiteboard, water cooler, L-shaped couch segments, shelving with three boards).
- Wires emit as two thin twisting conductors (`fixturesDead`) from `WALL_H - 0.02` down to `max(0.4, top - len)`.
- Puddles emit irregular hexagonal low quads at y = -0.002 into their own group, sized by per-vertex jitter around `pd.r`.

**Winding auto-orientation convention (invariant):** `quad()` computes the cross product of corner edges e1 = b - a, e2 = c - a and dots it against the declared normal; if dot >= 0 indices are emitted as (0,2,1)(0,3,2), else (0,1,2)(0,2,3). Callers may list corners in either order; the declared normal wins, so faces are never backface-culled by accident. Source comments note the Babylon LH rasterizer convention was verified empirically against this cross-product sign.

`applyTint(m, r, g, b)` writes per-vertex colors (RGBA, alpha 1), used by ChunkManager for district temperature tints without new materials.

## 5. Collision (`world/collision.ts`, consumer view)

Colliders are axis-aligned `Box2 {minX,minZ,maxX,maxZ}` derived from the same edge codes (`buildColliders(layout)`), so physics geometry and rendered walls share one source of truth. Solid props are boxed too - including the newer `vending`/`whiteboard`/`cooler`/`couch_l`/`shelf` kinds - so mesher geometry and blockers stay in lockstep. Entities move via `moveCircle(body, dx, dz, colliders)` (circle radius 0.3 humans, 0.34 player); `hasLineOfSight` supports watcher placement. Doorway colliders mirror the mesher exactly: two side segments plus a header above `DOOR_H`.

## 6. Chunk streaming (`world/chunkManager.ts`)

**Purpose:** build chunks around the player under a frame budget; dispose distant ones; expose colliders/fixtures/queries.

**Tunables:** `VIEW_RADIUS = 2` (5x5 build set), `DISPOSE_RADIUS = 3` (Chebyshev distance), `BUILD_BUDGET_MS = 6` per frame, `WALL_HALF = 0.08` (sign offset from wall plane), `BEACON_SALT = 316963681` (shared with StorySystem's beacon roll).

**Update:** pending = missing chunks in view, sorted ascending by squared ring offset; builds while budget lasts (`performance.now()` checked between builds); disposes chunks with Chebyshev distance > 3 and invalidates the fixture cache. Every build/dispose/sign/graffiti construction bumps `fixtureVersion`, the invalidation token consumed by the lighting rig's sort gate (§13).

**Build:** `generateLayout(seed, cx, cz, mem)` -> story camp-decor injection if an unfound beacon lives here -> geometry groups -> per-district vertex tint `TINTS[[0.96,0.94,0.88],[1.04,1.02,0.95],[1.00,0.97,0.90],[0.92,0.95,1.00]]` applied to floor/ceiling/walls/debris -> one frozen, unpickable Mesh per non-empty group mapped onto `MaterialSet` keys (carpet/ceiling/wall/fixture/fixtureDead/prop/paper/puddle) -> signs and graffiti as individual DynamicTexture planes (512x128 canvas text; sign background inverted when `kind.valueOf() % 2 === 1`). Sign materials are cached in `signMats: Map<text, StandardMaterial>` (graffiti likewise via `graffitiMats`) so repeated signage across chunks shares one material/draw resource instead of compiling a material per plane -> colliders stored.

**State vs purity:** the `chunks: Map<"cx,cz", Chunk>` map and pending queue are mutable runtime state; everything in `ChunkLayout` is reproducible. Because structure reads only the eternal memory layer, disposing and rebuilding a chunk later yields identical geometry even though the weather front moved.

**Queries:** `collidersAround` (3x3 chunks), `nearestNote` (< 1.7 m), `edgeCodeBetweenCell` (cross-chunk-safe border lookup used by the doorway-loop trick), `allFixtures` (cached array, invalidated on build/dispose), `nearestFixture(x,z,yaw)` returning distance plus stereo pan computed along camera-right vector `(cos yaw, -sin yaw)`, `nearestFixtureDist` (dead-light-zone checks for incomplete spawns), `chunkSalt` (hash with `BEACON_SALT`), `cellKey`, `districtAtPos`.

## 7. Horror Director (`director/director.ts`)

**Purpose:** pacing FSM over four phases: `calm -> build -> (peak | release) -> release -> calm`. Communicates only through the `DirectorHost` interface (lightingStress, killNearbyLight, blackoutPulse, whisperSurge, distantThreat, nonEuclideanNudge, armDoorwayLoop, requestEntitySpawn, playerPosition, elapsed).

**State machine:** initial `calm` for `70 + Math.random()*60` s; build `35 + Math.random()*55` s; peak entered with 55 % chance out of build (RNG seeded `(seed ^ elapsedMs) >>> 0`), duration `12 + rng*14`; release `40-90` / `50-120` s; calm again `60-140` s. `tension` rises linearly to 0.75 in build, oscillates `0.85 + sin(t*3)*0.1` in peak, drains at `dt*0.05` in calm. Each discovery adds +0.15 tension (cap 1). `peaksUsed` counts peaks.

**Host actions fired:** build - random light kills (`p = dt*0.06`) and distant threats (`dt*0.04`); peak entry - `blackoutPulse(3+rnd*5)`, `requestEntitySpawn('watcher')`, 35 % `nonEuclideanNudge`, 40 % `armDoorwayLoop(75)`; during peak whispers at `dt*0.2`. Every tick calls `host.lightingStress(tension)` (x0.3 in calm). Most rolls use bare `Math.random()` - director timing is deliberately not reproducible across sessions.

## 8. Reality Erosion (`director/erosion.ts`)

**Purpose:** the recovery/death loop. `stability` in [0,1]. Drain rates: peak +0.02/s, blackout +0.012/s, watcher within 8 m +0.05/s. Recovery +0.018/s (+0.03 sprinting) when nothing drains. Game-side, touching a research beacon restores `stability = min(1, stability + 0.25)` - contact with something honest steadies you.

At stability <= 0 **during a peak**: reset to 1, `relocations++`, return `{relocate: true}` - the game teleports the player 220-420 m at a random angle, synchronously runs 4 chunk-update passes so we never wake up in void, plays a whisper, and shows "...the carpet here is warmer...". Death is an edit, not an end; all progress (story, memory field) persists.

`overlay(now)`: screen effect strength = low-stability component (`stability < 0.45`) plus a 1200 ms relocation flash, clamped to 1.

## 9. Reconstructed humans (`entities/humans.ts`, `entities/manager.ts`)

**Figure data:** `CircleBody & {y}` (radius 0.3), box-and-sphere body (height 1.72; `incomplete` 1.1), per-figure `RNG(seed)`, `life`, `vanishAt`, dialogue flags (`said`, `lastSpokeAt`). Shared cached materials `humanMat` (diffuse 0.62,0.58,0.52) / `believerMat` (warmer 0.72,0.66,0.48 - believers kept their work clothes); 40 % of `incomplete` figures omit the head entirely (via `RNG(seed ^ 0xdead)`).

**Archetypes and behaviors:**

| Type | Behavior | Despawn conditions |
|---|---|---|
| `watcher` | Body turns slowly toward player (`rate min(1, dt*1.4)`), head snaps faster (`dt*6`) - "the head is already looking at you". Never moves. | Close-vanish at d < 4.6 after life > 1.2 s (crack SFX, +0.5 stress, `vanishEvents++`); d > 62 |
| `wanderer` | Walks forward at 0.85 m/s; occasionally pauses 4-12 s; turns 90-270 deg when blocked | d > 62 or `vanishAt` |
| `helper` | Faces the player exactly; one arm raised pointing toward beacons; static | d > 62 or `vanishAt` (scheduler sets life+90) |
| `believer` | Still doing their rounds at 0.6 m/s; stops to face you like a colleague, occasional pause (2-6 s) with head fidget; speaks lines every >= 12 s | d > 62 or `vanishAt` (life+100) |
| `incomplete` | Perfectly still - no movement code at all | d > 62 or `vanishAt` |
| `double` | Turns toward you (rate `dt*2`), walks your old pathHistory back at 0.9 m/s; head tracks first, lagging at `dt*3` | Close-vanish at d < 5 after life > 3 s; d > 62; `vanishAt` (life+55) |

**Manager:** live figures capped at 4 (enforced game-side); `nearestOf(px,pz,types)` only returns figures within 7 m; central update handles all vanish/despawn logic and fires `onWatcherVanish`.

**Torch interactions:** the manager receives `beam = {on}` and computes per-figure `litByBeam` (torch on, d < 14 m, alignment > 0.86 with the view vector). Watchers caught in the beam freeze for 2.2 s (`beamFreezeUntil = life + 2.2`), then turn away for 8 s (`beamAvoidUntil`) — fires the once-per-figure `onBeamFrozen` chain (game plays a whisper). Doubles halt mid-stride under the beam; incompletes rotate slowly toward it.

## 10. Story system (`story/story.ts`)

**Purpose:** expedition objectives, research beacon discoveries, threshold ending.

**Beacon placement (deterministic per seed):** a chunk hosts a beacon iff `hash2i(cx, cz, seed ^ 316963681) % 23 === 5` (~1 in 23 chunks); position jittered +/-2 cells around chunk center via `RNG(hash2i(cx, cz, ^0x77aa))`. Two anchors forced at new game via `anchors()`: `first` at distance 105 m and `threshold` at 255 m, both at angle `rng(seed ^ 0xa11ce)` (+1.3 rad offset for threshold). Unfound beacons sprout abandoned camps: 4 crates/cabinets (6 for threshold) at 1.0-2.4 m plus a bench and stacked chairs, all from `RNG(^0xcafe)` - injected into layouts by ChunkManager before meshing.

**Stage flow (beacon/threshold):**

```
stage 0  intro      OBJECTIVE: follow the cyan light (~signal distance shown)
   |     first beacon found (interact < 2.6 m) -> LORE[0]
stage 1/2 more      find more beacons (discoveries n/3); lore delivered in fixed
   |                order indexed by discovery count (LORE, 6 entries)
stage 3  threshold  at 3 discoveries: "The Threshold is open. Reach the white light."
   |                threshold beacon pulses white at 1.4 Hz vs cyan 2.6 Hz
stage 4  ended      touching threshold beacon: "THE THRESHOLD ACCEPTS YOU."
                    ending epilogue branches on discoveries >= 6 vs <= 4
```

Each discovery calls `director.notifyDiscovery()` (+0.15 tension) and injects PERSONAL memory 0.45 at the spot. Beacon visuals: pole h 2.3 (threshold 3.2) + lamp emissive cyan `Color3(0.3,0.8,0.8)`, `disableLighting`; meshes appear within 70 m, disposed beyond 85 m or on found. `ensureBeaconsAround` runs every 8 s over a 9-chunk Chebyshev radius so placement state exists before arrival.

**Persistence:** only `found` flags (as `[cx, cz, threshold]` triples), `stage`, `discoveries` serialize; positions recompute from seed. Note: deserialization of found beacons reconstructs center positions without jitter - harmless since found beacons render no mesh.

## 11. Player controller (`player/controller.ts`)

Constants: `PLAYER_RADIUS = 0.34`, `EYE_STAND = 1.62`, `EYE_CROUCH = 0.98`, mouse `sensitivity = 0.0022` (scaled by settings). Speeds: crouch 1.15, walk 2.35, sprint 4.4 m/s (forward-only sprint, requires stamina > 0.05). Stamina: -0.11/s sprinting, +0.075/s otherwise. Pitch clamped to +/-(PI/2 - 0.02). Gravity 18 m/s^2 placeholder (floor at y 0). Head bob: `bobPhase += dt * speed * 3.4`, amplitude 0.03 (0.014 crouched) scaled by speed/4; footstep event fires on each bob half-cycle change (`floor(bobPhase/PI)`). Idle breathing sway approx 0.0016 rad keeps stillness from looking frozen. Movement basis matches Babylon yaw: forward `(-sin yaw, 0, -cos yaw)`, right `(cos yaw, 0, -sin yaw)`. Look updates apply even when disabled (menu); movement does not. Spawn `(1.25, 1.25)` facing `PI * 0.75`.

## 12. Audio engine (`audio/audio.ts`)

**Flashlight (`player/flashlight.ts`):** add9, staggered entries) partially through the reverb bus.
- Reverb bus: procedural 2.4 s exponentially-decaying stereo impulse in a ConvolverNode; doorway scuffs send 50 % wet, landmark chords 55 %; `setSpaceSize(v)` eases the bus gain toward 0.5 inside landmark rooms vs 0.18 in corridors.
- Landmark ambient layers (`setLandmarkAmbient(name)`): one crossfaded layer per named room — CHAPEL three detuned sines (196/196.7/246.9 Hz, ±detune), LAUNDRY lowpass-140 Hz thump loop with 1.1 Hz square LFO on layer gain, ARCHIVE highpass-4200 Hz shimmer bed, PLAYROOM music-box plinks (1046–2093 Hz sines, 1.6–4.4 s apart). Built lazily once; fades via setTargetAtTime tau 1.1 s.

Non-deterministic by design (all `Math.random()` scheduling).

## 13. Lighting rig (`gfx/lighting.ts`)

Pool of `POOL = 14` PointLights (range 13.5, warm diffuse `Color3(1.0, 0.94, 0.72)`) rebound each frame to the 14 nearest **alive** fixtures sorted by squared distance; unused lights parked at y = -100. Base intensity `1.7 * max(0.3, 1 - d/26)` at fixture height 2.86. **Sort gating:** the filter/sort/slice runs only when `chunkManager.fixtureVersion` changed or the player crossed a 4 m quarter-position boundary (`sortKey = version + ':' + floor(px/4) + ':' + floor(pz/4)`); otherwise the cached `lastSorted` set is rebound with freshly computed distances - the per-frame sort is eliminated. Flicker bands from `flicker % 100`: < 12 irregular buzz (hash-sampled at 24 Hz), 12-17 dying pulse `0.35 + 0.65*abs(sin(1.7 t))`; director stress drops lights to x0.15 with probability scaling `stress * 0.35`. Hemispheric ambient intensity 0.85 (`diffuse 1.0,0.95,0.78`, ground `0.18,0.14,0.07`). Post: GlowLayer 0.75 (512 px, kernel 48); DefaultRenderingPipeline FXAA + bloom (threshold 0.55, weight 0.28, kernel 48), vignette weight 1.55, animated grain 9, exposure 1.32, contrast 1.18. Fog EXP2 base density 0.028 eased per district presets `[MAZE 0.040, OPEN_OFFICE 0.021, HONEYCOMB 0.032, CORRIDOR_GRID 0.026]` (`setDistrictFog`, lerp k = dt*0.4); `setWeatherTint` eases fog color and hemi color toward the weather front's per-kind RGB multipliers (k = dt*0.25).

## 14. Procedural materials (`gfx/materials.ts`)

All textures painted to canvases at boot from fixed-seed `RNG`s (101, 202, 303, ... per paint stage): mustard carpet #7a6a33 with fiber streaks and stains (512^2, bump 256^2), yellow wallpaper with baked skirting band and rising grime, mineral ceiling tiles (grid repeat 0.61 m matching `CEIL_SCALE`), emissive fixture diffuser, grimy props, ruled paper. Eight materials form `MaterialSet`; `fixture` has `disableLighting = true` (self-lit); all others get `maxSimultaneousLights = 16` and are `freeze()`d to avoid shader recompiles. The **puddle** material is an untextured dark specular catcher - diffuse `Color3(0.05, 0.055, 0.045)`, specular `Color3(1.4, 1.35, 1.1)` with power 96 - frozen like the rest, so pooled fluorescents smear bright reflections across damp transit/hospital floors. Caveat: a few texture strokes use bare `Math.random()` (carpet fibers, ceiling speckles, scratches) so boot-time textures vary slightly per session; appearance only, never gameplay.

## 15. Game orchestration & frame order (`core/game.ts`)

Owns engine (WebGPU preferred, WebGL fallback), scene (clearColor `0.02,0.018,0.008`, ambientColor `0.12,0.11,0.08`), camera (fov 1.25, minZ 0.08, maxZ 140), all subsystems, save lifecycle, and the DirectorHost adapter. Autosaves every 30 s of playtime, on pause, on quit, and on `beforeunload`. Entity scheduler ticks every 7 s; beacon ensure every 8 s; objective UI refresh 1 Hz; expedition log 0.5 Hz.

**Attract mode:** in menu state the world keeps rendering behind the translucent title UI. A drifting camera walks `ax = 8 + t*0.55`, `az = 8 + sin(t*0.11)*14` at eye height 1.55 with slow rotational sway; `chunks.update` follows the drift so geometry streams in around it, and lighting/audio focus the attract position instead of the parked player.

**Frame update order** (single `frame()`; dt clamped to 0.1 s):

```
+-- frame()
|  0. if menu: attract camera drift    world streams around it; title stays translucent
|  1. dt computation (clamp 0.1); playtimeSec += dt if playing
|  2. collidersAround(focus)           <- snapshot for this frame
|  3. player.update(dt)                look -> stance -> move+collide
|     |                                gravity -> eye/bob -> camera pose
|  4. if playing:
|  |    mem.recordPresence + mem.tick  trail accumulation + 10 s evolution
|  |    zone ambient                   setZoneAmbient(sample.kind) crossfade
|  |    personal-memory reaction       once per region: cue variant + distant
|  |                                   footsteps + PERSONAL inject 0.3
|  |    weather.update                 front drift / periodic reseed
|  |    lighting.setWeatherTint        mood ease
|  |    lighting.setDistrictFog        depth ease
|  |    director.update                phase FSM -> host actions
|  |    humans.update                  archetype AI, vanish/despawn
|  |    pathHistory sampling           every 0.5 s, 150 s window (the double)
|  |    entityScheduler                7 s spawn rolls per phase
|  |    helperDialogue
|  |    erosion.update                 stability drain/recover; relocate?
|  |      relocate -> teleport 220-420 m + 4x synchronous chunks.update
|  |    ui.setErosion(overlay)
|  |    handleInteraction              notes/beacons ([E] queued by keydown);
|  |                                   notesRead++, beacons restore stability +0.25
|  |    beaconEnsureTimer (8 s)        ensureBeaconsAround r = 9
|  |    doorway-loop check             armed loop -> teleport-back trick
|  5. if not menu: chunks.update       budgeted build + distant dispose
|                 story.update         beacon mesh create/pulse/cull
|  6. blackout ghost-light roll        p = dt*0.12: one alive fixture 22-60 m out
|     |                                forced lit 2-7 s (ghostLit map + lightCrack)
|     fixture merge with ghostLit / forceDeadLights / blackout overrides
|     (allocates copies only when overrides exist; ghostLit cleared on thaw)
|  7. lighting.update                  gated re-sort -> pool binding + flicker sim
|  8. audio.update                     hum proximity/pan; zoneTick; distant events
|     beaconUpdate                     620 Hz pulses when unfound beacon < 40 m
|  9. UI: stamina, subtitles, objective (1 Hz), F3 debug, log (0.5 Hz,
|     NOTES READ counter)
| 10. autosave if playtimeSec - lastAutosave > 30
| 11. scene.render()
```

**Non-obvious behaviors:** `forceDeadLights` (Set of "x,z" keys) implements director light kills without mutating layouts; merged into the fixture list only when non-empty. Blackout marks all fixtures dead and silences hum (fixture distance reported as 99) - except **ghost lights**: during a blackout each frame rolls `p = dt*0.12` to pick a random alive fixture 22-60 m away, force it lit for 2-7 s via the `ghostLit: Map<"x,z", untilSec>` override, and play a lightCrack ("one distant light fights back"); the map clears the moment the blackout ends. `nonEuclideanNudge` teleports 28-46 m behind the player then resolves with `moveCircle(body, 0, 0, colliders)` so we never land inside geometry. The armed doorway loop (`loopArmedUntil`) fires when crossing an `EdgeCode.DOORWAY` cell boundary within the armed window: teleport 26-40 m forward along facing, whisper, inject PERSONAL 0.25, subtitle "You have passed through this door already."; disarms itself on trigger. Watcher spawns score 7 candidate points by sightline visibility (+/-0.9 rad of facing) and line-of-sight, preferring candidates with both (score 5 breaks early), backed by three fading knocks. Ambient spawn rules: wanderers during calm (count < 2, p 0.3), watchers during build (count < 3, p 0.22), mirror steps during build (p 0.18, 10-20 s), believers calm/build (count < 4, p 0.12), doubles peak/build walking the player's own wake (p 0.15, needs pathHistory > 40 and a sample >= ~90 s / 14 m away; preceded by four distant footsteps), incompletes in dead-light zones (> 17 m from any lit fixture, via `nearestFixtureDist`) during peak (count < 4, p 0.35), helpers after stage 1 every 220-380 s pointing at the nearest unfound beacon > 20 m away. Personal-region entry (kind PERSONAL, intensity > 0.35, first visit per region key in `seenPersonal`, cleared after 400 entries) plays one of three cue variants ("...the carpet here remembers your weight...", "...somewhere behind the walls, your name is being pronounced badly... (line truncated to 2000 chars)

## 16. Persistence (`save/db.ts`, `game.captureSlot`)

IndexedDB database `bmb` version 1; object stores `slots` (single key `"auto"`) and `kv` (settings).

**Save-slot schema v2** (`version: 2`):

| Field | Type | Source |
|---|---|---|
| `seed` | uint32 | run seed (hex-rendered in UI) |
| `px`, `pz`, `yaw` | number | player transform (y always 0) |
| `playtimeSec` | number | accumulated active time |
| `savedAt` | number | `Date.now()` epoch ms |
| `version` | number | literal `2` |
| `mem` | `{ nodes: [rk, [id, MemoryNode][]][]; trail: [rk, seconds][]; nowSec }` | MemoryField.serialize() |
| `weather` | `WeatherFront & { t, dur }` | MemoryWeather.serialize() |
| `story` | `{ stage, discoveries, found: [cx, cz, threshold][] }` | StorySystem.serialize(); unfound beacons re-derived from seed |

Settings record: `{ sensitivity, volume, quality, fov? }` under kv key `settings`.

**Load robustness:** `continueGame` wraps each deserialization - `MemoryField.deserialize(slot.mem)`, `MemoryWeather.deserialize(seed ^ 0x5179, slot.weather)`, `StorySystem.deserialize(slot.story)` - in its own try/catch, falling back to a fresh instance of that system, so a corrupt partial slot still boots a playable run.

## 17. Cross-cutting invariants summary

1. **Eternal vs volatile split.** Structure (edges, districts, corridor lattice) consumes `sampleBaseAt` only; dressing (props, light health, signs, puddles, graffiti) may consume the mutable `sampleAt`. This is why regenerated chunks match both their neighbors and their own past selves.
2. **Border edges are computed twice, identically.** Both adjacent chunks generate the shared boundary row from global-coordinate hashes; consumers may read either copy.
3. **Geometry <-> collision parity.** Colliders derive from the same EdgeCode arrays and dimensional constants (`DOOR_W`, `DOOR_H`, `WALL_T`) as the mesher, plus matching prop boxes.
4. **Winding is caller-proof.** `quad()` reorients triangle indices against the declared normal; corner order carries no semantic.
5. **Determinism tiers.** Tier 1 (exact, seed-only): world structure, beacon placement, prop/sign/note selection. Tier 2 (seeded but state-dependent): memory field evolution, entity behavior streams, weather front sequence after load divergence. Tier 3 (`Math.random()`, intentional): director rolls, audio scheduling, relocation vectors, minor texture strokes.
6. **Budgeted mutation of an immutable world.** Weather and memory mutate the *interpretation*, never stored geometry; chunks are pure caches and can be dropped/rebuilt freely (`DISPOSE_RADIUS > VIEW_RADIUS` guarantees a rebuilt chunk regenerates before becoming visible again). Runtime overrides (`forceDeadLights`, `ghostLit`) merge into the fixture view per frame and never touch layouts.

## Appendix: Worker Infrastructure

src/workers/layout.worker.ts + layoutPool.ts provide off-thread chunk layout generation (2 workers, round-robin, cached by chunk key). ChunkManager.useWorker = true activates the async path; the synchronous budgeted path remains the default and fallback. Verified byte-identical determinism vs main-thread generation (~0.73 ms/chunk on worker).

## Appendix: Extended Systems

### Audio Extensions

- `src/audio/fanaudio.ts` — Fully procedural ceiling-fan audio (blade-pass whoosh pulses, motor hum, wobble creaks) following the doors.ts conventions; a setSpeed(revsPerSec) API starts/stops the motor voice and scales whoosh rate.
- `src/audio/humharmonics.ts` — Fluorescent-hum enrichment layering odd mains harmonics (180/300/420 Hz at -12/-18/-24 dB), a detuned twin voice producing slow amplitude beats between fixtures, and age-warble LFO drift scaled by district profile over the existing 120 Hz bed.
- `src/audio/crowd.ts` — Distant crowd ambience stacking nine detuned, stereo-spread formant-babble voices (the radio.ts technique blurred) into an indistinct office murmur behind a ~750 Hz lowpass with a 20–40 s swell LFO; audible only in OPEN_OFFICE during calm/build tension.
- `src/audio/doors.ts` — Distant self-moving door creaks every 45–90 s during calm/build phases: stick-slip sawtooth creaks placed at a random bearing 15–40 m out with inverse-square falloff, never repeating a compass quadrant while the director is tense; shining the torch toward a fresh creak's bearing triggers a softer answering creak.
- `src/audio/groans.ts` — Structure groans: deep 40–80 Hz settlement swells plus metallic pipe knocks that echo down "plumbing" (a fainter, duller follow-up knock), scheduled every 90–180 s of calm and thinning out as director tension rises.
- `src/audio/exterior.ts` — Exterior bleed of impossible outside sounds (muffled birdsong, passing traffic whooshes, rare children's calls, rain patter during wet weather fronts), each routed through per-voice muffle filters and weighted by what the current memory zone "remembers" having windows.
- `src/audio/echoes.ts` — Relocation echoes: sites marked via markSite() play reverse-envelope whisper fragments when revisited within 15 m, escalating across visits from lone bursts to a continuous murmuring bed; getIntensity(x, z) exposes proximity × escalation for matching screen effects, and the class runs logic-only without an AudioContext.
- `src/audio/batterycue.ts` — Torch battery audio cues: a soft double-beep below 15% charge every 30 s, an urgent single beep below 5% every 10 s, an ascending confirmation when a recharge hits 100%, and a three-note pickup arpeggio for collected cells; warnings are suppressed while recharging and critical supersedes low.
- `src/audio/loresting.ts` — Lore-discovery stingers built from oscillators and envelopes: noteRead (two-note A4→C5 motif), clusterComplete (resolved A-minor phrase), radioLock (triangle glissando); a per-sting lowpass closes from 8 kHz to 3 kHz across story stages 0–4 so late-game discoveries sound more muffled.
- `src/audio/boundaries.ts` — Chunk-seam crossing cues: a quiet bandpass noise whoosh swept 300→100 Hz, with metallic-ring accents entering STORAGE and hollow tonal pulses entering HONEYCOMB, rate-limited to one cue per 4 s and muted entirely during the director's peak phase.
- `src/audio/music.ts` — DynamicScore procedural ambient score in three WebAudio layers: a detuned-sawtooth drone keyed to each memory zone's pentatonic root, sparse pentatonic sine plucks whose interval shrinks as tension rises, and a dissonant minor-second cluster following director tension; all transitions crossfade via setTargetAtTime so switches never click.
- `src/audio/positional.ts` — Per-fixture positional hum giving the nearest three ceiling fixtures their own slightly-detuned 120 Hz voices panned by bearing relative to player facing, with inverse-square falloff, a -12 dB combined loudness cap, and smooth setTargetAtTime pan/gain motion while walking.
- `src/audio/approach.ts` — Watcher approach footsteps synced mirror-style half a stride off the player's own cadence, using the surface the watcher stands on (so a metal ring betrays its location), taking exactly two trailing steps after the player stops, swelling with proximity and cutting to silence inside 3 m; runs logic-only without an AudioContext for headless tests.
- `src/audio/surfaces.ts` — District-specific procedural footsteps as filtered white-noise bursts with per-surface envelopes/EQ (carpet thud, tile click, metal ring, puddle splash), ±10% pitch/volume jitter per step, and louder/faster/higher steps while sprinting.
- `src/audio/radio.ts` — Beacon radio chatter: within 30 m a beacon emits looping formant-babble babble (glottal sawtooth through three drifting bandpass vowel filters) over a carrier noise bed, seeded per-beacon by hashed position so every beacon sounds like a different person; clarity degrades with distance from clear under 10 m to silence past 30 m.
- `src/audio/emzones.ts` — EM interference fields: rare (~5% of chunks) deterministic pockets with a gaussian 12 m intensity profile exposed via getInterference(x, z) plus a pollable crackle schedule (sampleCrackle); downstream, radio static intensifies, torches flicker erratically, and the mains hum detunes sharp inside a zone.

### Entity Extensions

- `src/entities/gaze.ts` — GazeController simulation returning a head-yaw offset per tick: figures orient toward the player inside a ±60° peripheral cone with a capped turn rate and neck clamp; watchers hold unbroken eye contact forever while everyone else glances away after 2–4 seconds. Pure logic, no Babylon imports.
- `src/entities/schedules.ts` — Patrol routines deriving waypoint loops deterministically from a hash of where an entity first appeared, with shift-work cycles (3–5 minutes active, then standing very still); watchers pass alwaysOn and never rest.
- `src/entities/fidgets.ts` — Idle micro-motions for standing figures: seeded head tilts, shoulder rolls, hand-to-face gestures, and weight shifts every 8–20 s lasting 1–3 s, returned as pose modifiers; watchers are exempt because "statues do not scratch their noses."
- `src/entities/sitting.ts` — Sitting behavior steering figures onto bench/chair seats (aligned to seat yaw, lowered to seated height for a minute or two), with believers strongly preferring CHAPEL-tagged pews; a module-level claim registry prevents two figures sharing a seat, with claims expiring if abandoned.
- `src/entities/avoidance.ts` — Prop avoidance steering that bends an entity's desired velocity around nearby prop circles (fed via setObstacles) using squared-distance pre-filtering and a 60/40 desired-vs-repulsion blend clamped to stay forward-facing, so entities slide along furniture instead of ghosting through it.
- `src/entities/graceful.ts` — Graceful despawn: if the player is looking (±35° gaze cone), the expiring figure clones its shared material and fades opacity to zero over ~1 s; if unwatched, the despawn is instant — turn back and the corridor is empty.
- `src/entities/spawneffects.ts` — Supernatural transition effects: fadeIn (~0.8 s ease-out alpha ramp), dissolveOut (0.6 s fade with upward drift), and dimFixture (brief emissive sag on nearby lights during manifestation); materials are cloned before alpha changes and restored afterward, and every entry point degrades to a null-safe no-op.
- `src/entities/vocals.ts` — Ambient vocalizations gated by distance ((1 - d/range)^2.5 gain): believers mutter quiet formant-babble every 20–40 s within 10 m, wanderers hum 3–5 note minor-pentatonic phrases every 30–60 s within 12 m, and watchers are deliberately silent.
- `src/entities/gaze-wiring.ts` — Per-figure gaze coordination batching: GazeWiring attaches/detaches one GazeController per figure id and drives them all from a single updateAll(dt, px, pz), caching the latest head yaw offset for on-demand retrieval.

### World Extensions

- `src/world/cracks.ts` — Activity-driven wall cracks: chunks the player haunts accumulate dwell time (one crack per 45 cumulative seconds, cap 8/chunk), and each crack creeps one stage further (longer, darker) on re-entry after 5 min away; placement is a pure function of seed/chunk/activity, persisted in localStorage, with buildCrackGeometry supplying jagged trunk-and-branch polylines.
- `src/world/stains-growth.ts` — Ceiling water-stain growth mirroring graffiti-evolution: stains start as fresh damp patches and bloom one stage (up to stage 3 — bigger, darker, heavy pooling ring) per re-entry after STAIN_AWAY_MS; pure logic + localStorage consumed by the mesher via getStage/getSpec.
- `src/world/graffiti-evolution.ts` — Graffiti evolution: between sessions walls are rewritten — each graffiti advances one stage per re-entry after 5 min away through 2–3 entry escalation chains keyed to its base text ('GET OUT' → 'GET OUT GET OUT' → 'TOO LATE'), with stage 0 always rendering the verbatim original.
- `src/gfx/moisture.ts` — Wall moisture sheen near registered leaks: damp tint quads (alpha 0.06) whose wet radius creeps 0.5 m → 2 m across away-then-return visits using the same escalation loop as cracks; persisted in the 'bmb-moisture' bucket and emitted as CornerAO-style QuadInstance decals.
- `src/gfx/tiledisplace.ts` — Ceiling tile displacement: hash-based dressing giving ~12% of chunks exactly one subtly-wrong tile — either sagged ~1 cm below plane or tilted 2–5° ajar about its in-plane axis; deterministic per (seed, chunk, tile) and kept salted apart from ceiling-details to avoid correlated double-dressing.
- `src/gfx/cornerao.ts` — CornerAO baked fake ambient occlusion: darkening quads on both wall faces at wall-wall junctions (floor corners darkest at carpet, ceiling corners at the tile line), peaking at strength 0.25 and feathering over 0.45 m of wall run; pure data in/out, worker-safe, dropped straight into quad()+tint passes.
- `src/gfx/lightpools.ts` — Procedural light-pool shapes replacing implicit circles: four variants (troffer rectangle, tube streak, mottled diffuser blob, twin-lobe housing) assigned deterministically per fixture position; getTexture returns declarative specs, sampleAlpha evaluates them analytically for tests, and paint rasterizes real bitmaps.
- `src/gfx/fogvariation.ts` — Fog density variation: each chunk rolls a deterministic [0.9, 1.1] density multiplier, puddle chunks get a +15% "low areas" boost, and multiplierAt(px, pz) bilinearly blends the 2×2 chunk neighbourhood so fog thickens and thins smoothly with no chunk-border seams.
- `src/gfx/doorstyles.ts` — District-specific door frame treatments layered over the mesher's generic trim: flat maze boards, commercial casings with kick plates, heavy industrial frames with angle-iron braces, etc., each doorway rolling a salted-hash variant plus ±5% dimensional jitter for reproducible variety.
- `src/world/vignettes.ts` — Environmental storytelling vignettes: ten prop micro-scenes (pure data laid out in a rotated local frame reusing only mesher-supported prop kinds) that imply human stories — desks, benches, bedframes, lockers, TVs arranged into tableaux without any text.
- `src/world/placement-expansion.ts` — Placement tuning for the expanded vignette catalog: raises per-chunk spawn probability to EXPANDED_VIGNETTE_CHANCE = 0.03 (~3% of eligible open-floor chunks) and provides districtEligibility weighting full spawn odds for OPEN_OFFICE/HONEYCOMB/CORRIDOR_GRID and zero elsewhere.
- `src/world/neonsign.ts` — Rare dead-mall neon signs: 1-in-15 CORRIDOR_GRID chunks bolt one sign (MOTEL, VACANCY, DINER…) facing down a corridor band, text/color chosen from the chunk hash; flicker is a pure function of (seed, tMs) so buzz (sampleFlicker/buzzGain/createNeonBuzz) stays identical across clients and reloads.
- `src/world/ceiling-details.ts` — Ceiling inspection details rewarding looking up: missing tiles revealing black recessed voids and rare handwritten scrawl on single tiles ("THEY COUNT", "42"), generated only near chunk centers in fully open cell runs with no fixture blocking the sight line; ~8% of chunks win exactly one detail, writing rarer than holes.
- `src/world/radioprops.ts` — Physical radio props anchoring the tuning minigame: ~8% of OPEN_OFFICE desk chunks grow a bakelite box with whip antenna and warm emissive dial, placed deterministically per chunk and carrying a stable 'radio:<cx>:<cz>' seed string from which RadioTuner derives the hidden station and lore fragment.

(Output capped. Showing lines 1-347. Use offset=348 to continue.)

