
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


