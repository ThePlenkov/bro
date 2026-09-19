/**
 * refs/bro/data — artifact sync on a standalone data ref.
 *
 * Git-memory artifacts (the review-debt ledger, evidence packs, future
 * plugin state) live on an orphan ref OUTSIDE refs/heads, so they never
 * appear in MR diffs or reviewer context. All writes go through plumbing
 * with a private GIT_INDEX_FILE — the worktree and the user's index are
 * never touched. The synced set is untracked+ignored files only
 * (`ls-files -o -i --exclude-standard`): tracked repo content can't
 * leak into the data ref by construction.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git, gitTry } from './git.ts'

export const DATA_REF = 'refs/bro/data'

function g(root: string, args: string[], input?: string): string {
  const proc = execFileSync('git', ['-C', root, ...args], { // NOSONAR — git PATH lookup is the contract (same as gh/bd)
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return proc.trim()
}

/** Untrimmed read — file contents must survive byte-for-byte. */
function gRaw(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { // NOSONAR — PATH contract
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Resolve the repo root for cwd, or null outside a worktree. */
export function dataRefRoot(cwd: string = process.cwd()): string | null {
  const r = gitTry(['-C', cwd, 'rev-parse', '--show-toplevel'])
  return r.code === 0 ? r.out.trim() : null
}

function refSha(root: string, ref: string): string | null {
  const r = gitTry(['-C', root, 'rev-parse', '--verify', '--quiet', ref])
  return r.code === 0 ? r.out.trim() : null
}

/** All git ops share one throwaway index bound to the repo root —
 *  created empty per call so a crashed process can't leave a half-staged
 *  private index behind. */
function withIndex<T>(
  root: string,
  fn: (ix: (args: string[], input?: string) => string) => T
): T {
  const dir = mkdtempSync(join(tmpdir(), 'bro-dataref-'))
  const indexPath = join(dir, 'index')
  const ix = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', root, ...args], { // NOSONAR — PATH contract
      encoding: 'utf8',
      input,
      env: { ...process.env, GIT_INDEX_FILE: indexPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  try {
    return fn(ix)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface TreeEntry {
  mode: string
  sha: string
}

/** `git ls-tree -rz` → path → {mode, sha}. */
function treeEntries(root: string, sha: string): Map<string, TreeEntry> {
  const out = g(root, ['ls-tree', '-rz', sha])
  const map = new Map<string, TreeEntry>()
  for (const rec of out.split('\0')) {
    if (rec === '') {
      continue
    }
    const tab = rec.indexOf('\t')
    const [mode, , sha] = rec.slice(0, tab).split(' ')
    map.set(rec.slice(tab + 1), { mode: mode!, sha: sha! })
  }
  return map
}

/** Line-union merge for append-only JSONL — order preserved, dupes dropped. */
function unionJsonl(a: string, b: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of `${a}\n${b}`.split('\n')) {
    const t = line.trim()
    if (t === '' || seen.has(t)) {
      continue
    }
    seen.add(t)
    out.push(t)
  }
  return `${out.join('\n')}\n`
}

/** Tree-level merge of two data-ref heads: .jsonl unions by line, every
 *  other conflict resolves to ours — regenerated artifacts (summaries,
 *  indexes) are safe to clobber and the JSONL holds the real history. */
function mergeDataHeads(root: string, ref: string, ours: string, theirs: string): void {
  const a = treeEntries(root, ours)
  const merged = new Map(a)
  for (const [path, e] of treeEntries(root, theirs)) {
    const cur = merged.get(path)
    if (!cur) {
      merged.set(path, e)
      continue
    }
    if (cur.sha !== e.sha && path.endsWith('.jsonl')) {
      const union = unionJsonl(
        g(root, ['show', `${ours}:${path}`]),
        g(root, ['show', `${theirs}:${path}`])
      )
      merged.set(path, { mode: '100644', sha: g(root, ['hash-object', '-w', '--stdin'], union) })
    }
  }
  const tree = withIndex(root, (ix) => {
    ix(['read-tree', '--empty'])
    let info = ''
    for (const [path, e] of merged) {
      info += `${e.mode} ${e.sha}\t${path}\0`
    }
    ix(['update-index', '-z', '--index-info'], info)
    return ix(['write-tree'])
  })
  const commit = g(root, [
    'commit-tree',
    tree,
    '-p',
    ours,
    '-p',
    theirs,
    '-m',
    'bro data: merge replicas',
  ])
  g(root, ['update-ref', ref, commit, ours])
}

/**
 * Commit the untracked+ignored files under relDir to the data ref.
 * Returns the ref head (existing sha when the tree didn't change, null
 * when there's nothing to sync).
 */
export function dataRefCommit(
  root: string,
  relDir: string,
  message: string,
  ref: string = DATA_REF
): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = refSha(root, ref)
    const result = withIndex(root, (ix) => {
      ix(base ? ['read-tree', base] : ['read-tree', '--empty'])
      const files = ix(['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', relDir])
        .split('\0')
        .filter((f) => f !== '')
      // index entries under relDir that vanished from disk are deletions
      const staged = new Set(
        ix(['ls-files', '-z', '--', relDir]).split('\0').filter(Boolean)
      )
      for (const f of files) {
        ix(['update-index', '--add', '--', f])
        staged.delete(f)
      }
      for (const gone of staged) {
        ix(['update-index', '--remove', '--', gone])
      }
      if (files.length === 0 && staged.size === 0 && base === null) {
        return null // nothing to sync and no ref yet — don't commit an empty tree
      }
      return ix(['write-tree'])
    })
    if (result === null) {
      return null
    }
    const baseTree = base === null ? null : g(root, ['rev-parse', `${base}^{tree}`])
    if (result === baseTree) {
      return base // tree unchanged — no new commit
    }
    const commit = g(
      root,
      ['commit-tree', result, ...(base ? ['-p', base] : []), '-m', message]
    )
    const cas = gitTry(['-C', root, 'update-ref', ref, commit, base ?? ''])
    if (cas.code === 0) {
      return commit
    }
    // a local writer moved the ref mid-commit — rebase our tree on it
  }
  return refSha(root, ref)
}

/**
 * Push the data ref with CAS retry. A rejected push means a replica won
 * the race: fetch it, merge trees (JSONL union), retry. Returns false on
 * offline/no-remote after bounded attempts — callers treat sync as
 * best-effort and warn, never fail the command.
 */
export function dataRefPush(
  root: string,
  remote: string = 'origin',
  ref: string = DATA_REF
): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (gitTry(['-C', root, 'push', remote, `${ref}:${ref}`]).code === 0) {
      return true
    }
    const fetch = gitTry(['-C', root, 'fetch', remote, ref])
    if (fetch.code !== 0) {
      return false // remote has no data ref (or offline) and push still failed
    }
    const theirs = g(root, ['rev-parse', 'FETCH_HEAD'])
    const ours = refSha(root, ref)
    if (ours === null) {
      return false
    }
    // They may already be contained in ours (spurious reject) — retry push.
    if (gitTry(['-C', root, 'merge-base', '--is-ancestor', theirs, ours]).code !== 0) {
      mergeDataHeads(root, ref, ours, theirs)
    }
  }
  return false
}

