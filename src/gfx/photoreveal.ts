/**
 * Anomaly photography (F41): photographs see what the player cannot.
 *
 * Entities that hide from the live renderer still register in captured
 * frames. Developing a capture is a pure function of the capture descriptor:
 * a photo reveals an entity iff one was present AND a seeded threshold keyed
 * by the frame hash passes, so the same frameHash+seed always develops
 * identically while the live renderer stays blind. Revealed captures carry a
 * deterministic silhouette descriptor a renderer can draw without any live
 * entity state. Developed records feed a gallery list model whose tier rises
 * with the number of successful reveals.
 *
 * Pure module - no DOM, no Babylon imports, all randomness via src/core/rng.
 */
import { hash2i, RNG } from '../core/rng';

/**
 * Salt so photoreveal draws never correlate with any other feature keyed on
 * the same (frameHash, seed) pair.
 */
const PHOTOREVEAL_SALT = 0x70c1;

/**
 * Probability that a capture taken while an entity is present actually
 * develops a reveal. Fixed by design: photography is a consistent lens on
 * the hidden world, not a tunable.
 */
export const REVEAL_RATE = 0.4;

/** What the camera was pointed at when the shutter fired. */
export interface CaptureDescriptor {
  /**
   * Stable hash of the captured frame content (renderer's frame hash).
   * Keys both the reveal threshold and the silhouette, so re-developing the
   * identical frame reproduces the identical photograph.
   */
  frameHash: number;
  /**
   * Whether an entity occupied the frame - including entities flagged
   * hidden from the live renderer. The live renderer cannot read this.
   */
  entityPresence: boolean;
  /** Master run seed. */
  seed: number;
}

/**
 * Geometry of a developed entity silhouette, in meters/radians, ready for a
 * renderer to extrude without consulting live entity state.
 */
export interface SilhouetteDescriptor {
  /** Standing height of the silhouette in meters (> 0). */
  heightM: number;
  /** Shoulder width in meters (> 0). */
  widthM: number;
  /** Head tilt in radians, signed. */
  headTiltRad: number;
  /** Number of visible limb masses (>= 2, not guaranteed anatomical). */
  limbCount: number;
  /** How far limbs splay from the body axis in [0, 1]. */
  limbSplay: number;
  /** Edge softness in [0, 1]: 0 razor-cut, 1 dissolving into grain. */
  edgeSoftness: number;
}

/** The result of developing one capture. */
export interface RevealRecord {
  /** True iff an entity was present and the seeded threshold passed. */
  revealed: boolean;
  /** Silhouette geometry when revealed; null otherwise. */
  silhouette: SilhouetteDescriptor | null;
}

/**
 * Develop one capture into its reveal record.
 * Pure: the same descriptor always returns a deep-equal record, in any
 * process, in any call order. `revealed` iff `entityPresence` is true and
 * the seeded draw for (frameHash, seed) passes REVEAL_RATE - so captures
 * without an entity NEVER reveal one, and captures with one reveal at the
 * fixed seeded rate.
 * @param capture Capture descriptor injected by the camera pipeline.
 * @returns Reveal record; `silhouette` is null unless revealed.
 */
export function develop(capture: CaptureDescriptor): RevealRecord {
  if (!capture.entityPresence) return { revealed: false, silhouette: null };
  const draw =
    hash2i(capture.seed | 0, capture.frameHash | 0, PHOTOREVEAL_SALT) / 4294967296;
  if (draw >= REVEAL_RATE) return { revealed: false, silhouette: null };
  return { revealed: true, silhouette: silhouetteFor(capture.frameHash, capture.seed) };
}

/**
 * Deterministic silhouette geometry for a revealed frame.
 * @param frameHash Stable hash of the captured frame content.
 * @param seed Master run seed.
 */
function silhouetteFor(frameHash: number, seed: number): SilhouetteDescriptor {
  const rr = new RNG(hash2i(seed | 0, frameHash | 0, PHOTOREVEAL_SALT + 11));
  const r3 = () => Math.round(rr.next() * 1000) / 1000;
  return {
    heightM: Math.round((1.4 + rr.next() * 1.1) * 100) / 100,
    widthM: Math.round((0.35 + rr.next() * 0.45) * 100) / 100,
    headTiltRad: Math.round((rr.next() * 2 - 1) * 0.6 * 1000) / 1000,
    limbCount: rr.int(2, 6),
    limbSplay: r3(),
    edgeSoftness: r3(),
  };
}

/** One photo as listed by the gallery model. */
export interface GalleryPhotoEntry {
  /** Frame content hash identifying the photo. */
  frameHash: number;
  /** Seed the photo was captured under. */
  seed: number;
  /** Whether developing this photo revealed an entity. */
  revealed: boolean;
}

/** Gallery tiers, ascending. A tier is reached at minReveals lifetime reveals. */
export interface GalleryTier {
  /** Inclusive minimum lifetime revealed-count for this tier. */
  minReveals: number;
  /** Display label shown in the gallery header. */
  label: string;
}

/**
 * Gallery tiers by lifetime reveal count. Thresholds are ascending and the
 * first entry anchors tier 0 at zero reveals. Order matters: galleryTier
 * picks the LAST tier whose threshold the count meets.
 */
export const GALLERY_TIERS: readonly GalleryTier[] = [
  { minReveals: 0, label: 'snapshots' },
  { minReveals: 3, label: 'evidence' },
  { minReveals: 8, label: 'case file' },
  { minReveals: 15, label: 'the unhidden' },
];

/**
 * Gallery list model derived from developed photos.
 * @param photos Photos in capture order (order is preserved in the model).
 */
export interface GalleryListModel {
  /** All listed photos, capture order preserved. */
  photos: GalleryPhotoEntry[];
  /** Lifetime count of photos that revealed an entity. */
  revealedCount: number;
  /** Index into GALLERY_TIERS earned by revealedCount. */
  tierIndex: number;
}

/**
 * Build the gallery list model from developed photo entries.
 * Pure: same input list always yields a deep-equal model. The tier is a
 * pure function of revealedCount alone, so re-sorting or re-deriving the
 * list elsewhere can never change a gallery's tier.
 * @param photos Photo entries in capture order.
 */
export function buildGalleryModel(photos: readonly GalleryPhotoEntry[]): GalleryListModel {
  let revealedCount = 0;
  for (const p of photos) if (p.revealed) revealedCount++;
  return { photos: [...photos], revealedCount, tierIndex: galleryTier(revealedCount) };
}

/**
 * Resolve the gallery tier index earned by a lifetime reveal count.
 * Exact: count 0..GALLERY_TIERS[1].minReveals-1 maps to 0, and each later
 * threshold promotes exactly at its own minReveals. Monotone non-decreasing
 * in count; counts beyond the last tier saturate at the highest tier.
 * @param revealedCount Lifetime count of revealing photos (>= 0).
 */
export function galleryTier(revealedCount: number): number {
  const count = Math.max(0, Math.floor(revealedCount) || 0);
  let tier = 0;
  for (let i = 1; i < GALLERY_TIERS.length; i++) {
    if (count >= GALLERY_TIERS[i].minReveals) tier = i;
  }
  return tier;
}
