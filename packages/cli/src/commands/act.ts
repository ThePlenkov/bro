/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
 *   annotations [PR] [--json] check-run annotations for the PR head
 *   merge [PR]             merge only when the exit gate is green
 *   threads [PR]           unresolved review threads, TSV
 *   resolve --thread ID [--comment TEXT] [--unresolve]
 *   reply   --thread ID --comment TEXT | --file TSV
 *   dismiss [PR] [--dry-run] [--message T]
 *                          dismiss STALE veto reviews — a standing
 *                          CHANGES_REQUESTED whose referenced threads
 *                          are all resolved+outdated (bro-n1foa)
 */
import { readFileSync } from 'node:fs';
import {
  type ActPlan,
  type ActThreadVerdict,
  checkHistory,
  evaluateExitGate,
  fetchPrActState,
  prStateCache,
  resolveLedger,
  staleStatus,
} from '@broject/act';
import {
  CommandError,
  EXIT,
  emitLifecycle,
  ensureAuth,
  hasHelpFlag,
  type PrTarget,
  type ReviewFacade,
  type ReviewThread,
  type TaskStore,
  reviewHost,
} from '@broject/core';
import { annotateThreads, judgeConfig, judgeFacade, recordDisposition } from '@broject/judge';
import { loadBroConfig } from '../plugins.ts';
import {
  commentArg,
  resolvePr,
  resolvePrLenient,
  threadArg,
  usage,
  VALUE_FLAGS,
} from './act-args.ts';
import { flag } from './args.ts';
import { cmdDismiss } from './act-dismiss.ts';
import { claimStore, cmdMerge, dropActState } from './act-land.ts';
import { printStatus } from './act-report.ts';
import { cmdRearm, cmdWait } from './act-wait.ts';
import { cmdAnnotations } from './act-annotations.ts';

export type { ResolvedTarget, ResolveMode } from './act-args.ts';
export { mergeMethod, resolvePr } from './act-args.ts';
export {
  cleanupAfterMerge,
  closeLandedBead,
  defaultBranch,
  landPr,
  reportActOutcome,
  warnHumanOwned,
} from './act-land.ts';
export {
  gateStateFetcher,
  rearmPass,
  respawnWatcher,
  waitOpts,
} from './act-wait.ts';

async function cmdStatus(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const json = argv.includes('--json');
  const t = resolvePr(rev, argv);
  const act = loadBroConfig().act;
  const state = await fetchPrActState(rev, t, {
    ignoreChecks: act.ignoreChecks,
    selfCheck: act.selfCheck,
    checkHistory: checkHistory(process.cwd()),
    maxRounds: act.maxRounds,
    docsPaths: act.docsPaths,
    docsMaxRounds: act.docsMaxRounds,
    requireApproval: act.requireApproval,
    approvers: act.approvers,
    stateCache: prStateCache(process.cwd()),
    resolveLedger: resolveLedger(process.cwd()),
  });
  const gate = evaluateExitGate(state, { requireApproval: act.requireApproval });
  const cache = prStateCache(process.cwd());
  const stale = staleStatus(process.cwd(), t, state, cache);

  if (!gate.ok) {
    process.exitCode = 1;
  }
  if (json) {
    console.log(JSON.stringify({ pr: state, exit_gate: gate, stale }, null, 2));
    return;
  }
  printStatus(state, gate, stale);
}

async function cmdThreads(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const t = resolvePr(rev, argv);
  // threads only needs the threads API — fetching checks/SAST here would
  // make a read-only listing fail on unrelated check-service flakes
  const threads = await rev.reviewThreads(t);
  // shadow-mode judge verdicts render beside each unresolved thread —
  // annotation only, never applied; every failure mode degrades to
  // "no annotation" (a judge that can stall `act threads` gets turned
  // off, per the spec's fail-open rule)
  // judging runs behind the listing, not beside it — TSV rows print
  // first; shadowNotes can open with a slow prMeta call, and starting
  // it before the row loop would still stall the listing. Annotations
  // land on stderr once the batch resolves.
  const open = printThreadRows(threads);
  const notes = await shadowNotes(rev, t, threads).catch(() => undefined);
  printShadowNotes(threads, notes);
  console.error(`act threads: ${open} unresolved`);
}

/** The TSV row per unresolved thread — the listing's stdout contract;
 *  returns the unresolved count the summary line reports. */
