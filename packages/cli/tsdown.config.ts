import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { collectEmbedded } from './src/embedded.ts'

// The tarball carries the embedded skills/formulas snapshot as a bundle
// asset (dist/generated/skills-data.json), collected fresh at bundle time —
// nothing generated is committed to git. skills-data.ts reads it back via a
// sibling URL when the module runs from an installed package.
const root = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  // src/opencode.ts is the opencode plugin entry — its loader reads the
  // package's exports["./server"] (see packages/cli/package.json), and it
  // spawns the sibling dist/index.js rather than importing bro, so the two
  // never share a process.
  entry: ['src/index.ts', 'src/plugin.ts', 'src/opencode.ts', 'src/kilo.ts'],
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
