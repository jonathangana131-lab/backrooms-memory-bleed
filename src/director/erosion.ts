/**
 * Reality Erosion - the recovery/death loop.
 *
 * Peaks, blackouts and close watchers erode stability. At zero during a
 * peak the space "rejects" the player and relocates them somewhere else,
 * keeping all progress. Death is not an end here; it is an edit.
 */
export class RealityErosion {
  /** 1 = stable, 0 = rejected */
  stability = 1;
  relocations = 0;
  private flashUntil = 0;

  update(
    dt: number,
    ctx: { phase: string; blackout: boolean; watcherDist: number | null; sprinting: boolean },
  ): { relocate: boolean } | null {
    let drain = 0;
    if (ctx.phase === 'peak') drain += 0.02;
    if (ctx.blackout) drain += 0.012;
    if (ctx.watcherDist !== null && ctx.watcherDist < 8) drain += 0.05;
    if (drain === 0) {
      this.stability = Math.min(1, this.stability + dt * (ctx.sprinting ? 0.03 : 0.018));
    } else {
      this.stability = Math.max(0, this.stability - dt * drain);
    }
    if (this.stability <= 0 && ctx.phase === 'peak') {
      this.stability = 1;
      this.relocations++;
      this.flashUntil = performance.now() + 1200;
      return { relocate: true };
    }
    return null;
  }

  /** screen overlay strength 0..1 */
  overlay(now: number): number {
    const base = this.stability < 0.45 ? (0.45 - this.stability) / 0.45 : 0;
    const flash = now < this.flashUntil ? (this.flashUntil - now) / 1200 : 0;
    return Math.min(1, base * 0.7 + flash);
  }
}


