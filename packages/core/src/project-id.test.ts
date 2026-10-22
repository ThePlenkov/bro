import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { normalizeRemote, projectId } from './project-id.ts'
import { gitCommonDir } from './git.ts'
import { scrubEnv, testGit } from './testkit.ts'
import { tmpDir } from './testtmp.ts'

after(scrubEnv())

function repo(remote?: string): string {
  const dir = tmpDir('bro-project-id-')
  testGit(['init', dir], { stdio: 'ignore' })
  if (remote !== undefined) {
    testGit(['-C', dir, 'remote', 'add', 'origin', remote], { stdio: 'ignore' })
  }
  return dir
}

describe('project identity', () => {
  test('normalizes https, scp, ssh, token, proxy, and git-suffixed remotes', () => {
    const remotes = [
      'https://GitHub.com/Owner/Repo.git/',
      'git@github.com:Owner/Repo.git',
      'ssh://git@GITHUB.com/Owner/Repo',
      'https://token@github.com/Owner/Repo.git',
      'http://git-manager.local/proxy/github.com/Owner/Repo.git',
    ]
    assert.deepEqual(remotes.map(normalizeRemote), remotes.map(() => 'github.com/Owner/Repo'))
    assert.equal(new Set(remotes.map((remote) => projectId(repo(remote)))).size, 1)
    assert.notEqual(projectId(repo('https://github.com/Owner/Other.git')), projectId(repo(remotes[0])))
  })

  test('uses the real git common directory when no origin exists', () => {
    const dir = repo()
    const common = gitCommonDir(dir)
    assert.notEqual(common, null)
    const expected = createHash('sha256')
      .update(realpathSync(common!))
      .digest('hex')
      .slice(0, 16)
    assert.equal(projectId(dir), expected)
  })
})
