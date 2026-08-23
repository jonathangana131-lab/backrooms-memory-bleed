/** Canvas minimap: explored chunks, player marker, landmarks, beacons. */
import { CHUNK_SIZE } from '../world/constants';

const SIZE = 150;              // canvas edge in px
const PX_PER_CHUNK = 12;       // map scale
const VIEW_RADIUS = SIZE / 2 / PX_PER_CHUNK; // chunks visible from center
const BEACON_RANGE = 90;       // world units: max distance to pulse a beacon

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private visited = new Set<string>();
  private landmarks: { x: number; z: number; name: string }[] = [];
  private beacons: { x: number; z: number }[] = [];
  private px = 0;
  private pz = 0;
  private yaw = Math.PI;
  private visible = false;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    const s = this.canvas.style;
    s.position = 'absolute';
    s.top = '10px';
    s.right = '10px';
    s.width = SIZE + 'px';
    s.height = SIZE + 'px';
    s.display = 'none'; // starts hidden
    s.zIndex = '20';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'm' || e.key === 'M') this.toggle();
    });
  }

  markVisited(cx: number, cz: number): void {
    this.visited.add(cx + ',' + cz);
  }

  markLandmark(x: number, z: number, name: string): void {
    this.landmarks.push({ x, z, name });
  }

  markBeacon(x: number, z: number): void {
    this.beacons.push({ x, z });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.style.display = this.visible ? 'block' : 'none';
  }

  /** Redraw the map each frame at player position (px, pz) facing yaw. */
  update(px: number, pz: number, yaw: number): void {
    this.px = px;
    this.pz = pz;
    this.yaw = yaw;
    if (!this.visible) return;

    const ctx = this.ctx;
    const c = SIZE / 2;
    const ccx = Math.floor(px / CHUNK_SIZE);
    const ccz = Math.floor(pz / CHUNK_SIZE);

    // semi-transparent backdrop with thin border
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = 'rgba(6, 8, 6, 0.72)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = 'rgba(140, 160, 140, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);

    // explored chunks: dark squares; current chunk lighter
    ctx.fillStyle = 'rgba(90, 110, 90, 0.35)';
    for (const key of this.visited) {
      const [cx, cz] = key.split(',').map(Number);
      const sx = c + (cx * CHUNK_SIZE - px) / CHUNK_SIZE * PX_PER_CHUNK;
      const sz = c + (cz * CHUNK_SIZE - pz) / CHUNK_SIZE * PX_PER_CHUNK;
      if (sx < -PX_PER_CHUNK || sz < -PX_PER_CHUNK ||
          sx > SIZE || sz > SIZE) continue;
      ctx.fillRect(sx, sz, PX_PER_CHUNK, PX_PER_CHUNK);
    }
    ctx.fillStyle = 'rgba(150, 175, 150, 0.45)';
    ctx.fillRect(c, c, PX_PER_CHUNK, PX_PER_CHUNK);

    // landmarks within view: cyan dots

(Showing lines 30-89 of 139. Use offset=90 to continue.)

    ctx.fillStyle = '#00e5ff';
    for (const lm of this.landmarks) {
      const sx = c + lm.x - px;
      const sz = c + lm.z - pz;
      if (sx < 3 || sz < 3 || sx > SIZE - 3 || sz > SIZE - 3) continue;
      ctx.beginPath();
      ctx.arc(sx, sz, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // unfound beacons in range: pulsing white dots
    const t = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(t * 4);
    for (const b of this.beacons) {
      const dx = b.x - px;
      const dz = b.z - pz;
      if (dx * dx + dz * dz > BEACON_RANGE * BEACON_RANGE) continue;
      const sx = c + dx / CHUNK_SIZE * PX_PER_CHUNK;
      const sz = c + dz / CHUNK_SIZE * PX_PER_CHUNK;
      if (sx < 4 || sz < 4 || sx > SIZE - 4 || sz > SIZE - 4) continue;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sx, sz, 2.5 + pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // player: triangle at center oriented by yaw
    // forward vector in world space is (-sin(yaw), -cos(yaw))
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const nose = 7, wing = 4;
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath();
    ctx.moveTo(c + fx * nose, c + fz * nose);
    ctx.lineTo(c - fx * wing + rx * wing, c - fz * wing + rz * wing);
    ctx.lineTo(c - fx * wing - rx * wing, c - fz * wing - rz * wing);
    ctx.closePath();
    ctx.fill();

    // range hint ring
    ctx.strokeStyle = 'rgba(255, 215, 94, 0.18)';
    ctx.beginPath();
    ctx.arc(c, c, BEACON_RANGE / CHUNK_SIZE * PX_PER_CHUNK, 0, Math.PI * 2);
    ctx.stroke();
  }
}


