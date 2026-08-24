/**
 * Stomach growl synth — the audio half of F73 hunger pangs.
 *
 * The pang SCHEDULE lives in src/player/hunger.ts (pure simulation);
 * game.ts drains its `drainEvents()` every frame and used to surface
 * pangs only as throttled HUNGER captions because this synth had never
 * landed. This module closes that v1.1 debt: each drained PangEvent is
 * rendered as one procedural stomach growl voice, no asset files:
 *
 *   - a falling-pitch sawtooth rumble (~80-110 Hz down to ~45-65 Hz)
 *     through a resonant lowpass, the "hollow room" of a gut,
 *   - a gain envelope whose peak grows with the pang's intensity
 *     (longer expeditions hit harder) and lasts exactly the pang's
 *     seeded durationS,
 *   - 2-3 deterministic mid-voice "gurgle" dips so no two growls in a
 *     row sound stamped from the same die.
 *
 * Every voice is derived purely from its PangEvent (seeded RNG keyed by
 * the pang's session minute), so a given seed + clock timeline renders
 * byte-identical plans forever and replays stay stable. Node-graph
 * failures are contained per voice: a broken WebAudio graph degrades to
 * silence, never to a thrown frame.
 */
import { RNG, hash32 } from '../core/rng';
import type { PangEvent } from '../player/hunger';

/** One scheduled gain point of a growl, relative to the voice start. */
export interface GrowlEnvelopePoint {
  /** Offset from voice start in seconds; envelope is ascending in this. */
  atS: number;
  /** Linear-ramp target as a fraction of the voice's peak gain. */
  gain: number;
}

/** Fully specified, deterministic description of one growl voice. */
export interface GrowlPlan {
  oscType: 'sawtooth';
  /** Oscillator pitch at voice start, Hz. */
  startHz: number;
  /** Oscillator pitch at voice end, Hz (< startHz: the rumble falls). */
  endHz: number;
  lowpassHz: number;
  lowpassQ: number;
  /** Total audible length in seconds (== the pang's seeded durationS). */
  durationS: number;
  /** Peak linear gain at the end of the attack ramp. */
  peakGain: number;
  /** Attack/hold/gurgle points between 0 and durationS, ascending. */
  envelope: GrowlEnvelopePoint[];
}

/** Hard clamp on rendered voice length regardless of event data. */
const MIN_DUR_S = 0.35;
const MAX_DUR_S = 2.5;

/** Salt so stomach-plan hashes never collide with other hash32 users. */
const PLAN_SALT = 0x53544f4d; // 'STOM'

/**
 * Derive the complete growl plan for one pang. Pure: same event (and
 * optional salt for same-minute collisions) always yields a deep-equal
 * plan, and nothing here touches wall-clock or unseeded randomness.
 */
export function planGrowl(event: PangEvent, salt = 0): GrowlPlan {
  const dur = Math.min(MAX_DUR_S, Math.max(MIN_DUR_S, event.durationS));
  const rng = new RNG(hash32(Math.round(event.timeMin * 1000) ^ PLAN_SALT ^ (salt | 0)));
  const intensity = event.intensity < 0 ? 0 : event.intensity > 1 ? 1 : event.intensity;
  // Base pitch rises a little with intensity; seeded +/-8% jitter keeps
  // consecutive growls from being pitch-identical.
  const baseHz = 82 + 24 * intensity;
  const startHz = baseHz * (1 + (rng.next() * 2 - 1) * 0.08);
  const endHz = startHz * (0.58 + rng.next() * 0.12);
  const peakGain = 0.045 + 0.075 * intensity;
  const gurgles = 2 + Math.floor(rng.next() * 2); // 2..3 dips per growl
  const envelope: GrowlEnvelopePoint[] = [];
  const attack = Math.min(0.09, dur * 0.2);
  envelope.push({ atS: 0, gain: 0 });
  envelope.push({ atS: attack, gain: 1 });
  // Gurgle dips spread deterministically across the middle of the voice.
  for (let i = 0; i < gurgles; i++) {
    const f = 0.3 + (0.55 * (i + rng.next())) / gurgles;
    envelope.push({ atS: f * dur, gain: 0.35 + rng.next() * 0.2 });
    envelope.push({ atS: f * dur + (dur * 0.08), gain: 0.85 + rng.next() * 0.15 });
  }
  envelope.push({ atS: dur, gain: 0 });
  envelope.sort((a, b) => a.atS - b.atS);
  return {
    oscType: 'sawtooth',
    startHz,
    endHz,
    lowpassHz: 220 + 180 * intensity,
    lowpassQ: 7,
    durationS: dur,
    peakGain,
    envelope,
  };
}

/**
 * Consumes drained PangEvents and renders each as one growl voice.
 * Built lazily by ensureAudioIntegrations() like the rest of the Wave B
 * audio pack; safe to feed an empty drain (no-op) and safe under a dead
 * context (per-voice failure islands).
 */
export class StomachAudio {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  /** True after stop(); consume() becomes a permanent no-op. */
  private stopped = false;
  private voicesStarted_ = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /** Total growl voices actually scheduled since construction. */
  get voicesStarted(): number {
    return this.voicesStarted_;
  }

  /**
   * Render one growl per pang event.
   * @returns how many voices were actually scheduled (0 after stop()).
   */
  consume(events: readonly PangEvent[]): number {
    if (this.stopped || events.length === 0) return 0;
    const t0 = this.ctx.currentTime;
    let rendered = 0;
    for (let i = 0; i < events.length; i++) {
      try {
        this.renderVoice(planGrowl(events[i], i), t0);
        rendered++;
        this.voicesStarted_++;
      } catch (err) {
        console.warn('[bmb] stomach growl failed', err);
      }
    }
    return rendered;
  }

  /** Silence everything; every later consume() is a no-op. */
  stop(): void {
    this.stopped = true;
  }

  /** Materialize one GrowlPlan as oscillator -> filter -> gain -> out. */
  private renderVoice(plan: GrowlPlan, at: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = plan.oscType;
    osc.frequency.setValueAtTime(plan.startHz, at);
    osc.frequency.linearRampToValueAtTime(plan.endHz, at + plan.durationS);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = plan.lowpassHz;
    filter.Q.value = plan.lowpassQ;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    let lastAt = -1;
    for (const p of plan.envelope) {
      if (p.atS <= lastAt) continue; // guard against degenerate ordering
      lastAt = p.atS;
      g.gain.linearRampToValueAtTime(p.gain * plan.peakGain, at + p.atS);
    }
    if (lastAt < plan.durationS) {
      g.gain.exponentialRampToValueAtTime(0.0001, at + plan.durationS);
    }

    osc.connect(filter);
    filter.connect(g);
    g.connect(this.out);
    osc.start(at);
    osc.stop(at + plan.durationS + 0.02);
  }
}
