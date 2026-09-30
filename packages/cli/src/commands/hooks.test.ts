import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyArmCommand, classifyArmCommands, classifyExecCommand, classifySkillMutation, isSelfToolCommand, readArmed, armDetail, otherLiveWork } from './hooks.ts'

describe('classifyExecCommand', () => {
  test('detects gh pr merge', () => {
    assert.equal(classifyExecCommand('gh pr merge 42 --squash'), 'pr-merge')
    assert.equal(classifyExecCommand('cd x && gh pr merge --auto'), 'pr-merge')
  })

  test('detects gh pr create', () => {
    assert.equal(classifyExecCommand('gh pr create --fill'), 'pr-create')
  })

  test('ignores unrelated commands', () => {
    assert.equal(classifyExecCommand('git status'), null)
    assert.equal(classifyExecCommand('gh pr view 42'), null)
    assert.equal(classifyExecCommand('echo "gh pr merge"'), null) // text, not a merge
  })
})

describe('isSelfToolCommand', () => {
  test('approves bro and bd invocations', () => {
    assert.ok(isSelfToolCommand('bro act status'))
    assert.ok(isSelfToolCommand('bd ready -n 5'))
    assert.ok(isSelfToolCommand('  bro debt prs'))
    assert.ok(isSelfToolCommand('npx -y @broject/bro debt status'))
    assert.ok(isSelfToolCommand('npx @broject/bro hooks stop'))
    assert.ok(isSelfToolCommand('npx -y @broject/bro@0 act status'))
  })

  test('does not approve lookalikes or other tools', () => {
    assert.ok(!isSelfToolCommand('brotli -d file'))
    assert.ok(!isSelfToolCommand('bdr foo'))
    assert.ok(!isSelfToolCommand('gh pr merge 1'))
    assert.ok(!isSelfToolCommand(''))
  })

  test('rejects chained/piped/redirected commands — the second stage is unvetted', () => {
    assert.ok(!isSelfToolCommand('bro act status && rm -rf /'))
    assert.ok(!isSelfToolCommand('bro act status; rm -rf /'))
    assert.ok(!isSelfToolCommand('bd ready | sh'))
    assert.ok(!isSelfToolCommand('bro x $(evil)'))
    assert.ok(!isSelfToolCommand('bro x > /tmp/out'))
  })
})

describe('classifyArmCommand', () => {
  test('arms act on PR-touching commands', () => {
    assert.equal(classifyArmCommand('bro act status'), 'act')
    assert.equal(classifyArmCommand('bro act merge 33 --squash'), 'act')
    assert.equal(classifyArmCommand('npx -y @broject/bro act threads 33'), 'act')
    assert.equal(classifyArmCommand('gh pr create --fill'), 'act')
    assert.equal(classifyArmCommand('gh pr view 42'), 'act')
    assert.equal(classifyArmCommand('git push -u origin feat/x'), 'act')
    assert.equal(classifyArmCommand('cd x && gh pr checks'), 'act')
  })

  test('arms drill on drill/wtf commands', () => {
    assert.equal(classifyArmCommand('bro drill down "x"'), 'drill')
    assert.equal(classifyArmCommand('bro wtf "why"'), 'drill')
    assert.equal(classifyArmCommand('bro drill up --result "done"'), 'drill')
  })

  test('arms work on worktree-mutating commands', () => {
    assert.equal(classifyArmCommand('bro work enter fix-x'), 'work')
    assert.equal(classifyArmCommand('bro work leave'), 'work')
    assert.equal(classifyArmCommand('npx -y @broject/bro work list'), 'work')
    assert.equal(classifyArmCommand('git worktree add ../repo--fix -b work/fix'), 'work')
    assert.equal(classifyArmCommand('git -C /path worktree remove old'), 'work')
    assert.equal(classifyArmCommand('bd worktree create feat'), 'work')
    assert.equal(classifyArmCommand('bd worktree remove feat'), 'work')
  })

  test('read-only worktree commands do not arm', () => {
    assert.equal(classifyArmCommand('git worktree list'), null)
    assert.equal(classifyArmCommand('git worktree prune'), null)
    assert.equal(classifyArmCommand('bd worktree list'), null)
  })

  test('bead claims arm task — the session owes the claim a close/release', () => {
    assert.equal(classifyArmCommand('bd update bro-x1 --claim'), 'task')
    assert.equal(classifyArmCommand('bd update --claim bro-x1'), 'task')
    assert.equal(classifyArmCommand('bd ready'), null)
    assert.equal(classifyArmCommand('bd show bro-x1'), null)
  })

  test('work enter arms both work and task — it also claims the bead', () => {
    assert.deepEqual(classifyArmCommands('bro work enter bro-x1').sort(), ['task', 'work'])
    assert.deepEqual(classifyArmCommands('git worktree add ../x'), ['work'])
    assert.deepEqual(classifyArmCommands('git status'), [])
  })

  test('ignores unrelated or non-command-position text', () => {
    assert.equal(classifyArmCommand('git status'), null)
    assert.equal(classifyArmCommand('bd ready'), null)
    assert.equal(classifyArmCommand('bro debt collect'), null)
    assert.equal(classifyArmCommand('echo "gh pr merge"'), null)
    assert.equal(classifyArmCommand('gh auth status'), null)
  })
})

