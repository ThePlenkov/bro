/**
 * `bro act <sub>` — the open-PR review loop as mechanics, not prompts.
 *
 *   status [PR] [--json]   PR state + exit gate (open threads, CI, SAST)
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
} from '@broject/act';
import {
  emitLifecycle,
  ensureAuth,
  hasHelpFlag,
  type PrTarget,
  type ReviewFacade,
  type ReviewThread,
  reviewHost,
} from '@broject/core';
import { annotateThreads, judgeConfig, judgeFacade, recordDisposition } from '@broject/judge';
import { loadBroConfig } from '../plugins.ts';
import { commentArg, resolvePr, threadArg, usage } from './act-args.ts';
import { cmdDismiss } from './act-dismiss.ts';
import { claimStore, cmdMerge, dropActState } from './act-land.ts';
import { printStatus } from './act-report.ts';
import { cmdRearm, cmdWait } from './act-wait.ts';

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

  if (!gate.ok) {
    process.exitCode = 1;
  }
  if (json) {
    console.log(JSON.stringify({ pr: state, exit_gate: gate }, null, 2));
    return;
  }
  printStatus(state, gate);
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
    const target = resolvePr(rev, argv, 'record');
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

/** One thread through the resolve/unresolve flow — the batch --file
 *  path and the single --thread path share it exactly (bro-71a10). */
function resolveOne(
  rev: ReviewFacade,
  argv: string[],
  id: string,
  comment: string | undefined,
  unresolve: boolean
): void {
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
    disposition(
      id,
      comment ? (/deferred to \S+/i.test(comment) ? 'deferred' : 'rejected') : 'fixed'
    );
  }
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
      process.exit(2);
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    let resolved = 0;
    for (const line of lines) {
      const tab = line.indexOf('\t');
      const rowId = (tab === -1 ? line : line.slice(0, tab)).trim();
      const rowComment =
        tab === -1
          ? undefined
          : line
              .slice(tab + 1)
              .replaceAll(String.raw`\n`, '\n')
              .replaceAll(String.raw`\t`, '\t');
      resolveOne(rev, argv, rowId, rowComment, unresolve);
      resolved += 1;
    }
    console.error(`act resolve: ${resolved} thread(s)`);
    dropActState();
    return;
  }
  const id = threadArg(argv);
  const comment = commentArg(argv);
  resolveOne(rev, argv, id, comment ?? undefined, unresolve);
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
      process.exit(2);
    }
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    let skipped = 0;
    const rows = lines
      .map(l => {
        const tab = l.indexOf('\t');
        if (tab === -1) {
          skipped += 1;
          return null;
        }
        return {
          id: l.slice(0, tab).trim(),
          body: l
            .slice(tab + 1)
            .replaceAll(String.raw`\n`, '\n')
            .replaceAll(String.raw`\t`, '\t'),
        };
      })
      .filter((r): r is { id: string; body: string } => r !== null);
    for (const row of rows) {
      rev.replyThread(row.id, row.body);
      console.error(`act: replied on ${row.id}`);
      disposition(row.id, /deferred to \S+/i.test(row.body) ? 'deferred' : 'replied');
    }
    console.error(`act reply: ${rows.length} repl(ies)`);
    if (skipped > 0) {
      console.error(`warning: ${skipped} line(s) had no <thread_id><TAB><body> shape — skipped`);
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
  disposition(id, /deferred to \S+/i.test(comment!) ? 'deferred' : 'replied');
  dropActState();
}

// a Map keeps the dispatch table off dynamic object indexing — a
// runtime-keyed `COMMANDS[cmd]` retrieval-then-call trips
// object-injection scanners
const COMMANDS = new Map<string, (argv: string[]) => void | Promise<void>>([
  ['status', cmdStatus],
  ['wait', cmdWait],
  ['merge', cmdMerge],
  ['rearm', cmdRearm],
  ['threads', cmdThreads],
  ['resolve', cmdResolve],
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
      } else {
        resolveVerdict(rev, v, plan.pr);
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
