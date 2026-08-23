/**
 * Lore discovery stingers for BACKROOMS: MEMORY BLEED.
 *
 * Short procedural Web Audio motifs that reward narrative interaction —
 * reading a note, completing a memory cluster, locking a beacon radio.
 * No asset files; every sting is built from oscillators and envelopes.
 *
 *   noteRead       : soft two-note sine motif, A4 -> C5, 200 ms each,
 *                    gentle swell/release envelope (~400 ms total)
 *   clusterComplete: resolved three-note A-minor phrase
 *                    A4 - C5 - E5 - A5, 180 ms notes with a slight
 *                    overlap so the resolution blooms instead of plodding
 *   radioLock      : warm triangle-wave glissando sweeping 300 -> 600 Hz
 *                    over 250 ms — clearly distinct from the radio's
 *                    existing tuning ping
 *
 * Stage darkening: the story stage (0-4) closes a per-sting lowpass
 * from 8 kHz down to 3 kHz, so late-game discoveries sound more
 * muffled and heavy — the world is literally closing in on the audio.
 */

/** Highest story stage accepted by the darkening curve. */
export const MAX_STAGE = 4;

const DARK_OPEN_HZ = 8000;   // stage 0 cutoff
const DARK_CLOSED_HZ = 3000; // stage 4 cutoff

/**
 * Lowpass cutoff for a story stage: stage 0-4 maps 8000 -> 3000 Hz,
 * clamped outside that range so weird saves still behave.
 */
export function stageCutoff(stage: number): number {
  const s = Math.max(0, Math.min(MAX_STAGE, stage));
  return DARK_OPEN_HZ + ((DARK_CLOSED_HZ - DARK_OPEN_HZ) * s) / MAX_STAGE;
}

/** One scheduled oscillator voice inside a sting. */
interface ToneSpec {
  readonly type: OscillatorType;
  /** frequency in Hz */


  readonly type: OscillatorType;
  /** frequency in Hz */
  readonly freq: number;
  /** start offset from the sting downbeat, seconds */
  readonly at: number;
  /** note length, seconds */
  readonly dur: number;
  /** envelope peak (linear gain) */
  readonly peak: number;
}

/** Shared voice specs for each motif (A4=440, C5=523.25, E5=659.25, A5=880). */
const NOTE_READ: readonly ToneSpec[] = [
  { type: 'sine', freq: 440.0, at: 0, dur: 0.2, peak: 0.06 },
  { type: 'sine', freq: 523.25, at: 0.18, dur: 0.22, peak: 0.05 },
];
const CLUSTER_COMPLETE: readonly ToneSpec[] = [
  { type: 'sine', freq: 440.0, at: 0, dur: 0.18, peak: 0.06 },
  { type: 'sine', freq: 523.25, at: 0.14, dur: 0.18, peak: 0.06 },
  { type: 'sine', freq: 659.25, at: 0.28, dur: 0.2, peak: 0.06 },
  { type: 'sine', freq: 880.0, at: 0.42, dur: 0.34, peak: 0.07 },
];

/**
 * Lore discovery stingers. One shared instance rides the audio bus; each
 * motif schedules its voices through a per-sting lowpass that closes as
 * the story stage rises (stageCutoff), so late-game discoveries sound
 * muffled and heavy.
 */
export class LoreStings {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Story stage for darkening; updated by setStage(). */
  private stage = 0;
  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Update the story stage used by the darkening curve.
   * @param stage story stage 0..MAX_STAGE
   */
  setStage(stage: number): void {
    this.stage = stage;
  }

  /** Soft two-note motif played when a note or document is read. */
  noteRead(stage = this.stage): void {
    this.render(NOTE_READ, stage);
  }

  /** Resolved A-minor phrase when a memory cluster completes. */
  clusterComplete(stage = this.stage): void {
    this.render(CLUSTER_COMPLETE, stage);
  }

  /** Warm triangle glissando when a beacon radio locks. */
  radioLock(stage = this.stage): void {
    if (this.stopped) return;
    try {
      const t = this.ctx.currentTime;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = stageCutoff(stage);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.25);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.out);
      osc.start(t);
      osc.stop(t + 0.32);
    } catch (err) {
      console.warn('[bmb] radio lock sting failed', err);
    }
  }

  /** Silence everything; later stings become no-ops. */
  stop(): void {
    this.stopped = true;
  }

  /** Schedule one motif through its darkened lowpass. */
  private render(specs: readonly ToneSpec[], stage: number): void {
    if (this.stopped) return;
    try {
      const t = this.ctx.currentTime;
      const cutoff = stageCutoff(stage);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      lp.connect(this.out);
      for (const s of specs) {
        const osc = this.ctx.createOscillator();
        osc.type = s.type;
        osc.frequency.value = s.freq;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t + s.at);
        g.gain.linearRampToValueAtTime(s.peak, t + s.at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + s.at + s.dur);
        osc.connect(g);
        g.connect(lp);
        osc.start(t + s.at);
        osc.stop(t + s.at + s.dur + 0.02);
      }
    } catch (err) {
      console.warn('[bmb] lore sting failed', err);
    }
  }
}