function printThreadRows(threads: ReviewThread[]): number {
  let open = 0;
  for (const thread of threads) {
    if (thread.resolved) {
      continue;
    }
    open += 1;
    const c = thread.comment;
    const author = c?.author ?? '-';
    const path = c?.path ?? '-';
    const line = c?.line ?? '-';
    const body = (c?.body ?? '').replace(/[\n\t]/g, ' ').slice(0, 120);
    console.log(`${thread.id}\t${author}\t${path}:${line}\t${body}`);
  }
  return open;
}

/** The shadow verdict under each row — stderr, never the TSV stream. */
function printShadowNotes(threads: ReviewThread[], notes: Map<string, string> | undefined): void {
  for (const thread of threads) {
    const note = notes?.get(thread.id);
    if (note !== undefined) {
      // stderr — stdout is the documented TSV contract; a `judge:` line
      // there reads as a malformed thread record to TSV consumers
      console.error(`${thread.id} ${note}`);
    }
  }
}

/** Shadow-mode judge annotation for the threads listing — the
 *  `judge: …` line under each unresolved row when `judge.mode:
 *  shadow`, undefined otherwise. The journal dedups on
 *  (threadId, commentSha, headSha), so repeat polls annotate for
 *  free and only a moved subject pays for a fresh decide(). */
async function shadowNotes(
  rev: ReviewFacade,
  t: PrTarget,
  threads: ReviewThread[]
): Promise<Map<string, string> | undefined> {
  const dir = process.cwd();
  const cfg = judgeConfig(dir).judge;
  if (cfg.mode !== 'shadow') {
    return undefined;
  }
  try {
    // headSha is the "inputs moved" half of the dedup key — a push
    // re-judges the thread; an unfetchable head just loosens the key
    let headSha: string | undefined;
    try {
      // async twin when the facade has one — a sync CLI call inside an
      // async fn still freezes the loop this listing shares
      const meta = rev.prMetaAsync !== undefined ? await rev.prMetaAsync(t) : rev.prMeta(t);
      headSha = meta.headSha;
    } catch {
      // no head — dedup keys on commentSha alone
    }
    const res = await annotateThreads(threads, {
      dir,
      pr: t.pr,
      headSha,
      judge: judgeFacade(dir),
      budget: cfg.maxDecisionsPerRun,
      // a listing must stay a listing — a slow-but-alive backend gets a
      // few decide rounds, then the rows print unjudged
      deadlineMs: 10_000,
    });
    if (res.decided > 0) {
      console.error(`act: judge decided ${res.decided} thread(s) — verdicts journaled`);
    }
    return res.annotations;
  } catch (err) {
    console.error(
      `act: judge annotation skipped — ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/** The observed outcome for a thread — journaled beside its shadow
 *  verdict so stats can score judge-vs-outcome agreement. The lifecycle
 *  journal records the verdict unconditionally (it is THE thread
 *  transition); the shadow journal runs only in shadow mode (off
 *  writes no judge artifacts). A failed journal write never fails the
 *  mutation that produced the outcome. */
function disposition(threadId: string, outcome: string, pr?: number): void {
  const dir = process.cwd();
  emitLifecycle(dir, {
    kind: 'verdict',
    ...(pr !== undefined ? { pr } : {}),
    to: outcome,
    detail: { via: 'act', thread: threadId },
  });
  if (judgeConfig(dir).judge.mode !== 'shadow') {
    return;
  }
  try {
    recordDisposition(dir, { pr, threadId }, outcome);
  } catch (err) {
    console.error(
      `act: disposition not journaled — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Write one row into the resolve ledger. Best-effort by contract —
 *  the reopen guard degrades, never crashes. */
function ledgerRecord(repo: string, pr: number, threadId: string): void {
  try {
    resolveLedger(process.cwd())?.record({ repo, pr, thread: threadId });
  } catch {
    // recording is best-effort — the resolve itself already landed
  }
}

/** Record a resolve in the ledger — the source of "this thread was
 *  resolved before" for the reopened-thread cycle-guard. Best-effort: a
 *  missing git dir or an unwritable ledger means the reopen is not
 *  detected, never a crash. */
function recordResolve(rev: ReviewFacade, argv: string[], threadId: string): void {
  try {
    const ledger = resolveLedger(process.cwd());
    if (ledger === null) {
      return;
    }
    // resolvePrLenient, not resolvePr — resolvePr exits on an invalid
    // number or a missing implicit PR, and cmdResolve calls this AFTER
    // the thread is already resolved: an exit here would strand the
    // disposition journal and dropActState (bro-6mjla)
    const target = resolvePrLenient(rev, argv);
    if (target === null) {
      return;
    }
    if (target.source === 'auto') {
      // the auto row is a recency guess — recording a thread under the
      // wrong PR poisons the reopen guard just as much as losing the
      // row would, so the row is dropped with a note instead (codeant)
      console.error(
        `act: note — no branch PR for this thread; ledger record of ${threadId} skipped`
      );
      return;
    }
    ledger.record({ repo: target.repo, pr: target.pr, thread: threadId });
  } catch {
    // recording is best-effort — the resolve itself already landed
  }
}

/** Batch-file rows — `<id><TAB><body>` per line, `\\n`/`\\t` escapes
 *  expanded. Reply and resolve share one parser: the file shape is the
 *  same contract on both verbs (bro-71a10). Lines without the tab yield
 *  a null body — resolve reads them as silent fixes, reply skips them. */
function parseBatchRows(file: string): {
  rows: { id: string; body: string }[];
  tabless: string[];
  blankId: number;
} {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // a missing batch file is a usage error, not a raw ENOENT stack
    console.error(
      `error: cannot read --file ${file} — ${err instanceof Error ? err.message : String(err)}`
    );
    throw new CommandError('', EXIT.usage);
  }
  // trimEnd only: the leading tab of a blank-id row is STRUCTURAL —
  // trimming it away would turn the row into a bare "tabless" id and
  // silently resolve whatever the comment column named (codeant)
  const lines = text!
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim().length > 0);
  const rows: { id: string; body: string }[] = [];
  const tabless: string[] = [];
  let blankId = 0;
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab === -1) {
      // no structural tab — the whole line is the id, and whitespace
      // around it is noise (the trimEnd above keeps leading spaces so
      // the tab test stays honest; the id itself must not carry them —
      // kody on #1203)
      tabless.push(line.trim());
      continue;
    }
    const id = line.slice(0, tab).trim();
    // a tab-only line has no thread to act on — an empty id would hit
    // the host API as a malformed mutation (amazon-q on #1203)
    if (id === '') {
      blankId += 1;
      continue;
    }
    rows.push({
      id,
      body: line
        .slice(tab + 1)
        .replaceAll(String.raw`\n`, '\n')
        .replaceAll(String.raw`\t`, '\t'),
    });
  }
  if (blankId > 0) {
    // silent skips read as success — the operator must know rows were
    // dropped, or a malformed batch file looks fully applied (kody)
    console.error(`act: note — ${blankId} blank-id row(s) skipped in the batch file`);
  }
  return { rows, tabless, blankId };
}