describe('classifySkillMutation', () => {
  const skill = (cmd: string) => classifySkillMutation(cmd)?.skill ?? null

  test('cites the governing skill on mutating verbs', () => {
    assert.equal(skill('bro act resolve --thread t1'), 'act')
    assert.equal(skill('bro act merge 33 --squash'), 'act')
    assert.equal(skill('bro drill up --result "done"'), 'drill')
    assert.equal(skill('bro drill down "why"'), 'drill')
    assert.equal(skill('bro debt collect'), 'debt')
    assert.equal(skill('bro debt set done --thread-id t1'), 'debt')
    assert.equal(skill('bro work enter fix-x'), 'work')
    assert.equal(skill('bro convoy done bro-x --result "y"'), 'convoy')
    assert.equal(skill('bro spec new bro-x'), 'sdd')
    assert.equal(skill('npx -y @broject/bro act reply --thread t --comment x'), 'act')
  })

  test('aliases cite the shared skill, not argv[0]', () => {
    assert.equal(skill('bro retrospect capture "oops"'), 'wtf')
    assert.equal(skill('bro retrospect record --file p.toml'), 'wtf')
    assert.equal(skill('bro unwind --result "done"'), 'drill')
    assert.equal(skill('bro wtf "how did this happen"'), 'wtf')
  })

  test('wtf mutates only with an argument — bare is status', () => {
    assert.equal(skill('bro wtf'), null)
    assert.equal(skill('bro wtf verbatim complaint'), 'wtf')
    assert.equal(skill("bro wtf 'quoted vent'"), 'wtf')
  })

  test('bare-mutation plugins cite unless a read flag suppresses', () => {
    assert.equal(skill('bro next'), 'next')
    assert.equal(skill('bro next --list'), null)
    assert.equal(skill('bro loop'), 'loop')
    assert.equal(skill('bro loop --dry-run'), null)
    assert.equal(skill('bro sync'), 'sync')
    assert.equal(skill('bro sync --pull'), 'sync')
  })

  test('reads never cite', () => {
    assert.equal(skill('bro act status'), null)
    assert.equal(skill('bro act threads 12'), null)
    assert.equal(skill('bro act wait --interval 30'), null)
    assert.equal(skill('bro debt status'), null)
    assert.equal(skill('bro debt prs'), null)
    assert.equal(skill('bro debt list --status open'), null)
    assert.equal(skill('bro drill current'), null)
    assert.equal(skill('bro drill tree'), null)
    assert.equal(skill('bro work list'), null)
    assert.equal(skill('bro convoy next'), null)
    assert.equal(skill('bro retrospect status'), null)
    assert.equal(skill('bro spec check'), null)
  })

  test('act wait cites only when it can merge', () => {
    assert.equal(skill('bro act wait'), null)
    assert.equal(skill('bro act wait --merge'), 'act')
    assert.equal(skill('bro act wait --merge --cleanup'), 'act')
  })

  test('debt next cites only when it claims', () => {
    assert.equal(skill('bro debt next'), null)
    assert.equal(skill('bro debt next --json'), null)
    assert.equal(skill('bro debt next --claim'), 'debt')
  })

  test('finds mutations later in a chained command', () => {
    assert.equal(skill('bro act status && bro act resolve --thread t'), 'act')
    assert.equal(skill('cd x && bro drill down "y"'), 'drill')
  })

  test("a later segment's flags cannot mutate an earlier read", () => {
    assert.equal(skill('bro act wait; git push'), null)
    assert.equal(skill('bro next --list && echo done'), null)
  })

  test('ignores non-command-position text and other tools', () => {
    assert.equal(skill('echo "bro act resolve --thread t"'), null)
    assert.equal(skill('git status'), null)
    assert.equal(skill('bd close bro-x'), null)
    assert.equal(skill('broact resolve'), null)
  })
})

