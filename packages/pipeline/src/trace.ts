/**
 * Artifact → provenance trace — the `bro trace` resolver half of
 * specs/bro-7d5nb.md §traceability.
 *
 * Provenance stamps are driver-attested hints, never self-certifying
 * facts: a commit trailer or PR footer naming a run proves nothing by
 * itself. The authoritative half is the keyed lookup — this module
 * resolves the chain
 *
 *   commit → trailers ─┐
 *   branch → worktree ─┼→ registry → agent → provider/model →
 *   pr     → footer   ─┘             formula@sha → mol step
 *
 * and then VERIFIES every attested hop against the registry record:
 * VERIFIED on agreement, FORGED on a mismatch (including an attested
 * field the registry never recorded — forged-by-absence), MISSING on
 * no stamps or no resolvable record.
 *
 * The stamp surfaces:
 *   commit trailers  BRO-Run: <agentId> · BRO-Formula: <id>@<sha> ·
 *                    BRO-Session: <id>   (emitted by the driver's
 *                    commit path — the BRO_* env seam
 *                    prepare-commit-msg consumes)
 *   pr body footer   <!-- bro:trace run=… formula=<id>@<sha> session=… -->
 *                    (written by the driver's PR path — prTraceFooter
 *                    is the seam until that path exists)
 *   registry entry   formula / formula_sha / session_id /
 *                    pipeline_stage (stamped at spawn)
 *
 * Everything here is pure resolution logic over injected seams — the
 * registry read, the commit-message read, the worktree list, and the
 * PR view are deps; the CLI binds git/gh, tests bind fixtures.
 */

/** The trailer names the driver's commit path writes — spec-verbatim. */
export const TRACE_TRAILERS = {
  run: 'BRO-Run',
  formula: 'BRO-Formula',
  session: 'BRO-Session',
} as const;

/** The PR-footer sentinel — an HTML comment so the stamp doesn't
 *  render, on one line so a grep finds it whole. */
export const TRACE_FOOTER_MARK = 'bro:trace';

/** What one artifact attests — the three stamp fields. */
export interface TraceStamps {
  /** `BRO-Run` — the agentId the artifact claims produced it. */
  run?: string;
  /** `BRO-Formula` — `<id>@<sha256>` verbatim. */
  formula?: string;
  /** `BRO-Session` — the session id the artifact claims. */
  session?: string;
}

/** Compose the `<id>@<sha>` spelling the stamps and the registry's
 *  formula pair share. */
export function formulaRef(id: string, sha: string): string {
  return `${id}@${sha}`;
}

/** Split `<id>@<sha>` at the LAST '@' — an id containing '@' keeps its
 *  own text and the sha is always the tail. Empty halves fail closed:
 *  a stamp that can't name both is not a formula claim. */
export function splitFormulaRef(ref: string): { id: string; sha: string } | undefined {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) {
    return undefined;
  }
  return { id: ref.slice(0, at), sha: ref.slice(at + 1) };
}

/** The footer line a driver's PR path appends to the body — one
 *  HTML-comment line, `key=value` tokens. Values are token-cleaned:
 *  a space or `-->` would break the mark's own grammar, so they are
 *  stripped rather than let a hostile value smuggle a second footer. */
export function prTraceFooter(stamps: Required<TraceStamps>): string {
  const clean = (v: string): string => v.replace(/-->?|\s+/g, '');
  return (
    `<!-- ${TRACE_FOOTER_MARK} ` +
    `run=${clean(stamps.run)} ` +
    `formula=${clean(stamps.formula)} ` +
    `session=${clean(stamps.session)} -->`
  );
}

/** One footer line's `key=value` tokens — only the three stamp keys
 *  count; an unknown token is forward-compat noise, not an error. */
function footerTokens(out: TraceStamps, inner: string): void {
  for (const tok of inner.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = tok.slice(0, eq);
    if (key === 'run' || key === 'formula' || key === 'session') {
      const value = tok.slice(eq + 1);
      if (value !== '') {
        Reflect.set(out, key, value);
      }
    }
  }
}

/** The footer mark's stamps — string-ops only (no regex): the mark is
 *  one line and the PR body is uncontrolled input, so every scan is a
 *  bounded indexOf/split — there is nothing for a crafted body to
 *  backtrack. */
function footerStamps(body: string): TraceStamps {
  const out: TraceStamps = {};
  const open = `<!-- ${TRACE_FOOTER_MARK} `;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t.startsWith(open)) {
      continue;
    }
    const end = t.indexOf('-->', open.length);
    footerTokens(out, t.slice(open.length, end < 0 ? t.length : end));
    return out; // first mark wins — a forged second footer is noise
  }
  return out;
}

