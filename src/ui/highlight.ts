/**
 * Interaction highlighting for BACKROOMS: MEMORY BLEED.
 *
 * Visual feedback for interactable objects (beacons, notes, batteries):
 *   1. Glow outline    - interactables within GLOW_RANGE (2.5m) receive a glow,
 *                       via Babylon HighlightLayer when the caller supplies the
 *                       real mesh, otherwise via a self-owned emissive billboard
 *                       proxy (notes/batteries live in merged chunk meshes, so
 *                       there is no per-item mesh to decorate).
 *   2. Prompt anchor   - the interaction label ("E - READ" / "E - TAKE") is
 *                       projected from world to screen space and floats near
 *                       the object instead of a fixed HUD slot.
 *   3. Proximity fade  - glow strength scales inversely with distance: full at
 *                       GLOW_FULL_DIST (1m), zero at GLOW_RANGE (2.5m).
 *   4. Smooth fades    - every strength ramps linearly over FADE_SECONDS
 *                       (150ms) so highlights never pop in/out.
 *
 * Integration (game.ts handleInteraction already gathers the same candidates):
 *
 *   const hl = new InteractionHighlighter({ scene });
 *   await hl.ready;                     // once, before first update
 *   // each frame, after gathering note/battery/beacon candidates:
 *   hl.update(dt, { px, pz, targets });
 *
 * All pure math lives in module-level functions so it is unit-testable under
 * Node without Babylon or a DOM (see test/highlight-test.mjs).
 */

