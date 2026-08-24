/***********************************************************************
 * F97 Bureaucratic achievements — achievement events surface as stamped
 * government forms: 'FORM <n>-<L> — REQUEST: ...', routed APPROVED or
 * DENIED, animated through a slide-in / thunk / hold / file-away stamp
 * phase machine in a vertical queue.
 *
 * Design intent:
 *  - Form numbers are deterministic: the event id is hashed through the
 *    repo-standard seedFromString (src/core/rng.ts), so the same
 *    achievement always prints the same form number everywhere. All
 *    randomness flows through src/core/rng.ts (determinism law).
 *  - Routing is table-first: ironic requests (permission to leave,
 *    sanity refunds) are always DENIED; unlisted ids route by hash so
 *    the outcome stays deterministic per id.
 *  - The queue never drops burst events: every pushed record is kept
 *    until it is filed away. At most FORM_QUEUE_VISIBLE forms are on
 *    screen at once; the rest wait stacked below and mount FIFO as the
 *    ones above file away.
 *  - Each visible form advances its own phase machine on update(dtMs):
 *    slide-in -> thunk (stamp lands) -> hold -> file-away -> filed.
 *
 * Standalone module: owns only its own stylesheet and DOM subtree, like
 * hints.ts / dailyrite.ts. Pure logic + DOM, no Babylon dependency.
 ***********************************************************************/

import { hash32, seedFromString } from '../core/rng';

/** Slide-in duration (ms) before the stamp lands. */
export const FORM_SLIDE_MS = 260;

/** Thunk duration (ms): the stamp presses down. */
export const FORM_THUNK_MS = 120;

/** Hold duration (ms) the finished form stays readable. */
export const FORM_HOLD_MS = 4200;

/** File-away duration (ms) as the form slides out of the tray. */
export const FORM_FILE_MS = 500;

/** Maximum forms mounted on screen at once; overflow queues below. */
export const FORM_QUEUE_VISIBLE = 4;

/** Mount stagger between tray slots so completions never collide on one tick. */
export const FORM_STAGGER_MS = 120;

/** Stamp routing outcomes printed on the form. */
export type FormStamp = 'APPROVED' | 'DENIED';

/** Lifecycle phases of one mounted form. */
export type FormPhase = 'slide-in' | 'thunk' | 'hold' | 'file-away';

/**
 * Ironic denials: requests the bureaucracy always refuses, whatever
 * the player achieved. Table lookup wins over the hash fallback.
 */
export const FORM_IRONIC_DENIALS: readonly string[] = [
  'PERMIT_TO_LEAVE',
  'REFUND_OF_SANITY',
  'COMPLAINT_ABOUT_WALLS',
  'REQUEST_FOR_EXIT_SIGN',
];

/**
 * Route an event id to its stamp. Ironic ids always deny; other ids
 * route deterministically by hash (~1 in 6 denied, stable per id).
 *
 * @param id Stable machine id of the achievement event.
 * @returns The stamp printed on the form.
 */
export function routeStamp(id: string): FormStamp {
  if (FORM_IRONIC_DENIALS.includes(id)) return 'DENIED';
  return hash32(seedFromString(id)) % 6 === 0 ? 'DENIED' : 'APPROVED';
}

/** Letter row used as the second component of a form number. */
const FORM_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Deterministic form number ('417-K') for an event id: three digits
 * derived from the id hash plus a letter row from a salted re-hash.
 *
 * @param id Stable machine id of the achievement event.
 * @returns The form number string shared by all players for this id.
 */
export function formNumber(id: string): string {
  const h = seedFromString(id);
  const digits = String((h % 900) + 100);
  const letter = FORM_LETTERS[seedFromString(id + '/letter') % 26];
  return digits + '-' + letter;
}

/** Full printed heading for a form: 'FORM <n>-<L> — REQUEST: <request>'. */
export function formHeading(id: string, request: string): string {
  return 'FORM ' + formNumber(id) + ' \u2014 REQUEST: ' + request;
}

/** One queued or mounted bureaucratic form. */
export interface FormRecord {
  /** Stable machine id of the achievement event. */
  readonly id: string;
  /** Player-facing request text printed under the heading. */
  readonly request: string;
  /** Printed form number ('417-K'), deterministic in id. */
  readonly number: string;
  /** Full heading line including the request. */
  readonly heading: string;
  /** Stamp routing outcome for this id. */
  readonly stamp: FormStamp;
  /** Current animation phase once mounted (null while queued). */
  phase: FormPhase | null;
  /** Milliseconds elapsed inside the current phase. */
  elapsedMs: number;
  /** Countdown before this form's slide-in starts (tray stagger). */
  startDelayMs: number;
  /** True once the form has been filed away. */
  filed: boolean;
}

