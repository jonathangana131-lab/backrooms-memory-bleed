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
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
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
import type { HumanType } from '../entities/humans';
import { AudioEngine } from '../audio/audio';
import { PositionalHum } from '../audio/positional';
import { WatcherSteps } from '../audio/approach';
import { SurfaceDetector } from '../player/surfacedetect';
import { SurfaceFootsteps } from '../audio/surfaces';
import { DynamicScore } from '../audio/music';
import { ExteriorBleed } from '../audio/exterior';
import { UI } from '../ui/ui';
import { SaveDB, type SaveSlot, type SettingsData } from '../save/db';
import { MemoryField, MemoryKind, MEMORY_NAMES, sectorName } from '../memory/field';
import { MemoryWeather } from '../memory/weather';
import { HorrorDirector, type DirectorHost } from '../director/director';
import { RealityErosion } from '../director/erosion';
import { HumanManager } from '../entities/manager';
import { StorySystem } from '../story/story';

export type GameState = 'menu' | 'playing' | 'paused';

const SPAWN_X = 1.25;
const SPAWN_Z = 1.25;

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

  state: GameState = 'menu';
  seed = 0;
  playtimeSec = 0;

  private lastFrame = performance.now();
  private lastAutosave = 0;
  private settings: SettingsData = { sensitivity: 1, volume: 0.8, quality: 1, fov: 75 };

