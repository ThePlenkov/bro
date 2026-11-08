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