/** Minimal structural surface of elements used by the queue. */
export interface FormElementLike {
  className: string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: FormElementLike): unknown;
  remove(): void;
}

/** Minimal structural surface of the document used by the queue. */
export interface FormDocumentLike {
  createElement(tagName: string): FormElementLike;
  head: { appendChild(child: FormElementLike): unknown };
}

/** Options for constructing a FormToasts. */
export interface FormToastsOptions {
  /** Injected document (tests pass a stub; production uses the global). */
  document?: FormDocumentLike | null;
  /** Injected container for the vertical queue element. */
  container?: FormElementLike | null;
  /** Called each time a form finishes filing away. */
  onFiled?: (record: FormRecord) => void;
}

/**
 * Owns the stamped-form toast queue: push() enqueues an achievement
 * event, update(dtMs) drives the stamp phase machine and mounts queued
 * forms FIFO as earlier ones file away. Bursts queue instead of drop.
 *
 *   const forms = new FormToasts({ document, container });
 *   forms.push({ id: 'FIRST_STEPS', request: 'RECOGNITION OF MOVEMENT' });
 *   forms.update(16); // per frame
 */
export class FormToasts {
  private readonly doc: FormDocumentLike | null;
  private readonly root: FormElementLike | null;
  private readonly onFiled: (record: FormRecord) => void;
  /** Every record ever pushed, in arrival order (burst safety). */
  private readonly records: FormRecord[] = [];
  /** Records currently mounted and animating. */
  private readonly mounted: FormRecord[] = [];
  /** DOM element per mounted record (parallel to `mounted`). */
  private readonly els: FormElementLike[] = [];

  constructor(opts: FormToastsOptions) {
    this.onFiled = opts.onFiled ?? (() => undefined);
    const doc = opts.document ?? null;
    const container = opts.container ?? null;
    if (!doc || !container) {
      this.doc = null;
      this.root = null;
      return; // headless mode: model only
    }
    const style = doc.createElement('style');
    style.className = 'bmb-formq-style';
    setText(style, buildCss());
    doc.head.appendChild(style);

    const root = doc.createElement('div');
    root.className = 'bmb-formq';
    container.appendChild(root);
    this.doc = doc;
    this.root = root;
  }

  /**
   * Enqueue an achievement event. Never drops: bursts stack up and
   * mount FIFO as earlier forms file away.
   *
   * @param event The achievement event (id + player-facing request).
   * @returns The created record (already counted even while queued).
   */
  push(event: { id: string; request: string }): FormRecord {
    const number = formNumber(event.id);
    const rec: FormRecord = {
      id: event.id,
      request: event.request,
      number,
      heading: formHeading(event.id, event.request),
      stamp: routeStamp(event.id),
      phase: null,
      elapsedMs: 0,
      startDelayMs: 0,
      filed: false,
    };
    this.records.push(rec);
    if (this.mounted.length < FORM_QUEUE_VISIBLE) this.mount(rec);
    return rec;
  }

  /**
   * Advance every mounted form's phase clock by dtMs, filing finished
   * forms and mounting queued ones in their place.
   *
   * @param dtMs Frame delta in milliseconds (junk values ignored).
   * @returns Number of forms that finished filing away this tick.
   */
  update(dtMs: number): number {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return 0;
    const done: number[] = [];
    for (let i = 0; i < this.mounted.length; i++) {
      const rec = this.mounted[i];
      // tray stagger: hold the form before its slide-in starts
      if (rec.startDelayMs > 0) {
        const step = Math.min(rec.startDelayMs, dtMs);
        rec.startDelayMs -= step;
        continue;
      }
      rec.elapsedMs += dtMs;
      let finished = false;
      while (true) {
        const limit = phaseLimit(rec.phase);
        if (rec.elapsedMs < limit) break;
        if (rec.phase === 'file-away') {
          finished = true;
          break;
        }
        rec.elapsedMs -= limit;
        rec.phase = nextPhase(rec.phase);
      }
      if (finished) done.push(i);
    }
    // File in arrival order (ascending index) so same-tick completions
    // keep FIFO semantics.
    let shift = 0;
    for (const idx of done) {
      this.finishFile(idx - shift);
      shift++;
    }
    while (this.mounted.length < FORM_QUEUE_VISIBLE) {
      const next = this.records.find((r) => !r.filed && r.phase === null);
      if (!next) break;
      this.mount(next);
    }
    return done.length;
  }

