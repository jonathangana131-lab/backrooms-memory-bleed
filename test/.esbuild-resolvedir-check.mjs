// Isolated check: does esbuild 0.21.5 accept a stub onLoad with resolveDir?
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const esbuild = require_('esbuild');
const STUBS = process.cwd() + '/test/.smart-spawn-stubs.mjs';
try {
  const r = await esbuild.build({
    stdin: { contents: `export { TransformNode } from '@babylonjs/core/Meshes/transformNode';`, loader: 'js' },
    bundle: true, format: 'esm', write: false,
    plugins: [{
      name: 'p',
      setup(b) {
        b.onResolve({ filter: /@babylonjs\// }, (args) => ({ path: args.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: `export { Vector3, TransformNode } from '${STUBS}';`,
          loader: 'js',
          resolveDir: process.cwd(),
        }));
      },
    }],
  });
  console.log('OK_WITH_RESOLVEDIR bytes=', r.outputFiles[0].text.length);
} catch (e) {
  console.log('ERR', e.errors?.[0]?.text ?? String(e));
}
