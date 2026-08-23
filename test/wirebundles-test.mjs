      }
      before = g.props.positions.length;
    } catch (e) {
      check('mesher.addBox consumes BundleBox specs without throwing', false, String(e));
    }
    const verts = before / 3;
    const tris = g.props.indices.length / 3;
    check('mesher.addBox consumes BundleBox specs without throwing',
      verts > 0 && tris > 0, 'verts=' + verts + ' tris=' + tris);
    check('emitted mesh is clean triangles (indices multiple of 3)',
      g.props.indices.length % 3 === 0 && verts > 0);
  }

  // --- 9. empty/degenerate inputs ---------------------------------------------
  {
    const empty = makeLayout(0, 0, MAZE, {}); // no walls at all
    const out = new WireBundles(SEED).generateForChunk(empty);
    check('wall-free chunk yields zero instances', Array.isArray(out) && out.length === 0);

    const doorwayOnly = makeLayout(0, 0, STORAGE, {});
    doorwayOnly.hEdges[5 * N + 4] = 2; // DOORWAY edge only
    const out2 = new WireBundles(SEED).generateForChunk(doorwayOnly);
    check('doorway-only edges host no runs', out2.length === 0, 'n=' + out2.length);
  }
} catch (e) {
  failures++;
  console.log('FATAL ' + (e && e.stack ? e.stack : String(e)));
} finally {
  await server.close();
}

console.log(failures === 0 ? '
ALL TESTS PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);


