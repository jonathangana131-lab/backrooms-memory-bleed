/***********************************************************************
 * F93 diegetic-menu wall plane: renders a DiegeticMenu onto a textured
 * quad stuck to an in-world wall.
 *
 * Division of labor with src/ui/diegmenus.ts:
 *  - diegmenus.ts owns the pure math (wall frames, raycast mounting,
 *    cursor state, aspect-preserving layout constants). It never touches
 *    Babylon, so the projection/raycast AC is testable headless.
 *  - this module owns the single Babylon surface: one plane mesh with a
 *    canvas-generated monospace texture redrawn on cursor moves. The
 *    DOM menus stay canonical; this projection is an in-world mirror.
 *
 * Mounting flow (see Game.mountWallMenu): raycast the camera ray at the
 * scene, wrap the hit in a WallPlane {origin, normal, up}, run
 * faceTowards() so the readable side aims at the viewer, then convert
 * the resulting normal to a yaw for the axis-aligned walls this world
 * is built from (same convention as gfx/projections.ts).
 ***********************************************************************/
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import {
  MENU_HEIGHT_M,
  MENU_WIDTH_M,
  type MenuContent,
} from './diegmenus';

/** Canvas resolution per meter of wall menu (square pixels). */
const TEX_PX_PER_M = 220;

/** Gap between the texture plane and the wall surface, meters. */
export const WALL_MENU_OFFSET_M = 0.03;

/** Eye height the menu band centers on, meters. */
export const WALL_MENU_Y = 1.55;

/** Monospace family shared with the HUD so the projection reads as UI. */
const FONT = '"Courier New", Courier, monospace';

/**
 * One wall-mounted menu projection. Construct once per menu host
 * (title/pause), then alternate between mountAt()/refresh() as the
 * cursor or mounting wall changes.
 */
export class WallMenuPlane {
  private readonly mesh: Mesh;
  private readonly tex: DynamicTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private content: MenuContent | null = null;

  constructor(private readonly scene: Scene) {
    const w = Math.round(MENU_WIDTH_M * TEX_PX_PER_M);
    const h = Math.round(MENU_HEIGHT_M * TEX_PX_PER_M);
    this.tex = new DynamicTexture('wallmenuTex', { width: w, height: h }, scene, true);
    this.tex.hasAlpha = false;
    this.ctx = this.tex.getContext() as unknown as CanvasRenderingContext2D;

    const mat = new StandardMaterial('wallmenuMat', scene);
    mat.diffuseTexture = this.tex;
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(0.92, 0.9, 0.8);
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = true;

    this.mesh = MeshBuilder.CreatePlane('wallmenu', {
      width: MENU_WIDTH_M,
      height: MENU_HEIGHT_M,
    }, scene);
    // Readable-side convention matches gfx/projections.ts: after
    // rotation.y = yaw the textured face looks along (sin yaw, 0, cos yaw).
    this.mesh.material = mat;
    this.mesh.isPickable = false;
    this.mesh.setEnabled(false);
  }

  /**
   * Mount the plane on a wall point: origin is the menu center in world
   * space and yaw faces the textured side toward the room (the plane's
   * readable normal is (sin yaw, 0, cos yaw)).
   */
  mountAt(origin: { x: number; z: number }, yaw: number): void {
    this.mesh.position.set(
      origin.x + Math.sin(yaw) * WALL_MENU_OFFSET_M,
      WALL_MENU_Y,
      origin.z + Math.cos(yaw) * WALL_MENU_OFFSET_M,
    );
    this.mesh.rotation.y = yaw;
    this.mesh.freezeWorldMatrix();
    this.mesh.setEnabled(true);
  }

  /** Detach from the wall and hide (model state is untouched). */
  unmount(): void {
    this.mesh.setEnabled(false);
  }

  get mounted(): boolean {
    return this.mesh.isEnabled();
  }

  /**
   * Redraw the texture for the given content and cursor row. Pure
   * canvas work: title band across the top, one row per item below,
   * highlight bar behind the cursor row.
   */
  refresh(content: MenuContent, cursor: number): void {
    this.content = content;
    const W = this.tex.getSize().width;
    const H = this.tex.getSize().height;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10, 11, 8, 0.94)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(140, 128, 92, 0.85)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);

    const bandH = Math.round(H * 0.28);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ecdfae';
    ctx.font = 'bold ' + Math.round(bandH * 0.42) + 'px ' + FONT;
    ctx.fillText(content.title, W / 2, bandH / 2);

    const rowsTop = bandH;
    const rowH = (H - bandH) / Math.max(1, content.items.length);
    for (let i = 0; i < content.items.length; i++) {
      const cy = rowsTop + rowH * (i + 0.5);
      if (i === cursor) {
        ctx.fillStyle = 'rgba(205, 191, 114, 0.22)';
        ctx.fillRect(W * 0.06, rowsTop + rowH * i + 4, W * 0.88, rowH - 8);
      }
      ctx.fillStyle = i === cursor ? '#fff3bd' : '#b7ad8d';
      ctx.font = Math.round(rowH * 0.34) + 'px ' + FONT;
      ctx.fillText((i === cursor ? '> ' : '') + content.items[i].label, W / 2, cy);
    }
    this.tex.update(false);
  }

  /** Currently bound menu content (null until the first refresh). */
  get menu(): MenuContent | null {
    return this.content;
  }

  /** Remove the mesh and material from the scene. */
  dispose(): void {
    this.mesh.dispose();
    this.tex.dispose();
  }
}
