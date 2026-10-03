import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { collectEmbedded } from './src/embedded.ts'

// The tarball carries the embedded skills/formulas snapshot as a bundle
// asset (dist/generated/skills-data.json), collected fresh at bundle time —
// nothing generated is committed to git. skills-data.ts reads it back via a
// sibling URL when the module runs from an installed package.
const root = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
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