  /** Total records ever pushed (queued + mounted + filed). */
  get pushedCount(): number {
    return this.records.length;
  }

  /** Records pushed but not yet mounted (waiting below the tray). */
  get queuedCount(): number {
    return this.records.filter((r) => !r.filed && r.phase === null).length;
  }

  /** Records currently mounted on screen. */
  get activeForms(): readonly FormRecord[] {
    return this.mounted.slice();
  }

  /** Records that have completed the full phase machine. */
  get filedCount(): number {
    return this.records.filter((r) => r.filed).length;
  }

  /** Whether any record was lost (invariant: always false). */
  get droppedAny(): boolean {
    return this.records.length !== this.filedCount + this.mounted.length + this.queuedCount;
  }

  /** Remove the DOM subtree (model stays usable). */
  dispose(): void {
    try {
      this.root?.remove();
    } catch {
      /* already detached */
    }
  }

  /** Mount a queued record into the tray at the start of slide-in. */
  private mount(rec: FormRecord): void {
    rec.phase = 'slide-in';
    rec.elapsedMs = 0;
    // stagger each new tray slot behind the ones already animating so
    // completions land on distinct ticks (and the tray reads as a queue)
    rec.startDelayMs = this.mounted.length * FORM_STAGGER_MS;
    this.mounted.push(rec);
    if (this.root && this.doc) {
      const el = this.doc.createElement('div');
      el.className = 'bmb-form bmb-form-' + rec.stamp.toLowerCase();
      setText(el, rec.heading + String.fromCharCode(10) + '[ ' + rec.stamp + ' ]');
      this.root.appendChild(el);
      this.els.push(el);
    }
  }

  /** Complete a filing form: unmount it and report. */
  private finishFile(index: number): void {
    const rec = this.mounted[index];
    rec.filed = true;
    this.mounted.splice(index, 1);
    // mounted[] and els[] are parallel arrays: same index on both sides.
    const el = this.els.splice(index, 1)[0];
    try {
      el?.remove();
    } catch {
      /* already detached */
    }
    this.onFiled(rec);
  }
}

/** Duration of a phase in ms; file-away is terminal here. */
function phaseLimit(phase: FormPhase | null): number {
  switch (phase) {
    case 'slide-in': return FORM_SLIDE_MS;
    case 'thunk': return FORM_THUNK_MS;
    case 'hold': return FORM_HOLD_MS;
    case 'file-away': return FORM_FILE_MS;
    default: return Infinity;
  }
}

/** The phase that follows phase; after file-away the form is done. */
function nextPhase(phase: FormPhase | null): FormPhase | null {
  switch (phase) {
    case 'slide-in': return 'thunk';
    case 'thunk': return 'hold';
    case 'hold': return 'file-away';
    default: return null;
  }
}

/** Build the queue stylesheet text. */
function buildCss(): string {
  return [
    '.bmb-formq {',
    '  position: fixed;',
    '  left: 50%;',
    '  bottom: 84px;',
    '  transform: translateX(-50%);',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 8px;',
    '  z-index: 7;',
    '  pointer-events: none;',
    '}',
    '.bmb-form {',
    '  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;',
    '  font-size: 11px;',
    '  letter-spacing: 0.05em;',
    '  white-space: pre-line;',
    '  padding: 8px 14px;',
    '  color: rgba(214, 206, 182, 1);',
    '  background: rgba(16, 15, 12, 0.85);',
    '  border: 1px solid rgba(140, 128, 92, 0.55);',
    '  opacity: 0;',
    '  transform: translateY(14px);',
    '}',
    '.bmb-form-approved { border-left: 3px solid rgba(120, 220, 150, 0.9); }',
    '.bmb-form-denied { border-left: 3px solid rgba(220, 96, 84, 0.9); }',
  ].join(String.fromCharCode(10));
}

/** Write text content onto an element without relying on DOM typings. */
function setText(el: FormElementLike, text: string): void {
  (el as unknown as { textContent?: string }).textContent = text;
}
