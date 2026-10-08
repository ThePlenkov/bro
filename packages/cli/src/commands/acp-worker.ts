/**
 * `bro acp-worker` — the acp provider's spawn unit (spec bro-5hx1.1 §7).
 * Hidden: a backend's resolved spawn builds `bro acp-worker --command
 * <cmd> [--model m] [--auto-approve] <promptFile>` and execs it — the
 * driver IS the registered worker, so backend pid/exit/log semantics
 * apply to it directly. The ACP session id is diagnostic only; the
 * fleet's own registry identity stands.
 */
import { flag, positionals } from './args.ts'
import { patchAgentRegistry } from '@broject/core'

export async function runAcpWorkerCommand(argv: string[]): Promise<void> {
  const command = flag(argv, '--command')
  const model = flag(argv, '--model')
  const autoApprove = argv.includes('--auto-approve')
  const sessionRm = flag(argv, '--session-rm')
  const pos = positionals(argv, new Set(['--command', '--model', '--session-rm']))
  if (command === undefined || pos.length !== 1) {
    console.error(
      'usage: bro acp-worker --command <cmd> [--model <m>] [--auto-approve] [--session-rm <tmpl>] <promptFile>'
    )
    process.exit(2)
  }
  const promptFile = pos[0]!
  const { runAcpWorker } = await import('@broject/providers')
  const molStep = process.env.BRO_BEAD_ID
  const code = await runAcpWorker({
    command,
    model,
    autoApprove,
    sessionRm,
    promptFile,
    cwd: process.cwd(),
    provider: process.env.BRO_AGENT_PROVIDER,
    // provenance the driver learns post-spawn (session id, the model
    // the agent reports) merges back into the backend's registry row.
    // Advisory: a registry miss must never fail the worker.
    record:
      molStep === undefined
        ? undefined
        : (patch) => {
            try {
              patchAgentRegistry(process.cwd(), molStep, patch)
            } catch {
              // advisory
            }
          },
  })
  process.exit(code)
}
