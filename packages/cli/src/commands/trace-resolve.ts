/**
 * `bro trace <ref>` — artifact → provenance resolver (spec
 * bro-7d5nb §traceability). A positional ref (commit-ish, PR
 * number/URL, branch) resolves
 *
 *   branch→worktree→registry→agent→provider/model→formula@sha→mol step
 *
 * and reports VERIFIED when the artifact's attested stamps agree with
 * the registry, FORGED on a mismatch, MISSING on absence. The
 * mechanics live in @broject/pipeline's trace.ts — this file binds
 * the real seams (agents.json, git, gh) and prints.
 *
 * `bro trace export …` stays the OTLP journal exporter — trace.ts
 * dispatches here for every other argv shape.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EXIT, ghTry, gitTry, hasHelpFlag, printUsage, readAgentRegistry } from '@broject/core';
import {
  detectKind,
  prTraceFooter,
  resolveTrace,
  TRACE_FOOTER_MARK,
  type ArtifactTrace,
  type TraceDeps,
  type TraceEntryView,
  type TraceHop,
  type TraceRefKind,
} from '@broject/pipeline';
import { parseWorktreePorcelain } from './work.ts';

export const RESOLVE_USAGE =
  'usage: bro trace <ref> [--kind commit|pr|branch] [--json]   ' +
  '(refs: commit-ish | PR number/URL | branch)\n' +
  '       bro trace stamp — write the env-attested footer onto the ' +
  "current branch's PR body (idempotent)\n" +
  '       bro trace export [--session <id>] [--dry-run] [--json]';

/** Read the trailing trailer block of a commit-ish — undefined when
 *  the ref doesn't resolve (git itself rejected it). */
function commitMessage(dir: string, ref: string): string | undefined {
  const r = gitTry(['-C', dir, 'log', '-1', '--format=%B', ref]);
  return r.code === 0 ? r.out : undefined;
}

/** Linked worktrees as the resolver's {path, branch} pairs — detached
 *  entries carry no branch and just sit out. */
