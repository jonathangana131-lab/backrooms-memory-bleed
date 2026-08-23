  syncLights(allLights: FixtureLite[]): void {
    this.lights = allLights;
  }

  /**
   * A light at (x,z) just died. Every alive neighbour within
   * RIPPLE_RADIUS metres joins a strobe wave radiating outward: each is
   * delayed by its distance / RIPPLE_SPEED, so far lights react later and
   * the whole wave completes inside WAVE_WINDOW seconds. Dead/dying
   * fixtures stay dark - the grid has nothing left to surge through them.
   */
  onLightDeath(x: number, z: number, allLights: FixtureLite[]): void {
    this.syncLights(allLights);
    const now = this.clock;
    let added = 0;
    for (const f of allLights) {
      if (f.die) continue;
      // the dying light itself does not flicker - it is gone
      if (f.x === x && f.z === z) continue;
      const d = dist(x, z, f.x, f.z);
      if (d > RIPPLE_RADIUS || d <= 0) continue;
      this.bursts.push({
        x: f.x,
        z: f.z,
        start: now + d / RIPPLE_SPEED,
        dur: BURST_DURATION,
        seed: Math.floor(f.x * 7 + f.z * 13),
      });
      added++;
    }
    if (added > 0) this.prune();
  }

  /**
   * A watcher is about to spawn at (x,z), PRESPAWN_LEAD seconds out.
   * Alive lights within PRESPAWN_RADIUS begin an uneasy stutter NOW -
 * the building's wiring senses the intrusion before the player does.
   */
  preSpawn(x: number, z: number): void {
    const now = this.clock;
    for (const f of this.lights) {
      if (f.die) continue;
      if (dist(x, z, f.x, f.z) > PRESPAWN_RADIUS) continue;
      this.bursts.push({
        x: f.x,
        z: f.z,
        start: now,
        dur: PRESPAWN_LEAD,
        seed: Math.floor(f.x * 11 + f.z * 17),
      });
    }
    this.prespawns.push({ x, z, start: now });
    this.prune();
  }

  /**
   * Advance the clock and collect this frame's flicker contributions.
   * Returns one sample per actively-strobing light; lights absent from
   * the result run at their normal multiplier (1).
   */
  update(dt: number): FlickerSample[] {
    const step = Math.min(0.1, Math.max(0, dt));
    this.clock += step;
    const now = this.clock;

    const samples: FlickerSample[] = [];
    for (const b of this.bursts) {
      if (now < b.start || now >= b.start + b.dur) continue;
      const local = now - b.start;
      const k = 1 - local / b.dur; // decay envelope: strongest at wave arrival
      // chaotic strobing: hard dips driven by a 40 Hz hash of (time, light)
      const n = rand2(Math.floor(now * 40), b.seed, 4242);
      const strobe = n > 0.45 ? 1 : 0.12;
      samples.push({ x: b.x, z: b.z, mul: Math.max(0, Math.min(1, (0.2 + 0.8 * strobe) * (0.35 + 0.65 * k))) });
    }

    // phantom-presence undertone: while a prespawn disturbance is live,
    // every burst it spawned gets a subtle sub-frequency throb
    for (const p of this.prespawns) {
      if (now >= p.start + PRESPAWN_LEAD) continue;
      const throb = 0.85 + 0.15 * Math.sin((now - p.start) * 26);
      for (const s of samples) {
        if (dist(p.x, p.z, s.x, s.z) <= PRESPAWN_RADIUS) s.mul *= throb;
      }
    }

    this.bursts = this.bursts.filter((b) => now < b.start + b.dur);
    this.prespawns = this.prespawns.filter((p) => now < p.start + PRESPAWN_LEAD);
    return samples;
  }

  /** Drop finished bursts first; then enforce the simultaneous-event cap. */
  private prune(): void {
    const now = this.clock;
    this.bursts = this.bursts.filter((b) => now < b.start + b.dur + 1e-6);
    if (this.bursts.length > MAX_EVENTS) {
      // keep the newest waves; oldest scheduled bursts are dropped
      this.bursts = this.bursts.slice(this.bursts.length - MAX_EVENTS);
    }
  }
}


