/**
 * District-specific procedural footsteps for BACKROOMS: MEMORY BLEED.
 *
 * Every surface is a filtered white-noise burst with its own envelope
 * and EQ character — no asset files:
 *   carpet : soft thud      -> 200 Hz lowpass, ~80 ms
 *   tile   : click + tail   -> 3 ms click + 1 kHz bandpass, ~50 ms
 *   metal  : resonant ring  -> 800 Hz high-Q bandpass, ~200 ms decay
 *   splash : puddle zone    -> broadband ~120 ms, highpass sweeping up
 *
 * Each step gets ±10 % random pitch/volume so repeated steps never sound
 * identical, and sprinting makes steps faster, louder and slightly higher.
 */

export type SurfaceKind = 'carpet' | 'tile' | 'metal' | 'splash';

const SURFACES: readonly SurfaceKind[] = ['carpet', 'tile', 'metal', 'splash'];

/** Base per-surface voice: loudness and how long the burst rings. */
interface SurfaceProfile {
  /** peak gain before jitter */
  vol: number;
  /** nominal burst length in seconds (before sprint compression) */
  dur: number;
}

const PROFILES: Record<SurfaceKind, SurfaceProfile> = {
  carpet: { vol: 0.14, dur: 0.08 },
  tile:   { vol: 0.11, dur: 0.05 },
  metal:  { vol: 0.09, dur: 0.20 },
  splash: { vol: 0.16, dur: 0.12 },
};

export class SurfaceFootsteps {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly noise: AudioBuffer;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;


