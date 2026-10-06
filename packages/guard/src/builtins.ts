/**
 * Built-in guards — the first real declarations the connector seam
 * carries (spec: specs/sessions/bro-nkn6.md). Pure data, evaluated by
 * the same engine as config defs; a project `defs` entry with the same
 * name shadows the builtin (config wins, first-wins dedup).
 */
import type { Connector, Guard } from '@broject/core'

/** Stop-time nudge: source moved and no test file did. `src/**` is the
 *  spec'd default — flat-layout repos get it free; monorepos shadow it
 *  in `guard.defs` with `packages/*​/src/**`-style globs (bro itself
 *  does). Deliberately a hint: the guard can't know the diff already
 *  covers itself, so firing must stay cheap and ignorable. */
export const BUILTIN_GUARDS: Guard[] = [
  {
    name: 'test-coverage-on-stop',
    when: {
      on: ['stop'],
      state: {
        diff: { changed: ['src/**'], without: ['**/*.test.*', '**/*.spec.*'] },
      },
    },
    say: 'src changed and no test file moved — is the new behavior covered?',
  },
]

/** Contributes the builtins — every repo running bro's hooks gets them;
 *  `bro guard list` shows `guard` as their source. */
export const guardConnector: Connector = {
  name: 'guard',
  guards: () => BUILTIN_GUARDS,
}
