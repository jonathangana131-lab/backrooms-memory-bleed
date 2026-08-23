
/**
 * Procedural ambient score. No asset files: three WebAudio layers that
 * evolve with game state —
 *
 *   1. DRONE    two detuned sawtooths through a lowpass; the base note is
 *               the memory-zone's own pentatonic root, so each zone kind
 *               lives in a different key.
 *   2. MELODY   sparse pentatonic sine plucks; interval shrinks as
 *               tension rises (calm 12-20 s, peak 4-6 s).
 *   3. TENSION  a dissonant minor-second cluster whose level follows
 *               director tension, dissolving back to silence when calm.
 *
 * Every layer change is a gain crossfade (~3 s settle) driven by
 * setTargetAtTime, so zone/tension switches never click.
 */
export class DynamicScore {
  private ctx: AudioContext;
  private out: GainNode;
  private drones = new Map<number, DroneLayer>();
  private activeZone = -1;
  private zoneKind = 1;
  private tension = 0;
  private melodyNextIn = 5;
  private cluster: ClusterLayer | null = null;
  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination);
  }

  /**
   * New game state: which memory zone the player is in (picks the key)
   * and how tense the director is (0..1). Zone switches crossfade the
   * drone bed over ~3 s; tension moves the cluster level and melody
   * pacing smoothly.
   */

(Showing lines 1-40 of 226. Use offset=41 to continue.)

  setState(zoneKind: number, tension: number): void {
    if (this.stopped || !this.ctx) return;
    this.zoneKind = Math.round(zoneKind);
    this.tension = Math.max(0, Math.min(1, tension));
    const t = this.ctx.currentTime;

    if (zoneKind !== this.activeZone) {
      this.activeZone = zoneKind;
      // build the new zone's drone lazily, then crossfade beds over ~3 s:
      // tau 1.0 s settles ~95% in 3 s; beds overlap, so no gap and no click
      if (!this.drones.has(this.activeZone)) this.buildDrone(this.activeZone);
      for (const [k, layer] of this.drones) {
        layer.gain.gain.setTargetAtTime(k === this.activeZone ? 0.06 : 0, t, 1.0);
      }
      // the tension cluster re-tunes to the new root (glided, not stepped)
      if (!this.cluster) this.buildCluster();
      this.retuneCluster(t);
    }

    // tension fades the cluster in/out; tau 1.2 keeps it swelling, never snapping
    this.cluster!.gain.gain.setTargetAtTime(this.tension * 0.035, t, 1.2);
  }

  /** Per-frame tick: schedules the sparse melodic fragments. */
  update(dt: number): void {
    if (this.stopped || !this.ctx) return;
    this.melodyNextIn -= dt;
    if (this.melodyNextIn <= 0) {
      // calm: every 12-20 s  ->  peak: every 4-6 s, scaled by tension
      const i = this.tension;
      const lo = 12 - 8 * i;
      const hi = 20 - 14 * i;
      this.melodyNextIn = lo + Math.random() * (hi - lo);
      this.pluck();
    }
  }

  /** Fade everything out and tear the graph down. Safe to call twice. */
  stop(): void {
    if (this.stopped || !this.ctx) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0.0001, t + 1.6);
    const dying: OscillatorNode[] = [];
    for (const layer of this.drones.values()) dying.push(...layer.oscs);
    if (this.cluster) dying.push(...this.cluster.oscs);
    for (const o of dying) {
      try { o.stop(t + 1.8); } catch { /* already stopped */ }
    }
    setTimeout(() => {
      try { this.out.disconnect(); } catch { /* already gone */ }
    }, 2100);
  }

  // ---- internals -------------------------------------------------------

  /** Two detuned sawtooths -> lowpass with a slow breathing sweep. */
  private buildDrone(kind: number): void {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.out);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.6;
    lp.connect(gain);

    // slow cutoff LFO so the drone breathes instead of sitting dead flat
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 90;
    lfo.connect(lfoG).connect(lp.frequency);
    lfo.start();

    const root = midiToFreq(rootMidiForZone(kind));
    const oscs: OscillatorNode[] = [lfo];
    for (const cents of [0, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = root;
      o.detune.value = cents;
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og).connect(lp);
      o.start();
      oscs.push(o);
    }
    this.drones.set(kind, { gain, oscs });
  }

  /** One sparse pentatonic pluck: sine with a fast attack, long tail. */
  private pluck(): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const root = rootMidiForZone(this.zoneKind);
    const degree = PENTA[Math.floor(Math.random() * PENTA.length)];
    const oct = Math.random() < 0.3 ? 36 : 24; // mostly +2 octaves, sometimes +3
    const freq = midiToFreq(root + degree + oct);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const vol = 0.04 + Math.random() * 0.02;
    const dur = 1.1 + Math.random() * 1.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    o.connect(g).connect(pan).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Dissonant cluster: a stack of minor seconds an octave above the root. */
  private buildCluster(): void {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.out);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.5;
    lp.connect(gain);

    const root = rootMidiForZone(this.zoneKind) + 12;
    const oscs: OscillatorNode[] = [];
    for (let semi = 0; semi < 3; semi++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToFreq(root + semi);
      const og = ctx.createGain();
      og.gain.value = 0.33;
      o.connect(og).connect(lp);
      o.start();
      oscs.push(o);
    }
    this.cluster = { gain, oscs };
  }

  /** Glide the cluster onto the new zone's root without stepping a frequency. */
  private retuneCluster(t: number): void {
    const root = rootMidiForZone(this.zoneKind) + 12;
    const oscs = this.cluster!.oscs;
    for (let i = 0; i < 3 && i < oscs.length; i++) {
      oscs[i].frequency.setTargetAtTime(midiToFreq(root + i), t, 0.8);
    }
  }
}

// ---- pitch helpers -----------------------------------------------------

/** A-minor pentatonic degrees: 0 3 5 7 10. */
const PENTA = [0, 3, 5, 7, 10];

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * Each memory-zone kind gets its own root drawn from the pentatonic set,
 * so neighbouring zones sit a pentatonic step apart (kinds >= 6 lift an
 * octave). Unknown kinds wrap deterministically.
 */
function rootMidiForZone(kind: number): number {
  const idx = (((kind - 1) % PENTA.length) + PENTA.length) % PENTA.length;
  return 33 + PENTA[idx] + (kind >= 6 ? 12 : 0);
}

interface DroneLayer {
  gain: GainNode;
  oscs: OscillatorNode[];
}

interface ClusterLayer {
  gain: GainNode;
  oscs: OscillatorNode[];
}