/** One thread through the resolve/unresolve flow — the batch --file
 *  path and the single --thread path share it exactly (bro-71a10). */
function resolveOne(
  rev: ReviewFacade,
  argv: string[],
  opts: { id: string; comment?: string; unresolve: boolean }
): void {
  const { id, comment, unresolve } = opts;
  if (comment) {
    if (!unresolve) {
      // the verdict on a fix is the push — comments on resolved-as-fixed
      // threads are boilerplate noise on the PR (skills/act/SKILL.md)
      console.error('act: note — fixes resolve silently; --comment is for reject/defer reasons');
    }
    rev.replyThread(id, comment);
    console.error(`act: replied on ${id}`);
  }
  if (unresolve) {
    rev.resolveThread(id, true);
    console.error(`act: unresolved ${id}`);
    emitLifecycle(process.cwd(), {
      kind: 'verdict',
      to: 'unresolved',
      detail: { via: 'act', thread: id },
    });
  } else {
    rev.resolveThread(id);
    console.error(`act: resolved ${id}`);
    // Record the resolve — the reopened-thread cycle-guard needs to know
    // this thread was resolved before. The ledger, not the state cache:
    // the cache TTL is 30s, so its entry is gone between polls.
    recordResolve(rev, argv, id);
    // a silent resolve is the fix verdict; a comment is a reject/defer
    // reason (skills/act/SKILL.md) — the documented defer reply names
    // its bead ("deferred to <id>"), which is the one defer signal a
    // bare resolve can see
    // nested ternary flattened for S3358: falsy comment is the silent
    // resolve ('fixed'); a present comment is a defer or a reject.
    const verdict = !comment ? 'fixed' : isDeferComment(comment) ? 'deferred' : 'rejected';
    disposition(id, verdict);
  }
}

