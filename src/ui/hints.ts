/***********************************************************************
 * Ambient difficulty communication through found text.
 *
 * Design intent (subtlety is the feature):
 *  - When the adaptive director shifts spawn pressure (pulling close to
 *    a confident player, pushing far from a cautious one) the world may
 *    leave a fragment of graffiti near the player: "it watches the brave"
 *    / "it ignores the timid". It reads as environment dressing, never UI.
 *  - Selection is state-driven: cautiousness > 0.6 draws from the timid
 *    pool ("you are safe; something noticed"), < 0.3 from the brave pool
 *    ("something is closing in"). The ambiguous middle shows NOTHING:
 *    ambiguity is scarier than information.
 *  - Rate limited: at most one hint every 3-5 minutes (jittered so it
 *    never feels scheduled), and only after the pool actually CHANGED
 *    since the previous hint. A steady-state player stops hearing from
 *    the walls entirely.
 *  - Presentation: tiny dim monospace italic line, bottom-left, fading
 *    in and out over 4s. Pointer-transparent, non-blocking, never
 *    interrupts gameplay.
 *
 * Standalone module: owns only its own stylesheet and DOM subtree, like
 * whispercue.ts / compass.ts. Pure logic + DOM, no Babylon dependency.
 ***********************************************************************/

/** Cautiousness above which the timid pool becomes active. */
export const TIMID_THRESHOLD = 0.6;

/** Cautiousness below which the brave pool becomes active. */
export const BRAVE_THRESHOLD = 0.3;

/** Fade-in + fade-out duration for one hint presentation, in ms. */
export const HINT_FADE_MS = 4000;

/** Minimum seconds between two hints (inclusive lower bound). */
export const HINT_MIN_INTERVAL_S = 180; // 3 min

/** Maximum seconds between two hints (exclusive upper bound). */
export const HINT_MAX_INTERVAL_S = 300; // 5 min

/**
 * Peak opacity of a visible hint. Deliberately faint - legible when the
 * player looks for it, ignorable when they do not.
 */
export const HINT_PEAK_OPACITY = 0.34;

/** Graffiti fragments for the BRAVE pool: spawn pressure pulling closer. */
export const BRAVE_HINTS: readonly string[] = [
  'it watches the brave',
  'the walls lean closer',
  'your shadow has company',
  'it keeps pace with the sure',
];

/** Graffiti fragments for the TIMID pool: spawn pressure pushing away. */
export const TIMID_HINTS: readonly string[] = [
  'it ignores the timid',
  'stillness is a kind of invisibility',
  'the dark forgets the quiet',
  'patience goes unwitnessed',
];

/** Which graffiti pool is currently selected by cautiousness. */
export type HintPool = 'brave' | 'timid';

/**
 * Map a cautiousness reading to its hint pool. The ambiguous middle maps
 * to null on purpose: when behavior is mixed, the walls say nothing.
 */
export function poolFor(cautiousness: number): HintPool | null {
  if (!Number.isFinite(cautiousness)) return null;
  if (cautiousness > TIMID_THRESHOLD) return 'timid';
  if (cautiousness < BRAVE_THRESHOLD) return 'brave';
  return null;
}

/** Default random source for interval jitter: uniform in [min, max). */
function defaultRng(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Jittered inter-hint interval in [HINT_MIN_INTERVAL_S, HINT_MAX_INTERVAL_S). */
export function rollInterval(
  rng: (min: number, max: number) => number = defaultRng,
): number {
  return rng(HINT_MIN_INTERVAL_S, HINT_MAX_INTERVAL_S);
}

/** Pick one fragment from a pool, round-robin so repeats space out. */
export function pickFrom(pool: readonly string[], index: number): string {
  if (pool.length === 0) throw new Error('hint pool must not be empty');
  const i = ((index % pool.length) + pool.length) % pool.length;
  return pool[i];
}

/** Minimal structural surface of elements used by DifficultyHints. */
export interface HintElementLike {
  className: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: HintElementLike): unknown;
  remove(): void;
}

/** Minimal structural surface of the document used by DifficultyHints. */
export interface HintDocumentLike {
  createElement(tagName: string): HintElementLike;
  head: { appendChild(child: HintElementLike): unknown };
}

function resolveDocument(doc?: HintDocumentLike | null): HintDocumentLike {
  const d = doc ?? (globalThis as { document?: HintDocumentLike }).document;
  if (!d || typeof d.createElement !== 'function') {
    throw new Error('DifficultyHints requires a DOM document');
  }
  return d;
}

function buildCss(): string {
  return [
    '.bmb-hint {',
    '  position: fixed;',
    '  left: 18px;',
    '  bottom: 14px;',
    '  margin: 0;',
    '  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;',
    '  font-style: italic;',
    '  font-size: 12px;',
    '  letter-spacing: 0.06em;',
    "  color: rgba(196, 188, 170, 1);", // dusty wall tone; opacity does the dimming
    '  opacity: ' + HINT_PEAK_OPACITY + ';',
    '  transition: opacity ' + HINT_FADE_MS + 'ms ease-in-out;',
    '  pointer-events: none;',
    '  user-select: none;',
    '  white-space: nowrap;',
    '  z-index: 6;', // under HUD chrome, over the canvas
    '  text-shadow: 0 0 6px rgba(0, 0, 0, 0.8);', // legible on bright walls too
    '}',
  ].join(String.fromCharCode(10));
}

