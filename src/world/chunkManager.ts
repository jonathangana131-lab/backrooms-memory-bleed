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
import { CHUNK_CELLS, CELL, WALL_T, worldToChunk } from './constants';
import { generateLayout, type Box2, type ChunkLayout, type LightFixture, type SignInstance } from './architect';
import { getLayoutPool } from '../workers/layoutPool';
import { buildColliders } from './collision';
import { buildChunkGeometry, applyTint } from './mesher';
import type { GraffitiInstance, PropInstance } from './architect';
import { hash2i, RNG } from '../core/rng';
import type { MaterialSet } from '../gfx/materials';
import type { MemoryField } from '../memory/field';

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

  constructor(private scene: Scene, private mats: MaterialSet, public seed: number) {}

  key(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  reset(): void {
    for (const c of this.chunks.values()) for (const m of c.meshes) m.dispose();
    this.chunks.clear();
    this.pending.length = 0;
    this.fixtureCache = null;
    this.fixtureVersion++;
  }

  update(px: number, pz: number): void {
    const pcx = worldToChunk(px);
    const pcz = worldToChunk(pz);

    this.pending.length = 0;
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        if (!this.chunks.has(this.key(cx, cz))) {
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
        this.fixtureCache = null;
        this.fixtureVersion++;
      }
    }
  }

  /** when true, layout generation runs on a Web Worker (async) */
  useWorker = false;

  private build(cx: number, cz: number): void {
    if (this.useWorker) {
      getLayoutPool().requestLayout(this.seed, cx, cz).then((l) => {
        if (!this.chunks.has(cx + ':' + cz)) return;
        void this.buildFromLayout(cx, cz, l);
      }).catch(() => {
        const l2 = generateLayout(this.seed, cx, cz, this.mem ?? undefined);
        if (this.chunks.has(cx + ':' + cz)) void this.buildFromLayout(cx, cz, l2);
      });
      return;
    }
    const layout = generateLayout(this.seed, cx, cz, this.mem ?? undefined);
    void this.buildFromLayout(cx, cz, layout);
  }

  private async buildFromLayout(cx: number, cz: number, layout: ChunkLayout): Promise<void> {
    if (this.consumedBatteries && this.consumedBatteries.size) {
      // coordinate-stable keys survive index shifts between builds
      layout.props = layout.props.filter((p, i) =>
        p.kind !== 'battery' ||
        !this.consumedBatteries!.has(
          cx + ':' + cz + ':' + Math.round(p.x * 100) + ':' + Math.round(p.z * 100),
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

    this.chunks.set(this.key(cx, cz), {
      layout,
      meshes,
      colliders: buildColliders(layout),
    });
    this.fixtureCache = null;
    this.fixtureVersion++;
    this.totalBuilt++;
  }

  private signMats = new Map<string, StandardMaterial>();

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
    for (let i = 0; i < 40; i++) {
      ctx.fillRect(Math.random() * 512, Math.random() * 128, 3, 2);
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
      ctx.rotate(-0.05 + Math.random() * 0.1);
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
