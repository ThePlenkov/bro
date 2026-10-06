/**
 * `bro notify <text>` — the mailbox's write side (bro-d8zo). Drops one
 * atomic file per event into the session mailbox; the notify connector's
 * postTool probe drains it into the parent session's context, so a
 * watcher/fixer/convoy worker reaches the parent mid-turn instead of the
 * parent burning tokens in a wait loop.
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

export function runNotifyCommand(argv: string[]): void {
  const text = argv.join(' ').trim()
  if (text === '') {
    console.error('usage: bro notify <text> — drop an event into the session mailbox')
    process.exit(2)
  }
  const dir = process.cwd()
  const events = facade('events', { dir }, { prefer: loadConfig(dir).connectors })
  // A publish that reports `published: false` here means the configured
  // transport is not running. That is a reason, not a crash: the caller
  // is usually a detached worker that has to keep going either way.
  void events
    .publish({ topic: 'notify', kind: 'note', payload: text })
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