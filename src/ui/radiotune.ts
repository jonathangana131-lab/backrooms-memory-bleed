/***********************************************************************
 * Radio tuning minigame: interactable radios hide lore behind a dial.
 *
 * Design intent:
 *  - Pressing E near a radio opens a dial overlay: a horizontal 88-108
 *    MHz scale with a moving needle (A/D or arrow keys).
 *  - Each radio hides ONE station at a seeded frequency. White-noise
 *    static plays while hunting and fades toward silence as the needle
 *    closes on the hidden carrier: |freq - target| shrinks, static
 *    dies, and inside +/- LOCK_RANGE the signal locks - a clear
 *    voice-like dual tone rises out of the hiss and the lore fragment
 *    prints on screen.
 *  - Memory: once a station is found it is marked for the session.
 *    Reopening that radio shows its fragment instantly with NO static -
 *    the dial remembers what the expedition heard.
 *  - Lore pool: ten short expedition-log fragments (coordinates caught
 *    in broadcasts, warnings about named corridors, personal messages
 *    from the research team). Selection is seeded per radio and prefers
 *    fragments the player has not collected yet.
 *
 * Standalone module: owns only its own stylesheet and DOM subtree.
 * Pure logic + DOM + WebAudio; no Babylon dependency. Document,
 * audio, and window are injectable so headless tests drive the whole
 * lifecycle with stubs.
 ***********************************************************************/

/** Low edge of the FM broadcast band shown on the dial, in MHz. */
export const FREQ_MIN = 88;

/** High edge of the FM broadcast band shown on the dial, in MHz. */
export const FREQ_MAX = 108;

/** Needle within +/- this many MHz of the carrier counts as locked. */
export const LOCK_RANGE = 0.3;

/** Needle travel speed while a tune key is held, in MHz per second. */
export const TUNE_SPEED = 5;

/**
 * Distance in MHz beyond LOCK_RANGE over which static ramps from full
 * loudness down to silence. At STATIC_RAMP away the hiss is total; at
 * lock it is gone.
 */
export const STATIC_RAMP = 5;

/**
 * Expedition-log fragments behind the hidden stations. Ten entries, one
 * to two sentences each: coordinates, corridor warnings, personal mail.
 */
export const LORE_POOL: readonly string[] = [
  '...repeat: survey team HALCYON regrouping at grid 44.118 north, 79.542 west. Bring your own light - the ceiling lies about distances.',
  'Day 31. The yellow corridor past the flooded stairwell loops every forty paces - chalk your left hand on the wall or you will meet yourself coming back.',
  'If you can hear this, the transmitter on Sublevel 3 still has power. Do not answer on this frequency - it answers back.',
  'Mara to whoever keeps reading my notes: I am alive. West pillar line, third door that is not a door - I have stopped counting days.',
  'Broadcast log 88-C: all exits remapped at 12.7 meters per floor tile. The building adds floors while you sleep - never trust a stale map.',
  'Warning - corridor B-9 floods at irregular intervals with something that is not water. Doctor Okafor lost her boots and, shortly after, her patience.',
  '...signal originates approximately six kilometers below survey datum. Adjust your instruments, not your expectations.',
  'Personal, unencrypted: Jamie, the hum stops when you sleep. That is how I know you are still near - keep humming.',
  'Team directive 7: never tune past 107.9. The band above ours belongs to whatever was here before the fluorescent lights.',
  'Coordinates again, slower: 41 degrees north, 2 degrees east, depth unknown. If rescue reads this, bring rope and do not bring mirrors.',
];

/** Padding kept from the band edges so the hidden carrier stays reachable. */
const BAND_PAD = 1.5;

/**
 * FNV-1a 32-bit hash of a seed string. Deterministic across sessions so
 * a given radio always hides the same station.
 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hidden-carrier frequency for a seed: one decimal, inside the band. */
export function targetFreqFor(seed: string): number {
  const n = hashSeed(seed) / 0x100000000; // [0, 1)
  const lo = FREQ_MIN + BAND_PAD;
  const hi = FREQ_MAX - BAND_PAD;
  return Math.round((lo + n * (hi - lo)) * 10) / 10;
}

