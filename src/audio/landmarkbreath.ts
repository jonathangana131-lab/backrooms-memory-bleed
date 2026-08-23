  /**
   * Per-frame tick.
   * @param dt seconds since the previous frame
   */
  update(dt: number): void {
    if (this.stopped) return;
    dt = Math.min(dt, 0.1); // tab-back spikes shouldn't skip a breath
    const t = this.ctx.currentTime;

    if (this.holdTimer >= 0) {
      // holding its breath: pinned near silence until the pause elapses
      this.holdTimer -= dt;
      this.swell.gain.setTargetAtTime(0.0001, t, 0.08);
      this.rustleGain.gain.setTargetAtTime(0.0001, t, 0.08);
      if (this.holdTimer < 0) this.boost = 2.2; // the resumed exhale is loud
      return;
    }

    // ease the entrance boost back toward resting loudness
    this.boost = Math.max(1, this.boost * Math.exp(-dt / 4));

    // advance the cycle and shape one swell per half (inhale, exhale)
    this.phase = (this.phase + dt / this.period) % 1;
    const half = this.phase < 0.5 ? this.phase * 2 : (1 - this.phase) * 2;
    const env = Math.pow(Math.sin(Math.PI * half), 1.3);
    this.swell.gain.setTargetAtTime(this.vol * this.boost * env, t, 0.16);

    // ARCHIVE rooms get paper rustle riding the breath with a dry flutter
    if (this.kind === 'ARCHIVE') {
      const flutter = 0.5 + Math.random();
      this.rustleGain.gain.setTargetAtTime(env * 0.02 * flutter, t, 0.22);
    } else {
      this.rustleGain.gain.setTargetAtTime(0, t, 0.3);
    }

    // ornaments: faint monitor beeps / toy chimes on slow schedules
    if (this.kind === 'MEDICAL') {
      this.nextBeepIn -= dt;
      if (this.nextBeepIn <= 0) {
        this.nextBeepIn = 1.6 + Math.random() * 0.8;
        this.beep(t);
      }
    } else if (this.kind === 'PLAYROOM') {
      this.nextChimeIn -= dt;
      if (this.nextChimeIn <= 0) {
        this.nextChimeIn = 4 + Math.random() * 5;
        this.chime(t);
      }
    }
  }


