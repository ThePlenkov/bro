/**
 * The client-side terminal plane (ACP `terminal/*`) — the agent's commands
 * run as host-side children whose output stays pollable: the visible task
 * a host renders instead of an opaque in-agent spawn. One registry per
 * connection; `dispose()` on transport close so leaked terminals die
 * with it (spec: specs/bro-z7afs.md).
 */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
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
  /** Raw bytes — a multi-byte character split across pipe chunks
   *  reassembles whole here; `terminal/output` decodes utf8 at read
   *  time so `outputByteLimit` is honored in bytes, not UTF-16 units. */
  out: Buffer
  truncated: boolean
  exitStatus: TerminalExitStatus | null
  /** Set once output is final — 'close' fired, the orphan grace elapsed,
   *  or the spawn errored. wait_for_exit resolves early only against
   *  this, so a waiter never returns ahead of the last buffered bytes. */
  completed: boolean
  waiters: Array<(status: TerminalExitStatus) => void>
  /** Fallback flush after 'exit' when 'close' lags — a grandchild
   *  inheriting the stdout pipe holds 'close' until IT dies, which can
   *  be minutes after the command itself exited. */
  closeTimer?: ReturnType<typeof setTimeout>
  limit: number
  /** Live taps (bro-eua0d) — the serve SSE route subscribes through
   *  `follow`. `decoder` folds split multi-byte characters across pipe
   *  chunks so a live `data` never surfaces a U+FFFD boundary. */
  listeners: Set<TerminalFollower>
  decoder: StringDecoder
}

/** A follower's taps — `data` per appended chunk (utf8), `exit` once
 *  when the entry goes final. Followers are observers: a throwing tap
 *  is the consumer's bug, not the terminal's. */
export interface TerminalFollower {
  data(chunk: string): void
  exit(status: TerminalExitStatus): void
}

/** The atomic snapshot+stream a follow route needs — `snapshot` is the
 *  buffer at registration (no gap, no replay), `stop` drops the taps
 *  without touching the terminal. */
export interface TerminalFollow {
  snapshot: TerminalOutputResponse
  stop(): void
}

/** Grace between 'exit' and a still-pending 'close' before waiters
 *  resolve anyway — long enough for buffered pipe data to flush, short
 *  enough that an orphaned writer never hangs wait_for_exit. */
const ORPHAN_CLOSE_GRACE_MS = 500

/** Agent-supplied env merges over the host env but may not hijack it —
 *  a compromised agent sending `NODE_OPTIONS=--require …` or its own
 *  `PATH` would inject code into every child we spawn (CWE-78). These
 *  names are dropped from the agent's list, silently. */