(Showing lines 1-80 of 1238. Use offset=81 to continue.)

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
  private attract = { x: 8, z: 8, t: 0 };
  private loopArmedUntil = 0;
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
    this.lighting = new LightingRig(this.scene);
    this.lighting.attachToCamera(this.camera);
    // Integration: surface detection is context-free, so it can boot here.
    try {
      this.surfaceDetector = new SurfaceDetector();
    } catch (e) {
      console.warn('[bmb] SurfaceDetector unavailable', e);
    }
    this.lighting.onLightDied = () => {
      this.audio.lightCrack();
      this.ui.say('...that light was coming to you...', 3.5);
    };
    this.player = new PlayerController(this.camera, this.input, this.scene);
    this.flashlight = new Flashlight(this.scene);
    this.chunks = new ChunkManager(this.scene, this.mats, 1);
    this.chunks.consumedBatteries = this.consumedBatteries;
    this.chunks.discoveredLandmarks = this.seenLandmarks;
    this.dust = new DustMotes(this.scene);
    this.humans = new HumanManager(this.scene);
    this.humans.onWatcherVanish = () => {
      this.audio.lightCrack();
      this.lighting.stressLevel = Math.min(1, this.lighting.stressLevel + 0.5);
    };
    this.humans.onBeamFreeze = () => {
      this.audio.beamFreezeSting();
    };
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
    this.director = new HorrorDirector(host, this.seed);
    this.story = new StorySystem(this.scene, this.seed);

    this.player.events.on('footstep', ({ running }) => {
      this.audio.footstep(running);
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
    });

    canvas.addEventListener('click', () => {
      this.audio.unlock();
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
      if (e.code === 'F3') {
        e.preventDefault();
        this.ui.toggleDebug();
      }
      if (e.code === 'KeyE' && this.state === 'playing') {
        console.log('[key] KeyE firing, setting queue; sameInstance=', this === (window as unknown as Record<string, Record<string, unknown>>).__BMB__?.game);
        this.interactQueued = true;
      }
      if (e.code === 'KeyF' && this.state === 'playing') {
        const turned = this.flashlight.toggle();
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
            this.ui.setPrompt(null);
            e.preventDefault();
          }
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
    this.camera.fov = fovDeg * Math.PI / 180;
    this.player.sensitivity = 0.0022 * this.settings.sensitivity;
    this.audio.setMasterVolume(this.settings.volume);
    this.engine.setHardwareScalingLevel(1 / Math.max(0.4, Math.min(1, this.settings.quality)));
    void SaveDB.saveSettings(this.settings).catch(() => {});
  }

  private setState(s: GameState): void {
    this.state = s;
    this.player.enabled = s === 'playing';
  }

  startNew(seedText: string): void {
    this.seed = seedText ? seedFromString(seedText) : (Math.random() * 0xffffffff) >>> 0;
    this.beginRun({ x: SPAWN_X, z: SPAWN_Z, yaw: Math.PI * 0.75 });
    this.player.beginWake();
    this.story.anchors(); // materialize guaranteed beacons
    this.chunks.story = this.story;
    this.ui.toast('EXPEDITION LOG — DAY 0\nYou fell asleep at your desk. The carpet hums under your hands. Somewhere out there a beacon is repeating the last honest words anyone wrote down.');
    void SaveDB.saveGame(this.captureSlot());
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
    if (this.flashlight.has) {
      this.ui.toast('TORCH RESTORED — charge ' + Math.round(this.flashlight.battery * 100) + '% [F]', 6000);
    }
    this.ui.toast('SIGNAL RESTORED — elapsed ' + Math.floor((slot.playtimeSec ?? 0) / 60) + ' min');
  }

  private beginRun(pos: { x: number; z: number; yaw: number }): void {
    this.chunks.seed = this.seed;
    this.chunks.reset();
    this.humans.reset();
    this.forceDeadLights.clear();
    this.blackoutUntil = 0;
    this.mem.seed = this.seed;
    this.weather = new MemoryWeather(this.seed ^ 0x5179);
    this.mem.weather = this.weather;
    this.director = new HorrorDirector({
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
    }, this.seed);
    this.loopArmedUntil = 0;
    this.prevCell = null;
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
    this.input.releaseLock();
    void this.saveNow();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('playing');
    this.ui.hidePause();
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
    this.ui.showTitle(true, Math.floor(s.playtimeSec / 60) + ' min · ' + (s.seed >>> 0).toString(16).toUpperCase().slice(0, 8));
    this.input.releaseLock();
  }

  captureSlot(): SaveSlot {
    return {
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

  private nonEuclideanNudge(): void {
    const yaw = this.player.yaw;
    const back = 28 + Math.random() * 18;
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
        const ang2 = Math.random() * Math.PI * 2;
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

(Showing lines 440-559 of 1250. Use offset=560 to continue.)

    const yaw = rng.next() * Math.PI * 2;
    const dist = 30 + rng.next() * 15;
    this.humans.spawn('wanderer', px - Math.sin(yaw) * dist, pz - Math.cos(yaw) * dist, hash2i(Math.floor(px), Math.floor(pz), this.seed));
  }

  // ---------- integrated systems boot ----------

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
    this.audioModulesReady = true;
  }

  // ---------- frame ----------

  private frame(): void {
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    const active = this.state === 'playing';
    if (active) this.playtimeSec += dt;

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
    this.player.update(active ? dt : 0, colliders);

    if (active) {
      this.mem.recordPresence(this.player.body.x, this.player.body.z, dt);
      this.mem.tick(dt);
      // landmark discovery: one-time line per named room
      if (this.playerLandmark !== this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z)) {
        this.playerLandmark = this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z);
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
          this.ui.say(cues[Math.floor(Math.random() * cues.length)], 5);
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
    this.audioModulesReady = true;
  }

  // ---------- frame ----------

  private frame(): void {
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;

    const active = this.state === 'playing';
    if (active) this.playtimeSec += dt;

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
    this.player.update(active ? dt : 0, colliders);

    if (active) {
      this.mem.recordPresence(this.player.body.x, this.player.body.z, dt);
      this.mem.tick(dt);
      // landmark discovery: one-time line per named room
      if (this.playerLandmark !== this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z)) {
        this.playerLandmark = this.chunks.landmarkAtPos(this.player.body.x, this.player.body.z);
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

(Showing lines 680-789 of 1166. Use offset=790 to continue.)


    // fixture list with director overrides (no allocation in the common case)
    const blackout = this.playtimeSec < this.blackoutUntil;
    // panels go dark too - emissive swap on the shared fixture material
    if (blackout !== this.lastBlackoutVisual) {
      this.lastBlackoutVisual = blackout;
      this.mats.fixture.emissiveColor = blackout
        ? new Color3(0.012, 0.012, 0.01)
        : new Color3(1.0, 0.98, 0.86);
    }
    if (blackout && Math.random() < dt * 0.12) {
      // one distant light fights back
      const cands = this.chunks.allFixtures().filter((f) => {
        const d = Math.hypot(f.x - this.player.body.x, f.z - this.player.body.z);
        return f.alive && d > 22 && d < 60;
      });
      if (cands.length) {
        const pick = cands[Math.floor(Math.random() * cands.length)];
        const dur = 2 + Math.random() * 5;
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

    // Heartbeat: a closing watcher (within 8 m) OR unstable reality.
    // Uses the humans manager proximity data when freshly published,
    // falling back to the live figures list.
    try {
      let hb = 0;
      const prox = this.humans.proximities;
      if (this.prevCell && (cell.x !== this.prevCell.x || cell.z !== this.prevCell.z)) {
        const code = this.chunks.edgeCodeBetweenCell(this.prevCell.x, this.prevCell.z, cell.x, cell.z);
        if (code === 2) this.audio.doorway();
        if (code === 2 && this.playtimeSec < this.loopArmedUntil) {
          this.loopArmedUntil = 0;
          const back = 26 + Math.random() * 14;
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

(Showing lines 895-914 of 1250. Use offset=915 to continue.)

      this.chunks.update(this.player.body.x, this.player.body.z);
      this.story.update(this.player.body.x, this.player.body.z, now / 1000);
    } else if (this.state === 'paused') {
      this.chunks.update(this.player.body.x, this.player.body.z);
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
    if (blackout && Math.random() < dt * 0.12) {
      // one distant light fights back
      const cands = this.chunks.allFixtures().filter((f) => {
        const d = Math.hypot(f.x - this.player.body.x, f.z - this.player.body.z);

(Showing lines 914-933 of 1250. Use offset=934 to continue.)

      }
    }

    const fx2 = this.state === 'menu' ? this.attract.x : this.player.body.x;
    const fz2 = this.state === 'menu' ? this.attract.z : this.player.body.z;
    this.dust.update(dt, fx2, fz2);
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

    // Heartbeat: unstable reality OR a closing watcher.
    try {
      const hb = this.audio.heartbeatFromState(this.erosion.stability, nearestWatcherDist ?? Infinity);
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

(Showing lines 940-1049 of 1238. Use offset=1050 to continue.)


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
    if (shakeAmt > 0.001 && this.state === 'playing') {
      this.camera.position.x += (Math.random() - 0.5) * shakeAmt;
      this.camera.position.y += (Math.random() - 0.5) * shakeAmt;
      this.camera.rotation.z += (Math.random() - 0.5) * shakeAmt * 0.5;
    }
    this.ui.setStamina(this.player.stamina);
    this.ui.setBattery(this.flashlight.has ? this.flashlight.battery : null);
    this.ui.torchOn = this.flashlight.on;
    this.ui.tickSubtitles(dt);
    this.objectiveTimer -= dt;
    if (active && this.objectiveTimer <= 0 && this.story.stage < 4) {
      this.objectiveTimer = 1.0;
      this.ui.setObjective(this.story.objectiveText(this.player.body.x, this.player.body.z));
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

    this.scene.render();
  }

  private openNote: string | null = null;
  private notesRead = 0;

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
      this.setState('menu');
      this.ui.showEnding(lines.filter((l) => l.length > 0), () => {
        this.ui.showTitle(true);
      });
    }, 1400);
    this.input.releaseLock();
  }
}




        const d = Math.hypot(b.x - this.player.body.x, b.z - this.player.body.z);
        if (d < nb) { nb = d; nx2 = b.x; nz2 = b.z; }
      }
      if (isFinite(nb) && nb < 40 && nb > 2.6) {
        const dx = (nx2 - this.player.body.x) / (nb || 1);
        const dz = (nz2 - this.player.body.z) / (nb || 1);
        const pan = Math.max(-1, Math.min(1, dx * Math.cos(this.player.yaw) - dz * Math.sin(this.player.yaw)));
        this.audio.beaconUpdate(nb, pan);
      }
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
    if (shakeAmt > 0.001 && this.state === 'playing') {
      this.camera.position.x += (Math.random() - 0.5) * shakeAmt;
      this.camera.position.y += (Math.random() - 0.5) * shakeAmt;
      this.camera.rotation.z += (Math.random() - 0.5) * shakeAmt * 0.5;
    }
    this.ui.setStamina(this.player.stamina);
    this.ui.setBattery(this.flashlight.has ? this.flashlight.battery : null);
    this.ui.torchOn = this.flashlight.on;
    this.ui.tickSubtitles(dt);
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

    this.scene.render();
  }

  private openNote: string | null = null;
  private notesRead = 0;

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
    // Wave A (A-2a): NoteReread ledger + bleed distortion on re-reads.
    else if (prompt === '[E] READ NOTE' && note && this.reread) {
      try {
        const noteId = 'note:' + Math.round(note.x * 10) + ':' + Math.round(note.z * 10);
        const firstRead = !this.reread.isRead(noteId);
        this.reread.markRead(noteId);
        if (!firstRead) {
          const res = this.reread.distort(note.text, noteId);
          if (res.altered) this.ui.showNote(res.text);
        }
      } catch (e) {
        console.warn('[bmb] note reread failed', e);
      }
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
      this.setState('menu');
      this.ui.showEnding(lines.filter((l) => l.length > 0), () => {
        // Wave A (A-3a): expedition debrief over the title screen.
        if (this.endstats) {
          try { this.endstats.show(this.buildExpeditionStats()); }
          catch (e) { console.warn('[bmb] end stats failed', e); }
        }
        this.ui.showTitle(true);
      });
    }, 1400);
    this.input.releaseLock();
  }
}




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
      // Wave B (B-3b): compass points at that same nearest unfound beacon
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
    if (shakeAmt > 0.001 && this.state === 'playing') {
      this.camera.position.x += (Math.random() - 0.5) * shakeAmt;
      this.camera.position.y += (Math.random() - 0.5) * shakeAmt;
      this.camera.rotation.z += (Math.random() - 0.5) * shakeAmt * 0.5;
    }
    this.ui.setStamina(this.player.stamina);
    this.ui.setBattery(this.flashlight.has ? this.flashlight.battery : null);
    this.ui.torchOn = this.flashlight.on;
    this.ui.tickSubtitles(dt);
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
        const nf = this.weather.nextFront();
        this.weatherUi.update({ kind: nf.kind, intensity: nf.strength, etaSec: nf.etaSec, storm: nf.storm });
      } catch (e) { console.warn('[bmb] weather ui update failed', e); }
    }
    this.objectiveTimer -= dt;

