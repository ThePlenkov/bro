import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { collectEmbedded } from './src/embedded.ts'

// The tarball carries the embedded skills/formulas snapshot as a bundle
// asset (dist/generated/skills-data.json), collected fresh at bundle time —
// nothing generated is committed to git. skills-data.ts reads it back via a
// sibling URL when the module runs from an installed package.
const root = fileURLToPath(new URL('../..', import.meta.url))

// src/opencode.ts is the opencode plugin entry — its loader reads the
// package's exports["./server"] (see packages/cli/package.json), and it
// spawns the sibling dist/index.js rather than importing bro, so the two
// never share a process. src/opencode-tui.ts is the opencode CLI/TUI
// plugin (exports["./tui"]). src/kilo.ts is the kilo adapter — the same
// standalone module contract.
const main = defineConfig({
  entry: [
    'src/index.ts',
    'src/plugin.ts',
    'src/opencode.ts',
    'src/opencode-tui.ts',
    'src/opencode-tui-v2.tsx',
    'src/kilo.ts',
  ],
  format: ['esm'],
  dts: true,
  // Bundle workspace libs into the published CLI — consumers get one file.
  noExternal: [/^@broject\//],
  plugins: [
    {
      name: 'bro-embedded',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'generated/skills-data.json',
          source: JSON.stringify(collectEmbedded(root)),
        })
      },
    },
  ],
})

/**
 * The pi and omp adapters each get their OWN build.
 *
 * Both import the shared adapter core (src/adapter/), and a host loads
 * them as a single file: pi's jiti reads the raw .ts, omp resolves a
 * relative import inside a plugin package — neither has a `node_modules`
 * to resolve a code-split chunk against. Sharing one build would emit
 * `dist/host-<hash>.js` next to `dist/pi.js` and the installed adapter
 * would fail to load.
 *
 * A separate config per adapter keeps each graph self-contained: one
 * entry, one file, nothing to resolve.
 */
const pi = defineConfig({
  entry: ['src/adapter/pi.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  noExternal: [/^@broject\//],
})

const omp = defineConfig({
  entry: ['src/adapter/omp.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  noExternal: [/^@broject\//],
})

export default [main, pi, omp]
