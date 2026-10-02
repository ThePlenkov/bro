import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  drainDirs,
  drainMailbox,
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

/** Pin XDG state into a tmp dir — drainDirs() reads the real
 *  $HOME/.local/state mailbox otherwise and tests would eat it. */
const withXdg = <T>(dir: string, fn: () => T): T => {
  const prev = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    return fn()
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = prev
    }
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
    withXdg(join(tmp('bro-xdg-'), 'state'), () => {
      assert.match(userMailboxDir(), /state\/bro\/notify$/)
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

  test('notifyDir picks the repo mailbox, else the user mailbox', () => {
    withRepo((dir) => {
      withXdg(tmp('bro-xdg-'), () => {
        assert.equal(notifyDir(dir), mailboxDir(dir))
      })
    })
    const bare = tmp('bro-notify-bare-')
    try {
      withXdg(join(bare, 'xdg'), () => {
        assert.equal(notifyDir(bare), join(bare, 'xdg', 'bro', 'notify'))
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
  test('returns drops oldest-first and deletes them', () => {
    withRepo((dir) => {
      withXdg(tmp('bro-xdg-'), () => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'note-100-a.txt'), 'first')
        writeFileSync(join(mb, 'note-200-b.txt'), 'second')
        writeFileSync(join(mb, '.note-300.tmp'), 'half-written')
        assert.deepEqual(drainMailbox(dir), ['first', 'second'])
        assert.equal(existsSync(join(mb, 'note-100-a.txt')), false)
        assert.deepEqual(drainMailbox(dir), [])
      })
    })
  })

  test('orders by drop time across prefixes — watch-* does not wait on note-*', () => {
    withRepo((dir) => {
      withXdg(tmp('bro-xdg-'), () => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        writeFileSync(join(mb, 'watch-100-a.txt'), 'older watch')
        writeFileSync(join(mb, 'note-200-b.txt'), 'newer note')
        writeFileSync(join(mb, 'watch-50-c.txt'), 'oldest watch')
        assert.deepEqual(drainMailbox(dir), [
          'oldest watch',
          'older watch',
          'newer note',
        ])
      })
    })
  })

  test('a live .claim is invisible to drain; a stale one is handed back', () => {
    withRepo((dir) => {
      withXdg(tmp('bro-xdg-'), () => {
        const mb = mailboxDir(dir)!
        mkdirSync(mb, { recursive: true })
        const claim = join(mb, '.note-100-a.txt.4242-zz.claim')
        writeFileSync(claim, 'claimed but undelivered')
        assert.deepEqual(drainMailbox(dir), [])
        assert.equal(existsSync(claim), true)
        const stale = new Date(Date.now() - 120_000)
        utimesSync(claim, stale, stale)
        assert.deepEqual(drainMailbox(dir), ['claimed but undelivered'])
        assert.equal(existsSync(claim), false)
      })
    })
  })

  test('drains the user mailbox too — drops written outside a repo', () => {
    withRepo((dir) => {
      const xdg = tmp('bro-xdg-')
      withXdg(xdg, () => {
        dropMailbox(userMailboxDir(), 'from a repo-less writer', 'note')
        assert.deepEqual(drainMailbox(dir), ['from a repo-less writer'])
      })
    })
  })

  test('no mailboxes anywhere is an empty drain, not an error', () => {
    const dir = tmp('bro-notify-empty-')
    try {
      withXdg(join(dir, 'xdg'), () => {
        assert.deepEqual(drainDirs(dir), [join(dir, 'xdg', 'bro', 'notify')])
        assert.deepEqual(drainMailbox(dir), [])
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
