/**
 * `bro pulse` — the session-owned metronome (bro-ijffz; spec
 * specs/bro-pulse.md). A long-lived child: every S seconds it ticks —
 * prints the beat to stdout and, as the `pulse.lock` holder, drops it
 * into the session mailbox. Each mail is the session's wake: a
 * background child's exit reaches no one, so the tick's drop is the
 * only inbound channel that lands mid-turn.
 *
 *   bro pulse [S]                     metronome — beat every S seconds
 *                                     (default watch.intervalSec)
 *   bro pulse [S] --notify            mail each beat as the lock holder
 *                                     (default — the wake channel)
 *   bro pulse [S] --no-notify         stdout liveness only, no drops
 *   bro pulse [S] --json              one structured object per beat
 *   bro pulse [S] -- <cmd>…           the tick is <cmd> instead of the
 *                                     watch snapshot — a failing probe
 *                                     never kills the beat
 *
 * `pulse.lock` arbitrates the MAILER role, never the tick: the pulse
 * try-acquires it (zero wait budget, heartbeated while held, retried
 * each beat). The holder mails; a non-holder still prints every beat —
 * 'standing by' silence is banned (a dead-looking watchdog is worse
 * than none). The holder's heartbeat is also `pulseLive()`'s read, so
 * a live pulse keeps the `pulseRearm` checkpoint quiet; when the
 * holder dies the checkpoint respawns the unattended leg
 * (`bro watch --every --for --notify`).
 *
 * `pulse.json` is armed on every start (`armPulse(dir, S)`) — the
 * durable want-marker that carries the session's cadence across
 * restarts. Orchestrator-only: refuses under BRO_AGENT_ID, the same
 * guard `bro watch --every` carries — workers never arm the cadence.
 * Usable anywhere: outside a repo there is no marker/lock/mailbox, the
 * warnings say so once, and the metronome still beats.
 */
import { spawnSync } from 'node:child_process'
import { dropMailbox, holdFileLock, loadConfig, LockTimeout, mailboxDir } from '@broject/core'
import { positionals } from './args.ts'
import { MAX_INTERVAL_SEC, MIN_INTERVAL_SEC } from './drive-config.ts'
import { writeHeartbeat } from './watch-heartbeat.ts'
import { tickOnce } from './watch.ts'
import { watchSection, type WatchConfig } from './watch-config.ts'
import { armPulse, isOrchestratorSession, pulseLockPath } from './watch-pulse.ts'

export interface PulseArgs {
  /** Tick cadence in seconds — undefined means `watch.intervalSec`. */
  sec?: number
  notify: boolean
  json: boolean
  /** Everything after `--` — the per-tick probe command, verbatim. */
  cmd: string[]
}

const BOOL_FLAGS = new Set(['--notify', '--no-notify', '--json'])

/** `bro pulse [S] [flags] [-- <cmd>…]` — S is the only positional;
 *  everything after `--` is the probe command, never parsed. Unknown
 *  flags fail loudly (strict) — a typo'd `--notfy` must not silently
 *  disarm the wake channel. */
export function pulseArgs(argv: string[]): PulseArgs {
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)
  const cmd = sep === -1 ? [] : argv.slice(sep + 1)
  if (sep !== -1 && cmd.length === 0) {
    throw new Error("a trailing '--' needs a command after it")
  }
  rejectUnknownFlags(head)
  const pos = positionals(head, new Set(), { boolFlags: BOOL_FLAGS })
  if (pos.length > 1) {
    throw new Error(`bro pulse takes at most one <seconds> — got ${pos.join(' ')}`)
  }
  if (head.includes('--notify') && head.includes('--no-notify')) {
    throw new Error('--notify and --no-notify conflict')
  }
  return {
    sec: pos.length === 1 ? parsePulseSec(pos[0]!) : undefined,
    notify: !head.includes('--no-notify'),
    json: head.includes('--json'),
    cmd,
  }
}

// an unknown flag fails loudly as a usage error — a typo'd `--notfy`
// must not silently disarm the wake channel. Thrown, not
// positionals' strict exit, so the parse stays testable in-process.
function rejectUnknownFlags(head: string[]): void {
  for (const a of head) {
    if (!a.startsWith('--')) {
      continue
    }
    const name = a.split('=', 1)[0]!
    if (!BOOL_FLAGS.has(name)) {
      throw new Error(`unknown option ${name}`)
    }
    if (a !== name) {
      throw new Error(`option ${name} takes no value`)
    }
  }
}

// the shared interval bounds: a sub-floor pulse busy-loops, a
// >2^31-1 ms one clamps to ~1ms — both fail closed
function parsePulseSec(v: string): number {
  const sec = Number(v)
  if (!Number.isFinite(sec) || sec < MIN_INTERVAL_SEC || sec > MAX_INTERVAL_SEC) {
    throw new Error(
      `<seconds> needs a value ≥${MIN_INTERVAL_SEC} up to ${MAX_INTERVAL_SEC}s, got "${v}"`
    )
  }
  return sec
}

/** The mailer role: who this process's pulse.lock hold is. `release`
 *  stays null while another live holder mails — a non-holder still
 *  ticks, so its beats are liveness on stdout, never mail. */
export interface PulseMailer {
  release: (() => void) | null
}

/** Try to take the mailer role — an effectively non-blocking acquire.
 *  waitMs 0 would try ONCE and give up even after the steal inside
 *  tryAcquire freed a dead holder's path; 60ms covers one retry sleep
 *  so a dead incumbent's lock transfers to us on the same beat, while
 *  a live one costs one 25ms nap per beat — still 'never stands by'. */
