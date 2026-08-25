/**
 * Synthesized audio engine. No asset files: everything generated
 * with WebAudio primitives (fluorescent hum, room tone, distant
 * building groans, footsteps).
 */
import { HEARING_GAIN_MUL_MAX } from '../player/adrenaline';

/** Smoothing time-constant (s) for adrenaline hearing-gain automation. */
export const HEARING_MUL_TAU_S = 0.25;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Total-mix bus gain for whole-mix automation (F6 dread-silence duck). Null before start(). */
  get masterBus(): GainNode | null {
    return this.master ?? null;
  }
  private reverb!: ConvolverNode;
  private reverbGain!: GainNode;
  private lmGains = new Map<string, GainNode>();
  private activeLandmark: string | null = null;
  private lmBuilt = false;
  private lmChapel?: GainNode;
  private lmLaundry?: GainNode;
  private lmArchive?: GainNode;
  private lmPlay?: GainNode;
  private nextPlinkIn = 4;
  private watchGains: GainNode[] = [];
  private watchBuilt = false;

  // ---- expansion: wall occlusion (lowpass on the ambient bed) ----
  private occlusion?: BiquadFilterNode;
  private occlusionLevel = 0;

  // ---- expansion: adrenaline hearing-gain bus (F75 consumer) ----
  /**
   * Dedicated ambience bus sitting between the wall-occlusion lowpass and
   * master; every muffled-bed voice flows through it. Its gain is the
   * ONLY place adrenaline's hearing boost is applied — master.gain is
   * owned by DreadSilence's whole-mix duck and must never carry this.
   */
  private ambience?: GainNode;
  /** Last level requested via setHearingMul (kept pre-unlock too). */
  private hearingMul = 1;

  // ---- expansion: district-dependent reverb response ----
  private district = -1;
  private spaceSize = 0.18;

  // ---- expansion: whisper spatialization ----
  private whisperPan: number | null = null;

  // ---- expansion: positional footstep echo ----
  private stepVerb?: ConvolverNode;
  private stepVerbWet?: GainNode;

  // ---- expansion: heartbeat system ----
  private hbIntensity = 0;
  private hbNext = 0;
  private watchProx = 0;
  private erosionStability = 1;

  /** Occlusion 0..1 -> lowpass cutoff Hz: open air 20 kHz, fully walled 800 Hz (log sweep). */
  private freqForOcclusion(level: number): number {
    return 20000 * Math.pow(800 / 20000, level);
  }

  /**
   * Wall occlusion from the game's raycast result: 0 = clear line to the
   * listener, 1 = fully behind a wall. Sweeps a lowpass over the ambient bed
   * from 20 kHz (open) down to 800 Hz (fully occluded), smoothed with
   * setTargetAtTime so walls sliding past never zipper.
   */
  setOcclusion(factor: number): void {
    const level = Math.max(0, Math.min(1, factor));
    this.occlusionLevel = level;
    if (!this.started || !this.ctx || !this.occlusion) return;
    this.occlusion.frequency.setTargetAtTime(this.freqForOcclusion(level), this.ctx.currentTime, 0.18);
  }

  /** Everything muffled by walls routes through this node (falls back to master pre-unlock). */
  private ambientOut(): AudioNode {
    return this.occlusion ?? this.master!;
  }

  /**
   * Adrenaline hearing boost (F75 consumer): multiplier in
   * [1, HEARING_GAIN_MUL_MAX] applied on the dedicated ambience bus that
   * sits between the occlusion lowpass and master. Clamped and NaN-safe;
   * smoothed with setTargetAtTime (tau HEARING_MUL_TAU_S) so dumps attack
   * fast but never zipper. Calls before unlock() only store the level —
   * unlock() seeds the bus gain from it. Never touches master.gain:
   * DreadSilence owns that param for whole-mix ducks.
   */
  setHearingMul(mul: number): void {
    const m = Number.isFinite(mul) ? Math.max(1, Math.min(HEARING_GAIN_MUL_MAX, mul)) : 1;
    this.hearingMul = m;
    if (!this.started || !this.ctx || !this.ambience) return;
    this.ambience.gain.setTargetAtTime(m, this.ctx.currentTime, HEARING_MUL_TAU_S);
  }

  /** Last level handed to setHearingMul (post-clamp; identity until then). */
  get hearingMulLevel(): number {
    return this.hearingMul;
  }

  /** The dedicated ambience (hearing-gain) bus; null before unlock(). */
  get ambienceBus(): GainNode | null {
    return this.ambience ?? null;
  }

  /** Inverse-square distance attenuation: unity within 5m, 1/d² beyond (0 past any finite range). */
  static rolloff(dist: number): number {
    const REF = 5;
    if (!(dist >= REF)) return Number.isNaN(dist) ? 0 : 1;
    const r = REF / dist;
    return r * r;
  }

  /** Feed the director erosion.stability here so the heart auto-triggers below 0.3. */
  setErosionStability(stability: number): void {
    this.erosionStability = Math.max(0, Math.min(1, stability));
  }

  /**
   * Heartbeat layer, intensity 0..1. Two low thumps (55Hz then 42Hz,
   * 140ms apart) repeating every ~0.8s at rest down to ~0.5s at full
   * intensity; volume scales with the intensity parameter.
   */
  setHeartbeat(intensity: number): void {
    if (!this.started || !this.ctx) return;
    this.hbIntensity = Math.max(0, Math.min(1, intensity));
  }

  /** Intensity for setHeartbeat from game state: unstable reality OR close watcher. */
  heartbeatFromState(stability: number, nearestWatcherDist: number): number {
    let i = 0;
    if (stability < 0.3) i = (0.3 - stability) / 0.3;
    if (isFinite(nearestWatcherDist) && nearestWatcherDist < 6) {
      i = Math.max(i, (6 - nearestWatcherDist) / 6);
    }
    return Math.min(1, i);
  }

  private heartThump(intensity: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const vol = 0.05 + 0.22 * intensity;
    for (const [off, freq] of [[0, 55], [0.14, 42]] as const) {
      const t = t0 + off;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol * (off ? 0.75 : 1), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.22);
    }
  }

  // ---- expansion: ARCHIVE radio static prop ----
  private radioBuilt = false;
  private radioGain?: GainNode;
  private radioFilter?: BiquadFilterNode;
  private radioProx = 0;
  private nextTuneIn = 10;

  /** Bandpass static at 1800Hz, random tuning sweeps every 8-15s. proximity 0..1 */
  setRadioStatic(proximity: number): void {
    if (!this.started || !this.ctx) return;
    this.radioProx = Math.max(0, Math.min(1, proximity));
    if (this.radioProx <= 0) {
      this.radioGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.8);
      return;
    }
    if (!this.radioBuilt) {
      const ctx = this.ctx;
      const g = ctx.createGain(); g.gain.value = 0;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass';
      f.frequency.value = 1800; f.Q.value = 1.6;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      this.radioGain = g;
      this.radioFilter = f;
      this.radioBuilt = true;
    }
    this.radioGain!.gain.setTargetAtTime(0.06 * this.radioProx, this.ctx.currentTime, 0.9);
  }

  private radioSweep(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const f = this.radioFilter!;
    f.frequency.cancelScheduledValues(t);
    f.frequency.setValueAtTime(f.frequency.value, t);
    f.frequency.linearRampToValueAtTime(700 + Math.random() * 3300, t + 0.9);
    const g = this.radioGain!;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0.11 * this.radioProx, t + 0.35);
    g.gain.linearRampToValueAtTime(0.06 * this.radioProx, t + 1.2);
  }
  private storageGain?: GainNode;
  activeDistrict = -1;
  private humGain!: GainNode;
  private humPanner!: StereoPannerNode;
  private toneGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private nextEventIn = 8;
  masterVolume = 0.8;
  started = false;

  unlock(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    try {
      const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6;
      this.master.connect(comp).connect(ctx.destination);

      // wall-occlusion lowpass sitting on the ambient bed (see setOcclusion),
      // followed by the adrenaline hearing-gain ambience bus (see setHearingMul)
      this.occlusion = ctx.createBiquadFilter();
      this.occlusion.type = 'lowpass';
      this.occlusion.frequency.value = this.freqForOcclusion(this.occlusionLevel);
      this.occlusion.Q.value = 0.4;
      this.ambience = ctx.createGain();
      this.ambience.gain.value = this.hearingMul;
      this.occlusion.connect(this.ambience).connect(this.master);

      // procedural reverb bus: exponentially decaying stereo impulse
      this.reverb = ctx.createConvolver();
      const irLen = Math.floor(ctx.sampleRate * 2.4);
      const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const dd = ir.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          dd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.8);
        }
      }
      this.reverb.buffer = ir;
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.0; // set by setSpaceSize
      this.reverb.connect(this.reverbGain).connect(this.master);

      // shared noise buffer (2s pink-ish)
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }

      // fluorescent hum: 120Hz + harmonics + buzz bandpass noise
      this.humGain = ctx.createGain();
      this.humGain.gain.value = 0.0;
      this.humPanner = ctx.createStereoPanner();
      this.humGain.connect(this.humPanner).connect(this.ambientOut());
      for (const [f, g] of [[120, 0.5], [240, 0.22], [360, 0.08], [480, 0.05]] as const) {
        const o = ctx.createOscillator();
        o.type = f === 120 ? 'sine' : 'triangle';
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g * 0.05;
        o.connect(og).connect(this.humGain);
        o.start();
      }
      const buzz = ctx.createBufferSource();
      buzz.buffer = this.noiseBuf; buzz.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 2.5;
      const bg = ctx.createGain(); bg.gain.value = 0.012;
      buzz.connect(bp).connect(bg).connect(this.humGain);
      buzz.start();

      // room tone: filtered brown noise, slow swell LFO
      this.toneGain = ctx.createGain();
      this.toneGain.gain.value = 0.05;
      this.toneGain.connect(this.ambientOut());
      const tone = ctx.createBufferSource();
      tone.buffer = this.noiseBuf; tone.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 260;
      tone.connect(lp).connect(this.toneGain);
      tone.start();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.025;
      lfo.connect(lfoG).connect(this.toneGain.gain);
      lfo.start();

      this.started = true;
    } catch (e) {
      console.warn('[audio] unavailable', e);
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.1);
  }

  private mirrorUntil = 0;

  /** For a while, something repeats your footsteps a half-beat behind. */
  startMirrorSteps(sec: number): void {
    this.mirrorUntil = performance.now() / 1000 + sec;
  }

  // ---- zone ambience: memory-kind specific beds, crossfaded ----
  private zoneLayers = new Map<number, GainNode>();
  private zoneBuilt = false;
  private activeZone = -1;
  private zoneEventIn = 6;

  private buildZoneLayer(kind: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.ambientOut());
    this.zoneLayers.set(kind, g);
    const noise = (): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start();
      return s;
    };
    if (kind === 3) {
      // HOSPITAL: bright filtered bed + slow monitor beeps
      const n = noise();
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800;
      const ng = ctx.createGain(); ng.gain.value = 0.14;
      n.connect(f).connect(ng).connect(g);
      const beep = ctx.createOscillator(); beep.type = 'sine'; beep.frequency.value = 880;
      const bg = ctx.createGain(); bg.gain.value = 0;
      beep.connect(bg).connect(g); beep.start();
      setInterval(() => {
        if (!this.ctx) return;
        const tt = this.ctx.currentTime;
        bg.gain.cancelScheduledValues(tt);
        bg.gain.setValueAtTime(0.0001, tt);
        bg.gain.linearRampToValueAtTime(0.012, tt + 0.04);
        bg.gain.linearRampToValueAtTime(0.0001, tt + 0.22);
      }, 1700);
    } else if (kind === 5) {
      // MALL: wide murmur
      const n = noise();
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 300; f.Q.value = 0.8;
      n.connect(f).connect(g);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lg = ctx.createGain(); lg.gain.value = 0.012;
      lfo.connect(lg).connect(g.gain); lfo.start();
    } else if (kind === 6) {
      // TRANSIT: deep rumble
      const n = noise();
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 85;
      const ng = ctx.createGain(); ng.gain.value = 0.5;
      n.connect(f).connect(ng).connect(g);
    } else if (kind === 2) {
      // OFFICE: faint tick clusters handled in update; thin tonal bed here
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 62;
      const og = ctx.createGain(); og.gain.value = 0.006;
      o.connect(og).connect(g); o.start();
    } else if (kind === 4) {
      // SCHOOL: hollow hallway resonance
      const n = noise();
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 3;
      const ng = ctx.createGain(); ng.gain.value = 0.10;
      n.connect(f).connect(ng).connect(g);
    } else {
      // RESIDENCE/PERSONAL: warm low bed
      const n = noise();
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 140;
      const ng = ctx.createGain(); ng.gain.value = 0.16;
      n.connect(f).connect(ng).connect(g);
    }
  }

  /** 0..1 — how much of the wet reverb bus feeds the master (bigger room = more). */
  setSpaceSize(v: number): void {
    this.spaceSize = Math.max(0, Math.min(0.6, v));
    this.reapplySpaceSize();
  }

  /**
   * District bias on the reverb bus: STORAGE canyons of hoarded metal ring
   * with a hard metallic echo; OPEN_OFFICE carpet and cubicle foam deaden
   * the tail. District values match world/constants District enum
   * (OPEN_OFFICE = 1, STORAGE = 4); anything else is neutral.
   */
  setDistrict(district: number): void {
    if (district === this.district) return;
    this.district = district;
    this.reapplySpaceSize();
  }

  private districtVerbMul(): number {
    if (this.district === 4) return 1.7;  // STORAGE: metallic echo
    if (this.district === 1) return 0.45; // OPEN_OFFICE: deadened
    return 1;
  }

  private reapplySpaceSize(): void {
    if (!this.started || !this.ctx) return;
    const target = Math.max(0, Math.min(0.6, this.spaceSize * this.districtVerbMul()));
    this.reverbGain.gain.setTargetAtTime(target, this.ctx.currentTime, 1.2);
  }

  /** Route a one-shot node partially into the reverb bus. */
  private sendWet(node: AudioNode, wet: number): void {
    if (!this.ctx || !this.reverb) return;
    const g = this.ctx.createGain();
    g.gain.value = wet;
    node.connect(g).connect(this.reverb);
  }

  /** Crossfade memory-zone ambience. Call whenever the player's zone changes. */
  setZoneAmbient(kind: number): void {
    if (!this.started || !this.ctx || kind === this.activeZone) return;
    const prev = this.activeZone;
    if (!this.zoneBuilt) {
      for (const k of [1, 2, 3, 4, 5, 6, 7]) this.buildZoneLayer(k);
      this.zoneBuilt = true;
    }
    this.activeZone = kind;
    const t = this.ctx.currentTime;
    for (const [k, gn] of this.zoneLayers) {
      gn.gain.setTargetAtTime(k === kind ? 0.035 : 0, t, 0.9);
    }
    // crossed between memory zones: the air changed
    if (prev !== -1 && prev !== kind) this.setZoneTransition();
  }

  /**
   * Zone-transition sting: bandpass-filtered noise sweeping upward
   * 400 -> 2000 Hz over 200ms — the sound of a memory-zone boundary
   * being crossed.
   */
  playZoneTransition(): void {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2000, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.23);
    src.connect(f).connect(g).connect(this.master);
    this.sendWet(g, 0.35);
    src.start(t);
    src.stop(t + 0.25);
  }

  /** 200ms filtered noise sweep — a memory-zone boundary was just crossed. */
  setZoneTransition(): void {
    this.playZoneTransition();
  }

  private zoneTick(kind: number): void {
    if (!this.ctx || !this.started) return;
    this.zoneEventIn -= 1 / 60;
    if (this.zoneEventIn > 0) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (kind === 2 && Math.random() < 0.5) {
      // office keyboard cluster
      for (let i = 0; i < 5 + Math.floor(Math.random() * 6); i++) {
        const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass';
        f.frequency.value = 2400 + Math.random() * 1800; f.Q.value = 6;
        const g = ctx.createGain();
        const at = t + i * (0.09 + Math.random() * 0.08);
        g.gain.setValueAtTime(0.02, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
        src.connect(f).connect(g).connect(this.master);
        src.start(at, Math.random(), 0.06);
      }
      this.zoneEventIn = 4 + Math.random() * 6;
    } else if (kind === 4 && Math.random() < 0.45) {
      // school metallic clatter
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass';
      f.frequency.value = 3200 + Math.random() * 1500; f.Q.value = 9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.028, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      const p = ctx.createStereoPanner(); p.pan.value = Math.random() * 1.4 - 0.7;
      src.connect(f).connect(g).connect(p).connect(this.master);
      src.start(t, Math.random(), 0.3);
      this.zoneEventIn = 5 + Math.random() * 9;
    } else if (kind === 6 && Math.random() < 0.35) {
      // transit rail screech sweep
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(1900, t);
      o.frequency.linearRampToValueAtTime(2600, t + 1.4);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 12;
      f.frequency.setValueAtTime(2000, t);
      f.frequency.linearRampToValueAtTime(2800, t + 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.006, t + 0.5);
      g.gain.linearRampToValueAtTime(0.0001, t + 1.5);
      o.connect(f).connect(g).connect(this.master);
      o.start(t); o.stop(t + 1.6);
      this.zoneEventIn = 18 + Math.random() * 20;
    } else {
      this.zoneEventIn = 3 + Math.random() * 5;
    }
  }

  /** per-landmark ambient layer: each named room sounds different */
  setLandmarkAmbient(name: string | null): void {
    if (!this.started || !this.ctx) return;
    if (name === this.activeLandmark) return;
    this.activeLandmark = name;
    const ctx = this.ctx;
    if (!this.lmBuilt) {
      this.lmBuilt = true;
      // CHAPEL: slow choir-like detuned sines
      const chapel = ctx.createGain(); chapel.gain.value = 0; chapel.connect(this.ambientOut());
      for (const [f, d] of [[196.0, 0], [196.7, 3], [246.9, -2]] as const) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.detune.value = d * 4;
        const og = ctx.createGain(); og.gain.value = 0.25;
        o.connect(og).connect(chapel); o.start();
      }
      this.lmChapel = chapel;
      // LAUNDRY: rhythmic mechanical thump loop via noise envelope LFO
      const laundry = ctx.createGain(); laundry.gain.value = 0; laundry.connect(this.ambientOut());
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140; lp.Q.value = 5;
      const ng = ctx.createGain(); ng.gain.value = 0.5;
      n.connect(lp).connect(ng).connect(laundry);
      n.start();
      // thump LFO: square osc through gain into the layer's gain AudioParam
      const pulse = ctx.createOscillator(); pulse.type = 'square'; pulse.frequency.value = 1.1;
      const pg = ctx.createGain(); pg.gain.value = 0.25;
      laundry.gain.value = 0.5;
      pulse.connect(pg); pg.connect(laundry.gain);
      pulse.start();
      this.lmLaundry = laundry;
      // ARCHIVE: paper rustle bed (highpass shimmer)
      const archive = ctx.createGain(); archive.gain.value = 0; archive.connect(this.ambientOut());
      const an = ctx.createBufferSource(); an.buffer = this.noiseBuf; an.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4200;
      const ag = ctx.createGain(); ag.gain.value = 0.06;
      an.connect(hp).connect(ag).connect(archive); an.start();
      this.lmArchive = archive;
      // PLAYROOM: music-box style high plinks on a slow schedule handled in update
      const play = ctx.createGain(); play.gain.value = 0; play.connect(this.ambientOut());
      this.lmPlay = play;
    }
    const t = ctx.currentTime;
    const fade = (g2: GainNode | undefined, on: boolean) => {
      g2?.gain.setTargetAtTime(on ? 0.05 : 0, t, 1.1);
    };
    fade(this.lmChapel, name === 'CHAPEL');
    fade(this.lmLaundry, name === 'LAUNDRY');
    fade(this.lmArchive, name === 'ARCHIVE');
    fade(this.lmPlay, name === 'PLAYROOM');
    // radio static prop lives near/in ARCHIVE rooms
    this.setRadioStatic(name === 'ARCHIVE' ? 1 : 0);
  }

  /** STORAGE district bed: industrial low drone + slow mechanical pulse */
  setStorageAmbient(on: boolean): void {
    if (!this.started || !this.ctx) return;
    if (on && !this.storageGain) {
      const ctx = this.ctx;
      const g2 = ctx.createGain(); g2.gain.value = 0; g2.connect(this.ambientOut());
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 95; lp.Q.value = 2;
      n.connect(lp).connect(g2); n.start();
      // slow mechanical pulse via LFO on filter frequency
      const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.4;
      const lg2 = ctx.createGain(); lg2.gain.value = 30;
      lfo.connect(lg2); lg2.connect(lp.frequency); lfo.start();
      this.storageGain = g2;
    }
    if (this.storageGain) {
      this.storageGain.gain.setTargetAtTime(on ? 0.05 : 0, this.ctx.currentTime, 1.3);
    }
  }

  /** dissonant beating pair that swells when a watcher is near */
  setWatchProximity(v: number): void {
    if (!this.started || !this.ctx) return;
    this.watchProx = Math.max(0, Math.min(1, v));
    if (!this.watchBuilt) {
      this.watchBuilt = true;
      for (const f of [109.5, 110.3]) {
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const g2 = this.ctx.createGain();
        g2.gain.value = 0;
        o.connect(g2).connect(this.master);
        o.start();
        this.watchGains.push(g2);
      }
    }
    const t = this.ctx.currentTime;
    const target = Math.max(0, Math.min(1, v)) * 0.045;
    for (const g2 of this.watchGains) g2.gain.setTargetAtTime(target, t, 1.4);
  }

  /** proximity + direction of nearest lit fixture drive the hum */
  update(dt: number, fixtureDist: number, pan = 0): void {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;
    // inverse-square falloff beyond 5m instead of linear-with-cutoff
    const prox = AudioEngine.rolloff(fixtureDist);
    this.humGain.gain.setTargetAtTime(prox, t, 0.25);
    this.humPanner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.2);
    if (this.activeZone >= 0) this.zoneTick(this.activeZone);

    // heartbeat: unstable reality OR a watcher/double within 6m
    const hbEff = Math.max(
      this.hbIntensity,
      this.watchProx > 0.5 ? (this.watchProx - 0.5) * 2 : 0,
      this.erosionStability < 0.3 ? (0.3 - this.erosionStability) / 0.3 : 0
    );
    if (hbEff > 0.02) {
      const nowS = performance.now() / 1000;
      if (nowS >= this.hbNext) {
        this.hbNext = nowS + 0.8 - 0.3 * hbEff; // 0.8s -> 0.5s cycle
        this.heartThump(hbEff);
      }
    } else {
      this.hbNext = 0;
    }

    // radio static tuning sweeps while near an ARCHIVE
    if (this.radioBuilt && this.radioProx > 0) {
      this.nextTuneIn -= dt;
      if (this.nextTuneIn <= 0) {
        this.nextTuneIn = 8 + Math.random() * 7;
        this.radioSweep();
      }
    }

    // PLAYROOM music-box plinks
    if (this.activeLandmark === 'PLAYROOM' && this.started) {
      this.nextPlinkIn -= dt;
      if (this.nextPlinkIn <= 0) {
        this.nextPlinkIn = 1.6 + Math.random() * 2.8;
        if (this.ctx && this.lmPlay) {
          const tt = this.ctx.currentTime;
          const o = this.ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = [1046.5, 1318.5, 1568, 2093][Math.floor(Math.random() * 4)];
          const g2 = this.ctx.createGain();
          g2.gain.setValueAtTime(0.02, tt);
          g2.gain.exponentialRampToValueAtTime(0.0001, tt + 1.1);
          o.connect(g2).connect(this.lmPlay);
          o.start(tt); o.stop(tt + 1.2);
        }
      }
    }

    // scheduled distant events
    this.nextEventIn -= dt;
    if (this.nextEventIn <= 0) {
      this.nextEventIn = 18 + Math.random() * 42;
      this.distantEvent();
    }
  }

  private panNode(): StereoPannerNode {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    p.connect(this.master);
    return p;
  }

  private distantEvent(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const kind = Math.floor(Math.random() * 3);
    const out = this.panNode();
    if (kind === 0) {
      // deep thump
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(58, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.24, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 1);
    } else if (kind === 1) {
      // metallic groan
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.8);
      g.gain.linearRampToValueAtTime(0.0001, t + 2.6);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 9;
      f.frequency.setValueAtTime(140 + Math.random() * 120, t);
      f.frequency.linearRampToValueAtTime(90 + Math.random() * 60, t + 2.4);
      for (const det of [0, 3, -4]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 62 + det;
        o.connect(f);
        o.start(t); o.stop(t + 2.7);
      }
      f.connect(g).connect(out);
    } else if (kind === 3) {
      // distant door slam: low thump + metal ring
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(75, t);
      o.frequency.exponentialRampToValueAtTime(35, t + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.09, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.4);
      const ring = ctx.createOscillator(); ring.type = 'triangle'; ring.frequency.value = 620;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.008, t + 0.02);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      ring.connect(rg).connect(this.master);
      ring.start(t + 0.02); ring.stop(t + 1);
    } else {
      // dragging/rustle
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 500; f.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.4);
      g.gain.linearRampToValueAtTime(0.0001, t + 1.6);
      src.connect(f).connect(g).connect(out);
      src.start(t); src.stop(t + 1.7);
    }
  }

  footstep(running: boolean, volMul = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = running ? 700 : 520;
    const g = ctx.createGain();
    const vol = (running ? 0.16 : 0.10) * (0.85 + Math.random() * 0.3) * volMul;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, 0.2);
    // positional echo: dedicated convolver tail while inside a landmark room
    if (this.activeLandmark) {
      if (!this.stepVerb) {
        const irLen = Math.floor(ctx.sampleRate * 1.6);
        const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const dd = ir.getChannelData(ch);
          for (let i = 0; i < irLen; i++) {
            dd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 1.9);
          }
        }
        const cv = ctx.createConvolver();
        cv.buffer = ir;
        const wet = ctx.createGain();
        wet.gain.value = 0;
        cv.connect(wet).connect(this.master);
        this.stepVerb = cv;
        this.stepVerbWet = wet;
      }
      g.connect(this.stepVerb);
      this.stepVerbWet!.gain.setTargetAtTime(0.55, t, 0.4);
    } else if (this.stepVerbWet) {
      this.stepVerbWet.gain.setTargetAtTime(0, t, 1.5);
    }
    // the mirror: a softer copy a half-beat late, from the other side
    if (t < this.mirrorUntil) {
      const src2 = ctx.createBufferSource();
      src2.buffer = this.noiseBuf;
      src2.playbackRate.value = 0.75 + Math.random() * 0.25;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'lowpass';
      f2.frequency.value = 420;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(vol * 0.45, t + 0.19);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      const p2 = ctx.createStereoPanner();
      p2.pan.value = Math.random() < 0.5 ? -0.9 : 0.9;
      src2.connect(f2).connect(g2).connect(p2).connect(this.master);
      src2.start(t + 0.19, Math.random() * 1.5, 0.2);
    }
  }

  /**
   * Stereo placement for subsequent whispers: -1 hard left .. 1 hard right.
   * Pass the horizontal direction to the whisper's source. Until set,
   * whispers keep their old random placement.
   */
  setWhisperPan(pan: number): void {
    this.whisperPan = Math.max(-1, Math.min(1, pan));
  }

  /**
   * One duplicated footstep at a fixed stereo pan, scheduled delaySec after
   * the call (the anomaly system's mirror-steps phenomenon uses 0.4 s).
   * Deliberately not routed through the step-verb send: the double walks on
   * carpet that has never been inside any room.
   */
  echoFootstep(pan: number, delaySec: number, volMul = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.max(0, delaySec);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.72 + Math.random() * 0.2; // DSP texture only; sim determinism unaffected
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.085 * volMul, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 1.5, 0.2);
  }

  /** close, breathy whisper swell */
  whisper(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(1100 + Math.random() * 700, t);
    f.frequency.linearRampToValueAtTime(700 + Math.random() * 400, t + 1.8);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // syllable-ish amplitude wobble
    for (let i = 0; i < 7; i++) {
      g.gain.linearRampToValueAtTime(0.02 + Math.random() * 0.03, t + 0.15 + i * 0.24);
      g.gain.linearRampToValueAtTime(0.004, t + 0.32 + i * 0.24);
    }
    g.gain.linearRampToValueAtTime(0.0001, t + 2.1);
    const p = ctx.createStereoPanner();
    p.pan.value = this.whisperPan ?? (Math.random() * 2 - 1);
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t);
    src.stop(t + 2.2);
  }

  /** soft threshold scuff passing through a doorway */
  doorway(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 260; f.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(f).connect(g).connect(this.master);
    this.sendWet(g, 0.5);
    src.start(t, Math.random(), 0.4);
  }

  private beaconNext = 0;

  /** distant beacon pulse: audible when its transmitter is within ~40m */
  beaconUpdate(dist: number, pan: number): void {
    if (!this.ctx || !this.started) return;
    if (dist > 40) { this.beaconNext = 0; return; }
    const now = performance.now() / 1000;
    if (now < this.beaconNext) return;
    this.beaconNext = now + 2.4;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 620;
    const g = this.ctx.createGain();
    const vol = 0.03 * Math.max(0.08, AudioEngine.rolloff(dist));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g).connect(p).connect(this.master);
    o.start(t); o.stop(t + 0.55);
  }

  /** brief high-pitched sting when a watcher is caught in the torch beam */
  beamFreezeSting(): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // two detuned high sines with fast decay — "something noticed you"
    for (const f of [2093, 2093.7]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.015, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.9);
    }
  }

  /** warm three-note chord when a landmark room is first entered */
  landmarkChord(): void {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // A minor add9 spread wide — familiar but wrong
    const notes = [220, 261.6, 329.6, 493.9];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.02, t + 0.6 + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5 - i * 0.4);
      o.connect(g).connect(this.master);
      this.sendWet(g, 0.55);
      o.start(t); o.stop(t + 4.6);
    });
  }

  /** sharp electrical crack when a light dies nearby */
  lightCrack(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.panNode();
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.20, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random(), 0.2);
  }
}


