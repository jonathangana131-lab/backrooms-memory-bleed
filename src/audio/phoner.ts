/**
 * Distant telephone ringing for BACKROOMS: MEMORY BLEED.
 *
 * The OPEN_OFFICE wrongness garnish owned by areaidentity.ts: telephones
 * ring in rooms you cannot reach. Fully procedural, no assets:
 *
 *   PLACEMENT a deterministic per-session hash scatters candidate phones
 *             on a sparse grid; each hash also picks an in-cell offset,
 *             so the same seed always builds the same dead offices.
 *   RING      two slightly-wrong sines (a bell pair detuned off the
 *             standard 440+480) through a distance lowpass, amplitude-
 *             gated at ~20 Hz into that old electromechanical buzz.
 *   ONCE ONLY when a phone first comes within earshot it rings twice,
 *             then its key enters the done-set and it stays silent for
 *             the rest of the session — whatever was calling has given up.
 *
 * Determinism: placement and ring jitter derive from core/rng hashes and
 * mulberry32 streams keyed by the session seed.
 */
import { hash2i, rand2 } from '../core/rng';

/** Grid spacing between candidate phones (meters). */
export const PHONE_CELL = 48;

/** Fraction of grid cells that actually hold a phone. */
export const PHONE_DENSITY = 0.34;

/** Earshot radius: phones start ringing inside this distance (meters). */
export const RING_HEARSHOT = 26;

/** Ring bursts before a phone goes silent forever. */
export const RINGS_PER_PHONE = 2;

/** Session salt mixed into every placement hash. */
const SALT = 0x70e1;

/** Deterministic PRNG (same construction as crowd.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One placed phone. */
interface PhoneSpot {
  readonly key: string;
  readonly x: number;
  readonly z: number;
}

/** One ringing voice currently sounding. */
interface LiveRing {
  readonly sources: AudioScheduledSourceNode[];
  endsAt: number;
}

export class PhoneRinger {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Session seed driving the placement hash; 0 until seeded(). */
  private sessionSeed = 0;
  /** Phones that have already rung their RINGS_PER_PHONE this session. */
  private readonly done = new Set<string>();
  private stopped = false;

  private readonly live = new Set<LiveRing>();

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Bind the placement hash to a run's seed. Call once after startNew;
 * re-seeding mid-session keeps already-rung phones silent via done keys.
   * @param seed session/world seed
   */
  seed(seed: number): void { this.sessionSeed = seed | 0; }

  /**
   * Per-frame tick: check earshot against un-rung phones near the player.
   * @param dt seconds since the previous frame (drives nothing scheduled)
   * @param px player world x
   * @param pz player world z
   */
  update(dt: number, px: number, pz: number): void {
    if (this.stopped || this.sessionSeed === 0) return;
    void dt;
    // Only the cells around the player can possibly be in earshot.
    const cx = Math.floor(px / PHONE_CELL);
    const cz = Math.floor(pz / PHONE_CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        if (!this.hasPhone(gx, gz)) continue;
        const spot = this.phoneAt(gx, gz);
        if (this.done.has(spot.key)) continue;
        const d = Math.hypot(px - spot.x, pz - spot.z);
        if (d <= RING_HEARSHOT) {
          this.done.add(spot.key); // rings twice, never again this session
          this.startRing(spot);
        }
      }
    }
    // Reap finished rings so stop() only touches sounding voices.
    const now = this.ctx.currentTime;
    for (const ring of this.live) {
      if (ring.endsAt <= now) {
        for (const src of ring.sources) { try { src.stop(); } catch { /* ended */ } }
        this.live.delete(ring);
      }
    }
  }

  /** Silence everything sounding; the instance will not restart. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const ring of this.live) {
      for (const src of ring.sources) { try { src.stop(); } catch { /* already ended */ } }
    }
    this.live.clear();
  }

  /** True when the placement hash puts a phone in this grid cell. */
  hasPhone(cx: number, cz: number): boolean {
    if (this.sessionSeed === 0) return false;
    return rand2(this.sessionSeed ^ cx, cz ^ SALT, SALT) < PHONE_DENSITY;
  }

  /** Deterministic in-cell position for a hashed phone cell. */
  phoneAt(cx: number, cz: number): PhoneSpot {
    const h = hash2i(this.sessionSeed ^ (cx * 73856093), cz * 19349663, SALT);
    return {
      key: cx + ',' + cz + '@' + this.sessionSeed,
      x: cx * PHONE_CELL + (h % 1000) / 1000 * PHONE_CELL,
      z: cz * PHONE_CELL + ((h >>> 10) % 1000) / 1000 * PHONE_CELL,
    };
  }

  /** Two ring bursts, ~3 s apart, quieter with distance from the listener. */
  private startRing(spot: PhoneSpot): void {
    const rnd = mulberry32(hash2i(spot.x | 0, spot.z | 0, this.sessionSeed));
    const t0 = this.ctx.currentTime + 0.15 + rnd() * 0.4;
    const dist = 6 + rnd() * 18; // placement is unreachable; keep it distant
    const gainScale = Math.min(1, 36 / (dist * dist)) * 0.05;
    let cursor = t0;
    const sources: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < RINGS_PER_PHONE; i++) {
      sources.push(...this.ringBurst(cursor, gainScale, rnd));
      cursor += 3.2;
    }
    this.live.add({ sources, endsAt: cursor + 0.5 });
  }

  /**
   * One ~1.8 s burst: detuned bell-pair sines gated by a 20 Hz square-ish
   * LFO through a distance lowpass.
   */
  private ringBurst(at: number, level: number, rnd: () => number): AudioScheduledSourceNode[] {
    const ctx = this.ctx;
    const srcs: AudioScheduledSourceNode[] = [];

    // Bell pair, deliberately off the 440/480 standard by a few cents-worth.
    const fA = 440 * (0.995 + rnd() * 0.01);
    const fB = 480 * (0.99 + rnd() * 0.02);
    const mix = ctx.createGain();
    mix.gain.value = level;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.5;

    // Electromechanical gate: fast tremolo shaping both partials.
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 20;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth);
    lfoDepth.connect(gate.gain);

    for (const [f, w] of [[fA, 0.6], [fB, 0.4]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = w;
      osc.connect(og);
      og.connect(mix);
      osc.start(at);
      srcs.push(osc);
    }

    // Envelope on the post-gate sum: fade in, hold, fade out.
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(1, at + 0.25);
    env.gain.setValueAtTime(1, at + 1.4);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);

    mix.connect(lp);
    lp.connect(gate);
    gate.connect(env);
    env.connect(this.out);
    lfo.start(at);
    srcs.push(lfo);
    return srcs;
  }
}


