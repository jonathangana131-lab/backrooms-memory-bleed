/**
 * Chunk streaming: builds chunks around the player under a frame budget,
 * disposes distant ones, exposes colliders and fixtures.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { CHUNK_CELLS, CELL, WALL_H, WALL_T, worldToChunk } from './constants';
import {
  generateLayout, landmarkFor,
  type Box2, type ChunkLayout, type LightFixture, type SignInstance,
} from './architect';
import { getLayoutPool } from '../workers/layoutPool';
import { buildColliders } from './collision';
import { buildChunkGeometry, applyTint } from './mesher';
import type { GraffitiInstance, PropInstance } from './architect';
import { hash2i, RNG, seedFromString } from '../core/rng';
import { graffitiTilt, signGrimeRects } from './textureDressing';
import { ChunkDeltas, applyDecorDrift } from './chunkDeltas';
import { AgingLedger, decayStage, type AgingStageParams } from './aging';
import { sessionSeasonBleeds } from './seasonrooms';
import { generateMezzanine, mezzanineGate, glimpseFootprint } from './mezzanine';
import type { MezzaninePair } from './mezzanine';
import { echoPositions } from './landmarkecho';
import type { LandmarkDescriptor } from './landmarkecho';
import type { MaterialSet } from '../gfx/materials';
import type { MemoryField } from '../memory/field';

/** Salt so aging decor draws never correlate with any other per-chunk feature. */
const AGING_DECOR_SALT = 0xa9e6;

/** Salt so map-fragment scatter draws never correlate with other features. */
const MAPFRAG_SALT = 0xf8a6;

/** Chance a chunk scatters the cartographer's map fragments at all. */
const MAPFRAG_CHANCE = 0.22;

/** Minimal surface of the story system used during chunk builds. */
export interface StoryLike {
  beaconForChunk(cx: number, cz: number): { cx: number; cz: number; found: boolean } | null;
  campDecor(b: { cx: number; cz: number }): PropInstance[];
}

const VIEW_RADIUS = 2;
const DISPOSE_RADIUS = 3;
const BUILD_BUDGET_MS = 6;
const WALL_HALF = 0.08;
const N_HALF = CHUNK_CELLS / 2;
const BEACON_SALT = 316963681;

interface Chunk {
  layout: ChunkLayout;
  meshes: Mesh[];
  colliders: Box2[];
}

export class ChunkManager {
  private chunks = new Map<string, Chunk>();
  private pending: { cx: number; cz: number; d: number }[] = [];
  private fixtureCache: LightFixture[] | null = null;
  fixtureVersion = 0;
  lastBuildMs = 0;
  totalBuilt = 0;
  mem: MemoryField | null = null;
  /** optional story system notified of chunk builds for beacon placement */
  story: StoryLike | null = null;
  /** keys ("cx:cz:i") of battery pickups already taken; filtered at build */
  consumedBatteries: Set<string> | null = null;
  /** landmark room names the player has entered — their signs gain a cyan tick */
  discoveredLandmarks: Set<string> | null = null;
  /** downsampled movement trail from the previous session; scuffs render in debris */
  pathEchoPoints: Array<{ x: number; z: number }> | null = null;
  /** F32 custodian: graffiti erased by the Custodian, keyed
   * 'cx,cz:x100:z100'; filtered out of every subsequent build so a removal
   * survives chunk rebuilds and session loads. */
  removedGraffiti: Set<string> | null = null;
  /**
   * Reversible per-chunk mutation ledger (see chunkDeltas.ts). When set,
   * drifted chunks fold their drift step into decor generation so anomaly
   * mutations survive rebuilds while revertAll() restores the canonical
   * world. Purely deterministic - never written by generation itself.
   */
  deltas: ChunkDeltas | null = null;

  /**
   * Revisit-decay ledger (see aging.ts, F24). Every chunk build records one
   * visit; the resulting decay stage folds into the decor the build path
   * generates so heavily revisited corridors visibly worsen. Accepting an
   * external ledger lets save systems restore decay history; a fresh
   * ledger keeps the constructor call site unchanged.
   */
  aging: AgingLedger;

  /** Folded aging params for each currently built chunk, keyed "cx,cz". */
  private agingByChunk = new Map<string, AgingStageParams>();