(Showing lines 1670-1677 of 1904. Use offset=1678 to continue.)

    if (active && this.objectiveTimer <= 0 && this.story.stage < 4) {
      this.objectiveTimer = 1.0;
      this.ui.setObjective(this.story.objectiveText(this.player.body.x, this.player.body.z));
    }
    // Wave A (A-2b): throttled ambient difficulty hints from the walls.
    this.hintsTimer -= dt;
    if (active && this.hintsTimer <= 0 && this.hints) {

(Showing lines 1665-1684 of 1904. Use offset=1685 to continue.)

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

    this.scene.render();
  }

  private openNote: string | null = null;
  private notesRead = 0;

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
    // Wave A (A-2a): NoteReread ledger + bleed distortion on re-reads.
    else if (prompt === '[E] READ NOTE' && note && this.reread) {
      try {
        const noteId = 'note:' + Math.round(note.x * 10) + ':' + Math.round(note.z * 10);
        const firstRead = !this.reread.isRead(noteId);
        this.reread.markRead(noteId);
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
      this.setState('menu');
      this.ui.showEnding(lines.filter((l) => l.length > 0), () => {
        // Wave A (A-3a): expedition debrief over the title screen.
        if (this.endstats) {
          try { this.endstats.show(this.buildExpeditionStats()); }
          catch (e) { console.warn('[bmb] end stats failed', e); }
        }
        this.ui.showTitle(true);
      });
    }, 1400);
    this.input.releaseLock();
  }
}




    }
    // Wave A (A-2b): throttled ambient difficulty hints from the walls.
    this.hintsTimer -= dt;
    if (active && this.hintsTimer <= 0 && this.hints) {
      this.hintsTimer = 1.0;

(Showing lines 1690-1909 of 2267. Use offset=1910 to continue.)

    this.ui.torchOn = this.flashlight.on;
    this.ui.tickSubtitles(dt);
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
    // Wave C (C-4): throttled achievement evaluation from live gameplay state
    this.trackerTimer -= dt;
    if (active && this.trackerTimer <= 0 && this.trackerFeed) {
      this.trackerTimer = 1.0;
      try {
        const tf: TrackerState = {

(Showing lines 1830-1949 of 2295. Use offset=1950 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
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
      this.ui.toast('CHECKPOINT RESTORED', 4000);
      this.saveScreen?.hide();
    } catch (e) {
      console.warn('[bmb] checkpoint restore failed', e);
    }
  }

  /** Wave C (C-5): refresh and open the save/load browser over the pause menu. */
  private async openSaveScreen(): Promise<void> {
    if (!this.saveScreen || !this.checkpointsMgr) return;

(Showing lines 2100-2159 of 2267. Use offset=2160 to continue.)

