/**
 * Wake cinematic run-start mount tests (F91) - pure Node, no renderer.
 * Verifies the wakemount driver contract:
 *   1. determinism - same seed + anchor + delta script replays a
 *      byte-identical applied-pose sequence
 *   2. pose bounds - every emitted world-space pose stays inside
 *      POSE_BOUNDS relative to its bed anchor
 *   3. natural completion - finishes within ceil(totalMs/1000)+1 ticks at
 *      dt=1000ms, emits >= MIN_SHOTS poses, calls onFinish exactly once,
 *      and lands on the staged final shot's anchored pose
 *   4. skip semantics - first press fast-forwards to the closing shot's
 *      framing while still playing; second press ends it (onFinish once)
 *   5. post-finish inertia - ticks after finishing emit nothing further and
 *      never re-fire onFinish
 *   6. junk deltas - NaN/negative/infinite dt are ignored
 *   7. abort - silent teardown: no onFinish, further ticks inert
 *   8. anchor translation - moving the anchor translates every pose by
 *      exactly the anchor delta on x/z, leaving y/fov untouched
 *   9. source hygiene - neither new file reads wall clocks or PRNGs
 *
 * Run: node test/wakemount-test.mjs  (prints WAKEMOUNT ALL PASS, exits 0)
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

import { readFileSync } from 'node:fs';

const {
  WakeMount,
} = await import('../src/story/wakemount.ts');
const {
  stageWakeCinematic, MIN_SHOTS, POSE_BOUNDS,
} = await import('../src/story/wakecinematic.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const EPS = 1e-9;

/** Recording host capturing every applied pose and finish callbacks. */
const makeHost = () => {
  const poses = [];
  let finishes = 0;
  return {
    poses,
    finishes: () => finishes,
    applyPose(p) { poses.push(p); },
    onFinish() { finishes++; },
  };
};

/** Fresh mount wired to a recording host. */
const makeMount = (seed, ax, az) => {
  const host = makeHost();
  return { host, mount: new WakeMount(seed, ax, az, host) };
};

/** Drive a mount with a fixed delta until it stops or maxTicks elapse. */
const drive = (mount, dtMs, maxTicks) => {
  for (let i = 0; i < maxTicks && mount.playing; i++) mount.tick(dtMs);
};

/** True when a world-space pose respects every bound around the anchor. */
const poseInBounds = (p, ax, az) => {
  const b = POSE_BOUNDS;
  return Math.abs(p.px - ax) <= b.positionXZ + EPS &&
    Math.abs(p.pz - az) <= b.positionXZ + EPS &&
    p.py >= b.positionYMin - EPS && p.py <= b.positionYMax + EPS &&
    Math.abs(p.tx - ax) <= b.targetXZ + EPS &&
    Math.abs(p.tz - az) <= b.targetXZ + EPS &&
    p.ty >= b.targetYMin - EPS && p.ty <= b.targetYMax + EPS &&
    p.fovDeg >= b.fovDegMin - EPS && p.fovDeg <= b.fovDegMax + EPS;
};

// ---------------------------------------------------------------------------
console.log('1. Determinism: same seed + anchor + delta script');
{
  const runScript = () => {
    const { mount, host } = makeMount(1234, 5, -7);
    const dts = [16, 33, 16, 250, 1000, 750, 500];
    let i = 0;
    while (mount.playing && i < 200) { mount.tick(dts[i % dts.length]); i++; }
    return JSON.stringify(host.poses);
  };
  const a = runScript();
  const b = runScript();
  ok(a.length > 0, `script produced poses (${JSON.parse(a).length} frames)`);
  ok(a === b, 'two identical runs replay byte-identical pose sequences');
}

// ---------------------------------------------------------------------------
console.log('2. Every applied pose stays inside POSE_BOUNDS around the anchor');
{
  let allIn = true;
  let count = 0;
  for (const seed of [0, 42, 777, 0x9e3779b9]) {
    const { mount, host } = makeMount(seed, 3, 4);
    drive(mount, 120, 200);
    for (const p of host.poses) {
      count++;
      if (!poseInBounds(p, 3, 4)) allIn = false;
    }
  }
  ok(count > 0, `poses were emitted across four seeds (${count} frames)`);
  ok(allIn, 'every emitted pose respects POSE_BOUNDS around its anchor');
}

// ---------------------------------------------------------------------------
console.log('3. Natural completion: timing, pose count, single finish, final shot');
{
  // Pick a seed whose staging is long enough that ceil(totalMs/1000) ticks
  // at dt=1000ms still emit at least MIN_SHOTS poses.
  let seed = -1;
  let st = null;
  for (let s = 0; s < 400; s++) {
    const cand = stageWakeCinematic(s);
    if (cand.totalMs >= 4200) { seed = s; st = cand; break; }
  }
  ok(seed >= 0, `found a long-enough staging (seed ${seed}, ${st ? st.totalMs : 0} ms)`);

  const { mount, host } = makeMount(seed, 0, 0);
  const maxTicks = Math.ceil(st.totalMs / 1000) + 1;
  let ticks = 0;
  while (mount.playing && ticks < maxTicks + 10) { mount.tick(1000); ticks++; }
  ok(!mount.playing, 'sequence finished naturally');
  ok(ticks <= maxTicks, `finished within ceil(totalMs/1000)+1 ticks (${ticks} <= ${maxTicks})`);
  ok(host.poses.length >= MIN_SHOTS, `applied >= MIN_SHOTS poses (${host.poses.length} >= ${MIN_SHOTS})`);
  ok(host.finishes() === 1, `onFinish called exactly once (${host.finishes()})`);

  const lastShot = st.shots[st.shots.length - 1].pose;
  const lastPose = host.poses[host.poses.length - 1];
  ok(
    lastPose.px === 0 + lastShot.position[0] &&
    lastPose.py === lastShot.position[1] &&
    lastPose.pz === 0 + lastShot.position[2] &&
    lastPose.tx === 0 + lastShot.target[0] &&
    lastPose.ty === lastShot.target[1] &&
    lastPose.tz === 0 + lastShot.target[2] &&
    lastPose.fovDeg === lastShot.fovDeg,
    'last applied pose equals the final staged shot, anchored',
  );
}

