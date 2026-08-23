/**
 * Rare neon signs — dead-mall remnants bleeding into the Backrooms.
 *
 * A CORRIDOR_GRID chunk has a 1-in-15 chance of hosting exactly one neon
 * sign, bolted to a block wall and facing straight down an open corridor
 * band (the lat-7 grid's gx/gz == 3..4 strips, matching architect.ts).
 * Text is chosen deterministically from the chunk hash, so the same chunk
 * always grows the same sign.
 *
 * Pure data + logic — no Babylon dependency. The mesher consumes
 * NeonSignInstance directly (emissive quad + halo), and the audio layer
 * drives the buzz with sampleFlicker/buzzGain or attaches the ready-made
 * Web Audio graph via createNeonBuzz. Everything is a pure function of
 * (seed, tMs) so flicker is identical across clients and reloads.
 */

/** Grid cell size in meters (mirrors constants.CELL). */
const CELL = 2.5;
/** Cells per chunk side (mirrors constants.CHUNK_CELLS). */
const CHUNK_CELLS = 12;

/** District.CORRIDOR_GRID ordinal in constants.ts. */
const CORRIDOR_GRID = 3;

/** Lat spacing of the corridor super-grid (mirrors architect.decideEdge). */
const LAT = 7;

/** Private salt so neon placement never correlates with any other feature. */
const NEON_SALT = 0x6e30;

/** Buzz is audible within this radius (m). */
export const BUZZ_RADIUS = 8;

const TEXT_POOL = ['MOTEL', 'OPEN 24 HRS', 'VACANCY', 'NO VACANCY', 'DINER'] as const;
export type NeonText = (typeof TEXT_POOL)[number];

/** Tube color per text — motel-red, exit-green, vacancy-cyan, diner-amber. */
const TEXT_COLORS: Record<NeonText, string> = {
  'MOTEL': '#ff3038',
  'OPEN 24 HRS': '#39ff88',
  'VACANCY': '#4de8ff',
  'NO VACANCY': '#ff3038',
  'DINER': '#ffc24d',
};

/** What the mesher needs to build the emissive plane + halo. */
export interface NeonSignInstance {
  text: string;
  /** world-space anchor on the wall plane (center of the sign) */
  x: number;
  z: number;
  /** wall normal direction: 0=-z 1=+z 2=-x 3=+x (same convention as architect.SignInstance) */
  face: 0 | 1 | 2 | 3;
  /** mounting height of the sign center (m) */
  y: number;
  /** emissive plane size (m) */
  width: number;
  height: number;
  /** tube glow color (hex) */
  color: string;
  /** deterministic flicker/audio seed (derived from chunk hash) */
  seed: number;
}