describe('readArmed', () => {
  test('returns an empty set for a session with no marker', () => {
    assert.equal(readArmed('definitely-no-such-session-id').size, 0)
  })
})

describe('classifyArmCommand edge cases', () => {
  test('arms through global flags between binary and subcommand', () => {
    assert.equal(classifyArmCommand('git -C /path push'), 'act')
    assert.equal(classifyArmCommand('gh -R owner/repo pr view'), 'act')
    assert.equal(classifyArmCommand('gh --repo owner/repo pr checks'), 'act')
  })

  test('quoted separators do not fake a command position', () => {
    assert.equal(classifyArmCommand('echo "x; bro act status"'), null)
    assert.equal(classifyArmCommand("echo 'git push'"), null)
  })
})

describe('classifyArmCommand positions', () => {
  test('leading whitespace and newlines still count as command position', () => {
    assert.equal(classifyArmCommand('  gh pr view'), 'act')
    assert.equal(classifyArmCommand('echo hi\nbro act status'), 'act')
    assert.equal(classifyArmCommand('true && git push'), 'act')
  })

  test('escaped quotes inside arguments do not open a command position', () => {
    assert.equal(classifyArmCommand('echo "x\\"; git push"'), null)
    assert.equal(classifyArmCommand("echo 'a\\'; bro act'"), null)
  })
})

describe('armDetail', () => {
  for (const [cmd, aspect, want] of [
    ['bro work enter bro-n5t-2', 'work', 'bro-n5t-2'],
    ['cd x && bro work enter bro-abc', 'work', 'bro-abc'],
    ['git worktree add ../bro--x -b work/x', 'work', '../bro--x'],
    ['git worktree add -b work/x ../bro--x', 'work', '../bro--x'],
    ['bro act merge 89 --cleanup', 'act', '#89'],
    ['gh pr merge 42 --squash', 'act', '#42'],
    ['git push', 'act', ''],
    ['bro drill down bro-x', 'drill', ''],
    ['bd update bro-x1 --claim', 'task', 'bro-x1'],
    ['npm test', 'work', ''],
  ] as const) {
    test(`${cmd} → "${want}"`, () => {
      assert.equal(armDetail(cmd, aspect), want)
    })
  }
})

describe('otherLiveWork', () => {
  /** Seed marker files; ageHours backdates mtime past the live window. */
  function markerDir(entries: Array<[name: string, content: string, ageHours?: number]>): string {
    const dir = mkdtempSync(join(tmpdir(), 'bro-hooks-'))
    for (const [name, content, ageHours] of entries) {
      const p = join(dir, name)
      writeFileSync(p, content)
      if (ageHours !== undefined) {
        const past = new Date(Date.now() - ageHours * 3_600_000)
        utimesSync(p, past, past)
      }
    }
    return dir
  }

  test("a second session's live work marker is detected with its detail", () => {
    const dir = markerDir([['other-session-1.work', '123\nbro-xyz']])
    const found = otherLiveWork(dir, 'self-session')
    assert.equal(found.length, 1)
    assert.equal(found[0]!.session, 'other-session-1')
    assert.equal(found[0]!.detail, 'bro-xyz')
  })

  test('a lone session sees nothing', () => {
    const dir = markerDir([
      ['self-session.work', '123\nbro-mine'],
      ['self-session.act', '123\n#1'],
    ])
    assert.equal(otherLiveWork(dir, 'self-session').length, 0)
  })

  test('stale markers and non-work aspects are ignored', () => {
    const dir = markerDir([
      ['old-session.work', '123\nbro-old', 25],
      ['other.act', '123\n#1'],
      ['other.drill', '123\n'],
      ['unrelated-file', 'x'],
    ])
    assert.equal(otherLiveWork(dir, 'self-session').length, 0)
  })
})
