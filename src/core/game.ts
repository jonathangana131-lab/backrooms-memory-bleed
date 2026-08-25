/**
 * Game: owns the Babylon engine/scene, wires all subsystems,
 * runs the frame update and manages game states.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
// WebGPU engine lacks createDynamicTexture without these side-effect imports
import '@babylonjs/core/Engines/Extensions/engine.dynamicTexture';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture';
import { Scene } from '@babylonjs/core/scene';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Input } from './input';
import { seedFromString, hash2i, RNG } from './rng';
import { moveCircle, hasLineOfSight } from '../world/collision';
import { CELL as CELL_SIZE, worldToChunk } from '../world/constants';
import { createMaterials, type MaterialSet } from '../gfx/materials';
import { LightingRig } from '../gfx/lighting';
import { ChunkManager } from '../world/chunkManager';
import { PlayerController } from '../player/controller';
import { Flashlight } from '../player/flashlight';
import { DustMotes } from '../gfx/dust';
import { attachClipboardProp, HumanFigure, type HumanType } from '../entities/humans';
import { AudioEngine } from '../audio/audio';
import { SelfRadio, type FeedEntry } from '../audio/selfradio';
import { VoiceMemoStore, ZONE_GEN_MAX } from '../audio/voicememo';
import { PositionalHum } from '../audio/positional';
import { WatcherSteps } from '../audio/approach';
import { SurfaceDetector } from '../player/surfacedetect';
import { SurfaceFootsteps } from '../audio/surfaces';
import { DynamicScore } from '../audio/music';
import { ExteriorBleed } from '../audio/exterior';
import { UI } from '../ui/ui';
import { SaveDB, type SaveSlot, type SettingsData } from '../save/db';
import { computeScars, serializeScars, type RouteSample } from '../save/scarring';
import {
  createLedger,
  loadLedger,
  saveLedger,
  mergeExpedition,
  type LedgerEntry,
  type LedgerStorageLike,
} from '../save/ledger';
import { MemoryField, MemoryKind, MEMORY_NAMES, sectorName } from '../memory/field';
import { MemoryWeather } from '../memory/weather';
import { HorrorDirector, type DirectorHost } from '../director/director';
// F48: per-run director temperament — pacing personality selected from the seed
import { pacingRngFor, temperamentForRun } from '../director/persona';
// F90: fear-learning telemetry — scare-response events tune per-context pacing
import { DirectorLearning } from '../director/learning';
// F91: staged wake cinematic played additively over the wake-intro window
import { stageWakeCinematic, WakeCinematicPlayer, type WakeStaging } from '../story/wakecinematic';
// F91 v1.1 debt: the run-start mount that actually plays the staged shots
import { WakeMount } from '../story/wakemount';
// F50: the exit that isn't — ultra-rare fire-exit door into a white epilogue room
import { buildEpilogueRoom, enterEpilogue, ExitVoidTracker } from '../story/exitvoid';
// F100: the credits walk — rolling credits over an endless corridor of screenshots
import { buildCreditsWalk, CreditsWalker, type CreditsWalkPlan, type ScreenshotRef } from '../story/creditswalk';
import type { StoredPhoto } from '../ui/gallery';
import { AnomalySystem, type AnomalyHost } from '../director/anomalies';
import { ChunkDeltas } from '../world/chunkDeltas';
import { RealityErosion } from '../director/erosion';
import { HumanManager } from '../entities/manager';
import { RoachEcosystem, type RoachGrid, type CabinetSite, type SpawnCandidate } from '../entities/roaches';
import { StorySystem } from '../story/story';
// Wave A: pure logic modules (no Scene, no AudioContext)
import { SettingsManager, type GameSettings } from '../ui/settings';
import { ACCESSIBILITY_KEY, AccessibilityManager, AccessibilityController, type A11yDocumentLike } from '../ui/accessibility';
// F99: colorblind pattern language for anomaly captions
import { anomalySignal, type SeverityClass } from '../ui/colorblindSignals';
import {
  buildSettingsPanel,
  compositeStore,
  defaultSections,
  settingsStoreAdapter,
  accessibilityStoreAdapter,
  type SettingsPanelHandle,
} from '../ui/settingspanel';
import { NoteReread } from '../story/reread';
import { DifficultyHints } from '../ui/hints';
import { StoryBeats } from '../story/beats';
import { EndStats, type ExpeditionStats } from '../ui/endstats';
import { EndCapture } from '../ui/endcapture';
import { createWallCracks, type WallCracks } from '../world/cracks';
import { createStainGrowth, type StainGrowth } from '../world/stains-growth';
import { createGraffitiEvolution, type GraffitiEvolution } from '../world/graffiti-evolution';
import { DayCycle } from '../gfx/daycycle';
import { EmergencyWiring } from '../gfx/emergency-wiring';
import { HeatShimmer, MAX_SHIMMER_ZONES, shimmerIntensity, type FixtureScreen } from '../gfx/heatshimmer';
import { PhotoMode } from '../ui/photomode';
import { CHUNK_SIZE, WALL_H } from '../world/constants';
// Wave B: audio pack (ctx-gated, constructed in ensureAudioIntegrations())
import { DoorCreaks } from '../audio/doors';
import { StructureGroans } from '../audio/groans';
import { CrowdAmbience } from '../audio/crowd';
import { LoreStings } from '../audio/loresting';
import { BatteryCues } from '../audio/batterycue';
import { StomachAudio } from '../audio/hungerpangs-consumer';
import { VentAudio } from '../audio/vents';
import { ElevatorAmbience } from '../audio/elevator';
import { ElectricPops } from '../audio/electricpop';
import { FanSpeedAudio, type FanSpeedState } from '../audio/fanspeeds';
import { CabinetCreaks } from '../audio/cabinetcreak';
import { EchoSites } from '../audio/echoes';
import { FanAudio } from '../audio/fanaudio';
// F2 central mounts: breath embodiment + district identity beds + clarity policy
import { mountPlayerBreath, type BreathHandle } from '../audio/breath';
import { AreaIdentityBeds } from '../audio/areaidentity';
import { applyRenderClarity, enforceWebGPULightBudget, type RenderClarityHandle } from '../gfx/renderclarity';
// Wave-1 dread features (F5/F6): binaural whispers + rationed total-mix duck
import { WhisperField } from '../audio/whisperfield';
import { DreadSilence } from '../audio/dreadsilence';
// F7 footstep DNA: gait classifier fed from earshot strides
import { FootstepDNA, CLASSIFY_WINDOW, gaitSignature, type StepObservation } from '../audio/footstepdna';
// F14 fall stagger: post-hard-fall control damp + screen blur envelope
import { FallStagger } from '../player/fallstagger';
// F8 gait-synced dread: stride onsets pulled toward the heartbeat
import { dreadOffset, excitedHeartbeatPeriod } from '../audio/gaitdread';
import { BOB_FREQUENCY } from '../player/controller';
// Wave B: scene pack
import { PostFX } from '../gfx/postfx';
import { FaunaWiring } from '../entities/faunawiring';
import { GazeWiring } from '../entities/gaze-wiring';
import { GazeController } from '../entities/gaze';
// Wave B: DOM overlays
import { Minimap } from '../ui/minimap';
import { Compass } from '../ui/compass';
import { WeatherUI } from '../ui/weatherui';
// Wave C (C-3..C-8): ordered-chain modules
import { Journal } from '../ui/journal';
import { JournalFeed } from '../story/journal-feed';
import { JournalWiring } from '../story/journal-wiring';
import { Tracker, type TrackerState } from '../ui/tracker';
import { TrackerFeed } from '../ui/tracker-wiring';
import { CheckpointManager } from '../story/checkpoints';
import { SaveScreen } from '../ui/savescreen';
import { WatcherIntroController } from '../story/watcherintro';
import { PhotoGallery } from '../ui/gallery';
import { formatExtended, type ExtendedStats } from '../ui/endstatsext';
import { createFogVariation } from '../gfx/fogvariation';
// F17: echo geography — the halls record your sounds and give them back
import { EchoGeography } from '../story/echogeography';
// F18: time slippage — clocks drift apart inside memory-saturated zones
import { TimeSlippage } from '../story/timeslippage';
// F21: memory residue — tagged props play prior-tenant ghost replays
import { ResidueField, RESIDUE_KINDS, type ResidueKind } from '../memory/residue';
// F11: torch view-model — held-hand pose model driving a camera-attached mesh
import { TorchView, type TorchViewTarget } from '../gfx/torchview';
// F42: night-vision camcorder — IR ramp mode draining the torch cell
import { NightVision } from '../gfx/nightvision';
// F22: gravity ambivalence — saturation zones tilt the camera horizon
import { GravityTilt } from './gravitytilt';
import { LEAN_ROLL_MAX } from '../player/leanpeek';
// Mount batch B: player-body signals (pure logic, no Scene/AudioContext)
import { HandTremor } from '../player/tremor';
import { BlinkScheduler } from '../player/blinks';
import { AdrenalineSystem } from '../player/adrenaline';
import { HungerPangs } from '../player/hunger';
import { FlickerBattery } from '../player/flickerbattery';
// Batch C mounts: grounded entity gossip + lying compass + journal hand decay
import { GossipSource, type VisitedSite } from '../entities/gossip';
import { LyingCompass, type MemoryWell } from '../ui/lyingcompass';
import { degradationIndex, entryJournalFont } from '../ui/journalfont';
// Social-entity mounts (F26/F32/F61): archivist, custodian, chapel hymn
import { Archivist, ARCHIVIST_STORE_PREFIX, reactionForPhotos } from '../entities/archivist';
import { CustodianWiring, parseGraffitiMarkingId, type GraffitiHit } from '../entities/custodian';
import { ChapelChoir, HYMN_CHOIR_COUNT, type ChapelAnchor } from '../entities/hymn';
import type { DiscoveryEntry } from '../audio/hymn';
import { CartSqueaks } from '../audio/cartsqueak';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Ray } from '@babylonjs/core/Culling/ray';
// F47: date-derived shared daily seed + discovery checklist
import { DailyRite } from '../ui/dailyrite';
// F49: independent accessibility pack effectors (zero-when-off guarantees)
import { createAccessibilityPack, type AccessibilityPack } from '../ui/accessibilitypack';
// F93: diegetic menu projection math + textured wall plane
import { faceTowards, type MenuContent, type WallPlane } from '../ui/diegmenus';
import { WallMenuPlane } from '../ui/wallmenu';
// F97: stamped bureaucratic achievement forms
import { FormToasts, type FormDocumentLike, type FormElementLike } from '../ui/formtoasts';
import { setAchievementToastSink } from '../ui/tracker-wiring';
// F27: coordinated multi-watcher stalks at story stage >= 3
import { WatcherPack, STAGE_GATE, type PackInput } from '../entities/watcherpacks';
// F28: furniture mimics - crate/chair/locker entities frozen while observed
import { MimicPropWiring, type MimicPropAnchor, type MimicVariant } from '../entities/mimicwiring';
// F66: doppelganger letters drafted over the recorded choice ledger
import { DoubleLetters, CHOICE_KINDS, type ChoiceLedgerEntry, type ChoiceKind, type DoppelLetter } from '../story/doubleletters';

export type GameState = 'menu' | 'playing' | 'paused' | 'credits';

const SPAWN_X = 1.25;
const SPAWN_Z = 1.25;
/** F22: hard roll cap of the gravity tilt, in radians (GravityTilt.TILT_MAX_DEG). */
const TILT_MAX_RAD = (5 * Math.PI) / 180;

/** F29: per-run salt for the gossip RNG, so identical seeds replay identically. */
const GOSSIP_SALT = 0x60a55;

/** F26: camera range inside which a capture counts as photographing the Archivist. */
const SOCIAL_PHOTO_RANGE_M = 14;
/** F61: distance from the chapel inside which hymn lines surface as captions. */
const SOCIAL_CHOIR_EARSHOT_M = 26;

/** F94: seconds between coarse memory-well sweeps of the neighborhood. */
const COMPASS_RESAMPLE_SEC = 2;
/** F94: coarse sample-grid spacing in meters for well detection. */
const COMPASS_WELL_GRID_M = 15;
/** F94: minimum memory intensity for a grid sample to count as a well. */
const COMPASS_WELL_MIN_INTENSITY = 0.25;

/** F97: bureaucratic REQUEST text printed on each achievement's form. */
const ACHIEVEMENT_FORM_REQUESTS: Readonly<Record<string, string>> = {
  first_steps: 'RECOGNITION_OF_MOTION',
  first_beacon: 'VERIFICATION_OF_SIGNAL',
  half_way: 'PARTIAL_SURVEY_CREDIT',
  all_beacons: 'FULL_SURVEY_CERTIFICATION',
  landmark_visitor: 'ROOM_TOURISM_PERMIT',
  note_collector: 'ARCHIVAL_READING_LICENSE',
  survivor: 'EXTENDED_STAY_WAIVER',
  threshold_crosser: 'PERMIT_TO_LEAVE',
};

/** F93: menu content projected onto the title-screen wall. */
const TITLE_WALL_MENU: MenuContent = {
  id: 'title-wall',
  title: 'BACKROOMS: MEMORY BLEED',
  items: [
    { id: 'new', label: 'NEW EXPEDITION' },
    { id: 'continue', label: 'CONTINUE' },
    { id: 'settings', label: 'SETTINGS' },
  ],
};

/** F93: menu content projected onto the pause wall. */
const PAUSE_WALL_MENU: MenuContent = {
  id: 'pause-wall',
  title: 'SIGNAL HELD',
  items: [
    { id: 'resume', label: 'RESUME' },
    { id: 'settings', label: 'SETTINGS' },
    { id: 'quit', label: 'SAVE & QUIT' },
  ],
};

/** F96: seconds between journal-hand restyles of an open note body. */
const JOURNAL_RESTYLE_SEC = 1;
/** F96: opacity lost per unit of glyph-break probability at full break. */
const JOURNAL_OPACITY_LOSS_PER_BREAK = 0.15;

/** F31: fixed simulation step for roach ecosystem ticks (seed-replayable). */
const ROACH_TICK_SEC = 0.5;
/** F31: metres from a food-store prop its food signal reaches. */
const ROACH_FOOD_RADIUS_M = 6;
/** F31: hard cap on cabinet fixtures offered to one run's ecosystem. */
const ROACH_CABINET_CAP = 64;

// ---- F90 director-learning feed tunables ----
/** F90: dwelling this long inside a landmark room / beside a beacon is a linger. */
const LEARNING_LINGER_SEC = 5;
/** F90: beacon radius (m) counted as "at the beacon" for the linger detector. */
const LEARNING_LINGER_RADIUS_M = 6;
/** F90: seconds between pacing-bias captions read off suggestPhaseBias(). */
const LEARNING_BIAS_CAPTION_SEC = 120;

// ---- F91 wake-cinematic additive gains ----
/** F91: metres of camera drift per unit of staged pose x/z offset. */
const WAKE_POS_GAIN_M = 0.14;
/** F91: mid height of the staged pose y range; y offsets are centered on it. */
const WAKE_POS_Y_MID_M = 0.85;
/** F91: radians of gaze pull per radian of staged pose look direction. */
const WAKE_LOOK_GAIN_RAD = 0.08;
/** F91: radians of lens breath per unit of normalized staged fov deviation. */
const WAKE_FOV_GAIN_RAD = 0.35;

/** Wave C: local +Z fed to camera direction queries (same convention the
 *  compass marker cull uses for world-space forward). */
const CAMERA_FORWARD = new Vector3(0, 0, 1);

/** Wave A (A-1a): quality preset <-> legacy numeric quality mapping. */
function presetToQualityNum(q: string): number {
  return q === 'low' ? 0.45 : q === 'medium' ? 0.6 : 1;
}
function qualityNumToPreset(q: number): 'low' | 'medium' | 'high' {
  return q >= 0.9 ? 'high' : q >= 0.55 ? 'medium' : 'low';
}

export class Game {
  engine!: Engine;
  scene!: Scene;
  camera!: TargetCamera;
  input!: Input;
  mats!: MaterialSet;
  lighting!: LightingRig;
  chunks!: ChunkManager;
  player!: PlayerController;
  flashlight!: Flashlight;
  dust!: DustMotes;
  audio = new AudioEngine();
  ui!: UI;
  mem!: MemoryField;
  weather!: MemoryWeather;
  director!: HorrorDirector;
  erosion = new RealityErosion();
  humans!: HumanManager;
  story!: StorySystem;

  // ---- integrated audio/gameplay systems (constructed lazily, ctx-gated) ----
  humAudio: PositionalHum | null = null;
  watcherSteps: WatcherSteps | null = null;
  surfaceDetector: SurfaceDetector | null = null;
  surfaceFootsteps: SurfaceFootsteps | null = null;
  score: DynamicScore | null = null;
  exterior: ExteriorBleed | null = null;
  private audioModulesReady = false;


  // ---- Wave A pure-logic integrations (nullable + guarded, see init()) ----
  private settingsManager: SettingsManager | null = null;
  private settingsPanel: SettingsPanelHandle | null = null;
  /** Detaches the WebGPU light-budget observer (no-op on WebGL engines). */
  private webgpuLightBudgetDisposer: (() => void) | null = null;
  private syncingSettings = false;
  private a11yMgr: AccessibilityManager | null = null;
  private a11yCtl: AccessibilityController | null = null;
  private reread: NoteReread | null = null;
  private hints: DifficultyHints | null = null;
  private hintsTimer = 0;
  private emergencyWiring: import('../gfx/emergency-wiring').EmergencyWiring | null = null;
  private heatShimmer: import('../gfx/heatshimmer').HeatShimmer | null = null;
  photoMode: import('../ui/photomode').PhotoMode | null = null;
  private beats: StoryBeats | null = null;
  private endstats: EndStats | null = null;
  private endcapture: EndCapture | null = null;
  private wallCracks: WallCracks | null = null;
  private stainGrowth: StainGrowth | null = null;
  private graffitiEvolution: GraffitiEvolution | null = null;
  /** last chunk key fed to the stain/graffiti stage helpers */
  private prevStageChunk: string | null = null;
  private daycycle: DayCycle | null = null;

  // ---- Wave B (B-1) audio pack: nullable, ctx-gated via ensureAudioIntegrations() ----
  private doorCreaks: DoorCreaks | null = null;
  private groans: StructureGroans | null = null;
  private crowd: CrowdAmbience | null = null;
  private loreStings: LoreStings | null = null;
  private batteryCues: BatteryCues | null = null;
  private stomachAudio: StomachAudio | null = null;
  private vents: VentAudio | null = null;
  private elevatorAmb: ElevatorAmbience | null = null;
  private electricPops: ElectricPops | null = null;
  private fanSpeedAudio: FanSpeedAudio | null = null;
  private cabinetCreaks: CabinetCreaks | null = null;
  private echoSites: EchoSites | null = null;
  private fanAudio: FanAudio | null = null;
  // ---- F2 central integration mounts ----
  private breathHandle: BreathHandle | null = null;
  private areaBeds: AreaIdentityBeds | null = null;
  /** dream-state clarity policy handle; rebuilt when the quality preset changes */
  private clarityHandle: RenderClarityHandle | null = null;
  private clarityQuality: string | null = null;
  // ---- wave-1 dread features ----
  /** F5: world-fixed HRTF whisper voices around the listener */
  private whispers: WhisperField | null = null;
  /** F6: director-rationed total-mix silence before major anomalies */
  private dread: DreadSilence | null = null;
  /** F7: per-archetype gait classifier fed from earshot strides */
  private footstepDNA: FootstepDNA | null = null;
  /** F7: per-figure stride accumulator + rolling observation window */
  private strideState = new WeakMap<object, {
    lastX: number; lastZ: number; acc: number; lastStepAt: number;
    window: StepObservation[]; flagged: boolean;
  }>();
  /** F14: hard-fall stagger driving control damp + blur veil */
  private fallStagger = new FallStagger();
  /** F14: lazy full-screen backdrop-blur veil (grain-overlay pattern) */
  private staggerBlurEl: HTMLDivElement | null = null;

  // ---- F17 echo geography: per-run recorder + replay queue ----
  private echoGeo: EchoGeography | null = null;
  /** player footstep bursts since run start (every 4th is recorded) */
  private echoFootstepCount = 0;
  /** 12 m site key the player last occupied */
  private echoSiteKey: string | null = null;
  /** cues waiting to play: due session-second + verbatim memo text if any */
  private echoCueQueue: { dueSec: number; text?: string }[] = [];
  /** echoes played during the current site entry (capped at 2) */
  private echoPlaysThisEntry = 0;

  // ---- F18 time slippage: per-run tracker + one-warning-per-visit state ----
  private timeSlip: TimeSlippage | null = null;
  /** zone key fed to the slippage tracker last frame */
  private slipZoneKey: string | null = null;
  /** true once the 60 s disagreement warning fired for the current visit */
  private slipWarned = false;

  // ---- F21 memory residue: per-run field + one-beat frame queue ----
  private residue: ResidueField | null = null;
  /** beats waiting to play: due session-second + verbatim line */
  private residueBeatQueue: { dueSec: number; text: string }[] = [];
  /** session second of the last replay (one replay per 90 s of session time) */
  private residueLastPlaySec = -1e9;

  // ---- F11 torch view-model: persistent hand mesh + per-run pose model ----
  /** camera-attached hand/torch mesh; built once, survives runs */
  private torchHandNode: TransformNode | null = null;
  /** pose sink for TorchView (captures the node without a Babylon import in gfx) */
  private torchTarget: TorchViewTarget | null = null;
  /** rebuilt every run so sway phases re-seed from the fresh seed */
  private torchView: TorchView | null = null;

  // ---- F42 night-vision camcorder: per-run mode model + IR tint veil ----
  /** rebuilt every run (starts off, latch cleared, drain handed back) */
  private nightvision: NightVision | null = null;
  /** full-screen green grade element, created lazily like the stagger blur */
  private nvTintEl: HTMLDivElement | null = null;
  private nvHintShown = false;
  /** cutoff announcements already surfaced for the current run */
  private nvCutoffsSeen = 0;
  /** playtime of the last loud-artifact caption (10 s min gap per run) */
  private nvArtifactLastSec = -1e9;
  /** above this artifactLevel the IR static earns a caption (the module's
   * gain caps the level at NV_ARTIFACT_GAIN = 0.8, so the threshold must
   * sit inside the reachable range) */
  private readonly NV_ARTIFACT_CAPTION_LEVEL = 0.72;

  // ---- F22 gravity ambivalence: per-run tilt model + roll bookkeeping ----
  /** rebuilt every run so the veer thresholds re-jitter from the fresh seed */
  private gravityTilt: GravityTilt | null = null;
  /** roll offset we last added to camera.rotation.z (rad); stripped from
   * the pre-update baseline so lean/shake never double-count the tilt */
  private gravityTiltAppliedRad = 0;
  /** previous body position for the per-frame lateral velocity estimate */
  private tiltPrevX = 0;
  private tiltPrevZ = 0;

  // ---- Mount batch B: player-body signals (F72/F73/F74/F75/F95) ----
  /** F72: low-battery camcorder aim wobble, sampled once per playing frame */
  private tremor: HandTremor | null = null;
  /** F74: sleep-pressure micro-blink scheduler driving the eyelid veil */
  private blinks: BlinkScheduler | null = null;
  /** F74: lazy full-screen black eyelid veil (stagger-blur pattern) */
  private blinkVeilEl: HTMLDivElement | null = null;
  /** F75: near-miss adrenaline dumps feeding camera shake + hearing gain */
  private adrenaline = new AdrenalineSystem();
  /** F75: hearing-gain multiplier snapshot for the future audio-layer consumer */
  private adrenalineHearingGainMul = 1;
  /** F73: expedition-length stomach pangs (schedule restarts per run — not serialized) */
  private hunger: HungerPangs | null = null;
  /** F73: playtime second of the last HUNGER caption (>= 20 s gap) */
  private hungerCaptionLastSec = -1e9;
  /** F95: opt-in hardcore flicker battery model; mode stays off until a
   * settings-schema toggle exists (see beginRun) */
  private flickerBattery: FlickerBattery | null = null;

  // ---- F50: the exit that isn't (per-run gate + one-shot latch) ----
  /** Per-run fire-exit gate; rebuilt every run from the fresh seed. */
  private exitVoid: ExitVoidTracker | null = null;
  /** True once this run's exit was taken; the void spawns at most once. */
  private exitVoidTaken = false;
  /** Full-white epilogue veil (#bmb-void), created lazily on first take. */
  private voidEl: HTMLDivElement | null = null;

  // ---- F100: the credits walk (transient 'credits' state) ----
  /** Playback cursor over the built walk plan; null when not walking. */
  private creditsWalker: CreditsWalker | null = null;
  /** Full-screen scroll overlay (reuses ending-overlay styling). */
  private creditsEl: HTMLDivElement | null = null;
  /** Translated inner column carrying the pre-rendered timeline. */
  private creditsScrollerEl: HTMLDivElement | null = null;
  /** Scroll speed of the credits column, px per walk-second. */
  private static readonly CREDITS_PX_PER_SEC = 64;

  // ---- F27 watcher packs ----
  /** F27: live coordinated stalk over a subset of the watcher population. */
  private watcherPack: WatcherPack | null = null;
  /** F27: figures driving the pack, indexed by stable pack member id. */
  private packMembers: HumanFigure[] = [];
  /** F27: seconds until another pack may form after one dissolves. */
  private packCooldownSec = 30;

  // ---- F28 mimic props ----
  /** F28: furniture-mimic wiring rebuilt with each run. */
  private mimicWiring: MimicPropWiring | null = null;
  /** F28: chunk keys already rolled for a mimic spawn this run. */
  private mimicRolledChunks = new Set<string>();
  /** F28: seconds until the next chunk-stream spawn roll (1 s cadence). */
  private mimicRollTimer = 0;

  // ---- F66 doppelganger letters ----
  /** F66: decision ledger keyed by choice id; feeds letter drafting. */
  private choiceSites = new Map<string, { id: string; kind: ChoiceKind; x: number; z: number }>();
  /** F66: sites restored from save meta awaiting their letter delivery. */
  private pendingLetters = new Map<string, DoppelLetter>();
  /** F66: drafter over the choice ledger; rebuilt when the ledger grows. */
  private doubleLetters: DoubleLetters | null = null;
  /** F66: ledger size the current drafter was built over (-1 = none). */
  private lettersBuiltRev = -1;
  /** F66: seconds until the next proximity sweep for letter delivery. */
  private letterTickTimer = 0;

  // ---- Batch C mounts (F29/F94/F96) ----
  /** F29: landmark visit ledger keyed by landmark name; entries are replaced
   * on revisit so lastVisitedAt always carries the freshest occupancy tick. */
  private gossipSites = new Map<string, VisitedSite>();
  /** F29: bumped whenever the ledger content changes; drives lazy rebuilds. */
  private gossipLedgerRev = 0;
  /** F29: ledger revision the current GossipSource was built over. */
  private gossipBuiltRev = -1;
  /** F29: per-run grounded-line source over the visit ledger. */
  private gossipSource: GossipSource | null = null;
  /** F94: needle model fed wells + contamination from the memory field. */
  private lyingCompass = new LyingCompass();
  /** F94: seconds until the next coarse well resample (~2 s cadence). */
  private compassWellTimer = 0;
  /** F96: seconds until the next journal-hand restyle (throttled). */
  private journalFontTimer = 0;
  /** F96: stable page id (note coords) seeding the per-entry hand wobble. */
  private journalEntryId = 'note:unread';

