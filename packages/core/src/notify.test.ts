import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainDirs,
  drainMailbox,
  DROP_TTL_MS,
  dropMailbox,
  mailboxDir,
  notifyDir,
  userMailboxDir,
} from './notify.ts'

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const withRepo = (fn: (dir: string) => void): void => {
  const dir = tmp('bro-notify-')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Pin XDG state into a tmp dir the helper owns and removes — without it
 *  drainDirs() would read the real $HOME/.local/state mailbox and tests
 *  would eat a live session's drops. */
const withXdg = <T>(fn: (xdg: string) => T): T => {
  const dir = tmp('bro-xdg-')
  const prev = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = prev
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mailboxDir', () => {
  test('resolves to <git-common>/bro/notify inside a repo', () => {
    withRepo((dir) => {
      assert.equal(mailboxDir(dir), join(dir, '.git', 'bro', 'notify'))
    })
  })

  test('a linked worktree resolves to the shared common dir', () => {
    withRepo((dir) => {
      const wt = join(dir, '..', `${dir.split('/').pop()}-wt`)
      execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', wt, '-b', 'w'])
      try {
        assert.equal(mailboxDir(wt), mailboxDir(dir))
      } finally {
        rmSync(wt, { recursive: true, force: true })
      }
    })
  })

  test('null outside a repo', () => {
    const dir = tmp('bro-notify-norepo-')
    try {
      assert.equal(mailboxDir(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('userMailboxDir / notifyDir', () => {
  test('XDG_STATE_HOME wins, else ~/.local/state', () => {
    withXdg((xdg) => {
      assert.equal(userMailboxDir(), join(xdg, 'bro', 'notify'))
    })
    const prev = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    try {
      assert.match(userMailboxDir(), /\.local\/state\/bro\/notify$/)
    } finally {
      if (prev !== undefined) {
        process.env.XDG_STATE_HOME = prev
      }
    }
  })

  test('an empty XDG_STATE_HOME falls back like an unset one', () => {
    const prev = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = ''
    try {
      assert.match(userMailboxDir(), /\.local\/state\/bro\/notify$/)
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_STATE_HOME
      } else {
        process.env.XDG_STATE_HOME = prev
      }
    }
  })

  test('notifyDir picks the repo mailbox, else the user mailbox', () => {
    withRepo((dir) => {
      withXdg(() => {
        assert.equal(notifyDir(dir), mailboxDir(dir))
      })
    })
    const bare = tmp('bro-notify-bare-')
    try {
      withXdg((xdg) => {
        assert.equal(notifyDir(bare), join(xdg, 'bro', 'notify'))
      })
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('dropMailbox', () => {
  test('writes one atomic <prefix>-*.txt drop and returns its path', () => {
    const mb = tmp('bro-mb-')
    try {
      const file = dropMailbox(mb, 'gate ready', 'note')
      assert.match(file, /note-\d+-[a-z0-9]+\.txt$/)
      assert.equal(readFileSync(file, 'utf8'), 'gate ready')
      assert.ok(!readdirSync(mb).some((f) => f.includes('.tmp')))
    } finally {
      rmSync(mb, { recursive: true, force: true })
    }
  })
})

describe('drainMailbox', () => {
  test('delivers drops oldest-first, verbatim — once per session', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'note-100-a.txt'), 'first')
        writeFileSync(join(mb, 'note-200-b.txt'), 'two\n  indented')
        writeFileSync(join(mb, '.note-300.tmp'), 'half-written')
        assert.deepEqual(drainMailbox(dir, 's1'), ['first', 'two\n  indented'])
        // same session: no redelivery
        assert.deepEqual(drainMailbox(dir, 's1'), [])
        // the cursor lives in the mailbox dir
        assert.ok(existsSync(join(mb, '.seen-s1')))
      })
    })
  })

  test('orders by drop time across prefixes — watch-* does not wait on note-*', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'watch-100-a.txt'), 'older watch')
        writeFileSync(join(mb, 'note-200-b.txt'), 'newer note')
        writeFileSync(join(mb, 'watch-50-c.txt'), 'oldest watch')
        assert.deepEqual(drainMailbox(dir, 's1'), [
          'oldest watch',
          'older watch',
          'newer note',
        ])
      })
    })
  })

  test('broadcast: a different session still gets the drops', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        dropMailbox(mb, 'for everyone', 'note')
        assert.deepEqual(drainMailbox(dir, 's1'), ['for everyone'])
        // s1's drain must not eat it — s2 is the intended recipient case
        assert.deepEqual(drainMailbox(dir, 's2'), ['for everyone'])
        // and the writer session echoing it back is delivery, not loss
        assert.deepEqual(drainMailbox(dir, 's3'), ['for everyone'])
      })
    })
  })

  test('a drop older than the TTL is reaped undelivered', () => {
    withRepo((dir) => {
      withXdg(() => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        const stale = join(mb, 'note-100-a.txt')
        writeFileSync(stale, 'ancient')
        const old = new Date(Date.now() - DROP_TTL_MS - 1000)
        utimesSync(stale, old, old)
        assert.deepEqual(drainMailbox(dir, 's1'), [])
        assert.equal(existsSync(stale), false)
      })
    })
  })

  test('drains the user mailbox too — drops written outside a repo', () => {
    withRepo((dir) => {
      withXdg(() => {
        dropMailbox(userMailboxDir(), 'from a repo-less writer', 'note')
        assert.deepEqual(drainMailbox(dir, 's1'), ['from a repo-less writer'])
      })
    })
  })

  test('no mailboxes anywhere is an empty drain, not an error', () => {
    const dir = tmp('bro-notify-empty-')
    try {
      withXdg((xdg) => {
        assert.deepEqual(drainDirs(dir), [join(xdg, 'bro', 'notify')])
        assert.deepEqual(drainMailbox(dir, 's1'), [])
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
