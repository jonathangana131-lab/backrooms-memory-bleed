   * and plays it on the footsteps synth with the sprint modifier applied.
   *
   * @returns true when a step was played; false when it was deduped away
   *          as too soon after the previous emitted step.
   */
  onStep(x: number, z: number, district: number, sprinting = false): boolean {
    const nowMs = nowMs();
    if (nowMs - this.lastStepMs < MIN_STEP_GAP_MS) return false;

    const surface: SurfaceKind = this.detector.detect(x, z, district);
    this.footsteps.play(surface, sprinting);
    this.lastStepMs = nowMs;

(Showing lines 50-61 of 79. Use offset=62 to continue.)

