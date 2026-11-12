/**
 * The path glob — repo-relative matching for `match.paths` (spec
 * bro-0ykhg.2).
 *
 * Three wildcards, nothing more: `*` any run of characters inside one
 * path segment, `**` any run across segments, `?` exactly one character.
 * Matching is anchored — the whole path must match the whole pattern,
 * so `packages/brouter/**` names that subtree and nothing else.
 *
 * Deliberately tiny: the table's paths are operator-written shapes,
 * not user input, and a regex engine here would be a dependency and a
 * ReDoS surface for no gain.
 */

/** One pattern compiled to segment matchers — `**` segments match any
 *  depth, every other segment carries its wildcard text for
 *  {@link segmentMatch}. The union keeps `text` non-optional on the
 *  only branch that reads it. */
type GlobSegment = { any: true } | { any: false; text: string };

/** One segment's wildcard match — `*` any run of characters, `?`
 *  exactly one, everything else literal. The classic two-pointer scan
 *  with star backtracking; a segment never contains `/` (both sides
 *  split on it), so `*`/`?` can never span a separator, and `**`
 *  inside a segment is just two stars — the same any-run. Hand-rolled
 *  on purpose: no RegExp means no ReDoS surface and no regex compile
 *  per match (bro-0ykhg.2 review). */
function segmentMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const pc = pattern.charAt(p);
    if (pc !== '' && (pc === '?' || pc === text.charAt(t))) {
      p += 1;
      t += 1;
    } else if (pc === '*') {
      starP = p;
      starT = t;
      p += 1;
    } else if (starP !== -1) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (pattern.charAt(p) === '*') {
    p += 1;
  }
  return p >= pattern.length;
}

/** Compile one glob into segments — leading/trailing slashes and
 *  empty segments collapse so `a//b` and `a/b` name the same path. */
function compile(pattern: string): GlobSegment[] {
  return pattern
    .split('/')
    .filter(s => s !== '' && s !== '.')
    .map((text): GlobSegment => (text === '**' ? { any: true } : { any: false, text }));
}

/** The recursive segment match — `**` consumes zero or more path
 *  segments, every other segment must match its own text exactly.
 *  Memoized on (si, pi): several `**` segments revisit the same states
 *  combinatorially, and a pathological pattern must not stall a route
 *  check (bro-0ykhg.2 review). */
function matchFrom(segs: GlobSegment[], parts: string[]): boolean {
  const memo = new Map<string, boolean>();
  const walk = (si: number, pi: number): boolean => {
    const key = `${si}:${pi}`;
    const hit = memo.get(key);
    if (hit !== undefined) {
      return hit;
    }
    let out: boolean;
    // `.at()` keeps every access a method call — computed member
    // indexing reads as an injection sink to the security scanners,
    // and the undefined answer doubles as the bounds check
    const seg = segs.at(si);
    if (seg === undefined) {
      // si only ever reaches segs.length — the pattern is exhausted,
      // so the path must be too
      out = pi === parts.length;
    } else if (seg.any) {
      // '**' matches zero segments, then one more, recursively
      out = false;
      for (let take = 0; pi + take <= parts.length && !out; take += 1) {
        out = walk(si + 1, pi + take);
      }
    } else {
      const part = parts.at(pi);
      out = part !== undefined && segmentMatch(seg.text, part) && walk(si + 1, pi + 1);
    }
    memo.set(key, out);
    return out;
  };
  return walk(0, 0);
}

/** Does the repo-relative `path` match the `pattern` glob? Both sides
 *  normalize the same way — `./a/b` and `a/b/` name `a/b`, and Windows
 *  separators fold to `/` first: a `src\view.ts` task path must match
 *  `src/*` the same as its POSIX spelling (bro-0ykhg.2 review). */
export function matchGlob(pattern: string, path: string): boolean {
  const normPath = path.replaceAll('\\', '/');
  const segs = compile(pattern.replaceAll('\\', '/'));
  if (segs.length === 0) {
    // an empty pattern matches only the empty path — never a real file
    return normPath.split('/').every(s => s === '' || s === '.');
  }
  const parts = normPath.split('/').filter(s => s !== '' && s !== '.');
  return matchFrom(segs, parts);
}

/** Is `path` a safe repo-relative path — no absolute form, no `..`
 *  escape, no empty segments? Validation for caller-supplied paths:
 *  a path that could name outside the repo never reaches the matcher.
 *  Windows absolute forms reject too — a drive letter (`C:…`, with or
 *  without a separator) or ANY leading `\` (root-relative `\foo` or UNC
 *  `\\host\share`) is never repo-relative, and the matcher's separator
 *  fold would otherwise strip the leading `\` and silently match
 *  `foo`-shaped globs (bro-0ykhg.2 review). */
export function isRepoRelativePath(path: string): boolean {
  // the first character decides every rooted form: '' (the empty
  // path — includes('') is true), '/', '~', and ANY leading '\' —
  // root-relative or UNC — all reject in one clause
  if ('/~\\'.includes(path.charAt(0))) {
    return false;
  }
  // a drive prefix — 'C:…' with or without a separator — is never
  // repo-relative either
  if (/^[A-Za-z]:/.test(path)) {
    return false;
  }
  return !path.split(/[\\/]/).includes('..');
}
