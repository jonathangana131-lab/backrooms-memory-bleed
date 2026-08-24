/**
 * Live occlusion reverb for BACKROOMS: MEMORY BLEED (F88).
 *
 * Per-room-volume audio physics computed live. The model is injected the
 * world's room volumes ({id, bounds, material class}) and, from geometry
 * alone, derives a reverb descriptor per room:
 *
 *   - RT60 via the Sabine equation RT60 = 0.161 * V / A, where V is the
 *     room's air volume and A its total absorption (surface area x material
 *     absorption coefficient). Bigger rooms ring longer; more absorptive
 *     materials die faster.
 *   - Early-reflection delays: first-order wall bounces, delay = 2d/c per
 *     axis pair (c = speed of sound), sorted ascending.
 *
 * As the listener moves, `update()` resolves the enclosing room and, on a
 * room change, opens exactly one crossfade transition between the previous
 * and next descriptors over TAU seconds (~0.4 s). While it runs the output
 * is a linear blend; at completion only the new descriptor remains.
 *
 * The descriptor is plain data so a convolver consumer can build its impulse
 * response without touching this module.
 *
 * Pure Node-testable: no DOM, no Web Audio graph, no Date.now(), no
 * Math.random() — everything is arithmetic over injected inputs (see
 * test/occreverb-test.mjs).
 */

// ---------------------------------------------------------------------------
// Materials + room volumes
// ---------------------------------------------------------------------------

/** Sabine constant (s · m⁻¹), metric SI value of 0.161 s/m. */
export const SABINE_CONSTANT = 0.161;

/** Speed of sound in m/s used for early-reflection delays. */
export const SPEED_OF_SOUND_MPS = 343;

/**
 * Material classes with their mid-band absorption coefficients (alpha,
 * 0..1). Higher alpha absorbs more energy per bounce → shorter RT60.
 */
export const MATERIAL_ABSORPTION: Readonly<Record<string, number>> = {
  /** Classic moist office tile: hard, reflective. */
  tile: 0.06,
  /** Bare poured concrete: long, hollow tail. */
  concrete: 0.05,
  /** Yellow backrooms carpet: deadens mids. */
  carpet: 0.35,
  /** Suspended acoustic ceiling tiles. */
  ceilingTile: 0.5,
  /** Water film / wet floor overlay: mid absorber with sheen. */
  wetSurface: 0.22,
};

/** Default absorption for rooms whose material class is unknown. */
export const FALLBACK_ABSORPTION = MATERIAL_ABSORPTION.tile;

/** Axis-aligned bounds of one room volume. */
export interface Bounds {
  /** Minimum corner [x, y, z]. */
  min: readonly [number, number, number];
  /** Maximum corner [x, y, z]. */
  max: readonly [number, number, number];
}

/** One injected room volume with its dominant surface material class. */
export interface RoomVolume {
  /** Stable room identifier; must be unique within an injection. */
  id: string;
  /** Axis-aligned bounds of the room. */
  bounds: Bounds;
  /** Material class key into MATERIAL_ABSORPTION. */
  material: string;
}

/** Per-room reverb descriptor consumed by a convolver. */
export interface ReverbDescriptor {
  /** Room the descriptor belongs to ('' while blending between two). */
  roomId: string;
  /** Estimated RT60 in seconds (> 0). */
  rt60Sec: number;
  /** First-order early-reflection delays in seconds, ascending. */
  earlyDelaysSec: readonly number[];
  /** Wet mix suggestion in 0..1, derived from RT60 (longer = wetter). */
  wetGain: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Air volume in m³ of valid bounds; NaN when extents are degenerate. */
export function boundsVolume(b: Bounds): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return dx * dy * dz;
}

/** True when all six extents are finite and strictly positive. */
export function boundsValid(b: Bounds): boolean {
  return (
    Number.isFinite(boundsVolume(b)) &&
    b.max[0] > b.min[0] &&
    b.max[1] > b.min[1] &&
    b.max[2] > b.min[2]
  );
}

/** Total face area in m² (sum over the six faces). */
export function boundsSurfaceArea(b: Bounds): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return 2 * (dx * dy + dx * dz + dy * dz);
}

/** Point-in-bounds test; non-finite coordinates are never inside. */
export function boundsContain(b: Bounds, p: readonly number[]): boolean {
  if (!p.every(Number.isFinite)) return false;
  return (
    p[0] >= b.min[0] && p[0] <= b.max[0] &&
    p[1] >= b.min[1] && p[1] <= b.max[1] &&
    p[2] >= b.min[2] && p[2] <= b.max[2]
  );
}

// ---------------------------------------------------------------------------
// Descriptor computation
// ---------------------------------------------------------------------------

