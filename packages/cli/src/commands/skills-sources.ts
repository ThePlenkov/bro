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
const RELATIVE = 'local: must be repo-relative — no absolute paths, no ..';

function localPath(raw: string, spec: string, prefix: string): SkillSource {
  const path = spec.slice(prefix.length).trim();
  if (path === '') {
    return { kind: 'invalid', raw, reason: 'local: needs a repo-relative path' };
  }
  if (isAbsolute(path)) {
    return { kind: 'invalid', raw, reason: RELATIVE };
  }
  if (path.split('/').includes('..')) {
    return { kind: 'invalid', raw, reason: RELATIVE };
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
  if (!GH_REPO.test(repo)) {
    return { kind: 'invalid', raw, reason: 'github: needs <owner>/<repo>[/<path>]' };
  }
  if (dotSeg(repo)) {
    return { kind: 'invalid', raw, reason: 'github: needs <owner>/<repo>[/<path>]' };
  }
  if (rest.length === 0) {
    return { kind: 'github', repo, raw };
  }
  const path = rest.join('/');
  return { kind: 'github', repo, path, skill: basename(path), raw };
}

function parseUrlSource(raw: string, spec: string): SkillSource | null {
  if (spec.startsWith('http://')) {
    return { kind: 'invalid', raw, reason: 'plaintext http:// is not a source — use https://' };
  }
  return spec.startsWith('https://') ? { kind: 'url', url: spec, raw } : null;
}

function parseBareRepo(raw: string, spec: string): SkillSource | null {
  if (!GH_REPO.test(spec)) {
    return null;
  }
  if (dotSeg(spec)) {
    return null;
  }
  return { kind: 'github', repo: spec, raw };
}

/** The grammar, in precedence order — first parser to claim the spec
 *  wins. A parser returns `null` only when the spec is not its shape. */
const SOURCE_PARSERS = [parseLocalSource, parseGithubSource, parseUrlSource, parseBareRepo];

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
  for (const parse of SOURCE_PARSERS) {
    const src = parse(raw, spec);
    if (src !== null) {
      return src;
    }
  }
  return {
    kind: 'invalid',
    raw,
    reason:
      'expected github:<owner>/<repo>[/<path>], <owner>/<repo>, an https:// URL, or local:<path>',
  };
}

/** The skill a `/tree/<ref>/<path…>` URL names — the basename of the
 *  pinned path. A URL without a tree path names no single skill. */
function urlTreeSkill(url: string): string | undefined {
  const segs = url.split('/').filter(s => s !== '');
  const treeAt = segs.indexOf('tree');
  if (treeAt < 0) {
    return undefined;
  }
  if (segs.length <= treeAt + 2) {
    return undefined;
  }
  return segs.at(-1);
}

/** `https://github.com/<owner>/<repo>[/tree/<ref>/<path…>]` — the repo a
 *  URL source records in the lock, plus the one skill a `/tree/` URL
 *  names (the CLI accepts tree URLs; the lock's `source` is the repo). */
function urlRepo(url: string): { repo: string; skill?: string } | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(url);
  if (m?.[1] === undefined) {
    return null;
  }
  return { repo: m[1].replace(/\.git$/, ''), skill: urlTreeSkill(url) };
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

function lockedNamesMatching(
  locked: Map<string, LockedSkill>,
  match: (e: LockedSkill) => boolean
): string[] {
  return [...locked.values()].filter(match).map(e => e.name);
}

function githubLockNames(
  src: SkillSource & { kind: 'github' },
  locked: Map<string, LockedSkill>
): string[] {
  if (src.skill !== undefined) {
    return [src.skill];
  }
  return lockedNamesMatching(locked, e => e.source === src.repo);
}

function urlLockNames(url: string, locked: Map<string, LockedSkill>): string[] {
  const u = urlRepo(url);
  if (u?.skill !== undefined) {
    return [u.skill];
  }
  const want = u?.repo ?? normSource(url);
  return lockedNamesMatching(locked, e => normSource(e.source) === want);
}

/** Which lock entries a github/URL source is expected to cover —
 *  a pinned path names one skill; a bare repo/URL is covered by the
 *  entries it recorded (`source` matches, normalized, on any host). */
export function lockNamesFor(src: SkillSource, locked: Map<string, LockedSkill>): string[] {
  if (src.kind === 'github') {
    return githubLockNames(src, locked);
  }
  if (src.kind === 'url') {
    return urlLockNames(src.url, locked);
  }
  return [];
}
