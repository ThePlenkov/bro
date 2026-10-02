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
 */
import { dropMailbox, notifyDir } from '@broject/core'

export function runNotifyCommand(argv: string[]): void {
  const text = argv.join(' ').trim()
  if (text === '') {
    console.error('usage: bro notify <text> — drop an event into the session mailbox')
    process.exit(2)
  }
  console.log(dropMailbox(notifyDir(process.cwd()), text, 'note'))
}
