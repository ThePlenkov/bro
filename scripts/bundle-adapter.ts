/**
 * bundle-adapter — collapse an adapter module into one standalone file.
 *
 * The shared core lives in `packages/agent-plugins/adapter-core/src/` and
 * the build folds it into each shipped artifact (pi, omp) so the host can
 * load a single file with no node_modules resolution.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_CORE = join(ROOT, 'packages/agent-plugins/adapter-core/src');

/** The ownership sentinel every shipped adapter carries. */
const SENTINEL =
  '// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove';

/** Bundle one adapter module into a single standalone ESM string. */
export async function bundleAdapter(entry: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'bro-adapter-'));
  try {
    const bundle = await rolldown({
      input: { bro: resolve(entry) },
      platform: 'node',
      resolve: {
        alias: {
          '@broject/adapter-core/host': join(ADAPTER_CORE, 'host.ts'),
          '@broject/adapter-core/core': join(ADAPTER_CORE, 'core.ts'),
          '@broject/adapter-core': join(ADAPTER_CORE, 'index.ts'),
        },
      },
    });
    try {
      await bundle.write({
        dir: outDir,
        format: 'esm',
        entryFileNames: '[name].ts',
        banner: SENTINEL,
      });
    } finally {
      await bundle.close();
    }
    return readFileSync(join(outDir, 'bro.ts'), 'utf8');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
