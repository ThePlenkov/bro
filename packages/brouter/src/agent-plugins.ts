/**
 * The agent surface — ask an agent, speak ACP.
 *
 * Two commands, one theme: the PROTOCOL clients of the served catalog —
 * they drive an agent through the router's lanes. (Configuring a thin
 * client — Claude Code's model block — is `@broject/client-adapters`,
 * mounted beside these under `bro router`.)
 *
 * Every command keeps its own pieces in its own function: the request it
 * builds, the outcome it reports. A plugin that does both in one closure
 * is a plugin whose complexity nobody can name.
 */
import { type CommandPlugin, definePlugin } from '@broject/command';
import { explainSlicesOrExit, flag, positionals, renderExplanation } from '@broject/core';
import { runAcpFacade } from './acp.ts';
import { runAsk } from './ask.ts';
import { BOOL_FLAGS, VALUE_FLAGS } from './policy.ts';
import { formulaPath, routeTablePath } from './routes-cmd.ts';

/** The lane flags every agent command reads — the provider, the model and
 *  the budget. */
interface LaneFlags {
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

/** The lane flags — the provider, the model, the budget. */
function laneFlags(argv: string[]): LaneFlags {
  const flags: LaneFlags = {};
  const provider = flag(argv, '--provider');
  if (provider !== undefined) {
    flags.provider = provider;
  }
  const model = flag(argv, '--model');
  if (model !== undefined) {
    flags.model = model;
  }
  const timeout = flag(argv, '--timeout');
  if (timeout !== undefined) {
    // the budget is a deadline: a float or a NaN makes every comparison
    // against it false, and the call never times out
    const ms = Number(timeout);
    if (!Number.isInteger(ms) || ms <= 0) {
      console.error('error: --timeout must be a whole number of milliseconds');
      process.exit(2);
    }
    flags.timeoutMs = ms;
  }
  return flags;
}

/** `ask` — one question to an ACP agent, the answer printed. */
function askPlugin(): CommandPlugin {
  return definePlugin({
    name: 'ask',
    summary: 'Ask an ACP agent one question — the answer printed [--explain]',
    run: async argv => {
      const pos = positionals(argv, VALUE_FLAGS, { boolFlags: BOOL_FLAGS });
      const question = pos.join(' ').trim();
      if (question === '') {
        console.error('error: brouter ask needs a question');
        process.exit(2);
      }
      const dir = process.cwd();
      const routes = routeTablePath(dir, argv);
      const formula = formulaPath(dir, argv);
      const slices = explainSlicesOrExit(argv);
      const request = {
        ...laneFlags(argv),
        question,
        ...(routes === undefined ? {} : { routes }),
        ...(formula === undefined ? {} : { formula }),
        // --no-cache bypasses the decision cache for this ask
        // (bro-0ykhg.3) — entries stay, only the consult is skipped
        ...(argv.includes('--no-cache') ? { noCache: true } : {}),
        ...(slices === undefined ? {} : { slices }),
      };
      const outcome = await runAsk(request, dir);
      if (argv.includes('--json')) {
        console.log(JSON.stringify(outcome, null, 2));
        return;
      }
      if (outcome.explanation !== undefined) {
        // stderr — stdout stays the answer, pipeable
        console.error(renderExplanation(outcome.explanation, slices ?? []));
      }
      console.log(outcome.text);
    },
  });
}

/** `acp` — the stdio endpoint in front of a configured agent. */
function acpPlugin(): CommandPlugin {
  return definePlugin({
    name: 'acp',
    summary: 'The ACP endpoint (stdio) in front of a configured agent',
    run: async argv => {
      await runAcpFacade(laneFlags(argv), process.cwd());
    },
  });
}

/** The agent surface — ask, acp. */
export function agentPlugins(): CommandPlugin[] {
  return [askPlugin(), acpPlugin()];
}
