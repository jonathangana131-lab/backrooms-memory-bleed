/**
 * Per-fixture positional hum for BACKROOMS: MEMORY BLEED.
 *
 * Instead of one global fluorescent bed, the nearest three ceiling
 * fixtures each get their own quiet oscillator voice:
 *
 *   VOICES     up to three persistent 120 Hz voices (plus soft 240/360 Hz
 *               harmonics), one per fixture, slightly detuned per voice so
 *               neighbouring fixtures beat gently instead of phasing flat.
 *   PLACEMENT  each voice runs through a StereoPannerNode driven by the
 *               fixture's bearing relative to the player's facing
 *               (Babylon left-handed yaw: forward = (-sin, -cos)).
 *   FALLOFF    inverse-square attenuation, unity within REF_DIST metres;
 *               when the voices would stack louder than -12 dB combined,
 *               every voice is scaled down proportionally so standing in
 *               a tight cluster of fixtures never sums into a blast.
 *   MOTION     pan and gain glide with setTargetAtTime tau 0.1 s, so
 *               walking past a fixture sweeps the hum across the head
 *               smoothly instead of zipper-stepping.
 */

/** World-space fixture anchor (ceiling light position on the floor plane). */
export interface FixturePos {
  x: number;
  z: number;
}

/** Maximum simultaneous fixture voices (the nearest N fixtures sound). */
export const MAX_VOICES = 3;
/** Metres at which (and below which) a voice plays at full level. */
export const REF_DIST = 5;
/** Linear amplitude of one voice at unity rolloff. */
export const VOICE_LEVEL = 0.12;
/** Smoothing time constant for pan/gain motion, seconds. */
export const SMOOTH_TAU = 0.1;
/** Combined loudness ceiling across all voices: -12 dB, linear. */
export const COMBINED_CAP_LINEAR = Math.pow(10, -12 / 20);

/**
 * Inverse-square distance attenuation: unity within REF_DIST, 1/dist^2
 * beyond, matching AudioEngine.rolloff so every source shares one ear.
 */
export function humRolloff(dist: number): number {
  if (!(dist >= REF_DIST)) return Number.isNaN(dist) ? 0 : 1;
  const r = REF_DIST / dist;
  return r * r;
}

/** Stereo pan (-1 hard left .. 1 hard right) for a bearing angle. */
export function panForBearing(bearing: number): number {
  return Math.max(-1, Math.min(1, Math.sin(bearing)));
}

interface HumVoice {
  gain: GainNode;
  panner: StereoPannerNode;
  sources: OscillatorNode[];
}

/**
 * Spatialized per-fixture fluorescent hum. Feed it the fixture list once
 * (setFixtures), then tick it every frame with the player pose (update).
 */
export class PositionalHum {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly voices: HumVoice[] = [];
  private fixtures: FixturePos[] = [];
  private stopped = false;

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.out = destination ?? ctx.destination;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(this.buildVoice(i));
  }

  /** One voice chain: detuned oscillator stack -> gain -> stereo panner -> out. */
  private buildVoice(index: number): HumVoice {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;
    gain.connect(panner).connect(this.out);

    // Per-voice detune spreads identical fixtures apart in phase so two
    // voices near each other produce a slow beat, not cancellation.
    const detune = (index - 1) * 1.7;
    const sources: OscillatorNode[] = [];
    for (const [freq, amt, type] of [
      [120, 1, 'sine'],
      [240, 0.32, 'triangle'],
      [360, 0.12, 'sine'],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const og = ctx.createGain();
      og.gain.value = amt / 1.44; // normalizes stack to roughly unity
      o.connect(og).connect(gain);
      o.start();
      sources.push(o);
    }
    return { gain, panner, sources };
  }

  /** Replace the fixture set; voices re-target on the next update(). */
  setFixtures(fixtures: FixturePos[]): void {
    this.fixtures = fixtures.filter(
      (f) => Number.isFinite(f.x) && Number.isFinite(f.z),
    );
  }

  /**
   * Per-frame tick: retarget the three voices onto the nearest fixtures
   * and glide their pan/gain toward the pose-relative values.
   */
  update(px: number, pz: number, pyaw: number): void {
    if (this.stopped || !this.ctx) return;
    const t = this.ctx.currentTime;
    const sinYaw = Math.sin(pyaw);
    const cosYaw = Math.cos(pyaw);

    // Nearest-first ordering; squared distances avoid needless sqrts.
    const order = this.fixtures
      .map((f, idx) => ({ idx, d2: (f.x - px) ** 2 + (f.z - pz) ** 2 }))
      .sort((a, b) => a.d2 - b.d2);

    const targets: number[] = [];
    for (let v = 0; v < this.voices.length; v++) {
      const voice = this.voices[v];
      const pick = order[v];
      if (!pick) {
        targets.push(0);
        continue;
      }
      const f = this.fixtures[pick.idx];
      const dx = f.x - px;
      const dz = f.z - pz;
      // Babylon left-handed yaw basis: forward = (-sin, -cos),
      // right = (cos, -sin). Bearing is measured from straight ahead.
      const fwdComp = -(sinYaw * dx + cosYaw * dz);
      const rightComp = cosYaw * dx - sinYaw * dz;
      const bearing = Math.atan2(rightComp, fwdComp);
      voice.panner.pan.setTargetAtTime(panForBearing(bearing), t, SMOOTH_TAU);
      targets.push(VOICE_LEVEL * humRolloff(Math.sqrt(pick.d2)));
    }

    // Loudness-stacking guard: if the linear gains would sum past the
    // combined -12 dB ceiling, scale every voice down proportionally so
    // the mix keeps its balance but never the stacked blast.
    let sum = 0;
    for (const g of targets) sum += g;
    const scale =
      sum > COMBINED_CAP_LINEAR ? COMBINED_CAP_LINEAR / sum : 1;
    for (let v = 0; v < this.voices.length; v++) {
      this.voices[v].gain.gain.setTargetAtTime(targets[v] * scale, t, SMOOTH_TAU);
    }
  }

  /** Diagnostics/test snapshot of the currently smoothed voice state. */
  voiceState(): { pan: number; gain: number }[] {
    return this.voices.map((v) => ({
      pan: v.panner.pan.value,
      gain: v.gain.gain.value,
    }));
  }

  /** Smoothly silence every voice and release the oscillators. */
  stop(): void {
    if (this.stopped || !this.ctx) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setTargetAtTime(0, t, 0.05);
    }
    window.setTimeout(() => {
      for (const voice of this.voices) {
        for (const src of voice.sources) {
          try { src.stop(); } catch { /* already ended */ }
        }
      }
    }, 400);
  }
}


