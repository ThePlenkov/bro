/**
 * `bro acp-worker` — the acp provider's spawn unit (spec bro-5hx1.1 §7).
 * Hidden: a backend's resolved spawn builds `bro acp-worker --command
 * <cmd> [--model m] [--auto-approve] <promptFile>` and execs it — the
 * driver IS the registered worker, so backend pid/exit/log semantics
 * apply to it directly. The ACP session id is diagnostic only; the
 * fleet's own registry identity stands.
 */
import { CommandError, EXIT, patchAgentRegistry } from '@broject/core';
import { flag, positionals } from './args.ts';
import { readFileSync } from 'node:fs';

/** MCP server descriptors reach the worker as a FILE, never inline on
 *  argv — a stdio server's `env` credentials would be world-readable in
 *  ps/procfs. Spawned workers get the path via the BRO_MCP_FILE pin;
 *  `--mcp-servers-file` is the same contract for a manual run. */
function mcpServersFromFile(argv: string[]): unknown[] | undefined {
  const mcpFile = flag(argv, '--mcp-servers-file') ?? process.env.BRO_MCP_FILE;
  if (mcpFile === undefined || mcpFile === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpFile, 'utf8'));
  } catch (err) {
    // SyntaxError text can quote the offending source slice — the file
    // carries env credentials, so a parse failure must never echo
    // parser details into an aggregated stderr log.
    throw new CommandError(
      `bro acp-worker: cannot read MCP servers file ${mcpFile} — ${err instanceof SyntaxError ? 'invalid JSON' : err instanceof Error ? err.message : String(err)}`,
      EXIT.usage
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CommandError(
      `bro acp-worker: MCP servers file ${mcpFile} must contain a JSON array`,
      EXIT.usage
    );
  }
  return parsed;
}

export async function runAcpWorkerCommand(argv: string[]): Promise<void> {
  const command = flag(argv, '--command');
  const model = flag(argv, '--model');
  const autoApprove = argv.includes('--auto-approve');
  const sessionRm = flag(argv, '--session-rm');
  const mcpServers = mcpServersFromFile(argv);
  const pos = positionals(
    argv,
    new Set(['--command', '--model', '--session-rm', '--mcp-servers-file'])
  );
  if (command === undefined || pos.length !== 1) {
    throw new CommandError(
      'usage: bro acp-worker --command <cmd> [--model <m>] [--auto-approve] [--session-rm <tmpl>] [--mcp-servers-file <path>] <promptFile>',
      EXIT.usage
    );
  }
  const promptFile = pos[0]!;
  const { runAcpWorker } = await import('@broject/providers');
  const molStep = process.env.BRO_BEAD_ID;
  const code = await runAcpWorker({
    command,
    model,
    autoApprove,
    sessionRm,
    mcpServers,
    promptFile,
    cwd: process.cwd(),
    provider: process.env.BRO_AGENT_PROVIDER,
    // provenance the driver learns post-spawn (session id, the model
    // the agent reports) merges back into the backend's registry row.
    // Advisory: a registry miss must never fail the worker.
    record:
      molStep === undefined
        ? undefined
        : patch => {
            try {
              patchAgentRegistry(process.cwd(), molStep, patch);
            } catch {
              // advisory
            }
          },
  });
  if (code !== 0) {
    throw new CommandError('', code as any);
  }
}
