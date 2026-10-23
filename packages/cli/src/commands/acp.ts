/**
 * `bro acp proxy -- <agent cmd>` — the cascading ACP edge (specs
 * bro-rs8sp.md, bro-bhyo1.md). bro sits on the ACP wire: the client
 * (Zed, JetBrains, Neovim, `devin acp`, `kilo acp`) talks ACP to this
 * process's stdin/stdout; bro spawns the downstream agent from the
 * argv tail and forwards everything verbatim — except the session's
 * first `session/prompt`, which carries the hook seam's session-start
 * + prompt-submit context as one prepended text block.
 *
 * The seam is the same code `bro hooks` runs — collectSessionContext /
 * collectPromptContext as library calls keyed on `session/new`'s cwd,
 * never a subprocess and never the proxy's own cwd.
 */
import { collectPromptContext, collectSessionContext } from './hooks.ts'

const USAGE = 'usage: bro acp proxy -- <agent cmd…>'

function usage(line: string): never {
  console.error(line)
  console.error(USAGE)
  process.exit(2)
}

export async function runAcpCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub !== 'proxy') {
    usage(`error: unknown subcommand '${sub ?? ''}'`)
  }
  const sep = rest.indexOf('--')
  // `--` is mandatory — the tail is the successor's argv, tokenized
  // verbatim and exec'd without a shell; without the separator a
  // downstream flag could be misread as ours
  if (sep === -1) {
    usage('error: `proxy` requires `--` before the agent command')
  }
  const command = rest.slice(sep + 1)
  if (command.length === 0) {
    usage('error: empty agent command after `--`')
  }
  const { runAcpProxy } = await import('@broject/providers')
  const code = await runAcpProxy(command, {
    seam: {
      sessionContext: async (cwd, sessionId) => {
        const r = await collectSessionContext(cwd, sessionId)
        return r.lines.length === 0 ? undefined : r.lines.join('\n')
      },
      promptContext: async (cwd, sessionId, prompt) => {
        const r = await collectPromptContext(cwd, sessionId, prompt)
        return r.lines.length === 0 ? undefined : r.lines.join('\n')
      },
    },
  })
  process.exit(code)
}
