import './style.css';
import { Game } from './core/game';

async function boot(): Promise<void> {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const errBox = document.getElementById('boot-error')!;
  const game = new Game();
  try {
    await game.init(canvas);
    (window as unknown as Record<string, unknown>).__BMB__ = {
      game,
      teleport(x: number, z: number, yaw = 0): void {
        game.player.teleport(x, z, yaw);
      },
      stats(): Record<string, unknown> {
        return {
          state: game.state,
          seed: game.seed,
          pos: [game.player.body.x, game.player.body.z],
          chunksLoaded: game.chunks.loadedCount,
          chunksBuiltTotal: game.chunks.totalBuilt,
          fps: Math.round(game.engine.getFps()),
          drawCalls: game.scene.getActiveMeshes().length,
        };
      },
      startNew(seed?: string): void { game.startNew(seed ?? ''); },
      // F91 v1.1: harness escape hatch — end the waking sequence instantly,
      // exactly as a player's first press does.
      dismissWakeCinematic(): void { game.dismissWakeCinematic(); },
      // F100 motion-safety follow-up: harness escape hatch — end the credits
      // walk instantly with the natural-finish hand-off to the title.
      skipCreditsWalk(): void { game.skipCreditsWalk(); },
      saveNow(): void { void game.saveNow(); },
    };
  } catch (e) {
    console.error('[bmb] boot failed', e);
    errBox.style.display = 'flex';
    errBox.textContent = 'BOOT FAILURE: ' + String(e);
  }
}

void boot();


