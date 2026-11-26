import { EXIT, isCommandError, printUsage } from '@broject/core';

/** The one process boundary for command failures (spec bro-fl5o5). */
export function dispatchFatal(err: unknown): void {
  if (isCommandError(err)) {
    const code = typeof err.code === 'number' ? err.code : EXIT.error;
    const out = code === EXIT.ok ? console.log : console.error;
    if (err.message && err.message !== err.usage) out(err.message);
    if (err.usage !== undefined && err.message !== err.usage) {
      try {
        printUsage(err.usage, err.code);
      } catch {
        // printUsage writes before throwing its boundary error.
      }
    }
    process.exit(code === EXIT.ok ? 0 : code);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(EXIT.error);
}