// --- deterministic hashing (local copy so the module stays dependency-free) ---

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(a: number, b: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(a | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(b | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function frac(h: number): number {
  return h / 4294967296;
}

function posMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export class NeonSign {
  /**
   * Deterministic placement: at most one sign per chunk, and only when the
   * chunk hash wins the 1-in-15 lottery, and only in CORRIDOR_GRID districts.
   * Returns null for every losing/non-qualifying chunk — call sites can
   * simply skip meshing when null comes back.
   */
  static tryPlace(cx: number, cz: number, district: number): NeonSignInstance | null {
    if (district !== CORRIDOR_GRID) return null;
    const h = hash2(cx, cz, NEON_SALT);
    if (h % 15 !== 0) return null; // rarity gate: expected 1 sign per 15 chunks

    const seed = hash2(cx, cz, NEON_SALT ^ 0x5eed);

    // --- corridor geometry (lat-7 grid, bands at local 3..4, walls at 3 & 5)
    const baseCellX = cx * CHUNK_CELLS;
    const baseCellZ = cz * CHUNK_CELLS;

    // local cell indices of the two wall lines bounding the corridor bands,
    // when they fall inside this chunk
    interface Candidate { axis: 'x' | 'z'; line: number; face: 0 | 1 | 2 | 3 }
    const candidates: Candidate[] = [];
    const top = posMod(3 - posMod(baseCellZ, LAT), LAT);
    const bottom = posMod(5 - posMod(baseCellZ, LAT), LAT);
    // line >= 1 keeps the sign strictly interior (a line-0 wall lies exactly
    // on the chunk boundary and belongs to the neighbour's dressing pass)
    if (top > 0 && top < CHUNK_CELLS) candidates.push({ axis: 'x', line: top, face: 1 });
    if (bottom > 0 && bottom < CHUNK_CELLS) candidates.push({ axis: 'x', line: bottom, face: 0 });
    const left = posMod(3 - posMod(baseCellX, LAT), LAT);
    const right = posMod(5 - posMod(baseCellX, LAT), LAT);
    if (left > 0 && left < CHUNK_CELLS) candidates.push({ axis: 'z', line: left, face: 3 });
    if (right > 0 && right < CHUNK_CELLS) candidates.push({ axis: 'z', line: right, face: 2 });
    if (!candidates.length) return null;

    const cand = candidates[seed % candidates.length];

    // pick a corridor band cell along the wall so the sign faces down the aisle
    const alongBase = cand.axis === 'x' ? baseCellX : baseCellZ;
    const corridorLocals: number[] = [];
    for (let l = 0; l < CHUNK_CELLS; l++) {
      const g = posMod(alongBase + l, LAT);
      if (g === 3 || g === 4) corridorLocals.push(l);
    }
    if (!corridorLocals.length) return null;
    const alongLocal = corridorLocals[(seed >>> 8) % corridorLocals.length];

    // sign anchor: centered on the corridor cell, offset off the wall plane

(Showing lines 80-139 of 293. Use offset=140 to continue.)

    const OFFSET = 0.11; // clears WALL_T plus tube standoff
    let x: number, z: number, face: 0 | 1 | 2 | 3;
    if (cand.axis === 'x') {
      // wall runs east-west; sign looks along z into the corridor
      x = (baseCellX + alongLocal + 0.5) * CELL;
      z = (baseCellZ + cand.line) * CELL + (cand.face === 1 ? OFFSET : -OFFSET);
      face = cand.face;
    } else {
      // wall runs north-south; sign looks along x into the corridor
      z = (baseCellZ + alongLocal + 0.5) * CELL;
      x = (baseCellX + cand.line) * CELL + (cand.face === 3 ? OFFSET : -OFFSET);
      face = cand.face;
    }

    const text = TEXT_POOL[(seed >>> 16) % TEXT_POOL.length];
    const y = 2.0 + frac(hash2(seed, 1, 0x79)) * 0.5; // 2.0–2.5 m, above head height
    const width = 0.42 + text.length * 0.21;

    return {
      text,
      x, z,
      face,
      y,
      width,
      height: 0.62,
      color: TEXT_COLORS[text],
      seed,
    };
  }

  /**
   * Realistic neon decay, sampled (not integrated) — brightness in [0,1]:
   *
   *  - baseline: mostly-on (~95%) with faint shimmer, punctuated by brief
   *    "buzz-cut" dropouts of one-or-two 30–80 ms slots where the tube dims
   *    to a sputter but never fully dies;
   *  - episodes: on a 26–60 s per-sign cycle there is a 35% chance of a full
   *    failure lasting 0.5–2 s — hard zero, the ballast giving up — followed
   *    by a ~0.4 s erratic restart stutter before settling back to baseline.
   *
   * Exact zero is returned ONLY inside a full-off episode, so callers can
   * gate the buzz audio and emissive intensity on brightness > 0.
   */
  static sampleFlicker(seed: number, tMs: number): number {
    const s = seed >>> 0;

    // --- full-off episodes -------------------------------------------------
    const cycle = 26_000 + frac(hash2(s, 0, 0xc1)) * 34_000; // 26–60 s
    const phase = Math.floor(tMs / cycle);
    if (frac(hash2(s, phase, 0xe0)) < 0.35) {
      const offDur = 500 + frac(hash2(s, phase, 0xe1)) * 1500; // 0.5–2 s
      const start = frac(hash2(s, phase, 0xe2)) * (cycle - offDur);
      const dt = tMs - phase * cycle - start;
      if (dt >= 0 && dt < offDur) return 0; // dead tube
      if (dt >= offDur && dt < offDur + 400) {
        // buzz-back: erratic restart, stutter slots brighten as it catches
        const progress = (dt - offDur) / 400;
        const slotLen = 40 + frac(hash2(s, phase, 0xe3)) * 30;
        const q = Math.floor(dt / slotLen);
        const fires = frac(hash2(s, q, 0xe4)) < 0.35 + 0.6 * progress;
        return fires ? 0.75 + 0.25 * frac(hash2(s, q, 0xe5)) : 0.25;
      }
    }

    // --- baseline: shimmer + buzz-cut dropouts -----------------------------
    const slotLen = 30 + frac(hash2(s, 1, 0xd1)) * 50; // 30–80 ms, fixed per sign
    const q = Math.floor(tMs / slotLen);
    const cut = frac(hash2(s, q, 0xd2));
    if (cut < 0.03) return 0.06 + 0.06 * frac(hash2(s, q, 0xd3)); // deep sputter
    if (cut < 0.055) return 0.35; // shallow blink
    const shimmer = 0.94 + 0.06 * frac(hash2(s, Math.floor(tMs / 17), 0xd4));
    return shimmer;
  }

  /**
   * Buzz loudness (0..1 pre-master) for a listener at (px, pz):
   * squared-distance falloff clipped to BUZZ_RADIUS, gated by the flicker —
   * the hum dies exactly when the tube dies and stutters with the restart.
   */
  static buzzGain(sign: NeonSignInstance, px: number, pz: number, tMs: number): number {
    const d = Math.hypot(px - sign.x, pz - sign.z);
    if (d >= BUZZ_RADIUS) return 0;
    const att = 1 - d / BUZZ_RADIUS;
    return att * att * NeonSign.sampleFlicker(sign.seed, tMs);
  }
}

// --- optional Web Audio graph -----------------------------------------------

/** Live handle for the buzz voice; call update() each frame, dispose() on unload. */
export interface NeonBuzzHandle {
  update(px: number, pz: number, tMs: number): void;
  dispose(): void;
}

/**
 * Builds the electrical buzz: a 60 Hz sawtooth carrier (ballast hum) plus
 * sine harmonics at 120/180/240 Hz for the metallic edge, mixed through one
 * master gain that tracks buzzGain() — audible within 8 m, silent while the
 * sign is in a full-off episode. Returns null outside a browser (tests).
 */
export function createNeonBuzz(
  ctx: AudioContext,
  destination: AudioNode,
  sign: NeonSignInstance,
): NeonBuzzHandle | null {
  if (!ctx || typeof ctx.createOscillator !== 'function') return null;

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(destination);

  // [freq, type, level]
  const voices: Array<[number, OscillatorType, number]> = [
    [60, 'sawtooth', 0.5],
    [120, 'sine', 0.28],
    [180, 'sine', 0.14],
    [240, 'sine', 0.08],
  ];
  const oscs: OscillatorNode[] = [];
  const filters: BiquadFilterNode[] = [];
  for (const [freq, type, level] of voices) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = freq * 4; // tame sawtooth rasp on the carrier
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start();
    oscs.push(osc);
    filters.push(lp);
  }

  const PEAK = 0.045; // quiet — background texture, not an alarm
  return {
    update(px: number, pz: number, tMs: number): void {
      const g = NeonSign.buzzGain(sign, px, pz, tMs) * PEAK;
      master.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
    },
    dispose(): void {
      for (const osc of oscs) {
        try { osc.stop(); } catch { /* already stopped */ }
        osc.disconnect();
      }
      for (const f of filters) f.disconnect();
      master.disconnect();
    },
  };
}


