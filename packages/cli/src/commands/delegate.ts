/**
 * `bro fleet delegate` — agent A activates agent B (spec bro-z8tng).
 *
 *   bro fleet delegate [prompt…] [--prompt <text>] [--prompt-file <file>]
 *                     [--provider <name> | --class <name>] [--model <m>]
 *                     [--wait [--timeout <sec>] | --detach [--connector <name>]
 *                      [--worktree <path>] [--auto-approve]] [--beads-dir <dir>]
 *                     [--json]
 *
 * One contract, two modes: --wait is the synchronous short ask — one
 * pooled ACP turn on a providers.<name> acp entry, text + provenance
 * back, no registry entry. --detach is real work — the same registry
 * spawn `bro agents run` takes (routing, walls, fleet.maxConcurrent,
 * session quotas, claim artifacts), returning an agentId. The caller's
 * BRO_AGENT_ID rides as delegatedBy provenance on both.
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  BATCH_MARKER_ENV,
  hasHelpFlag,
  printUsage,
  resolveStepClass,
  SpawnError,
  wallText,
  type AgentInfo,
  type ExitCode,
  type ResolvedClass,
} from '@broject/core'
import {
  acpOpen,
  acpPooledTurn,
  type AcpSeam,
  type FetchFn,
  type ProviderWireOpts,
} from '@broject/providers'
import { beadsDir } from '@broject/convoy'
import { flag, positionals } from './args.ts'
import {
  loadAgentEnv,
  providerWallsFor,
  type AgentConnectorEnv,
} from '../agent-connectors.ts'
import { SpawnInputError, spawnStepAgent } from './agents.ts'

const DEFAULT_TIMEOUT_SEC = 120

function usage(exitCode: ExitCode = 2): never {
  printUsage(`usage:
  bro fleet delegate [prompt…] [--prompt <text>] [--prompt-file <file>]
              [--provider <name> | --class <name>] [--model <m>]
              [--wait [--timeout <sec>] | --detach [--connector <name>]
               [--worktree <path>] [--auto-approve]] [--beads-dir <dir>]
              [--json]
              --wait (default) asks another agent synchronously: one
              pooled ACP turn against the resolved providers.<name> acp
              entry — the reply text lands on stdout, --json adds
              provider/model/stopReason provenance. --detach does real
              work: the registry spawn 'bro agents run' takes (routing,
              walls, fleet cap, quotas), returning the new agentId. The
              caller's BRO_AGENT_ID rides as delegatedBy provenance on
              both — 'agent A activates agent B' is auditable.`, exitCode)
}

// a function declaration — tsc only treats calls to never-returning
// declarations as terminating the control flow (same convention as
// agents.ts's die)
function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** The mode-independent request — the CLI parser and the plane's
 *  exec('delegate') args map onto this one shape. */
export interface DelegateRequest {
  prompt?: string
  promptFile?: string
  /** 'wait' (default) = pooled ACP turn; 'detach' = registry spawn. */
  mode?: 'wait' | 'detach'
  provider?: string
  class?: string
  model?: string
  /** --wait deadline seconds (default 120). */
  timeoutSec?: number
  connector?: string
  worktree?: string
  autoApprove?: boolean
  /** agentId of the asking agent — CLI defaults it from the caller's
   *  BRO_AGENT_ID pin; the MCP caller may declare its own. */
  delegatedBy?: string
  beadsDir?: string
}

export interface DelegateWaitResult {
  mode: 'wait'
  provider: string
  model: string
  class?: string
  stopReason: string
  text: string
  delegatedBy?: string
}

export interface DelegateDetachResult {
  mode: 'detach'
  delegatedBy?: string
  agent: AgentInfo
}

export type DelegateResult = DelegateWaitResult | DelegateDetachResult

/** The prompt text the request carries — --prompt and --prompt-file
 *  are the same channel (mutually exclusive), whitespace-only is no
 *  prompt at all. */
function delegatePrompt(req: DelegateRequest): string {
  if (req.prompt !== undefined && req.promptFile !== undefined) {
    throw new SpawnInputError('prompt and promptFile are mutually exclusive')
  }
  let text = req.prompt
  if (text === undefined) {
    if (req.promptFile === undefined) {
      throw new SpawnInputError('delegate requires a prompt — --prompt <text> or --prompt-file <file>')
    }
    if (!existsSync(req.promptFile)) {
      throw new SpawnInputError(`prompt file ${req.promptFile} does not exist`)
    }
    text = readFileSync(req.promptFile, 'utf8')
  }
  if (text.trim() === '') {
    throw new SpawnInputError('prompt must not be empty')
  }
  return text
}

