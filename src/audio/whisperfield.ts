/**
 * Binaural whisper field for BACKROOMS: MEMORY BLEED.
 *
 * A handful of whisper voices are anchored to WORLD positions around the
 * player's start point and never move. Only the listener moves -- so what
 * the feature proves to the ear is that the room owns the voices:
 *
 *   ANCHORING  every voice sits at a seeded world offset inside
 *              FIELD_RADIUS metres (src/core/rng.ts, never Math.random);
 *              update() re-derives each voice's direction from the live
 *              listener pose, so turning 180 degrees swaps which ear leads.
 *   BINAURAL   each voice feeds a per-ear gain pair (left/right) merged
 *              into a 2-channel bus; the split comes from the pure
 *              panWeights() helper (interaural level difference), so the
 *              left/right dominance is deterministic and provable headless.
 *   POSITION   each voice also holds a PannerNode whose position params
 *              carry the world-relative offset (dx, 0, dz) every frame --
 *              on real hardware this adds HRTF colour (panningModel
 *              'HRTF') on top of the deterministic ear gains.
 *   FALLOFF    inverse-square attenuation via whisperAttenuation(), unity
 *              within WHISPER_REF_DIST, matching the PositionalHum ear.
 *
 * Fully procedural: one shared white-noise buffer through two parallel
 * vowel bandpass filters per voice, slowly undulating. No asset files.
 * Everything runs on an injected AudioContext-ish interface; a stub
 * context (test/whisperfield-test.mjs) proves pan inversion and
 * world-fixing at the graph level without real WebAudio.
 */

import { RNG } from '../core/rng';

/** Minimal scheduling surface of a Web Audio AudioParam. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

/** Minimal connectivity surface of a Web Audio node. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike, outputIndex?: number, inputIndex?: number): AudioNodeLike;
  disconnect(): unknown;
}

/** Minimal shape of the noise source material buffer. */
export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

/** Minimal buffer-source surface used for the looping whisper voice. */
export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  playbackRate: AudioParamLike;
  start(when?: number): unknown;
  stop(when?: number): unknown;
}

/** Minimal filter surface used for the vowel colouring. */
export interface BiquadFilterLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

/** Minimal gain surface used for voice/ear levels. */
export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

/** Minimal panner surface carrying the world-relative source position. */
export interface PannerLike extends AudioNodeLike {
  /** Real nodes set 'HRTF'; the field never depends on the value. */
  panningModel: string;
  positionX: AudioParamLike;
  positionY: AudioParamLike;
  positionZ: AudioParamLike;
}

/**
 * Structural slice of a Web Audio context the field needs. A real
 * AudioContext satisfies it; the headless test injects a stub.
 */
export interface WhisperContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createBufferSource(): BufferSourceLike;
  createBiquadFilter(): BiquadFilterLike;
  createGain(): GainNodeLike;
  createPanner(): PannerLike;
  createChannelMerger(numberOfInputs?: number): AudioNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
}

/** Listener pose on the floor plane; yaw follows the Babylon LH convention. */
export interface ListenerPose {
  x: number;
  z: number;
  /** Facing angle: forward = (-sin, -cos), right = (cos, -sin). */
  yaw: number;
}

/** Reads the current listener pose once per frame. */
export type PoseProvider = () => ListenerPose;

/** Number of world-fixed whisper voices (spec minimum is 4). */
export const VOICE_COUNT = 5;
/** Metres from the field origin where voices are scattered. */
export const FIELD_RADIUS = 13;
/** Distance attenuation reference: unity at/inside this radius. */
export const WHISPER_REF_DIST = 4;
/** Linear level of one voice at unity rolloff, pre ear-split. */
export const VOICE_LEVEL = 0.085;
/** Smoothing time constant for ear-gain motion, seconds. */
export const SMOOTH_TAU = 0.12;
/** Default seed for voice placement when none is injected. */
export const DEFAULT_FIELD_SEED = 0x57686973; // 'whis'

/** Rough vowel formant targets (Hz) that make filtered noise read as speech. */
const VOWELS: readonly { f1: number; f2: number }[] = [
  { f1: 700, f2: 1220 },
  { f1: 420, f2: 1800 },
  { f1: 310, f2: 2150 },
  { f1: 500, f2: 900 },
];

