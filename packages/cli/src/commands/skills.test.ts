import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillFolderHash } from '@broject/core';
import {
  collectRows,
  ensureLocalLink,
  localSkillName,
  parseSkillSource,
  resolveSkillsBin,
  runSync,
  type SkillsConfig,
  type SpawnRunner,
} from './skills.ts';
import { skillsSection } from './skills-config.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bro-skills-'));

function makeSkill(dir: string, name: string, body?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: x\n---\n${body ?? '# s\n'}`
  );
}

function writeLock(root: string, skills: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify({ skills }));
}

/** A lock entry whose computedHash is the folder's real hash — verifies clean. */
function lockEntry(root: string, name: string, source = 'o/r'): Record<string, unknown> {
  return {
    source,
    sourceType: 'github',
    skillPath: `skills/${name}/SKILL.md`,
    computedHash: skillFolderHash(join(root, '.agents', 'skills', name)),
    ref: 'abc123',
  };
}

const cfg = (install: string[], extra: Partial<SkillsConfig> = {}): SkillsConfig => ({
  install,
  agents: ['universal'],
  ...extra,
});

/** Spawn stub — records argv, returns a scripted status per predicate.
 *  `materialize` fakes an `add -s <name>` by dropping a SKILL.md into
 *  .agents/skills/<name> so post-sync verification sees it land. */
function fakeSpawn(opts: { failOn?: (args: string[]) => boolean; materialize?: boolean } = {}): {
  spawn: SpawnRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn: SpawnRunner = (_bin, root, args) => {
    calls.push([...args]);
    const status = opts.failOn?.(args) === true ? 1 : 0;
    if (status === 0 && opts.materialize === true && args[0] === 'add') {
      const s = args.indexOf('-s');
      if (s !== -1 && args[s + 1] !== undefined) {
        makeSkill(join(root, '.agents', 'skills', args[s + 1]!), args[s + 1]!);
      }
    }
    return {
      status,
      stdout: '',
      stderr: status === 0 ? '' : 'boom',
      output: [],
      pid: 1,
      signal: null,
    };
  };
  return { spawn, calls };
}

describe('parseSkillSource', () => {
  test('github: with a skill path keeps repo, path, and basename', () => {
    assert.deepEqual(parseSkillSource('github:herdrdev/herdr/skills/herdr'), {
      kind: 'github',
      repo: 'herdrdev/herdr',
      path: 'skills/herdr',
      skill: 'herdr',
      raw: 'github:herdrdev/herdr/skills/herdr',
    });
  });
  test('github: repo-only carries no skill', () => {
    const s = parseSkillSource('github:o/r');
    assert.deepEqual(s, { kind: 'github', repo: 'o/r', raw: 'github:o/r' });
  });
  test('bare owner/repo is the github shorthand', () => {
    assert.deepEqual(parseSkillSource('o/r'), { kind: 'github', repo: 'o/r', raw: 'o/r' });
  });
  test('https URL passes through', () => {
    const u = 'https://github.com/o/r/tree/main/skills/x';
    assert.deepEqual(parseSkillSource(u), { kind: 'url', url: u, raw: u });
  });
  test('local: and ./ are repo-relative dirs', () => {
    assert.deepEqual(parseSkillSource('local:skills/x'), {
      kind: 'local',
      path: 'skills/x',
      raw: 'local:skills/x',
    });
    assert.deepEqual(parseSkillSource('./skills/x'), {
      kind: 'local',
      path: './skills/x',
      raw: './skills/x',
    });
  });
  test('a garbage string is invalid, never skipped', () => {
    const s = parseSkillSource('not a source');
    assert.equal(s.kind, 'invalid');
    assert.equal(parseSkillSource('github:o').kind, 'invalid');
    assert.equal(parseSkillSource('local:').kind, 'invalid');
  });
  test('local: escapes are invalid — no absolute paths, no ..', () => {
    assert.equal(parseSkillSource('local:/etc/skill').kind, 'invalid');
    assert.equal(parseSkillSource('local:../outside/x').kind, 'invalid');
    assert.equal(parseSkillSource('local:skills/../../x').kind, 'invalid');
    assert.equal(parseSkillSource('../x').kind, 'invalid');
  });
  test('plaintext http:// is rejected — https only', () => {
    assert.equal(parseSkillSource('http://github.com/o/r').kind, 'invalid');
  });
  test('a non-string entry is invalid — not silently dropped', () => {
    const s = parseSkillSource(42);
    assert.equal(s.kind, 'invalid');
    assert.equal(parseSkillSource({ repo: 'o/r' }).kind, 'invalid');
  });
});

describe('skillsSection', () => {
  test('defaults — empty install, universal agents', () => {
    assert.deepEqual(skillsSection(undefined), {
      install: [],
      agents: ['universal'],
    });
  });
  test('parses the declared shape', () => {
    assert.deepEqual(skillsSection({ install: ['github:o/r'], agents: ['devin'], bin: 'skills' }), {
      install: ['github:o/r'],
      agents: ['devin'],
      bin: 'skills',
    });
  });
  test('a non-array install stays visible — an invalid entry, not a drop', () => {
    const cfg = skillsSection({ install: 'github:o/r' });
    assert.equal(cfg.install.length, 1);
    assert.equal(parseSkillSource(cfg.install[0]).kind, 'github');
    // a non-string entry keeps its seat — parseSkillSource reports it
    const bad = skillsSection({ install: ['o/r', 7] });
    assert.equal(bad.install.length, 2);
    assert.equal(parseSkillSource(bad.install[1]).kind, 'invalid');
  });
});

describe('resolveSkillsBin', () => {
  test('config → skills on PATH → npx fallback', () => {
    // no skills bin anywhere → npx
    const bin = resolveSkillsBin('/x', undefined, () => false);
    assert.equal(bin.file, 'npx');
    // the fallback pins the package — a bare `skills` spec would run
    // whatever the registry serves that day
    assert.deepEqual(bin.args, ['-y', 'skills@1.7.4']);
    // skills on PATH → run it directly
    assert.deepEqual(
      resolveSkillsBin('/x', undefined, () => true),
      {
        file: 'skills',
        args: [],
        via: 'path',
      }
    );
  });
  test('a configured command runs directly, probe or not', () => {
    assert.deepEqual(
      resolveSkillsBin('/x', 'skills', () => false),
      {
        file: 'skills',
        args: [],
        via: 'config',
      }
    );
  });
  test('a configured relative path resolves against root', () => {
    assert.equal(resolveSkillsBin('/x', 'bin/skills').file, join('/x', 'bin/skills'));
  });
});

describe('local skills', () => {
  test('localSkillName reads the frontmatter name, basename fallback', () => {
    const root = tmp();
    makeSkill(join(root, 'skills', 'bro-herdr'), 'bro-herdr');
    assert.equal(localSkillName(root, 'skills/bro-herdr'), 'bro-herdr');
    assert.equal(localSkillName(root, 'skills/nope'), 'nope');
  });

  test('ensureLocalLink symlinks into .agents/skills', () => {
    const root = tmp();
    makeSkill(join(root, 'skills', 'bro-herdr'), 'bro-herdr');
    const link = ensureLocalLink(root, 'skills/bro-herdr');
    assert.equal(link.state, 'linked');
    const p = join(root, '.agents', 'skills', 'bro-herdr');
    assert.equal(lstatSync(p).isSymbolicLink(), true);
    assert.equal(realpathSync(p), realpathSync(join(root, 'skills', 'bro-herdr')));
  });

  test('a link pointing elsewhere is an error — never silently repointed', () => {
    const root = tmp();
    makeSkill(join(root, 'a'), 'x');
    makeSkill(join(root, 'b'), 'x');
    ensureLocalLink(root, 'a');
    const again = ensureLocalLink(root, 'a');
    assert.equal(again.state, 'linked');
    const moved = ensureLocalLink(root, 'b');
    assert.equal(moved.state, 'error');
    assert.equal(realpathSync(join(root, '.agents', 'skills', 'x')), realpathSync(join(root, 'a')));
    // a real directory in the way is reported, never replaced
    const root2 = tmp();
    const dir = join(root2, '.agents', 'skills', 'x');
    makeSkill(dir, 'x');
    makeSkill(join(root2, 'src'), 'x');
    const blocked = ensureLocalLink(root2, 'src');
    assert.equal(blocked.state, 'present');
    assert.equal(lstatSync(dir).isSymbolicLink(), false);
  });

  test('a local source without SKILL.md is an error', () => {
    const root = tmp();
    mkdirSync(join(root, 'empty'), { recursive: true });
    assert.equal(ensureLocalLink(root, 'empty').state, 'error');
  });
});

describe('collectRows', () => {
  test('a path-pinned source names its skill — missing until installed', () => {
    const root = tmp();
    const { rows } = collectRows(root, cfg(['github:o/r/skills/s1']));
    assert.deepEqual(
      rows.map(r => [r.name, r.state]),
      [['s1', 'missing']]
    );
    // a repo-level source's names are unknown until the lock records them
    const repo = collectRows(root, cfg(['github:o/r']));
    assert.deepEqual(
      repo.rows.map(r => r.state),
      ['pending']
    );
    // a lock entry nothing declares reconciles as extra
    makeSkill(join(root, '.agents', 'skills', 's9'), 's9');
    writeLock(root, { s9: lockEntry(root, 's9', 'other/r') });
    const again = collectRows(root, cfg(['github:o/r/skills/s1']));
    assert.deepEqual(
      again.rows.map(r => [r.name, r.state]),
      [
        ['s1', 'missing'],
        ['s9', 'extra'],
      ]
    );
  });

  test('locked+installed verifies ok; missing reports drift', () => {
    const root = tmp();
    makeSkill(join(root, '.agents', 'skills', 's1'), 's1');
    writeLock(root, { s1: lockEntry(root, 's1', 'o/r') });
    const { rows, drift } = collectRows(root, cfg(['github:o/r/skills/s1']));
    assert.deepEqual(
      rows.map(r => r.state),
      ['ok']
    );
    assert.equal(drift.length, 0);
    // delete the install → missing in both rows and drift
    const root2 = tmp();
    writeLock(root2, { s1: { source: 'o/r', computedHash: 'x', ref: 'a' } });
    const miss = collectRows(root2, cfg(['github:o/r/skills/s1']));
    assert.equal(miss.rows[0]!.state, 'missing');
    assert.equal(miss.drift[0]!.kind, 'missing');
  });

  test('tampered content is drifted', () => {
    const root = tmp();
    const dir = join(root, '.agents', 'skills', 's1');
    makeSkill(dir, 's1');
    writeLock(root, { s1: lockEntry(root, 's1', 'o/r') });
    writeFileSync(join(dir, 'extra.md'), 'tampered\n');
    const { rows, drift } = collectRows(root, cfg(['github:o/r/skills/s1']));
    assert.equal(rows[0]!.state, 'drifted');
    assert.equal(drift[0]!.kind, 'drifted');
  });

  test('a local row reports linked vs missing vs present', () => {
    const root = tmp();
    makeSkill(join(root, 'skills', 'lx'), 'lx');
    assert.equal(collectRows(root, cfg(['local:skills/lx'])).rows[0]!.state, 'missing');
    ensureLocalLink(root, 'skills/lx');
    assert.equal(collectRows(root, cfg(['local:skills/lx'])).rows[0]!.state, 'linked');
    const root2 = tmp();
    makeSkill(join(root2, 'skills', 'lx'), 'lx');
    makeSkill(join(root2, '.agents', 'skills', 'lx'), 'lx');
    assert.equal(collectRows(root2, cfg(['local:skills/lx'])).rows[0]!.state, 'present');
  });

  test('an invalid source is an error row', () => {
    const { rows } = collectRows(tmp(), cfg(['nonsense']));
    assert.equal(rows[0]!.state, 'error');
  });
});

describe('runSync', () => {
  test('adds github sources, links locals, skips nothing extra', () => {
    const root = tmp();
    makeSkill(join(root, 'skills', 'lx'), 'lx');
    const { spawn, calls } = fakeSpawn({ materialize: true });
    const out = runSync(root, cfg(['github:o/r/skills/s1', 'local:skills/lx']), spawn);
    assert.equal(out.failed, false);
    assert.deepEqual(calls, [['add', 'o/r', '-s', 's1', '-a', 'universal', '-y']]);
    const steps = new Map(out.steps.map(s => [s.state, s.label]));
    assert.equal(steps.get('ok') !== undefined, true);
    assert.equal(lstatSync(join(root, '.agents', 'skills', 'lx')).isSymbolicLink(), true);
  });

  test('a locked path-skill is not re-added', () => {
    const root = tmp();
    makeSkill(join(root, '.agents', 'skills', 's1'), 's1');
    writeLock(root, { s1: lockEntry(root, 's1', 'o/r') });
    const { spawn, calls } = fakeSpawn();
    const out = runSync(root, cfg(['github:o/r/skills/s1']), spawn);
    assert.deepEqual(calls, []);
    assert.equal(out.steps[0]!.state, 'skipped');
    assert.equal(out.failed, false);
  });

  test('a lock gap triggers one experimental_install', () => {
    const root = tmp();
    writeLock(root, { s9: { source: 'o/r', computedHash: 'x', ref: 'a' } });
    const { spawn, calls } = fakeSpawn();
    runSync(root, cfg(['github:o/r']), spawn);
    assert.deepEqual(calls, [
      ['add', 'o/r', '-a', 'universal', '-y'],
      ['experimental_install', '-y'],
    ]);
  });

  test('a failing add fails the run; an invalid source fails too', () => {
    const root = tmp();
    const { spawn } = fakeSpawn({ failOn: args => args[0] === 'add' });
    const out = runSync(root, cfg(['github:o/r', 'nonsense']), spawn);
    assert.equal(out.failed, true);
    assert.equal(out.steps.filter(s => s.state === 'error').length, 2);
  });

  test('post-sync drift fails the run', () => {
    const root = tmp();
    writeLock(root, { s1: { source: 'o/r', computedHash: 'x', ref: 'a' } });
    // the fake install does not restore s1 → still missing after sync
    const { spawn } = fakeSpawn();
    const out = runSync(root, cfg([]), spawn);
    assert.equal(out.failed, true);
    assert.equal(out.drift[0]!.kind, 'missing');
  });

  test('agents config reaches the add argv', () => {
    const root = tmp();
    const { spawn, calls } = fakeSpawn();
    runSync(root, cfg(['o/r'], { agents: ['devin', 'claude-code'] }), spawn);
    assert.deepEqual(calls[0], ['add', 'o/r', '-a', 'devin', '-a', 'claude-code', '-y']);
  });
});