/** `Key: value` with the value's trailing whitespace OUTSIDE the
 *  capture — `(\S[^\n]*\S|\S)` is the linear shape: `[^\n]*` greedy
 *  backtracks once for the final `\S`, so a crafted line full of
 *  spaces walks one path, never a polynomial retry storm (CodeQL's
 *  `(\S.*?)\s*$` complaint). */
const TRAILER_LINE = /^(BRO-Run|BRO-Formula|BRO-Session):\s*(\S[^\n]*\S|\S)\s*$/;
const TRAILER_SHAPED = /^[\w][\w-]*:\s*\S/;
const LEGACY_TRAILER = /^(Session|Bead):\s*(\S[^\n]*\S|\S)\s*$/;

/** Trailer-shaped lines ending the message — git's own rule: trailers
 *  live in the last contiguous `Key: value` block, so a `BRO-Run:`
 *  mentioned mid-body is prose, not a stamp. Also returns the legacy
 *  `Session`/`Bead` values found in that block — resolution hints
 *  only, never attested stamps. */
export function trailerBlock(message: string): {
  stamps: TraceStamps;
  session?: string;
  bead?: string;
} {
  const lines = message.split('\n');
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trimEnd();
    if (line === '') {
      if (block.length > 0) {
        break;
      }
      continue; // trailing blanks aren't part of the block
    }
    if (!TRAILER_SHAPED.test(line)) {
      break;
    }
    block.unshift(line);
  }
  const out: { stamps: TraceStamps; session?: string; bead?: string } = { stamps: {} };
  for (const line of block) {
    const t = TRAILER_LINE.exec(line);
    if (t !== null) {
      const key = t[1] === 'BRO-Run' ? 'run' : t[1] === 'BRO-Formula' ? 'formula' : 'session';
      Reflect.set(out.stamps, key, t[2]);
      continue;
    }
    const l = LEGACY_TRAILER.exec(line);
    if (l !== null) {
      if (l[1] === 'Session') out.session ??= l[2];
      else out.bead ??= l[2];
    }
  }
  return out;
}

/** Parse an artifact's attested stamps. `commit` reads the trailing
 *  trailer block; `pr` reads the footer mark. Unknown text yields {} —
 *  absence is a verdict input, never a parse failure. */
export function parseTraceStamps(text: string | undefined, kind: 'commit' | 'pr'): TraceStamps {
  if (text === undefined) {
    return {};
  }
  return kind === 'pr' ? footerStamps(text) : trailerBlock(text).stamps;
}

// --- registry view ---------------------------------------------------------------

/** The registry-record slice the resolver reads — typed fields plus
 *  the untyped backend session ids entries already carry. */
export interface TraceEntryView {
  agentId?: string;
  backend?: string;
  provider?: string;
  model?: string;
  worktree?: string;
  runId?: string;
  formula?: string;
  formula_sha?: string;
  session_id?: string;
  pipeline_stage?: string;
  /** backend-reported session ids (gascity/copilot `sessionId`, the acp
   *  driver's `acpSessionId`) — session-hop verification reads them as
   *  recorded sessions too */
  sessionId?: string;
  acpSessionId?: string;
}

/** Everything the resolver needs from the world — one dep per store.
 *  A dep left unbound narrows the resolution (never fabricates it):
 *  no `worktrees` means a branch can't reach its registry entry. */
export interface TraceDeps {
  /** molStep → registry record — the authority every hop checks. */
  registry(): Record<string, TraceEntryView>;
  /** The full commit message for a commit-ish (`git log -1 --format=%B`). */
  commitMessage?(ref: string): string | undefined;
  /** Linked worktrees — branch resolution's worktree hop. */
  worktrees?(): { path: string; branch: string }[];
  /** PR body + head branch (`gh pr view`). */
  prView?(ref: string): { body?: string; headRefName?: string } | undefined;
  /** Ref-kind probe — the host's git answers (local branch? commit-ish?).
   *  Unbound refs fall back to the lexical heuristic in detectKind. */
  kind?(ref: string): TraceRefKind | undefined;
}

export type TraceRefKind = 'commit' | 'pr' | 'branch';

export type TraceVerdict = 'verified' | 'forged' | 'missing';

export type TraceHopState = 'match' | 'mismatch' | 'unattested';

export interface TraceHop {
  hop: 'run' | 'formula' | 'session';
  state: TraceHopState;
  /** what the artifact claimed — absent on an unattested hop */
  attested?: string;
  /** what the registry records — absent when the entry has no answer */
  registry?: string;
}

