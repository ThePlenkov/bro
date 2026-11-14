/**
 * `bro acp` — bro on the ACP wire (specs bro-rs8sp.md, bro-bhyo1.md,
 * bro-u2eps.md, bro-tegz2.md). Two surfaces, one pump:
 *
 * - `bro acp` (agent mode) — bro IS the agent: the CLI contract
 *   advertised as slash commands, free-form prompts forwarded to the
 *   configured provider (fleet.routing class → chain head). See
 *   acp-agent.ts.
 * - `bro acp proxy -- <agent cmd>` — the cascading edge: the client
 *   names the successor in argv; bro forwards everything verbatim
 *   except the session's first `session/prompt` (which carries the
 *   hook seam's session-start + prompt-submit context as one
 *   prepended text block), the tool-call updates that feed the
 *   in-process arming/guard pass, and the turn-end responses the
 *   stop gate can hold for exactly one re-prompt.
 *
 * The seam is the same code `bro hooks` runs — collectSessionContext /
 * collectPromptContext / collectToolCallGuards / collectStopGate as
 * library calls keyed on `session/new`'s cwd, never a subprocess and
 * never the proxy's own cwd. `acpHookSeam()` in acp-agent.ts wires it
 * for both surfaces.
 */
import { CommandError, EXIT, passthroughExitCode } from '@broject/core';
import { acpAgentFlags, acpHookSeam, runAcpAgent } from './acp-agent.ts';

const USAGE = `usage:
  bro acp [--provider <name> | --class <name>]
  bro acp proxy -- <agent cmd…>`;

function usage(line: string): never {
  throw new CommandError(`${line}\n${USAGE}`, EXIT.usage, USAGE);
}

export async function runAcpCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== 'proxy') {
    // agent mode — bare `bro acp` is the ACP server (the `* acp`
    // convention); flag parsing owns the usage errors from here
    const sel = acpAgentFlags(argv);
    const code = await runAcpAgent(sel);
    if (code !== 0) {
      throw new CommandError('', passthroughExitCode(code));
    }
    return;
  }
  const sep = rest.indexOf('--');
  // `--` is mandatory — the tail is the successor's argv, tokenized
  // verbatim and exec'd without a shell; without the separator a
  // downstream flag could be misread as ours
  if (sep === -1) {
    usage('error: `proxy` requires `--` before the agent command');
  }
  const command = rest.slice(sep + 1);
  if (command.length === 0) {
    usage('error: empty agent command after `--`');
  }
  const { runAcpProxy } = await import('@broject/providers');
  const code = await runAcpProxy(command, { seam: acpHookSeam() });
  if (code !== 0) {
    throw new CommandError('', passthroughExitCode(code));
  }
}