function worktrees(dir: string): { path: string; branch: string }[] {
  const r = gitTry(['-C', dir, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) {
    return [];
  }
  return parseWorktreePorcelain(r.out)
    .filter(w => w.branch !== undefined && w.branch !== '')
    .map(w => ({ path: w.path, branch: w.branch! }));
}

/** `gh pr view` — body + head branch. Undefined on any failure (gh
 *  missing, no such PR, not a repo) — the resolver treats an
 *  unreadable PR view as no attestation, never a crash. */
function prView(dir: string, ref: string): { body?: string; headRefName?: string } | undefined {
  const r = ghTry(['pr', 'view', ref, '--json', 'body,headRefName'], dir);
  if (r.code !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(r.out) as { body?: string; headRefName?: string };
  } catch {
    return undefined;
  }
}

/** Real-probe kind detection: PR-shaped refs probe `gh pr view` first
 *  (a numeric-looking branch name still gets its chance when no PR
 *  answers); a checked-out local branch beats a commit-ish guess
 *  because the worktree hop is the stronger chain. Undefined when
 *  nothing answers — detectKind's lexical fallback stays the
 *  resolver's last word. */
export function detectRefKind(dir: string, ref: string): TraceRefKind | undefined {
  if (detectKind(ref) === 'pr' && prView(dir, ref) !== undefined) {
    return 'pr';
  }
  if (gitTry(['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${ref}`]).code === 0) {
    return 'branch';
  }
  if (gitTry(['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code === 0) {
    return 'commit';
  }
  if (detectKind(ref) === 'pr') {
    return 'pr'; // shaped like one even though the view failed — let the verdict say missing
  }
  return undefined;
}

/** The deps binding — registry + git + gh over one repo dir. */
export function traceDeps(dir: string): TraceDeps {
  return {
    // TraceEntryView is a read projection of the registry record —
    // untyped entry fields (worktree, sessionId) arrive through the
    // record's index signature as `unknown`, so the honest cast goes
    // through unknown (the view reads every field optionally anyway)
    registry: () => readAgentRegistry(dir) as unknown as Record<string, TraceEntryView>,
    commitMessage: ref => commitMessage(dir, ref),
    worktrees: () => worktrees(dir),
    prView: ref => prView(dir, ref),
    kind: ref => detectRefKind(dir, ref),
  };
}

// --- report ---------------------------------------------------------------------

const VERDICT_WORD: Record<ArtifactTrace['verdict'], string> = {
  verified: 'VERIFIED',
  forged: 'FORGED',
  missing: 'MISSING',
};

const HOP_MARK: Record<TraceHop['state'], string> = {
  match: '✓',
  mismatch: '✗',
  unattested: '·',
};

const HOP_TAIL: Record<TraceHop['state'], string> = {
  match: 'registry agrees',
  mismatch: 'registry says',
  unattested: 'not attested',
};

function hopLine(h: TraceHop): string {
  const attested = h.attested ?? '—';
  const registry = h.registry ?? '—';
  const tail = h.state === 'mismatch' ? `registry says ${registry}` : HOP_TAIL[h.state];
  return `  ${HOP_MARK[h.state]} ${h.hop.padEnd(7)} ${attested} — ${tail}`;
}

/** The resolved-record rows — absent fields simply don't print. */
function resolvedLines(t: ArtifactTrace): string[] {
  const resolved: [string, string | undefined][] = [
    ['agent', t.agent],
    ['provider', t.provider],
    ['model', t.model],
    ['session', t.session],
    ['formula', t.formula],
    ['mol step', t.molStep],
    ['stage', t.pipelineStage],
    ['worktree', t.worktree],
    ['backend', t.backend],
    ['via', t.via],
  ];
  return resolved.filter(([, v]) => v !== undefined).map(([k, v]) => `    ${k.padEnd(8)} ${v}`);
}

/** The human report — resolved record first, then the per-hop
 *  verification table, then the detail line. */
export function formatTrace(t: ArtifactTrace): string {
  const lines: string[] = [`${VERDICT_WORD[t.verdict]}  ${t.ref} (${t.kind})`, ...resolvedLines(t)];
  if (t.hops.length > 0) {
    lines.push('  hops:', ...t.hops.map(hopLine));
  }
  if (t.detail !== undefined) {
    lines.push(`    ${t.detail}`);
  }
  return lines.join('\n');
}

interface ResolveArgs {
  ref: string;
  kind: TraceRefKind | undefined;
  json: boolean;
}

const RESOLVE_KINDS = ['commit', 'pr', 'branch'] as const;

/** Exported for tests — arg parsing is the command's one branchy
 *  corner (flag order, a dangling --kind, a flag-shaped ref). */
export function parseResolveArgs(args: string[]): ResolveArgs | null {
  const rest = [...args];
  let kind: TraceRefKind | undefined;
  const ki = rest.indexOf('--kind');
  if (ki >= 0) {
    const v = rest.splice(ki, 2)[1] as TraceRefKind | undefined;
    if (!RESOLVE_KINDS.includes(v as TraceRefKind)) {
      return null;
    }
    kind = v;
  }
  const ji = rest.indexOf('--json');
  if (ji >= 0) {
    rest.splice(ji, 1);
  }
  if (rest.length !== 1 || rest[0]!.startsWith('-')) {
    return null;
  }
  return { ref: rest[0]!, kind, json: ji >= 0 };
}

// --- PR footer stamp -------------------------------------------------------------
//
// The spec's "PR → body footer: run/formula/session line" writer. bro
// never authors PR bodies — the WORKER runs `gh pr create` — so the
// stamp rides the post-tool hook: a landed create respawns
// `bro trace stamp` detached, this process reads the env-attested pins
// (BRO_FORMULA is the connector's attestation — absent means there is
// nothing honest to write) and appends the footer to the branch's own
// PR. Same hint contract as the commit trailers: the mark proves
// nothing alone, `bro trace <pr>` verifies it against the registry.

type GhProbe = (args: string[], cwd?: string) => { code: number; out: string; err: string };

/** Stamp the current branch's PR body with the env-attested footer.
 *  'unattested' — env pins don't carry run+formula (a human or a
 *  legacy spawn — nothing honest to write); 'skipped' — no PR on this
 *  branch, an unreadable body, the mark already present, or the edit
 *  failed; 'stamped' — the footer landed. Never throws: this runs as
 *  the detached post-tool respawn where any failure is silence. */
export function stampBranchPr(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  gh: GhProbe = ghTry
): 'stamped' | 'skipped' | 'unattested' {
  try {
    const formula = env.BRO_FORMULA?.trim();
    const run = env.BRO_AGENT_ID?.trim();
    if (formula === undefined || formula === '' || run === undefined || run === '') {
      return 'unattested';
    }
    const view = gh(['pr', 'view', '--json', 'body'], dir);
    if (view.code !== 0) {
      return 'skipped';
    }
    let body: unknown;
    try {
      body = (JSON.parse(view.out) as { body?: unknown }).body;
    } catch {
      return 'skipped';
    }
    if (typeof body !== 'string' || body.includes(TRACE_FOOTER_MARK)) {
      return 'skipped';
    }
    const session = env.BRO_SESSION_ID?.trim();
    const footer = prTraceFooter({
      run,
      formula,
      session: session === undefined || session === '' ? run : session,
    });
    const edit = gh(['pr', 'edit', '--body', `${body.trimEnd()}\n\n${footer}\n`], dir);
    return edit.code === 0 ? 'stamped' : 'skipped';
  } catch {
    return 'skipped';
  }
}

/** Detached `bro trace stamp` respawn — the auto-flush pattern:
 *  argv[1] is this CLI's entry in dev and installs alike, execPath
 *  sidesteps shim rules, detached+ignore+unref returns instantly. The
 *  stamp itself is idempotent (the mark check), so a racing double
 *  spawn costs one extra `gh pr view`, never a second footer. */
function spawnStamp(entry: string, dir: string): void {
  const child = spawn(process.execPath, [entry, 'trace', 'stamp'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

/** The hook half: env pins carry the attestation (BRO_FORMULA is the
 *  connector's — a worker can fake it and the resolver catches the
 *  forgery, a missing pin means nothing was ever attested). Every
 *  failure degrades to silence — the stamp must never stall the
 *  session or fail a hook. */
export function maybeSpawnTraceStamp(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: (entry: string, dir: string) => void = spawnStamp
): void {
  try {
    if (env.BRO_FORMULA === undefined || env.BRO_FORMULA.trim() === '') {
      return;
    }
    const entry = process.argv[1];
    if (entry === undefined || !existsSync(entry)) {
      return;
    }
    spawnFn(entry, dir);
  } catch {
    // the stamp never affects the agent — silence is the contract
  }
}

export async function runTraceResolve(argv: string[]): Promise<void> {
  // `bro trace stamp` — the detached post-tool writer; exit is always
  // ok: a stamp failure is a missing hint, never a hook failure
  if (argv[0] === 'stamp' && !hasHelpFlag(argv)) {
    stampBranchPr(process.cwd());
    process.exit(EXIT.ok);
  }
  const args = hasHelpFlag(argv) ? null : parseResolveArgs(argv);
  if (args === null) {
    printUsage(RESOLVE_USAGE, hasHelpFlag(argv) ? EXIT.ok : EXIT.usage);
    return; // printUsage is `never` — the return documents the exit, not the type
  }
  const dir = process.cwd();
  const t = resolveTrace(args.ref, traceDeps(dir), args.kind);
  if (args.json) {
    console.log(JSON.stringify(t, null, 2));
  } else {
    console.log(formatTrace(t));
  }
  // a piped console.log can hold unflushed bytes — drain before the
  // exit lands so a truncated report never masquerades as the verdict
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  process.exit(t.verdict === 'verified' ? EXIT.ok : EXIT.error);
}
