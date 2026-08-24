/**
 * Chunk-boundary crossing cues for BACKROOMS: MEMORY BLEED.
 *
 * Stepping across a chunk seam should feel like the air itself changing,
 * not like an event horn. Fully procedural, no asset files:
 *
 *   WHOOSH    bandpass-filtered noise swept down 300 -> 100 Hz over
 *             250 ms at volume 0.02 — a breath of displaced air.
 *   ACCENTS   crossing INTO STORAGE adds a faint metallic ring overtone
 *             (hoarded metal settling), INTO HONEYCOMB a hollow tonal
 *             pulse (empty hexagonal cells answering back).
 *   PACING    never more than one cue per 4 s, and none at all while
 *             the director is in its peak phase — too much is already
 *             happening for a whisper of air to register.
 */

/** District.STORAGE ordinal in world/constants.ts (kept numeric so the
 *  const enum stays out of the runtime path). */
const DISTRICT_STORAGE = 4;
/** District.HONEYCOMB ordinal in world/constants.ts. */
const DISTRICT_HONEYCOMB = 2;

/** Minimum seconds between crossing cues. */
const COOLDOWN_SECONDS = 4;

export class BoundaryCue {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Seconds until another cue may fire; drained by update(). */
  private cooldown = 0;
  /** Director phase name from the most recent update(); 'peak' mutes everything. */
  private phase = 'calm';
  /** Shared white-noise buffer, built lazily on first cue. */
  private noiseBuf: AudioBuffer | null = null;

  // ---- test hooks ----
  private whooshCount = 0;
  private accentCount = 0;
  private lastAccentDistrict = -1;


  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Per-frame tick: drains the crossing cooldown and remembers the director
   * phase ('peak' mutes all cues).
   * @param dt seconds since the previous frame
   * @param phase director phase name, when known
   */
  update(dt: number, phase?: string): void {
    if (this.stopped) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (phase !== undefined) this.phase = phase;
  }

  /**
   * A chunk seam was just crossed INTO the given district.
   * @param district district ordinal from world/constants.ts
   */
  cross(district: number): void {
    if (this.stopped) return;
    if (this.phase === 'peak') return;      // too much is already happening
    if (this.cooldown > 0) return;          // never more than one per 4 s
    this.cooldown = COOLDOWN_SECONDS;

    try { this.playWhoosh(); } catch (err) { console.warn('[bmb] boundary whoosh failed', err); }
    if (district === DISTRICT_STORAGE) {
      try { this.playStorageAccent(); } catch (err) { console.warn('[bmb] boundary accent failed', err); }
    } else if (district === DISTRICT_HONEYCOMB) {
      try { this.playHoneycombAccent(); } catch (err) { console.warn('[bmb] boundary accent failed', err); }
    }
  }

  /** Silence everything; later crossings become no-ops. */
  stop(): void {
    this.stopped = true;
  }

  // ---------------------------------------------------------------------------

  /** Shared lazily-built one-second white-noise buffer. */
  private noise(): AudioBuffer {
    if (!this.noiseBuf) {
      const len = Math.floor(this.ctx.sampleRate);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      // audio DSP buffer fill — sim PRNG law carve-out
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuf;
  }

  /** Bandpass noise swept down 300 -> 100 Hz: a breath of displaced air. */
  private playWhoosh(): void {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(100, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.out);
    src.start(t);
    src.stop(t + 0.3);
    this.whooshCount++;
  }

  /** STORAGE entry: faint metallic ring overtone (hoarded metal settling). */
  private playStorageAccent(): void {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1730;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.008, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(g);
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + 1);
    this.accentCount++;
    this.lastAccentDistrict = DISTRICT_STORAGE;
  }

  /** HONEYCOMB entry: hollow tonal pulse (empty cells answering back). */
  private playHoneycombAccent(): void {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(210, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.35);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.012, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(g);
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.45);
    this.accentCount++;
    this.lastAccentDistrict = DISTRICT_HONEYCOMB;
  }
}