/**
 * Sabine RT60 estimate for one room.

 * @param volume Air volume in m³ (must be finite, > 0).
 * @param absorption Total absorption A in m² (must be finite, > 0).
 * @returns RT60 in seconds; falls back to MIN_RT60_SEC when inputs are junk
 *   or the ratio underflows.
 */
export function sabineRt60(volume: number, absorption: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(absorption)) return MIN_RT60_SEC;
  if (volume <= 0 || absorption <= 0) return MIN_RT60_SEC;
  return Math.max(MIN_RT60_SEC, SABINE_CONSTANT * volume / absorption);
}

/** Floor for RT60 estimates so degenerate rooms never reach zero. */
export const MIN_RT60_SEC = 0.08;

/** Ceiling for RT60 so pathological halls stay inside convolver budgets. */
export const MAX_RT60_SEC = 8;

/**
 * Compute the reverb descriptor of one valid room volume.
 *
 * @param room Injected room volume (bounds must satisfy boundsValid).
 * @returns Its descriptor; early delays cover the six first-order bounces.
 * @throws When the room's bounds are degenerate or non-finite.
 */
export function computeDescriptor(room: RoomVolume): ReverbDescriptor {
  if (!boundsValid(room.bounds)) throw new Error(`invalid bounds for room ${room.id}`);
  const alpha = Object.prototype.hasOwnProperty.call(MATERIAL_ABSORPTION, room.material)
    ? MATERIAL_ABSORPTION[room.material]
    : FALLBACK_ABSORPTION;
  const area = boundsSurfaceArea(room.bounds);
  const rawRt60 = sabineRt60(boundsVolume(room.bounds), area * alpha);
  const rt60Sec = Math.min(MAX_RT60_SEC, rawRt60);
  // First-order reflections: sound travels to each face pair and back,
  // so each axis contributes 2 × separation / c, ascending per axis order.
  const d = [
    2 * (room.bounds.max[0] - room.bounds.min[0]) / SPEED_OF_SOUND_MPS,
    2 * (room.bounds.max[1] - room.bounds.min[1]) / SPEED_OF_SOUND_MPS,
    2 * (room.bounds.max[2] - room.bounds.min[2]) / SPEED_OF_SOUND_MPS,
  ];
  const delays = [...d].sort((a, b) => a - b);
  const wetGain = Math.min(1, rt60Sec / 2);
  return { roomId: room.id, rt60Sec, earlyDelaysSec: delays, wetGain };
}

/**
 * Linear blend of two descriptors for a crossfade consumer. Delay lists are
 * blended elementwise; the shorter list pads from its last entry.

 * @param from Descriptor fading out.
 * @param to Descriptor fading in.
 * @param t Blend position in 0..1 (clamped); 0 = from, 1 = to.
 * @returns Blended descriptor; roomId is empty because neither endpoint owns it.
 */
export function blendDescriptors(
  from: ReverbDescriptor,
  to: ReverbDescriptor,
  t: number,
): ReverbDescriptor {
  const u = Math.min(1, Math.max(0, t));
  const n = Math.max(from.earlyDelaysSec.length, to.earlyDelaysSec.length);
  const delays: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i < from.earlyDelaysSec.length ? from.earlyDelaysSec[i] : from.earlyDelaysSec[from.earlyDelaysSec.length - 1];
    const b = i < to.earlyDelaysSec.length ? to.earlyDelaysSec[i] : to.earlyDelaysSec[to.earlyDelaysSec.length - 1];
    delays.push(a + (b - a) * u);
  }
  return {
    roomId: '',
    rt60Sec: from.rt60Sec + (to.rt60Sec - from.rt60Sec) * u,
    earlyDelaysSec: delays,
    wetGain: from.wetGain + (to.wetGain - from.wetGain) * u,
  };
}

// ---------------------------------------------------------------------------
// Listener model with crossfade transitions
// ---------------------------------------------------------------------------

/** Crossfade duration for room-to-room descriptor blends, in seconds. */
export const TRANSITION_TAU_SEC = 0.4;

/** Completion tolerance band around τ accepted by the AC (±10 %). */
export const TAU_TOLERANCE = 0.1;

/** One blended room-to-room descriptor transition. */
export interface ReverbTransition {
  /** Descriptor fading out. */
  from: ReverbDescriptor;
  /** Descriptor fading in. */
  to: ReverbDescriptor;
  /** Model time the crossfade started, in seconds. */
  startSec: number;
}