/** Clamp a frequency to the dial range. */
export function clampFreq(freq: number): number {
  if (Number.isNaN(freq)) return FREQ_MIN;
  return Math.min(FREQ_MAX, Math.max(FREQ_MIN, freq));
}

/** True when the needle sits inside the +/- LOCK_RANGE capture window. */
export function isLocked(freq: number, target: number): boolean {
  return Math.abs(freq - target) <= LOCK_RANGE;
}

/**
 * Static loudness 0..1 for the current needle position. Falls to
 * silence as the needle approaches the carrier (the static clears),
 * and stays silent forever on stations already in expedition memory.
 */
export function staticVolume(
  freq: number,
  target: number,
  alreadyFound = false,
): number {
  if (alreadyFound) return 0;
  const d = Math.abs(freq - target);
  if (d <= LOCK_RANGE) return 0;
  return Math.min(1, (d - LOCK_RANGE) / STATIC_RAMP);
}

/** Needle position as a percentage along the 88-108 scale. */
export function needlePercent(freq: number): number {
  const f = clampFreq(freq);
  return ((f - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * 100;
}

/**
 * Pick a lore index for a radio. Starts at hash % pool size and walks
 * forward past indices already handed out, so different radios tend to
 * surface different fragments. When every fragment has been surfaced
 * it falls back to the hashed start.
 */
export function loreIndexFor(
  seedHash: number,
  taken: ReadonlySet<number>,
): number {
  const n = LORE_POOL.length;
  if (n === 0) throw new Error('lore pool must not be empty');
  const start = ((seedHash % n) + n) % n;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    if (!taken.has(idx)) return idx;
  }
  return start;
}

/* ------------------------------------------------------------------ */
/* Audio backend                                                       */
/* ------------------------------------------------------------------ */

/**
 * Structural surface of the static engine. Production wires WebAudio;
 * tests inject a recorder. All levels are 0..1 intentions - the real
 * implementation scales them down to mix-safe gains.
 */
export interface RadioAudio {
  /** White-noise bed loudness (0 = silent band, 1 = full hiss). */
  setStatic(level: number): void;
  /** Voice-like dual-tone presence (rises when the signal locks). */
  setVoice(level: number): void;
  /** Short confirmation chirp played at the moment of discovery. */
  ping(): void;
  suspend(): void;
  resume(): void;
}

interface GainParamLike {
  value: number;
  setTargetAtTime?(value: number, startTime: number, timeConstant: number): void;
}

/** A gain node: an automation-capable level wired into the graph. */
interface GainNodeLike {
  gain: GainParamLike;
  connect(node: unknown): void;
}

interface FreqParamLike {
  value: number;
}

interface AudioContextLike {
  currentTime: number;
  sampleRate: number;
  destination: unknown;
  createBuffer(channels: number, length: number, rate: number): {
    getChannelData(channel: number): Float32Array;
  };
  createBufferSource(): {
    buffer: unknown;
    loop: boolean;
    connect(node: unknown): void;
    start(when?: number): void;
  };
  createGain(): GainNodeLike;
  createOscillator(): {
    type: string;
    frequency: FreqParamLike;
    connect(node: unknown): void;
    start(when?: number): void;
    stop(when?: number): void;
  };
  resume(): Promise<void> | void;
  suspend(): Promise<void> | void;
}

/** Mix ceilings so hiss and tone sit under the world ambience. */
const STATIC_MAX_GAIN = 0.16;
const VOICE_MAX_GAIN = 0.05;

/**
 * Real WebAudio implementation: looping white-noise buffer through a
 * gain (static), two slightly detuned sines through another gain (a
 * carrier hum that reads as a voice underneath), and a percussive ping
 * oscillator created per discovery.
 */
export class WebAudioStatic implements RadioAudio {
  private ctx: AudioContextLike;
  private staticGain: GainNodeLike;
  private voiceGain: GainNodeLike;

  constructor(ctx: AudioContextLike) {
    this.ctx = ctx;

    // ---- white noise bed ----
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const data = buf.getChannelData(0);
    // audio DSP buffer fill (static white noise) — sim PRNG law carve-out
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    src.connect(this.staticGain);
    this.staticGain.connect(ctx.destination);
    src.start();

    // ---- voice-like dual carrier ----
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;
    this.voiceGain.connect(ctx.destination);
    for (const hz of [174, 261.6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      osc.connect(this.voiceGain);
      osc.start();
    }
  }

  private ramp(param: GainParamLike, level01: number): void {
    const v = Math.max(0, Math.min(1, level01));
    if (typeof param.setTargetAtTime === 'function') {
      param.setTargetAtTime(v, this.ctx.currentTime, 0.06);
    } else {
      param.value = v;
    }
  }

  setStatic(level: number): void {
    this.ramp(this.staticGain.gain, level * STATIC_MAX_GAIN);
  }

  setVoice(level: number): void {
    this.ramp(this.voiceGain.gain, level * VOICE_MAX_GAIN);
  }

  ping(): void {
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 660;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime?.(0.09, t, 0.02);
      g.gain.setTargetAtTime?.(0, t + 0.12, 0.08);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    } catch {
      /* a failed chirp must never break discovery */
    }
  }

  suspend(): void {
    try {
      void this.ctx.suspend();
    } catch {
      /* already suspended */
    }
  }

  resume(): void {
    try {
      void this.ctx.resume();
    } catch {
      /* already running */
    }
  }
}

/** Build the real audio backend, or null on hosts without WebAudio. */
export function createWebAudioStatic(): RadioAudio | null {
  try {
    const g = globalThis as {
      AudioContext?: new () => AudioContextLike;
      webkitAudioContext?: new () => AudioContextLike;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    return new WebAudioStatic(new Ctor());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* DOM plumbing (structural, stub-friendly like hints.ts)              */
/* ------------------------------------------------------------------ */

export interface TunerElementLike {
  className: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: TunerElementLike): unknown;
  remove(): void;
}

export interface TunerDocumentLike {
  createElement(tagName: string): TunerElementLike;
  head: { appendChild(child: TunerElementLike): unknown };
}

interface WindowLike {
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  removeEventListener(type: string, handler: (ev: unknown) => void): void;
}

function resolveDocument(doc?: TunerDocumentLike | null): TunerDocumentLike {
  const d = doc ?? (globalThis as { document?: TunerDocumentLike }).document;
  if (!d || typeof d.createElement !== 'function') {
    throw new Error('RadioTuner requires a DOM document');
  }
  return d;
}

function setText(el: TunerElementLike, text: string): void {
  (el as unknown as { textContent?: string }).textContent = text;
}

function css(el: TunerElementLike, name: string, value: string): void {
  el.style.setProperty(name, value);
}

function buildCss(): string {
  return [
    '.bmb-radiotune {',
    '  position: fixed;',
    '  inset: 0;',
    '  display: none;',
    '  align-items: center;',
    '  justify-content: center;',
    '  background: rgba(2, 3, 2, 0.55);',
    '  font-family: ui-monospace, Menlo, Consolas, monospace;',
    '  pointer-events: none;',
    '  user-select: none;',
    '  z-index: 30;',
    '}',
    '.bmb-radiotune-panel {',
    '  width: min(520px, 86vw);',
    '  padding: 18px 22px 14px;',
    '  background: rgba(8, 10, 7, 0.92);',
    '  border: 1px solid rgba(190, 160, 70, 0.35);',
    '  border-radius: 4px;',
    '  box-shadow: 0 0 24px rgba(0, 0, 0, 0.8), inset 0 0 40px rgba(120, 90, 20, 0.06);',
    '}',
    '.bmb-radiotune-title {',
    '  margin: 0 0 10px;',
    '  font-size: 11px;',
    '  letter-spacing: 0.32em;',
    '  color: rgba(214, 178, 84, 0.85);',
    '}',
    '.bmb-radiotune-scale {',
    '  position: relative;',
    '  height: 46px;',
    '  margin: 0 6px;',
    '  border-bottom: 1px solid rgba(214, 178, 84, 0.45);',
    '}',
    '.bmb-radiotune-tick {',
    '  position: absolute;',
    '  bottom: 0;',
    '  width: 1px;',
    '  height: 8px;',
    '  background: rgba(214, 178, 84, 0.35);',
    '}',
    '.bmb-radiotune-tick-major {',
    '  height: 16px;',
    '  background: rgba(214, 178, 84, 0.65);',
    '}',
    '.bmb-radiotune-tick-label {',
    '  position: absolute;',
    '  bottom: 20px;',
    '  transform: translateX(-50%);',
    '  font-size: 9px;',
    '  color: rgba(196, 170, 96, 0.6);',
    '  white-space: nowrap;',
    '}',
    '.bmb-radiotune-found {',
    '  position: absolute;',
    '  bottom: -3px;',
    '  width: 7px;',
    '  height: 7px;',
    '  transform: translateX(-50%) rotate(45deg);',
    '  background: #ffd75e;',
    '  box-shadow: 0 0 8px rgba(255, 215, 94, 0.9);',
    '  opacity: 0;',
    '}',
    '.bmb-radiotune-needle {',
    '  position: absolute;',
    '  bottom: -2px;',
    '  width: 2px;',
    '  height: 30px;',
    '  transform: translateX(-50%);',
    '  background: #ffb347;',
    '  box-shadow: 0 0 6px rgba(255, 179, 71, 0.9);',
    '}',
    '.bmb-radiotune-readout {',
    '  margin: 8px 6px 2px;',
    '  display: flex;',
    '  justify-content: space-between;',
    '  font-size: 13px;',
    '  color: rgba(232, 210, 150, 0.95);',
    '}',
    '.bmb-radiotune-status {',
    '  font-size: 11px;',
    '  letter-spacing: 0.18em;',
    '  color: rgba(150, 150, 130, 0.7);',
    '}',
    '.bmb-radiotune-lore {',
    '  min-height: 54px;',
    '  margin-top: 10px;',
    '  padding: 10px 12px;',
    '  border-left: 2px solid rgba(214, 178, 84, 0.5);',
    '  font-size: 13px;',
    '  line-height: 1.55;',
    '  color: rgba(228, 216, 184, 0.92);',
    '  font-style: italic;',
    '}',
    '.bmb-radiotune-hint {',
    '  margin: 10px 6px 0;',
    '  font-size: 10px;',
    '  letter-spacing: 0.12em;',
    '  color: rgba(150, 145, 125, 0.55);',
    '}',
  ].join(String.fromCharCode(10));
}

interface Options {
  /** Injected document (tests pass a stub; production uses the global). */
  document?: TunerDocumentLike | null;
  /** Mount point for the overlay; defaults to document.body or head. */
  container?: { appendChild(child: TunerElementLike): unknown } | null;
  /** Audio backend factory; defaults to WebAudio when the host has it. */
  createAudio?: () => RadioAudio | null;
  /** Injected window for key wiring; tests drive pressKey/releaseKey. */
  window?: WindowLike | null;
}

/* ------------------------------------------------------------------ */
/* RadioTuner                                                          */
/* ------------------------------------------------------------------ */

/**
 * Owns one radio-dial session at a time:
 *
 *   const tuner = new RadioTuner(document.body);
 *   // E pressed near a radio:
 *   tuner.open(radio.seed);
 *   // each frame while the dial is up:
 *   const lore = tuner.update(dt); // string at the moment of discovery
 *   // E or Escape pressed again:
 *   tuner.close();
 */
export class RadioTuner {
  private doc: TunerDocumentLike;
  private root: TunerElementLike;
  private needle: TunerElementLike;
  private foundMark: TunerElementLike;
  private readout: TunerElementLike;
  private status: TunerElementLike;
  private loreBox: TunerElementLike;
  private audio: RadioAudio | null;
  private keyDetach: (() => void) | null = null;
  private held = new Set<string>();

  /** Band position of the needle, MHz. */
  private freq = FREQ_MIN;
  /** Hidden carrier for the open radio, MHz. */
  private target = 0;
  private seed = '';
  private loreText = '';
  private openFlag = false;
  private disposed = false;

  /** Stations found this session, keyed by seed. */
  private foundStations = new Set<string>();
  /** Seeds whose lore update() has already reported upward. */
  private reported = new Set<string>();
  /** Lore pool indices already surfaced; selection prefers fresh ones. */
  private usedLore = new Set<number>();
  /** Stable seed -> lore assignment so a radio never changes its story. */
  private loreBySeed = new Map<string, number>();

  constructor(opts: Options = {}) {
    this.doc = resolveDocument(opts.document);

    // ---- stylesheet ----
    const style = this.doc.createElement('style');
    style.className = 'bmb-radiotune-style';
    setText(style, buildCss());
    this.doc.head.appendChild(style);

    // ---- overlay subtree ----
    this.root = this.doc.createElement('div');
    this.root.className = 'bmb-radiotune';
    css(this.root, 'display', 'none');

    const panel = this.el(this.root, 'bmb-radiotune-panel');
    const title = this.el(panel, 'bmb-radiotune-title');
    setText(title, 'SIGNAL SCAN');

    const scale = this.el(panel, 'bmb-radiotune-scale');
    for (let m = FREQ_MIN; m <= FREQ_MAX; m += 1) {
      const pct = needlePercent(m).toFixed(2) + '%';
      const major = m % 5 === 0;
      const tick = this.el(
        scale,
        major ? 'bmb-radiotune-tick bmb-radiotune-tick-major' : 'bmb-radiotune-tick',
      );
      css(tick, 'left', pct);
      if (major) {
        const label = this.el(scale, 'bmb-radiotune-tick-label');
        css(label, 'left', pct);
        setText(label, String(m));
      }
    }
    this.foundMark = this.el(scale, 'bmb-radiotune-found');
    this.needle = this.el(scale, 'bmb-radiotune-needle');

    const readRow = this.el(panel, 'bmb-radiotune-readout');
    this.readout = this.el(readRow, 'bmb-radiotune-freq');
    this.status = this.el(readRow, 'bmb-radiotune-status');

    this.loreBox = this.el(panel, 'bmb-radiotune-lore');
    setText(this.loreBox, '');

    const hint = this.el(panel, 'bmb-radiotune-hint');
    setText(hint, '[A]/[D] or arrows - tune - [E]/[ESC] - close');

    const fallbackDoc = this.doc as unknown as {
      body?: { appendChild(c: TunerElementLike): unknown };
    };
    const mount = opts.container ?? fallbackDoc.body ?? this.doc.head;
    mount.appendChild(this.root);

    this.audio = opts.createAudio ? opts.createAudio() : createWebAudioStatic();
    this.wireWindow(opts.window ?? resolveWindow());
  }

  /** Append a styled child element and return it. */
  private el(parent: TunerElementLike, className: string): TunerElementLike {
    const child = this.doc.createElement('div');
    child.className = className;
    parent.appendChild(child);
    return child;
  }

  /** Bind global key listeners when a real window exists. */
  private wireWindow(w: WindowLike | null): void {
    if (!w || typeof w.addEventListener !== 'function') return;
    const down = (ev: unknown): void => {
      const e = ev as { key?: string; preventDefault?: () => void } | null;
      if (!e || !e.key) return;
      if (this.openFlag && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault?.();
      }
      this.pressKey(e.key);
    };
    const up = (ev: unknown): void => {
      const e = ev as { key?: string } | null;
      if (e && e.key) this.releaseKey(e.key);
    };
    w.addEventListener('keydown', down);
    w.addEventListener('keyup', up);
    this.keyDetach = () => {
      w.removeEventListener('keydown', down);
      w.removeEventListener('keyup', up);
    };
  }

  /**
   * Feed a key press. Production wiring goes through the window
   * listeners; tests may call directly. Tune keys are tracked as held
   * until releaseKey; E or Escape closes an open dial.
   */
  pressKey(key: string): void {
    if (this.disposed) return;
    const k = key.toLowerCase();
    if (this.openFlag && (k === 'e' || k === 'escape')) {
      this.close();
      return;
    }
    this.held.add(k);
  }

  /** Release a previously pressed key. */
  releaseKey(key: string): void {
    this.held.delete(key.toLowerCase());
  }

  /**
   * Open the dial for the radio identified by seed. Derives the hidden
   * carrier and lore fragment deterministically; a previously found
   * station shows its fragment immediately with no static.
   */
  open(seed: string): void {
    if (this.disposed || !seed) return;
    this.seed = seed;
    this.target = targetFreqFor(seed);
    this.freq = FREQ_MIN;
    this.openFlag = true;
    this.held.clear();

    const found = this.foundStations.has(seed);
    let idx = this.loreBySeed.get(seed);
    if (idx === undefined) {
      idx = loreIndexFor(hashSeed(seed), this.usedLore);
      this.loreBySeed.set(seed, idx);
      this.usedLore.add(idx);
    }
    this.loreText = LORE_POOL[idx];

    setText(this.loreBox, found ? this.loreText : '');
    css(this.loreBox, 'opacity', found ? '0.85' : '0.25');
    css(this.foundMark, 'opacity', found ? '1' : '0');
    css(this.foundMark, 'left', needlePercent(this.target).toFixed(2) + '%');
    css(this.root, 'display', 'flex');

    this.audio?.resume();
    this.render();
  }

  /** Close the dial and silence the receiver. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.seed = '';
    this.held.clear();
    css(this.root, 'display', 'none');
    this.audio?.setStatic(0);
    this.audio?.setVoice(0);
    this.audio?.suspend();
  }

  /**
   * Advance one frame. Handles held-key tuning, drives needle/readout/
   * static, and resolves discovery. Returns the lore fragment exactly
   * once per newly found station; null otherwise.
   */
  update(dt: number): string | null {
    if (this.disposed || !this.openFlag || !this.seed) return null;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;

    let dir = 0;
    if (this.held.has('a') || this.held.has('arrowleft')) dir -= 1;
    if (this.held.has('d') || this.held.has('arrowright')) dir += 1;
    if (dir !== 0) this.freq = clampFreq(this.freq + dir * TUNE_SPEED * step);

    const found = this.foundStations.has(this.seed);
    const locked = isLocked(this.freq, this.target);

    // Static clears as the needle closes on the carrier; found stations
    // stay silent forever (memory). The voice-like tone rises on lock.
    this.audio?.setStatic(staticVolume(this.freq, this.target, found));
    this.audio?.setVoice(locked ? 1 : 0);

    if (locked && !found) {
      this.foundStations.add(this.seed);
      css(this.foundMark, 'opacity', '1');
      setText(this.loreBox, this.loreText);
      css(this.loreBox, 'opacity', '0.92');
      this.audio?.ping();
      this.render();
      if (!this.reported.has(this.seed)) {
        this.reported.add(this.seed);
        return this.loreText;
      }
      return null;
    }

    this.render();
    return null;
  }

  /** Push current needle/readout/status into the DOM layer. */
  private render(): void {
    css(this.needle, 'left', needlePercent(this.freq).toFixed(2) + '%');
    setText(this.readout, this.freq.toFixed(1) + ' MHz');
    const locked = isLocked(this.freq, this.target);
    setText(this.status, locked ? '◆ SIGNAL LOCK' : 'searching…');
    css(this.status, 'color', locked ? '#ffe28a' : 'rgba(150, 150, 130, 0.7)');
  }

  /** Whether the dial overlay is currently mounted and active. */
  get isOpen(): boolean {
    return this.openFlag && !this.disposed;
  }

  /** How many hidden stations sit in expedition memory. */
  get knownStationCount(): number {
    return this.foundStations.size;
  }

  /** Remove the DOM subtree and detach listeners; update() becomes inert. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.keyDetach?.();
    this.keyDetach = null;
    try {
      this.root.remove();
    } catch {
      /* already detached */
    }
  }
}

/** Resolve the host window when one exists (never throws in Node). */
function resolveWindow(): WindowLike | null {
  const w = (globalThis as { window?: WindowLike }).window;
  if (w && typeof w.addEventListener === 'function') return w;
  return null;
}


