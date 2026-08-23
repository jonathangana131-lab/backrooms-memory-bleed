  const b = td.generateForChunk(cx, cz, 4, s);
  if (JSON.stringify(a) !== JSON.stringify(b)) { sweepOk = false; break; }
}
check('determinism sweep over negative/zero/positive chunks (STORAGE)', sweepOk);

// ---- cluster geometry ------------------------------------------------------
// Group shards by proximity: each hash-gated cluster holds FRAGMENTS_MIN..
// FRAGMENTS_MAX fragments within roughly CLUSTER_RADIUS of its anchor.
function clusterSizes(quads) {
  const pts = quads.map((q) => [
    (q.positions[0] + q.positions[3] + q.positions[6] + q.positions[9]) / 4,
    (q.positions[2] + q.positions[5] + q.positions[8] + q.positions[11]) / 4,
  ]);
  const used = new Array(pts.length).fill(false);
  const sizes = [];
  const R = CLUSTER_RADIUS * 1.35 + 0.12;
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    let size = 0;
    for (let j = i; j < pts.length; j++) {
      if (!used[j] && Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) <= R) {
        used[j] = true;
        size++;
      }
    }
    sizes.push(size);
  }
  return sizes;
}
{
  const bigSeeds = [];
  for (let i = 0; i < 6; i++) {
    bigSeeds.push({ x: 20 * CHUNK + 4 + i * 3.5, z: 30 * CHUNK + 4 + i * 2.9, rotY: (i % 4) * Math.PI / 2 });
  }
  // force every gate on: many chunks until one shows >=2 clusters
  let found = null;
  outer:
  for (let cx = 40; cx < 70; cx++) for (let cz = 40; cz < 70; cz++) {
    const qs = td.generateForChunk(cx, cz, 4, bigSeeds.map((s, k) => ({
      x: cx * CHUNK + 4 + k * 3.5, z: cz * CHUNK + 4 + k * 2.9, rotY: (k % 4) * Math.PI / 2,

(Showing lines 130-169 of 285. Use offset=170 to continue.)

