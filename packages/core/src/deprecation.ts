/**
 * The deprecation contract — one stderr line, the thing still works.
 *
 * Pre-1.0 surfaces may still be removed, but never silently: ship the
 * warning for a release first (`BroPlugin.deprecated` covers whole
 * commands; commands call this for flags/subcommands/verbs), removal
 * lands in a later release. See CONTRIBUTING.md §Stability.
 */
export function warnDeprecated(what: string, advice?: string): void {
  console.error(`warning: ${what} is deprecated${advice ? ` — ${advice}` : ''}`)
}
