import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { collectEmbedded } from './src/embedded.ts';

// The tarball carries the embedded skills/formulas snapshot as a bundle
// asset (dist/generated/skills-data.json), collected fresh at bundle time.
const root = fileURLToPath(new URL('../..', import.meta.url));

// Agent adapters (opencode/kilo/omp/pi) live in packages/agent-plugins/* —
// CLI no longer bundles or exports them. The opencode plugin (server +
// TUI + RPC) ships as its own package: @broject/opencode.
/** The opencode catalog plugin's modules — the three that must
 *  travel together: opencode raises the TUI half only for a package
 *  that also has a server. */
const OPENCODE_PLUGIN_FILES = ['index.ts', 'tui.tsx', 'rpc.ts', 'README.md'];

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
    {
      // the opencode catalog plugin rides the tarball: `bro plugins
      // install opencode` writes those three modules into the user's
      // opencode plugin directory, and outside a bro CHECKOUT there is
      // no other source for them (the adapter packages are not
      // published on their own yet)
      name: 'bro-opencode-plugin',
      generateBundle() {
        for (const name of OPENCODE_PLUGIN_FILES) {
          const source = `${root}/plugins/opencode/bro/${name}`;
          if (!existsSync(source)) {
            continue;
          }
          this.emitFile({
            type: 'asset',
            fileName: `plugins/opencode/bro/${name}`,
            source: readFileSync(source),
          });
        }
      },
    },
  ],
});
