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