/** Shared provider/lane resolution: --provider pins directly, --class
 *  names a fleet.routing lane whose chain[0] supplies provider (+model);
 *  an unclassed request falls to the 'default' lane when routing is
 *  declared. undefined when no routing is declared and no provider is
 *  pinned — --wait refuses, --detach spawns provider-less like `bro
 *  agents run`. */
function routedLane(env: AgentConnectorEnv, req: DelegateRequest): ResolvedClass | undefined {
  if (req.provider !== undefined && req.class !== undefined) {
    throw new SpawnInputError('--provider and --class are mutually exclusive')
  }
  const routing = env.fleet?.routing
  const providers = env.providers ?? {}
  if (routing === undefined || Object.keys(routing).length === 0) {
    if (req.class !== undefined) {
      throw new SpawnInputError('--class names a fleet.routing lane — no fleet.routing is declared')
    }
    return undefined
  }
  // a delegate spawn/ask has no bead to read a class: label off — the
  // phantom molStep is minted per request, so the lane resolves the
  // same way routeStepClass would for a label-less step
  return resolveStepClass(routing, providers, { class: req.class })
}

/** --wait — one pooled ACP turn. Provider walls refuse first: a
 *  delegate turn is automated spend, not the interactive lane. The
 *  peer is per-request (no pool to keep warm across CLI invocations)
 *  and always closes — the 'exit' hook covers a mid-turn kill so the
 *  acp child can never orphan. */
async function delegateWait(
  dir: string,
  env: AgentConnectorEnv,
  req: DelegateRequest,
  routed: ResolvedClass | undefined,
  prompt: string,
  opts: { fetch?: FetchFn; acp?: AcpSeam }
): Promise<DelegateWaitResult> {
  const providers = env.providers ?? {}
  const name = req.provider ?? routed?.provider
  if (name === undefined) {
    throw new SpawnInputError(
      'delegate --wait needs a provider — pass --provider <name> or declare fleet.routing.<class>.chain'
    )
  }
  const entry = providers[name]
  if (entry === undefined) {
    throw new SpawnError(
      `providers.${name} is not configured`,
      req.provider !== undefined ? 'input' : 'config'
    )
  }
  if (entry.type !== 'acp') {
    throw new SpawnError(
      `providers.${name} (type '${entry.type}') cannot serve a delegate turn — --wait needs an 'acp' provider`,
      'config'
    )
  }
  // walls live in the repo registry — a non-repo dir simply has none
  const walls = ((): ReturnType<typeof providerWallsFor> => {
    try {
      return providerWallsFor(dir)
    } catch {
      return []
    }
  })()
  const wall = walls.find((w) => w.provider === name)
  if (wall !== undefined) {
    throw new SpawnError(
      `${wallText(wall)} — the delegate lane waits; retry after the reset or --detach to a different lane`,
      'cap'
    )
  }
  const timeoutSec = req.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new SpawnInputError('--timeout must be a positive number of seconds')
  }
  const deadline = Date.now() + timeoutSec * 1000
  // --model is the request pin: it outranks the chain's and the
  // entry's configured model but the reported model stays honest
  // (resolveTurnModel reports what the agent actually runs)
  const model = req.model ?? (req.provider === undefined ? routed?.model : undefined)
  const wire: ProviderWireOpts = {
    model,
    acp: { ...opts.acp, cwd: opts.acp?.cwd ?? dir },
  }
  const peer = await acpOpen(`delegate:${name}`, entry, wire, deadline)
  const onExit = (): void => peer.close()
  process.once('exit', onExit)
  try {
    const r = await acpPooledTurn(peer, entry, wire, prompt, deadline, {
      by: 'delegate',
      requestModel: req.model,
      signal: opts.acp?.signal,
      onUpdate: opts.acp?.onUpdate,
    })
    return {
      mode: 'wait',
      provider: name,
      model: r.model,
      ...(routed?.class !== undefined ? { class: routed.class } : {}),
      stopReason: r.stopReason,
      text: r.text,
      ...(req.delegatedBy !== undefined ? { delegatedBy: req.delegatedBy } : {}),
    }
  } finally {
    process.removeListener('exit', onExit)
    peer.close()
  }
}

/** The delegate contract — both CLI and the agents plane's
 *  exec('delegate') run it. Throws SpawnInputError on bad input,
 *  SpawnError on refusal/config/availability — callers render. */
