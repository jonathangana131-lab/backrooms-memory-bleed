/**
 * Beacon radio chatter — procedural Web Audio, no asset files.
 *
 * A beacon emits faint looping voice-like babble when the player is
 * within 30m: a sawtooth glottal source through three bandpass
 * formant filters that drift between vowel targets, gated by an
 * amplitude envelope that mimics speech rhythm (syllables ~120-200ms
 * grouped into words, pauses between words and phrases). The result
 * is cadence without intelligibility — someone is talking, the words
 * are gone.
 *
 * Under the voice sits a quiet bandpass noise bed (the carrier), and
 * a per-beacon seed (hashed from its world position) picks base
 * pitch, formant scale and speech rate so every beacon sounds like a
 * different person on a different rig.
 *
 * Signal quality scales with distance:
 *   <10m  clear            (clarity 1)
 *   10-20m intermittent     (fading clarity + random dropouts)
 *   20-30m mostly static    (voice buried under carrier hiss)
 *   >30m silence
 *
 * NOTE: connects straight to ctx.destination because AudioEngine
 * keeps its master bus private; levels are kept low accordingly.
 *
 * Determinism: every non-DSP random draw (receiver pan, vibrato rate,
 * dropout scheduling) runs on mulberry32 streams — receiver-level draws
 * off a fixed seed, per-beacon draws off the beacon's position hash.
 * Math.random survives only in the static-carrier buffer fill.
 */

