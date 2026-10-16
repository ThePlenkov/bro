/**
 * The client-side terminal plane (ACP `terminal/*`) — the agent's commands
 * run as host-side children whose output stays pollable: the visible task
 * a host renders instead of an opaque in-agent spawn. One registry per
 * connection; `dispose()` on transport close so leaked terminals die
 * with it (spec: specs/bro-z7afs.md).
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type {
  ClientApp,
  ClientRequestHandler,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalExitStatus,
  TerminalId,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'

interface TerminalEntry {
  child: ChildProcess
  out: string
  truncated: boolean
  exitStatus: TerminalExitStatus | null
  waiters: Array<(status: TerminalExitStatus) => void>
  /** Fallback flush after 'exit' when 'close' lags — a grandchild
   *  inheriting the stdout pipe holds 'close' until IT dies, which can
   *  be minutes after the command itself exited. */
  closeTimer?: ReturnType<typeof setTimeout>
  limit: number
}

/** Grace between 'exit' and a still-pending 'close' before waiters
 *  resolve anyway — long enough for buffered pipe data to flush, short
 *  enough that an orphaned writer never hangs wait_for_exit. */
const ORPHAN_CLOSE_GRACE_MS = 500

/** A slice landing mid-surrogate-pair leaves a lone low surrogate at [0]
 *  — drop it so retained output stays valid. */
function tailAtBoundary(s: string, limit: number): string {
  const tail = s.slice(-limit)
  const first = tail.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
}

export class AcpTerminals {
  private readonly entries = new Map<TerminalId, TerminalEntry>()
  /** outputByteLimit is the agent's choice; unbounded buffers on a
   *  runaway command are ours — the cap defaults to 1 MiB. */
  private readonly defaultLimit = 1_048_576

  private get(id: TerminalId): TerminalEntry {
    const entry = this.entries.get(id)
    if (entry === undefined) {
      throw new Error(`Unknown terminal '${id}'`)
    }
    return entry
  }

  readonly create: ClientRequestHandler<CreateTerminalRequest, CreateTerminalResponse> = (
    ctx
  ) => {
    const env = { ...process.env }
    for (const e of ctx.params.env ?? []) {
      env[e.name] = e.value
    }
    const child = spawn(ctx.params.command, ctx.params.args ?? [], {
      cwd: ctx.params.cwd ?? undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const entry: TerminalEntry = {
      child,
      out: '',
      truncated: false,
      exitStatus: null,
      waiters: [],
      limit: ctx.params.outputByteLimit ?? this.defaultLimit,
    }
    const settle = (exitCode: number | null, signal: string | null): void => {
      entry.exitStatus ??= { exitCode, signal }
    }
    const flush = (): void => {
      const status = entry.exitStatus ?? { exitCode: null, signal: null }
      for (const w of entry.waiters.splice(0)) {
        w(status)
      }
    }
    const append = (d: Buffer): void => {
      entry.out += d.toString()
      if (entry.out.length > entry.limit) {
        entry.out = tailAtBoundary(entry.out, entry.limit)
        entry.truncated = true
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (err) => {
      append(Buffer.from(`\n[terminal spawn error: ${err.message}]\n`))
      settle(null, null)
      flush()
    })
    // Two-stage settle: 'exit' carries the status (the command completed),
    // 'close' carries output completeness — exit fires while piped data is
    // still buffered. Waiters flush on close, or on exit + grace when an
    // orphaned writer holds the pipe open past the command's death.
    child.once('exit', (exitCode, signal) => {
      settle(exitCode, signal)
      entry.closeTimer = setTimeout(flush, ORPHAN_CLOSE_GRACE_MS)
    })
    child.once('close', (exitCode, signal) => {
      settle(exitCode, signal)
      clearTimeout(entry.closeTimer)
      flush()
    })
    const terminalId = randomUUID() as TerminalId
    this.entries.set(terminalId, entry)
    return { terminalId }
  }

  readonly output: ClientRequestHandler<TerminalOutputRequest, TerminalOutputResponse> = (
    ctx
  ) => {
    const entry = this.get(ctx.params.terminalId)
    return {
      output: entry.out,
      truncated: entry.truncated,
      exitStatus: entry.exitStatus,
    }
  }

  readonly waitForExit: ClientRequestHandler<
    WaitForTerminalExitRequest,
    WaitForTerminalExitResponse
  > = (ctx) =>
    new Promise((resolve) => {
      const entry = this.get(ctx.params.terminalId)
      if (entry.exitStatus !== null) {
        resolve({ exitCode: entry.exitStatus.exitCode, signal: entry.exitStatus.signal })
        return
      }
      entry.waiters.push((status) =>
        resolve({ exitCode: status.exitCode, signal: status.signal })
      )
    })

  readonly kill: ClientRequestHandler<KillTerminalRequest, void> = (ctx) => {
    this.get(ctx.params.terminalId).child.kill('SIGTERM')
  }

  readonly release: ClientRequestHandler<ReleaseTerminalRequest, void> = (ctx) => {
    const entry = this.get(ctx.params.terminalId)
    if (entry.exitStatus === null) {
      entry.child.kill('SIGKILL')
    }
    this.entries.delete(ctx.params.terminalId)
  }

  register(app: ClientApp): ClientApp {
    return app
      .onRequest('terminal/create', this.create)
      .onRequest('terminal/output', this.output)
      .onRequest('terminal/release', this.release)
      .onRequest('terminal/kill', this.kill)
      .onRequest('terminal/wait_for_exit', this.waitForExit)
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.child.kill('SIGKILL')
    }
    this.entries.clear()
  }
}