interface Options {
  /** Injected document (tests pass a stub; production uses the global). */
  document?: HintDocumentLike | null;
  /** Random source for interval jitter; injectable for deterministic tests. */
  rng?: (min: number, max: number) => number;
}

/**
 * Owns the ambient hint lifecycle. Feed it dt + the HumanManager profile
 * cautiousness once per frame:
 *
 *   const hints = new DifficultyHints();
 *   const text = hints.update(dt, manager.getPlayerProfile().cautiousness);
 *
 * Returns the fragment it just revealed (and started fading in/out), or
 * null on any frame where nothing should appear. The DOM layer follows
 * automatically - callers need the string only for logging/subtitles.
 */
export class DifficultyHints {
  /** Fragment currently mounted in the DOM layer ('' when hidden). */
  private currentText = '';
  /** Countdown to next eligible hint; ticks only while a pool shift is armed. */
  private nextIn: number;
  /** Pool the LAST shown hint came from; a new hint needs a different pool. */
  private lastShownPool: HintPool | null = null;
  /** Round-robin cursor per pool so consecutive fragments differ. */
  private picks: Record<HintPool, number> = { brave: 0, timid: 0 };
  /** Frame-time bookkeeping for the fade-out half of the presentation arc. */
  private visibleFor = 0;
  private rng: (min: number, max: number) => number;
  private el: HintElementLike;
  private doc: HintDocumentLike;
  private disposed = false;
  /** True while the ambiguous middle kept the walls silent last frame. */
  private wasSilent = false;

  constructor(opts: Options = {}) {
    this.doc = resolveDocument(opts.document);
    this.rng = opts.rng ?? defaultRng;
    this.nextIn = rollInterval(this.rng);
    // ---- stylesheet ----
    const style = this.doc.createElement('style');
    style.className = 'bmb-hints-style';
    setText(style, buildCss());
    this.doc.head.appendChild(style);
    // ---- hint element ----
    this.el = this.doc.createElement('p');
    this.el.className = 'bmb-hint';
    this.el.style.setProperty('opacity', '0'); // born invisible
    this.doc.head.appendChild(this.el);
  }

  /**
   * Advance the hint clock. cautiousness comes straight from
   * HumanManager.getPlayerProfile(). Returns the revealed fragment or null.
   */
  update(dt: number, cautiousness: number): string | null {
    if (this.disposed) return null;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 1)) : 0;
    const pool = poolFor(cautiousness);

    // Ambiguous middle: silence, and disarm so re-entering a pool later
    // counts as a fresh shift rather than resuming an old countdown.
    if (pool === null) {
      // Disarm: the next pool entry counts as a fresh shift instead of
      // resuming an old countdown against a stale lastShownPool, and it
      // waits a FULL fresh jittered window before speaking.
      this.lastShownPool = null;
      if (!this.wasSilent) {
        this.nextIn = rollInterval(this.rng);
        this.wasSilent = true;
      }
      this.tickFade(step);
      return null;
    }
    this.wasSilent = false;

    // A hint may fire only when this pool DIFFERS from the last one shown:
    // steady-state players stop receiving messages from the walls.
    if (pool === this.lastShownPool) {
      this.tickFade(step);
      return null;
    }

    this.nextIn -= step;
    if (this.nextIn > 0) return null;
    return this.reveal(pool);
  }

  /** Reveal a fragment from the given pool and start its 4s arc. */
  private reveal(pool: HintPool): string {
    const source = pool === 'brave' ? BRAVE_HINTS : TIMID_HINTS;
    let idx = this.picks[pool];
    // avoid showing the same fragment twice in a row across pool flips
    if (source.length > 1 && source[idx] === this.currentText) {
      idx = (idx + 1) % source.length;
    }
    const text = pickFrom(source, idx);
    this.picks[pool] = (idx + 1) % source.length;

    this.currentText = text;
    this.visibleFor = 0;
    setText(this.el, text);
    this.el.style.setProperty('opacity', String(HINT_PEAK_OPACITY));
    this.lastShownPool = pool;
    this.nextIn = rollInterval(this.rng);
    return text;
  }

  /**
   * Fade the current fragment back out once its hold window closes. Driven
   * by update() rather than setTimeout so headless tests, paused tabs, and
   * reduced-motion hosts all behave identically.
   */
  private tickFade(step: number): void {
    if (this.currentText === '') return;
    this.visibleFor += step;
    if (this.visibleFor >= HOLD_S_BEFORE_FADE_OUT) {
      this.el.style.setProperty('opacity', '0');
    }
  }

  /** True while a fragment is mid-presentation (visible or fading). */
  get visible(): boolean {
    return this.currentText !== '';
  }

  /** Fragment currently presented, if any. */
  get text(): string | null {
    return this.currentText === '' ? null : this.currentText;
}

  /** Seconds remaining before a hint MAY fire (only meaningful after a shift). */
  get secondsUntilEligible(): number {
    return Math.max(0, this.nextIn);
  }

  /** Remove the DOM subtree. update() becomes a silent no-op afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.el.remove();
    } catch {
      /* already detached */
    }
  }
}

/** How long a revealed fragment holds before beginning its fade-out, in s. */
const HOLD_S_BEFORE_FADE_OUT = 2;

/** Write text content onto an element without relying on DOM typings. */
function setText(el: HintElementLike, text: string): void {
  (el as unknown as { textContent?: string }).textContent = text;
}