/** Both reply and resolve record the same defer marker. Keep the accepted
 * spellings in one place so `act reply` cannot mis-score a defer as a reply. */
export function isDeferComment(comment: string): boolean {
  return /deferred (?:to|->) \S+/i.test(comment);
}

/** Persist the debt bead before resolving any selected host thread. */
type DeferOptions = { bead?: string; newBead?: string; pr?: number };

function validateDeferRequest(ids: string[], opts: DeferOptions): void {
  if ((opts.bead === undefined) === (opts.newBead === undefined)) {
    throw new CommandError('error: exactly one of --bead or --new-bead is required', EXIT.usage);
  }
  if (ids.length === 0) {
    throw new CommandError('error: at least one thread id is required', EXIT.usage);
  }
}

async function selectDeferThreads(
  rev: ReviewFacade,
  ids: string[],
  pr: number | undefined
): Promise<ReviewThread[]> {
  const target =
    pr === undefined
      ? resolvePr(rev, [], 'strict')
      : { repo: rev.resolveRepo([]), pr };
  const threads = await rev.reviewThreads(target);
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  return ids.map(id => {
    const thread = byId.get(id);
    if (thread === undefined) throw new CommandError(`error: thread not found: ${id}`, EXIT.usage);
    if (thread.resolved) {
      throw new CommandError(`error: thread already resolved: ${id}`, EXIT.usage);
    }
    return thread;
  });
}

function deferDetail(thread: ReviewThread): string {
  return `PRRT ${thread.id}: ${thread.comment?.body?.trim() || '(no comment body)'}`;
}

function ensureDeferBead(store: TaskStore, first: ReviewThread, opts: DeferOptions): string {
  if (opts.bead !== undefined) {
    if (store.get(opts.bead) === undefined) {
      throw new CommandError(`error: bead not found: ${opts.bead}`, EXIT.usage);
    }
    return opts.bead;
  }
  const title = opts.newBead;
  if (title === undefined) {
    throw new CommandError('error: --new-bead requires a title', EXIT.usage);
  }
  return store.create({
    title,
    labels: ['debt'],
    description: deferDetail(first),
    externalRef: JSON.stringify([first.id]),
  }).id;
}

export function deferExternalRef(threadIds: string[]): string {
  return JSON.stringify(threadIds);
}

function recordDeferNotes(
  store: TaskStore,
  bead: string,
  threads: ReviewThread[],
  existing: boolean
): void {
  for (const [index, thread] of threads.entries()) {
    if (existing || index > 0) store.note(bead, deferDetail(thread));
  }
}

function resolveDeferredThreads(
  rev: ReviewFacade,
  bead: string,
  threads: ReviewThread[],
  pr: number | undefined
): void {
  const resolveArgv = pr === undefined ? [] : ['--pr', String(pr)];
  for (const thread of threads) {
    resolveOne(rev, resolveArgv, {
      id: thread.id,
      comment: `deferred -> ${bead}`,
      unresolve: false,
    });
    console.error(`act: deferred ${thread.id} -> ${bead}`);
  }
}

export async function deferThreads(
  rev: ReviewFacade,
  store: TaskStore,
  ids: string[],
  opts: DeferOptions
): Promise<void> {
  validateDeferRequest(ids, opts);
  const selected = await selectDeferThreads(rev, ids, opts.pr);
  const first = selected[0];
  if (first === undefined)
    throw new CommandError('error: at least one thread id is required', EXIT.usage);
  const bead = ensureDeferBead(store, first, opts);
  // Notes are useful to humans, but replay's durable join is the bead's
  // external_ref. Update existing beads too: --bead must not strand the
  // later thread ids in notes that replay never reads.
  store.update(bead, { 'external-ref': deferExternalRef(selected.map(thread => thread.id)) });
  recordDeferNotes(store, bead, selected, opts.bead !== undefined);
  resolveDeferredThreads(rev, bead, selected, opts.pr);
  dropActState();
}

function deferArgIds(argv: string[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) {
      ids.push(
        ...arg
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
      );
    }
  }
  return ids;
}