export async function delegate(
  dir: string,
  env: AgentConnectorEnv,
  req: DelegateRequest,
  opts: { fetch?: FetchFn; acp?: AcpSeam } = {}
): Promise<DelegateResult> {
  const mode = req.mode ?? 'wait'
  const delegatedBy = req.delegatedBy ?? (process.env.BRO_AGENT_ID?.trim() || undefined)
  const routed = routedLane(env, req)
  if (mode === 'wait') {
    return delegateWait(dir, env, req, routed, delegatePrompt(req), opts)
  }
  // detach — the same spawn 'bro agents run' resolves: routing, walls,
  // fleet.maxConcurrent, session quotas and the claim artifacts all
  // ride spawnStepAgent. BRO_BATCH marks the fleet's lane (wall refusal
  // + batch budget); delegatedBy stamps via the spec's provenance pin.
  const molStep = `adhoc-${randomBytes(4).toString('hex')}`
  const agent = await spawnStepAgent(
    dir,
    env,
    {
      molStep,
      connector: req.connector,
      worktree: req.worktree,
      prompt: req.prompt,
      promptFile: req.promptFile,
      beadsDir: req.beadsDir ?? beadsDir(),
      provider: req.provider,
      model: req.model,
      class: req.class,
      autoApprove: req.autoApprove,
      delegatedBy,
      env: { [BATCH_MARKER_ENV]: '1' },
    },
    opts
  )
  return {
    mode: 'detach',
    ...(delegatedBy !== undefined ? { delegatedBy } : {}),
    agent,
  }
}

export async function runDelegateCommand(
  argv: string[],
  opts: { fetch?: FetchFn; acp?: AcpSeam } = {}
): Promise<void> {
  if (hasHelpFlag(argv)) {
    usage(0)
  }
  const dir = process.cwd()
  const pos = positionals(
    argv,
    new Set([
      '--prompt',
      '--prompt-file',
      '--provider',
      '--class',
      '--model',
      '--timeout',
      '--connector',
      '--worktree',
      '--beads-dir',
    ])
  )
  const wait = argv.includes('--wait')
  const detach = argv.includes('--detach')
  if (wait && detach) {
    die('--wait and --detach are mutually exclusive')
  }
  const mode: 'wait' | 'detach' = detach ? 'detach' : 'wait'
  const promptFlag = flag(argv, '--prompt')
  if (promptFlag !== undefined && pos.length > 0) {
    die('positional text and --prompt are the same channel — pick one')
  }
  const timeoutRaw = flag(argv, '--timeout')
  if (mode !== 'wait' && timeoutRaw !== undefined) {
    die('--timeout only applies to --wait')
  }
  if (mode !== 'detach' && (argv.includes('--auto-approve') || flag(argv, '--connector') !== undefined || flag(argv, '--worktree') !== undefined)) {
    die('--connector, --worktree and --auto-approve only apply to --detach')
  }
  const timeoutSec = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
  if (timeoutRaw !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec! <= 0)) {
    die('--timeout must be a positive number of seconds')
  }
  const req: DelegateRequest = {
    prompt: promptFlag ?? (pos.length > 0 ? pos.join(' ') : undefined),
    promptFile: flag(argv, '--prompt-file'),
    mode,
    provider: flag(argv, '--provider'),
    class: flag(argv, '--class'),
    model: flag(argv, '--model'),
    timeoutSec,
    connector: flag(argv, '--connector'),
    worktree: flag(argv, '--worktree'),
    autoApprove: argv.includes('--auto-approve') ? true : undefined,
    beadsDir: flag(argv, '--beads-dir'),
  }
  let result: DelegateResult
  try {
    result = await delegate(dir, loadAgentEnv(dir), req, opts)
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (result.mode === 'wait') {
    // the reply IS the output — provenance rides stderr so a pipeline
    // consumer never parses badge text out of the answer
    console.error(
      `provider ${result.provider} · model ${result.model}` +
        `${result.class === undefined ? '' : ` · class ${result.class}`} · ${result.stopReason}`
    )
    console.log(result.text)
    return
  }
  const info = result.agent
  const pid = info.pid === undefined ? '' : ` pid ${info.pid}`
  console.log(`agent ${info.id} ${info.state} for ${info.molStep} (${info.backend}${pid})`)
  if (result.delegatedBy !== undefined) {
    console.log(`  delegatedBy: ${result.delegatedBy}`)
  }
  if (info.provider !== undefined) {
    console.log(`  provider: ${info.provider}${info.model === undefined ? '' : ` · model ${info.model}`}`)
  }
  if (info.log !== undefined) {
    console.log(`  log: ${info.log}`)
  }
  if (info.worktree !== undefined) {
    console.log(`  worktree: ${info.worktree}`)
  }
}