/**
 * Pull the remote data ref and write its files under the worktree —
 * restores artifacts on a fresh clone. Local-only files are left alone;
 * the ref is the truth for everything it contains. Returns the number of
 * files written, or -1 when no remote ref exists.
 */
export function dataRefPull(
  root: string,
  remote: string = 'origin',
  ref: string = DATA_REF
): number {
  if (gitTry(['-C', root, 'fetch', remote, ref]).code !== 0) {
    return -1
  }
  const theirs = g(root, ['rev-parse', 'FETCH_HEAD'])
  const ours = refSha(root, ref)
  if (ours === null) {
    g(root, ['update-ref', ref, theirs])
  } else if (gitTry(['-C', root, 'merge-base', '--is-ancestor', ours, theirs]).code !== 0) {
    if (gitTry(['-C', root, 'merge-base', '--is-ancestor', theirs, ours]).code === 0) {
      // local ref is ahead — nothing new to materialize
    } else {
      mergeDataHeads(root, ref, ours, theirs)
    }
  } else {
    g(root, ['update-ref', ref, theirs])
  }
  let written = 0
  for (const [path] of treeEntries(root, ref)) {
    const dest = join(root, path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, gRaw(root, ['show', `${ref}:${path}`]))
    written += 1
  }
  return written
}