/** Output of one listener update. */
export interface OccReverbOutput {
  /** Enclosing room id, or null when the listener is outside every room. */
  roomId: string | null;
  /** Descriptor the convolver should render right now. */
  descriptor: ReverbDescriptor | null;
  /** Active crossfade, exactly once per room crossing until complete. */
  transition: ReverbTransition | null;
  /** True on this call iff a transition completed here (fires once). */
  transitionCompleted: boolean;
}

/**
 * Live occlusion-reverb model over injected room volumes. `update` is the
 * only input; it is pure with respect to the injected world and keeps only
 * the listener's current room and any open transition.
 */
export class OccReverb {
  private readonly rooms: Map<string, RoomVolume>;
  private readonly descriptors: Map<string, ReverbDescriptor>;
  private currentRoomId: string | null = null;
  private pending: ReverbTransition | null = null;

  /**
   * @param rooms Injected room volumes; duplicate ids fail loud. Malformed
   *   entries (degenerate/non-finite bounds) are dropped junk-safely.
   */
  constructor(rooms: readonly RoomVolume[]) {
    this.rooms = new Map();
    this.descriptors = new Map();
    const seen = new Set<string>();
    for (const r of rooms) {
      if (!r || typeof r.id !== 'string' || r.id === '') continue;
      if (seen.has(r.id)) throw new Error(`duplicate room id: ${r.id}`);
      seen.add(r.id);
      if (!boundsValid(r.bounds)) continue;
      this.rooms.set(r.id, r);
      this.descriptors.set(r.id, computeDescriptor(r));
    }
  }

  /** Registered room ids in injection order. */
  get roomIds(): readonly string[] {
    return [...this.rooms.keys()];
  }

  /**
   * Precomputed descriptor of one registered room.

   * @param roomId Room identifier.
   * @returns The descriptor, or null for unknown ids.
   */
  descriptorFor(roomId: string): ReverbDescriptor | null {
    return this.descriptors.get(roomId) ?? null;
  }

  /**
   * Resolve which room encloses a position.

   * @param pos Listener position [x, y, z].
   * @returns Enclosing room id, or null when outside every room.
   */
  roomAt(pos: readonly number[]): string | null {
    if (!Array.isArray(pos) || !pos.every(Number.isFinite)) return null;
    for (const r of this.rooms.values()) {
      if (boundsContain(r.bounds, pos)) return r.id;
    }
    return null;
  }

  /**
   * Advance the model to a listener pose at model time nowSec. Crossing into
   * a different room opens exactly one transition (a second crossing before
   * completion retargets the fade-in but never stacks a second fade); the
   * transition completes after TRANSITION_TAU_SEC of update-time.
   *
   * @param pos Listener position [x, y, z].
   * @param nowSec Monotonic model time in seconds.
   * @returns Current room, live (possibly blended) descriptor, and
   *   transition state; outside every room yields nulls and closes any
   *   pending fade silently.
   */
  update(pos: readonly number[], nowSec: number): OccReverbOutput {
    const roomId = this.roomAt(pos);
    let transitionCompleted = false;
    if (roomId === null) {
      this.currentRoomId = null;
      this.pending = null;
      return { roomId: null, descriptor: null, transition: null, transitionCompleted: false };
    }
    // Retire an expired fade exactly once.
    if (this.pending !== null && nowSec - this.pending.startSec >= TRANSITION_TAU_SEC) {
      this.pending = null;
      transitionCompleted = true;
      this.currentRoomId = roomId;
    }
    // Open exactly one fade per crossing; while a fade is open, later
    // crossings retarget its fade-in endpoint instead of stacking a second.
    if (roomId !== this.currentRoomId && this.pending === null) {
      const prevRoomId = this.currentRoomId;
      this.currentRoomId = roomId;
      const from = prevRoomId !== null ? this.descriptorFor(prevRoomId) : null;
      const to = this.descriptorFor(roomId)!;
      if (from !== null) this.pending = { from, to, startSec: nowSec };
    }
    if (this.pending !== null) {
      const to = this.descriptorFor(roomId)!;
      if (to !== this.pending.to) this.pending.to = to;
      this.currentRoomId = roomId;
    }
    const out = this.pending;
    let descriptor: ReverbDescriptor | null;
    if (out === null) {
      descriptor = this.descriptorFor(roomId);
    } else {
      const t = (nowSec - out.startSec) / TRANSITION_TAU_SEC;
      descriptor = blendDescriptors(out.from, out.to, t);
    }
    return { roomId, descriptor, transition: out, transitionCompleted };
  }

  /**
   * Snapshot of the currently open transition, if any.
   */
  activeTransition(): ReverbTransition | null {
    return this.pending;
  }

  /** Id of the room the model last resolved the listener into. */
  get currentRoom(): string | null {
    return this.currentRoomId;
  }
}
