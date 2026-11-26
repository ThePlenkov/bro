/**
 * Command errors carry a typed exit code so the dispatcher is the only
 * place that calls process.exit (spec bro-fl5o5). Library/command code
 * throws CommandError; the CLI maps it to the correct stream + code.
 */
import { EXIT, type ExitCode } from './exits.ts';

export type CommandErrorClassification = 'usage' | 'config' | 'runtime' | 'internal';

export class CommandError extends Error {
  code: ExitCode;
  classification: CommandErrorClassification;
  usage?: string;
  /** structured context for machine consumers — free-form, the
   *  dispatcher prints only message/usage */
  details?: unknown;

  constructor(
    message: string,
    code: ExitCode = EXIT.error,
    usage?: string,
    details?: unknown,
    classification: CommandErrorClassification = code === EXIT.usage ? 'usage' : 'runtime'
  ) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.classification = classification;
    this.usage = usage;
    this.details = details;
    // Ensure proper prototype chain for instanceof
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isCommandError(err: unknown): err is CommandError {
  // instanceof first; the name check catches a CommandError thrown by
  // a bundled duplicate of this module (two copies of @broject/core in
  // one process carry different prototypes but the same contract)
  return (
    err instanceof CommandError ||
    (err !== null && typeof err === 'object' && (err as { name?: unknown }).name === 'CommandError')
  );
}

export type { ExitCode };
export { EXIT };