import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Color3 } from '@babylonjs/core/Maths/math.color';
import type { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer';

// ---------------------------------------------------------------------------
// Tunables and palette
// ---------------------------------------------------------------------------

/** Interactables glow within this many meters of the player. */
export const GLOW_RANGE = 2.5;
/** Distance at which the glow reaches full strength. */
export const GLOW_FULL_DIST = 1.0;
/** Seconds for a highlight to ramp fully in or out. */
export const FADE_SECONDS = 0.15;

export type HighlightKind = 'beacon' | 'note' | 'battery';

/** Base glow RGB per interactable kind (linear, pre-strength). */
export const GLOW_COLORS: Record<HighlightKind, readonly [number, number, number]> = {
  beacon: [1.0, 0.98, 0.92],  // white pulse
  note: [1.0, 0.72, 0.30],    // warm amber
  battery: [0.40, 1.0, 0.48], // green tint
};

/** Default anchored prompt text per kind. */
export const DEFAULT_LABELS: Record<HighlightKind, string> = {
  beacon: 'E \u2014 ACCESS',
  note: 'E \u2014 READ',
  battery: 'E \u2014 TAKE',
};

/** Prompt anchor height above item base, per kind (meters). */
const ANCHOR_HEIGHT: Record<HighlightKind, number> = {
  beacon: 2.55,
  note: 0.55,
  battery: 0.55,
};

/** Hover height of the glow proxy billboard above the item base. */
const PROXY_HEIGHT: Record<HighlightKind, number> = {
  beacon: 2.05,
  note: 0.34,
  battery: 0.34,
};

const PROXY_SIZE: Record<HighlightKind, number> = {
  beacon: 0.46,
  note: 0.36,
  battery: 0.32,
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested under Node)
// ---------------------------------------------------------------------------

/**
 * Proximity falloff: 1 at or below GLOW_FULL_DIST, linearly down to 0 at
 * GLOW_RANGE, 0 beyond. Monotonic non-increasing in dist.
 */
export function proximityStrength(dist: number): number {
  if (!Number.isFinite(dist)) return 0;
  if (dist <= GLOW_FULL_DIST) return 1;
  if (dist >= GLOW_RANGE) return 0;
  return (GLOW_RANGE - dist) / (GLOW_RANGE - GLOW_FULL_DIST);
}

/**
 * Linear ramp of cur toward goal covering the full 0..1 sweep in exactly
 * FADE_SECONDS. dt is in seconds; non-positive or NaN dt leaves cur unchanged.
 */
export function approach(cur: number, goal: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return cur;
  const maxStep = FADE_SECONDS > 0 ? dt / FADE_SECONDS : 1;
  if (goal > cur) return Math.min(goal, cur + maxStep);
  if (goal < cur) return Math.max(goal, cur - maxStep);
  return cur;
}

/** Beacon lamps breathe; the glow breathes with them. */
export function beaconPulse(timeSec: number): number {
  return 0.7 + 0.3 * Math.sin(timeSec * 5.0);
}

/**
 * Final glow RGB for a kind at a moment in time (beacon pulse pre-applied;
 * strength scaling is applied by the caller/material separately).
 */
export function glowColor(kind: HighlightKind, timeSec: number): [number, number, number] {
  const base = GLOW_COLORS[kind];
  const k = kind === 'beacon' ? beaconPulse(timeSec) : 1;
  return [base[0] * k, base[1] * k, base[2] * k];
}

/** Prompt copy for a target (explicit label wins over the default). */
export function labelFor(kind: HighlightKind, label?: string): string {
  return label ?? DEFAULT_LABELS[kind];
}

/** Stable bookkeeping key for a target: explicit id, else quantized position. */
export function keyFor(t: HighlightTarget): string {
  if (t.id) return t.id;
  return t.kind + ':' + Math.round(t.x * 100) + ':' + Math.round(t.z * 100);
}

export interface HighlightTarget {
  kind: HighlightKind;
  /** Ground-plane world position of the item. */
  x: number;
  z: number;
  /** Base height above the floor (default 0). */
  y?: number;
  /** Optional stable identity; derived from kind+position when omitted. */
  id?: string;
  /**
   * Real mesh backing the item, when one exists (beacon poles do; merged chunk
   * props do not). Enables the HighlightLayer / emissive-modulation path.
   */
  mesh?: unknown;
  /** Prompt text override. */
  label?: string;
}

/** Nearest candidate within maxDist, or null when nothing is close enough. */
export function pickNearest(
  targets: readonly HighlightTarget[],
  px: number,
  pz: number,
  maxDist: number = GLOW_RANGE,
): { target: HighlightTarget; dist: number } | null {
  let best: HighlightTarget | null = null;
  let bd = maxDist;
  for (const t of targets) {
    const d = Math.hypot(t.x - px, t.z - pz);
    if (d < bd) { bd = d; best = t; }
  }
  return best ? { target: best, dist: bd } : null;
}

/**
 * Project a world point through a column-major 16-float view-projection matrix
 * to pixel coordinates. Returns clip w so callers can reject points behind the
 * camera (w <= 0).
 */
export function projectPoint(
  x: number,
  y: number,
  z: number,
  m: ArrayLike<number>,
  viewportW: number,
  viewportH: number,
): { x: number; y: number; w: number } {
  const cxp = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cyp = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (cw === 0) return { x: viewportW / 2, y: viewportH / 2, w: 0 };
  const ndcX = cxp / cw;
  const ndcY = cyp / cw;
  return {
    x: ((ndcX + 1) * 0.5) * viewportW,
    y: ((1 - ndcY) * 0.5) * viewportH,
    w: cw,
  };
}

// ---------------------------------------------------------------------------
// Runtime system
// ---------------------------------------------------------------------------

export interface HighlighterOptions {
  scene: Scene;
  /** DOM host for the anchored prompt (defaults to the canvas parent). */
  container?: HTMLElement | string;
  /** Try the Babylon HighlightLayer for targets that supply real meshes. */
  useHighlightLayer?: boolean;
}

export interface HighlightUpdateContext {
  /** Player/focus ground position. */
  px: number;
  pz: number;
  /** Candidates for this frame (freshly gathered from chunks/story). */
  targets: readonly HighlightTarget[];
  /** Camera override; defaults to scene.activeCamera. */
  camera?: Camera;
}

interface MarkerState {
  kind: HighlightKind;
  x: number;
  z: number;
  y: number;
  label: string;
  strength: number;
  /** Self-owned emissive billboard (proxy path). */
  proxy: Mesh | null;
  proxyMat: StandardMaterial | null;
  /** Real-mesh decoration state (HighlightLayer / emissive modulation). */
  targetMesh: Mesh | null;
  origEmissive: Color3 | null;
  hlAdded: boolean;
}

export class InteractionHighlighter {
  /** Resolves once Babylon submodules are loaded and the prompt DOM exists. */
  readonly ready: Promise<void>;

  private readonly scene: Scene;
  private readonly useHL: boolean;
  private hl: HighlightLayer | null = null;
  private promptEl: HTMLElement | null = null;
  private markers = new Map<string, MarkerState>();
  private time = 0;
  private disposed = false;

  // Lazily loaded Babylon modules (dynamic so the pure helpers stay runnable
  // under plain Node without resolving @babylonjs imports).
  private mMeshBuilder!: typeof import('@babylonjs/core/Meshes/meshBuilder');
  private mMesh!: typeof import('@babylonjs/core/Meshes/mesh');
  private mStdMat!: typeof import('@babylonjs/core/Materials/standardMaterial');
  private mColor!: typeof import('@babylonjs/core/Maths/math.color');

  constructor(opts: HighlighterOptions) {
    this.scene = opts.scene;
    this.useHL = opts.useHighlightLayer !== false;
    this.ready = this.init(opts.container).catch((err) => {
      console.error('[highlight] init failed; running glow-less', err);
    });
  }

  private async init(container?: HTMLElement | string): Promise<void> {
    const [mb, mm, sm, mc, hlm] = await Promise.all([
      import('@babylonjs/core/Meshes/meshBuilder'),
      import('@babylonjs/core/Meshes/mesh'),
      import('@babylonjs/core/Materials/standardMaterial'),
      import('@babylonjs/core/Maths/math.color'),
      import('@babylonjs/core/Layers/highlightLayer'),
    ]);
    this.mMeshBuilder = mb;
    this.mMesh = mm;
    this.mStdMat = sm;
    this.mColor = mc;

    if (this.useHL && typeof document !== 'undefined') {
      try {
        const hl = new hlm.HighlightLayer('interactHighlight', this.scene);
        hl.innerGlow = false;
        this.hl = hl;
      } catch (err) {
        // e.g. engine created without stencil support; proxies cover us.
        console.warn('[highlight] HighlightLayer unavailable, using emissive proxies', err);
        this.hl = null;
      }
    }

    if (typeof document !== 'undefined') {
      const canvas = this.scene.getEngine().getRenderingCanvas();
      let host: HTMLElement | null = null;
      if (typeof container === 'string') host = document.querySelector<HTMLElement>(container);
      else if (container) host = container;
      else host = (canvas?.parentElement as HTMLElement | null) ?? document.body;
      if (host) {
        const el = document.createElement('div');
        el.className = 'interact-prompt-hl';
        const s = el.style;
        s.position = 'absolute';
        s.left = '0';
        s.top = '0';
        s.fontSize = '13px';
        s.fontFamily = 'inherit';
        s.letterSpacing = '2px';
        s.color = '#ffe9b0';
        s.background = 'rgba(10,9,3,0.72)';
        s.border = '1px solid rgba(255,214,120,0.45)';
        s.padding = '6px 12px';
        s.whiteSpace = 'nowrap';
        s.pointerEvents = 'none';
        s.opacity = '0';
        s.willChange = 'transform';
        s.zIndex = '30';
        host.appendChild(el);
        this.promptEl = el;
      }
    }
  }

  /**
   * Drive glows and the anchored prompt for this frame. Safe to call before
   * ready resolves (the frame is simply skipped while modules load).
   */
  update(dt: number, ctx: HighlightUpdateContext): void {
    if (this.disposed || !this.mMeshBuilder) return;
    const step = Number.isFinite(dt) ? Math.max(dt, 0) : 0;
    this.time += step;

    const seen = new Set<string>();

    for (const t of ctx.targets) {
      const key = keyFor(t);
      seen.add(key);
      const dist = Math.hypot(t.x - ctx.px, t.z - ctx.pz);
      const inRange = dist < GLOW_RANGE;
      const goal = inRange ? proximityStrength(dist) : 0;

      let mk = this.markers.get(key);
      if (!mk) {
        mk = {
          kind: t.kind,
          x: t.x,
          z: t.z,
          y: t.y ?? 0,
          label: labelFor(t.kind, t.label),
          strength: 0,
          proxy: null,
          proxyMat: null,
          targetMesh: (t.mesh as Mesh | undefined) ?? null,
          origEmissive: null,
          hlAdded: false,
        };
        this.markers.set(key, mk);
      }

      mk.x = t.x;
      mk.z = t.z;
      mk.y = t.y ?? 0;
      mk.label = labelFor(t.kind, t.label);

      const prev = mk.strength;
      const next = approach(prev, goal, step);
      mk.strength = next;

      if (next <= 0 && goal <= 0) {
        this.destroyMarker(key);
        continue;
      }

      // Materialize/decorate only while visibly glowing.
      if (next > 0 && prev <= 0) this.attachVisual(mk, t.mesh);
      if (mk.proxy || mk.hlAdded || mk.origEmissive) this.applyGlow(mk);
    }

    // Markers absent from this frame candidate list fade out.
    for (const key of [...this.markers.keys()]) {
      if (seen.has(key)) continue;
      const mk = this.markers.get(key);
      if (!mk) continue;
      mk.strength = approach(mk.strength, 0, step);
      if (mk.strength <= 0) this.destroyMarker(key);
      else this.applyGlow(mk);
    }

    this.updatePrompt(ctx);
  }

  /** Release every resource this system owns. */
  dispose(): void {
    this.disposed = true;
    for (const key of [...this.markers.keys()]) this.destroyMarker(key);
    this.markers.clear();
    if (this.promptEl) {
      this.promptEl.remove();
      this.promptEl = null;
    }
    if (this.hl) {
      try { this.hl.dispose(); } catch { /* already gone */ }
      this.hl = null;
    }
  }

  // -- internals ------------------------------------------------------------

  private attachVisual(mk: MarkerState, meshRef: unknown): void {
    const mesh = meshRef as Mesh | undefined;
    if (mesh && this.hl) {
      try {
        this.hl.addMesh(mesh, this.hlColor(mk));
        mk.hlAdded = true;
        mk.targetMesh = mesh;
        return;
      } catch (err) {
        console.warn('[highlight] addMesh failed; falling back', err);
        this.hl = null;
      }
    }
    if (mesh) {
      const mat = mesh.material as StandardMaterial | null;
      if (mat && !mk.origEmissive) {
        mk.origEmissive = mat.emissiveColor.clone();
        mk.targetMesh = mesh;
        return;
      }
    }
    this.createProxy(mk);
  }

  private createProxy(mk: MarkerState): void {
    if (mk.proxy) return;
    const size = PROXY_SIZE[mk.kind];
    const proxy = this.mMeshBuilder.MeshBuilder.CreatePlane(
      'hl_' + mk.kind + '_' + mk.x.toFixed(1) + '_' + mk.z.toFixed(1),
      { size },
      this.scene,
    );
    proxy.position.set(mk.x, mk.y + PROXY_HEIGHT[mk.kind], mk.z);
    proxy.billboardMode = this.mMesh.Mesh.BILLBOARDMODE_ALL;
    proxy.isPickable = false;
    const mat = new this.mStdMat.StandardMaterial('hlMat_' + mk.kind, this.scene);
    mat.disableLighting = true;
    mat.emissiveColor = new this.mColor.Color3(0, 0, 0);
    mat.diffuseColor = this.mColor.Color3.Black();
    mat.specularColor = this.mColor.Color3.Black();
    mat.backFaceCulling = false;
    mat.alpha = 0;
    proxy.material = mat;
    mk.proxy = proxy;
    mk.proxyMat = mat;
  }

  private hlColor(mk: MarkerState): Color3 {
    const [r, g, b] = glowColor(mk.kind, this.time);
    return new this.mColor.Color3(r * mk.strength, g * mk.strength, b * mk.strength);
  }

  private applyGlow(mk: MarkerState): void {
    const s = mk.strength;
    if (mk.proxyMat) {
      const [r, g, b] = glowColor(mk.kind, this.time);
      mk.proxyMat.emissiveColor.set(r * s, g * s, b * s);
      mk.proxyMat.alpha = Math.min(1, s * 1.1);
      if (mk.proxy) mk.proxy.position.set(mk.x, mk.y + PROXY_HEIGHT[mk.kind], mk.z);
    }
    if (mk.hlAdded && mk.targetMesh && this.hl) {
      try { this.hl.addMesh(mk.targetMesh, this.hlColor(mk)); } catch { /* dropped */ }
    }
    if (mk.origEmissive && mk.targetMesh) {
      const mat = mk.targetMesh.material as StandardMaterial | null;
      if (mat) {
        const o = mk.origEmissive;
        const [r, g, b] = glowColor(mk.kind, this.time);
        mat.emissiveColor.set(o.r + r * s * 0.6, o.g + g * s * 0.6, o.b + b * s * 0.6);
      }
    }
  }

  private destroyMarker(key: string): void {
    const mk = this.markers.get(key);
    if (!mk) return;
    if (mk.proxy) {
      mk.proxy.dispose();
      mk.proxy = null;
    }
    if (mk.proxyMat) {
      mk.proxyMat.dispose();
      mk.proxyMat = null;
    }
    if (mk.hlAdded && mk.targetMesh && this.hl) {
      try { this.hl.removeMesh(mk.targetMesh); } catch { /* gone */ }
    }
    if (mk.origEmissive && mk.targetMesh) {
      const mat = mk.targetMesh.material as StandardMaterial | null;
      if (mat) mat.emissiveColor.copyFrom(mk.origEmissive);
    }
    this.markers.delete(key);
  }

  private updatePrompt(ctx: HighlightUpdateContext): void {
    const el = this.promptEl;
    if (!el) return;
    const near = pickNearest(ctx.targets, ctx.px, ctx.pz);
    if (!near) {
      el.style.opacity = '0';
      return;
    }
    const mk = this.markers.get(keyFor(near.target));
    const s = mk ? mk.strength : proximityStrength(near.dist);
    if (s <= 0.02) {
      el.style.opacity = '0';
      return;
    }

    const cam = ctx.camera ?? this.scene.activeCamera;
    if (!cam) {
      el.style.opacity = '0';
      return;
    }
    const engine = this.scene.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const vp = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
    const t = near.target;
    const wy = (t.y ?? 0) + ANCHOR_HEIGHT[t.kind];
    const pt = projectPoint(t.x, wy, t.z, vp.m, w, h);
    if (pt.w <= 0 || pt.x < -80 || pt.x > w + 80 || pt.y < -80 || pt.y > h + 80) {
      el.style.opacity = '0';
      return;
    }

    const txt = mk ? mk.label : labelFor(t.kind, t.label);
    if (el.textContent !== txt) el.textContent = txt;
    el.style.transform =
      'translate(' + pt.x.toFixed(1) + 'px,' + pt.y.toFixed(1) + 'px) translate(-50%,-115%)';
    el.style.opacity = s.toFixed(3);
  }
}


