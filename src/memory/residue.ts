/**
 * F21 Memory Residue Touch — tagged objects play ghost replays of prior tenants.
 *
 * A residue object is a world prop tagged with the tenant whose memory bled
 * into it (kind + tenantSeed). Touching one plays a one-shot ghost-replay
 * script assembled deterministically from tenantSeed: beat count, timing, and
 * lines all come from an RNG keyed only by (tenantSeed, kind), so identical
 * seeds produce byte-identical scripts on every instance and every run.
 * Scripts stay consistent with the kind table: presence/action beats always
 * speak through the archetype's own object and action vocabulary. One touch
 * per visit — repeat touches return null until the player leaves and
 * markLeft() re-arms the field. Pure simulation core — no Babylon, no game
 * imports; the mount injects objects and the interact callback.
 */
import { RNG, hash2i } from '../core/rng';

/** Prop archetypes that carry prior-tenant residue. */
export type ResidueKind =
  | 'armchair'
  | 'rotaryphone'
  | 'suitcase'
  | 'highchair'
  | 'transistorradio'
  | 'weddingphoto';

/** Vocabulary + behavior fragments for one archetype. */
export interface ResidueArchetype {
  /** what the object is, named inside presence beats */
  object: string;
  /** what its tenant used to do here, verbatim pool for action beats */
  actions: readonly string[];
}

/**
 * The kind table: archetype consistency contract for ghost replays. Every
 * action beat in a script is drawn verbatim from its kind's `actions`, and
 * every presence beat names its kind's `object`.
 */
export const RESIDUE_KINDS: Readonly<Record<ResidueKind, ResidueArchetype>> = {
  armchair: {
    object: 'armchair',
    actions: [
      'rocking slightly, though nobody moved',
      'holding a book open at the same page for hours',
      'counting the hallway lights through the doorway',
    ],
  },
  rotaryphone: {
    object: 'rotary phone',
    actions: [
      'dialing a number with seven nines in it',
      'lifting the receiver before it rang',
      'listening to a dial tone like it was a voice',
    ],
  },
  suitcase: {
    object: 'suitcase',
    actions: [
      'packing it, unpacking it, packing it again',
      'weighing it in both hands at the door they never opened',
      'writing a name on the tag, crossing it out, writing it again',
    ],
  },
  highchair: {
    object: 'high chair',
    actions: [
      'spooning food that was never eaten into a mouth that never came',
      'clipping the safety strap for a child who was somewhere else',
      'humming a lullaby to the empty seat',
    ],
  },
  transistorradio: {
    object: 'transistor radio',
    actions: [
      'turning the dial one notch at a time, hunting a station',
      'tapping the casing twice whenever the signal drifted',
      'leaving it on between stations all night for the static',
    ],
  },
  weddingphoto: {
    object: 'framed wedding photograph',
    actions: [
      'straightening the frame after every door slam',
      'covering the faces with a thumb, then uncovering them',
      'turning the frame face-down before sleeping',
    ],
  },
};

/** Utterances any prior tenant may leave behind, shared across archetypes. */
export const TENANT_VOICES: readonly string[] = [
  '"we only lived here eleven months"',
  '"the rent was fine. the walls were not."',
  '"I left the light on for you. I should not have."',
  '"tell whoever finds this that we tried to leave politely"',
  '"it learned our schedules before we had them"',
];

/** One replayed fragment of a prior tenant's presence. */
export interface ResidueBeat {
  /** seconds after touch at which the mount should play the beat */
  atSec: number;
  /** 'presence' names the object, 'action' shows the tenant using it, 'voice' speaks */
  channel: 'presence' | 'action' | 'voice';
  text: string;
}

const SCRIPT_SALT = 0x7e51d;

/**
 * Deterministic ghost-replay script for one residue object. Same (kind,
 * tenantSeed) → byte-identical beats; beats arrive in increasing time order;
 * first beat lands within 1.5 s of the touch.
 */
export function buildResidueScript(kind: ResidueKind, tenantSeed: number): ResidueBeat[] {
  const arch = RESIDUE_KINDS[kind];
  const rng = new RNG(hash2i(tenantSeed, hash2i(1, kind.length, SCRIPT_SALT)));
  const count = rng.int(3, 6);
  const beats: ResidueBeat[] = [];
  let t = rng.range(0.4, 1.5);
  // Channel order always opens on presence so every replay anchors the object.
  const channels: Array<ResidueBeat['channel']> = ['presence'];
  while (channels.length < count) {
    channels.push(rng.chance(0.45) ? 'voice' : 'action');
  }
  let lastAction = -1;
  for (let i = 0; i < count; i++) {
    if (i > 0) t += rng.range(1.1, 3.2);
    const ch = channels[i];
    if (ch === 'presence') {
      beats.push({ atSec: t, channel: 'presence', text: 'someone who lived by this ' + arch.object + ' is still here' });
    } else if (ch === 'voice') {
      beats.push({ atSec: t, channel: 'voice', text: rng.pick(TENANT_VOICES) });
    } else {
      // Never repeat the same action fragment back to back.
      let idx = rng.int(0, arch.actions.length);
      if (idx === lastAction) idx = (idx + 1) % arch.actions.length;
      lastAction = idx;
      beats.push({ atSec: t, channel: 'action', text: arch.actions[idx] });
    }
  }
  return beats;
}

/** A world object tagged with the tenant whose memory soaked into it. */
export interface ResidueObject {
  id: string;
  x: number;
  z: number;
  kind: ResidueKind;
  tenantSeed: number;
}

/**
 * Field of residue objects owned by the mount. Tracks touched state per
 * visit; {@link markLeft} ends the visit and re-arms every object exactly once.
 */
export class ResidueField {
  private objects = new Map<string, ResidueObject>();
  private touched = new Set<string>();

  constructor(public readonly seed: number) {}

  /** Adds or replaces a residue object by id. Does not reset touched state. */
  add(o: ResidueObject): void {
    this.objects.set(o.id, o);
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }

  /** Number of registered residue objects. */
  get size(): number {
    return this.objects.size;
  }

  /**
   * The player touches a tagged object. Returns the deterministic ghost-replay
   * script for its tenantSeed, or null when the id is unknown or the object
   * already played during this visit.
   */
  interact(id: string): ResidueBeat[] | null {
    if (this.touched.has(id)) return null;
    const o = this.objects.get(id);
    if (!o) return null;
    this.touched.add(id);
    return buildResidueScript(o.kind, o.tenantSeed);
  }

  /**
   * Player left the area: re-arm every object so each can replay once more
   * next visit. Idempotent mid-visit-safe call for the mount.
   */
  markLeft(): void {
    this.touched.clear();
  }

  /** True when this object already played its replay during the current visit. */
  wasTouched(id: string): boolean {
    return this.touched.has(id);
  }
}
