/**
 * Command errors carry a typed exit code so the dispatcher is the only
 * place that calls process.exit (spec bro-fl5o5). Library/command code
 * throws CommandError; the CLI maps it to the correct stream + code.
 */
import { EXIT, type ExitCode } from './exits.ts'

export class CommandError extends Error {
  code: ExitCode
  usage?: string

  constructor(message: string, code: ExitCode = EXIT.error, usage?: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.usage = usage
    // Ensure proper prototype chain for instanceof
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function isCommandError(err: unknown): err is CommandError {
  return err instanceof CommandError
}

export { EXIT }
export type { ExitCode }
