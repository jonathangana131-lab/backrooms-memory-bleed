          [cxw - hw, y0, czw], [cxw + hw, y0, czw],
          [cxw + hw, y1, czw], [cxw - hw, y1, czw],
          [0, 0, dt.face === 0 ? -1 : 1], [0, 0], [1, 0], [1, 1], [0, 1]);
      } else {
        quad(d,
          [cxw, y0, czw - hw], [cxw, y0, czw + hw],
          [cxw, y1, czw + hw], [cxw, y1, czw - hw],
          [dt.face === 2 ? -1 : 1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      }
    }
    tintVerts(d, startVert,
      ((dt.rgb >> 16) & 255) / 255,
      ((dt.rgb >> 8) & 255) / 255,
      (dt.rgb & 255) / 255);
  }
}

export function buildChunkGeometry(
  layout: ChunkGeometryInput,
  camX: number = Infinity,
  camZ: number = Infinity,
): ChunkGeometry {
  const N = CHUNK_CELLS;
  const centerX = (layout.cx + 0.5) * N * CELL;
  const centerZ = (layout.cz + 0.5) * N * CELL;
  // pure distance band: same chunk at same camera distance => same geometry
  const lod = lodLevelFor(camX, camZ, centerX, centerZ);
  const g: ChunkGeometry = {
    floor: newArray(), ceiling: newArray(),
    walls: newArray(), fixtures: newArray(), fixturesDead: newArray(),
    props: newArray(), debris: newArray(),
    puddles: newArray(), graffiti: newArray(), stains: newArray(),
  };
  addFloor(g, layout.cx, layout.cz);
  addCeiling(g, layout.cx, layout.cz);
  addCeilingGrid(g, layout.cx, layout.cz);
  addWalls(g, layout);
  addBaseboards(g, layout);
  addFixtures(g, layout);
  addProps(g, layout);
  // LOD 1+: skip small dressing quads — paper scraps, readable notes and
  // landmark details (prayer cards, lint, chalk...)
  if (lod < 1) addDebris(g, layout);
  // path echo: faint dark scuffs along the previous session's trail
  if (layout.pathEcho) {
    for (const pt of layout.pathEcho) {
      const sz2 = 0.09;
      const ang2 = Math.sin(pt.x * 7.3 + pt.z * 3.1) * Math.PI;
      const ca = Math.cos(ang2), sa = Math.sin(ang2);
      for (const [ox, oz] of [[-0.12, 0], [0.12, 0]] as const) {
        const px2 = pt.x + ca * ox - sa * oz;
        const pz2 = pt.z + sa * ox + ca * oz;
        quad(g.debris,
          [px2 - sz2, 0.005, pz2 - sz2], [px2 + sz2, 0.005, pz2 - sz2],
          [px2 + sz2, 0.005, pz2 + sz2], [px2 - sz2, 0.005, pz2 + sz2],
          [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      }
    }
  }
  // contact shadows: full-corner quads generated at build time
  if (layout.shadowQuads) {
    for (const q of layout.shadowQuads) {
      const p = q.positions;
      g.debris.positions.push(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11]);
      g.debris.normals.push(q.normal[0], q.normal[1], q.normal[2], q.normal[0], q.normal[1], q.normal[2], q.normal[0], q.normal[1], q.normal[2], q.normal[0], q.normal[1], q.normal[2]);
      g.debris.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      const t = q.tints;
      if (!g.debris.colors) g.debris.colors = [];
      for (let v = 0; v < 4; v++) g.debris.colors.push(t[v*3], t[v*3+1], t[v*3+2], 1);
      const bi = g.debris.indices.length;
      g.debris.indices.push(bi, bi+1, bi+2, bi, bi+2, bi+3);
    }
  }
  // LOD 1+: notes and landmark dressing quads are skipped too
  if (lod < 1) {
    addNotes(g, layout);
    addDetails(g, layout);
  }
  addPuddles(g, layout);
  addFloorWear(g, layout);
  addWires(g, layout);
  // LOD 2: also skip stains/graffiti quads
  if (lod < 2) {
    addGraffiti(g, layout);
    addCeilingStains(g, layout);
  }
  // vertex-budget debug aid: one console line per 50 chunks built
  lodChunksBuilt++;
  const verts = totalVerts(g);
  lodVertsBuiltTotal += verts;
  if (lod > 0) lodVertsSkippedTotal += estimateSkippedVerts(layout, lod);
  if (lodChunksBuilt % 50 === 0) {
    const full = lodVertsBuiltTotal + lodVertsSkippedTotal;
    const pct = full > 0 ? ((lodVertsSkippedTotal / full) * 100).toFixed(1) : '0.0';
    console.log(
      `[lod] ${lodChunksBuilt} chunks built: ${lodVertsBuiltTotal} verts emitted, ` +
      `~${lodVertsSkippedTotal} skipped by distance LOD (~${pct}% reduction)`);
  }
  return g;
}
type ChunkGeometryInput = import('./architect').ChunkLayout;


