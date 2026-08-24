/**
 * F32 Custodian cart squeak - approaching-cart loop voices.
 *
 * When the overnight pass schedules a removal, a cleaning cart squeaks its
 * way toward that wall: repeating rubber-wheel chirps whose pace quickens
 * and whose gain rises as the listener closes in, then cut out at the
 * removal moment (the building does not let you watch). One tracked cart
 * per scheduled marking; pacing rolls come from a per-cart RNG seeded by
 * the marking id, so identical nights replay identically (src/core/rng.ts
 * law; no Math.random anywhere - oscillator parameters only).
 *
 * Voice technique mirrors cabinetcreak.ts: plain WebAudio nodes
 * (oscillator -> gain -> stereo panner), so it works headless against a
 * minimal context mock like the cabinetcreak/groans tests use.
 */
import { RNG } from '../core/rng';

/** World position the cart is heading toward (the doomed scrawl). */
export interface SqueakTarget { x: number; z: number }

/** Distance at which a cart is first audible, metres. */
export const CART_AUDIBLE_M = 34;
/** Chirp interval at the edge of audibility, seconds. */
const FAR_INTERVAL_S = 1.4;
/** Chirp interval point-blank, seconds. */
const NEAR_INTERVAL_S = 0.22;
/** Peak linear gain point-blank. */
const PEAK_GAIN = 0.075;
/** Wheel-squeak sweep band, Hz. */
const SWEEP_LO_HZ = 950;
const SWEEP_HI_HZ = 1350;
/** Single chirp length, seconds. */
const CHIRP_S = 0.14;

/** FNV-1a over a string id so cart streams derive from the marking id. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface ActiveCart {
  x: number;
  z: number;
  nextChirpIn: number;
  rng: RNG;
}

/**
 * Approaching-cart squeak loops. cue() starts one cart, update(dt, px, pz)
 * paces its chirps by listener distance, stop()/stopAll() cut them out.
 */
export class CartSqueaks {
  private readonly carts = new Map<string, ActiveCart>();
  private stopped = false;

  constructor(private readonly ctx: AudioContext, private readonly destination: AudioNode | null) {}

 /** Number of currently tracked carts (test surface). */
  get size(): number {
    return this.carts.size;
  }

  /**
   * Start (or re-target) the cart approaching marking id. Seeding derives
   * from the id alone, so the same night plan replays the same squeaks.
   */
  cue(id: string, target: SqueakTarget): void {
    if (this.stopped) return;
    this.carts.set(id, {
      x: target.x,
      z: target.z,
      nextChirpIn: 0.05, // first squeak lands almost immediately after the cue
      rng: new RNG(hashId(id)),
    });
  }

  /** The cart reached its wall (removal fired): silence that voice. */
  stop(id: string): void {
    this.carts.delete(id);
  }

  /** Silence every tracked cart and refuse further cues. */
  stopAll(): void {
    this.stopped = true;
    this.carts.clear();
  }

  /**
   * Advance one frame: countdown each cart's next chirp, pacing and gain
   * driven by listener distance. Facing -Z, world +X falls on the left, so
   * pan mirrors (playerX - cartX) exactly like cabinetcreak's panner.
   */
  update(dt: number, px: number, pz: number): void {
    if (this.stopped || !(dt > 0)) return;
    for (const cart of this.carts.values()) {
      const dist = Math.hypot(cart.x - px, cart.z - pz);
      const prox = Math.max(0, Math.min(1, 1 - dist / CART_AUDIBLE_M));
      cart.nextChirpIn -= dt;
      if (cart.nextChirpIn > 0) continue;
      cart.nextChirpIn = FAR_INTERVAL_S - (FAR_INTERVAL_S - NEAR_INTERVAL_S) * prox;
      // wheel jitter: near carts run slightly ragged, distant ones even
      if (cart.rng.chance(0.25)) cart.nextChirpIn *= cart.rng.range(1.2, 1.6);
      if (dist >= CART_AUDIBLE_M) continue; // audible gate: pacing still advances
      this.chirp(cart, px, prox);
    }
  }

  /** One rubber-wheel chirp: downward sine sweep through pan + envelope. */
  private chirp(cart: ActiveCart, px: number, prox: number): void {
    if (!this.destination) return;
    const t = this.ctx.currentTime;
    const f0 = SWEEP_LO_HZ + cart.rng.range(-60, 160);
    const peak = PEAK_GAIN * (0.25 + 0.75 * prox);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0 + SWEEP_HI_HZ - SWEEP_LO_HZ, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(80, f0), t + CHIRP_S);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + CHIRP_S);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, (px - cart.x) / CART_AUDIBLE_M));

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.destination);
    osc.start(t);
    osc.stop(t + CHIRP_S + 0.03);
  }
}