export function pulseMailer(dir: string): PulseMailer {
  const lock = pulseLockPath(dir)
  if (lock === null) {
    return { release: null }
  }
  try {
    return { release: holdFileLock(lock, { waitMs: 60, label: 'pulse lock' }) }
  } catch (err) {
    // LockTimeout is contention — a live holder mails, we stay a stdout
    // standby. Anything else (EACCES, EIO, a dead staged write) is a
    // filesystem fault: without a warning the pulse ticks forever
    // unable to mail and nobody learns why.
    if (!(err instanceof LockTimeout)) {
      console.error(`pulse: pulse.lock acquire failed — ${errText(err)}`)
    }
    return { release: null }
  }
}

/** Retry the acquire — a non-holder takes the mailer role over the
 *  moment the incumbent's hold dies, without ever going silent. */
export function pulseMailerRetry(dir: string, mailer: PulseMailer): boolean {
  if (mailer.release !== null) {
    return true
  }
  const next = pulseMailer(dir)
  mailer.release = next.release
  return mailer.release !== null
}

interface PulseBeat {
  /** text form for stdout and the mailbox drop */
  text: string
  /** json form for --json stdout */
  json: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One beat's content — the watch snapshot, or the `--` probe's
 *  captured output. A spawn failure (missing binary) is beat content,
 *  never a crash: the metronome does not die on its probe. */
async function pulseBeat(
  dir: string,
  sec: number,
  cmd: string[],
  mailing: boolean
): Promise<PulseBeat> {
  const ts = new Date().toISOString()
  if (cmd.length === 0) {
    const { snap, text } = await tickOnce(dir)
    try {
      // the durable last-known-state — same write `bro watch` makes
      writeHeartbeat(dir, snap)
    } catch (err) {
      console.error(
        `pulse: heartbeat file write failed — ${errText(err)}`
      )
    }
    return {
      text,
      json: JSON.stringify({ ...snap, pulse: { sec, mailing } }),
    }
  }
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' }) // NOSONAR — PATH lookup is the contract (same as core/git.ts)
  const out = r.stdout ?? ''
  const err = r.error !== undefined ? `${r.error.message}\n` : (r.stderr ?? '')
  // null status = spawn error (127, the shell's missing-binary code) or
  // signal-death — either way the beat reports it, the metronome lives
  const code = r.status ?? 127
  const codeNote = code === 0 ? '' : ` (exit ${code})`
  const head = `bro pulse — ${ts} — $ ${cmd.join(' ')}${codeNote}`
  const text = [head, out === '' ? '' : out.trimEnd(), err === '' ? '' : `stderr:\n${err.trimEnd()}`]
    .filter((s) => s !== '')
    .join('\n')
  return {
    text,
    json: JSON.stringify({ ts, sec, mailing, cmd, code, stdout: out, stderr: err }),
  }
}

/** One beat: retry the mailer role, collect the tick, print, mail.
 *  A mail failure warns but never kills the metronome — a transient fs
 *  hiccup must not silence the watchdog permanently. */
export async function pulseTick(
  dir: string,
  args: { sec: number; notify: boolean; json: boolean; cmd: string[] },
  mailer: PulseMailer,
  mb: string | null
): Promise<void> {
  const mailing = pulseMailerRetry(dir, mailer)
  const beat = await pulseBeat(dir, args.sec, args.cmd, mailing)
  console.log(args.json ? beat.json : beat.text)
  if (args.notify && mailing && mb !== null) {
    try {
      dropMailbox(mb, beat.text, 'pulse')
    } catch (err) {
      console.error(`pulse: mailbox drop failed — ${errText(err)}`)
    }
  }
}

export async function runPulseCommand(argv: string[]): Promise<void> {
  let args: PulseArgs
  try {
    args = pulseArgs(argv)
  } catch (err) {
    console.error(`error: ${errText(err)}`)
    process.exit(2)
  }
  // GUARD: spawned workers pin BRO_AGENT_ID at spawn — they never arm
  // the cadence; the orchestrator session owns it (bro-killn, same
  // predicate as the orchestrator mailbox address).
  if (!isOrchestratorSession()) {
    console.error(
      'error: BRO_AGENT_ID is set — spawned workers never arm the pulse; ' +
        'the orchestrator session owns the cadence'
    )
    process.exit(2)
  }
  const dir = process.cwd()
  const cfg =
    (loadConfig(dir, { watch: watchSection }).watch as WatchConfig | undefined) ??
    watchSection(undefined)
  const sec = args.sec ?? cfg.intervalSec

  // the durable want-marker — the checkpoint respawns the unattended
  // leg from it when every holder dies. Outside a repo armPulse throws
  // 'not a git repository' — no marker to write, still beats.
  try {
    armPulse(dir, sec)
  } catch (err) {
    console.error(`pulse: no want-marker — ${errText(err)}`)
  }
  const mb = mailboxDir(dir)
  if (args.notify && mb === null) {
    console.error('pulse: no mailbox here — beats stay on stdout')
  }
  const mailer = pulseMailer(dir)

  const resolved = { sec, notify: args.notify, json: args.json, cmd: args.cmd }
  // the metronome contract is serial: a beat lands, then the gap —
  // parallel ticks would be a broken pulse, not a faster one
  for (;;) {
    await pulseTick(dir, resolved, mailer, mb) // NOSONAR — serial by contract
    await new Promise((r) => setTimeout(r, sec * 1000)) // NOSONAR — serial by contract
  }
}
