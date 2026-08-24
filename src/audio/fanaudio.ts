/**
 * Ceiling fan audio — blade whoosh pulses, motor hum, wobble creaks.
 * Fully procedural Web Audio following doors.ts conventions.
 */

export class FanAudio {
  private ctx: AudioContext;
  private destination: AudioNode;
  private noiseBuf: AudioBuffer;
  private motorOsc: OscillatorNode | null = null;
  private motorGain: GainNode | null = null;
  private whooshTimer = 0;
  private revsPerSec = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
    // shared noise buffer (1s white noise)
    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // audio DSP buffer fill (white noise source) — sim PRNG law carve-out
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  setSpeed(revsPerSec: number): void {
    const wasOff = this.revsPerSec === 0;
    this.revsPerSec = revsPerSec;
    if (wasOff && revsPerSec > 0) this.startMotor();
    if (revsPerSec === 0) this.stopMotor();
    if (this.motorGain && this.ctx) {
      this.motorGain.gain.setTargetAtTime(revsPerSec > 0 ? 0.008 : 0, this.ctx.currentTime, 0.5);
    }
  }

  update(dt: number): void {
    if (this.revsPerSec <= 0 || !this.ctx) return;
    // blade-pass whoosh at 4 blades x rev/s
    const passFreq = this.revsPerSec * 4;
    this.whooshTimer -= dt;
    if (this.whooshTimer <= 0) {
      this.whooshTimer = 1 / passFreq;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300 + this.revsPerSec * 200;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.012 + this.revsPerSec * 0.01, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9 / passFreq);
      src.connect(lp).connect(g).connect(this.destination);
      src.start(t); src.stop(t + 1 / passFreq);
    }
  }

  private startMotor(): void {
    if (!this.ctx || this.motorOsc) return;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 55;
    const g = this.ctx.createGain();
    g.gain.value = 0.006;
    o.connect(g).connect(this.destination);
    o.start();
    this.motorOsc = o;
    this.motorGain = g;
  }

  private stopMotor(): void {
    if (this.motorOsc) { try { this.motorOsc.stop(); } catch { /* already stopped */ } this.motorOsc = null; }
    this.motorGain = null;
  }

  stop(): void {
    this.stopMotor();
    this.revsPerSec = 0;
  }
}


