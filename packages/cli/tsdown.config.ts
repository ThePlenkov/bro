import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { collectEmbedded } from './src/embedded.ts';

// The tarball carries the embedded skills/formulas snapshot as a bundle
// asset (dist/generated/skills-data.json), collected fresh at bundle time.
const root = fileURLToPath(new URL('../..', import.meta.url));

// Agent adapters (opencode/kilo/omp/pi) live in packages/agent-plugins/* —
// CLI no longer bundles or exports them.
export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts', 'src/config-schema.ts'],
  format: ['esm'],
  dts: true,
  noExternal: [/^@broject\//],
  plugins: [
    {
      name: 'bro-embedded',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'generated/skills-data.json',
          source: JSON.stringify(collectEmbedded(root)),
        });
      },
    },
  ],
});
