import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSkillLock, readSkillLock, skillFolderHash } from './skills-lock.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bro-skills-lock-'))
}

describe('readSkillLock', () => {
  it('reads the locked skills', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'skills-lock.json'),
        JSON.stringify({
          version: 1,
          skills: {
            evidence: {
              source: 'public-org/public-skills',
              sourceType: 'github',
              skillPath: 'skills/verification/evidence/SKILL.md',
              computedHash: 'abc123',
              ref: '',
            },
          },
        }),
        'utf8'
      )
      const lock = readSkillLock(dir)
      assert.equal(lock.size, 1)
      const skill = lock.get('evidence')!
      assert.equal(skill.source, 'public-org/public-skills')
      assert.equal(skill.sourceType, 'github')
      assert.equal(skill.computedHash, 'abc123')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads an absent lockfile as nothing — fail open', () => {
    const dir = scratch()
    try {
      assert.equal(readSkillLock(dir).size, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a malformed lockfile as nothing — fail open', () => {
    const dir = scratch()
    try {
      writeFileSync(join(dir, 'skills-lock.json'), '{not json', 'utf8')
      assert.equal(readSkillLock(dir).size, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips entries that carry no source or hash', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'skills-lock.json'),
        JSON.stringify({
          version: 1,
          skills: {
            broken: { sourceType: 'github' },
            alsoBroken: { source: 'o/r' },
            good: { source: 'o/r', computedHash: 'h', ref: '' },
          },
        }),
        'utf8'
      )
      const lock = readSkillLock(dir)
      assert.equal(lock.size, 1)
      assert.ok(lock.has('good'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkSkillLock', () => {
  it('reports a skill that is not installed as missing', () => {
    const dir = scratch()
    try {
      const lock = new Map([
        [
          'evidence',
          {
            name: 'evidence',
            source: 'public-org/public-skills',
            sourceType: 'github',
            skillPath: 'x/SKILL.md',
            computedHash: 'abc',
              ref: '',
          },
        ],
      ])
      const drift = checkSkillLock(lock, join(dir, 'skills'))
      assert.equal(drift.length, 1)
      assert.equal(drift[0]!.kind, 'missing')
      assert.equal(drift[0]!.name, 'evidence')
      assert.equal(drift[0]!.actual, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a skill whose content no longer matches the lock as drifted', () => {
    const dir = scratch()
    try {
      const skills = join(dir, 'skills')
      mkdirSync(join(skills, 'evidence'), { recursive: true })
      writeFileSync(join(skills, 'evidence', 'SKILL.md'), '# different content\n', 'utf8')
      const installed = skillFolderHash(join(skills, 'evidence'))!

      const lock = new Map([
        [
          'evidence',
          {
            name: 'evidence',
            source: 'o/r',
            sourceType: 'github',
            skillPath: 'x/SKILL.md',
            computedHash: 'not-the-installed-hash',
              ref: '',
          },
        ],
      ])
      const drift = checkSkillLock(lock, skills)
      assert.equal(drift.length, 1)
      assert.equal(drift[0]!.kind, 'drifted')
      assert.equal(drift[0]!.actual, installed)
      assert.equal(drift[0]!.expected, 'not-the-installed-hash')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hashes the whole folder, so a changed helper script is a change', () => {
    const dir = scratch()
    try {
      const skill = join(dir, 'skill')
      mkdirSync(join(skill, 'scripts'), { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), '# same\n', 'utf8')
      writeFileSync(join(skill, 'scripts', 'helper.ts'), 'export const a = 1\n', 'utf8')
      const before = skillFolderHash(skill)!

      writeFileSync(join(skill, 'scripts', 'helper.ts'), 'export const a = 2\n', 'utf8')
      const after = skillFolderHash(skill)!

      assert.notEqual(before, after)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips .git and node_modules when hashing a folder', () => {
    const dir = scratch()
    try {
      const skill = join(dir, 'skill')
      mkdirSync(join(skill, '.git'), { recursive: true })
      mkdirSync(join(skill, 'node_modules'), { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), '# same\n', 'utf8')
      writeFileSync(join(skill, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
      writeFileSync(join(skill, 'node_modules', 'x.js'), 'noise\n', 'utf8')
      const withNoise = skillFolderHash(skill)!

      rmSync(join(skill, '.git'), { recursive: true, force: true })
      rmSync(join(skill, 'node_modules'), { recursive: true, force: true })
      assert.equal(skillFolderHash(skill), withNoise)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says nothing about a skill that matches the lock', () => {
    const dir = scratch()
    try {
      const skills = join(dir, 'skills')
      mkdirSync(join(skills, 'evidence'), { recursive: true })
      writeFileSync(join(skills, 'evidence', 'SKILL.md'), '# content\n', 'utf8')
      const hash = skillFolderHash(join(skills, 'evidence'))!

      const lock = new Map([
        [
          'evidence',
          {
            name: 'evidence',
            source: 'o/r',
            sourceType: 'github',
            skillPath: 'x/SKILL.md',
            computedHash: hash,
            ref: '',
          },
        ],
      ])
      assert.deepEqual(checkSkillLock(lock, skills), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports nothing for an empty lock', () => {
    const dir = scratch()
    try {
      assert.deepEqual(checkSkillLock(new Map(), join(dir, 'skills')), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
