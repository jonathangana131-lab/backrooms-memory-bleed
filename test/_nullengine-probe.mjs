
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
try {
  const B = await server.ssrLoadModule('@babylonjs/core');
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  const mesh = new B.Mesh('m', scene);
  const vd = new B.VertexData();
  vd.positions = [0,0,0, 1,0,0, 1,1,0, 0,1,0];
  vd.indices = [0,1,2,0,2,3];
  vd.colors = [1,0,0,0.5, 1,0,0,0.5, 1,0,0,0.5, 1,0,0,0.5];
  vd.applyToMesh(mesh, true);
  mesh.hasVertexAlpha = true;
  const upd = () => {
    mesh.updateVerticesData('position', new Float32Array(12));
    mesh.updateVerticesData('color', new Float32Array(16));
  };
  upd();
  console.log('PROBE OK: NullEngine + updatable mesh + vertex alpha OK');
} catch (e) {
  console.log('PROBE FAIL:', e && e.message);
}
await server.close();


