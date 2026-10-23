/**
 * bundle-adapter — collapse an adapter module into one standalone file.
 *
 * ## Why a bundle
 *
 * A shipped adapter is loaded by its host as a *plain file*: pi's jiti
 * reads the raw `.ts`, omp resolves a relative import inside a plugin
 * package, opencode's loader reads the package's exports. The file has
 * to stand alone — no `../adapter/core.ts` to resolve, no
 * `node_modules` to find the shared module in.
 *
 * That constraint is exactly why the shared core used to be copied by
 * hand into every adapter: three near-verbatim copies of the same 120
 * lines, free to drift. (They did: pi had no `options.command` tier,
 * and kilo's doc claimed an npx tier its code never had.)
 *
 * So the shared core lives in one place — `packages/cli/src/adapter/` —
 * and the *build* folds it into each shipped artifact. The copies are
 * still there; what is gone is the chance for them to disagree.
 *
 * ## Why rolldown
 *
 * tsdown's own bundler, so the adapter bundle uses the same toolchain
 * and the same `tsconfig.base.json` semantics as every package build.
 * It preserves comments — an adapter is a file a human reads when a
 * hook misbehaves, and a minified blob would be useless at 2am.
 *
 * ## The banner
 *
 * Every shipped adapter carries the `bro-adapter` sentinel on its first
 * line: `bro plugins install` refuses to overwrite a foreign file that
 * holds the slot, and the sentinel is how bro recognizes its own. The
 * bundler rewrites a module-level comment into a banner — rolldown
 * drops leading file comments otherwise, and the sentinel has to
 * survive the bundle.
 *
 * The output is ESM, platform node, no external dependencies: the
 * adapter may only import node builtins, because there is nothing else
 * to resolve it against.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolldown } from 'rolldown'

/** The ownership sentinel every shipped adapter carries. */
const SENTINEL =
  '// bro-adapter — ownership sentinel for `bro plugins` (isBroAdapter); do not remove'

/** Bundle one adapter module into a single standalone ESM string. */
export async function bundleAdapter(entry: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'bro-adapter-'))
  try {
    const bundle = await rolldown({
      input: { bro: entry },
      platform: 'node',
    })
    await bundle.write({
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].ts',
      banner: SENTINEL,
    })
    await bundle.close()
    return readFileSync(join(outDir, 'bro.ts'), 'utf8')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}
