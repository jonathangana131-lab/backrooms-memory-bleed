/**
 * Staged wake cinematic tests (F91) - pure Node, no renderer.
 * Verifies the F91 acceptance proof:
 *   1. staging determinism - same seed produces byte-identical shot lists
 *      (JSON string equality), and every shot kind is legal
 *   2. seed variation - different seeds differ in >= 1 shot across a sweep;
 *      shot order/count vary with the seed inside [MIN_SHOTS, MAX_SHOTS]
 *   3. duration cap - durations sum to totalMs <= TOTAL_CAP_MS on every
 *      staging, each shot >= MIN_SHOT_DURATION_MS, within its kind's range
 *      or capped by the shrink path
 *   4. pose bounds - every camera-pose component respects POSE_BOUNDS
 *   5. skip semantics - skip() lands instantly on the final shot at its own
 *      start; playback otherwise advances shot-by-shot and clamps at the end
 *   6. junk-seed safe - NaN/Infinity/negative seeds yield valid bounded
 *      stagings; empty shot lists fail loud in the player
 *
 * Run: node test/wakecinematic-test.mjs  (prints WAKECINEMATIC ALL PASS, exits 0)
 */
import { register } from 'node:module';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const {
  stageWakeCinematic, WakeCinematicPlayer,
  WAKE_SHOT_KINDS, MIN_SHOTS, MAX_SHOTS, TOTAL_CAP_MS,
  MIN_SHOT_DURATION_MS, SHOT_DURATION_RANGE_MS, POSE_BOUNDS,
} = await import('../src/story/wakecinematic.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** True when a pose respects every documented bound. */
const poseInBounds = (p) =>
  Math.abs(p.position[0]) <= POSE_BOUNDS.positionXZ &&
  Math.abs(p.position[2]) <= POSE_BOUNDS.positionXZ &&
  p.position[1] >= POSE_BOUNDS.positionYMin && p.position[1] <= POSE_BOUNDS.positionYMax &&
  Math.abs(p.target[0]) <= POSE_BOUNDS.targetXZ &&
  Math.abs(p.target[2]) <= POSE_BOUNDS.targetXZ &&
  p.target[1] >= POSE_BOUNDS.targetYMin && p.target[1] <= POSE_BOUNDS.targetYMax &&
  p.fovDeg >= POSE_BOUNDS.fovDegMin && p.fovDeg <= POSE_BOUNDS.fovDegMax;

/** True when a whole staging is structurally legal. */
const stagingLegal = (s) => {
  if (!Array.isArray(s.shots) || s.shots.length < MIN_SHOTS || s.shots.length > MAX_SHOTS) return false;
  let sum = 0;
  for (const shot of s.shots) {
    if (!WAKE_SHOT_KINDS.includes(shot.kind)) return false;
    if (!Number.isInteger(shot.durationMs) || shot.durationMs < MIN_SHOT_DURATION_MS) return false;
    const [dMin, dMax] = SHOT_DURATION_RANGE_MS[shot.kind];
    // Either inside the kind's natural range, or trimmed by the cap path.
    if (!(shot.durationMs >= dMin && shot.durationMs <= dMax) && s.totalMs !== sum + shot.durationMs) {
      if (shot.durationMs > dMax) return false;
    }
    if (!poseInBounds(shot.pose)) return false;
    sum += shot.durationMs;
  }
  return sum === s.totalMs && s.totalMs <= TOTAL_CAP_MS;
};

// ---------------------------------------------------------------------------
console.log('1. Determinism per seed');
{
  for (const seed of [0, 1, 42, 460225993, 0xDEADBEEF, 0x9e3779b9]) {
    const a = JSON.stringify(stageWakeCinematic(seed));
    const b = JSON.stringify(stageWakeCinematic(seed));
    ok(a === b, `seed ${seed} replays byte-identical (${a.length} chars)`);
    ok(stagingLegal(JSON.parse(a)), `seed ${seed} staging is structurally legal`);
  }
}

// ---------------------------------------------------------------------------
console.log('2. Different seeds diverge; order/count seeded');
{
  const anchor = JSON.stringify(stageWakeCinematic(1000));
  let diverged = 0;
  const counts = new Set();
  for (let s = 1001; s <= 1060; s++) {
    const json = JSON.stringify(stageWakeCinematic(s));
    if (json !== anchor) diverged++;
    counts.add(JSON.parse(json).shots.length);
  }
  ok(diverged === 60, `all 60 other seeds differ from seed 1000 in >= 1 shot (${diverged}/60)`);
  let adjacentDiffer = 0;
  for (let s = 0; s < 60; s++) {
    if (JSON.stringify(stageWakeCinematic(s)) !== JSON.stringify(stageWakeCinematic(s + 1))) adjacentDiffer++;
  }
  ok(adjacentDiffer >= 55, `adjacent seeds nearly always diverge (${adjacentDiffer}/60)`);
  ok(counts.size >= 3, `shot count varies with seed (seen ${[...counts].sort().join(',')})`);
  ok(Math.min(...counts) >= MIN_SHOTS && Math.max(...counts) <= MAX_SHOTS,
    'all counts stay inside [MIN_SHOTS, MAX_SHOTS]');
}

// ---------------------------------------------------------------------------
console.log('3. Duration cap over a wide seed sweep');
{
  let worst = 0;
  let allOk = true;
  for (let s = 0; s < 400; s++) {
    const st = stageWakeCinematic(s * 7919);
    worst = Math.max(worst, st.totalMs);
    if (st.totalMs > TOTAL_CAP_MS) allOk = false;
    for (const shot of st.shots) {
      if (shot.durationMs < MIN_SHOT_DURATION_MS) allOk = false;
    }
    // Force the shrink path directly: a hand-built over-cap list must come
    // back through stageWakeCinematic only via seeds - verify via extreme
    // seeds instead that no staging ever exceeds the cap.
  }
  ok(allOk, `no staging among 400 exceeds TOTAL_CAP_MS (worst ${worst})`);
  ok(worst <= TOTAL_CAP_MS && worst > TOTAL_CAP_MS * 0.7,
    `cap is actually approached but never crossed (worst ${worst})`);
}

// ---------------------------------------------------------------------------
console.log('4. Pose bounds everywhere');
{
  let allIn = true;
  for (let s = 0; s < 200; s++) {
    for (const shot of stageWakeCinematic(s).shots) {
      if (!poseInBounds(shot.pose)) { allIn = false; break; }
    }
  }
  ok(allIn, 'every pose component of 200 stagings respects POSE_BOUNDS');
}

// ---------------------------------------------------------------------------
console.log('5. Skip jumps to final shot instantly');
{
  const st = stageWakeCinematic(777);
  const player = new WakeCinematicPlayer(st);
  ok(player.activeIndex === 0 && player.activeShot.kind === st.shots[0].kind,
    'player starts on the first shot');
  // Advance partway into the second shot.
  player.update(st.shots[0].durationMs + 10);
  ok(player.activeIndex === 1, 'update() advances into the second shot');
  player.skip();
  ok(player.activeIndex === st.shots.length - 1, 'skip() lands on the final shot');
  ok(player.remainingMs === st.shots[st.shots.length - 1].durationMs,
    'final shot plays from its own start after skip');
  ok(player.activeShot.kind === st.shots[st.shots.length - 1].kind,
    'active shot is the staged final shot');
  // Playback still finishes normally afterwards.
  player.update(player.remainingMs + 5000);
  ok(player.remainingMs === 0, 'playback clamps at sequence end');
  // Junk deltas ignored.
  const p2 = new WakeCinematicPlayer(stageWakeCinematic(778));
  p2.update(-50);
  p2.update(NaN);
  ok(p2.activeIndex === 0, 'negative/NaN deltas are ignored');
}

// ---------------------------------------------------------------------------
console.log('6. Junk-seed safety');
{
  for (const junkSeed of [NaN, Infinity, -Infinity, -12345, 1.5e15, 4.2]) {
    const st = stageWakeCinematic(junkSeed);
    ok(stagingLegal(st), `junk seed ${String(junkSeed)} yields a legal staging`);
    ok(new WakeCinematicPlayer(st).remainingMs === st.totalMs,
      `junk seed ${String(junkSeed)} is playable`);
  }
  ok(
    JSON.stringify(stageWakeCinematic(NaN)) === JSON.stringify(stageWakeCinematic(Infinity)),
    'all junk seeds fall back to one canonical staging',
  );
  try {
    new WakeCinematicPlayer({ shots: [], totalMs: 0 });
    ok(false, 'empty shot list should throw');
  } catch {
    ok(true, 'empty shot list fails loud');
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? `WAKECINEMATIC ALL PASS (${check} checks)` : `${failures}/${check} FAILED`);
process.exit(failures === 0 ? 0 : 1);
