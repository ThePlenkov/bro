/**
 * @broject/command — a bootstrap for ANY CLI.
 *
 * The package knows nothing about bro, beads, the bus or the fleet: it
 * is the generic half. A CLI is a COMMAND — a declaration that holds
 * PLUGINS (leaf commands) and COMMANDS (nested commands). Nesting is
 * the tree, and the tree belongs to the caller:
 *
 *   const cli = defineCommand({
 *     name: 'mytool',
 *     summary: '…',
 *     plugins: [statusCommand],
 *     commands: [defineCommand({ name: 'db', summary: '…', plugins: [...] })],
 *   })
 *
 * A command is not executable by itself — the BIN decides what is
 * executable. Any command can be mounted as a bin of its own, because a
 * command is self-contained: the same `ask` a router mounts is
 * mountable as `router-ask` without a second implementation.
 *
 * Zero dependencies on purpose: the bootstrap is the bottom of the
 * stack, and every CLI above it may differ in everything but the
 * dispatch.
 */

/** The exit codes a CLI reports — the shared taxonomy every bro-family
 *  CLI uses, and the generic half of it. */
export const EXIT = {
  /** success — including explicit `--help`. */
  ok: 0,
  /** failure / negative verdict. */
  error: 1,
  /** usage error — bad flag, missing arg, unknown command. */
  usage: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Where the usage text goes — stdout for `--help`, stderr for a usage
 *  error. Injectable so a host can capture it in a test. */
export interface UsageWriter {
  write(code: ExitCode, text: string): void;
}

const defaultWriter: UsageWriter = {
  write(code, text) {
    if (code === EXIT.ok) {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    } else {
      process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    }
  },
};

let usageWriter: UsageWriter = defaultWriter;

/** Swap the usage writer (a test captures it; a host may route it). */
export function setUsageWriter(writer: UsageWriter): void {
  usageWriter = writer;
}

/** Print the usage text and exit. */
export function printUsage(text: string, code: ExitCode): never {
  usageWriter.write(code, text);
  process.exit(code);
}

/** Warn about a deprecated spelling — the same one-shot discipline the
 *  bro-family CLIs use. */
export function warnDeprecated(what: string, advice?: string): void {
  console.error(
    `warning: ${what} is deprecated${advice === undefined ? '' : ` — ${advice}`}`
  );
}