async function cmdDefer(argv: string[]): Promise<void> {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const bead = flag(argv, '--bead');
  const newBead = flag(argv, '--new-bead');
  const prRaw = flag(argv, '--pr');
  const parsedPr = prRaw === undefined ? undefined : Number(prRaw);
  const invalidPr = typeof parsedPr !== 'number' || !Number.isInteger(parsedPr) || parsedPr <= 0;
  if (prRaw !== undefined && invalidPr) {
    throw new CommandError(`error: invalid PR number "${prRaw}"`, EXIT.usage);
  }
  await deferThreads(rev, claimStore(process.cwd()), deferArgIds(argv), {
    bead,
    newBead,
    pr: parsedPr,
  });
}

/** Batch shape mirrors reply --file: one <thread_id> or
 *  <thread_id><TAB><comment> per line — a resolve sweep over N threads
 *  under one verdict comment is one command, not a hand-rolled loop
 *  (bro-71a10). Commentless lines resolve silently (the fix verdict). */
function cmdResolve(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const unresolve = argv.includes('--unresolve');
  const fileIdx = argv.indexOf('--file');
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1];
    if (!file) {
      console.error('error: --file requires a path');
      throw new CommandError('', EXIT.usage);
    }
    const { rows, tabless } = parseBatchRows(file);
    let resolved = 0;
    for (const row of rows) {
      resolveOne(rev, argv, { id: row.id, comment: row.body, unresolve });
      resolved += 1;
    }
    for (const id of tabless) {
      resolveOne(rev, argv, { id, unresolve });
      resolved += 1;
    }
    console.error(`act resolve: ${resolved} thread(s)`);
    dropActState();
    return;
  }
  const id = threadArg(argv);
  const comment = commentArg(argv);
  resolveOne(rev, argv, { id, comment: comment ?? undefined, unresolve });
  dropActState();
}

function cmdReply(argv: string[]): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  const fileIdx = argv.indexOf('--file');
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1];
    if (!file) {
      console.error('error: --file requires a path');
      throw new CommandError('', EXIT.usage);
    }
    const { rows, tabless, blankId } = parseBatchRows(file);
    const skipped = tabless.length;
    for (const row of rows) {
      rev.replyThread(row.id, row.body);
      console.error(`act: replied on ${row.id}`);
      disposition(row.id, isDeferComment(row.body) ? 'deferred' : 'replied');
    }
    console.error(`act reply: ${rows.length} repl(ies)`);
    if (skipped > 0) {
      console.error(`warning: ${skipped} line(s) had no <thread_id><TAB><body> shape — skipped`);
      process.exitCode = 1;
    }
    // a batch of ONLY malformed rows replied nothing at all — exiting 0
    // would report success for a no-op (macroscope on #1203)
    if (rows.length === 0 && blankId > 0) {
      process.exitCode = 1;
    }
    dropActState();
    return;
  }
  const id = threadArg(argv);
  const comment = commentArg(argv);
  if (!comment) {
    console.error('error: --comment required (or --file TSV)');
    usage();
  }
  rev.replyThread(id, comment!);
  console.error(`act: replied on ${id}`);
  // the documented defer flow replies "deferred to <bead>" then
  // resolves silently — journaled as deferred here (stats join
  // first-hit wins) so the silent resolve's 'fixed' can't mask it
  disposition(id, isDeferComment(comment!) ? 'deferred' : 'replied');
  dropActState();
}

// a Map keeps the dispatch table off dynamic object indexing — a
// runtime-keyed `COMMANDS[cmd]` retrieval-then-call trips
// object-injection scanners
const COMMANDS = new Map<string, (argv: string[]) => void | Promise<void>>([
  ['status', cmdStatus],
  ['annotations', cmdAnnotations],
  ['wait', cmdWait],
  ['merge', cmdMerge],
  ['rearm', cmdRearm],
  ['threads', cmdThreads],
  ['resolve', cmdResolve],
  ['defer', cmdDefer],
  ['reply', cmdReply],
  ['dismiss', cmdDismiss],
]);

/** Defer a thread into a debt bead — the skill's mechanics as code:
 *  `bd create -l debt --external-ref <thread>`, reply with the bead id,
 *  then resolve. Fails loudly when bd can't create — never resolves a
 *  defer that didn't land. */