  // ---- Social entity mounts (F26/F32/F61) ----
  /** F26: this session's Archivist sim; mounted lazily once landmarks stream in. */
  private archivist: Archivist | null = null;
  /** F26: visual-only clipboard figure driven by the sim body, never self-updated. */
  private archivistFigure: HumanFigure | null = null;
  /** F26: photos per run id; mirrors the save slot's archivistEncounters meta. */
  private readonly archivistPhotos = new Map<string, number>();
  /** F26: run id this session's encounters are recorded under. */
  private archivistRunId = '';
  /** F32: overnight removal pass over the live graffiti marking ledger. */
  private custodianWiring: CustodianWiring | null = null;
  /** F32: ids of markings removed ever; feeds ChunkManager.removedGraffiti so
   * erasures survive chunk rebuilds and session loads. */
  private readonly custodianRemovedKeys = new Set<string>();
  /** F32: true while the day cycle sits inside its night stretch. */
  private custodianNightActive = false;
  /** F32: cart-squeak loop voices (ctx-gated like the Wave-B audio pack). */
  private cartSqueaks: CartSqueaks | null = null;
  /** F61: choir at the first streamed-in CHAPEL landmark. */
  private chapelChoir: ChapelChoir | null = null;
  /** F61: discovery-ledger revision the choir's lyric pool was built over. */
  private choirBuiltRev = -1;
  /** F61: visual-only believer figures parked on the choir seats. */
  private readonly choirFigures: HumanFigure[] = [];

  // ---- Wave B (B-2) scene pack ----
  private postfx: PostFX | null = null;
  private fauna: FaunaWiring | null = null;
  private gaze: GazeWiring | null = null;
  /** figure instance -> stable wiring id for gaze attach/detach */
  private gazeIds = new WeakMap<object, string>();
  private gazeAttached = new Map<string, object>();
  private gazeNextId = 0;

  // ---- Wave B (B-3) DOM overlays ----
  private minimap: Minimap | null = null;
  private compass: Compass | null = null;
  private weatherUi: WeatherUI | null = null;
  private weatherPhase = '';

  // ---- Wave C (C-3..C-8): ordered-chain integrations ----
  private journalApi: Journal | null = null;
  private journalFeed: JournalFeed | null = null;
  private journalWiring: JournalWiring | null = null;
  private tracker: Tracker | null = null;
  private trackerFeed: TrackerFeed | null = null;
  private trackerTimer = 0;
  // ---- F47/F49/F93/F97 meta-UI mounts ----
  /** F47: today's shared-seed rite (checklist model + rollover clock). */
  private dailyRite: DailyRite | null = null;
  /** F47: session stats already reported into the active rite day. */
  private dailyNotesReported = 0;
  private dailyLandmarksReported = 0;
  private wasBlackoutForRite = false;
  private dailyTickTimer = 0;
  /** F97: stamped-form toast queue fed by achievement unlocks. */
  private forms: FormToasts | null = null;
  /** F49: composed pack rebuilt whenever settings or a11y flags change. */
  private a11yPack: AccessibilityPack | null = null;
  /** F93: title/pause menu projections on in-world walls. */
  private wallTitle: WallMenuPlane | null = null;
  private wallPause: WallMenuPlane | null = null;
  private wallMenuTimer = 0;
  private checkpointsMgr: CheckpointManager | null = null;
  private saveScreen: SaveScreen | null = null;
  private watcherIntro: WatcherIntroController | null = null;
  /** one-shot guard so markShown() persists exactly once */
  private watcherIntroMarked = false;
  private gallery: PhotoGallery | null = null;
  // extended debrief telemetry (C-8)
  private torchLitSec = 0;
  private lastPhaseKey = '';
  private phaseSessions = 0;
  private freezes = 0;
  private nearMisses = 0;
  private nearMissArmed = true;
  private districtVisitCounts = new Map<string, number>();
  private prevDistrictKey = '';
  private walkSinceBeaconM = 0;
  private longestBeaconDroughtM = 0;
  private beaconsAtLastWalk = 0;

  // ---- F90 director learning: per-run fear-affinity model + feed bookkeeping ----
  /** Per-run model; rebuilt in beginRun so learning restarts with each expedition. */
  private learning: DirectorLearning | null = null;
  /** F90: landmark/beacon key the linger detector currently sits inside. */
  private learningLingerKey: string | null = null;
  /** F90: seconds accumulated inside the current linger key. */
  private learningLingerSec = 0;
  /** F90: true once the current occupancy already confessed its linger. */
  private learningLingerFired = false;
  /** F90: playtime second of the last pacing-bias caption (>=2 min gap). */
  private learningBiasLastSec = -1e9;
  /** F90: note key whose READ prompt is currently showing (null when none). */
  private notePromptKey: string | null = null;
  /** F90: notes actually opened this run; walking away from the rest is a skip. */
  private readonly learningReadNotes = new Set<string>();

  // ---- F91 wake cinematic: per-run staging + playback cursor ----
  /** Staged shot list for this run's waking (startNew only). */
  private wakeStaging: WakeStaging | null = null;
  /** Playback cursor; null whenever no cinematic is riding the wake window. */
  private wakeCine: WakeCinematicPlayer | null = null;
  /** True after a movement-key skip fired for the active cinematic. */
  private wakeCineSkipped = false;
  /**
   * F91 v1.1 debt: live run-start wake sequence (startNew only). While set
   * and playing it owns the camera until it hands control to the rise.
   */
  private wakeMount: WakeMount | null = null;

  // ---- Wave B chunk-built / per-chunk bookkeeping ----
  /** continuous fog sampler: puddle low areas + contamination murk */
  private fogVar = createFogVariation();
  /** chunk keys already announced to the fauna spawn lottery */
  private knownChunkKeys = new Set<string>();
  private lastChunksBuiltSeen = 0;
  /** player chunk key already fed to minimap fog + cabinet/fan audio */
  private prevMiniChunk: string | null = null;
  private markedBeaconKeys = new Set<string>();
  private prevArcStage = 0;

  state: GameState = 'menu';
  seed = 0;
  playtimeSec = 0;

