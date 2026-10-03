/**
 * Build the usage-overlay client bundle with esbuild.
 *
 * The artifact must keep the web shell's loader shape: it calls
 * `window.__ModuleLoader__.load({ id, factory(require) { ... } })`, resolves
 * React through the injected require (the platform module table), and inlines
 * every other dependency (Recharts and its d3/transition tree) into client.js.
 *
 * Usage:
 *   node build.mjs          # one-shot production build
 *   node build.mjs --watch  # rebuild on source change
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** Specifiers the loader module table answers; everything else inlines. */
const external = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]

const options = {
  entryPoints: [resolve(root, 'src/client.tsx')],
  outfile: resolve(root, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external,
  minify: false,
  sourcemap: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Loader shape: open the factory, provide module/exports, close it.
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@local/usage-overlay", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  const { host, port } = await ctx.serve({ servedir: root, port: 0 })
  console.log(`usage-overlay: watching src/client.ts -> client.js (served on ${host}:${port})`)
} else {
  await build(options)
  console.log('usage-overlay: built client.js')
}