const ENV_DENYLIST: ReadonlySet<string> = new Set([
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'IFS',
  'PROMPT_COMMAND',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GIT_EXEC_PATH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
])

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
      if (!ENV_DENYLIST.has(e.name)) {
        env[e.name] = e.value
      }
    }
    const child = spawn(ctx.params.command, ctx.params.args ?? [], {
      cwd: ctx.params.cwd ?? undefined,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const entry: TerminalEntry = {
      child,
      out: Buffer.alloc(0),
      truncated: false,
      exitStatus: null,
      completed: false,
      waiters: [],
      limit: ctx.params.outputByteLimit ?? this.defaultLimit,
      listeners: new Set(),
      decoder: new StringDecoder('utf8'),
    }
    const settle = (exitCode: number | null, signal: string | null): void => {
      entry.exitStatus ??= { exitCode, signal }
    }
    const append = (d: Buffer): void => {
      let buf = Buffer.concat([entry.out, d])
      if (buf.length > entry.limit) {
        // keep the last `limit` bytes — a cut mid-character lands on a
        // UTF-8 continuation byte (10xxxxxx); skip forward so retained
        // output never starts with a partial character
        let start = buf.length - entry.limit
        while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
          start++
        }
        buf = buf.subarray(start)
        entry.truncated = true
      }
      entry.out = buf
      const text = entry.decoder.write(d)
      if (text !== '') {
        for (const l of entry.listeners) {
          try {
            l.data(text)
          } catch {
            // a broken follower is an observer bug, not the terminal's
          }
        }
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (err) => {
      append(Buffer.from(`\n[terminal spawn error: ${err.message}]\n`))
      settle(null, null)
      this.flushEntry(entry)
    })
    // Two-stage settle: 'exit' carries the status (the command completed),
    // 'close' carries output completeness — exit fires while piped data is
    // still buffered. Waiters flush on close, or on exit + grace when an
    // orphaned writer holds the pipe open past the command's death.
    child.once('exit', (exitCode, signal) => {
      settle(exitCode, signal)
      entry.closeTimer = setTimeout(() => this.flushEntry(entry), ORPHAN_CLOSE_GRACE_MS)
    })
    child.once('close', (exitCode, signal) => {
      settle(exitCode, signal)
      clearTimeout(entry.closeTimer)
      this.flushEntry(entry)
    })
    const terminalId = randomUUID() as TerminalId
    this.entries.set(terminalId, entry)
    return { terminalId }
  }

  /** The retained tail plus the exit status — the `terminal/output`
   *  wire shape, also the serve route's plain-GET answer. */
  snapshot(id: TerminalId): TerminalOutputResponse {
    const entry = this.get(id)
    return {
      output: entry.out.toString('utf8'),
      truncated: entry.truncated,
      exitStatus: entry.exitStatus,
    }
  }

  /** Snapshot + live taps in one registration — the return IS the
   *  buffer at tap time, so a chunk can't slip between the read and
   *  the subscribe. A completed terminal still follows: the snapshot
   *  carries its exitStatus and no events fire (the id stays valid
   *  until release, per the wire contract). */
  follow(id: TerminalId, listener: TerminalFollower): TerminalFollow {
    const entry = this.get(id)
    if (!entry.completed) {
      entry.listeners.add(listener)
    }
    return {
      snapshot: this.snapshot(id),
      stop: () => entry.listeners.delete(listener),
    }
  }

  /** Live count — the serve snapshot/debug surface. */
  get size(): number {
    return this.entries.size
  }

  readonly output: ClientRequestHandler<TerminalOutputRequest, TerminalOutputResponse> = (
    ctx
  ) => this.snapshot(ctx.params.terminalId)

  readonly waitForExit: ClientRequestHandler<
    WaitForTerminalExitRequest,
    WaitForTerminalExitResponse
  > = (ctx) =>
    new Promise((resolve) => {
      const entry = this.get(ctx.params.terminalId)
      // only `completed` guarantees the buffered output is final —
      // exitStatus alone means 'exit' fired while 'close' (and the last
      // piped bytes) are still pending; resolve against the real status
      if (entry.completed) {
        const status = entry.exitStatus ?? { exitCode: null, signal: null }
        resolve({ exitCode: status.exitCode, signal: status.signal })
        return
      }
      entry.waiters.push((status) =>
        resolve({ exitCode: status.exitCode, signal: status.signal })
      )
    })

  readonly kill: ClientRequestHandler<KillTerminalRequest, void> = (ctx) => {
    this.get(ctx.params.terminalId).child.kill('SIGTERM')
  }

  /** Drain the waiters with the best-known status and mark the entry
   *  final — splice(0) makes a second flush a no-op. Safe to call on an
   *  orphaned entry (post-release/dispose): closures outlive the map. */
  private flushEntry(entry: TerminalEntry): void {
    entry.completed = true
    const status = entry.exitStatus ?? { exitCode: null, signal: null }
    // a trailing partial character flushes out of the decoder before
    // the exit tap — listeners see the terminal's complete output
    const rest = entry.decoder.end()
    if (rest !== '') {
      for (const l of entry.listeners) {
        try {
          l.data(rest)
        } catch {
          // observer rule — same as append
        }
      }
    }
    for (const l of entry.listeners) {
      try {
        l.exit(status)
      } catch {
        // observer rule — same as append
      }
    }
    entry.listeners.clear()
    for (const w of entry.waiters.splice(0)) {
      w(status)
    }
  }

  readonly release: ClientRequestHandler<ReleaseTerminalRequest, void> = (ctx) => {
    const entry = this.get(ctx.params.terminalId)
    // cancel the pending grace flush — the entry leaves the map now, so
    // a late timer would resolve waiters with a synthetic null status
    clearTimeout(entry.closeTimer)
    if (entry.exitStatus === null) {
      // still running: SIGKILL's own 'exit' settles the real status and
      // resolves pending wait_for_exit through the normal path
      entry.child.kill('SIGKILL')
    } else {
      // exited but 'close' may never come — the timer just cleared was
      // the last guaranteed flush; resolve waiters now, on the real status
      this.flushEntry(entry)
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
      // same discipline as release: cancel a pending grace flush so no
      // timer fires post-dispose, and resolve waiters deterministically —
      // live children settle through their own SIGKILL'd 'exit'
      clearTimeout(entry.closeTimer)
      if (entry.exitStatus === null) {
        entry.child.kill('SIGKILL')
      } else {
        this.flushEntry(entry)
      }
    }
    this.entries.clear()
  }
}