function deferThread(
  rev: ReviewFacade,
  v: ActThreadVerdict,
  ownerRepo: string | null,
  pr?: number
): string {
  const desc =
    pr && ownerRepo
      ? `deferred from PR ${rev.prLink(ownerRepo, pr)} thread ${v.thread_id}`
      : pr
        ? `deferred from PR #${pr} thread ${v.thread_id}`
        : `deferred thread ${v.thread_id}`;
  if (!v.title) {
    throw new Error(`defer verdict for ${v.thread_id} has no title`);
  }
  const bead = claimStore(process.cwd()).create({
    title: v.title,
    labels: ['debt'],
    description: desc,
    externalRef: v.thread_id,
  }).id;
  const reply = `deferred to ${bead}${v.comment ? ` — ${v.comment}` : ''}`;
  rev.replyThread(v.thread_id, reply);
  rev.resolveThread(v.thread_id);
  disposition(v.thread_id, 'deferred', pr);
  return bead;
}

function replyVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (!v.comment) {
    throw new Error(`reply verdict for ${v.thread_id} has no comment`);
  }
  rev.replyThread(v.thread_id, v.comment);
  console.error(`act: replied on ${v.thread_id}`);
  disposition(v.thread_id, 'replied', pr);
}

function resolveVerdict(rev: ReviewFacade, v: ActThreadVerdict, pr?: number): void {
  if (v.comment) {
    rev.replyThread(v.thread_id, v.comment);
  }
  rev.resolveThread(v.thread_id);
  console.error(`act: resolved ${v.thread_id}`);
  disposition(v.thread_id, v.comment ? 'rejected' : 'fixed', pr);
}

/** One plan verdict → one ledger row. No row without BOTH the plan's
 *  PR and a resolvable repo — a half-keyed row poisons the reopen
 *  guard worse than no row, and the write is best-effort anyway. */
function ledgerRowFor(plan: ActPlan, v: ActThreadVerdict, ownerRepo: string | null): void {
  if (plan.pr !== undefined && ownerRepo !== null) {
    ledgerRecord(ownerRepo, plan.pr, v.thread_id);
  }
}

/** Apply an `act` plan (`bro run act.toml`) — batch thread verdicts.
 *  One bad verdict doesn't abort the rest; failures list at the end. */
export function applyActPlan(plan: ActPlan): void {
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  // no upfront beads check — a defer without bd/.beads fails that one
  // verdict (thread stays unresolved, per the skill's fallback rule)
  // instead of blocking every other verdict in the plan
  const failed: string[] = [];
  // lazy: only a defer verdict pays the repo-resolution call — and
  // outside a clone it can't pay at all; null falls back to the bare-#
  // bead description rather than failing a valid defer plan.
  // undefined = not yet attempted.
  let ownerRepo: string | null | undefined;
  const repoForDefers = (): string | null => {
    if (ownerRepo !== undefined) {
      return ownerRepo;
    }
    // a failed resolve isn't cached — one transient outage must not
    // degrade every later defer in the same plan
    try {
      return (ownerRepo = rev.resolveRepo([]));
    } catch {
      return null;
    }
  };
  for (const v of plan.threads) {
    try {
      if (v.action === 'reply') {
        replyVerdict(rev, v, plan.pr);
      } else if (v.action === 'defer') {
        console.error(
          `act: deferred ${v.thread_id} → ${deferThread(rev, v, repoForDefers(), plan.pr)}`
        );
        // a defer RESOLVES the thread on the host — and a plain resolve
        // the same. Both rows feed the reopened-thread guard exactly
        // like a CLI resolve does (bro-ux7cv): without them a plan batch
        // is invisible to the guard, and a bot re-answering an old
        // thread never trips the cycle detection.
        ledgerRowFor(plan, v, repoForDefers());
      } else {
        resolveVerdict(rev, v, plan.pr);
        ledgerRowFor(plan, v, repoForDefers());
      }
    } catch (err) {
      failed.push(v.thread_id);
      console.error(
        `act: ${v.thread_id} failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (plan.threads.length > 0) {
    dropActState();
  }
  if (failed.length > 0) {
    console.error(`act plan: ${failed.length} verdict(s) failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

export async function runActCommand(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  // zero-arg magic: bare `bro act` is the gate on the current branch's PR
  if (!cmd) {
    await cmdStatus([]);
    return;
  }
  if (cmd === '--help' || cmd === '-h') {
    usage(0);
  }
  const handler = COMMANDS.get(cmd);
  if (!handler) {
    console.error(`unknown command: ${cmd}`);
    usage();
  }
  if (hasHelpFlag(rest)) {
    usage(0);
  }
  await handler(rest);
}
