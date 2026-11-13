/**
 * `bro acp proxy -- <agent cmd>` — the cascading ACP edge (specs
 * bro-rs8sp.md, bro-bhyo1.md, bro-u2eps.md). bro sits on the ACP wire:
 * the client (Zed, JetBrains, Neovim, `devin acp`, `kilo acp`) talks ACP
 * to this process's stdin/stdout; bro spawns the downstream agent from
 * the argv tail and forwards everything verbatim — except the session's
 * first `session/prompt` (which carries the hook seam's session-start +
 * prompt-submit context as one prepended text block), the tool-call
 * updates that feed the in-process arming/guard pass, and the turn-end
 * responses the stop gate can hold for exactly one re-prompt.
 *
 * The seam is the same code `bro hooks` runs — collectSessionContext /
 * collectPromptContext / collectToolCallGuards / collectStopGate as
 * library calls keyed on `session/new`'s cwd, never a subprocess and
 * never the proxy's own cwd.
 */
import { CommandError, EXIT, passthroughExitCode } from '@broject/core';
import {
  collectPromptContext,
  collectSessionContext,
  collectStopGate,
  collectToolCallGuards,
} from './hooks.ts';

const USAGE = 'usage: bro acp proxy -- <agent cmd…>';

function usage(line: string): never {
  throw new CommandError(`${line}\n${USAGE}`, EXIT.usage);
}

export async function runAcpCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== 'proxy') {
    usage(`error: unknown subcommand '${sub ?? ''}'`);
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
  const code = await runAcpProxy(command, {
    seam: {
      sessionContext: async (cwd, sessionId) => {
        const r = await collectSessionContext(cwd, sessionId);
        // `settled` must cross the seam — an unsettled probe set is
        // incomplete context: the proxy retries it on the next prompt
        // rather than presenting partial output as the session start
        return {
          text: r.lines.length === 0 ? undefined : r.lines.join('\n'),
          settled: r.settled,
        };
      },
      promptContext: async (cwd, sessionId, prompt) => {
        const r = await collectPromptContext(cwd, sessionId, prompt);
        return r.lines.length === 0 ? undefined : r.lines.join('\n');
      },
      // the tool-call and stop-gate legs (spec bro-u2eps): the same
      // arming + guard + gate evaluation `bro hooks` runs, in-process —
      // the proxy pays no per-call subprocess. `call` arrives as the
      // proxy's own AcpProxyToolCall shape; AcpToolCall is the same
      // structure declared on this side of the module edge.
      toolCall: async (cwd, sessionId, call) => {
        const r = await collectToolCallGuards(cwd, sessionId, call);
        return r.lines.length === 0 ? undefined : r.lines;
      },
      stopGate: async (cwd, sessionId) => {
        const r = await collectStopGate(cwd, sessionId);
        return r.block === undefined && r.hints.length === 0 ? undefined : r;
      },
    },
  });
  if (code !== 0) {
    throw new CommandError('', passthroughExitCode(code));
  }
}
