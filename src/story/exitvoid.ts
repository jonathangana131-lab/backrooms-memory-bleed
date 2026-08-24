/**
 * F50 — The Exit that isn't: an ultra-rare fire-exit door that opens into
 * a white void epilogue room instead of another corridor.
 *
 * Pure gate + descriptor model (mounting lives in game.ts, not here):
 *
 * - Gate: door-candidate events carry their exploration-time stamp; at
 *   most one seeded roll happens per EXITVOID_CHECK_INTERVAL_SEC slot.
 *   The per-roll probability is derived so the expected spawn count is
 *   exactly 1 per 8h (28800 s) of exploration: p = interval / 28800.
 *   A session spawns at most once — after the first gated-in exit every
 *   further event is a no-op until a new session tracker is built.
 * - Room: when the player takes the exit, buildEpilogueRoom(seed)
 *   produces a descriptor whose cells are ALL white-flagged and which is
 *   exitless by construction. Entry goes through an injected teleport
 *   hook (enterEpilogue). The ONLY way out is wake-to-title
 *   (WAKE_EXIT); there is no in-world door back.
 *
 * Determinism: all placement decisions hash (seed, slot) via
 * src/core/rng.ts; identical seed and timeline ⇒ identical behavior.
 */

import { hash2i } from '../core/rng';

/** Exploration-time seconds between consecutive gate rolls. */
export const EXITVOID_CHECK_INTERVAL_SEC = 60;

/** Expected exploration seconds between spawns: 1 per 8 hours. */
export const EXITVOID_EXPECTED_INTERVAL_SEC = 28800;

/**
 * Per-roll gate probability derived from the calibration target:
 * p × (28800 / 60 rolls per 8h session) = 1 ⇒ p = 1/480 ≈ 0.0020833.
 */
export const EXITVOID_PER_CHECK_P =
    EXITVOID_CHECK_INTERVAL_SEC / EXITVOID_EXPECTED_INTERVAL_SEC;

/** Salt separating the fire-exit gate hash from other seed streams. */
const GATE_SALT_U32 = 0xf1e5d00a >>> 0;

/** How the player can leave the epilogue room: only waking to title. */
export const WAKE_EXIT = 'wake-to-title' as const;
export type WakeExit = typeof WAKE_EXIT;

/** Descriptor kind tag distinguishing this room from normal interiors. */
export const EXIT_VOID_KIND = 'exit-void' as const;

/**
 * One cell of the epilogue room grid. Every cell is white-flagged:
 * the void renders as uniform featureless white with no geometry,
 * props, or landmarks to walk toward.
 */
export interface ExitVoidCell {
    cx: number;
    cz: number;
    /** Always true in v1 — the entire room is the same white nothing. */
    whiteFlagged: boolean;
}

/**
 * Epilogue room descriptor produced when the player enters the exit.
 * `cells` covers a square grid around the arrival point, every cell
 * white-flagged; `exits` is empty and `exitless` true by construction —
 * the documented leave path is wake-to-title only.
 */
export interface EpilogueRoomDescriptor {
    kind: typeof EXIT_VOID_KIND;
    seed: number;
    radiusCells: number;
    cells: ExitVoidCell[];
    /** No exits exist; always empty (frozen). */
    exits: readonly never[];
    /** Redundant validity flag asserted alongside `exits`. */
    exitless: true;
    /** The one leave mode; game mounts map wake input to the title screen. */
    leaveMode: WakeExit;
    /** World-space arrival point fed to the injected teleport hook. */
    centerWorld: { x: number; z: number };
}

/** Injected teleport seam: moves the player to (x,z) world coordinates. */
export type TeleportHook = (x: number, z: number) => void;

/**
 * Seeded gate roll for one check slot. Pure and order-independent:
 * whether the exit manifests in slot k depends only on (seed, k).
 *
 * @param seed Session run seed.
 * @param slotIndex Exploration-time slot number (floor(sec / interval)).
 * @returns True when the fire-exit manifests in this slot.
 */
export function exitVoidGateRoll(seed: number, slotIndex: number): boolean {
    return hash2i(slotIndex, seed, GATE_SALT_U32) / 4294967296 < EXITVOID_PER_CHECK_P;
}

/**
 * Per-session gate state for the fire-exit. Feed door-candidate events
 * with their exploration-time stamps; the tracker rolls at most once per
 * interval slot and latches after the first manifest so a session can
 * never see the exit twice.
 */
export class ExitVoidTracker {
    /** True once this session's exit has manifested. */
    spawned = false;
    /** Exploration-time stamp of the manifestation (or -1). */
    spawnedAtSec = -1;
    private lastRolledSlot = -1;

    constructor(public readonly seed: number) {}

    /**
     * Report one door-candidate event at the given exploration time.
     * Multiple events inside the same interval slot produce a single roll
     * (the first), keeping the expectation time-based rather than
     * click-rate-based.
     *
     * @param explorationSec Elapsed exploration time in seconds (monotonic).
     * @returns True exactly when this event opens the fire-exit.
     */
    onDoorCandidate(explorationSec: number): boolean {
        if (this.spawned) return false;
        const slot = Math.floor(Math.max(0, explorationSec) / EXITVOID_CHECK_INTERVAL_SEC);
        if (slot === this.lastRolledSlot) return false;
        this.lastRolledSlot = slot;
        if (!exitVoidGateRoll(this.seed, slot)) return false;
        this.spawned = true;
        this.spawnedAtSec = Math.max(0, explorationSec);
        return true;
    }
}

/**
 * Build the epilogue-room descriptor for a session seed. Deterministic:
 * same seed ⇒ deep-equal descriptor (arrival jitter included). Every
 * cell in the (2r+1)² grid is white-flagged and there are no exits.
 *
 * @param seed Session run seed.
 * @param radiusCells Grid radius in cells; defaults to 3 (7×7 room).
 * @returns Frozen descriptor describing the white void epilogue room.
 */
export function buildEpilogueRoom(seed: number, radiusCells = 3): EpilogueRoomDescriptor {
    const r = Math.max(1, Math.floor(radiusCells));
    // Arrival offset derives from the seed so rooms differ between runs
    // without breaking determinism within one.
    const h = hash2i(seed, 0x3e17, GATE_SALT_U32);
    const jx = ((h >>> 8) % 1000 - 500) / 500 * 2.0;
    const jz = ((h >>> 20) % 1000 - 500) / 500 * 2.0;
    const cells: ExitVoidCell[] = [];
    for (let cz = -r; cz <= r; cz++) {
        for (let cx = -r; cx <= r; cx++) {
            cells.push({ cx, cz, whiteFlagged: true });
        }
    }
    const desc: EpilogueRoomDescriptor = {
        kind: EXIT_VOID_KIND,
        seed,
        radiusCells: r,
        cells,
        exits: Object.freeze([]),
        exitless: true,
        leaveMode: WAKE_EXIT,
        centerWorld: { x: jx, z: jz },
    };
    return Object.freeze(desc);
}

/**
 * Enter the epilogue room through the injected teleport hook: moves the
 * player to the descriptor's arrival point exactly once. Mounts own what
 * happens on the far side of the hook; leaving is wake-to-title only
 * (`descriptor.leaveMode`).
 *
 * @param room Descriptor from buildEpilogueRoom for this session.
 * @param teleport Host teleport seam receiving the arrival coordinates.
 */
export function enterEpilogue(room: EpilogueRoomDescriptor, teleport: TeleportHook): void {
    teleport(room.centerWorld.x, room.centerWorld.z);
}
