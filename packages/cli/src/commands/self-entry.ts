/** The entry script this process was launched as, absolutized at module
 *  load. Every detached respawn (pulse rearm, daemon, act-wait rearm,
 *  post-merge worker) re-roots its child at a foreign cwd — a relative
 *  `process.argv[1]` (`node ./dist/index.js`, dev invocations) would
 *  resolve against the CHILD's cwd there and the rearm never finds the
 *  CLI. Resolving at load also beats the hook process's own
 *  `enterHookProject` chdir, which runs before any connector probe gets
 *  to spawn. Null when argv is not bro-shaped (tests import these
 *  modules directly). */
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const rawEntry = process.argv[1] === undefined ? null : resolve(process.argv[1]);

/** The slim hook entry (`dist/hooks.js`, `src/hooks.ts`) dispatches only
 *  hook events — a detached respawn through it (`daemon run`, `watch`,
 *  `trace export`, post-merge workers) would land on runHooksCommand as
 *  an unknown event and silently do nothing. SELF_ENTRY must therefore
 *  always name a full-CLI entry: the hooks entry's index sibling is the
 *  same dispatch `bro <cmd>` takes. The sibling check keeps source/dev
 *  layouts and foreign `hooks.js` files untouched. */
function fullCliEntry(entry: string): string {
  const base = basename(entry);
  if (base !== 'hooks.js' && base !== 'hooks.ts') {
    return entry;
  }
  const sibling = join(dirname(entry), base === 'hooks.js' ? 'index.js' : 'index.ts');
  return existsSync(sibling) ? sibling : entry;
}

export const SELF_ENTRY: string | null = rawEntry === null ? null : fullCliEntry(rawEntry);
