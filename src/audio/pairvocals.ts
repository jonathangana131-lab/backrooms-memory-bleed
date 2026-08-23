      c.voiceB.dispose();
    }
    this.convos.length = 0;
  }

  /** Diagnostics snapshot for tests and wiring. */
  debugState(): ConvoDebug[] {
    return this.convos.map((c) => ({
      phase: c.phase,
      ax: c.ax, az: c.az,
      bx: c.bx, bz: c.bz,
      speaker: c.speaker,
      timeLeft: c.timeLeft,
      coolLeft: c.coolLeft,
      turns: c.turns,
    }));
  }

  // ------------------------------------------------------------------


(Showing lines 470-489 of 616. Use offset=490 to continue.)