  private lastFrame = performance.now();
  private lastAutosave = 0;
  private settings: SettingsData = { sensitivity: 1, volume: 0.8, quality: 1, fov: 75 };
  private forceDeadLights = new Set<string>();
  private blackoutUntil = 0;
  private interactQueued = false;
  private beaconEnsureTimer = 0;
  private seenPersonal = new Set<string>();
  private flashHintShown = false;
  private playerLandmark: string | undefined = undefined;
  private seenLandmarks = new Set<string>();
  private reconsolidationDoubles = new Set<string>();
  /** restored trail of the previous session - the space remembers your walk */
  private pastSessionPath: { x: number; z: number }[] = [];
  private echoedRegions = new Set<string>();
  private echoCheckTimer = 0;
  consumedBatteries = new Set<string>();
  private pathHistory: { x: number; z: number; t: number }[] = [];
  private pathSampleTimer = 0;
  /** F31: this run's roach ecosystem (null until chunk data is loaded). */
  private roachEco: RoachEcosystem | null = null;
  /** F31: seconds until the next deferred spawn attempt. */
  private roachSpawnTimer = 0;
  /** F31: fixed-step accumulator for roach doTick(). */
  private roachAccumulatorSec = 0;
  /** F34: this run's self-tuning receiver over the discovery feed. */
  private radio: SelfRadio | null = null;
  /** F34: session time of the last locked-station broadcast line (≥45 s apart). */
  private radioLastLineSec = -1e9;
  /** F35: this run's camcorder memo store (capture-only; playback deferred). */
  private memoStore: VoiceMemoStore | null = null;
  /** F35: per-run memo sequence number for stable capture ids. */
  private memoSeq = 0;
  /** F46: note ids first-read this run — the expedition ledger's note feed. */
  private readonly runNoteIds = new Set<string>();
  private attract = { x: 8, z: 8, t: 0 };
  private loopArmedUntil = 0;
  /** Spatial-anomaly runtime; rebuilt with the director on every run. */
  private anomalies: AnomalySystem | null = null;
  /** Reversible per-chunk mutation ledger feeding the anomaly decor drift. */
  private readonly deltas = new ChunkDeltas();
  /** Stand-in point light the migrating-lights anomaly steers around. */
  private ghostLight: PointLight | null = null;
  private lastBlackoutVisual = false;
  private prevCell: { x: number; z: number } | null = null;
  /** fixtures forced ON during blackouts, key -> until-seconds */
  private ghostLit = new Map<string, number>();
  logOpen = false;
  private logTimer = 0;
  private objectiveTimer = 0;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    let gpuOk = false;
    try {
      const { WebGPUEngine } = await import('@babylonjs/core/Engines/webgpuEngine');
      if (await WebGPUEngine.IsSupportedAsync) {
        const e = new WebGPUEngine(canvas, { antialias: true });
        await e.initAsync();
        this.engine = e as unknown as Engine;
        gpuOk = true;
        console.log('[bmb] WebGPU engine active');
      }
    } catch (e) {
      console.warn('[bmb] WebGPU unavailable, falling back', e);
    }
    if (!gpuOk) {
      this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false }, false);
      console.log('[bmb] WebGL engine active');
    }

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.02, 0.018, 0.008, 1);
    this.scene.ambientColor = new Color3(0.12, 0.11, 0.08);

    this.camera = new TargetCamera('cam', new Vector3(SPAWN_X, 1.62, SPAWN_Z), this.scene);
    this.camera.fov = 1.25;
    this.camera.minZ = 0.08;
    this.camera.maxZ = 140;

    this.input = new Input(canvas);
    this.mats = createMaterials(this.scene);
    // WebGPU-only: clamp per-material light counts so vertex-stage uniform
    // buffers stay under the 12-per-stage limit (16 bound lights overflow it
    // and every pipeline creation fails -> world renders black).
    this.webgpuLightBudgetDisposer = enforceWebGPULightBudget(this.scene, this.engine);
    this.lighting = new LightingRig(this.scene);
    this.lighting.attachToCamera(this.camera);
    // Integration: surface detection is context-free, so it can boot here.
    try {
      this.surfaceDetector = new SurfaceDetector();
    } catch (e) {
      console.warn('[bmb] SurfaceDetector unavailable', e);
    }
    // ---- Wave B (B-2a): post-processing over the LightingRig pipeline ----
    try {
      this.postfx = new PostFX();
      this.postfx.init(this.scene, { camera: this.camera });
    } catch (e) {
      console.warn('[bmb] PostFX unavailable', e);
      this.postfx = null;
    }
    // ---- F2: dream-state clarity policy (resolution/aniso/AA/fog cap) ----
    // Runs after PostFX so the rig's DefaultRenderingPipeline exists for FXAA.
    try {
      const preset = qualityNumToPreset(this.settings.quality);
      this.clarityHandle = applyRenderClarity(this.engine, this.scene, { quality: preset });
      this.clarityQuality = preset;
    } catch (e) {
      console.warn('[bmb] render clarity unavailable', e);
      this.clarityHandle = null;
      this.clarityQuality = null;
    }
    this.lighting.onLightDied = () => {
      this.audio.lightCrack();
      this.ui.say('...that light was coming to you...', 3.5);
      this.showAudioCaption('IMPACT'); // Wave A (A-1b): caption routing
    };
    this.player = new PlayerController(this.camera, this.input, this.scene);
    this.flashlight = new Flashlight(this.scene);
    // ---- F11: torch view-model hand mesh (built once; TorchView re-seeds per run) ----
    try {
      const hand = new TransformNode('torchHand', this.scene);
      hand.parent = this.camera;
      const bodyMesh = MeshBuilder.CreateCylinder('torchBody', {
        height: 0.22, diameterTop: 0.035, diameterBottom: 0.05, tessellation: 8,
      }, this.scene);
      bodyMesh.parent = hand;
      // barrel points along the view axis; camera-local forward is -Z
      bodyMesh.position.z = -0.1;
      const bodyMat = new StandardMaterial('torchBodyMat', this.scene);
      bodyMat.diffuseColor = new Color3(0.14, 0.13, 0.11);
      bodyMat.emissiveColor = new Color3(0.05, 0.048, 0.042);
      bodyMat.specularColor = new Color3(0.02, 0.02, 0.02);
      bodyMesh.material = bodyMat;
      bodyMesh.isPickable = false;
      this.torchHandNode = hand;
      this.torchTarget = {
        setPosition: (x, y, z) => { this.torchHandNode?.position.set(x, y, z); },
        setRotation: (x, y, z) => { if (this.torchHandNode) this.torchHandNode.rotation.set(x, y, z); },
      };
    } catch (e) {
      console.warn('[bmb] torch hand mesh unavailable', e);
      this.torchHandNode = null;
      this.torchTarget = null;
    }
    this.chunks = new ChunkManager(this.scene, this.mats, 1);
    this.chunks.consumedBatteries = this.consumedBatteries;
    // F32: the build filter consults the same set the Custodian drains into
    this.chunks.removedGraffiti = this.custodianRemovedKeys;
    this.chunks.discoveredLandmarks = this.seenLandmarks;
    this.chunks.deltas = this.deltas;
    // the migrating-lights anomaly steers this detached fixture light;
    // parked out of the world until an anomaly claims it
    this.ghostLight = new PointLight('ghost-migrant', new Vector3(0, -100, 0), this.scene);
    this.ghostLight.diffuse = new Color3(1.0, 0.97, 0.86);
    this.ghostLight.intensity = 0;
    this.ghostLight.range = 11;
    this.dust = new DustMotes(this.scene);
    this.humans = new HumanManager(this.scene);
    this.humans.onWatcherVanish = () => {
      this.audio.lightCrack();
      this.lighting.stressLevel = Math.min(1, this.lighting.stressLevel + 0.5);
      this.showAudioCaption('SCREAM'); // Wave A (A-1b): caption routing
    };
    this.humans.onBeamFreeze = () => {
      this.audio.beamFreezeSting();
      // F90: freezing in a watcher's beam confesses hesitation (fixed 0.8).
      try { this.learning?.record({ kind: 'hesitation', contextTag: 'watcher', intensity: 0.8 }); }
      catch (e) { console.warn('[bmb] director learning feed failed', e); }
    };
    // ---- Wave B (B-2m/B-2n): ambient fauna + per-figure gaze coordination ----
    try { this.fauna = new FaunaWiring(this.scene, this.seed); }
    catch (e) { console.warn('[bmb] FaunaWiring unavailable', e); this.fauna = null; }
    try { this.gaze = new GazeWiring(); }
    catch (e) { console.warn('[bmb] GazeWiring unavailable', e); this.gaze = null; }
    this.mem = new MemoryField(1);
    this.weather = new MemoryWeather(1);
    this.mem.weather = this.weather;
    this.chunks.mem = this.mem;
    this.ui = new UI({
      onNewExpedition: (s) => this.startNew(s),
      onContinue: () => void this.continueGame(),
      onResume: () => this.resume(),
      onSaveQuit: () => void this.saveAndQuit(),
      onSettingsChanged: (s) => this.applySettings(s),
    });


    // ---- Wave B (B-3): DOM overlays mounted into the HUD host ----
    try { this.minimap = new Minimap(this.ui.hud); }
    catch (e) { console.warn('[bmb] Minimap unavailable', e); this.minimap = null; }
    try { this.compass = new Compass(this.ui.hud); }
    catch (e) { console.warn('[bmb] Compass unavailable', e); this.compass = null; }
    try { this.weatherUi = new WeatherUI(this.ui.hud); }
    catch (e) { console.warn('[bmb] WeatherUI unavailable', e); this.weatherUi = null; }

    // ---- Wave C world-FX: emergency lights, heat shimmer, photo mode ----
    try {
      this.emergencyWiring = new EmergencyWiring();
      this.emergencyWiring.ensureLights(this.scene);
    } catch (e) { console.warn('[bmb] EmergencyLights unavailable', e); this.emergencyWiring = null; }
    try { this.heatShimmer = new HeatShimmer(document.body); }
    catch (e) { console.warn('[bmb] HeatShimmer unavailable', e); this.heatShimmer = null; }
    try {
      this.photoMode = new PhotoMode({
        canvas: document.getElementById('renderCanvas') as HTMLCanvasElement,
        getCameraPos: () => ({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z }),
        setCameraPos: (p) => this.camera.position.set(p.x, p.y, p.z),
        getCameraRot: () => ({ x: this.camera.rotation.x, y: this.camera.rotation.y, z: this.camera.rotation.z }),
        setCameraRot: (r) => this.camera.rotation.set(r.x, r.y, r.z),
      });
      window.addEventListener('keydown', (ev) => {
        // F91 v1.1: no photo mode while the waking sequence drives the camera
        // — its exit() restores a snapshot that would fight the mount.
        if (ev.code === 'KeyP' && this.state === 'playing' && !this.photoMode?.isOpen && !this.wakePlaying()) {
          this.photoMode?.enter();
        }
      });
      // F35: every PhotoMode capture (its own KeyC handler fires the frame
      // grab) also records a voice-memo model entry — the capture moment,
      // zone generation and seeded waveform are preserved even though
      // bitmap/audio plumbing is deferred (see recordPhotoMemo).
      window.addEventListener('keydown', (ev) => {
        if (ev.code === 'KeyC' && !ev.repeat && this.photoMode?.isOpen) {
          this.recordPhotoMemo();
        }
      });
    } catch (e) { console.warn('[bmb] PhotoMode unavailable', e); }

    // ---- Wave C (C-7): gallery of captured endings ----
    try { this.gallery = new PhotoGallery(document.body); }
    catch (e) { console.warn('[bmb] PhotoGallery unavailable', e); this.gallery = null; }

    // ---- Wave A (A-4): persistence stage helpers (world decay bookkeeping) ----
    try { this.wallCracks = createWallCracks(); }
    catch (e) { console.warn('[bmb] wall cracks unavailable', e); }
    try { this.stainGrowth = createStainGrowth(); }
    catch (e) { console.warn('[bmb] stain growth unavailable', e); }
    try { this.graffitiEvolution = createGraffitiEvolution(); }
    catch (e) { console.warn('[bmb] graffiti evolution unavailable', e); }

    // ---- Wave A (A-1a): canonical settings store, fed through applySettings() ----
    try {
      this.settingsManager = new SettingsManager();
      this.settingsManager.onChange((gs) => {
        try {
          if (!this.syncingSettings) {
            this.applySettings(this.panelToGameSettings(gs));
          }
          // F95: the hardcore battery toggle rides the canonical store; it
          // has no SettingsData counterpart, so it routes directly to the
          // per-run FlickerBattery (identity drive while off).
          this.applyHardcoreBattery(gs);
        } catch (err) {
          console.warn('[bmb] settings store sync failed', err);
        }
      });
    } catch (e) {
      console.warn('[bmb] SettingsManager unavailable', e);
    }

    // ---- Wave A (A-1b): accessibility options + DOM controller ----
    try {
      this.a11yMgr = new AccessibilityManager();
      const a11yAttach = AccessibilityController.attach(this.a11yMgr, document as unknown as A11yDocumentLike);
      this.a11yCtl = a11yAttach.controller;
    } catch (e) {
      console.warn('[bmb] AccessibilityManager unavailable', e);
    }

    // ---- Wave A (A-1c): schema-driven panel mounted into the shared pause-menu host ----
    try {
      if (this.settingsManager && this.a11yMgr) {
        const host = document.getElementById('settings-panel');
        if (host) {
          const store = compositeStore([
            settingsStoreAdapter(this.settingsManager),
            accessibilityStoreAdapter(this.a11yMgr),
          ]);
          this.settingsPanel = buildSettingsPanel(host, store, defaultSections());
        }
      }
    } catch (e) {
      console.warn('[bmb] settings panel unavailable', e);
    }

    // ---- F47/F49/F93/F97: meta-UI mounts ----
    // F47 daily rite: shared UTC-date seed + persisted checklist model.
    try {
      const g = globalThis as {
        localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
      };
      this.dailyRite = new DailyRite({
        storage: {
          get: (key) => (g.localStorage ? g.localStorage.getItem(key) : null),
          set: (key, value) => {
            try { g.localStorage?.setItem(key, value); } catch { /* quota: day stays session-local */ }
          },
        },
      });
      this.ui.setDailyRite(
        "TODAY'S RITE \u2014 SEED 0x" +
          (this.dailyRite.seed >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      );
    } catch (e) {
      console.warn('[bmb] daily rite unavailable', e);
    }
    // F97 stamped forms + revived tracker chain: fresh unlocks print FORMS.
    try {
      this.forms = new FormToasts({
        document: document as unknown as FormDocumentLike,
        container: document.body as unknown as FormElementLike,
      });
    } catch (e) {
      console.warn('[bmb] form toasts unavailable', e);
    }
    try {
      this.tracker = new Tracker(document.body);
      setAchievementToastSink((info) => {
        try {
          this.forms?.push({
            id: info.id.toUpperCase(),
            request: ACHIEVEMENT_FORM_REQUESTS[info.id] ??
              info.title.toUpperCase().replace(/ /g, '_'),
          });
        } catch { /* form routing must never break the unlock path */ }
      });
      this.trackerFeed = new TrackerFeed(this.tracker);
    } catch (e) {
      console.warn('[bmb] achievement chain unavailable', e);
    }
    // F49 accessibility pack: rebuilt on every settings/a11y change.
    try {
      this.a11yMgr?.onChange(() => {
        try { this.applyAccessibilityPack(); }
        catch (err) { console.warn('[bmb] a11y pack reapply failed', err); }
      });
      this.applyAccessibilityPack();
    } catch (e) {
      console.warn('[bmb] accessibility pack unavailable', e);
    }
    // F93 diegetic menu planes (remounted onto walls per state below).
    try {
      this.wallTitle = new WallMenuPlane(this.scene);
      this.wallPause = new WallMenuPlane(this.scene);
    } catch (e) {
      console.warn('[bmb] wall menus unavailable', e);
      this.wallTitle = null;
      this.wallPause = null;
    }

    // ---- Wave A (A-3a): expedition debrief overlay (invoked at ending) ----
    try { this.endstats = new EndStats(document.body); }
    catch (e) { console.warn('[bmb] EndStats unavailable', e); }

    // ---- Wave A (A-3b): Threshold whiteout watcher + commemorative frame grab ----
    try {
      this.endcapture = new EndCapture();
      // Wave C (C-7): every captured ending frame lands in the gallery
      this.endcapture.onCapture = (blob) => {
        console.log('[bmb] threshold frame captured');
        try {
          const dist = String(this.chunks.districtAtPos(this.player.body.x, this.player.body.z) ?? 0);
          void this.gallery?.addPhoto(blob, dist);
        } catch (err) { console.warn('[bmb] gallery capture failed', err); }
      };
      this.endcapture.arm(() => document.getElementById('renderCanvas') as HTMLCanvasElement | null);
    } catch (e) {
      console.warn('[bmb] EndCapture unavailable', e);
    }

    const host: DirectorHost = {
      lightingStress: (v) => { this.lighting.stressLevel = v; },
      killNearbyLight: () => this.killNearbyLight(),
      blackoutPulse: (sec) => { this.blackoutUntil = this.playtimeSec + sec; },
      whisperSurge: () => this.audio.whisper(),
      distantThreat: () => {/* distant events are scheduled by audio engine */},
      nonEuclideanNudge: () => this.nonEuclideanNudge(),
      armDoorwayLoop: (sec) => { this.loopArmedUntil = this.playtimeSec + sec; },
      requestEntitySpawn: (kind) => this.spawnEntity(kind),
      playerPosition: () => ({ x: this.player.body.x, z: this.player.body.z }),
      elapsed: () => this.playtimeSec,
    };
    // F48: every run picks a temperament from the seed; the director routes
    // phase durations, peak intensity, and window-event chances through it.
    const temperament = temperamentForRun(this.seed);
    this.director = new HorrorDirector(host, this.seed, undefined, {
      temperament,
      pacingRng: pacingRngFor(this.seed, temperament),
    });
    this.anomalies?.dispose();
    this.anomalies = new AnomalySystem(this.anomalyHost(), this.seed, this.director.events);
    this.story = new StorySystem(this.scene, this.seed);

    // ---- Wave A (A-2b/A-2c/A-5a): text/state machines + day drift ----
    try { this.hints = new DifficultyHints(); }
    catch (e) { console.warn('[bmb] DifficultyHints unavailable', e); }
    try { this.beats = new StoryBeats(); }
    catch (e) { console.warn('[bmb] StoryBeats unavailable', e); }
    try { this.daycycle = new DayCycle(); }
    catch (e) { console.warn('[bmb] DayCycle unavailable', e); }

    // ---- Wave A (A-2a): re-read ledger for note distortion ----
    try { this.reread = new NoteReread(); }
    catch (e) { console.warn('[bmb] NoteReread unavailable', e); }

    // F14: hard falls arm the control-damp + blur stagger envelope
    this.player.events.on('hardfall', ({ vy }) => {
      this.fallStagger.onImpact(vy);
    });
    this.player.events.on('footstep', ({ running }) => {
      this.audio.footstep(running);
      // mirror-steps anomaly duplicates rare footsteps 400 ms behind
      this.anomalies?.noteFootstep(running);
      // Integration: district/puddle-aware footstep material.
      try {
        if (this.surfaceFootsteps && this.surfaceDetector) {
          const d = this.chunks.districtAtPos(this.player.body.x, this.player.body.z) ?? 0;
          const surf = this.surfaceDetector.detect(this.player.body.x, this.player.body.z, d);
          this.surfaceFootsteps.play(surf, running);
        }
      } catch (e) {
        console.warn('[bmb] surface footsteps failed', e);
      }
      // F17: every fourth footstep burst is recorded into the halls' memory
      try {
        this.echoFootstepCount++;
        if (this.echoGeo && this.echoFootstepCount % 4 === 0) {
          this.echoGeo.recordFootstepBurst(
            Math.floor(this.player.body.x / 12) + ',' + Math.floor(this.player.body.z / 12),
            this.playtimeSec,
          );
        }
      } catch (e) {
        console.warn('[bmb] echo geography footstep feed failed', e);
      }
    });

    canvas.addEventListener('click', () => {
      this.audio.unlock();
      // F91 v1.1: a click during the waking sequence dismisses it (pointer
      // lock is already engaged from beginRun, so no re-request is needed).
      if (this.wakePlaying()) {
        this.dismissWakeCinematic();
        return;
      }
      // F100 motion-safety follow-up: the credits walk overlay is
      // pointer-events:none, so a click lands here — any click skips the
      // scroll straight to the title (same hand-off as its natural finish).
      if (this.state === 'credits' && this.creditsWalker) {
        this.finishCreditsWalk();
        return;
      }
      if (this.state === 'playing') this.input.requestLock();
    });
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
    };

    try {
      const s = await SaveDB.loadSettings();
      if (s) this.ui.loadSettings(s);
    } catch { /* defaults */ }

    window.addEventListener('keydown', (e) => {
      // F91 v1.1: any press during the waking sequence ends it instantly and
      // hands control to the rise — waking eyes do not run the expedition
      // kit. F3 stays live so debug overlays work from frame zero.
      if (this.wakePlaying() && e.code !== 'F3') {
        e.preventDefault();
        this.dismissWakeCinematic();
        return;
      }
      // F100 motion-safety follow-up: any press skips the auto-scrolling
      // credits column straight to the title (same hand-off as its natural
      // finish). F3 stays live so debug overlays keep working.
      if (this.state === 'credits' && e.code !== 'F3' && this.finishCreditsWalk()) {
        e.preventDefault();
        return;
      }
      if (e.code === 'F3') {
        e.preventDefault();
        this.ui.toggleDebug();
      }
      if (e.code === 'KeyE' && this.state === 'playing') {
        console.log('[key] KeyE firing, setting queue; sameInstance=', this === (window as unknown as Record<string, Record<string, unknown>>).__BMB__?.game);
        this.interactQueued = true;
      }
      if (e.code === 'KeyF' && this.state === 'playing') {
        const wasOn = this.flashlight.on;
        const turned = this.flashlight.toggle();
        // F11: the hand jolts whenever the torch state actually flips
        if (turned !== wasOn) this.torchView?.kick();
        if (turned && !this.flashHintShown) {
          this.flashHintShown = true;
          this.ui.say('The camp kit’s torch. It drinks from the working lights.', 4);
        }
      }
      // batteries consume synchronously here so nothing can eat the press
      if (e.code === 'KeyE' && this.state === 'playing') {
        const b0 = this.chunks.nearestBattery(this.player.body.x, this.player.body.z);
        console.log('[batE] reached, b=', !!b0);
        const b = b0;
        const beaconNear = [...this.story.beacons.values()].some(
          (bb) => !bb.found && Math.hypot(bb.x - this.player.body.x, bb.z - this.player.body.z) < 2.6,
        );
        console.log('[batE] beaconNear=', beaconNear, 'b=', !!b);
        if (b && !beaconNear) {
          const cx2 = worldToChunk(b.x);
          const cz2 = worldToChunk(b.z);
          // coordinate-stable key matches the build-time filter
          const key = cx2 + ':' + cz2 + ':' + Math.round(b.x * 100) + ':' + Math.round(b.z * 100);
          if (!this.consumedBatteries.has(key)) {
            this.consumedBatteries.add(key);
            this.chunks.rebuildChunk(cx2, cz2);
            this.flashlight.battery = Math.min(1, this.flashlight.battery + 0.35);
            this.ui.toast('TORCH CELL +35%', 2500);
            // F11: fresh cell goes in — the hand dips for the swap beat
            this.torchView?.beginSwap();
            this.ui.setPrompt(null);
            // Wave B (B-1): battery pickup cue
            try { this.batteryCues?.pickupSound(); }
            catch (err) { console.warn('[bmb] battery pickup cue failed', err); }
            e.preventDefault();
          }
        }
      }
      if (e.code === 'KeyN' && this.state === 'playing') {
        // F42: camcorder IR toggle — shares the torch cell, so it needs the kit
        if (!this.flashlight.has) {
          this.ui.say('No camcorder yet. The camp kit holds one.', 3);
        } else if (this.nightvision?.toggle() && !this.nvHintShown) {
          this.nvHintShown = true;
          this.ui.say('IR mode. Green light drinks from the same cell. [N]', 4);
        }
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        this.logOpen = !this.logOpen;
      }
    });
    window.addEventListener('beforeunload', () => {
      if (this.state !== 'menu') void this.saveNow();
    });

    this.engine.runRenderLoop(() => this.frame());
    const slot0 = await SaveDB.loadGame();
    this.ui.showTitle(!!slot0, slot0 ? Math.floor((slot0.playtimeSec ?? 0) / 60) + ' min · ' + (slot0.seed >>> 0).toString(16).toUpperCase().slice(0, 8) : undefined);
  }

  applySettings(s: SettingsData): void {
    // normalize FOV into sane bounds (60–110 degrees); default 75 when missing
    const fovDeg = Math.min(110, Math.max(60, s.fov ?? 75));
    this.settings = { ...s, fov: fovDeg };
    // FOV routes through the controller's baseFovRad seam: the controller
    // rewrites camera.fov every frame from that field (sprint kick + stamina
    // pulse are relative to it), so a direct camera.fov write here would be
    // clobbered. Clamp keeps the radian value in a sane [0.9, 2.2] band on
    // top of the degree normalization above.
    this.player.baseFovRad = Math.max(0.9, Math.min(2.2, fovDeg * Math.PI / 180));
    // Subtitle visibility rides the canonical settings object; turning it
    // off also clears any live line (ui.setSubtitlesOn). Absent -> default on.
    this.ui.setSubtitlesOn(s.subtitles !== false);
    this.ui.syncSubtitlesCheckbox(s.subtitles !== false);
    this.player.sensitivity = 0.0022 * this.settings.sensitivity;
    this.audio.setMasterVolume(this.settings.volume);
    this.engine.setHardwareScalingLevel(1 / Math.max(0.4, Math.min(1, this.settings.quality)));
    // F2: dream-state clarity follows the quality preset; rebuild on change.
    {
      const preset = qualityNumToPreset(this.settings.quality);
      if (this.clarityHandle && preset !== this.clarityQuality) {
        try { this.clarityHandle.dispose(); } catch (e) { console.warn('[bmb] clarity dispose failed', e); }
        this.clarityHandle = null;
        this.clarityQuality = null;
      }
      if (!this.clarityHandle && this.scene) {
        try {
          this.clarityHandle = applyRenderClarity(this.engine, this.scene, { quality: preset });
          this.clarityQuality = preset;
        } catch (e) { console.warn('[bmb] clarity reapply failed', e); }
      }
    }
    // Wave A (A-1a): keep the canonical settings store in agreement.
    if (!this.syncingSettings && this.settingsManager) {
      this.syncingSettings = true;
      try {
        this.settingsManager.set({
          masterVolume: s.volume,
          sensitivity: s.sensitivity,
          quality: qualityNumToPreset(s.quality),
          fov: fovDeg,
          // Mirror the subtitle flag too: the store round-trips every
          // applySettings through onSettingsChanged, so an unmirrored key
          // would let the store's stale value clobber the caller's choice.
          subtitles: s.subtitles !== false,
        });
        this.settingsPanel?.refresh();
      } catch (e) {
        console.warn('[bmb] settings mirror failed', e);
      }
      this.syncingSettings = false;
    }
    try { this.applyAccessibilityPack(); } catch { /* pack stays stale */ }
    void SaveDB.saveSettings(this.settings).catch(() => {});
  }

  /**
   * F95: re-apply the hardcore battery mode from the canonical settings
   * store onto the per-run FlickerBattery. Called from beginRun (fresh
   * battery per expedition) and from the settings-change callback; with
   * the store unavailable or the toggle off, the drive stays identity.
   */
  private applyHardcoreBattery(gs?: GameSettings): void {
    const on = (gs ?? this.settingsManager?.settings)?.hardcoreBattery === true;
    this.flickerBattery?.setHardcore(on);
  }

  /**
   * F49: rebuild the accessibility pack from the live settings + a11y
   * flags and rewire its effectors. Each toggle reaches exactly one
   * consumer: motionSafety gates controller bob/sway (injected read) and
   * the camera-shake/gravity-tilt mounts; speakerTags feeds the UI
   * subtitle tagger; highContrast swaps the theme tokens on the root
   * element. With every toggle off the outputs are byte-identical to the
   * pre-pack behavior.
   */
  private applyAccessibilityPack(): void {
    if (!this.settingsManager) return;
    const gs = this.settingsManager.settings;
    const hc = this.a11yMgr ? this.a11yMgr.options.highContrast : false;
    const pack = createAccessibilityPack({
      motionSafety: gs.motionSafety,
      speakerTags: gs.speakerTags,
      highContrast: hc,
    });
    this.a11yPack = pack;
    this.player.getSettings = () => ({ motionSafety: pack.options.motionSafety });
    this.ui.subtitleTagger = (speaker, line) => pack.tagSubtitle(speaker, line);
    // high-contrast theme token swap on <html>
    try {
      const style = document.documentElement.style;
      const palette = pack.palette();
      if (!palette) {
        style.removeProperty('--bmb-hc-bg-lift');
        style.removeProperty('--bmb-hc-text-boost');
        style.removeProperty('--bmb-hc-outline-strength');
      } else {
        style.setProperty('--bmb-hc-bg-lift', palette.bgLift.toFixed(3));
        style.setProperty('--bmb-hc-text-boost', palette.textBoost.toFixed(3));
        style.setProperty('--bmb-hc-outline-strength', palette.outlineStrength.toFixed(3));
      }
    } catch { /* styleless hosts keep the model-level effects */ }
  }

  /** F49 live read for the per-frame anomaly displacement mounts. */
  private motionSafetyOn(): boolean {
    return this.a11yPack?.options.motionSafety === true;
  }

  /**
   * F47: report fresh discovery progress into today's rite and roll the
   * rite over at UTC midnight. Idempotent: counters baseline at beginRun
   * and only deltas are reported.
   */
  private dailyRiteTick(): void {
    const rite = this.dailyRite;
    if (!rite) return;
    rite.tick();
    if (this.notesRead > this.dailyNotesReported) {
      const delta = this.notesRead - this.dailyNotesReported;
      this.dailyNotesReported += delta;
      rite.report('notes', delta);
    }
    if (this.seenLandmarks.size > this.dailyLandmarksReported) {
      this.dailyLandmarksReported = this.seenLandmarks.size;
      rite.report('landmark', 1);
    }
    const blackoutNow = this.playtimeSec < this.blackoutUntil;
    if (this.wasBlackoutForRite && !blackoutNow && this.blackoutUntil > 0) {
      rite.report('blackout', 1);
    }
    this.wasBlackoutForRite = blackoutNow;
  }

  /**
   * F93: mount the active state's menu onto a wall seen by the current
   * camera. A raycast hit supplies origin + wall normal; faceTowards()
   * flips the readable side at the viewer; the resulting normal becomes
   * a yaw for these axis-aligned walls. No hit falls back to a floating
   * plane four meters ahead facing the viewer.
   */
  private remountDiegeticMenus(): void {
    const menu = this.state === 'paused' ? this.wallPause : this.wallTitle;
    const other = this.state === 'paused' ? this.wallTitle : this.wallPause;
    other?.unmount();
    if (!menu || (this.state !== 'menu' && this.state !== 'paused')) return;
    const content = this.state === 'paused' ? PAUSE_WALL_MENU : TITLE_WALL_MENU;
    menu.refresh(content, 0);
    const cam = this.camera.position;
    let dir = new Vector3(0, 0, 1);
    try { dir = this.camera.getDirection(new Vector3(0, 0, 1)); } catch { /* default forward */ }
    let mounted = false;
    try {
      const ray = new Ray(cam.clone(), dir.scale(10), 10);
      const pick = this.scene.pickWithRay(
        ray,
        (m) => m.isEnabled() && m.isPickable && !m.name.startsWith('wallmenu'),
      );
      const p = pick?.pickedPoint;
      const n = pick?.hit && pick.getNormal(true);
      if (pick?.hit && p && n && Math.abs(n.y) < 0.5) {
        // diegmenus mounting helpers: wrap the hit as a WallPlane and aim
        // the readable side at the viewer before deriving the yaw.
        const faced = faceTowards(
          { origin: [p.x, p.y, p.z], normal: [n.x, n.y, n.z], up: [0, 1, 0] },
          [cam.x, cam.y, cam.z],
        );
        menu.mountAt({ x: p.x, z: p.z }, Math.atan2(faced.normal[0], faced.normal[2]));
        mounted = true;
      }
    } catch { /* picking unsupported here - fall through to floating */ }
    if (!mounted) {
      menu.mountAt({ x: cam.x + dir.x * 4, z: cam.z + dir.z * 4 }, Math.atan2(-dir.x, -dir.z));
    }
  }
  /** Wave A (A-1a): map the panel-store schema onto the game's SettingsData. */
  private panelToGameSettings(gs: GameSettings): SettingsData {
    return {
      sensitivity: gs.sensitivity,
      volume: gs.masterVolume,
      quality: presetToQualityNum(gs.quality),
      fov: gs.fov,
      subtitles: gs.subtitles,
    };
  }

  /**
   * F99: caption-kind -> anomaly severity class. Kinds outside this table
   * are not classified anomalies and keep their plain color-only cue.
   */
  private static readonly CAPTION_SEVERITY: Record<string, SeverityClass> = {
    THUNDER: 'info',
    HUNGER: 'info',
    FOOTSTEPS: 'warning',
    'IR STATIC': 'warning',
    SCREAM: 'critical',
    IMPACT: 'critical',
  };

  /**
   * F99: colorblind pattern-language flag. Gap note:
   * validateAccessibilityOptions() drops unknown keys, so until a
   * colorblindMode field lands in the a11y schema the flag is read
   * directly from the persisted accessibility JSON; default OFF.
   */
  private colorblindModeOn(): boolean {
    try {
      const raw = localStorage.getItem(ACCESSIBILITY_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed['colorblindMode'] === true;
    } catch {
      return false;
    }
  }

  /** Wave A (A-1b): route a loud-sound label through the caption layer. */
  private showAudioCaption(kind: string): void {
    if (!this.a11yCtl) return;
    try {
      // F99: classified anomaly captions gain a geometric pattern + pulse
      // tag when colorblind mode is on; unclassified kinds pass through.
      let label = kind;
      const sev = Game.CAPTION_SEVERITY[kind];
      if (sev) {
        const sig = anomalySignal(this.colorblindModeOn(), sev);
        if (sig) label = `[PATTERN ${sig.patternId} ${sig.pulseHz}Hz] [${kind}]`;
      }
      this.a11yCtl.showCaption(label);
    }
    catch (e) { console.warn('[bmb] caption failed', e); }
  }

  private setState(s: GameState): void {
    this.state = s;
    this.player.enabled = s === 'playing';
  }

  startNew(seedText: string): void {
    this.seed = seedText ? seedFromString(seedText) : seedFromString(String(Date.now()));
    // F2: re-bind district identity beds (office phones) to the fresh seed
    try { this.areaBeds?.seed(this.seed); }
    catch (e) { console.warn('[bmb] area beds seed failed', e); }
    // F7: fresh gait classifier + stride accumulators per run
    try { this.footstepDNA = new FootstepDNA(this.seed); }
    catch (e) { console.warn('[bmb] footstep dna unavailable', e); this.footstepDNA = null; }
    this.strideState = new WeakMap();
    // F14: fresh stagger state per run
    this.fallStagger = new FallStagger();
    this.updateStaggerBlur(0);
    this.beginRun({ x: SPAWN_X, z: SPAWN_Z, yaw: Math.PI * 0.75 });
    // F91 v1.1 debt: play the staged wake shots before control hands off
    this.beginWakeSequence();
    this.story.anchors(); // materialize guaranteed beacons
    this.chunks.story = this.story;
    this.ui.toast('EXPEDITION LOG — DAY 0\nYou fell asleep at your desk. The carpet hums under your hands. Somewhere out there a beacon is repeating the last honest words anyone wrote down.');
    void SaveDB.saveGame(this.captureSlot());
  }

  /**
   * F91 v1.1: true while the staged waking sequence is mounted, playing, and
   * in control of the camera (it only ever runs inside the playing state).
   */
  private wakePlaying(): boolean {
    return !!(this.wakeMount && this.wakeMount.playing && this.state === 'playing');
  }

  /**
   * F91 v1.1 debt mount: stage and play the seeded wake shots at run start,
   * before control hands off. The sequence rides the frame loop's last word
   * on the camera; any press/click (or the harness hook) dismisses it into
   * the existing rise. Motion-safety keeps the straight rise — every
   * cinematic camera move is generated motion.
   */
  private beginWakeSequence(): void {
    if (this.motionSafetyOn()) {
      this.player.beginWake();
      return;
    }
    try {
      this.player.enabled = false;
      this.wakeMount = new WakeMount(this.seed, SPAWN_X, SPAWN_Z, {
        applyPose: (p) => {
          this.camera.position.set(p.px, p.py, p.pz);
          this.camera.setTarget(new Vector3(p.tx, p.ty, p.tz));
          // The controller writes fov from baseFovRad only once gameplay
          // resumes, so the sequence owns it for now.
          (this.camera as unknown as { fov: number }).fov = (p.fovDeg * Math.PI) / 180;
        },
        onFinish: () => this.finishToRise(),
      });
    } catch (e) {
      console.warn('[bmb] wake cinematic unavailable', e);
      this.wakeMount = null;
      this.player.beginWake();
    }
  }

  /**
   * Public dismissal used by input skips and the __BMB__ harness hook: end
   * the sequence right now and hand control to the wake rise. No-op when
   * nothing is playing.
   */
  dismissWakeCinematic(): void {
    if (!this.wakePlaying()) return;
    this.wakeMount?.abort();
    this.finishToRise();
  }

  /**
   * Hand the camera back to the controller's rise after the closing shot:
   * restore gameplay FOV (neither the sequence nor the rise rewrites it),
   * aim the rise where the closing shot looked (beginWake adds its own
   * +0.15π yaw offset, so pre-subtract it around the shot direction), then
   * drop the mount and start the rise.
   */
  private finishToRise(): void {
    (this.camera as unknown as { fov: number }).fov = this.player.baseFovRad;
    try {
      const dir = this.camera.getDirection(new Vector3(0, 0, 1));
      if (Math.abs(dir.x) + Math.abs(dir.z) > 1e-4) {
        this.player.yaw = Math.atan2(-dir.x, -dir.z) - Math.PI * 0.15;
      }
    } catch { /* cosmetic alignment only */ }
    this.wakeMount = null;
    this.player.beginWake();
  }

  async continueGame(): Promise<void> {
    const slot = await SaveDB.loadGame();
    if (!slot) return;
    this.seed = slot.seed >>> 0;
    this.playtimeSec = slot.playtimeSec ?? 0;
    try {
      this.mem = MemoryField.deserialize(this.seed, (slot.mem as ReturnType<MemoryField['serialize']>) ?? null);
    } catch {
      this.mem = new MemoryField(this.seed);
    }
    try {
      this.weather = MemoryWeather.deserialize(this.seed ^ 0x5179, (slot.weather as ReturnType<MemoryWeather['serialize']>) ?? null);
    } catch {
      this.weather = new MemoryWeather(this.seed ^ 0x5179);
    }
    this.mem.weather = this.weather;
    this.chunks.mem = this.mem;
    try {
      this.story = StorySystem.deserialize(this.scene, this.seed, slot.story ?? null);
    } catch {
      this.story = new StorySystem(this.scene, this.seed);
    }
    const fl = slot.flash as { has: boolean; on: boolean; battery: number } | undefined;
    this.flashlight.has = !!(fl && fl.has);
    this.flashlight.on = !!(fl && fl.has && fl.on && fl.battery > 0.001);
    this.flashlight.battery = fl ? fl.battery : 1;
    const bt = (slot as { batteriesTaken?: string[] }).batteriesTaken;
    if (bt) for (const k of bt) this.consumedBatteries.add(k);
    const pe = (slot as { pathEcho?: { x: number; z: number }[] }).pathEcho;
    this.pastSessionPath = Array.isArray(pe) ? pe.slice(-200) : [];
    this.echoedRegions.clear();
    const ls = (slot as { landmarksSeen?: string[] }).landmarksSeen;
    if (ls) for (const name of ls) this.seenLandmarks.add(name);
    const stab = (slot as { stability?: number }).stability;
    if (typeof stab === 'number') this.erosion.stability = Math.max(0, Math.min(1, stab));
    const reloc = (slot as { relocations?: number }).relocations;
    if (typeof reloc === 'number') this.erosion.relocations = reloc;
    this.chunks.discoveredLandmarks = this.seenLandmarks;
    this.chunks.story = this.story;
    this.beginRun({ x: slot.px, z: slot.pz, yaw: slot.yaw });
    // F73: restore the saved pang schedule over beginRun's fresh one so a
    // continued expedition keeps its elapsed-hunger pacing. Malformed
    // payloads keep the fresh schedule (pacing flavor, not progression).
    if (slot.hunger && this.hunger && !this.hunger.restore(slot.hunger)) {
      console.warn('[bmb] hunger save unusable; keeping fresh pang schedule');
    }
    // F90: restore learned fear affinities over the fresh per-run model.
    // Malformed payloads keep the fresh model (deserialize throws loud, we
    // fall back soft — the learning feed is pacing flavor, not progression).
    const lraw = (slot as { learning?: string }).learning;
    if (typeof lraw === 'string') {
      try { this.learning = DirectorLearning.deserialize(lraw); }
      catch (e) { console.warn('[bmb] director-learning save unusable', e); }
    }
    // F26/F32: social-entity persistence — photo tallies shape the next
    // session's Archivist mood; the removal ledger keeps erased scrawls gone.
    const aenc = slot.archivistEncounters;
    if (aenc) {
      for (const [k, v] of Object.entries(aenc)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.archivistPhotos.set(k, Math.max(0, Math.floor(v)));
        }
      }
    }
    if (slot.custodian && !this.custodianWiring) {
      try { this.custodianWiring = CustodianWiring.restore(slot.custodian, { seed: this.seed }); }
      catch (e) { console.warn('[bmb] custodian save unusable', e); this.custodianWiring = null; }
      if (this.custodianWiring) {
        for (const r of this.custodianWiring.removalLedger) this.custodianRemovedKeys.add(r.markingId);
      }
    }
    if (this.flashlight.has) {
      this.ui.toast('TORCH RESTORED — charge ' + Math.round(this.flashlight.battery * 100) + '% [F]', 6000);
    }
    this.ui.toast('SIGNAL RESTORED — elapsed ' + Math.floor((slot.playtimeSec ?? 0) / 60) + ' min');
  }

  private beginRun(pos: { x: number; z: number; yaw: number }): void {
    this.chunks.seed = this.seed;
    this.chunks.reset();
    this.humans.reset();
    this.disposeSocialFigures(); // per-run visuals remount from the fresh seed
    this.archivist = null;
    this.chapelChoir = null;
    this.choirBuiltRev = -1;
    this.custodianNightActive = false;
    this.forceDeadLights.clear();
    // Wave C: forget accumulated emergency-light chunks for the fresh run
    try { this.emergencyWiring?.reset(); }
    catch (e) { console.warn('[bmb] emergency wiring reset failed', e); }
    this.blackoutUntil = 0;
    this.mem.seed = this.seed;
    this.weather = new MemoryWeather(this.seed ^ 0x5179);
    this.mem.weather = this.weather;
    const beginHost: DirectorHost = {
      lightingStress: (v) => { this.lighting.stressLevel = v; },
      killNearbyLight: () => this.killNearbyLight(),
      blackoutPulse: (sec) => { this.blackoutUntil = this.playtimeSec + sec; },
      whisperSurge: () => this.audio.whisper(),
      distantThreat: () => {},
      nonEuclideanNudge: () => this.nonEuclideanNudge(),
      armDoorwayLoop: (sec) => { this.loopArmedUntil = this.playtimeSec + sec; },
      requestEntitySpawn: (kind) => this.spawnEntity(kind),
      playerPosition: () => ({ x: this.player.body.x, z: this.player.body.z }),
      elapsed: () => this.playtimeSec,
    };
    // F48: fresh per-run persona so the temperament re-derives from the
    // new seed and the pacing stream restarts with the run.
    const runTemperament = temperamentForRun(this.seed);
    this.director = new HorrorDirector(beginHost, this.seed, undefined, {
      temperament: runTemperament,
      pacingRng: pacingRngFor(this.seed, runTemperament),
    });
    this.anomalies?.dispose();
    this.anomalies = new AnomalySystem(this.anomalyHost(), this.seed, this.director.events);
    this.deltas.revertAll(); // a fresh expedition finds the canonical world
    if (this.ghostLight) { this.ghostLight.intensity = 0; this.ghostLight.position.set(0, -100, 0); }
    this.loopArmedUntil = 0;
    this.prevCell = null;
    // Wave A: per-run resets for pure-logic state machines
    try { this.beats?.reset(); }
    catch (e) { console.warn('[bmb] beats reset failed', e); }
    this.prevStageChunk = null;
    // Wave B: per-run resets for scene/audio integrations
    try { this.gaze?.dispose(); }
    catch (e) { console.warn('[bmb] gaze reset failed', e); }
    this.gazeIds = new WeakMap();
    this.gazeAttached.clear();
    try { this.fauna?.resetOnNewExpedition(this.seed); }
    catch (e) { console.warn('[bmb] fauna reset failed', e); }
    try { this.weatherUi?.reset(); }
    catch (e) { console.warn('[bmb] weather ui reset failed', e); }
    // F17: fresh echo-geography recorder + replay state per run
    try { this.echoGeo = new EchoGeography(this.seed); }
    catch (e) { console.warn('[bmb] echo geography unavailable', e); this.echoGeo = null; }
    this.echoFootstepCount = 0;
    this.echoSiteKey = null;
    this.echoCueQueue.length = 0;
    this.echoPlaysThisEntry = 0;
    // F18: fresh clock-slippage tracker per run
    try { this.timeSlip = new TimeSlippage(this.seed); }
    catch (e) { console.warn('[bmb] time slippage unavailable', e); this.timeSlip = null; }
    this.slipZoneKey = null;
    this.slipWarned = false;
    // F21: fresh residue field + replay state per run
    try { this.residue = new ResidueField(this.seed); }
    catch (e) { console.warn('[bmb] residue field unavailable', e); this.residue = null; }
    this.residueBeatQueue.length = 0;
    this.residueLastPlaySec = -1e9;
    // F11: fresh torch pose model per run so sway phases re-seed; the shared
    // hand node persists. Rest pose sits at negative camera-local z (Babylon
    // forward is -Z), lens anchor ahead of the grip.
    if (this.torchTarget) {
      try {
        this.torchView = new TorchView(this.torchTarget, () => this.player.speed, {
          seed: this.seed,
          restPosition: { x: 0.18, y: -0.24, z: -0.38 },
          anchorLocal: { x: 0, y: 0.05, z: -0.14 },
        });
      } catch (e) { console.warn('[bmb] torch view unavailable', e); this.torchView = null; }
    }
    // F42: fresh camcorder per run — starts off and re-owns the drain seam;
    // battery provider drives the one-shot auto-cutoff.
    this.nvCutoffsSeen = 0;
    this.nvArtifactLastSec = -1e9;
    this.updateNVTint(0);
    this.flashlight.drainMultiplier = 1;
    try {
      this.nightvision = new NightVision(
        { setDrainMultiplier: (m) => { this.flashlight.drainMultiplier = m; } },
        { seed: (this.seed ^ 0x1eca7a) >>> 0, batteryLevel: () => this.flashlight.battery },
      );
    } catch (e) { console.warn('[bmb] night vision unavailable', e); this.nightvision = null; }
    // F22: fresh balance-tilt model per run (seed-jittered thresholds);
    // the lateral-velocity history starts empty at the spawn point.
    try { this.gravityTilt = new GravityTilt(this.seed); }
    catch (e) { console.warn('[bmb] gravity tilt unavailable', e); this.gravityTilt = null; }
    this.gravityTiltAppliedRad = 0;
    this.tiltPrevX = pos.x;
    this.tiltPrevZ = pos.z;
    // ---- Mount batch B: fresh per-run player-body models, re-seeded from
    // the run seed so identical seeds replay identically.
    this.tremor = new HandTremor((this.seed ^ 0x74f2) >>> 0);
    this.blinks = new BlinkScheduler((this.seed ^ 0xb121) >>> 0);
    this.updateBlinkVeil(0);
    this.adrenaline = new AdrenalineSystem();
    this.adrenalineHearingGainMul = 1;
    // F73: fresh pang schedule per run; continueGame()/restoreCheckpoint()
    // overwrite it with the slot's serialized schedule when one exists.
    this.hunger = new HungerPangs((this.seed ^ 0x4e71) >>> 0);
    this.hungerCaptionLastSec = -1e9;
    // F95: fresh hardcore battery model per run; the opt-in toggle lives in
    // the panel's VISUALS section and re-applies here so a continued
    // expedition restores the persisted mode (off = identity drive).
    this.flickerBattery = new FlickerBattery((this.seed ^ 0xf11c9) >>> 0);
    this.applyHardcoreBattery();
    this.flashlight.flickerCut = false;
    this.flashlight.flickerDim = 1;
    // F29: fresh visit ledger + gossip source per run (grounding is per-run)
    this.gossipSites.clear();
    this.gossipLedgerRev = 0;
    this.gossipBuiltRev = -1;
    this.gossipSource = null;
    // F94: fresh needle model per run; wells repopulate on the next resample
    this.lyingCompass = new LyingCompass();
    this.compassWellTimer = 0;
    // F96: journal hand reapplies on the next open note frame
    this.journalFontTimer = 0;
    this.journalEntryId = 'note:unread';
    // F50: fresh fire-exit gate per run (one seeded roll chain, one latch)
    this.exitVoid = new ExitVoidTracker(this.seed);
    this.exitVoidTaken = false;
    // F31: fresh ecosystem per run — spawn defers until chunk data streams
    // in (frame loop), so the moisture scan sees real world geometry.
    this.roachEco = null;
    this.roachSpawnTimer = 0;
    this.roachAccumulatorSec = 0;
    // F34: fresh receiver per run, grounded in the live discovery feed
    // (landmarks seen + beacons contacted) and the equipment loadout.
    try {
      this.radio = new SelfRadio({
        seed: (this.seed >>> 0).toString(16),
        getFeed: () => this.radioFeed(),
        getLoadout: () => this.radioLoadout(),
      });
    } catch (e) { console.warn('[bmb] self radio unavailable', e); this.radio = null; }
    this.radioLastLineSec = -1e9;
    // F35: fresh memo store per run — capture ids pin the seeded waveform
    // identity and the degraded render to this run's seed.
    this.memoStore = new VoiceMemoStore((this.seed >>> 0).toString(16));
    this.memoSeq = 0;
    // F46: the ledger feed restarts with every expedition
    this.runNoteIds.clear();
    // F100: never carry a credits walk into a fresh expedition
    this.cancelCreditsWalk();
    // F90: fresh fear-learning model per run; the known context tags start
    // at the uniform 0.5 baseline. The module takes no seed by design — it is
    // pure arithmetic over the injected event feed (determinism law).
    this.learning = new DirectorLearning(['landmark', 'note', 'watcher']);
    this.learningLingerKey = null;
    this.learningLingerSec = 0;
    this.learningLingerFired = false;
    this.learningBiasLastSec = -1e9;
    this.notePromptKey = null;
    this.learningReadNotes.clear();
    // F91: a fresh expedition never inherits the last run's wake cinematic.
    this.wakeStaging = null;
    this.wakeCine = null;
    this.wakeCineSkipped = false;
    // F91 v1.1: the mounted sequence dies with the run — silent abort, never
    // a handoff into whatever expedition beginRun is about to assemble.
    this.wakeMount?.abort();
    this.wakeMount = null;
    // near-miss telemetry + adrenaline arming reset with the fresh run
    this.nearMisses = 0;
    this.nearMissArmed = true;
    this.knownChunkKeys.clear();
    this.lastChunksBuiltSeen = 0;
    this.markedBeaconKeys.clear();
    this.prevMiniChunk = null;
    this.prevArcStage = this.story.stage;
    // F47: baseline the rite counters so only fresh progress counts today.
    this.dailyNotesReported = this.notesRead;
    this.dailyLandmarksReported = this.seenLandmarks.size;
    this.wasBlackoutForRite = false;
    // F93: no diegetic projection follows you into the run.
    this.wallTitle?.unmount();
    this.wallPause?.unmount();
    this.player.teleport(pos.x, pos.z, pos.yaw);
    this.setState('playing');
    this.ui.showHud();
    this.audio.unlock();
    this.input.requestLock();
    this.lastAutosave = this.playtimeSec;
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.ui.setPauseSummary(
      sectorName(this.seed, this.player.body.x, this.player.body.z) + ' · ' +
      Math.floor(this.playtimeSec / 60) + 'm elapsed · ' +
      this.story.discoveries + ' beacon(s) · stability ' +
      Math.round(this.erosion.stability * 100) + '%',
    );
    this.ui.showPause();
    // F93: project the pause menu onto the wall the player faces.
    this.wallMenuTimer = 0;
    try { this.remountDiegeticMenus(); } catch { /* projection is cosmetic */ }
    this.input.releaseLock();
    // Wave C (C-6): never leave the mix ducked if the intro is interrupted
    try { if (this.watcherIntro?.isActive()) this.audio.setMasterVolume(this.settings.volume); }
    catch { /* audio not ready */ }
    void this.saveNow();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('playing');
    this.ui.hidePause();
    this.wallPause?.unmount(); // F93: take the projected menu down with the DOM one
    this.input.requestLock();
    this.audio.unlock();
  }

  async saveNow(): Promise<void> {
    try {
      await SaveDB.saveGame(this.captureSlot());
    } catch { /* storage unavailable */ }
  }

  async saveAndQuit(): Promise<void> {
    const s = this.captureSlot();
    await this.saveNow();
    this.setState('menu');
    this.story.clearMeshes();
    this.humans.reset();
    this.disposeSocialFigures();
    this.ui.showTitle(true, Math.floor(s.playtimeSec / 60) + ' min · ' + (s.seed >>> 0).toString(16).toUpperCase().slice(0, 8));
    this.input.releaseLock();
  }

  captureSlot(): SaveSlot {
    const slot: SaveSlot = {
      seed: this.seed,
      px: this.player.body.x,
      pz: this.player.body.z,
      yaw: this.player.yaw,
      playtimeSec: this.playtimeSec,
      savedAt: Date.now(),
      version: 2,
      mem: this.mem.serialize(),
      weather: this.weather.serialize(),
      flash: { has: this.flashlight.has, on: this.flashlight.on, battery: this.flashlight.battery },
      batteriesTaken: [...this.consumedBatteries],
      landmarksSeen: [...this.seenLandmarks],
      stability: this.erosion.stability,
      relocations: this.erosion.relocations,
      completed: this.story.stage >= 4,
      pathEcho: this.pathHistory.filter((_, i) => i % 4 === 0).slice(-200).map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1) })),
      story: this.story.serialize(),
    };
    // F90: the learning state rides along as an optional extension field
    // (documented gap: SaveSlot itself is not extended — that type lives in
    // save/db.ts). deserialize() validates strictly, so older or malformed
    // slots fall back to a fresh model at load time.
    if (this.learning) (slot as { learning?: string }).learning = this.learning.serialize();
    // F26: photo tallies ride the slot so the next session's Archivist comes
    // back changed per the reaction table.
    if (this.archivistPhotos.size > 0) {
      slot.archivistEncounters = Object.fromEntries(this.archivistPhotos);
    }
    // F32: the removal ledger rides the slot so erasures survive sessions.
    if (this.custodianWiring && this.custodianWiring.removalLedger.length > 0) {
      slot.custodian = this.custodianWiring.serialize();
    }
    // F73: the pang schedule rides the slot so a continued expedition
    // resumes its elapsed-hunger pacing instead of a fresh grace period.
    if (this.hunger) slot.hunger = this.hunger.serialize();
    return slot;
  }

  // ---------- director actions ----------

  private killNearbyLight(): boolean {
    const px = this.player.body.x, pz = this.player.body.z;
    let best: { x: number; z: number } | null = null;
    let bd = 26 * 26;
    for (const f of this.chunks.allFixtures()) {
      if (!f.alive) continue;
      const k = f.x + ',' + f.z;
      if (this.forceDeadLights.has(k)) continue;
      const d = (f.x - px) ** 2 + (f.z - pz) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    if (!best) return false;
    this.forceDeadLights.add(best.x + ',' + best.z);
    this.audio.lightCrack();
    return true;
  }

  /** Plain-data view of the game the anomaly system is allowed to touch. */
  private anomalyHost(): AnomalyHost {
    return {
      playerPosition: () => ({ x: this.player.body.x, z: this.player.body.z }),
      playerYaw: () => this.player.yaw,
      elapsed: () => this.playtimeSec,
      blackoutActive: () => this.playtimeSec < this.blackoutUntil,
      edgeCodeBetweenCell: (fx, fz, tx, tz) => this.chunks.edgeCodeBetweenCell(fx, fz, tx, tz),
      teleportPlayer: (x, z) => {
        // build the immediate area synchronously so we never land in void,
        // then resolve against destination walls like nonEuclideanNudge
        for (let i = 0; i < 4; i++) this.chunks.update(x, z);
        this.player.teleport(x, z, this.player.yaw);
        moveCircle(this.player.body, 0, 0, this.chunks.collidersAround(x, z));
      },
      bumpChunkDrift: (cx, cz) => {
        this.deltas.bump(cx, cz);
        this.chunks.rebuildChunk(cx, cz); // no-op when the chunk is not loaded
      },
      nearestAliveFixture: (x, z, maxDist) => {
        let best: { x: number; z: number; key: string } | null = null;
        let bd = maxDist * maxDist;
        for (const f of this.chunks.allFixtures()) {
          if (!f.alive) continue;
          const d = (f.x - x) ** 2 + (f.z - z) ** 2;
          if (d < bd) { bd = d; best = { x: f.x, z: f.z, key: f.x + ',' + f.z }; }
        }
        return best;
      },
      setGhostLight: (x, z, intensity) => {
        if (!this.ghostLight) return;
        this.ghostLight.position.set(x, 2.86, z);
        this.ghostLight.intensity = intensity;
      },
      echoFootstep: (pan, volumeMul) => this.audio.echoFootstep(pan, 0, volumeMul),
      say: (text, seconds) => this.ui.say(text, seconds),
    };
  }

  private nonEuclideanNudge(): void {
    const yaw = this.player.yaw;
    // F3: nudge distance is a seeded draw so replays of the same run match
    const rng = new RNG(hash2i(Math.floor(this.playtimeSec * 10), 863, this.seed));
    const back = 28 + rng.range(0, 18);
    const dx = Math.sin(yaw) * -back;
    const dz = Math.cos(yaw) * -back;
    const colliders = this.chunks.collidersAround(this.player.body.x + dx, this.player.body.z + dz);
    this.player.teleport(this.player.body.x + dx, this.player.body.z + dz, this.player.yaw);
    // resolve against walls at destination so we never land inside geometry
    moveCircle(this.player.body, 0, 0, colliders);
  }

  private entityTimer = 8;
  private helperTimer = 200;
  private staffedLandmarks = new Set<string>();

  /** Ambient population: calm wanderers, post-discovery helpers, blackout incompletes. */
  private entityScheduler(dt: number): void {
    this.entityTimer -= dt;
    if (this.entityTimer > 0) return;
    this.entityTimer = 7;
    const rng = new RNG(hash2i(Math.floor(this.playtimeSec), 555, this.seed));
    // wanderers drift through during long calms
    if (this.director.phase === 'calm' && this.humans.count < 2 && rng.chance(0.3)) {
      this.spawnEntity('wanderer');
    }
    // during builds you start catching shapes standing far away
    if (this.director.phase === 'build' && this.humans.count < 3 && rng.chance(0.22)) {
      this.spawnEntity('watcher');
    }
    // sometimes your footsteps come back with company
    if (this.director.phase === 'build' && rng.chance(0.18)) {
      this.audio.startMirrorSteps(10 + rng.next() * 10);
    }
    // peaks: a light detaches and drifts toward you
    if (this.director.phase === 'peak' && rng.chance(0.25)) {
      this.lighting.startMigratingLight(this.player.body.x, this.player.body.z);
    }
    // your torch beam is visible from far away
    if (this.director.phase === 'peak' && this.flashlight.on && this.humans.count < 4 && rng.chance(0.3)) {
      this.spawnEntity('watcher');
    }
    // storage canyons: a figure at the far end of a long sightline
    if (this.director.phase === 'build' && this.chunks.districtAtPos(this.player.body.x, this.player.body.z) === (4 as number) && this.humans.count < 4 && rng.chance(0.2)) {
      const yaw = rng.next() * Math.PI * 2;
      const d = 30 + rng.next() * 10;
      this.spawnWatcherAt(this.player.body.x - Math.sin(yaw) * d, this.player.body.z - Math.cos(yaw) * d);
    }
    // landmark attendants: a figure stationed inside each named room.
    // CHAPEL gets a believer humming to itself; everywhere else gets a watcher.
    // Revisiting a previously-staffed landmark: a second figure has appeared.
    if (this.humans.count < 4) {
      for (const lm of this.chunks.landmarkCentersNear(this.player.body.x, this.player.body.z, 45)) {
        const revisited = this.staffedLandmarks.has(lm.key);
        if (revisited ? this.humans.count >= 3 : this.humans.count >= 4) continue;
        if (!revisited && this.staffedLandmarks.has(lm.key)) continue;
        if (revisited) this.staffedLandmarks.add(lm.key + ':r');
        else this.staffedLandmarks.add(lm.key);
        const ang2 = new RNG(hash2i(Math.floor(this.playtimeSec * 10), 957, this.seed)).range(0, Math.PI * 2);
        const wx = lm.x + Math.cos(ang2) * (revisited ? 2 : 3);
        const wz = lm.z + Math.sin(ang2) * (revisited ? 2 : 3);
        const type: HumanType = (() => {
          switch (lm.name) {
            case 'CHAPEL': return 'believer';
            case 'ARCHIVE': return 'incomplete';
            case 'MEDICAL BAY': return 'watcher';
            case 'CANTEEN': return 'wanderer';
            default: return 'watcher';
          }
        })();
        const f = this.humans.spawn(type, wx, wz, hash2i(Math.floor(wx), Math.floor(wz), this.seed ^ (revisited ? 0x5ec : 0x417d)));
        f.vanishAt = f.life + (revisited ? 60 : 90);
        break;
      }
    }
    // reconsolidation doubles: where your memories were copied, something
    // walks your walk — even outside peaks
    const memHere = this.mem.sampleAt(this.player.body.x, this.player.body.z);
    if (memHere.kind === MemoryKind.PERSONAL && memHere.intensity > 0.45 && rng.chance(0.25) && this.humans.count < 4) {
      const rk = Math.floor(this.player.body.x / 24) + ':' + Math.floor(this.player.body.z / 24);
      if (!this.reconsolidationDoubles.has(rk)) {
        this.reconsolidationDoubles.add(rk);
        const yaw = rng.next() * Math.PI * 2;
        const d = 16 + rng.next() * 8;
        const f = this.humans.spawn('double', this.player.body.x - Math.sin(yaw) * d, this.player.body.z - Math.cos(yaw) * d, hash2i(Math.floor(this.player.body.x), Math.floor(this.player.body.z), this.seed ^ 0xdc));
        f.vanishAt = f.life + 70;
        this.audio.whisper();
      }
    }
    // misleading safety: during long calms a figure stands far off in the fog
    if (this.director.phase === 'calm' && this.humans.count < 4 && rng.chance(0.14)) {
      const yaw = rng.next() * Math.PI * 2;
      const d = 38 + rng.next() * 8;
      const fx = this.player.body.x - Math.sin(yaw) * d;
      const fz = this.player.body.z - Math.cos(yaw) * d;
      const f = this.humans.spawn('watcher', fx, fz, hash2i(Math.floor(fx), Math.floor(fz), this.seed ^ 0xfa7));
      f.vanishAt = f.life + 120;
    }
    // misleading safety: during long calms a figure stands far off in the fog
    if (this.director.phase === 'calm' && this.humans.count < 4 && rng.chance(0.14)) {
      const yaw = rng.next() * Math.PI * 2;
      const d = 38 + rng.next() * 8;
      const fx = this.player.body.x - Math.sin(yaw) * d;
      const fz = this.player.body.z - Math.cos(yaw) * d;
      const f = this.humans.spawn('watcher', fx, fz, hash2i(Math.floor(fx), Math.floor(fz), this.seed ^ 0xfa7));
      f.vanishAt = f.life + 120;
    }
    // believers still work here
    if ((this.director.phase === 'calm' || this.director.phase === 'build') && this.humans.count < 4 && rng.chance(0.12)) {
      const yaw = rng.next() * Math.PI * 2;
      const d = 12 + rng.next() * 8;
      const bx = this.player.body.x - Math.sin(yaw) * d;
      const bz = this.player.body.z - Math.cos(yaw) * d;
      const f = this.humans.spawn('believer', bx, bz, hash2i(Math.floor(bx), Math.floor(bz), this.seed ^ 0xbe11));
      f.vanishAt = f.life + 100;
    }
    // the double: something walks your own wake back toward you
    if ((this.director.phase === 'peak' || this.director.phase === 'build') && rng.chance(0.15) && this.pathHistory.length > 40) {
      const old = this.pathHistory[Math.max(0, this.pathHistory.length - Math.floor(90 / 1.5))];
      if (old && Math.hypot(old.x - this.player.body.x, old.z - this.player.body.z) > 14) {
        const f = this.humans.spawn('double', old.x, old.z, hash2i(Math.floor(old.x), Math.floor(old.z), this.seed ^ 0xd0b1e));
        f.vanishAt = f.life + 55;
        // you hear it coming your way
        for (let i = 0; i < 4; i++) {
          setTimeout(() => this.audio.footstep(false, 0.22 - i * 0.04), 900 + i * 700);
        }
      }
    }
    // an incomplete stands in dead-light zones during peaks
    const fxNear = this.chunks.nearestFixtureDist(this.player.body.x, this.player.body.z);
    if (fxNear > 17 && this.director.phase === 'peak' && this.humans.count < 4 && rng.chance(0.35)) {
      const yaw = this.player.yaw + (rng.next() - 0.5) * 1.6;
      const d = 9 + rng.next() * 5;
      this.humans.spawn('incomplete', this.player.body.x - Math.sin(yaw) * d, this.player.body.z - Math.cos(yaw) * d, hash2i(Math.floor(this.playtimeSec), 77, this.seed));
      this.audio.whisper();
    }
    // a helper appears periodically once the expedition is underway
    if (this.story.stage >= 1 && this.story.stage < 4 && this.humans.count < 4) {
      this.helperTimer -= 7;
      if (this.helperTimer <= 0) {
        this.helperTimer = 220 + rng.next() * 160;
        const target = this.nearestBeacon();
        if (target) {
          const ang = Math.atan2(target.x - this.player.body.x, target.z - this.player.body.z);
          const hx = this.player.body.x - Math.sin(ang) * 11;
          const hz = this.player.body.z - Math.cos(ang) * 11;
          const f = this.humans.spawn('helper', hx, hz, hash2i(Math.floor(hx), Math.floor(hz), this.seed ^ 0x111));
          f.vanishAt = f.life + 90;
        }
      }
    }
  }

  private nearestBeacon(): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bd = Infinity;
    for (const b of this.story.beacons.values()) {
      if (b.found) continue;
      const d = Math.hypot(b.x - this.player.body.x, b.z - this.player.body.z);
      if (d < bd && d > 20) { bd = d; best = b; }
    }
    return best;
  }

  private static HELPER_LINES = [
    'It said you would come.',
    'The light remembers being a star. Do not tell it otherwise.',
    'Keep walking. The carpet is patient but you should not be.',
    'I had a face this morning. It is around here somewhere.',
  ];

  private static BELIEVER_LINES = [
    'Morning. Coffee machine on three is still out.',
    'They are saying the east stairwell moved again.',
    'You are new. Your badge has not faded yet.',
    'It fixes my tie every morning. I stopped asking how.',
    'Ignore the ones without faces. It is not personal with them.',
    'Put in the hours and eventually the walls let you home.',
  ];

  /**
   * F29: one grounded gossip line for a figure archetype, drawn over the
   * landmark visit ledger. The GossipSource rebuilds lazily whenever the
   * ledger changed since the last build (the revision bumps on every visit),
   * so fresh discoveries join the pool without per-frame reconstruction.
   * Returns null when nothing is groundable yet (empty ledger is
   * silence-safe) or dedup concedes; callers fall back to their scripted
   * pools. Draws flow through src/core/rng.ts keyed by (seed ^ GOSSIP_SALT)
   * with recency weighted by playtimeSec — no Date.now, no Math.random.
   */
  private gossipLine(kind: 'helper' | 'believer'): string | null {
    if (!this.gossipSource || this.gossipBuiltRev !== this.gossipLedgerRev) {
      this.gossipSource = new GossipSource(
        [...this.gossipSites.values()],
        (this.seed ^ GOSSIP_SALT) >>> 0,
      );
      this.gossipBuiltRev = this.gossipLedgerRev;
    }
    const line = this.gossipSource.generate(kind, this.playtimeSec);
    return line ? line.text : null;
  }

  /**
   * F94: feed the lying-compass needle model from the memory field. Every
   * COMPASS_RESAMPLE_SEC the neighborhood sweeps on a coarse grid and each
   * sample at or above COMPASS_WELL_MIN_INTENSITY becomes a memory well
   * with that intensity as pull strength; contamination tracks the zone
   * saturation at the player's own position, so a saturated district bends
   * the needle while clean halls read true (c = 0 is exact). Pure sampling
   * of mem.sampleAt — deterministic per field state, no clock, no RNG.
   *
   * Seam: the needle model stays mounted and fed on this cadence as the
   * F94 lie surface for UI consumers. The screen-edge beacon compass is
   * not one of them — its B-3b contract is a true bearing on the nearest
   * unfound beacon (same truthful feed as the minimap and the beacon-audio
   * pan), so contamination never bends that marker.
   */
  private updateLyingCompass(dt: number): void {
    if (!(dt > 0)) return;
    this.compassWellTimer -= dt;
    if (this.compassWellTimer > 0) return;
    this.compassWellTimer = COMPASS_RESAMPLE_SEC;
    const px = this.player.body.x;
    const pz = this.player.body.z;
    const wells: MemoryWell[] = [];
    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -2; gz <= 2; gz++) {
        const x = px + gx * COMPASS_WELL_GRID_M;
        const z = pz + gz * COMPASS_WELL_GRID_M;
        const s = Math.max(0, Math.min(1, this.mem.sampleAt(x, z).intensity));
        if (s >= COMPASS_WELL_MIN_INTENSITY) wells.push({ x, z, strength: s });
      }
    }
    this.lyingCompass.setWells(wells);
    this.lyingCompass.setContamination(
      Math.max(0, Math.min(1, this.mem.sampleAt(px, pz).intensity)),
    );
  }

  /**
   * F96: sanity has no dedicated stat, so the journal hand decays against a
   * proxy: 1 − zone saturation, where saturation is the memory-field
   * intensity at the player's position (the same reading the gravity tilt
   * and the lying compass consume). A clean hallway reads as steady hands;
   * standing inside a saturated zone shakes them, on top of the arc-stage
   * term folded in from story.stage by degradationIndex().
   */
  private get sanityProxy(): number {
    return 1 - Math.max(0, Math.min(1, this.mem.sampleAt(this.player.body.x, this.player.body.z).intensity));
  }

  /**
   * F96: restyle the open note body with the degrading journal hand:
   * entryJournalFont(degradationIndex(story.stage, sanityProxy), entryId)
   * drives an italic slant skew and an opacity loss of
   * JOURNAL_OPACITY_LOSS_PER_BREAK × glyph-break probability. entryId seeds
   * the per-entry ±10% wobble, so one page's handwriting differs from the
   * next while staying deterministic per (entryId, index).
   */
  private applyJournalHand(entryId: string): void {
    try {
      const body = document.querySelector('.note-paper p');
      if (!(body instanceof HTMLElement)) return;
      const index = degradationIndex(this.story.stage, this.sanityProxy);
      const font = entryJournalFont(index, entryId);
      body.style.transform = 'skewX(' + (-font.slantDeg).toFixed(2) + 'deg)';
      body.style.opacity = String(Math.max(
        0,
        1 - JOURNAL_OPACITY_LOSS_PER_BREAK * font.glyphBreakProbability,
      ));
    } catch (e) {
      console.warn('[bmb] journal hand restyle failed', e);
    }
  }

  private helperDialogue(): void {
    // F3: line picks are seeded draws (stable per run timeline)
    const rng = new RNG(hash2i(Math.floor(this.playtimeSec * 10), 1083, this.seed));
    const h = this.humans.nearestOf(this.player.body.x, this.player.body.z, ['helper']);
    if (h && !h.said) {
      h.said = true;
      // F29: a quarter of helper vocals come out as grounded gossip about
      // places the player actually visited; falls back to the scripted pool
      // when the ledger is still empty or dedup concedes.
      const gossiped = rng.chance(0.25) ? this.gossipLine('helper') : null;
      if (gossiped !== null) {
        this.ui.say(gossiped, 5);
      } else {
        const i = rng.int(0, Game.HELPER_LINES.length);
        this.ui.say(Game.HELPER_LINES[i], 5);
      }
    }
    const b = this.humans.nearestOf(this.player.body.x, this.player.body.z, ['believer']);
    if (b && performance.now() / 1000 - b.lastSpokeAt > 12) {
      b.lastSpokeAt = performance.now() / 1000;
      let line: string;
      if (this.flashlight.on) {
        line = 'Put that away. The light makes the walls come closer.';
      } else if (this.story.stage >= 3) {
        line = 'The white door opened for you. It never opened for us.';
      } else if (this.story.discoveries >= 2) {
        line = 'You keep finding their beacons. They keep not finding you.';
      } else {
        // F29: same grounding pass over the believer pool pick; scripted
        // context lines above stay verbatim because they answer the moment,
        // not the place.
        const gossiped = rng.chance(0.25) ? this.gossipLine('believer') : null;
        line = gossiped !== null
          ? gossiped
          : Game.BELIEVER_LINES[rng.int(0, Game.BELIEVER_LINES.length)];
      }
      this.ui.say(line, 4.5);
    }
  }

  private spawnWatcherAt(wx: number, wz: number): void {
    if (this.humans.count >= 4) return;
    const f = this.humans.spawn('watcher', wx, wz, hash2i(Math.floor(wx), Math.floor(wz), this.seed ^ 0xca9a));
    f.vanishAt = f.life + 60;
  }

  private spawnEntity(kind: 'watcher' | 'wanderer'): void {
    if (this.humans.count >= 4) return;
    const rng = new RNG(hash2i(Math.floor(this.playtimeSec * 10), 991, this.seed));
    const px = this.player.body.x, pz = this.player.body.z;
    const colliders = this.chunks.collidersAround(px, pz);
    if (kind === 'watcher') {
      // prefer a spot the player can actually SEE down their sightline
      let bx = 0, bz = 0, bs = -Infinity;
      for (let i = 0; i < 7; i++) {
        const ang = rng.next() * Math.PI * 2;
        const d = 16 + rng.next() * 11;
        const cxw = px - Math.sin(ang) * d;
        const czw = pz - Math.cos(ang) * d;
        let rel = ang - this.player.yaw;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        const visible = Math.abs(rel) < 0.9;
        const los = hasLineOfSight(cxw, czw, px, pz, colliders);
        const s = (visible ? 2 : 0) + (los ? 3 : 0);
        if (s > bs) { bs = s; bx = cxw; bz = czw; if (s >= 5) break; }
      }
      this.humans.spawn('watcher', bx, bz, hash2i(Math.floor(bx), Math.floor(bz), this.seed));
      // faint approaching knocks give the sighting an audio anchor
      for (let i = 0; i < 3; i++) {
        setTimeout(() => this.audio.footstep(false, 0.35 - i * 0.08), 500 + i * 420);
      }
      return;
    }
    const yaw = rng.next() * Math.PI * 2;
    const dist = 30 + rng.next() * 15;
    this.humans.spawn('wanderer', px - Math.sin(yaw) * dist, pz - Math.cos(yaw) * dist, hash2i(Math.floor(px), Math.floor(pz), this.seed));
  }

  // ---------- integrated systems boot ----------

  /**
   * Wave B: detect chunks that finished building since the last frame and
   * forward each one to FaunaWiring's spawn lottery, plus minimap visited
   * bookkeeping. Cheap when nothing new built (one integer compare).
   */
  private noteBuiltChunks(wx: number, wz: number): void {
    const pcx = Math.floor(wx / CHUNK_SIZE);
    const pcz = Math.floor(wz / CHUNK_SIZE);
    // minimap fog marks the visited chunk only on chunk change
    const miniKey = pcx + ':' + pcz;
    if (this.minimap && this.state !== 'menu' && miniKey !== this.prevMiniChunk) {
      this.prevMiniChunk = miniKey;
      try { this.minimap.markVisited(pcx, pcz); }
      catch (e) { console.warn('[bmb] minimap visit failed', e); }
    }
    if (this.chunks.totalBuilt === this.lastChunksBuiltSeen) return;
    this.lastChunksBuiltSeen = this.chunks.totalBuilt;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = cx + ':' + cz;
        if (this.knownChunkKeys.has(key)) continue;
        if (!this.chunks.layoutAt(cx, cz)) continue;
        this.knownChunkKeys.add(key);
        if (!this.fauna) continue;
        const district = this.chunks.districtAtPos(
          cx * CHUNK_SIZE + CHUNK_SIZE / 2, cz * CHUNK_SIZE + CHUNK_SIZE / 2,
        ) ?? 0;
        const lo = cx * CHUNK_SIZE, hi = (cx + 1) * CHUNK_SIZE;
        const loZ = cz * CHUNK_SIZE, hiZ = (cz + 1) * CHUNK_SIZE;
        const lights = this.chunks.allFixtures().filter((f) =>
          f.x >= lo && f.x < hi && f.z >= loZ && f.z < hiZ,
        );
        this.fauna.onChunkBuilt(cx, cz, district, lights);
      }
    }
  }

  /**
   * Wave B: per-player-chunk audio feeds — CabinetCreaks gets the real
   * cabinet props from the loaded layouts around here, and the fan audio
   * pair takes a deterministic per-chunk ceiling-fan speed state.
   */
  private refreshChunkAudio(pcx: number, pcz: number): void {
    const key = pcx + ':' + pcz;
    if (key === this.prevAudioChunk) return;
    this.prevAudioChunk = key;
    if (this.cabinetCreaks) {
      const cabs: { x: number; z: number }[] = [];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const layout = this.chunks.layoutAt(pcx + dx, pcz + dz);
          if (!layout) continue;
          for (const p of layout.props) {
            if (p.kind === 'cabinet') cabs.push({ x: p.x, z: p.z });
          }
        }
      }
      try { this.cabinetCreaks.setCabinets(cabs); }
      catch (e) { console.warn('[bmb] cabinet feed failed', e); }
    }
    if (this.fanSpeedAudio || this.fanAudio) {
      // deterministic stand-in until the fan mesh wiring lands: ~57% of
      // chunks host a spinning ceiling fan, speed rolled per chunk
      const roll = hash2i(pcx, pcz, 0xfa17) % 7;
      const states: FanSpeedState[] = ['SLOW', 'OFF', 'OFF', 'MEDIUM', 'SLOW', 'FAST', 'MEDIUM'];
      const state = states[roll] ?? 'OFF';
      try { this.fanSpeedAudio?.setState(state); }
      catch (e) { console.warn('[bmb] fan state feed failed', e); }
      const revs = state === 'OFF' ? 0 : state === 'SLOW' ? 0.9 : state === 'MEDIUM' ? 1.7 : 2.6;
      try { this.fanAudio?.setSpeed(revs); }
      catch (e) { console.warn('[bmb] fan speed feed failed', e); }
    }
  }

  private prevAudioChunk: string | null = null;

  /**
   * Construct every AudioContext-dependent integration exactly once, the
   * first frame after the audio engine has unlocked its context. Each
   * module is wrapped individually so one failing synth can never take
   * down boot or the rest of the mix.
   */
  private ensureAudioIntegrations(): void {
    if (this.audioModulesReady || !this.audio.started || !this.audio.ctx) return;
    const ctx = this.audio.ctx;
    const dest = ctx.destination;
    try { this.humAudio = new PositionalHum(ctx, dest); }
    catch (e) { console.warn('[bmb] PositionalHum unavailable', e); this.humAudio = null; }
    try { this.watcherSteps = new WatcherSteps(ctx, dest); }
    catch (e) { console.warn('[bmb] WatcherSteps unavailable', e); this.watcherSteps = null; }
    try { this.surfaceFootsteps = new SurfaceFootsteps(ctx, dest); }
    catch (e) { console.warn('[bmb] SurfaceFootsteps unavailable', e); this.surfaceFootsteps = null; }
    try { this.score = new DynamicScore(ctx, dest); }
    catch (e) { console.warn('[bmb] DynamicScore unavailable', e); this.score = null; }
    try { this.exterior = new ExteriorBleed(ctx, dest); }
    catch (e) { console.warn('[bmb] ExteriorBleed unavailable', e); this.exterior = null; }
    // ---- Wave B (B-1): extended audio pack, each in its own failure island ----
    try { this.doorCreaks = new DoorCreaks(ctx, dest); }
    catch (e) { console.warn('[bmb] DoorCreaks unavailable', e); this.doorCreaks = null; }
    try { this.groans = new StructureGroans(ctx, dest); }
    catch (e) { console.warn('[bmb] StructureGroans unavailable', e); this.groans = null; }
    try { this.vents = new VentAudio(ctx, dest); }
    catch (e) { console.warn('[bmb] VentAudio unavailable', e); this.vents = null; }
    try { this.elevatorAmb = new ElevatorAmbience(ctx, dest); }
    catch (e) { console.warn('[bmb] ElevatorAmbience unavailable', e); this.elevatorAmb = null; }
    try { this.crowd = new CrowdAmbience(ctx, dest); }
    catch (e) { console.warn('[bmb] CrowdAmbience unavailable', e); this.crowd = null; }
    try { this.loreStings = new LoreStings(ctx, dest); }
    catch (e) { console.warn('[bmb] LoreStings unavailable', e); this.loreStings = null; }
    try { this.batteryCues = new BatteryCues(ctx, dest); }
    catch (e) { console.warn('[bmb] BatteryCues unavailable', e); this.batteryCues = null; }
    // ---- F73 v1.1 debt payoff: drained pang events drive a real growl ----
    try { this.stomachAudio = new StomachAudio(ctx, dest); }
    catch (e) { console.warn('[bmb] StomachAudio unavailable', e); this.stomachAudio = null; }
    try { this.electricPops = new ElectricPops(ctx, dest); }
    catch (e) { console.warn('[bmb] ElectricPops unavailable', e); this.electricPops = null; }
    try { this.fanAudio = new FanAudio(ctx, dest); }
    catch (e) { console.warn('[bmb] FanAudio unavailable', e); this.fanAudio = null; }
    try { this.fanSpeedAudio = new FanSpeedAudio(ctx, dest); }
    catch (e) { console.warn('[bmb] FanSpeedAudio unavailable', e); this.fanSpeedAudio = null; }
    try { this.cabinetCreaks = new CabinetCreaks(ctx, dest); }
    catch (e) { console.warn('[bmb] CabinetCreaks unavailable', e); this.cabinetCreaks = null; }
    try { this.echoSites = new EchoSites(ctx, dest); }
    catch (e) { console.warn('[bmb] EchoSites unavailable', e); this.echoSites = null; }
    // ---- F32: cart-squeak approach loop joins the shared graph ----
    try { this.cartSqueaks = new CartSqueaks(ctx, dest); }
    catch (e) { console.warn('[bmb] CartSqueaks unavailable', e); this.cartSqueaks = null; }
    // ---- Wave B (B-2m): fauna skitter voice joins the shared graph ----
    try { this.fauna?.attachAudio(ctx); }
    catch (e) { console.warn('[bmb] fauna audio unavailable', e); }
    // ---- F2: player breath embodiment cycles on the shared graph ----
    try {
      this.breathHandle = mountPlayerBreath({
        ctx,
        destination: dest,
        playerEvents: this.player.events,
        tension: () => this.director.tension,
        blackout: () => this.playtimeSec < this.blackoutUntil,
        // F9: winded players breathe harder — fatigue folds into tension
        effort: () => Math.max(0, Math.min(1, (this.player.staminaEngine.breathRateMul - 1) / 0.8)),
      });
    } catch (e) { console.warn('[bmb] breath mount unavailable', e); this.breathHandle = null; }
    // ---- F2: per-district identity beds (maze/office/honeycomb/corridor/storage) ----
    try {
      this.areaBeds = new AreaIdentityBeds(ctx, dest);
      this.areaBeds.seed(this.seed);
    } catch (e) { console.warn('[bmb] area beds unavailable', e); this.areaBeds = null; }
    // ---- F5: binaural whisper field pinned around the listener ----
    try {
      this.whispers = new WhisperField(
        ctx,
        () => ({ x: this.player.body.x, z: this.player.body.z, yaw: this.player.yaw }),
        { seed: (this.seed ^ 0x57686973) >>> 0 },
      );
    } catch (e) { console.warn('[bmb] WhisperField unavailable', e); this.whispers = null; }
    // ---- F6: dread-silence duck over the total mix ----
    try {
      const bus = this.audio.masterBus;
      this.dread = bus ? new DreadSilence(bus, { seed: (this.seed ^ 0x64726561) >>> 0 }) : null;
    } catch (e) { console.warn('[bmb] DreadSilence unavailable', e); this.dread = null; }
    this.audioModulesReady = true;
  }

  /** F14: full-screen backdrop-blur veil whose opacity tracks the stagger envelope. */
  private updateStaggerBlur(amp: number): void {
    if (typeof document === 'undefined') return;
    if (!this.staggerBlurEl) {
      const el = document.createElement('div');
      el.id = 'bmb-stagger-blur';
      el.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:5;' +
        'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0';
      document.body.appendChild(el);
      this.staggerBlurEl = el;
    }
    this.staggerBlurEl.style.opacity = String(Math.max(0, Math.min(0.85, amp)));
  }

  /**
   * F42: full-screen green IR grade whose opacity tracks the night-vision
   * envelope (same lazy fixed-div pattern as the stagger-blur veil). The
   * color matches the module's NV_TINT_BASE; the 0.08 opacity ceiling keeps
   * the grade readable-through, never a green wall.
   */
  private updateNVTint(envelope: number): void {
    if (typeof document === 'undefined') return;
    if (!this.nvTintEl) {
      const el = document.createElement('div');
      el.id = 'bmb-nv-tint';
      el.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:6;' +
        'background:rgba(56,255,97,1);opacity:0';
      document.body.appendChild(el);
      this.nvTintEl = el;
    }
    this.nvTintEl.style.opacity = String(Math.max(0, Math.min(0.08, envelope * 0.08)));
  }

  /**
   * F74: full-screen black eyelid veil whose opacity tracks the blink
   * closure envelope (same lazy fixed-div pattern as the stagger-blur veil).
   * The 0.85 opacity ceiling keeps even peak blinks readable-through.
   */
  private updateBlinkVeil(closure: number): void {
    if (typeof document === 'undefined') return;
    if (!this.blinkVeilEl) {
      const el = document.createElement('div');
      el.id = 'bmb-blink-veil';
      el.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:7;' +
        'background:#000;opacity:0';
      document.body.appendChild(el);
      this.blinkVeilEl = el;
    }
    this.blinkVeilEl.style.opacity = String(Math.max(0, Math.min(0.85, 0.85 * closure)));
  }

  // ---------- frame ----------

  private frame(): void {
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    const active = this.state === 'playing';
    if (active) this.playtimeSec += dt;

    // F100: drive the credits walk while the transient credits state is held
    if (this.state === 'credits') this.tickCreditsWalk(dt);

    // title-screen attract camera drifts through the world behind the menu
    if (this.state === 'menu') {
      this.attract.t += dt;
      const ax = 8 + this.attract.t * 0.55;
      const az = 8 + Math.sin(this.attract.t * 0.11) * 14;
      this.attract.x = ax; this.attract.z = az;
      this.chunks.update(ax, az);
      this.camera.position.set(ax, 1.55, az);
      const sway = Math.sin(this.attract.t * 0.21) * 0.35;
      this.camera.rotation.set(Math.sin(this.attract.t * 0.16) * 0.05, -Math.PI / 2 + sway, Math.sin(this.attract.t * 0.09) * 0.02);
    }

    const colliders = this.chunks.collidersAround(
      this.state === 'menu' ? this.attract.x : this.player.body.x,
      this.state === 'menu' ? this.attract.z : this.player.body.z,
    );
    // F22 baseline capture: the controller REWRITES rotation.z every update
    // (lean roll), so strip our own prior tilt contribution from the
    // pre-update roll to recover lean + shake as the baseline the new tilt
    // adds onto — the tilt can then never accumulate frame over frame.
    const tiltBaselineZ = this.camera.rotation.z - this.gravityTiltAppliedRad;
    this.player.update(active ? dt : 0, colliders);
    // F8: stride onsets drift toward the heartbeat under tension — the
    // controller advances its bob cycle by this externally computed scale.
    if (active) {
      const hb = excitedHeartbeatPeriod(this.director.tension);
      const nominalStride = Math.PI / Math.max(0.5, this.player.speed * BOB_FREQUENCY);
      const off = dreadOffset(this.director.tension, nominalStride, hb);
      this.player.strideRateScale = Math.max(0.65, Math.min(1.35, 1 - off / Math.max(0.05, nominalStride)));
    } else {
      this.player.strideRateScale = 1;
    }
    // F14: fall-stagger control damp + screen blur envelope
    this.player.inputScale = active ? this.fallStagger.inputScale : 1;
    if (this.fallStagger.active) this.fallStagger.update(dt);
    this.updateStaggerBlur(this.fallStagger.blurAmp);

    // F22: gravity ambivalence — inside memory-saturated zones the horizon
    // tilts toward the veer the walk history settles on. The summed roll is
    // clamped to the tilt cap (±5°) on top of the lean bound.
    // F49: motion-safety also zeroes the tilt displacement force.
    if (this.gravityTilt && !this.motionSafetyOn()) {
      try {
        if (active && dt > 0) {
          const vx = (this.player.body.x - this.tiltPrevX) / dt;
          const vz = (this.player.body.z - this.tiltPrevZ) / dt;
          // right vector of the yaw frame — the same basis Flashlight aims with
          const lateral = vx * Math.cos(this.player.yaw) - vz * Math.sin(this.player.yaw);
          const sat = Math.max(0, Math.min(1, this.mem.sampleAt(this.player.body.x, this.player.body.z).intensity));
          this.gravityTiltAppliedRad = (this.gravityTilt.update(sat, lateral, dt) * Math.PI) / 180;
        } else {
          this.gravityTilt.reset();
          this.gravityTiltAppliedRad = 0;
        }
        this.tiltPrevX = this.player.body.x;
        this.tiltPrevZ = this.player.body.z;
        const maxRoll = TILT_MAX_RAD + LEAN_ROLL_MAX;
        this.camera.rotation.z = Math.max(-maxRoll, Math.min(maxRoll, tiltBaselineZ + this.gravityTiltAppliedRad));
      } catch (e) {
        console.warn('[bmb] gravity tilt failed', e);
        this.gravityTilt.reset();
        this.gravityTiltAppliedRad = 0;
        this.camera.rotation.z = tiltBaselineZ;
      }
    }

    if (active) {
      this.mem.recordPresence(this.player.body.x, this.player.body.z, dt);
      this.mem.tick(dt);
      // F94: coarse well sweep + contamination refresh on its ~2 s cadence
      try { this.updateLyingCompass(dt); }
      catch (e) { console.warn('[bmb] lying compass feed failed', e); }
      // landmark discovery: one-time line per named room
      if (this.playerLandmark !== this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z)) {
        this.playerLandmark = this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z);
        // F29: every landmark occupancy feeds the visit ledger — first
        // discovery or revisit alike, since recency is what gossip weights.
        if (this.playerLandmark) {
          this.gossipSites.set(this.playerLandmark, {
            siteKey: this.playerLandmark,
            kind: 'landmark',
            name: this.playerLandmark,
            lastVisitedAt: this.playtimeSec,
          });
          this.gossipLedgerRev++;
        }
        if (this.playerLandmark && !this.seenLandmarks.has(this.playerLandmark)) {
          this.seenLandmarks.add(this.playerLandmark);
          const lines: Record<string, string> = {
            'EXECUTIVE OFFICE': '...an executive office, sealed and lit, miles below any building...',
            'LAUNDRY': '...industrial washers, running for no one, forever...',
            'CHAPEL': '...pews facing nothing. It built this one carefully.',
            'PLAYROOM': '...you hear children. There are no children. Only the shapes they left.',
            'CANTEEN': '...two long tables. Every chair is already pulled out for someone.',
            'ARCHIVE': '...shelves of files about people who were never hired here.',
            'SECURITY STATION': '...a wall of monitors. All of them show this room.',
            'MEDICAL BAY': '...the gurneys are made up. Someone expects patients.',
          };
          this.ui.say(lines[this.playerLandmark] ?? ('...' + this.playerLandmark.toLowerCase() + '...'), 5);
          // the space copies your visit into its own memory
          this.mem.inject(this.player.body.x, this.player.body.z, MemoryKind.PERSONAL, 0.3);
          this.audio.landmarkChord();
          // Wave B (B-3a): pin the room on the minimap
          try { this.minimap?.markLandmark(this.player.body.x, this.player.body.z, this.playerLandmark); }
          catch (e) { console.warn('[bmb] minimap landmark failed', e); }
        }
      }
      // the space remembering YOU: entering strong personal-memory regions
      {
        const s = this.mem.sampleAt(this.player.body.x, this.player.body.z);
        this.audio.setZoneAmbient(s.kind as number);
        const inLandmark = !!this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z);
        this.audio.setSpaceSize(inLandmark ? 0.5 : 0.18);
        const dist = this.chunks.districtAtPos(this.player.body.x, this.player.body.z);
        this.audio.setStorageAmbient(dist === (4 as number));
        // watcher proximity: dissonant beating swells within ~12 m
        let wd = Infinity;
        for (const f of this.humans.figures) {
          if (f.type !== 'watcher' && f.type !== 'double') continue;
          const d = Math.hypot(f.body.x - this.player.body.x, f.body.z - this.player.body.z);
          if (d < wd) wd = d;
        }
        this.audio.setWatchProximity(isFinite(wd) ? Math.max(0, 1 - wd / 12) : 0);
        this.audio.setLandmarkAmbient(inLandmark ? this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z) ?? null : null);
        const rk = Math.floor(this.player.body.x / 24) + ',' + Math.floor(this.player.body.z / 24);
        if (s.kind === MemoryKind.PERSONAL && s.intensity > 0.35 && !this.seenPersonal.has(rk)) {
          this.seenPersonal.add(rk);
          if (this.seenPersonal.size > 400) this.seenPersonal.clear();
          const cues = [
            '...the carpet here remembers your weight...',
            '...somewhere behind the walls, your name is being pronounced badly...',
            '...this hallway was copied from a memory of you copying it...',
          ];
          // F3: cue pick is a seeded draw (replay-stable)
          this.ui.say(cues[new RNG(hash2i(Math.floor(this.playtimeSec * 10), 1374, this.seed)).int(0, cues.length)], 5);
          setTimeout(() => { this.audio.footstep(false); }, 700);
          setTimeout(() => { this.audio.footstep(false); }, 1500);
          this.mem.inject(this.player.body.x, this.player.body.z, MemoryKind.PERSONAL, 0.3);
        }
      }
      if (this.weather.update(dt, this.player.body.x, this.player.body.z)) {
        if (this.playtimeSec > 45) {
          this.ui.toast('The air feels different. Something has moved through this place.', 7000);
        }
      }
      this.lighting.setWeatherTint(this.weather.fogTint(), dt);
      // scars: more relocations = heavier permanent vignette
      this.lighting.setVignetteWeight(2.6 + Math.min(3, this.erosion.relocations * 0.8));
      // contamination atmosphere: reconstruction zones breathe denser, warmer murk
      {
        const layouts = this.chunks.loadedLayouts();
        this.fogVar.updateContamSet(layouts.map((l) => ({ cx: l.cx, cz: l.cz, intensity: l.memIntensity })));
        this.fogVar.updatePuddleSet(layouts.flatMap((l) => l.puddles));
        this.lighting.setContamination(
          this.fogVar.multiplierAt(this.player.body.x, this.player.body.z),
          this.fogVar.warmthAt(this.player.body.x, this.player.body.z),
        );
      }
      const dist = this.chunks.districtAtPos(this.player.body.x, this.player.body.z);
      if (dist !== null) this.lighting.setDistrictFog(dist, dt);
      this.director.update(dt);
      // spatial anomalies: consume director windows, drive the wrongness
      this.anomalies?.update(dt);
      // Wave A (A-2c): ambient story beats surface as quiet observations.
      if (this.beats) {
        try {
          const beatLine = this.beats.update(dt, {
            playtimeSec: this.playtimeSec,
            discoveries: this.story.discoveries,
            notesRead: this.notesRead,
            landmarksSeen: this.seenLandmarks,
            stability: this.erosion.stability,
            phase: this.director.phase,
          });
          if (beatLine) this.ui.say(beatLine, 7);
        } catch (e) {
          console.warn('[bmb] story beats failed', e);
        }
      }
      // Wave A (A-5a): day-cycle drift freezes during blackouts.
      if (this.daycycle) {
        try { this.daycycle.update(dt, this.playtimeSec < this.blackoutUntil); }
        catch (e) { console.warn('[bmb] day cycle failed', e); }
      }
      // Wave C world-FX: heat-shimmer feed. Project the nearest alive fixture
      // heads to CSS-pixel rects and hand them to the DOM overlay; pure DOM
      // work downstream, no scene or render-loop cost beyond the projection.
      if (this.state === 'playing' && this.heatShimmer) {
        try {
          const rw = this.engine.getRenderWidth();
          const rh = this.engine.getRenderHeight();
          if (rw >= 2 && rh >= 2) {
            const vp = this.camera.viewport.toGlobal(rw, rh);
            const transform = this.scene.getTransformMatrix();
            const camPos = this.camera.globalPosition;
            const fwd = this.camera.getDirection(CAMERA_FORWARD);
            // Tubes hang just under the ceiling plane and span one corridor cell.
            const headY = WALL_H - 0.12;
            const halfTubeM = CELL_SIZE / 2;
            const fLen = Math.hypot(fwd.x, fwd.z) || 1;
            const rightX = fwd.z / fLen;
            const rightZ = -fwd.x / fLen;
            const candidates: { x: number; z: number; d2: number }[] = [];
            for (const l of this.chunks.loadedLayouts()) {
              for (const f of l.lights.filter((f) => f.alive)) {
                const dx = f.x - camPos.x;
                const dz = f.z - camPos.z;
                candidates.push({ x: f.x, z: f.z, d2: dx * dx + dz * dz });
              }
            }
            candidates.sort((a, b) => a.d2 - b.d2);
            const rects: FixtureScreen[] = [];
            for (const c of candidates) {
              if (rects.length >= MAX_SHIMMER_ZONES) break;
              const wx = c.x - camPos.x;
              const wy = headY - camPos.y;
              const wz = c.z - camPos.z;
              // behind-camera cull: fixture must lie in the forward half-space
              if (wx * fwd.x + wy * fwd.y + wz * fwd.z <= 0) continue;
              const center = Vector3.Project(new Vector3(c.x, headY, c.z), Matrix.Identity(), transform, vp);
              if (center.z < 0 || center.z > 1) continue;
              const endA = Vector3.Project(new Vector3(c.x - rightX * halfTubeM, headY, c.z - rightZ * halfTubeM), Matrix.Identity(), transform, vp);
              const endB = Vector3.Project(new Vector3(c.x + rightX * halfTubeM, headY, c.z + rightZ * halfTubeM), Matrix.Identity(), transform, vp);
              const width = Math.abs(endB.x - endA.x);
              if (!(width > 0)) continue;
              rects.push({ left: center.x - width / 2, top: center.y, width });
            }
            let intensity = 0.5; // neutral default before day-cycle phase data exists
            if (this.daycycle) intensity = shimmerIntensity(false, this.daycycle.dayProgress());
            this.heatShimmer.update(rects, intensity);
          }
        } catch (e) { console.warn('[bmb] heat shimmer feed failed', e); }
      }
      // Wave A (A-4): world-decay stage bookkeeping.
      try { this.wallCracks?.addActivity(this.player.body.x, this.player.body.z, dt); }
      catch (e) { console.warn('[bmb] crack activity failed', e); }
      {
        const stageChunk = Math.floor(this.player.body.x / CHUNK_SIZE) + ':' + Math.floor(this.player.body.z / CHUNK_SIZE);
        if (stageChunk !== this.prevStageChunk) {
          this.prevStageChunk = stageChunk;
          try { this.stainGrowth?.noteChunkEntry(stageChunk); }
          catch (e) { console.warn('[bmb] stain growth failed', e); }
          try { this.graffitiEvolution?.noteChunkEntry(stageChunk); }
          catch (e) { console.warn('[bmb] graffiti evolution failed', e); }
        }
      }
      // Wave B (B-2n): reconcile + advance gaze controllers ahead of the sim step.
      if (this.gaze) {
        try {
          const seen = new Set<string>();
          for (const f of this.humans.figures) {
            let id = this.gazeIds.get(f);
            if (!id) {
              id = 'fig' + (this.gazeNextId++);
              this.gazeIds.set(f, id);
            }
            if (!this.gazeAttached.has(id)) {
              this.gaze.attach(id, new GazeController({
                watcher: f.type === 'watcher' || f.type === 'double',
                seed: hash2i(Math.floor(f.body.x * 4), Math.floor(f.body.z * 4), this.seed),
              }));
              this.gazeAttached.set(id, f);
            }
            seen.add(id);
          }
          for (const [id, fig] of this.gazeAttached) {
            if (!seen.has(id)) {
              this.gaze.detach(id);
              this.gazeAttached.delete(id);
            }
          }
          this.gaze.updateAll(dt, this.player.body.x, this.player.body.z);
        } catch (e) {
          console.warn('[bmb] gaze update failed', e);
        }
      }
      this.humans.update(dt, this.player.body.x, this.player.body.z, this.player.yaw, colliders, { on: this.flashlight.on });
      // Social entities (F26/F32/F61): archivist circuit, custodian night
      // pass + cart squeaks, chapel hymn. Guarded: flavor never breaks frames.
      try { this.updateSocialEntities(dt, colliders); }
      catch (e) { console.warn('[bmb] social entities failed', e); }
      // F7: footstep DNA — learn each earshot walker's gait and flag wrong
      // cadence before line of sight. Energy fractions come from the same
      // seeded archetype signature the step synth uses (documented prior).
      if (this.footstepDNA) {
        try {
          for (const fig of this.humans.figures) {
            const dxF = fig.body.x - this.player.body.x;
            const dzF = fig.body.z - this.player.body.z;
            if (dxF * dxF + dzF * dzF > 18 * 18) { this.strideState.delete(fig); continue; }
            let st = this.strideState.get(fig);
            if (!st) {
              st = { lastX: fig.body.x, lastZ: fig.body.z, acc: 0, lastStepAt: this.playtimeSec, window: [], flagged: false };
              this.strideState.set(fig, st);
            }
            st.acc += Math.hypot(fig.body.x - st.lastX, fig.body.z - st.lastZ);
            st.lastX = fig.body.x;
            st.lastZ = fig.body.z;
            if (st.acc < 0.75) continue; // one stride ≈ 0.75 m of travel
            st.acc = 0;
            const sig = gaitSignature(fig.type, this.seed);
            const interval = Math.max(0.2, this.playtimeSec - st.lastStepAt);
            st.lastStepAt = this.playtimeSec;
            // spectral balance: signature prior + small seeded per-step jitter
            const jr = new RNG(hash2i(Math.floor(this.playtimeSec * 60), 7717, this.seed));
            const obs: StepObservation = {
              interval,
              low: sig.low * (0.9 + jr.next() * 0.2),
              mid: sig.mid * (0.9 + jr.next() * 0.2),
              high: sig.high * (0.9 + jr.next() * 0.2),
            };
            this.footstepDNA.observe(fig.type, obs);
            st.window.push(obs);
            if (st.window.length > CLASSIFY_WINDOW) st.window.shift();
            if (st.flagged || st.window.length < CLASSIFY_WINDOW) continue;
            const id = this.footstepDNA.classifyWindow(st.window);
            const seen = hasLineOfSight(fig.body.x, fig.body.z, this.player.body.x, this.player.body.z, colliders);
            if (!seen && id.confidence > 0.8 && (id.type === 'watcher' || id.type === 'double')) {
              st.flagged = true; // once per figure per run
              this.showAudioCaption('FOOTSTEPS'); // a11y caption overlay takes arbitrary kinds
              this.ui.say('...footfalls out there keep a rhythm nothing human owns...', 4);
            }
          }
        } catch (e) {
          console.warn('[bmb] footstep dna update failed', e);
        }
      }
      // Wave B (B-2m): ambient fauna tick directly after the human sim
      if (this.fauna) {
        try {
          this.fauna.updateAll(dt, this.player.body.x, this.player.body.z, this.player.yaw,
            colliders, this.flashlight.on, this.chunks.allFixtures());
        } catch (e) {
          console.warn('[bmb] fauna update failed', e);
        }
      }
      // ---- F34: advance the self-tuning receiver; when a grounded station
      // locks in strongly enough, surface its deterministic broadcast body
      // through ui.say, throttled to at most one line every 45 s.
      if (this.radio) {
        try {
          this.radio.update(dt);
          const air = this.radio.onAir();
          if (air && air.clarity > 0.25 && this.playtimeSec - this.radioLastLineSec >= 45) {
            this.radioLastLineSec = this.playtimeSec;
            this.ui.say(air.script[1], 6);
          }
        } catch (e) {
          console.warn('[bmb] self radio update failed', e);
        }
      }
      // ---- Mount batch G (F31): roach ecosystems on the adapted chunk
      // grid. Spawn defers until world data streams in; ticks run on a
      // ROACH_TICK_SEC fixed-step accumulator so population dynamics stay
      // seed-replayable regardless of frame rate.
      if (!this.roachEco) {
        this.roachSpawnTimer -= dt;
        if (this.roachSpawnTimer <= 0) {
          this.roachSpawnTimer = 2;
          this.spawnRoachEcosystem();
        }
      } else {
        this.roachAccumulatorSec += dt;
        while (this.roachAccumulatorSec >= ROACH_TICK_SEC) {
          this.roachAccumulatorSec -= ROACH_TICK_SEC;
          try {
            this.roachEco.doTick();
          } catch (e) {
            console.warn('[bmb] roach tick failed', e);
            this.roachAccumulatorSec = 0;
            break;
          }
        }
      }
      // record the wake you leave behind (the double walks it back to you)
      this.pathSampleTimer -= dt;
      if (this.pathSampleTimer <= 0) {
        this.pathSampleTimer = 0.5;
        this.pathHistory.push({ x: this.player.body.x, z: this.player.body.z, t: this.playtimeSec });
        const cutoff = this.playtimeSec - 150;
        while (this.pathHistory.length && this.pathHistory[0].t < cutoff) this.pathHistory.shift();
      }
      // flashlight simulation (drains on, trickles under working lights)
      const nearLit = this.playtimeSec >= this.blackoutUntil && this.chunks.nearestFixtureDist(this.player.body.x, this.player.body.z) < 8;
      this.flashlight.update(dt, now / 1000, this.camera.position.x, this.camera.position.z, this.player.yaw, this.player.pitch, nearLit);
      // F95: hardcore battery encodes charge purely in flicker character —
      // each playing frame samples the seeded per-tick drive and feeds it to
      // the torch; off keeps identity so nothing changes visually.
      if (this.flickerBattery !== null && this.flickerBattery.hardcore) {
        const f = this.flickerBattery.frame(
          this.flashlight.battery,
          Math.floor(this.playtimeSec * 60),
        );
        this.flashlight.flickerCut = !f.on;
        this.flashlight.flickerDim = f.dim;
      } else {
        this.flashlight.flickerCut = false;
        this.flashlight.flickerDim = 1;
      }
      // F11: advance the view-model every playing frame (the battery-swap
      // beat must animate even while the torch is off), then remount the
      // SpotLight on its lens anchor so the beam originates at the visible
      // hand (only while lit — Flashlight parks the light at (0,-50,0)
      // when off and that parking must win).
      if (this.torchView) {
        try {
          this.torchView.update(dt);
          if (this.flashlight.on) {
            const a = this.torchView.getLightAnchor();
            const anchorWorld = Vector3.TransformCoordinates(
              new Vector3(a.x, a.y, a.z),
              this.camera.computeWorldMatrix(),
            );
            this.flashlight.light.position.copyFrom(anchorWorld);
          }
        } catch (e) {
          console.warn('[bmb] torch view update failed', e);
        }
      }
      // F42: advance the camcorder mode model, paint the IR grade from the
      // ramp envelope, and surface loud gain noise + auto-cutoffs (each
      // caption path throttled by its own per-run bookkeeping).
      if (this.nightvision) {
        try {
          this.nightvision.update(dt);
          this.updateNVTint(this.nightvision.envelope);
          if (
            this.playtimeSec - this.nvArtifactLastSec >= 10 &&
            this.nightvision.artifactLevel > this.NV_ARTIFACT_CAPTION_LEVEL
          ) {
            this.nvArtifactLastSec = this.playtimeSec;
            this.showAudioCaption('IR STATIC');
          }
          if (this.nightvision.cutoffCount > this.nvCutoffsSeen) {
            this.nvCutoffsSeen = this.nightvision.cutoffCount;
            this.ui.say('...the cell gave out. The green dies first...', 3.5);
          }
        } catch (e) {
          console.warn('[bmb] night vision update failed', e);
        }
      }
      // ---- Mount batch B: player-body signals (playing frames only) ----
      // F75 adrenaline: advance dump envelopes, run the armed near-miss
      // detector over watcher/double proximity (a figure closing inside 3 m
      // fires one severity-by-closeness dump; re-armed past 6 m), and keep
      // the hearing-gain snapshot for the audio layer.
      try {
        this.adrenaline.update(dt);
        let adWd = Infinity;
        for (const f of this.humans.figures) {
          if (f.type !== 'watcher' && f.type !== 'double') continue;
          const d = Math.hypot(f.body.x - this.player.body.x, f.body.z - this.player.body.z);
          if (d < adWd) adWd = d;
        }
        if (isFinite(adWd)) {
          if (this.nearMissArmed && adWd < 3) {
            this.nearMissArmed = false;
            this.nearMisses++;
            const severity = Math.max(0, Math.min(1, 1 - adWd / 3));
            this.adrenaline.pushNearMiss({ severity });
            // F90: the near-miss dump doubles as a pause confession; intensity
            // is closeness. Doubles share the 'watcher' tag — both figures
            // play the same dread role (documented tag simplification).
            this.learning?.record({ kind: 'pause', contextTag: 'watcher', intensity: severity });
          } else if (!this.nearMissArmed && adWd > 6) {
            this.nearMissArmed = true;
          }
        }
        this.adrenalineHearingGainMul = this.adrenaline.hearingGainMul;
      } catch (e) {
        console.warn('[bmb] adrenaline update failed', e);
      }
      // ---- F90 director learning: session clock + scare-response feed. The
      // near-miss dump above contributes pause/watcher and onBeamFreeze the
      // hesitation; the linger detector and the note-skip tracker below
      // complete the feed. Every ~2 min the top of suggestPhaseBias()
      // surfaces as a caption — that read is the documented pacing-bias seam
      // where deeper director surgery will consume these weights later.
      if (this.learning) {
        try {
          this.learning.advanceClock(dt);
          this.updateLearningLinger(dt);
          if (this.playtimeSec - this.learningBiasLastSec >= LEARNING_BIAS_CAPTION_SEC) {
            this.learningBiasLastSec = this.playtimeSec;
            const bias = this.learning.suggestPhaseBias();
            let top: string | null = null;
            for (const tag of Object.keys(bias).sort()) {
              if (top === null || bias[tag] > bias[top]) top = tag;
            }
            if (top) this.ui.say('...the house paces itself around your ' + top.toLowerCase() + '...', 5);
          }
        } catch (e) {
          console.warn('[bmb] director learning failed', e);
        }
      }
      // F73 hunger: absolute session clock in minutes. Drained pangs feed
      // the stomach growl synth; the HUNGER caption stays as the throttled
      // (>= 20 s) visible fallback for muted/unavailable audio.
      if (this.hunger) {
        try {
          this.hunger.update(this.playtimeSec / 60);
          const pangs = this.hunger.drainEvents();
          if (pangs.length > 0) {
            if (this.stomachAudio) {
              try { this.stomachAudio.consume(pangs); }
              catch (e) { console.warn('[bmb] stomach audio failed', e); }
            }
            if (this.playtimeSec - this.hungerCaptionLastSec >= 20) {
              this.hungerCaptionLastSec = this.playtimeSec;
              this.showAudioCaption('HUNGER');
            }
          }
        } catch (e) {
          console.warn('[bmb] hunger pangs failed', e);
        }
      }
      // F74 blinks: session hours drive the rate ramp; drain events so the
      // fired buffer cannot grow unbounded (no other consumer yet).
      if (this.blinks) {
        try {
          this.blinks.update(dt, this.playtimeSec / 3600);
          void this.blinks.drainEvents();
          this.updateBlinkVeil(this.blinks.eyelidClosure);
        } catch (e) {
          console.warn('[bmb] blink scheduler failed', e);
        }
      }
      // F72 tremor: battery-keyed aim wobble added AFTER the pose solve; the
      // controller rewrites rotation every frame so the delta never stacks.
      if (this.tremor) {
        try {
          const o = this.tremor.update(dt, Math.max(0, Math.min(1, this.flashlight.battery)));
          this.camera.rotation.y += o.yawRad;
          this.camera.rotation.x += o.pitchRad;
        } catch (e) {
          console.warn('[bmb] hand tremor failed', e);
        }
      }
      // path echoes: the space remembers where you walked last session
      if (this.pastSessionPath.length) {
        this.echoCheckTimer -= dt;
        if (this.echoCheckTimer <= 0) {
          this.echoCheckTimer = 2;
          const rk = Math.floor(this.player.body.x / 24) + ',' + Math.floor(this.player.body.z / 24);
          if (!this.echoedRegions.has(rk)) {
            const near = this.pastSessionPath.some((p) => Math.hypot(p.x - this.player.body.x, p.z - this.player.body.z) < 8);
            if (near) {
              this.echoedRegions.add(rk);
              this.ui.say('...your footsteps from before are still here...', 4.5);
              this.audio.whisper();
            }
          }
        }
      }
      // path echoes: the space remembers where you walked last session
      if (this.pastSessionPath.length) {
        this.echoCheckTimer -= dt;
        if (this.echoCheckTimer <= 0) {
          this.echoCheckTimer = 2;
          const rk = Math.floor(this.player.body.x / 24) + ',' + Math.floor(this.player.body.z / 24);
          if (!this.echoedRegions.has(rk)) {
            const near = this.pastSessionPath.some((p) => Math.hypot(p.x - this.player.body.x, p.z - this.player.body.z) < 8);
            if (near) {
              this.echoedRegions.add(rk);
              this.ui.say('...your footsteps from before are still here...', 4.5);
              this.audio.whisper();
            }
          }
        }
      }
      // F17: re-entering a recorded site queues its echo schedule; frame
      // processing plays at most two distant echoes per entry.
      if (this.echoGeo) {
        try {
          const sk = Math.floor(this.player.body.x / 12) + ',' + Math.floor(this.player.body.z / 12);
          if (sk !== this.echoSiteKey) {
            this.echoSiteKey = sk;
            this.echoPlaysThisEntry = 0;
            this.echoCueQueue.length = 0; // echoes belong to their entry only
            for (const cue of this.echoGeo.enterSite(sk)) {
              this.echoCueQueue.push({ dueSec: this.playtimeSec + cue.delaySec, text: cue.memoText });
            }
          }
          while (
            this.echoPlaysThisEntry < 2 &&
            this.echoCueQueue.length > 0 &&
            this.echoCueQueue[0].dueSec <= this.playtimeSec
          ) {
            const cue = this.echoCueQueue.shift()!;
            this.audio.whisper();
            this.ui.say(cue.text ?? '...your own footsteps come back wrong...', 4);
            this.echoPlaysThisEntry++;
          }
        } catch (e) {
          console.warn('[bmb] echo geography replay failed', e);
        }
      }
      // F18: the occupied 12 m site is the slippage zone; its memory
      // intensity is the saturation. A >60 s clock disagreement warns once
      // per zone visit.
      if (this.timeSlip) {
        try {
          const zk = Math.floor(this.player.body.x / 12) + ',' + Math.floor(this.player.body.z / 12);
          if (zk !== this.slipZoneKey) {
            this.slipZoneKey = zk;
            this.slipWarned = false;
          }
          const sat = Math.max(0, Math.min(1, this.mem.sampleAt(this.player.body.x, this.player.body.z).intensity));
          this.timeSlip.enterZone(zk, sat);
          this.timeSlip.reading('session', this.playtimeSec);
          if (!this.slipWarned && this.timeSlip.disagreementSec() >= 60) {
            this.slipWarned = true;
            this.ui.say('...the clocks down here disagree about you...', 4);
          }
        } catch (e) {
          console.warn('[bmb] time slippage failed', e);
        }
      }
      // F21: residue beats play from the frame queue ~900 ms after the touch
      while (this.residueBeatQueue.length > 0 && this.residueBeatQueue[0].dueSec <= this.playtimeSec) {
        const beat = this.residueBeatQueue.shift()!;
        try { this.ui.say(beat.text, 5); }
        catch (e) { console.warn('[bmb] residue beat failed', e); }
      }
      this.entityScheduler(dt);
      this.helperDialogue();
      // reality erosion / relocation
      const watcher = this.humans.nearestOf(this.player.body.x, this.player.body.z, ['watcher']);
      const verdict = this.erosion.update(dt, {
        phase: this.director.phase,
        blackout: this.playtimeSec < this.blackoutUntil,
        watcherDist: watcher ? Math.hypot(watcher.body.x - this.player.body.x, watcher.body.z - this.player.body.z) : null,
        sprinting: this.player.sprinting,
      });
      if (verdict && verdict.relocate) {
        try { this.echoSites?.markSite(this.player.body.x, this.player.body.z); }
        catch (e) { console.warn('[bmb] echo site mark failed', e); }
        // F6: relocation is the loudest wrongness — hold the mix before it lands
        if (this.dread?.canDuck(this.playtimeSec)) {
          try { this.dread.requestDuck(this.playtimeSec); }
          catch (e) { console.warn('[bmb] dread duck failed', e); }
        }
        // F3: relocation replays identical per seed (same timeline up to the verdict)
        const rng = new RNG(hash2i(Math.floor(this.playtimeSec), 1529, this.seed));
        const ang = rng.range(0, Math.PI * 2);
        const dist = 220 + rng.range(0, 200);
        const nx = this.player.body.x + Math.cos(ang) * dist;
        const nz = this.player.body.z + Math.sin(ang) * dist;
        this.player.teleport(nx, nz, rng.range(0, Math.PI * 2));
        // build the immediate area synchronously so we never wake up in void
        for (let i = 0; i < 4; i++) this.chunks.update(nx, nz);
        // where you wake becomes someone's remembered home
        this.mem.inject(nx, nz, MemoryKind.RESIDENCE, 0.4);
        this.ui.say('...the carpet here is warmer, as if you had just been lying on it...', 6);
        this.audio.whisper();
        this.blackoutUntil = this.playtimeSec;
      }
      this.ui.setErosion(this.erosion.overlay(performance.now()));
      this.handleInteraction(dt);
      this.beaconEnsureTimer -= dt;
      if (this.beaconEnsureTimer <= 0) {
        this.beaconEnsureTimer = 8;
        this.story.ensureBeaconsAround(
          Math.floor(this.player.body.x / 30), Math.floor(this.player.body.z / 30), 9,
        );
        // Wave B (B-3a): keep minimap beacon pings current
        if (this.minimap) {
          try {
            for (const b of this.story.beacons.values()) {
              if (b.found) continue;
              const bk = Math.round(b.x) + ':' + Math.round(b.z);
              if (this.markedBeaconKeys.has(bk)) continue;
              this.markedBeaconKeys.add(bk);
              this.minimap.markBeacon(b.x, b.z);
            }
          } catch (e) { console.warn('[bmb] minimap beacons failed', e); }
        }
      }
      // armed doorway loop: the next door you pass through repeats itself
      const cell = { x: Math.floor(this.player.body.x / CELL_SIZE), z: Math.floor(this.player.body.z / CELL_SIZE) };
      if (this.prevCell && (cell.x !== this.prevCell.x || cell.z !== this.prevCell.z)) {
        // spatial anomalies watch every crossing too (deja-vu, stretch feed)
        this.anomalies?.noteCellCrossing(this.prevCell.x, this.prevCell.z, cell.x, cell.z);
        const code = this.chunks.edgeCodeBetweenCell(this.prevCell.x, this.prevCell.z, cell.x, cell.z);
        if (code === 2) {
          this.audio.doorway();
          // Wave B (B-1a): sweep the creak through the doorway just crossed
          try {
            const mdx = cell.x - this.prevCell.x, mdz = cell.z - this.prevCell.z;
            const mlen = Math.hypot(mdx, mdz) || 1;
            const myaw = this.player.yaw;
            this.doorCreaks?.torchToward(Math.max(-1, Math.min(1, (mdx * Math.cos(myaw) - mdz * Math.sin(myaw)) / mlen)));
          } catch (e) { console.warn('[bmb] door creak aim failed', e); }
          // F50: every real door crossing is a fire-exit candidate event.
          // Gap note: handleInteraction() has no door branch in v1 (its
          // interactions are beacons/batteries/notes), so the doorway
          // crossing here is the door-interaction path the gate is fed from.
          this.feedExitVoid();
        }
        if (code === 2 && this.playtimeSec < this.loopArmedUntil) {
          this.loopArmedUntil = 0;
          // F3: loop-back offset is a seeded draw (replay-stable)
          const back = 26 + new RNG(hash2i(Math.floor(this.playtimeSec * 10), 1581, this.seed)).range(0, 14);
          const yaw = this.player.yaw;
          const nx = this.player.body.x + Math.sin(yaw) * back;
          const nz = this.player.body.z + Math.cos(yaw) * back;
          this.player.teleport(nx, nz, yaw);
          for (let i = 0; i < 4; i++) this.chunks.update(nx, nz);
          this.ui.say('You have passed through this door already.', 4.5);
          this.audio.whisper();
          this.mem.inject(nx, nz, MemoryKind.PERSONAL, 0.25);
        }
      }
      this.prevCell = cell;
    }

    if (this.state === 'playing') {
      this.chunks.update(this.player.body.x, this.player.body.z);
      this.story.update(this.player.body.x, this.player.body.z, now / 1000);
    } else if (this.state === 'paused') {
      this.chunks.update(this.player.body.x, this.player.body.z);
    }

    // ---- Wave B: announce freshly built chunks + per-chunk audio feeds ----
    {
      const bwx = this.state === 'menu' ? this.attract.x : this.player.body.x;
      const bwz = this.state === 'menu' ? this.attract.z : this.player.body.z;
      try { this.noteBuiltChunks(bwx, bwz); }
      catch (e) { console.warn('[bmb] chunk announce failed', e); }
      try { this.refreshChunkAudio(Math.floor(bwx / CHUNK_SIZE), Math.floor(bwz / CHUNK_SIZE)); }
      catch (e) { console.warn('[bmb] chunk audio feed failed', e); }
    }

    // fixture list with director overrides (no allocation in the common case)
    const blackout = this.playtimeSec < this.blackoutUntil;
    // panels go dark too - emissive swap on the shared fixture material
    if (blackout !== this.lastBlackoutVisual) {
      this.lastBlackoutVisual = blackout;
      this.mats.fixture.emissiveColor = blackout
        ? new Color3(0.012, 0.012, 0.01)
        : new Color3(1.0, 0.98, 0.86);
    }
    // F3: ghost-light fights are seeded per frame-tick (replay-stable)
    const ghostRng = new RNG(hash2i(Math.floor(this.playtimeSec * 60), 1621, this.seed));
    if (blackout && ghostRng.chance(dt * 0.12)) {
      // one distant light fights back
      const cands = this.chunks.allFixtures().filter((f) => {
        const d = Math.hypot(f.x - this.player.body.x, f.z - this.player.body.z);
        return f.alive && d > 22 && d < 60;
      });
      if (cands.length) {
        const pick = cands[ghostRng.int(0, cands.length)];
        const dur = 2 + ghostRng.range(0, 5);
        this.ghostLit.set(pick.x + ',' + pick.z, this.playtimeSec + dur);
        this.audio.lightCrack();
      }
    }
    if (!blackout) this.ghostLit.clear();
    let fixtures: ReadonlyArray<{ x: number; z: number; flicker: number; alive: boolean }> =
      this.chunks.allFixtures();
    if (blackout || this.forceDeadLights.size > 0 || this.ghostLit.size > 0) {
      fixtures = fixtures.map((f) => {
        const k = f.x + ',' + f.z;
        const ghost = this.ghostLit.get(k);
        return {
          ...f,
          alive: ghost !== undefined
            ? this.playtimeSec < ghost
            : f.alive && !this.forceDeadLights.has(k) && !blackout,
        };
      });
    }
    const focus = this.state === 'menu'
      ? { x: this.attract.x, z: this.attract.z, yaw: this.camera.rotation.y }
      : { x: this.player.body.x, z: this.player.body.z, yaw: this.player.yaw };
    this.lighting.update(focus.x, focus.z, now / 1000, fixtures, this.chunks.fixtureVersion);
    const fxr = blackout
      ? { d: Infinity as number, pan: 0 }
      : this.chunks.nearestFixture(focus.x, focus.z, focus.yaw);
    this.audio.update(dt, fxr.d === Infinity || fixtures.length === 0 ? 99 : fxr.d, fxr.pan);

    // Wave B (B-2a): post-processing pulse / instability aberration / blackout blur
    if (this.postfx) {
      try {
        this.postfx.setPulse(this.director.tension > 0.7);
        this.postfx.setAberration(1 - this.erosion.stability);
        this.postfx.setBlackout(blackout);
        this.postfx.update(dt);
      } catch (e) {
        console.warn('[bmb] postfx update failed', e);
      }
    }

    // ---- integrated audio/gameplay systems -------------------------------
    this.ensureAudioIntegrations();

    // PositionalHum: the nearest fixtures each become their own voice.
    if (this.humAudio) {
      try {
        const near = fixtures
          .filter((f) => f.alive)
          .map((f) => ({ f, d2: (f.x - focus.x) ** 2 + (f.z - focus.z) ** 2 }))
          .sort((a, b) => a.d2 - b.d2)
          .slice(0, 12)
          .map((e) => ({ x: e.f.x, z: e.f.z }));
        this.humAudio.setFixtures(near);
        this.humAudio.update(focus.x, focus.z, focus.yaw);
      } catch (e) {
        console.warn('[bmb] positional hum update failed', e);
      }
    }

    // Watcher proximity shared by watcher steps + heartbeat.
    let nearestWatcherDist: number | null = null;
    for (const fig of this.humans.figures) {
      if (fig.type !== 'watcher' && fig.type !== 'double') continue;
      const d = Math.hypot(fig.body.x - focus.x, fig.body.z - focus.z);
      if (nearestWatcherDist === null || d < nearestWatcherDist) nearestWatcherDist = d;
    }

    const zoneSample = this.mem.sampleAt(focus.x, focus.z);
    const zoneKind = zoneSample.kind as number;
    const tension = this.director.tension;

    // DynamicScore: zone-keyed drone bed + tension cluster.
    if (this.score) {
      try {
        this.score.setState(zoneKind, tension);
        this.score.update(dt);
      } catch (e) {
        console.warn('[bmb] dynamic score failed', e);
      }
    }

    // ExteriorBleed: rain tracks storm fronts overhead; tension thins birds.
    if (this.exterior) {
      try {
        const fr = this.weather.front;
        const overFront = Math.max(0, 1 - Math.hypot(focus.x - fr.cx, focus.z - fr.cz) / Math.max(1, fr.radiusM));
        this.exterior.update(dt, zoneKind, tension, fr.storm ? fr.strength * overFront : 0);
      } catch (e) {
        console.warn('[bmb] exterior bleed failed', e);
      }
    }

    // ---- Wave B (B-1): extended ambience pack -----------------------------
    const bDistrict = this.chunks.districtAtPos(focus.x, focus.z) ?? 0;
    if (this.doorCreaks) {
      try { this.doorCreaks.update(dt, tension); }
      catch (e) { console.warn('[bmb] door creaks update failed', e); }
    }
    if (this.groans) {
      try { this.groans.update(dt, tension); }
      catch (e) { console.warn('[bmb] structure groans update failed', e); }
    }
    if (this.vents) {
      try { this.vents.update(dt, bDistrict, focus.x, focus.z); }
      catch (e) { console.warn('[bmb] vent audio update failed', e); }
    }
    if (this.elevatorAmb) {
      try { this.elevatorAmb.update(dt, bDistrict); }
      catch (e) { console.warn('[bmb] elevator ambience update failed', e); }
    }
    if (this.crowd) {
      try { this.crowd.update(dt, bDistrict, tension); }
      catch (e) { console.warn('[bmb] crowd ambience update failed', e); }
    }
    if (this.echoSites) {
      try { this.echoSites.update(dt, focus.x, focus.z); }
      catch (e) { console.warn('[bmb] echo sites update failed', e); }
    }
    if (this.batteryCues) {
      try {
        const charging = !blackout && this.chunks.nearestFixtureDist(focus.x, focus.z) < 8;
        this.batteryCues.update(this.flashlight.battery, charging);
      } catch (e) { console.warn('[bmb] battery cues update failed', e); }
    }
    if (this.electricPops) {
      try { this.electricPops.update(dt); }
      catch (e) { console.warn('[bmb] electric pops update failed', e); }
    }
    if (this.fanAudio) {
      try { this.fanAudio.update(dt); }
      catch (e) { console.warn('[bmb] fan audio update failed', e); }
    }
    if (this.fanSpeedAudio) {
      try { this.fanSpeedAudio.update(dt); }
      catch (e) { console.warn('[bmb] fan speed audio update failed', e); }
    }
    if (this.cabinetCreaks) {
      try { this.cabinetCreaks.update(dt, focus.x, focus.z); }
      catch (e) { console.warn('[bmb] cabinet creaks update failed', e); }
    }
    // ---- F2: district identity beds follow district + listener pose ----
    if (this.areaBeds) {
      try {
        this.areaBeds.setListener(focus.x, focus.z);
        this.areaBeds.update(dt, bDistrict, tension);
      } catch (e) { console.warn('[bmb] area beds update failed', e); }
    }
    // ---- F2: player breath cycles with effort/tension/blackout providers ----
    if (this.breathHandle) {
      try { this.breathHandle.update(dt); }
      catch (e) { console.warn('[bmb] breath update failed', e); }
    }
    // ---- F5: whisper voices re-solve around the live pose ----
    if (this.whispers) {
      try { this.whispers.update(dt); }
      catch (e) { console.warn('[bmb] whisperfield update failed', e); }
    }
    // ---- F6: dread-silence scheduler runs on the session clock ----
    if (this.dread) {
      try { this.dread.tick(this.playtimeSec); }
      catch (e) { console.warn('[bmb] dread silence tick failed', e); }
    }
    // ---- F2: re-assert the clarity fog cap (LightingRig eases density back up) ----
    if (this.clarityHandle) {
      try { this.clarityHandle.update(bDistrict); }
      catch (e) { console.warn('[bmb] clarity update failed', e); }
    }
    // lore stings: cluster-complete sting when the story arc advances
    if (this.loreStings && this.story.stage !== this.prevArcStage) {
      try {
        if (this.story.stage > this.prevArcStage) this.loreStings.clusterComplete(this.story.stage);
        this.prevArcStage = this.story.stage;
      } catch (e) { console.warn('[bmb] lore sting cluster failed', e); }
    }

    // Heartbeat: a closing watcher (within 8 m) OR unstable reality.
    // Uses the humans manager proximity data when freshly published,
    // falling back to the live figures list.
    try {
      let hb = 0;
      const prox = this.humans.proximities;
      let wd = nearestWatcherDist;
      if (wd === null && prox.length > 0) {
        for (const e of prox) {
          if (e.type !== 'watcher' && e.type !== 'double') continue;
          wd = wd === null ? e.dist : Math.min(wd, e.dist);
        }
      }
      if (wd !== null && wd < 8) hb = Math.max(0, 1 - wd / 8);
      else if (this.erosion.stability < 0.3) hb = 0.5;
      this.audio.setHeartbeat(active ? hb : 0);
    } catch (e) {
      console.warn('[bmb] heartbeat failed', e);
    }

    // WatcherSteps: mirror-steps on whatever floor THEY stand on. Only the
    // playing state advances them (paused/menu keeps the trail parked).
    if (this.watcherSteps && active && this.surfaceDetector) {
      try {
        const district = this.chunks.districtAtPos(this.player.body.x, this.player.body.z) ?? 0;
        const surface = this.surfaceDetector.detect(this.player.body.x, this.player.body.z, district);
        this.watcherSteps.update(dt, nearestWatcherDist, this.player.speed > 0.05, surface);
      } catch (e) {
        console.warn('[bmb] watcher steps failed', e);
      }
    }

    // beacon transmitter pulse when close
    if (active && this.story.stage < 4) {
      let nb = Infinity, nx2 = 0, nz2 = 0;
      for (const b of this.story.beacons.values()) {
        if (b.found) continue;
        const d = Math.hypot(b.x - this.player.body.x, b.z - this.player.body.z);
        if (d < nb) { nb = d; nx2 = b.x; nz2 = b.z; }
      }
      if (isFinite(nb) && nb < 40 && nb > 2.6) {
        const dx = (nx2 - this.player.body.x) / (nb || 1);
        const dz = (nz2 - this.player.body.z) / (nb || 1);
        const pan = Math.max(-1, Math.min(1, dx * Math.cos(this.player.yaw) - dz * Math.sin(this.player.yaw)));
        this.audio.beaconUpdate(nb, pan);
      }
      // Wave B (B-3b): the screen-edge compass aims at that same nearest
      // unfound beacon — true bearing, the same truthful feed the minimap
      // and the beacon-audio pan get. Its contract (ui/compass.ts header,
      // integration-plan B-3b "same feed as B-3a") is to always point at
      // the nearest unfound research beacon; the F94 needle model does not
      // bend this marker.
      if (this.compass) {
        try {
          this.compass.update(this.player.body.x, this.player.body.z, this.player.yaw,
            this.camera, nx2, nz2, isFinite(nb));
        } catch (e) { console.warn('[bmb] compass update failed', e); }
      }
    } else if (this.compass) {
      try { this.compass.hide(); }
      catch (e) { console.warn('[bmb] compass hide failed', e); }
    }

    const fx2 = this.state === 'menu' ? this.attract.x : this.player.body.x;
    const fz2 = this.state === 'menu' ? this.attract.z : this.player.body.z;
    this.dust.update(dt, fx2, fz2);
    // camera shake: proximity + tension + peak = fear you can feel
    let shakeAmt = 0;
    if (active && this.director.tension > 0.3) {
      let wd = Infinity;
      for (const f of this.humans.figures) {
        const d2 = Math.hypot(f.body.x - this.player.body.x, f.body.z - this.player.body.z);
        if (d2 < wd) wd = d2;
      }
      if (isFinite(wd)) shakeAmt = this.director.tension * Math.max(0, 1 - wd / 8) * 0.025;
      if (blackout) shakeAmt *= 1.5;
    }
    // F75: adrenaline dumps add their own bounded hand shake on top
    shakeAmt += this.adrenaline.handShakeAmp;
    // F49: motion-safety zeroes this anomaly displacement force entirely.
    if (shakeAmt > 0.001 && this.state === 'playing' && !this.motionSafetyOn()) {
      // F3: camera shake jitter is a seeded draw per frame-tick (replay-stable)
      const shakeRng = new RNG(hash2i(Math.floor(this.playtimeSec * 60), 1868, this.seed));
      this.camera.position.x += (shakeRng.next() - 0.5) * shakeAmt;
      this.camera.position.y += (shakeRng.next() - 0.5) * shakeAmt;
      this.camera.rotation.z += (shakeRng.next() - 0.5) * shakeAmt * 0.5;
    }
    this.ui.setStamina(this.player.stamina);
    // F95: hardcore mode suppresses the numeric readout — charge reads only
    // through the beam's flicker character until the player opts out.
    const hardcoreHud = this.flickerBattery?.hudSuppressed === true;
    this.ui.setBattery(!hardcoreHud && this.flashlight.has ? this.flashlight.battery : null);
    this.ui.torchOn = this.flashlight.on;
    this.ui.tickSubtitles(dt);
    // F96: keep the open note's hand current as stage/saturation drift
    if (active && this.ui.noteIsOpen) {
      try {
        this.journalFontTimer -= dt;
        if (this.journalFontTimer <= 0) {
          this.journalFontTimer = JOURNAL_RESTYLE_SEC;
          this.applyJournalHand(this.journalEntryId);
        }
      } catch (e) { console.warn('[bmb] journal hand tick failed', e); }
    }
    // Wave B (B-3a): minimap redraw at the live focus pose
    if (this.minimap) {
      try {
        this.minimap.update(fx2, fz2, this.state === 'menu' ? this.camera.rotation.y : this.player.yaw);
      } catch (e) { console.warn('[bmb] minimap update failed', e); }
    }
    // Wave B (B-3c): incoming-front warnings, phase-suppressed during peaks
    if (this.weatherUi) {
      try {
        if (this.director.phase !== this.weatherPhase) {
          this.weatherPhase = this.director.phase;
          this.weatherUi.setPhase(this.weatherPhase);
        }
        // Wave B (B-3c): nextFront() already speaks WeatherUI's forecast shape
        this.weatherUi.update(this.weather.nextFront());
      } catch (e) { console.warn('[bmb] weather ui update failed', e); }
    }
    this.objectiveTimer -= dt;
    if (active && this.objectiveTimer <= 0 && this.story.stage < 4) {
      this.objectiveTimer = 1.0;
      this.ui.setObjective(this.story.objectiveText(this.player.body.x, this.player.body.z));
    }
    // Wave A (A-2b): throttled ambient difficulty hints from the walls.
    this.hintsTimer -= dt;
    if (active && this.hintsTimer <= 0 && this.hints) {
      this.hintsTimer = 1.0;
      try {
        this.hints.update(1.0, this.humans.getPlayerProfile().cautiousness);
      } catch (e) {
        console.warn('[bmb] difficulty hints failed', e);
      }
    }

    this.ui.updateDebug(dt * 1000, {
      pos: this.player.body.x.toFixed(1) + ', ' + this.player.body.z.toFixed(1),
      chunks: this.chunks.loadedCount,
      built: this.chunks.totalBuilt,
      buildMs: this.chunks.lastBuildMs.toFixed(1),
      act: this.scene.getActiveMeshes().length,
      phase: this.director.describe(),
      humans: this.humans.count,
      mem: JSON.stringify(this.mem.stats()),
      story: 'st' + this.story.stage + '/' + this.story.discoveries,
      state: this.state,
      seed: (this.seed >>> 0).toString(16),
    });

    // expedition log refresh (throttled)
    this.logTimer -= dt;
    if (this.logOpen && this.logTimer <= 0) {
      const s = this.mem.sampleAt(this.player.body.x, this.player.body.z);
      const memName = MEMORY_NAMES[s.kind];
      this.ui.setLog(true, [
        'SECTOR    ' + sectorName(this.seed, this.player.body.x, this.player.body.z),
        'ELAPSED   ' + Math.floor(this.playtimeSec / 60) + 'm ' + Math.floor(this.playtimeSec % 60) + 's',
        'SEED      ' + (this.seed >>> 0).toString(16).toUpperCase(),
        'DISCOVERIES ' + this.story.discoveries + ' · STAGE ' + this.story.stage,
        'NOTES READ ' + this.notesRead,
        'ROOMS      ' + this.seenLandmarks.size,
        'STABILITY ' + Math.round(this.erosion.stability * 100) + '%',
        'RELOCATIONS ' + this.erosion.relocations,
        'AIR       ' + (memName ? 'touched by ' + memName : 'neutral') + ' (' + Math.round(s.intensity * 100) + '%)',
        'PRESENCE  ' + this.humans.count + ' figure(s) registered nearby',
        '',
        '[TAB] to close',
      ]);
    } else if (!this.logOpen && this.ui.logOpen) {
      this.ui.setLog(false);
    }

    if (active && this.playtimeSec - this.lastAutosave > 30) {
      this.lastAutosave = this.playtimeSec;
      void this.saveNow();
    }

    // F91 v1.1: the staged wake sequence gets the last word on the camera
    // until it hands control to the rise; the state gate freezes it in pause.
    if (this.wakePlaying()) {
      try {
        this.wakeMount?.tick(dt * 1000);
      } catch (e) {
        console.warn('[bmb] wake cinematic failed', e);
        this.wakeMount?.abort();
        this.wakeMount = null;
        if (this.state === 'playing') this.player.beginWake();
      }
    }

    this.scene.render();
    // Wave C (C-4): throttled achievement evaluation from live gameplay state
    this.trackerTimer -= dt;
    if (active && this.trackerTimer <= 0 && this.trackerFeed) {
      this.trackerTimer = 1.0;
      try {
        const tf: TrackerState = {
          discoveries: this.story.discoveries,
          notesRead: this.notesRead,
          landmarksSeen: [...this.seenLandmarks],
          playtimeSec: this.playtimeSec,
          completed: this.story.stage >= 4,
        };
        this.trackerFeed.feed(tf);
      } catch (e) {
        console.warn('[bmb] tracker update failed', e);
      }
    }
    // ---- F47/F93/F97 meta pumps ----
    this.wallMenuTimer -= dt;
    if ((this.state === 'menu' || this.state === 'paused') && this.wallMenuTimer <= 0) {
      this.wallMenuTimer = 2;
      try { this.remountDiegeticMenus(); }
      catch (e) { console.warn('[bmb] wall menu failed', e); }
    }
    this.dailyTickTimer -= dt;
    if (this.dailyTickTimer <= 0) {
      this.dailyTickTimer = 10;
      try { this.dailyRiteTick(); }
      catch (e) { console.warn('[bmb] daily rite failed', e); }
    }
    try { this.forms?.update(dt * 1000); } catch { /* forms never block the frame */ }
    // Wave C (C-8): extended-debrief telemetry accumulation
    if (active) {
      if (this.flashlight.on) this.torchLitSec += dt;
      if (this.director.phase !== this.lastPhaseKey) {
        this.lastPhaseKey = this.director.phase;
        this.phaseSessions++;
        // F6: a peak is a major-anomaly window — duck the mix first (rationed)
        if (this.director.phase === 'peak' && this.dread?.canDuck(this.playtimeSec)) {
          try { this.dread.requestDuck(this.playtimeSec); }
          catch (e) { console.warn('[bmb] dread duck failed', e); }
        }
      }
      const dkey = String(this.chunks.districtAtPos(this.player.body.x, this.player.body.z) ?? 0);
      if (dkey !== this.prevDistrictKey) {
        this.prevDistrictKey = dkey;
        this.districtVisitCounts.set(dkey, (this.districtVisitCounts.get(dkey) ?? 0) + 1);
      }
    }
  }


  private openNote: string | null = null;
  private notesRead = 0;

  /**
   * F21: a read note becomes a residue object tagged with a prior tenant;
   * its deterministic first beat queues for playback ~900 ms out. Rate
   * limited to one replay per 90 s of session time.
   */
  private touchResidue(note: { x: number; z: number }): void {
    if (!this.residue) return;
    try {
      if (this.playtimeSec - this.residueLastPlaySec < 90) return;
      const noteKey = 'note:' + Math.round(note.x * 10) + ':' + Math.round(note.z * 10);
      const kinds = Object.keys(RESIDUE_KINDS) as ResidueKind[];
      const kind = kinds[hash2i(Math.round(note.x * 10), Math.round(note.z * 10), this.seed) % kinds.length];
      this.residue.add({
        id: noteKey,
        x: note.x,
        z: note.z,
        kind,
        tenantSeed: hash2i(this.seed, hash2i(Math.round(note.x * 10), Math.round(note.z * 10), 0x7211)),
      });
      const script = this.residue.interact(noteKey);
      if (!script || script.length === 0) return;
      this.residueLastPlaySec = this.playtimeSec;
      this.residueBeatQueue.push({ dueSec: this.playtimeSec + 0.9, text: script[0].text });
    } catch (e) {
      console.warn('[bmb] residue touch failed', e);
    }
  }

  private nearestBattery(): { x: number; z: number } | null {
    const p = this.chunks.nearestBattery(this.player.body.x, this.player.body.z);
    return p ? { x: p.x, z: p.z } : null;
  }

  private handleInteraction(dt: number): void {
    const pressed = this.interactQueued;
    this.interactQueued = false;
    // reading a note swallows input until it is put down
    if (this.openNote) {
      this.ui.setPrompt(null);
      if (this.interactQueued) {
        this.openNote = null;
        this.interactQueued = false;
        this.ui.hideNote();
      }
      return;
    }

    const note = this.chunks.nearestNote(this.player.body.x, this.player.body.z);
    const battery = this.nearestBattery();
    let prompt: string | null = null;
    let beaconTouch = false;
    for (const b of this.story.beacons.values()) {
      if (!b.found && Math.hypot(b.x - this.player.body.x, b.z - this.player.body.z) < 2.6) {
        prompt = b.threshold ? '[E] REACH THE THRESHOLD' : '[E] ACCESS RESEARCH BEACON';
        beaconTouch = true;
        break;
      }
    }
    if (!prompt && battery) prompt = '[E] TAKE BATTERY (+35% TORCH)';
    if (!prompt && note) prompt = '[E] READ NOTE';
    this.ui.setPrompt(prompt);

    // act only on queued presses while a prompt is showing
    if (!pressed || !prompt) return;

    const lore = this.story.interact(this.player.body.x, this.player.body.z);
    if (lore) {
      this.ui.flashBeacon();
      // first camp yields the torch: darkness becomes negotiable
      if (!this.flashlight.has) {
        this.flashlight.has = true;
        this.flashlight.battery = 1;
        setTimeout(() => {
          if (!this.flashHintShown) {
            this.flashHintShown = true;
            this.ui.say('You take the torch from the camp kit. [F]', 5);
          }
        }, 2500);
      }
      this.ui.toast(lore, 9000);
      this.director.notifyDiscovery();
      this.erosion.stability = Math.min(1, this.erosion.stability + 0.25);
      this.mem.inject(this.player.body.x, this.player.body.z, MemoryKind.PERSONAL, 0.45);
      if (lore.includes('THRESHOLD')) this.triggerEnding();
    }
    // F17/F21: any note read is a voice-memo moment for the halls' echo
    // memory and a potential prior-tenant residue touch.
    else if (prompt === '[E] READ NOTE' && note) {
      try {
        this.echoGeo?.recordMemoMoment(
          Math.floor(note.x / 12) + ',' + Math.floor(note.z / 12),
          this.playtimeSec,
          note.text,
        );
      } catch (e) {
        console.warn('[bmb] echo geography memo feed failed', e);
      }
      this.touchResidue(note);
      // F96: this page's hand wobbles by its own seeded entry draw
      this.journalEntryId = 'note:' + Math.round(note.x * 10) + ':' + Math.round(note.z * 10);
      this.applyJournalHand(this.journalEntryId);
    }
    // Wave A (A-2a): NoteReread ledger + bleed distortion on re-reads.
    else if (prompt === '[E] READ NOTE' && note && this.reread) {
      try {
        const noteId = 'note:' + Math.round(note.x * 10) + ':' + Math.round(note.z * 10);
        const firstRead = !this.reread.isRead(noteId);
        this.reread.markRead(noteId);
        if (firstRead) this.runNoteIds.add(noteId); // F46 ledger feed
        if (!firstRead) {
          const res = this.reread.distort(note.text, noteId);
          if (res.altered) this.ui.showNote(res.text);
        }
      } catch (e) {
        console.warn('[bmb] note reread failed', e);
      }
    }
    // Wave B (B-1i): stage-gated reading sting on any note read
    else if (prompt === '[E] READ NOTE' && note) {
      try { this.loreStings?.noteRead(this.story.stage); }
      catch (e) { console.warn('[bmb] lore sting note read failed', e); }
    }
  }

  /** Wave A (A-3a): assemble expedition telemetry for the debrief screen. */
  private buildExpeditionStats(): ExpeditionStats {
    let deepestM = Math.hypot(this.player.body.x - SPAWN_X, this.player.body.z - SPAWN_Z);
    let distanceM = 0;
    const chunkSet = new Set<string>();
    const track = (x: number, z: number): void => {
      deepestM = Math.max(deepestM, Math.hypot(x - SPAWN_X, z - SPAWN_Z));
      chunkSet.add(Math.floor(x / CHUNK_SIZE) + ':' + Math.floor(z / CHUNK_SIZE));
    };
    for (let i = 0; i < this.pathHistory.length; i++) {
      const p = this.pathHistory[i];
      track(p.x, p.z);
      if (i > 0) {
        const q = this.pathHistory[i - 1];
        distanceM += Math.hypot(p.x - q.x, p.z - q.z);
      }
    }
    track(this.player.body.x, this.player.body.z);
    return {
      seed: this.seed,
      durationSec: this.playtimeSec,
      distanceM: Math.round(distanceM),
      uniqueChunks: chunkSet.size,
      landmarkNames: [...this.seenLandmarks],
      notesRead: this.notesRead,
      batteries: this.consumedBatteries.size,
      relocations: this.erosion.relocations,
      phaseTimePct: { calm: 0, build: 0, peak: 0, release: 0 },
      deepestM: Math.round(deepestM),
      discoveries: this.story.discoveries,
    };
  }

  // ---------- Social entities (F26/F32/F61) ----------

  /**
   * Per-frame social-entity tick, called from the playing-frame path right
   * after the human-manager update. Mounts lazily: the Archivist circuit
   * and the chapel choir appear as their landmark chunks stream in; the
   * Custodian runs its overnight pass only inside the day cycle's night
   * stretch.
   */
  private updateSocialEntities(dt: number, colliders: readonly import('../world/architect').Box2[]): void {
    const layouts = this.chunks.loadedLayouts();

    // ---- F26 The Archivist ----
    if (!this.archivist && layouts.some((l) => l.landmark)) this.mountArchivist(layouts);
    if (this.archivist) {
      this.archivist.update(dt, this.player.body.x, this.player.body.z, colliders);
      const f = this.archivistFigure;
      if (f) {
        f.root.position.set(this.archivist.body.x, 0, this.archivist.body.z);
        f.root.rotation.y = this.archivist.facingYaw;
      }
    }

    // ---- F32 The Custodian ----
    if (!this.custodianWiring) this.custodianWiring = new CustodianWiring({ seed: this.seed });
    const wiring = this.custodianWiring;
    const hits: GraffitiHit[] = [];
    for (const l of layouts) {
      // layouts are already filtered by removedGraffiti, so erased scrawls
      // never re-register
      for (const g of l.graffiti) hits.push({ cx: l.cx, cz: l.cz, x: g.x, z: g.z });
    }
    if (hits.length > 0) wiring.registerGraffiti(hits);
    const night = this.daycycle?.currentPhase() === 'night';
    if (night && !this.custodianNightActive) {
      this.custodianNightActive = true;
      wiring.beginNight(wiring.nightCount + 1);
    } else if (!night && this.custodianNightActive) {
      this.custodianNightActive = false;
    }
    wiring.update(night ? dt : 0);
    for (const s of wiring.drainSqueaks()) {
      const at = parseGraffitiMarkingId(s.markingId);
      if (at) this.cartSqueaks?.cue(s.markingId, at);
      this.showAudioCaption('CART'); // F32: squeak precedes every removal
    }
    for (const r of wiring.drainRemovals()) {
      this.custodianRemovedKeys.add(r.markingId);
      this.cartSqueaks?.stop(r.markingId);
      const at = parseGraffitiMarkingId(r.markingId);
      if (at) {
        try { this.chunks.rebuildChunk(at.cx, at.cz); }
        catch (e) { console.warn('[bmb] custodian rebuild failed', e); }
        this.ui.toast('Somewhere, a wall has been scrubbed clean.', 5000);
      }
    }
    this.cartSqueaks?.update(dt, this.player.body.x, this.player.body.z);

    // ---- F61 The Congregation's Hymn ----
    // Rebuild over fresh discoveries whenever the visit ledger moves, so a
    // beacon contacted mid-session joins the lyric pool by nightfall.
    const chapelLayout = layouts.find((l) => l.landmark === 'CHAPEL');
    if (chapelLayout && (!this.chapelChoir || this.choirBuiltRev !== this.gossipLedgerRev)) {
      this.mountChoir(chapelLayout);
    }
    if (this.chapelChoir) {
      this.chapelChoir.update(dt);
      const active = this.chapelChoir.active;
      for (const f of this.choirFigures) f.root.setEnabled(active);
      const dx = this.chapelChoir.chapel.x - this.player.body.x;
      const dz = this.chapelChoir.chapel.z - this.player.body.z;
      const earshot = Math.hypot(dx, dz) <= SOCIAL_CHOIR_EARSHOT_M;
      for (const line of this.chapelChoir.drainLines()) {
        if (earshot) this.ui.say('\u201c' + line.text + '\u201d', 4);
      }
    }
  }

  /**
   * F26 mount: build one session's Archivist over a landmark circuit and an
   * injected store that mirrors archivistPhotos into the save slot meta.
   * Prior run tallies come from the same map, so a reloaded save returns
   * with the mood its photographs earned.
   */
  private mountArchivist(layouts: ReturnType<ChunkManager['loadedLayouts']>): void {
    const anchors = layouts
      .filter((l) => l.landmark)
      .slice(0, 5)
      .map((l) => ({ x: l.cx * CHUNK_SIZE + CHUNK_SIZE / 2, z: l.cz * CHUNK_SIZE + CHUNK_SIZE / 2 }));
    this.archivistRunId = 'r' + (this.seed >>> 0).toString(16) + '-' + Date.now().toString(36);
    const storeKey = (key: string): string => key.slice(ARCHIVIST_STORE_PREFIX.length);
    const store = {
      get: (key: string): unknown => {
        const v = this.archivistPhotos.get(storeKey(key));
        return v === undefined ? undefined : { version: 1, photos: v };
      },
      set: (key: string, value: unknown): void => {
        const photos = (value as { photos?: unknown } | null)?.photos;
        if (typeof photos === 'number') {
          this.archivistPhotos.set(storeKey(key), Math.max(0, Math.floor(photos)));
        }
      },
    };
    this.archivist = new Archivist({
      landmarks: anchors.length > 0 ? anchors : [{ x: this.player.body.x + 6, z: this.player.body.z + 6 }],
      store,
      runId: this.archivistRunId,
      priorRunIds: [...this.archivistPhotos.keys()],
      seed: (this.seed ^ 0x417c1b15) >>> 0,
    });
    try {
      // visual-only wanderer body carrying the clipboard prop; driven by the
      // sim each frame, never handed to HumanManager
      const fig = new HumanFigure('wanderer', this.scene, this.archivist.body.x, this.archivist.body.z, (this.seed ^ 0x6117c1) >>> 0);
      attachClipboardProp(fig, this.scene);
      this.archivistFigure = fig;
    } catch (e) {
      console.warn('[bmb] archivist figure unavailable', e);
      this.archivistFigure = null;
    }
  }

  /**
   * F61 mount: build the chapel choir over a discovery ledger grounded in
   * what the player actually found this run — landmark rooms entered and
   * beacons contacted (the same real-discovery discipline as the gossip
   * and radio feeds). Singer visuals park on the formation seats.
   */
  private mountChoir(chapel: { cx: number; cz: number }): void {
    const anchor: ChapelAnchor = {
      name: 'CHAPEL',
      x: chapel.cx * CHUNK_SIZE + CHUNK_SIZE / 2,
      z: chapel.cz * CHUNK_SIZE + CHUNK_SIZE / 2,
    };
    const discoveries: DiscoveryEntry[] = [];
    for (const name of this.seenLandmarks) discoveries.push({ id: 'landmark:' + name, name });
    for (const [key, b] of this.story.beacons) {
      if (b.found) discoveries.push({ id: 'beacon:' + key, name: 'the beacon at ' + b.cx + ',' + b.cz });
    }
    this.chapelChoir = new ChapelChoir(
      anchor,
      discoveries,
      (this.seed ^ 0x68796d) >>> 0,
      () => (this.daycycle ? this.daycycle.dayProgress() : 0),
    );
    this.choirBuiltRev = this.gossipLedgerRev;
    for (const f of this.choirFigures) f.dispose();
    this.choirFigures.length = 0;
    try {
      for (let i = 0; i < HYMN_CHOIR_COUNT; i++) {
        const seat = this.chapelChoir.seats[i];
        const f = new HumanFigure('believer', this.scene, seat.x, seat.z, hash2i(i, 77, (this.seed ^ 0xbe1101)) >>> 0);
        f.root.position.set(seat.x, 0, seat.z);
        f.root.rotation.y = seat.yaw; // face the altar
        f.root.setEnabled(false); // the service has not started yet
        this.choirFigures.push(f);
      }
    } catch (e) {
      console.warn('[bmb] choir figures unavailable', e);
    }
  }

  /** Dispose the per-run social-entity visuals (data models survive). */
  private disposeSocialFigures(): void {
    if (this.archivistFigure) {
      this.archivistFigure.dispose();
      this.archivistFigure = null;
    }
    for (const f of this.choirFigures) f.dispose();
    this.choirFigures.length = 0;
  }
  // ---------- F34: self-tuning radio ----------

  /**
   * F34 discovery feed: one entry per landmark room entered this run
   * (kind 'landmark') and one per beacon contacted (kind 'note'), both
   * keyed by stable ids so the grounding model sees real discoveries.
   */
  private radioFeed(): readonly FeedEntry[] {
    const entries: FeedEntry[] = [];
    for (const name of this.seenLandmarks) {
      entries.push({ id: 'landmark:' + name, kind: 'landmark', textSeed: name });
    }
    for (const [key, b] of this.story.beacons) {
      if (!b.found) continue;
      entries.push({ id: 'beacon:' + key, kind: 'note', textSeed: 'beacon ' + b.cx + ',' + b.cz });
    }
    return entries;
  }

  /** F34 loadout descriptors: the equipment actually carried this run. */
  private radioLoadout(): readonly string[] {
    const out: string[] = [];
    if (this.flashlight.has) out.push('flashlight');
    if (this.photoMode) out.push('camcorder');
    if (this.nightvision) out.push('camcorder-ir');
    return out;
  }

  // ---------- F35: camcorder voice memos ----------

  /**
   * F35: record one memo model entry for a PhotoMode capture. Zone-gen
   * mapping: memory-contamination intensity at the frame position, scaled
   * onto the modelled [0, ZONE_GEN_MAX] band — the more reconstructed the
   * zone a frame was shot in, the more degraded any future playback of it
   * will be. The spoken payload stands in as the sector designation.
   *
   * Gap notes: (1) playback is deferred — degradationFor() rendering needs
   * a Web Audio presentation layer that does not exist yet; (2) captured
   * entries have no SaveSlot home — VoiceMemoStore.serialize() output will
   * ride the slot once a field lands there.
   */
  private recordPhotoMemo(): void {
    if (!this.memoStore || !this.photoMode?.isOpen) return;
    const id = 'memo-' + (this.seed >>> 0).toString(16) + '-' + this.memoSeq++;
    try {
      const sat = this.mem.sampleAt(this.camera.position.x, this.camera.position.z);
      const zoneGen = Math.round(Math.max(0, Math.min(1, sat.intensity)) * ZONE_GEN_MAX);
      this.memoStore.record(
        id,
        'FRAME ' + sectorName(this.seed, this.camera.position.x, this.camera.position.z),
        zoneGen,
        3,
      );
    } catch (e) { console.warn('[bmb] voice memo capture failed', e); }
    // F26: photographing the Archivist records an encounter under this run
    // id; the tally lands in the save slot and shapes the NEXT session's
    // mood per the reaction table in entities/archivist.ts.
    if (this.archivist) {
      const d = Math.hypot(
        this.archivist.body.x - this.camera.position.x,
        this.archivist.body.z - this.camera.position.z,
      );
      if (d <= SOCIAL_PHOTO_RANGE_M) {
        const total = this.archivist.photograph();
        this.archivistPhotos.set(this.archivistRunId, total);
        this.ui.say('the lens finds the Archivist. it does not look up. (' +
          reactionForPhotos(total) + ' · photo ' + total + ')', 4);
      }
    }
  }

  // ---------- F31: roach ecosystems ----------

  /**
   * F31 grid adaptation — chunk layout data mapped onto the RoachGrid the
   * ecosystem consumes. The mapping (single-floor v1, y is unused):
   *  - moistureAt: every puddle instance (the architect's damp floors in
   *    transit/hospital corridors and around the laundry washers) radiates
   *    moisture with linear falloff across three puddle radii, scaled to a
   *    0.9 peak; standing inside a LAUNDRY landmark chunk adds a flat 0.65.
   *    Unloaded chunks and dry rooms read 0.
   *  - foodAt: vending machines, coolers and crates read as food stores —
   *    full strength at the prop and gone by ROACH_FOOD_RADIUS_M. All
   *    other props read 0.
   * Both are pure reads of deterministic per-(seed, chunk) layout data,
   * so identical runs see identical grids.
   */
  private roachMoistureAt(x: number, _y: number, z: number): number {
    let m = 0;
    for (const l of this.chunks.loadedLayouts()) {
      if (l.landmark === 'LAUNDRY') {
        const cxw = l.cx * CHUNK_SIZE + CHUNK_SIZE / 2;
        const czw = l.cz * CHUNK_SIZE + CHUNK_SIZE / 2;
        if (Math.abs(x - cxw) < CHUNK_SIZE && Math.abs(z - czw) < CHUNK_SIZE) m = Math.max(m, 0.65);
      }
      for (const p of l.puddles) {
        const d = Math.hypot(p.x - x, p.z - z);
        m = Math.max(m, Math.max(0, 1 - d / (p.r * 3)) * 0.9);
      }
    }
    return m;
  }

  /** F31 food mapping: see roachMoistureAt for the documented adaptation. */
  private roachFoodAt(x: number, _y: number, z: number): number {
    let f = 0;
    for (const l of this.chunks.loadedLayouts()) {
      for (const p of l.props) {
        if (p.kind !== 'vending' && p.kind !== 'cooler' && p.kind !== 'crate') continue;
        const d = Math.hypot(p.x - x, p.z - z);
        f = Math.max(f, Math.max(0, 1 - d / ROACH_FOOD_RADIUS_M));
      }
    }
    return f;
  }

  /**
   * F31: hatch this run's ecosystem once chunk data exists. Candidates are
   * sampled straight from the mapped grid's moisture sources (four ring
   * points per puddle), so spawnIn sees exactly the cells the world can
   * actually wet; cabinets come from loaded layout props within reach.
   */
  private spawnRoachEcosystem(): void {
    try {
      const layouts = this.chunks.loadedLayouts();
      if (layouts.length === 0) return; // world not streamed yet — retry later
      const candidates: SpawnCandidate[] = [];
      for (const l of layouts) {
        for (const p of l.puddles) {
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * Math.PI * 2;
            candidates.push({ x: p.x + Math.cos(ang) * p.r, y: 0, z: p.z + Math.sin(ang) * p.r });
          }
        }
      }
      if (candidates.length === 0) return; // no moisture in view yet — retry
      const cabinets: CabinetSite[] = [];
      for (const l of layouts) {
        for (const p of l.props) {
          if (p.kind !== 'cabinet') continue;
          cabinets.push({ id: 'cab:' + l.cx + ':' + l.cz + ':' + cabinets.length, x: p.x, y: 0, z: p.z });
          if (cabinets.length >= ROACH_CABINET_CAP) break;
        }
        if (cabinets.length >= ROACH_CABINET_CAP) break;
      }
      const grid: RoachGrid = {
        moistureAt: (x, y, z) => this.roachMoistureAt(x, y, z),
        foodAt: (x, y, z) => this.roachFoodAt(x, y, z),
      };
      this.roachEco = RoachEcosystem.spawnIn({ grid, cabinets, seed: this.seed }, candidates);
    } catch (e) {
      console.warn('[bmb] roach ecosystem unavailable', e);
      this.roachEco = null;
    }
  }

  /**
   * F90 linger feed: dwell ≥5 s inside one named landmark records a 'linger'
   * scare-response so the director learns which rooms hold the player.
   */
  private updateLearningLinger(dt: number): void {
    if (!this.playerLandmark) {
      this.learningLingerSec = 0;
      this.learningLingerFired = false;
      return;
    }
    if (this.learningLingerFired) return; // one confession per occupancy
    this.learningLingerSec += dt;
    if (this.learningLingerSec >= 5) {
      this.learningLingerSec = 0;
      this.learningLingerFired = true;
      try { this.learning?.record({ kind: 'linger', contextTag: 'landmark', intensity: 0.5 }); }
      catch (e) { console.warn('[bmb] learning linger failed', e); }
    }
  }

  // ---------- F44 + F46: expedition meta archive ----------

  /**
   * Run-end hook: persist this expedition's cross-run meta. Called once
   * from each ending path (threshold and fire exit) before the final save.
   *
   * F44 scarring: computeScars over this session's route history (path
   * samples are seconds — RouteSample.t wants ms), aged {sessions: 1,
   * playtimeSec}; the serialized archive lands under a per-save localStorage
   * key so a future mesher/render pass can regenerate the phantom cracks
   * without re-running the model.
   * F46 ledger: first-read note ids merge in as 'note' entries and entered
   * landmarks as 'cluster' entries under a fresh expedition id (seed hex +
   * end-time playtime keeps expeditions distinct even across same-seed
   * replays); idempotent per entryId, so crash-double-calls are no-ops.
   *
   * Gap notes: SaveDB exposes no generic kv surface (its kv store backs
   * only settings accessors), so both archives ride localStorage — the
   * ledger module's documented injected-storage contract; migrate into
   * SaveDB kv when a public get/set API lands there.
   */
  private recordExpeditionMeta(): void {
    if (typeof localStorage === 'undefined') return; // non-DOM harness runs
    // F44: per-save archive key (localStorage until SaveDB grows a kv API)
    const SCAR_ARCHIVE_KEY_PREFIX = 'bmb.scar-archive.';
    try {
      const route: RouteSample[] = this.pathHistory.map((p) => ({ x: p.x, z: p.z, t: p.t * 1000 }));
      const scars = computeScars(String(this.seed), route, {
        sessions: 1,
        playtimeSec: this.playtimeSec,
      });
      localStorage.setItem(
        SCAR_ARCHIVE_KEY_PREFIX + (this.seed >>> 0).toString(16),
        serializeScars(scars),
      );
    } catch (e) {
      console.warn('[bmb] scar archive failed', e);
    }
    try {
      const storage: LedgerStorageLike = {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => {
          localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        },
      };
      const loaded = loadLedger(storage);
      const entries: LedgerEntry[] = [];
      for (const id of this.runNoteIds) {
        entries.push({ entryId: id, kind: 'note', refId: id, rarity: 0, discoveredAt: Date.now() });
      }
      for (const name of this.seenLandmarks) {
        entries.push({
          entryId: 'cluster:' + name,
          kind: 'cluster',
          refId: name,
          rarity: 0,
          discoveredAt: Date.now(),
        });
      }
      const expeditionId =
        'exp-' + (this.seed >>> 0).toString(16) + '-' + Math.round(this.playtimeSec);
      saveLedger(storage, mergeExpedition(loaded.ok ? loaded.ledger : createLedger(), expeditionId, entries));
    } catch (e) {
      console.warn('[bmb] expedition ledger merge failed', e);
    }
  }

  /**
   * F50: report one door crossing to the per-run fire-exit gate. The
   * tracker rolls at most once per EXITVOID_CHECK_INTERVAL_SEC slot and
   * latches after a manifest, so click rate cannot influence the outcome
   * and the exit can never appear twice in one run.
   */
  private feedExitVoid(): void {
    if (!this.exitVoid || this.exitVoidTaken) return;
    if (!this.exitVoid.onDoorCandidate(this.playtimeSec)) return;
    this.exitVoidTaken = true;
    this.triggerExitVoid();
  }

  /**
   * F50: take the fire exit. Whiteout through the #bmb-void full-white
   * veil (postfx blackout-veil pattern), teleport far out via the epilogue
   * descriptor's arrival hook, then surface the ending overlay whose
   * RETURN TO TITLE button is the wake-to-title leave path (the descriptor's
   * only documented exit; there is no in-world way back).
   */
  private triggerExitVoid(): void {
    const room = buildEpilogueRoom(this.seed);
    this.ui.say('...a fire exit. It was always there...', 6);
    this.input.releaseLock();
    if (typeof document !== 'undefined') {
      if (!this.voidEl) {
        const el = document.createElement('div');
        el.id = 'bmb-void';
        el.style.cssText =
          'position:fixed;inset:0;pointer-events:none;z-index:40;' +
          'background:#ffffff;opacity:0;transition:opacity 2.5s ease-in';
        document.body.appendChild(el);
        this.voidEl = el;
      }
      requestAnimationFrame(() => { this.voidEl?.style.setProperty('opacity', '1'); });
    }
    // Walk through: the descriptor's centerWorld sits near the origin by
    // design, so the mount displaces the arrival by a fixed far offset —
    // still seeded through room.centerWorld, still chunk-streamed so the
    // player never lands in void geometry.
    setTimeout(() => {
      enterEpilogue(room, (x, z) => {
        const fx = x + 4096;
        const fz = z - 4096;
        for (let i = 0; i < 4; i++) this.chunks.update(fx, fz);
        this.player.teleport(fx, fz, this.player.yaw);
      });
      void this.saveNow();
    }, 2600);
    // Wake input = clicking RETURN TO TITLE on the existing ending overlay.
    setTimeout(() => {
      this.setState('menu');
      this.story.clearMeshes();
      this.humans.reset();
      this.disposeSocialFigures();
      this.ui.showEnding([
        'The push-bar clicks. The door was never on any floor plan.',
        'You step into white. Not light — just white, patient and total.',
        'Behind you, the corridors keep humming for someone else.',
        'EXIT FOUND — the expedition ends where the plans end · seed ' + (this.seed >>> 0).toString(16),
      ], () => {
        this.voidEl?.style.setProperty('opacity', '0');
        this.ui.showTitle(true);
      });
    }, 5200);
  }

  private triggerEnding(): void {
    const lines = [
      'The Threshold opens like an eye that has finally decided to see you.',
      'Behind you, the corridors fold the carpet back over their tracks.',
      'Somewhere in the yellow, something practices saying your name —',
      'it gets one syllable wrong. It will practice until it does not matter.',
    ];
    if (this.story.discoveries >= 6) {
      lines.push('Six beacons or more. You were very interesting indeed. It has already started a better copy of you.');
    } else if (this.story.discoveries <= 4) {
      lines.push('You found so little. It will have to guess, and its guesses are enormous.');
    }
    if (this.erosion.relocations > 0) {
      lines.push('You were moved ' + this.erosion.relocations + ' time(s). The version of you that started this expedition did not arrive.');
    }
    if (this.notesRead >= 8) {
      lines.push('You read their words. They know.');
    }
    if (this.seenLandmarks.size >= 3) {
      lines.push('You have seen the rooms it builds.');
    }
    if (this.flashlight.has && !this.flashlight.on) {
      lines.push('You walked in darkness and it respected you for it.');
    }
    if (this.playtimeSec < 600) {
      lines.push('So brief. It barely had time to learn you.');
    } else if (this.playtimeSec > 3600) {
      lines.push('So long. It knows you better than you know yourself now.');
    }
    lines.push('');
    lines.push('EXPEDITION COMPLETE — ' + this.story.discoveries + ' beacons contacted · seed ' + (this.seed >>> 0).toString(16));
    void SaveDB.saveGame(this.captureSlot()).then(() => {});
    // whiteout beat, then the log
    document.body.style.transition = 'background 1.2s ease';
    document.body.style.background = '#efe9d8';
    setTimeout(() => {
      document.body.style.transition = '';
      document.body.style.background = '';
      // F100: hold the transient credits state while the walk scrolls under
      // the ending overlay; the overlay's RETURN TO TITLE click cancels
      // straight into the title (playthrough contract: one click to title).
      this.setState('credits');
      this.beginCreditsWalk();
      this.ui.showEnding(lines.filter((l) => l.length > 0), () => {
        this.cancelCreditsWalk();
        // Same terminal state the walk's natural finish lands on — the
        // button exit used to leave state parked at 'credits'.
        this.setState('menu');
        // Wave A (A-3a): expedition debrief over the title screen.
        if (this.endstats) {
          try { this.endstats.show(this.buildExpeditionStats()); }
          catch (e) { console.warn('[bmb] end stats failed', e); }
          // Wave C (C-8): extended debrief telemetry beside the base rows.
          try {
            for (const line of formatExtended(this.buildExtendedStats())) this.ui.say(line, 6);
          } catch (e) { console.warn('[bmb] extended debrief failed', e); }
        }
        this.ui.showTitle(true);
      });
    }, 1400);
    this.input.releaseLock();
  }

  /**
   * F100: build the credits walk plan from the captured-screenshot gallery
   * (empty gallery -> rolling credits only) and raise the scroll overlay.
   * The plan is deterministic per (screenshots, seed); frames render as
   * labeled cards — gap note: bitmap plumbing from gallery blobs into the
   * scroll column is deferred, so shots appear as expedition-frame cards.
   */
  private beginCreditsWalk(): void {
    if (this.creditsWalker) return;
    // Motion-safety keeps the static ending overlay: the auto-scrolling
    // column is generated motion, so reduced-motion players skip it the
    // same way the wake cinematic collapses to the plain rise. The ending
    // overlay's RETURN TO TITLE button remains the exit.
    if (this.motionSafetyOn()) return;
    const loadShots = async (): Promise<ScreenshotRef[]> => {
      try {
        const photos: StoredPhoto[] = (await this.gallery?.getAll()) ?? [];
        return photos.map((p) => ({
          id: String(p.id),
          takenAtSec: Number.isFinite(p.timestamp) ? Math.max(0, Math.floor(p.timestamp / 1000)) : 0,
        }));
      } catch {
        return []; // storage unavailable -> rolling credits only
      }
    };
    void loadShots().then((shots) => { this.raiseCreditsOverlay(shots); });
  }

  /** Build the plan + DOM once the screenshot list resolves. */
  private raiseCreditsOverlay(shots: ScreenshotRef[]): void {
    if (this.creditsWalker || this.state !== 'credits') return;
    let plan: CreditsWalkPlan;
    try {
      plan = buildCreditsWalk({ screenshots: shots, seed: this.seed });
    } catch (e) {
      console.warn('[bmb] credits walk build failed', e);
      return;
    }
    this.creditsWalker = new CreditsWalker(plan);
    if (typeof document === 'undefined') return;
    const pxPerSec = Game.CREDITS_PX_PER_SEC;
    const overlay = document.createElement('div');
    overlay.id = 'bmb-creditswalk';
    overlay.className = 'ending-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:60;pointer-events:none;display:block;' +
      'overflow:hidden;background:linear-gradient(rgba(12,11,5,0.88), rgba(12,11,5,0.95));' +
      'padding:0;';
    const scroller = document.createElement('div');
    scroller.style.cssText =
      'position:absolute;left:0;right:0;top:' + window.innerHeight + 'px;will-change:transform;';
    for (const entry of plan.timeline) {
      const item = document.createElement('div');
      item.style.cssText = 'position:absolute;left:0;right:0;text-align:center;';
      item.style.top = (entry.atSec * pxPerSec) + 'px';
      if (entry.kind === 'credit') {
        const role = document.createElement('p');
        role.style.setProperty('opacity', '1');
        role.style.animation = 'none';
        role.style.letterSpacing = '4px';
        role.style.fontSize = '12px';
        role.style.margin = '0 auto';
        role.style.color = '#8f8354';
        role.textContent = entry.credit.role.toUpperCase();
        const name = document.createElement('p');
        name.style.setProperty('opacity', '1');
        name.style.animation = 'none';
        name.style.fontSize = '20px';
        name.style.margin = '4px auto 0';
        name.textContent = entry.credit.name;
        item.appendChild(role);
        item.appendChild(name);
      } else {
        const card = document.createElement('p');
        card.style.setProperty('opacity', '1');
        card.style.animation = 'none';
        card.style.fontSize = '12px';
        card.style.margin = '0 auto';
        card.style.color = '#c9bd85';
        const t = entry.frame.takenAtSec;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(Math.floor(t % 60)).padStart(2, '0');
        card.textContent = '· EXPEDITION FRAME — ' + mm + ':' + ss + ' ·';
        item.appendChild(card);
      }
      scroller.appendChild(item);
    }
    scroller.style.height = (plan.durationSec * pxPerSec + window.innerHeight) + 'px';
    overlay.appendChild(scroller);
    document.body.appendChild(overlay);
    this.creditsEl = overlay;
    this.creditsScrollerEl = scroller;
  }

  /** Per-frame scroll update from the walker clock; finishes into title. */
  private tickCreditsWalk(dt: number): void {
    if (!this.creditsWalker) return;
    try {
      this.creditsWalker.advance(dt);
      if (this.creditsScrollerEl) {
        const y = this.creditsWalker.elapsedSec * Game.CREDITS_PX_PER_SEC;
        this.creditsScrollerEl.style.transform = 'translateY(-' + y.toFixed(1) + 'px)';
      }
      if (this.creditsWalker.finished) {
        this.finishCreditsWalk();
      }
    } catch (e) {
      console.warn('[bmb] credits walk tick failed', e);
    }
  }

  /**
   * End the walk the way its natural finish does — tear down the overlay
   * and hand off to the title — used by the walker clock running out and a
   * player's skip press/click.
   *
   * @returns True when a live walk was finished; false when nothing was
   *   playing (motion-safety runs never mount one).
   */
  private finishCreditsWalk(): boolean {
    if (!this.creditsWalker) return false;
    this.cancelCreditsWalk();
    this.setState('menu');
    this.ui.showTitle(true);
    return true;
  }

  /**
   * Public skip used by input handlers and the __BMB__ harness hook: end
   * the credits walk right now with the natural-finish hand-off to the
   * title. No-op when nothing is playing.
   */
  skipCreditsWalk(): boolean {
    return this.finishCreditsWalk();
  }

  /** Tear down the credits overlay + cursor (cancel or natural finish). */
  private cancelCreditsWalk(): void {
    this.creditsWalker = null;
    this.creditsEl?.remove();
    this.creditsEl = null;
    this.creditsScrollerEl = null;
  }

  /** Wave C (C-8): assemble the deeper debrief telemetry snapshot. */
  private buildExtendedStats(): ExtendedStats {
    const totalSec = Math.max(0.001, this.playtimeSec);
    const districtVisits: Record<string, number> = {};
    for (const [k, v] of this.districtVisitCounts) districtVisits[k] = v;
    return {
      torchUsePct: (this.torchLitSec / totalSec) * 100,
      phaseSessions: Math.max(1, this.phaseSessions),
      durationSec: this.playtimeSec,
      relocations: this.erosion.relocations,
      discoveries: this.story.discoveries,
      freezes: this.freezes,
      nearMisses: this.nearMisses,
      longestWalkNoBeaconM: Math.round(Math.max(0, this.longestBeaconDroughtM)),
      districtVisits,
    };
  }

  /** Wave C (C-5): apply a checkpoint snapshot back onto the running game. */
  private async restoreCheckpoint(slot: SaveSlot): Promise<void> {
    try {
      this.seed = slot.seed >>> 0;
      this.playtimeSec = slot.playtimeSec ?? 0;
      try {
        this.mem = MemoryField.deserialize(this.seed, (slot.mem as ReturnType<MemoryField['serialize']>) ?? null);
      } catch { this.mem = new MemoryField(this.seed); }
      try {
        this.weather = MemoryWeather.deserialize(this.seed ^ 0x5179, (slot.weather as ReturnType<MemoryWeather['serialize']>) ?? null);
      } catch { this.weather = new MemoryWeather(this.seed ^ 0x5179); }
      this.mem.weather = this.weather;
      this.chunks.mem = this.mem;
      try {
        this.story = StorySystem.deserialize(this.scene, this.seed, slot.story ?? null);
      } catch { this.story = new StorySystem(this.scene, this.seed); }
      const fl = slot.flash as { has: boolean; on: boolean; battery: number } | undefined;
      this.flashlight.has = !!(fl && fl.has);
      this.flashlight.on = !!(fl && fl.has && fl.on && fl.battery > 0.001);
      this.flashlight.battery = fl ? fl.battery : 1;
      const bt = (slot as { batteriesTaken?: string[] }).batteriesTaken;
      if (bt) for (const k of bt) this.consumedBatteries.add(k);
      const pe = (slot as { pathEcho?: { x: number; z: number }[] }).pathEcho;
      this.pastSessionPath = Array.isArray(pe) ? pe.slice(-200) : [];
      this.echoedRegions.clear();
      const ls = (slot as { landmarksSeen?: string[] }).landmarksSeen;
      if (ls) for (const name of ls) this.seenLandmarks.add(name);
      const stab = (slot as { stability?: number }).stability;
      if (typeof stab === 'number') this.erosion.stability = Math.max(0, Math.min(1, stab));
      const reloc = (slot as { relocations?: number }).relocations;
      if (typeof reloc === 'number') this.erosion.relocations = reloc;
      this.chunks.discoveredLandmarks = this.seenLandmarks;
      this.chunks.story = this.story;
      this.beginRun({ x: slot.px, z: slot.pz, yaw: slot.yaw });
      // F73: checkpoint restores keep the saved pang schedule too.
      if (slot.hunger && this.hunger && !this.hunger.restore(slot.hunger)) {
        console.warn('[bmb] hunger save unusable; keeping fresh pang schedule');
      }
      this.ui.toast('CHECKPOINT RESTORED', 4000);
      this.saveScreen?.hide();
    } catch (e) {
      console.warn('[bmb] checkpoint restore failed', e);
    }
  }

  /** Wave C (C-5): refresh and open the save/load browser over the pause menu. */
  private async openSaveScreen(): Promise<void> {
    if (!this.saveScreen || !this.checkpointsMgr) return;
    try {
      const slots = await this.checkpointsMgr.listCheckpoints();
      this.saveScreen.show(slots as unknown as Parameters<SaveScreen['show']>[0]);
    } catch (e) {
      console.warn('[bmb] save screen failed', e);
    }
  }
}
