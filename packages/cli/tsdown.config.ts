import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  // src/hooks.ts → dist/hooks.js is the slim hook entry (specs/
  // bro-36sx7.7.md): run.sh prefers it so a hook event never evaluates
  // the PLUGINS registry in index.ts's graph.
  entry: ['src/index.ts', 'src/plugin.ts', 'src/config-schema.ts', 'src/hooks.ts'],
  format: ['esm'],
  dts: true,
  fixedExtension: false,
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
      // brotocol's spec templates ride the tarball as dist assets —
      // @broject/spec is bundled (noExternal), so the published cli has
      // no node_modules/@broject/brotocol to resolve templates from;
      // spec-connector probes <dist>/templates first
      name: 'bro-brotocol-templates',
      generateBundle() {
        const templates = `${root}/packages/brotocol/templates`;
        if (!existsSync(templates)) {
          return;
        }
        for (const e of readdirSync(templates, { withFileTypes: true })) {
          if (!e.isFile()) {
            continue;
          }
          const source = `${templates}/${e.name}`;
          this.emitFile({
            type: 'asset',
            fileName: `templates/${e.name}`,
            source: readFileSync(source),
          });
        }
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