  /** Landmark chunk keys seen this session; the pool that elects the bleed room. */
  private seasonSeen = new Set<string>();

  /** Key of the currently elected seasonal-bleed room, or null before any landmark builds. */
  private seasonWinner: string | null = null;

  /**
   * F51 mezzanine cache keyed "<seed>|<chunkKey>". generateMezzanine is a
   * pure function of (worldSeed, chunkKey), so entries stay valid for the
   * manager's lifetime — including across rebuilds and reset(). Null values
   * mean the rarity gate is closed for that chunk; caching them keeps the
   * gate a one-time draw instead of a per-rebuild recompute.
   */
  private mezzCache = new Map<string, MezzaninePair | null>();

  constructor(private scene: Scene, private mats: MaterialSet, public seed: number, aging?: AgingLedger) {
    this.aging = aging ?? new AgingLedger();
  }

  key(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  /**
   * Serialize the revisit-decay ledger for persistence. Round-trips
   * exactly through restoreLedger.
   */
  ledgerSnapshot(): string {
    return this.aging.toJSON();
  }

  /**
   * Replace the decay ledger with one built from ledgerSnapshot output.
   * Folded params recompute on each chunk's next build, so already-built
   * chunks keep their current look until rebuilt.
   * @throws When the payload is malformed (see AgingLedger.fromJSON).
   */
  restoreLedger(json: string): void {
    this.aging = AgingLedger.fromJSON(json);
  }

  /** Folded aging params for a built chunk, or null when not loaded. */
  agingAt(cx: number, cz: number): AgingStageParams | null {
    return this.agingByChunk.get(this.key(cx, cz)) ?? null;
  }

  reset(): void {
    for (const c of this.chunks.values()) for (const m of c.meshes) m.dispose();
    this.chunks.clear();
    this.building.clear();
    this.pending.length = 0;
    this.fixtureCache = null;
    this.fixtureVersion++;
    this.agingByChunk.clear();
    this.seasonSeen.clear();
    this.seasonWinner = null;
  }

  update(px: number, pz: number): void {
    const pcx = worldToChunk(px);
    const pcz = worldToChunk(pz);

    this.pending.length = 0;
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const k = this.key(cx, cz);
        if (!this.chunks.has(k) && !this.building.has(k)) {
          this.pending.push({ cx, cz, d: dx * dx + dz * dz });
        }
      }
    }
    this.pending.sort((a, b) => a.d - b.d);

    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < BUILD_BUDGET_MS) {
      const j = this.pending.shift()!;
      this.build(j.cx, j.cz);
    }
    this.lastBuildMs = performance.now() - t0;

    for (const [k, c] of this.chunks) {
      const d = Math.max(Math.abs(c.layout.cx - pcx), Math.abs(c.layout.cz - pcz));
      if (d > DISPOSE_RADIUS) {
        for (const m of c.meshes) m.dispose();
        this.chunks.delete(k);
        this.agingByChunk.delete(k);
        this.fixtureCache = null;
        this.fixtureVersion++;
      }
    }
  }

  /** when true, layout generation runs on a Web Worker (async) */
  useWorker = false;

  /**
   * Chunk keys with an async build currently in flight. The await inside
   * buildFromLayout spans frames under slow renderers; without this guard
   * update() re-queues the same chunk every frame and duplicate builds
   * stack until memory blows out.
   */
  private building = new Set<string>();

  private build(cx: number, cz: number): void {
    const k = this.key(cx, cz);
    this.building.add(k); // cleared by buildFromLayout's finally
    if (this.useWorker) {
      getLayoutPool().requestLayout(this.seed, cx, cz).then((l) => {
        if (!this.chunks.has(k)) return;
        void this.buildFromLayout(cx, cz, l);
      }).catch(() => {
        const l2 = generateLayout(this.seed, cx, cz, this.mem ?? undefined);
        if (this.chunks.has(k)) void this.buildFromLayout(cx, cz, l2);
        else this.building.delete(k);
      });
      return;
    }
    const layout = generateLayout(this.seed, cx, cz, this.mem ?? undefined);
    void this.buildFromLayout(cx, cz, layout);
  }

  private async buildFromLayout(cx: number, cz: number, layout: ChunkLayout): Promise<void> {
    const k = this.key(cx, cz);
    try {
      await this.buildFromLayoutInner(cx, cz, layout);
    } finally {
      this.building.delete(k);
    }
  }

  private async buildFromLayoutInner(cx: number, cz: number, layout: ChunkLayout): Promise<void> {
    const k = this.key(cx, cz);
    // anomaly decor drift (see chunkDeltas.ts): deterministic for a given
    // drift step, so a drifted chunk rebuilds identically until reverted
    const drift = this.deltas?.step(cx, cz) ?? 0;
    if (drift > 0) applyDecorDrift(layout.props, cx, cz, this.seed, drift);
    // F24 aging: every build of a chunk counts as one visit; the folded
    // decay params thicken its decor below. Deterministic per
    // (chunkKey, visits, seed), so a rebuilt chunk shows the same decay.
    const visits = this.aging.recordVisit(k);
    const aging = decayStage(k, visits, this.seed);
    this.agingByChunk.set(k, aging);
    if (aging.stainSpreadFactor > 0 && layout.stains.length > 0) {
      // Stain spread: grow the architect's stain set toward full coverage.
      // The base count is chosen in architect.generateStains; this fold
      // multiplies it where the build path finalizes decor density.
      const arng = new RNG(hash2i(seedFromString(k), this.seed, AGING_DECOR_SALT));
      const extra = Math.round(layout.stains.length * aging.stainSpreadFactor);
      for (let i = 0; i < extra; i++) {
        layout.stains.push({
          x: (cx * CHUNK_CELLS + arng.range(0.5, CHUNK_CELLS - 0.5)) * CELL,
          z: (cz * CHUNK_CELLS + arng.range(0.5, CHUNK_CELLS - 0.5)) * CELL,
          r: arng.range(0.5, 1.6),
        });
      }
    }
    // crackDensityMul seam: the build path has no crack-count site to
    // multiply - wall cracks are runtime decals driven by core/game.ts and
    // the FloorCracks pass is not wired into buildChunkGeometry. The folded
    // value stays exposed via agingAt() for whichever decal pass consumes
    // it first; nothing here forces that wiring.
    // F56 cartographer's error: seeded chance scatters 0-2 map-fragment
    // papers as NoteInstances - this world's existing paper prop kind,
    // rendered flat on the carpet by the mesher's note pass. Payload ids
    // are pure hashes of (seed, chunkKey, fragment slot), so a future
    // pickup/consumption pass resolves the identical fragment from the id
    // alone; this mount places paper only.
    const fragRng = new RNG(hash2i(seedFromString(k), this.seed, MAPFRAG_SALT));
    const fragCount = fragRng.chance(MAPFRAG_CHANCE) ? 1 + fragRng.int(0, 2) : 0;
    for (let fi = 0; fi < fragCount; fi++) {
      layout.notes.push({
        x: (cx * CHUNK_CELLS + fragRng.range(0.8, CHUNK_CELLS - 0.8)) * CELL,
        z: (cz * CHUNK_CELLS + fragRng.range(0.8, CHUNK_CELLS - 0.8)) * CELL,
        rot: fragRng.next() * Math.PI * 2,
        text: 'MAP FRAGMENT #' +
          (hash2i(this.seed, seedFromString(k), fi) >>> 0).toString(16).padStart(8, '0'),
      });
    }
    if (this.consumedBatteries && this.consumedBatteries.size) {
      // coordinate-stable keys survive index shifts between builds
      layout.props = layout.props.filter((p, i) =>
        p.kind !== 'battery' ||
        !this.consumedBatteries!.has(
          cx + ':' + cz + ':' + Math.round(p.x * 100) + ':' + Math.round(p.z * 100),
        ));
    }
    // F32 custodian: erased markings stay gone on every rebuild (position-
    // stable keys survive index shifts between builds)
    if (this.removedGraffiti && this.removedGraffiti.size && layout.graffiti.length) {
      layout.graffiti = layout.graffiti.filter((g) =>
        !this.removedGraffiti!.has(
          cx + ',' + cz + ':' + Math.round(g.x * 100) + ':' + Math.round(g.z * 100),
        ));
    }
    // path echo: faint dark scuffs where the player walked last session
    if (this.pathEchoPoints && this.pathEchoPoints.length) {
      const bx0 = cx * CHUNK_CELLS * CELL, bz0 = cz * CHUNK_CELLS * CELL;
      for (const pt of this.pathEchoPoints) {
        if (pt.x < bx0 || pt.x >= bx0 + CHUNK_CELLS * CELL) continue;
        if (pt.z < bz0 || pt.z >= bz0 + CHUNK_CELLS * CELL) continue;
        if (!layout.pathEcho) layout.pathEcho = [];
        layout.pathEcho.push({ x: pt.x, z: pt.z });
      }
    }
    const story = this.story;
    const beacon = story ? story.beaconForChunk(cx, cz) : null;
    if (story && beacon && !beacon.found) {
      // abandoned expedition camp around the beacon
      layout.props.push(...story.campDecor(beacon));
    }
    // revisited landmarks: the space rearranged the room since you left
    if (layout.landmark && this.discoveredLandmarks?.has(layout.landmark)) {
      const movable = new Set(['desk', 'chair', 'bench', 'crate', 'stacked_chairs', 'gurney']);
      // deterministic rearrangement: seeded from chunk coords + world seed so
      // a rebuilt chunk always shows the same rearrangement (no hidden state)
      const rr = new RNG(hash2i(cx, cz, this.seed ^ 0x3e6d));
      let shifted = 0;
      for (const p of layout.props) {
        if (!movable.has(p.kind) || shifted >= 4) continue;
        if (rr.chance(0.5)) continue;
        p.x += (rr.next() - 0.5) * 0.9;
        p.z += (rr.next() - 0.5) * 0.9;
        shifted++;
      }
      if (shifted > 0) console.log('[lm] rearranged', shifted, 'props in', layout.landmark);
      // memory bleed: furniture from OTHER visited landmarks appears here
      const kindMap: Record<string, string> = {
        'CHAPEL': 'bench', 'EXECUTIVE OFFICE': 'desk', 'LAUNDRY': 'cooler',
        'PLAYROOM': 'crate', 'CANTEEN': 'chair', 'ARCHIVE': 'shelf',
        'SECURITY STATION': 'whiteboard', 'MEDICAL BAY': 'gurney',
      };
      for (const seen of this.discoveredLandmarks) {
        if (seen === layout.landmark) continue;
        const propKind = kindMap[seen];
        if (!propKind) continue;
        const ang = rr.next() * Math.PI * 2;
        const dist2 = 3 + rr.next() * 3;
        const centerX = (cx * CHUNK_CELLS + N_HALF) * CELL;
        const centerZ = (cz * CHUNK_CELLS + N_HALF) * CELL;
        layout.props.push({
          kind: propKind as PropInstance['kind'],
          x: centerX + Math.cos(ang) * dist2,
          z: centerZ + Math.sin(ang) * dist2,
          rot: 0,
          variant: rr.int(0, 4),
        });
        break; // one foreign item per revisit is enough
      }
    }
    // F57 seasonal bleed: each landmark chunk scores itself through the
    // session-hash API in seasonrooms.ts; the highest-scoring key seen
    // this session is the session's single bleed room and carries the
    // tint/particle descriptor on its layout.
    if (layout.landmark) {
      this.seasonSeen.add(k);
      const bleeds = sessionSeasonBleeds(this.seed, [...this.seasonSeen]);
      const winner = bleeds.keys().next().value ?? null;
      if (winner !== null && winner !== this.seasonWinner) {
        const prevWinner = this.seasonWinner;
        this.seasonWinner = winner;
        // A later-streaming landmark outscored the old winner: rebuild that
        // chunk so its stale descriptor clears. Election is a pure argmax
        // of intrinsic scores, so once the seen set stops growing the
        // winner is stable and no rebuild oscillates.
        if (prevWinner) {
          const [pcx, pcz] = prevWinner.split(',').map(Number);
          if (Number.isFinite(pcx) && Number.isFinite(pcz)) this.rebuildChunk(pcx, pcz);
        }
      }
      layout.seasonBleed = winner === k ? bleeds.get(k) : undefined;
      // Particle seam: layout.seasonBleed.particle has no consumer in the
      // build path yet - ambient particle passes live game-side. The
      // descriptor rides on the layout for whoever renders it first.
      // F59 landmark echo mount: register this landmark's +/-7-chunk echo
      // slots on the layout. Occupancy checks against the existing chunk
      // map when the candidate is loaded; unbuilt candidates are predicted
      // with the same pure landmarkFor draw the builder will apply, so the
      // accepted set does not depend on stream order. Echoes carry the SAME
      // descriptor object (reference-equal across the whole registration).
      // DATA-ONLY seam: layout.landmarkEcho is registration metadata for
      // consumers; echo chunks render their canonical generation, and any
      // mirrored-room rendering is a later pass's decision.
      const descriptor = this.landmarkDescriptor(layout);
      const echoes = echoPositions(
        { descriptor, baseChunkX: cx, baseChunkZ: cz },
        {
          canHost: (ex: number, ez: number): boolean => {
            const built = this.chunks.get(this.key(ex, ez));
            if (built) return !built.layout.landmark;
            return landmarkFor(ex, ez, this.seed) === null;
          },
        },
        this.seed,
      );
      if (echoes.length > 0) layout.landmarkEcho = echoes;
    }
    // F51 mezzanine mount: every streamed base chunk carries the
    // seed-independent glimpse footprint (ceiling-crack view-through
    // metadata; no consumer in the mesher yet), and ~1 chunk in 25 passes
    // the rarity gate and gets its staircase + interior descriptor attached.
    // DATA ONLY seam: the descriptor marks layout.mezzanine for the later
    // render pass that mounts full 3D geometry (risers, balcony ring, upper
    // floor) — nothing here forces that wiring. Generation is cached per
    // (seed, chunkKey), so rebuilds reuse one byte-identical pair.
    layout.mezzGlimpse = glimpseFootprint(k);
    const mezzKey = this.seed + '|' + k;
    let mezz = this.mezzCache.get(mezzKey);
    if (mezz === undefined) {
      mezz = mezzanineGate(this.seed, k) ? generateMezzanine(this.seed, k) : null;
      this.mezzCache.set(mezzKey, mezz);
    }
    if (mezz) layout.mezzanine = mezz;
    // contact shadows: soft dark blobs under furniture (torch-lit realism)
    try {
      // ../gfx/shadowmesher does not exist yet; widening the specifier to a plain
      // string defers resolution to runtime, where the surrounding catch
      // already handles its absence.
      const { ShadowMesherPass } = await import('../gfx/shadowmesher');
      const pass = new ShadowMesherPass();
      layout.shadowQuads = pass.generate(layout.props);
    } catch (e) { console.warn('[bmb] contact shadows unavailable', e); }
    const geo = buildChunkGeometry(layout);
    // district temperature tint: subtle per-region hue shifts
    const TINTS: [number, number, number][] = [
      [0.96, 0.94, 0.88],  // maze: warm-dim
      [1.04, 1.02, 0.95],  // open office: brighter
      [1.00, 0.97, 0.90],  // honeycomb
      [0.92, 0.95, 1.00],  // corridor grid: cool
      [0.88, 0.86, 0.80],  // storage: dusty dim
    ];
    const tint = TINTS[layout.district as number] ?? [1, 1, 1];
    for (const grp of [geo.floor, geo.ceiling, geo.walls, geo.debris]) {
      applyTint(grp, tint[0], tint[1], tint[2]);
    }
    // seasonal-bleed tint: tilt the district look toward the bleed room's
    // packed ambient hue, kept subtle so it reads as air, not paint.
    const bleed = layout.seasonBleed;
    if (bleed) {
      const br = ((bleed.tint >> 16) & 255) / 255;
      const bg = ((bleed.tint >> 8) & 255) / 255;
      const bb = (bleed.tint & 255) / 255;
      const mean = (br + bg + bb) / 3;
      for (const grp of [geo.floor, geo.ceiling, geo.walls, geo.debris]) {
        applyTint(grp, 1 + (br - mean) * 0.45, 1 + (bg - mean) * 0.45, 1 + (bb - mean) * 0.45);
      }
    }

    const meshes: Mesh[] = [];
    const make = (arrs: typeof geo.floor, name: string, mat: keyof MaterialSet): void => {
      if (arrs.indices.length === 0) return;
      const mesh = new Mesh(name, this.scene);
      const vd = new VertexData();
      vd.positions = new Float32Array(arrs.positions);
      vd.normals = new Float32Array(arrs.normals);
      vd.uvs = new Float32Array(arrs.uvs);
      vd.indices = arrs.indices;
      if (arrs.colors) vd.colors = new Float32Array(arrs.colors);
      vd.applyToMesh(mesh);
      mesh.material = this.mats[mat] as StandardMaterial;
      mesh.freezeWorldMatrix();
      mesh.isPickable = false;
      meshes.push(mesh);
    };
    make(geo.floor, 'floor_' + cx + '_' + cz, 'carpet');
    make(geo.ceiling, 'ceil_' + cx + '_' + cz, 'ceiling');
    make(geo.walls, 'walls_' + cx + '_' + cz, 'wall');
    make(geo.fixtures, 'fx_' + cx + '_' + cz, 'fixture');
    make(geo.fixturesDead, 'fxd_' + cx + '_' + cz, 'fixtureDead');
    make(geo.props, 'props_' + cx + '_' + cz, 'prop');
    make(geo.debris, 'debris_' + cx + '_' + cz, 'paper');
    make(geo.puddles, 'puddles_' + cx + '_' + cz, 'puddle');
    make(geo.stains, 'stains_' + cx + '_' + cz, 'stain');

    for (const s of layout.signs) meshes.push(this.buildSign(s));
    for (const gf of layout.graffiti) meshes.push(this.buildGraffiti(gf));

    const prev = this.chunks.get(k);
    if (prev) for (const m of prev.meshes) m.dispose(); // no orphaned meshes
    this.chunks.set(k, {
      layout,
      meshes,
      colliders: buildColliders(layout),
    });
    this.fixtureCache = null;
    this.fixtureVersion++;
    this.totalBuilt++;
  }

  private signMats = new Map<string, StandardMaterial>();

  /**
   * Deterministic landmark identity for one built chunk, used as the F59
   * echo descriptor: id/name from the landmark name, the prop manifest from
   * the layout's distinct prop kinds (sorted), and lights mapped to
   * room-local meters at the standard fixture hang height. Pure function of
   * the built layout, so a rebuilt chunk re-derives a byte-identical value.
   */
  private landmarkDescriptor(layout: ChunkLayout): LandmarkDescriptor {
    const name = layout.landmark as string;
    const bx = layout.cx * ChunkManager.CELLS * CELL;
    const bz = layout.cz * ChunkManager.CELLS * CELL;
    return {
      id: 'lm:' + name,
      name,
      props: [...new Set(layout.props.map((p) => p.kind))].sort(),
      lights: layout.lights.map((l) => ({
        kind: l.alive ? 'fluoro' : 'dead-tube',
        x: l.x - bx,
        y: WALL_H - 0.35,
        z: l.z - bz,
      })),
    };
  }

  private signMaterial(s: SignInstance, discoveredTick = false): StandardMaterial {
    const key = (s.kind.valueOf() % 2 === 1 ? 'i:' : 'n:') + s.text + (discoveredTick ? ':seen' : '');
    const hit = this.signMats.get(key);
    if (hit) return hit;
    const tex = new DynamicTexture('signtex', { width: 512, height: 128 }, this.scene, true);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const invert = (s.kind.valueOf() % 2) === 1;
    ctx.fillStyle = invert ? '#20241f' : '#cfc7a6';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = invert ? '#b9c4a8' : '#33302a';
    ctx.font = 'bold 64px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, 256, 70);
    ctx.fillStyle = 'rgba(60,50,30,0.25)';
    for (const r of signGrimeRects(s.text, s.kind.valueOf())) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (discoveredTick) {
      // cyan underline stripe marking a room you have entered before
      ctx.fillStyle = '#7fd8d8';
      ctx.fillRect(96, 108, 320, 8);
    }
    tex.update(false);
    const mat = new StandardMaterial('signMat', this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(0.22, 0.22, 0.18);
    mat.specularColor = Color3.Black();
    mat.maxSimultaneousLights = 8;
    this.signMats.set(key, mat);
    return mat;
  }

  private buildSign(s: SignInstance): Mesh {
    const tick = !!this.discoveredLandmarks?.has(s.text);
    const w = Math.max(0.5, s.text.length * 0.14 + 0.24);
    const plane = MeshBuilder.CreatePlane('sign', { width: w, height: 0.36 }, this.scene);
    const OFF = 0.1;
    switch (s.face) {
      case 0: plane.position.set(s.x, s.y, s.z - WALL_HALF - OFF); break;
      case 1: plane.position.set(s.x, s.y, s.z + WALL_HALF + OFF); plane.rotation.y = Math.PI; break;
      case 2: plane.position.set(s.x - WALL_HALF - OFF, s.y, s.z); plane.rotation.y = -Math.PI / 2; break;
      case 3: plane.position.set(s.x + WALL_HALF + OFF, s.y, s.z); plane.rotation.y = Math.PI / 2; break;
    }
    plane.material = this.signMaterial(s, tick);
    plane.freezeWorldMatrix();
    plane.isPickable = false;
    return plane;
  }

  private graffitiMats = new Map<string, StandardMaterial>();

  private buildGraffiti(gf: import('./architect').GraffitiInstance): Mesh {
    const w = Math.min(1.6, gf.text.length * 0.11 + 0.2);
    const hgt = 0.42;
    const OFF = WALL_T / 2 + 0.012;
    let cxw = gf.x, czw = gf.z;
    if (gf.face === 0) czw -= OFF;
    else if (gf.face === 1) czw += OFF;
    else if (gf.face === 2) cxw -= OFF;
    else cxw += OFF;
    const horiz = gf.face === 0 || gf.face === 1;
    // reuse the mesher's quad orientation by building a plane and rotating it
    const plane = MeshBuilder.CreatePlane('graffiti', { width: w, height: hgt }, this.scene);
    switch (gf.face) {
      case 0: plane.position.set(cxw, gf.y, czw); break;
      case 1: plane.position.set(cxw, gf.y, czw); plane.rotation.y = Math.PI; break;
      case 2: plane.position.set(cxw, gf.y, czw); plane.rotation.y = -Math.PI / 2; break;
      case 3: plane.position.set(cxw, gf.y, czw); plane.rotation.y = Math.PI / 2; break;
    }
    void horiz;
    const key = gf.text;
    let mat = this.graffitiMats.get(key);
    if (!mat) {
      const tex = new DynamicTexture('graffititex', { width: 512, height: 128 }, this.scene, true);
      const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 512, 128);
      ctx.fillStyle = 'rgba(58,26,18,0.92)';
      ctx.font = 'bold italic 72px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(256, 64);
      ctx.rotate(graffitiTilt(gf.text));
      ctx.fillText(gf.text, 0, 0);
      ctx.restore();
      tex.update(false);
      tex.hasAlpha = true;
      mat = new StandardMaterial('graffitiMat', this.scene);
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.emissiveColor = new Color3(0.06, 0.02, 0.015);
      mat.specularColor = Color3.Black();
      mat.maxSimultaneousLights = 8;
      mat.backFaceCulling = false;
      this.graffitiMats.set(key, mat);
    }
    plane.material = mat;
    plane.freezeWorldMatrix();
    plane.isPickable = false;
    return plane;
  }

  collidersAround(x: number, z: number): Box2[] {
    const out: Box2[] = [];
    const pcx = worldToChunk(x), pcz = worldToChunk(z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(this.key(pcx + dx, pcz + dz));
        if (c) out.push(...c.colliders);
      }
    }
    return out;
  }

  /** Nearest readable note within reach of a position. */
  nearestNote(x: number, z: number): import('./architect').NoteInstance | null {
    let best: import('./architect').NoteInstance | null = null;
    let bd = Infinity;
    for (const c of this.chunks.values()) {
      for (const n of c.layout.notes) {
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < 1.7 && d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }

  /** Edge code crossed when moving from cell (fx,fz) to adjacent cell. */
  edgeCodeBetweenCell(fx: number, fz: number, tx: number, tz: number): number {
    const N = CHUNK_CELLS;
    let wx: number, wz: number, vert: boolean;
    if (tx === fx + 1) { vert = true; wx = tx; wz = fz; }
    else if (tx === fx - 1) { vert = true; wx = fx; wz = fz; }
    else if (tz === fz + 1) { vert = false; wx = fx; wz = tz; }
    else if (tz === fz - 1) { vert = false; wx = fx; wz = fz; }
    else return 0;
    // both neighboring chunks store this border edge identically
    const cx = Math.floor(wx / N), cz = Math.floor(wz / N);
    const c = this.chunks.get(this.key(cx, cz));
    if (!c) return 0;
    const lx = wx - cx * N;
    const lz = wz - cz * N;
    return vert ? c.layout.vEdges[lz * (N + 1) + lx] : c.layout.hEdges[lz * N + lx];
  }

  /** Landmark room name for the chunk containing a position (if any). */
  landmarkAtPos(x: number, z: number): string | undefined {
    const c = this.chunks.get(this.key(worldToChunk(x), worldToChunk(z)));
    return c?.layout.landmark;
  }

  /** Loaded landmark rooms within maxDist of a position. */
  landmarkCentersNear(px: number, pz: number, maxDist: number): { name: string; x: number; z: number; key: string }[] {
    const out: { name: string; x: number; z: number; key: string }[] = [];
    for (const c of this.chunks.values()) {
      if (!c.layout.landmark) continue;
      const x = (c.layout.cx * CHUNK_CELLS + N_HALF) * CELL;
      const z = (c.layout.cz * CHUNK_CELLS + N_HALF) * CELL;
      const d = Math.hypot(x - px, z - pz);
      if (d <= maxDist) out.push({ name: c.layout.landmark, x, z, key: c.layout.cx + ',' + c.layout.cz });
    }
    return out;
  }

  /** Nearest un-consumed battery pickup within reach. */
  nearestBattery(x: number, z: number): PropInstance | null {
    let best: PropInstance | null = null;
    let bd = Infinity;
    for (const c of this.chunks.values()) {
      for (const p of c.layout.props) {
        if (p.kind !== 'battery') continue;
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < 1.6 && d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  /** Dispose and rebuild one chunk in place (used after prop consumption). */
  rebuildChunk(cx: number, cz: number): void {
    const key = this.key(cx, cz);
    const existing = this.chunks.get(key);
    if (!existing) return;
    for (const m of existing.meshes) m.dispose();
    this.chunks.delete(key);
    this.fixtureCache = null;
    this.build(cx, cz);
  }

  allFixtures(): LightFixture[] {
    if (!this.fixtureCache) {
      const out: LightFixture[] = [];
      for (const c of this.chunks.values()) out.push(...c.layout.lights);
      this.fixtureCache = out;
    }
    return this.fixtureCache;
  }

  nearestFixtureDist(x: number, z: number): number {
    return this.nearestFixture(x, z, 0).d;
  }

  /** Nearest alive fixture with stereo pan relative to a facing yaw. */
  nearestFixture(x: number, z: number, yaw: number): { d: number; pan: number } {
    let bd = Infinity;
    let bx = 0, bz = 0;
    for (const c of this.chunks.values()) {
      for (const l of c.layout.lights) {
        if (!l.alive) continue;
        const d = (l.x - x) ** 2 + (l.z - z) ** 2;
        if (d < bd) { bd = d; bx = l.x; bz = l.z; }
      }
    }
    if (!isFinite(bd)) return { d: Infinity, pan: 0 };
    const dx = bx - x, dz = bz - z;
    const len = Math.hypot(dx, dz) || 1;
    // camera-right vector for Babylon yaw is (cos, -sin)
    const pan = Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dz * -Math.sin(yaw)) / len));
    return { d: Math.sqrt(bd), pan };
  }

  get loadedCount(): number { return this.chunks.size; }

  layoutAt(cx: number, cz: number): ChunkLayout | undefined {
    return this.chunks.get(this.key(cx, cz))?.layout;
  }

  /** All currently loaded layouts (atmosphere consumers iterate these). */
  loadedLayouts(): ChunkLayout[] {
    const out: ChunkLayout[] = [];
    for (const c of this.chunks.values()) out.push(c.layout);
    return out;
  }

  /** District of the chunk containing a position (if built). */
  districtAtPos(x: number, z: number): number | null {
    const c = this.chunks.get(this.key(worldToChunk(x), worldToChunk(z)));
    return c ? (c.layout.district as number) : null;
  }

  /** deterministic sparse selection used by story beacon placement */
  chunkSalt(cx: number, cz: number): number {
    return hash2i(cx, cz, this.seed ^ BEACON_SALT);
  }

  cellKey(x: number, z: number): number {
    return hash2i(Math.floor(x / CELL), Math.floor(z / CELL), this.seed);
  }

  static CELLS = CHUNK_CELLS;
}
