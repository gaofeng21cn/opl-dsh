import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Build the regression-test bridge without rewriting platform-dependent RPC sources. */
export async function buildNativeBridge(root) {
  await build({
    entryPoints: [join(root, 'src/execution/host/adapters/native-harness-bridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: join(root, 'dist/package/lib/native-harness-bridge.mjs'),
    banner: {
      js: "import { createRequire as oplCreateRequire } from 'node:module'; const require = oplCreateRequire(import.meta.url);",
    },
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildNativeBridge(resolve(import.meta.dirname, '..'))