/**
 * Per-ear weights (0..1 each, summing to 1) for a source at world-relative
 * offset (dx, dz) heard under listener yaw. Positive bearing (source to the
 * listener's right) sends more weight to the right ear; a source dead ahead,
 * behind, or on the listener splits evenly -- the interaural ambiguity a
 * real head has too.
 *
 * @param yaw listener facing angle (forward = (-sin, -cos))
 * @param dx source minus listener, world X
 * @param dz source minus listener, world Z
 * @returns left/right linear ear weights in 0..1
 */
export function panWeights(yaw: number, dx: number, dz: number): { left: number; right: number } {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-6)) return { left: 0.5, right: 0.5 };
  const fwdComp = -(Math.sin(yaw) * dx + Math.cos(yaw) * dz);
  const rightComp = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
  const bearing = Math.atan2(rightComp, fwdComp);
  const s = Math.max(-1, Math.min(1, Math.sin(bearing)));
  return { left: 0.5 * (1 - s), right: 0.5 * (1 + s) };
}

/**
 * Inverse-square whisper loudness: unity at/inside WHISPER_REF_DIST,
 * falling with distance beyond, floored away from zero.
 *
 * @param dist straight-line distance listener -> voice, metres
 * @returns linear attenuation factor in (0, 1]
 */
export function whisperAttenuation(dist: number): number {
  const d = Math.max(Math.abs(dist), 0.001);
  if (d <= WHISPER_REF_DIST) return 1;
  const r = WHISPER_REF_DIST / d;
  return r * r;
}

interface FieldVoice {
  /** World anchor -- never changes after construction. */
  wx: number;
  wz: number;
  src: BufferSourceLike;
  filterHz: [number, number];
  voiceGain: GainNodeLike;
  panner: PannerLike;
  earL: GainNodeLike;
  earR: GainNodeLike;
  /** Undulation phase offset so voices never pulse in unison. */
  phase: number;
  /** Undulation speed multiplier, rad/s. */
  speed: number;
}

/** Diagnostic snapshot of one voice's current solved spatial state. */
export interface VoiceState {
  wx: number;
  wz: number;
  dist: number;
  left: number;
  right: number;
  level: number;
}

/** Construction options; everything except the context has a default. */
export interface WhisperFieldOptions {
  seed?: number;
  radius?: number;
  voiceCount?: number;
}

/**
 * World-fixed binaural whisper field. Construct once audio is unlocked,
 * then feed update(dt) every frame with the live pose provider. Voices
 * never move; the ears do.
 */
export class WhisperField {
  private readonly ctx: WhisperContext;
  private readonly pose: PoseProvider;
  private readonly voices: FieldVoice[] = [];
  private readonly rnd: RNG;
  private clock = 0;
  private stopped = false;
  private noiseBuf: AudioBufferLike | null = null;

  constructor(ctx: WhisperContext, pose: PoseProvider, options: WhisperFieldOptions = {}) {
    this.ctx = ctx;
    this.pose = pose;
    this.rnd = new RNG(options.seed ?? DEFAULT_FIELD_SEED);
    const radius = options.radius ?? FIELD_RADIUS;
    const count = Math.max(4, options.voiceCount ?? VOICE_COUNT);
    for (let i = 0; i < count; i++) {
      const ang = this.rnd.range(0, Math.PI * 2);
      const rad = this.rnd.range(0.35, 1) * radius;
      this.voices.push(
        this.buildVoice(i, Math.cos(ang) * rad, Math.sin(ang) * rad),
      );
    }
  }

