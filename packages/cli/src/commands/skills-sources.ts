/**
 * `skills.install` source descriptors — the grammar, parsing, and
 * lock-name matching for `bro skills`. Leaf module: no fs, no spawn.
 */
import { basename, isAbsolute } from 'node:path';
import type { LockedSkill } from '@broject/core';

export type SkillSource =
  | { kind: 'github'; repo: string; path?: string; skill?: string; raw: string }
  | { kind: 'url'; url: string; raw: string }
  | { kind: 'local'; path: string; raw: string }
  | { kind: 'invalid'; raw: string; reason: string };

/** `<owner>/<repo>` — the two leading path segments a github: source
 *  (or a bare shorthand) must carry. `.` is legal in names, so `.`/`..`
 *  segments get a separate check — `../x` is not a repository. */
const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const dotSeg = (repo: string): boolean => repo.split('/').some(s => s === '.' || s === '..');

/** A `local:` path must stay inside the checkout — absolute paths and
 *  `..` segments would link outside content into `.agents/skills/`. */
function localPath(raw: string, spec: string, prefix: string): SkillSource {
  const path = spec.slice(prefix.length).trim();
  if (path === '') {
    return { kind: 'invalid', raw, reason: 'local: needs a repo-relative path' };
  }
  if (isAbsolute(path) || path.split('/').includes('..')) {
    return {
      kind: 'invalid',
      raw,
      reason: 'local: must be repo-relative — no absolute paths, no ..',
    };
  }
  return { kind: 'local', path, raw };
}

function parseLocalSource(raw: string, spec: string): SkillSource | null {
  if (spec.startsWith('local:')) {
    return localPath(raw, spec, 'local:');
  }
  return spec.startsWith('./') ? localPath(raw, spec, '') : null;
}

function parseGithubSource(raw: string, spec: string): SkillSource | null {
  if (!spec.startsWith('github:')) {
    return null;
  }
  const [owner, name, ...rest] = spec
    .slice('github:'.length)
    .split('/')
    .filter(s => s !== '');
  const repo = `${owner ?? ''}/${name ?? ''}`;
  if (!GH_REPO.test(repo) || dotSeg(repo)) {
    return { kind: 'invalid', raw, reason: 'github: needs <owner>/<repo>[/<path>]' };
  }
  if (rest.length === 0) {
    return { kind: 'github', repo, raw };
  }
  const path = rest.join('/');
  return { kind: 'github', repo, path, skill: basename(path), raw };
}

/** One `skills.install` entry → a typed source. Anything outside the
 *  grammar is `invalid` — reported by the command, never skipped. */
export function parseSkillSource(raw: unknown): SkillSource {
  if (typeof raw !== 'string') {
    return {
      kind: 'invalid',
      raw: JSON.stringify(raw) ?? '?',
      reason: 'skills.install entries must be strings (the section a string array)',
    };
  }
  const spec = raw.trim();
  const local = parseLocalSource(raw, spec);
  if (local !== null) {
    return local;
  }
  const github = parseGithubSource(raw, spec);
  if (github !== null) {
    return github;
  }
  if (spec.startsWith('http://')) {
    return { kind: 'invalid', raw, reason: 'plaintext http:// is not a source — use https://' };
  }
  if (spec.startsWith('https://')) {
    return { kind: 'url', url: spec, raw };
  }
  if (GH_REPO.test(spec) && !dotSeg(spec)) {
    return { kind: 'github', repo: spec, raw };
  }
  return {
    kind: 'invalid',
    raw,
    reason:
      'expected github:<owner>/<repo>[/<path>], <owner>/<repo>, an https:// URL, or local:<path>',
  };
}

/** `https://github.com/<owner>/<repo>[/tree/<ref>/<path…>]` — the repo a
 *  URL source records in the lock, plus the one skill a `/tree/` URL
 *  names (the CLI accepts tree URLs; the lock's `source` is the repo). */
function urlRepo(url: string): { repo: string; skill?: string } | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(url);
  if (m?.[1] === undefined) {
    return null;
  }
  const repo = m[1].replace(/\.git$/, '');
  const segs = url.split('/').filter(s => s !== '');
  const treeAt = segs.indexOf('tree');
  const skill = treeAt >= 0 && segs.length > treeAt + 2 ? segs.at(-1) : undefined;
  return skill !== undefined ? { repo, skill } : { repo };
}

/** A source string compared for equality — scheme, `git@` form, `.git`
 *  suffix and trailing slash normalized away so `https://host/o/r` and
 *  `git@host:o/r.git` name the same thing. */
function normSource(s: string): string {
  return s
    .replace(/^https?:\/\//, '')
    .replace(/^git@([^:/]+)[:/]/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** Which lock entries a github/URL source is expected to cover —
 *  a pinned path names one skill; a bare repo/URL is covered by the
 *  entries it recorded (`source` matches, normalized, on any host). */
export function lockNamesFor(src: SkillSource, locked: Map<string, LockedSkill>): string[] {
  if (src.kind === 'github' && src.skill !== undefined) {
    return [src.skill];
  }
  if (src.kind === 'url') {
    const u = urlRepo(src.url);
    if (u?.skill !== undefined) {
      return [u.skill];
    }
    const want = u?.repo ?? normSource(src.url);
    return [...locked.values()].filter(e => normSource(e.source) === want).map(e => e.name);
  }
  if (src.kind === 'github') {
    return [...locked.values()].filter(e => e.source === src.repo).map(e => e.name);
  }
  return [];
}
