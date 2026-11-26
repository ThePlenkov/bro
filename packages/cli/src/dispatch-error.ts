import { EXIT, type CommandError, isCommandError, printUsage } from '@broject/core';

function presentUsage(err: CommandError): void {
  try {
    printUsage(err.usage as string, err.code);
  } catch {
    // printUsage writes before throwing its boundary error.
  }
}

function presentCommandError(err: CommandError): void {
  const out = err.code === EXIT.ok ? console.log : console.error;
  const distinct = err.message !== err.usage;
  if (err.message && distinct) out(err.message);
  if (err.usage !== undefined && distinct) {
    presentUsage(err);
  }
}

/** The one process boundary for command failures (spec bro-fl5o5). */
export function dispatchFatal(err: unknown): void {
  if (!isCommandError(err)) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(EXIT.error);
  }
  presentCommandError(err);
  process.exit(err.code);
}
