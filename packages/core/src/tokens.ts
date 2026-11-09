/**
 * The token estimate — the number bro reports when the provider reported
 * none.
 *
 * chars/4 for ascii, one token per wide codepoint (CJK reads about one
 * token per character, so the quarter-rate would undercount it several
 * times over). An ESTIMATE, always labelled as one: never billing, never
 * compaction, never a substitute for a provider's own number.
 */

/** The estimated token count of a text. */
export function estimateTokens(s: string): number {
  let units = 0;
  for (const ch of s) {
    units += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 4 : 1;
  }
  return Math.max(1, Math.ceil(units / 4));
}
