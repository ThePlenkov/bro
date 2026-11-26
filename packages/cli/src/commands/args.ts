/**
 * Shared hand-rolled arg parsing — no parser library.
 *
 * The parser lives in core so EVERY bro CLI parses the same way: the
 * `bro` CLI and the `brouter` bin are two shells over one set of
 * rules (a `--name value` pair, a `--name=value` pair, a boolean flag,
 * `--` ending the flag zone). One parser, one set of mistakes.
 */
export {
  deprecatedFlag,
  flag,
  flagAll,
  flagValue,
  positionals,
} from '@broject/core';

/** Return only the portion of argv where option parsing is active. */
export const flagZone = (argv: readonly string[]): readonly string[] => {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
};