/** Deterministic PRNG so a beacon always sounds like itself. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position hash -> 32-bit seed (FNV-1a over the two float bit patterns). */
export function positionSeed(x: number, z: number): number {
  const xf = new Float64Array(1); xf[0] = x;
  const zf = new Float64Array(1); zf[0] = z;
  const bytes = new Uint8Array(xf.buffer.byteLength * 2);
  bytes.set(new Uint8Array(xf.buffer), 0);
  bytes.set(new Uint8Array(zf.buffer), 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Vowel { readonly f1: number; readonly f2: number; readonly f3: number }
// rough vowel formant targets (Hz): a, e, i, o, u
const VOWELS: readonly Vowel[] = [
  { f1: 800, f2: 1150, f3: 2800 },
  { f1: 450, f2: 1750, f3: 2550 },
  { f1: 300, f2: 2100, f3: 2900 },
  { f1: 420, f2: 800, f3: 2600 },
  { f1: 330, f2: 700, f3: 2400 },
];

const RANGE = 30;          // audible radius in metres
import type { AudioEngine } from './audio';

const CLEAR_UNDER = 10;    // full clarity below this distance
const FADE_END = 20;       // intermittent zone ends here

/** Seed for receiver-level draws made before the first beacon reseed. */
const RECEIVER_SEED = 0x21ade5;
/** Salt XORed into each beacon's position seed for its dropout stream. */
const DROPOUT_SALT = 0x44506f;

export class RadioChatter {
  private readonly audio: AudioEngine;
  private ctx: AudioContext | null = null;

  // ---- graph (all created in build(); public for tests) ----
  out: GainNode | null = null;           // master gate for the whole chatter
  qualityGain: GainNode | null = null;   // signal-quality gate on the voice
  voiceEnv: GainNode | null = null;      // syllable envelope automation target
  staticGain: GainNode | null = null;    // carrier noise bed level
  staticFilter: BiquadFilterNode | null = null;
  osc: OscillatorNode | null = null;     // glottal sawtooth source
  private formants: BiquadFilterNode[] = [];
  private vibrato: OscillatorNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;

  // ---- per-beacon identity ----
  private seedKey = '';
  /** Voice/speech stream; reseeded per beacon in reseedIfNeeded(). */
  private rnd: () => number = mulberry32(RECEIVER_SEED);
  /** Dropout-schedule stream, keyed per beacon off DROPOUT_SALT. */
  private dropRng: () => number = mulberry32((RECEIVER_SEED ^ DROPOUT_SALT) >>> 0);
  baseFreq = 110;       // seeded glottal pitch (Hz)
  formantScale = 1;     // seeded vocal-tract length bias
  rate = 1;             // seeded speech-rate multiplier

  // ---- runtime state ----
  private dist = Infinity;
  private quality = 0;              // current clarity 0..1
  private dropoutUntil = 0;         // ctx time until which the signal is lost
  private nextSyllableAt = 0;       // lookahead cursor for speech scheduling
  private tickId: ReturnType<typeof setInterval> | null = null;
  stopped = false;

  constructor(audio: AudioEngine) {
    this.audio = audio;
  }

  /**
   * Point the receiver at a beacon and the player's position. Safe to
   * call every frame: rebuilds nothing unless needed, retunes the
   * voice if the beacon changed, and eases gain targets each call.
   */
  setTarget(x: number, z: number, playerX: number, playerZ: number): void {
    if (this.stopped) return;
    const dx = x - playerX;
    const dz = z - playerZ;
    this.dist = Math.hypot(dx, dz);

    if (!this.ctx) {
      if (!this.audio.started || !this.audio.ctx) return; // engine not unlocked yet
      this.build();
    }
    this.reseedIfNeeded(x, z);
    this.applySignalQuality();
  }

  /** Stop everything and release nodes; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    if (this.tickId !== null) { clearInterval(this.tickId); this.tickId = null; }
    const ctx = this.ctx;
    const t = ctx ? ctx.currentTime : 0;
    try { this.out?.gain.setTargetAtTime(0.0001, t, 0.08); } catch { /* detached */ }
    try { this.osc?.stop(t + 0.5); } catch { /* already stopped */ }
    try { this.vibrato?.stop(t + 0.5); } catch { /* already stopped */ }
    try { this.noiseSrc?.stop(t + 0.5); } catch { /* already stopped */ }
    setTimeout(() => {
      for (const n of [this.osc, this.vibrato, this.noiseSrc, ...this.formants,
        this.voiceEnv, this.qualityGain, this.staticGain, this.out]) {
        try { n?.disconnect(); } catch { /* not connected */ }
      }
    }, 700);
    this.ctx = null;
    this.out = null;
    this.qualityGain = null;
    this.voiceEnv = null;
    this.staticGain = null;
    this.staticFilter = null;
    this.osc = null;
    this.vibrato = null;
    this.noiseSrc = null;
    this.formants = [];
  }

  // ------------------------------------------------------------------

  private build(): void {
    const ctx = this.audio.ctx!;
    this.ctx = ctx;

    const out = ctx.createGain();
    out.gain.value = 0;                       // fades in when in range
    const pan = ctx.createStereoPanner();     // static-ish placement per session
    pan.pan.value = this.rnd() * 0.9 - 0.45;
    out.connect(pan).connect(ctx.destination);

    // ---- voice chain: sawtooth -> parallel formants -> env -> quality -> out
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = this.baseFreq;
    const oscLevel = ctx.createGain();
    oscLevel.gain.value = 0.5;
    osc.connect(oscLevel);

    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.7 + this.rnd() * 1.4;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 7;                  // cents of pitch wobble
    vibrato.connect(vibDepth).connect(osc.detune);

    const voiceEnv = ctx.createGain();
    voiceEnv.gain.value = 0;
    const qualityGain = ctx.createGain();
    qualityGain.gain.value = 0;

    this.formants = [];
    const formantGains = [1, 0.55, 0.28];
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = VOWELS[0].f1;
      f.Q.value = [9, 11, 13][i];
      const fg = ctx.createGain();
      fg.gain.value = formantGains[i];
      oscLevel.connect(f).connect(fg).connect(voiceEnv);
      this.formants.push(f);
    }
    // a little raw source bleed so it reads as "through a speaker" not pure tone
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'bandpass';
    rasp.frequency.value = 1400;
    rasp.Q.value = 0.9;
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.05;
    oscLevel.connect(rasp).connect(raspGain).connect(voiceEnv);

    voiceEnv.connect(qualityGain).connect(out);

    // ---- static carrier bed: looped white noise through a bandpass
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // audio DSP buffer fill (static carrier noise) — sim PRNG law carve-out
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    const staticFilter = ctx.createBiquadFilter();
    staticFilter.type = 'bandpass';
    staticFilter.frequency.value = 1600;
    staticFilter.Q.value = 0.8;
    const staticGain = ctx.createGain();
    staticGain.gain.value = 0;
    noiseSrc.connect(staticFilter).connect(staticGain).connect(out);

    osc.start();
    vibrato.start();
    noiseSrc.start();

    this.out = out;
    this.osc = osc;
    this.vibrato = vibrato;
    this.voiceEnv = voiceEnv;
    this.qualityGain = qualityGain;
    this.noiseSrc = noiseSrc;
    this.staticFilter = staticFilter;
    this.staticGain = staticGain;

    this.nextSyllableAt = ctx.currentTime + 0.3;
    this.tickId = setInterval(() => this.tick(), 180);
  }

  /** Re-pick the voice identity whenever the tracked beacon changes. */
  private reseedIfNeeded(x: number, z: number): void {
    const key = `${Math.round(x)}:${Math.round(z)}`;
    if (key === this.seedKey) return;
    this.seedKey = key;
    const rnd = mulberry32(positionSeed(x, z));
    this.rnd = rnd;
    this.dropRng = mulberry32((positionSeed(x, z) ^ DROPOUT_SALT) >>> 0);
    this.baseFreq = 82 + rnd() * 58;          // 82-140 Hz: different speakers
    this.formantScale = 0.88 + rnd() * 0.26;  // vocal tract length
    this.rate = 0.85 + rnd() * 0.45;          // hurried .. drawling
    if (this.ctx && this.osc) {
      this.osc.frequency.setTargetAtTime(this.baseFreq, this.ctx.currentTime, 0.15);
    }
  }

  /**
   * Clarity curve + dropout scheduler. Runs ~5x/sec from the tick.
   * <10m clear; 10-20m fading with intermittent dropouts; 20-30m the
   * voice drowns and dropouts are near-constant.
   */
  private applySignalQuality(): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.qualityGain || !this.staticGain) return;
    const t = ctx.currentTime;
    const d = this.dist;

    let clarity: number;
    if (d < CLEAR_UNDER) {
      clarity = 1;
    } else if (d < FADE_END) {
      clarity = 1 - ((d - CLEAR_UNDER) / (FADE_END - CLEAR_UNDER)) * 0.65; // 1 -> 0.35
    } else if (d < RANGE) {
      clarity = Math.max(0.05, 0.35 - ((d - FADE_END) / (RANGE - FADE_END)) * 0.3);
    } else {
      clarity = 0;
    }

    // random dropouts only once outside the clear ring
    if (d >= CLEAR_UNDER && d < RANGE && t >= this.dropoutUntil) {
      const p = d < FADE_END ? 0.22 : 0.42;
      if (this.dropRng() < p) {
        const dur = 0.15 + this.dropRng() * (d < FADE_END ? 0.45 : 0.8);
        this.dropoutUntil = t + dur;
      }
    }
    if (t < this.dropoutUntil || d >= RANGE) clarity = Math.min(clarity, 0.02);

    this.quality += (clarity - this.quality) * 0.25;
    this.qualityGain.gain.setTargetAtTime(this.quality, t, 0.07);

    // carrier bed: quiet up close, dominant far away
    const prox = Math.max(0, Math.min(1, 1 - d / RANGE));
    const staticLevel = prox <= 0 ? 0 : 0.02 + 0.06 * (1 - prox);
    this.staticGain.gain.setTargetAtTime(staticLevel, t, 0.3);

    // whole-receiver gate
    this.out.gain.setTargetAtTime(d < RANGE ? 0.9 : 0, t, 0.5);
  }

  /** Lookahead scheduler: plans syllables/words ~1s ahead on the audio clock. */
  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.voiceEnv || !this.out) return;
    this.applySignalQuality();
    if (this.dist >= RANGE) {
      // keep the cursor pinned just ahead of now while silent
      this.nextSyllableAt = Math.max(this.nextSyllableAt, ctx.currentTime + 0.1);
      return;
    }
    this.scheduleSpeech(ctx.currentTime);
  }

  private scheduleSpeech(now: number): void {
    const env = this.voiceEnv!.gain;
    const horizon = now + 1.0;
    let t = Math.max(this.nextSyllableAt, now + 0.05);
    while (t < horizon) {
      // one "word": 1-4 syllables
      const syllables = 1 + Math.floor(this.rnd() * 4);
      for (let s = 0; s < syllables && t < horizon + 0.5; s++) {
        const dur = (0.11 + this.rnd() * 0.09) / this.rate;
        const peak = 0.16 + this.rnd() * 0.14;
        // vowel target for this syllable, biased by the beacon's tract
        const v = VOWELS[Math.floor(this.rnd() * VOWELS.length)];
        for (let i = 0; i < 3; i++) {
          const target = (i === 0 ? v.f1 : i === 1 ? v.f2 : v.f3) * this.formantScale;
          this.formants[i]?.frequency.setTargetAtTime(target, t, dur * 0.35);
        }
        // syllable envelope: quick attack, held, released
        env.setTargetAtTime(peak, t, 0.018);
        env.setTargetAtTime(peak * 0.35, t + dur * 0.55, 0.03);
        env.setTargetAtTime(0.0001, t + dur, 0.022);
        t += dur + (0.012 + this.rnd() * 0.03) / this.rate; // inter-syllable gap
      }
      // pause between words; occasionally a longer phrase break
      t += this.rnd() < 0.22
        ? 0.45 + (this.rnd() * 0.55) / this.rate
        : (0.08 + this.rnd() * 0.28) / this.rate;
    }
    this.nextSyllableAt = t;
  }
}