// ---------------------------------------------------------------------------
console.log('4. Skip-to-final: two presses always end it');
{
  const { mount, host } = makeMount(777, 2, -3);
  mount.skip();
  ok(mount.playing, 'first skip leaves the mount playing');
  const finalShot = stageWakeCinematic(777).shots.slice(-1)[0].pose;
  ok(host.poses.length === 1, `first skip applied exactly one pose (${host.poses.length})`);
  const shown = host.poses[0];
  ok(
    shown.px === 2 + finalShot.position[0] &&
    shown.py === finalShot.position[1] &&
    shown.pz === -3 + finalShot.position[2] &&
    shown.tx === 2 + finalShot.target[0] &&
    shown.ty === finalShot.target[1] &&
    shown.tz === -3 + finalShot.target[2] &&
    shown.fovDeg === finalShot.fovDeg,
    'the frame right after skip shows the final shot, anchored',
  );
  // A tick on the closing shot keeps showing the same framing, still playing.
  mount.tick(50);
  ok(mount.playing && host.finishes() === 0, 'closing shot plays on after the first press');
  mount.skip();
  ok(!mount.playing, 'second skip ends the sequence');
  ok(host.finishes() === 1, `second skip fires onFinish exactly once (${host.finishes()})`);
}

// ---------------------------------------------------------------------------
console.log('5. No-op after natural finish');
{
  const { mount, host } = makeMount(42, 0, 0);
  drive(mount, 500, 200);
  ok(!mount.playing && host.finishes() === 1, 'finished naturally before probing');
  const before = host.poses.length;
  mount.tick(500);
  mount.tick(NaN);
  mount.tick(-1);
  ok(host.poses.length === before, 'post-finish ticks emit nothing further');
  ok(host.finishes() === 1, 'onFinish never re-fires after finish');
}

// ---------------------------------------------------------------------------
console.log('6. Junk deltas are ignored');
{
  const { mount, host } = makeMount(99, 0, 0);
  mount.tick(1000);
  const before = host.poses.length;
  mount.tick(NaN);
  mount.tick(-1);
  mount.tick(Infinity);
  mount.tick(-Infinity);
  ok(host.poses.length === before, `NaN/-1/Infinity/-Infinity dt change nothing (${before} poses)`);
  ok(mount.playing, 'junk deltas do not end playback');
}

// ---------------------------------------------------------------------------
console.log('7. abort() is silent teardown');
{
  const { mount, host } = makeMount(555, 0, 0);
  mount.tick(250);
  mount.abort();
  ok(!mount.playing, 'abort() stops playback');
  ok(host.finishes() === 0, 'abort() never calls onFinish');
  mount.abort();
  const before = host.poses.length;
  mount.tick(1000);
  mount.skip();
  mount.abort();
  ok(host.poses.length === before, 'ticks/skips after abort are inert');
  ok(host.finishes() === 0, 'still no onFinish after abort');
}

// ---------------------------------------------------------------------------
console.log('8. Anchor translation moves every axis by exactly the delta');
{
  const script = [];
  for (let i = 0; i < 64; i++) script.push(i % 3 === 0 ? 333 : 111);
  const runAt = (ax, az) => {
    const { mount, host } = makeMount(2024, ax, az);
    for (const dt of script) { if (!mount.playing) break; mount.tick(dt); }
    return host.poses;
  };
  const base = runAt(0, 0);
  const moved = runAt(37, -12);
  ok(base.length > 0 && base.length === moved.length,
    `both runs emitted matching pose counts (${base.length})`);
  let translated = true;
  let yFovIdentical = true;
  for (let i = 0; i < Math.min(base.length, moved.length); i++) {
    const a = base[i];
    const b = moved[i];
    if (b.px !== 37 + a.px || b.pz !== -12 + a.pz ||
        b.tx !== 37 + a.tx || b.tz !== -12 + a.tz) translated = false;
    if (b.py !== a.py || b.fovDeg !== a.fovDeg) yFovIdentical = false;
  }
  ok(translated, 'px/pz/tx/tz differ by exactly the anchor delta');
  ok(yFovIdentical, 'py and fovDeg are identical between anchors');
}

// ---------------------------------------------------------------------------
console.log('9. Source hygiene: no wall clocks, no PRNGs in the new files');
{
  // Assembled piecewise so this file never contains the literals itself.
  const banned = ['Math' + '.' + 'random', 'Date' + '.' + 'now', 'performance' + '.' + 'now'];
  const files = [
    new URL('../src/story/wakemount.ts', import.meta.url),
    new URL('../test/wakemount-test.mjs', import.meta.url),
  ];
  for (const url of files) {
    const text = readFileSync(url, 'utf8');
    for (const token of banned) {
      ok(!text.includes(token), `${url.pathname.split('/').pop()} is free of '${token}'`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? `WAKEMOUNT ALL PASS ${check}/0` : `${failures}/${check} FAILED`);
process.exit(failures === 0 ? 0 : 1);
