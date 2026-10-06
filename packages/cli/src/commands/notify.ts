/**
 * `bro notify <text>` — the mailbox's write side (bro-d8zo, bro-22jd).
 * Drops one atomic file per event into the session mailbox; the notify
 * connector's postTool probe drains it into the recipient's context, so
 * a watcher/fixer/convoy worker reaches the session mid-turn instead of
 * the recipient burning tokens in a wait loop.
 *
 * Addressed, typed, threaded notes:
 *   --to <agentId|sessionId|orchestrator>  a peer message for exactly
 *        one consumer — `orchestrator` names the session owning agents
 *        (one without BRO_AGENT_ID); absent = broadcast to all sessions
 *   --kind note|info|ask|result|block     a label, never a grant — a
 *        `block` or `ask` carries no approval or scope with it
 *   --in-reply-to <ref>                   the drop/bead/step answered
 *   --key <k>                             coalesce: a pending same-key
 *        drop from this source is superseded by the newer one
 *
 * Addressed drops expire on read (single-consumer); broadcast drops
 * stay for every session until the drop TTL reaps them.
 *
 * Mailbox: `<git-common-dir>/bro/notify/` inside a repo (shared across
 * linked worktrees), the XDG state dir (`$XDG_STATE_HOME`, default
 * `~/.local/state`) outside one — the spec's "(or XDG state)" fallback.
 *
 * The write goes through the `events` FACADE, so `"connectors": {"events":
 * "bus"}` in bro.config.json sends the same event down the bus instead.
 * The default stays the mailbox: this command works with no broker, no
 * config and no daemon, and it must keep doing so.
 */
import { facade, loadConfig } from '@broject/core'
import { flag, positionals } from './args.ts'

const KINDS = new Set(['note', 'info', 'ask', 'result', 'block'])
const VALUE_FLAGS = new Set(['--to', '--kind', '--in-reply-to', '--key'])

const sourceOf = (): string | undefined => {
  const a = process.env.BRO_AGENT_ID
  const s = process.env.BRO_SESSION_ID
  return a !== undefined && a !== '' ? a : s !== undefined && s !== '' ? s : undefined
}

export function runNotifyCommand(argv: string[]): void {
  // strict: notify knows every `--flag` it takes — anything else is a
  // typo'd option, never message text silently dropped. `--` ends flag
  // parsing so a text containing an option-looking word survives.
  const text = positionals(argv, VALUE_FLAGS, { strict: true }).join(' ').trim()
  const to = flag(argv, '--to')
  const kind = flag(argv, '--kind')
  const inReplyTo = flag(argv, '--in-reply-to')
  const key = flag(argv, '--key')
  if (kind !== undefined && !KINDS.has(kind)) {
    console.error(`error: --kind must be one of: ${[...KINDS].join(', ')}`)
    process.exit(2)
  }
  if (text === '') {
    console.error(
      'usage: bro notify [--to <addr>] [--kind <k>] [--in-reply-to <r>] [--key <k>] [--] <text>'
    )
    process.exit(2)
  }
  const dir = process.cwd()
  const events = facade('events', { dir }, { prefer: loadConfig(dir).connectors })
  // A publish that reports `published: false` here means the configured
  // transport is not running. That is a reason, not a crash: the caller
  // is usually a detached worker that has to keep going either way.
  void events
    .publish({
      topic: 'notify',
      kind: kind ?? 'note',
      payload: text,
      ...(to !== undefined && { to }),
      ...(inReplyTo !== undefined && { cause: inReplyTo }),
      ...(key !== undefined && { key }),
      // spawned workers pin BRO_AGENT_ID at spawn; an interactive
      // session under a hook host carries BRO_SESSION_ID — either pins
      // the source so two publishers' same-key drops don't collide on
      // the absent-source wildcard. A session with neither stays
      // anonymous rather than claim a role.
      ...(sourceOf() !== undefined && { source: sourceOf() }),
    })
    .then((res) => {
      if (!res.published) {
        console.error(`notify: not delivered (${res.reason ?? 'unknown reason'})`)
        return
      }
      // The mailbox answers with the file it wrote, which callers point
      // at. A transport with no locator has nothing to print — silence,
      // not a blank line.
      if (res.locator !== undefined) {
        console.log(res.locator)
      }
    })
}
