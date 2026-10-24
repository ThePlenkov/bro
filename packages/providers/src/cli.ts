/**
 * The `cli` provider binding — a bare command template as a prose call
 * (spec: specs/bro-ribc.1.md §cli, milestone 6). The contract is
 * loop.agent's generalized: `{promptFile}` expands to `"$1"` — the path
 * of a temp file holding the prompt travels as a positional arg, never
 * inside the command line (appended as the last arg when the template
 * doesn't name it). The expanded line runs under `sh -c`, the process
 * exits, and stdout IS the answer — the consumer (the judge's
 * proseDecide) prompt-and-parses it, so a cli answer is always
 * prose-grade. The spawn surface is the fleet connector's template
 * worker over the same entry.command — this file is the call surface.
 *
 * `by` is the caller's provenance stamp (`provider:<name>`); config
 * bugs (a command sh can't find, an empty template) throw plain
 * errors — a misconfigured provider is a startup error, not a backend
 * outage.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliCommandModel, JudgeUnavailable } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { remaining } from './http.ts'
import type { ProviderChat, ProviderChatResult } from './registry.ts'
import type { ProviderWireOpts } from './systemone.ts'

type CliEntry = Extract<ProviderEntry, { type: 'cli' }>

/** The caller's config bug — a command that can't run at all is a
 *  startup error, never wrapped into JudgeUnavailable. */
class CliConfigError extends Error {
  override name = 'CliConfigError'
}

/** The loop.agent expansion contract — `{promptFile}` becomes `"$1"`;
 *  no placeholder → `"$1"` appends as the last arg. The path itself rides
 *  the positional arg `runTemplate` passes to `sh -c` — nothing derived
 *  from the file's name is ever concatenated into the command line, so
 *  no quoting is needed at all (the same "$1" positional exec the native
 *  agent connector uses). Kept local: expandAgentCmd lives in
 *  @broject/loop and the providers package must not grow a dep edge on
 *  the loop for seven lines of expansion. */
export function expandPromptFile(command: string): string {
  if (command.includes('{promptFile}')) {
    // fn replacer — keeps the substitution literal whatever it becomes
    return command.replaceAll('{promptFile}', () => '"$1"')
  }
  return `${command} "$1"`
}

/** One `sh -c` round-trip under the caller's budget — an expired
 *  deadline or a timed-out process is JudgeUnavailable (fail-open);
 *  exit 127 names the config bug (the command isn't there); any other
 *  non-zero exit is availability — the command ran and failed, the
 *  stderr tail says why. */
function runTemplate(by: string, command: string, promptFile: string, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const left = remaining(deadline)
    if (left <= 0) {
      reject(new JudgeUnavailable(`${by} (cli) timed out — budget spent`))
      return
    }
    // operator-configured provider command (same contract as
    // loop.agent / agents.*.command everywhere: PATH lookup, sh -c).
    // `bro-cli` becomes $0; the prompt file is $1 — argv, not the line.
    const child = spawn('sh', ['-c', command, 'bro-cli', promptFile], { stdio: ['ignore', 'pipe', 'pipe'] }) // NOSONAR — operator-authored command template; the prompt path rides argv
    const out: Buffer[] = []
    let tail = ''
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-2048)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new JudgeUnavailable(`${by} (cli) timed out`))
    }, left)
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(new CliConfigError(`${by}: cannot exec cli command — ${e.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const stderr = tail.trim()
      const detail = stderr === '' ? '' : ` — ${stderr}`
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'))
      } else if (code === 127) {
        reject(new CliConfigError(`${by}: cli command not found${detail}`))
      } else {
        reject(new JudgeUnavailable(`${by} (cli) exited ${code}${detail}`))
      }
    })
  })
}

/** The raw prose call surface for a `cli` entry — the prompt written
 *  to a private (0700) temp file, `{promptFile}` expanded, stdout back.
 *  `model` reports the pin the user declared (or 'unknown' unpinned) —
 *  and only models the command can actually run: an override reaches
 *  the process through `{model}` or the call refuses to relabel. */
export function cliChat(
  by: string,
  entry: CliEntry,
  opts: ProviderWireOpts = {}
): ProviderChat {
  const { command, model } = cliCommandModel(
    entry.command,
    entry.model,
    opts.model,
    (m) =>
      new CliConfigError(
        `${by}: cli command cannot honor model '${m}' — it has no {model} placeholder`
      ),
    () => new CliConfigError(`${by}: cli command uses {model} but no model is pinned`)
  )
  const reported = model ?? 'unknown'
  return async (prompt, deadline): Promise<ProviderChatResult> => {
    // mkdtemp gives a 0700 dir — the prompt file never lands world-readable
    const dir = mkdtempSync(join(tmpdir(), 'bro-cli-'))
    try {
      const promptFile = join(dir, 'prompt.md')
      writeFileSync(promptFile, prompt)
      const content = await runTemplate(by, expandPromptFile(command), promptFile, deadline)
      return { content, model: reported }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