  /**
   * Per-frame tick: re-solve every voice against the live listener pose --
   * world-relative panner position, ear split, distance attenuation, and
   * the slow undulation. Never throws.
   *
   * @param dt frame delta in seconds; non-positive values are ignored
   */
  update(dt: number): void {
    if (this.stopped || !(dt > 0)) return;
    this.clock += dt;
    const p = this.pose();
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        const dx = v.wx - p.x;
        const dz = v.wz - p.z;
        const dist = Math.hypot(dx, dz);
        // The panner holds the WORLD-relative offset: on real hardware the
        // HRTF model colours the voice from a fixed point in the room.
        v.panner.positionX.value = dx;
        v.panner.positionY.value = 0;
        v.panner.positionZ.value = dz;
        const w = panWeights(p.yaw, dx, dz);
        const undulation = 0.72 + 0.28 * Math.sin(this.clock * v.speed + v.phase);
        const level = VOICE_LEVEL * whisperAttenuation(dist) * undulation;
        v.earL.gain.setTargetAtTime(w.left * level, t, SMOOTH_TAU);
        v.earR.gain.setTargetAtTime(w.right * level, t, SMOOTH_TAU);
      } catch (e) {
        console.warn('[bmb] whisper voice update failed', e);
      }
    }
  }

  /**
   * Diagnostics/test snapshot: each voice's world anchor plus the exact
   * spatial solve from the most recent update().
   */
  voiceState(): VoiceState[] {
    const p = this.pose();
    return this.voices.map((v) => {
      const dist = Math.hypot(v.wx - p.x, v.wz - p.z);
      const w = panWeights(p.yaw, v.wx - p.x, v.wz - p.z);
      return {
        wx: v.wx,
        wz: v.wz,
        dist,
        left: w.left,
        right: w.right,
        level: VOICE_LEVEL * whisperAttenuation(dist),
      };
    });
  }

  /** World anchor of voice i (world-fixedness assertions). */
  voiceAnchor(i: number): { x: number; z: number } {
    const v = this.voices[i];
    return { x: v.wx, z: v.wz };
  }

  /** Smoothly silence every voice and stop the noise sources. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      const t = this.ctx.currentTime;
      for (const v of this.voices) {
        v.earL.gain.cancelScheduledValues(t);
        v.earR.gain.cancelScheduledValues(t);
        v.earL.gain.setTargetAtTime(0, t, 0.05);
        v.earR.gain.setTargetAtTime(0, t, 0.05);
        try { v.src.stop(); } catch { /* already ended */ }
      }
    } catch (e) {
      console.warn('[bmb] whisperfield stop failed', e);
    }
  }

  /**
   * One voice chain: looping noise -> two parallel vowel bandpasses ->
   * voice gain -> world-positioned panner -> per-ear gains -> 2-channel
   * merge into the destination bus.
   */
  private buildVoice(index: number, wx: number, wz: number): FieldVoice {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.sharedNoise();
    src.loop = true;
    // slight rate spread keeps the voices from phasing against each other
    src.playbackRate.value = 0.85 + this.rnd.next() * 0.3;

    const vowelA = VOWELS[Math.floor(this.rnd.next() * VOWELS.length)];
    let vowelB = VOWELS[Math.floor(this.rnd.next() * VOWELS.length)];
    if (vowelB === vowelA) vowelB = VOWELS[(VOWELS.indexOf(vowelA) + 2) % VOWELS.length];
    const filterHz: [number, number] = [vowelA.f1, vowelB.f2];
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 0;
    for (const hz of filterHz) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = 6 + this.rnd.next() * 4;
      src.connect(bp).connect(voiceGain);
    }

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    voiceGain.connect(panner);

    const earL = ctx.createGain();
    const earR = ctx.createGain();
    earL.gain.value = 0;
    earR.gain.value = 0;
    const merger = ctx.createChannelMerger(2);
    // the world-positioned HRTF panner drives both ear gains; the merge
    // pins each weighted copy to its own bus channel
    panner.connect(earL);
    panner.connect(earR);
    earL.connect(merger, 0, 0);
    earR.connect(merger, 0, 1);
    merger.connect(ctx.destination);

    src.start(ctx.currentTime + index * 0.07);
    return {
      wx,
      wz,
      src,
      filterHz,
      voiceGain,
      panner,
      earL,
      earR,
      phase: this.rnd.range(0, Math.PI * 2),
      speed: 0.5 + this.rnd.next() * 0.7,
    };
  }

  /** Shared white-noise source material; DSP fill exempt from sim PRNG law. */
  private sharedNoise(): AudioBufferLike {
    if (!this.noiseBuf) {
      const len = Math.max(1, Math.floor(this.ctx.sampleRate));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      // audio DSP buffer fill (white noise source) — sim PRNG law carve-out
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }
}