export interface ArtifactTrace {
  ref: string;
  kind: TraceRefKind;
  verdict: TraceVerdict;
  /** the artifact's attested stamps (empty = nothing claimed) */
  stamps: TraceStamps;
  hops: TraceHop[];
  /** the resolved registry record, when one was found */
  molStep?: string;
  agent?: string;
  backend?: string;
  provider?: string;
  model?: string;
  session?: string;
  /** `<id>@<sha>` reconstructed from the registry pair */
  formula?: string;
  pipelineStage?: string;
  worktree?: string;
  /** how the entry was reached — 'run' | 'worktree' | 'session' |
   *  'bead' | 'molStep' — the resolution's own provenance */
  via?: string;
  detail?: string;
}

/** Lexical fallback when deps.kind is unbound — PR-shaped refs are
 *  safe to detect; everything else reads 'commit' (a branch guessed
 *  here simply finds no trailer block → missing, never a wrong
 *  verdict). */
export function detectKind(ref: string): TraceRefKind {
  if (/^#?\d+$/.test(ref) || /\/pull\/\d+/.test(ref) || /\/merge_requests\/\d+/.test(ref)) {
    return 'pr';
  }
  return 'commit';
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** Every session identity an entry records — pipeline's `session_id`
 *  first, then the backend-reported ids. */
function entrySessions(e: TraceEntryView): string[] {
  return [e.session_id, e.sessionId, e.acpSessionId]
    .map(nonEmpty)
    .filter((v): v is string => v !== undefined);
}

interface Hit {
  molStep: string;
  entry: TraceEntryView;
  via: string;
}

/** The keyed lookup — strongest hint first for `rank` order; the FIRST
 *  hit wins because resolution order IS the chain's direction (an
 *  attested run beats a worktree for a commit, the worktree beats
 *  hints for a branch). */
function findEntry(
  reg: Record<string, TraceEntryView>,
  hints: [string, string | undefined][]
): Hit | undefined {
  for (const [how, want] of hints) {
    if (want === undefined) {
      continue;
    }
    for (const [molStep, entry] of Object.entries(reg)) {
      const found =
        how === 'molStep'
          ? molStep === want
          : how === 'worktree'
            ? nonEmpty(entry.worktree) === want
            : how === 'run'
              ? nonEmpty(entry.agentId) === want
              : /* session */ entrySessions(entry).includes(want);
      if (found) {
        return { molStep, entry, via: how };
      }
    }
  }
  return undefined;
}

/** run hop: the attested agentId vs the resolved entry's. */
function runHop(stamps: TraceStamps, entry: TraceEntryView): TraceHop {
  if (stamps.run === undefined) {
    return { hop: 'run', state: 'unattested' };
  }
  const registry = nonEmpty(entry.agentId);
  return {
    hop: 'run',
    state: registry === stamps.run ? 'match' : 'mismatch',
    attested: stamps.run,
    registry,
  };
}

/** formula hop: the attested `<id>@<sha>` vs the registry pair —
 *  reconstructed identically so id/sha can't partially collide. An
 *  attested formula the registry never recorded is a mismatch (the
 *  forged-by-absence case: registry is the authority). */
function formulaHop(stamps: TraceStamps, entry: TraceEntryView): TraceHop {
  if (stamps.formula === undefined) {
    return { hop: 'formula', state: 'unattested' };
  }
  const registry =
    nonEmpty(entry.formula) !== undefined && nonEmpty(entry.formula_sha) !== undefined
      ? formulaRef(entry.formula!, entry.formula_sha!)
      : undefined;
  return {
    hop: 'formula',
    state: registry === stamps.formula ? 'match' : 'mismatch',
    attested: stamps.formula,
    registry,
  };
}

/** session hop: attested vs any recorded session id; the agentId pin
 *  answers ONLY when the entry records no session at all — that is
 *  BRO_SESSION_ID's spawn contract. When the registry knows an
 *  explicit session, a stamp still claiming the agentId contradicts
 *  the record: mismatch, not a match. */
function sessionHop(stamps: TraceStamps, entry: TraceEntryView): TraceHop {
  if (stamps.session === undefined) {
    return { hop: 'session', state: 'unattested' };
  }
  const sessions = entrySessions(entry);
  const registry = sessions[0];
  const agentPin = nonEmpty(entry.agentId);
  const match =
    sessions.includes(stamps.session) || (sessions.length === 0 && stamps.session === agentPin);
  return {
    hop: 'session',
    state: match ? 'match' : 'mismatch',
    attested: stamps.session,
    registry: registry ?? agentPin,
  };
}

function recordOf(
  molStep: string,
  entry: TraceEntryView,
  via: string
): Pick<
  ArtifactTrace,
  | 'molStep'
  | 'agent'
  | 'backend'
  | 'provider'
  | 'model'
  | 'session'
  | 'formula'
  | 'pipelineStage'
  | 'worktree'
  | 'via'
> {
  return {
    molStep,
    agent: nonEmpty(entry.agentId),
    backend: nonEmpty(entry.backend),
    provider: nonEmpty(entry.provider),
    model: nonEmpty(entry.model),
    session: entrySessions(entry)[0] ?? nonEmpty(entry.agentId),
    formula:
      nonEmpty(entry.formula) !== undefined && nonEmpty(entry.formula_sha) !== undefined
        ? formulaRef(entry.formula!, entry.formula_sha!)
        : undefined,
    pipelineStage: nonEmpty(entry.pipeline_stage),
    worktree: nonEmpty(entry.worktree),
    via,
  };
}

/** Resolution-side context an artifact carries beyond its stamps —
 *  the legacy `Session:`/`Bead:` hint trailers, a branch's checked-out
 *  worktree, a PR's head branch. */
interface TraceExtras {
  session?: string;
  bead?: string;
  worktree?: string;
  headBranch?: string;
}

/** Hints a ref's resolution may use, strongest first per kind —
 *  the chain's direction is the spec's: a commit speaks its trailers;
 *  a branch goes through the worktree; a PR through its footer, then
 *  the head branch's worktree. */
function hintsFor(
  kind: TraceRefKind,
  stamps: TraceStamps,
  extra: TraceExtras,
  wt: { path: string; branch: string }[]
): [string, string | undefined][] {
  const byBranch = (b: string | undefined): string | undefined =>
    b === undefined ? undefined : wt.find(w => w.branch === b)?.path;
  if (kind === 'branch') {
    const wtPath = extra.worktree ?? byBranch(extra.headBranch);
    return [
      ['worktree', wtPath],
      ['run', stamps.run],
      ['session', stamps.session ?? extra.session],
      ['molStep', extra.bead],
    ];
  }
  if (kind === 'pr') {
    return [
      ['run', stamps.run],
      ['worktree', byBranch(extra.headBranch)],
      ['session', stamps.session ?? extra.session],
      ['molStep', extra.bead],
    ];
  }
  return [
    ['run', stamps.run],
    ['session', stamps.session ?? extra.session],
    ['molStep', extra.bead],
  ];
}

/** The kind-specific attestation read — a commit speaks its own
 *  trailers; a branch's attestation is its tip commit's trailers plus
 *  its checked-out worktree path; a PR speaks its body footer plus
 *  the head branch name. */
function attestationOf(
  k: TraceRefKind,
  ref: string,
  deps: TraceDeps,
  wt: { path: string; branch: string }[]
): { stamps: TraceStamps; extra: TraceExtras } {
  const extra: TraceExtras = {};
  if (k === 'pr') {
    const view = deps.prView?.(ref);
    extra.headBranch = nonEmpty(view?.headRefName);
    return { stamps: parseTraceStamps(view?.body, 'pr'), extra };
  }
  const msg = deps.commitMessage?.(ref);
  const block = msg === undefined ? { stamps: {} as TraceStamps } : trailerBlock(msg);
  extra.session = block.session;
  extra.bead = block.bead;
  if (k === 'branch') {
    extra.worktree = wt.find(w => w.branch === ref)?.path;
  }
  return { stamps: block.stamps, extra };
}

/** Resolve an artifact's provenance and verify it against the
 *  registry. Never throws — every absence is a verdict input. */
export function resolveTrace(ref: string, deps: TraceDeps, kind?: TraceRefKind): ArtifactTrace {
  const k = kind ?? deps.kind?.(ref) ?? detectKind(ref);
  const wt = deps.worktrees?.() ?? [];
  const reg = deps.registry();
  const { stamps, extra } = attestationOf(k, ref, deps, wt);

  const hit = findEntry(reg, hintsFor(k, stamps, extra, wt));
  const hops: TraceHop[] =
    hit === undefined
      ? []
      : [runHop(stamps, hit.entry), formulaHop(stamps, hit.entry), sessionHop(stamps, hit.entry)];
  const stamped =
    stamps.run !== undefined || stamps.formula !== undefined || stamps.session !== undefined;

  const base: ArtifactTrace = { ref, kind: k, verdict: 'missing', stamps, hops };
  if (hit === undefined) {
    return {
      ...base,
      detail: stamped
        ? 'stamps resolve to no registry entry — unbacked attestation'
        : 'no trace stamps and no registry record resolved',
    };
  }
  const record = recordOf(hit.molStep, hit.entry, hit.via);
  if (!stamped) {
    return {
      ...base,
      ...record,
      detail: `no trace stamps on the artifact — registry-only resolution via ${hit.via}`,
    };
  }
  const forged = hops.some(h => h.state === 'mismatch');
  return {
    ...base,
    ...record,
    verdict: forged ? 'forged' : 'verified',
    detail: forged
      ? 'attestation disagrees with the registry'
      : 'registry agrees on every attested hop',
  };
}
