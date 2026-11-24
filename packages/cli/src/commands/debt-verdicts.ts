/** `bro debt`'s ledger/label mutations — `set` (row verdicts), `mark`
 *  (PR debt:* labels), and applyVerdicts, which the debt plan runner
 *  (`bro run debt.toml`) shares. Split out of debt.ts — the module was
 *  past the CodeScene file-size bar. */
import { readFileSync } from 'node:fs';
import { ensureAuth, reviewHost } from '@broject/core';
import {
  applyDebtLabel,
  applyDebtVerdicts,
  buildSummary,
  clearDebtLabels,
  DEBT_ROW_STATUSES,
  DEBT_STATES,
  ensureDebtLabels,
  readDebtRecords,
  writeSummary,
  type DebtPrState,
  type DebtStatus,
  type DebtVerdict,
} from '@broject/debt';
import { loadBroConfig } from '../plugins.ts';
import { parsePositiveInt, readOption } from './debt-args.ts';

// --- mark ------------------------------------------------------------------

export function cmdMark(argv: string[]): void {
  const positional = argv.filter(a => !a.startsWith('--'));
  const [prRaw, stateRaw, ...rest] = positional;
  const pr = Number(prRaw);
  if (!Number.isFinite(pr) || !stateRaw) {
    console.error(`Usage: bro debt mark PR <${[...DEBT_STATES, 'none'].join('|')}> [OWNER REPO]`);
    process.exit(2);
  }
  const rev = reviewHost(undefined, loadBroConfig().connectors);
  ensureAuth('reviews', { dir: process.cwd() }, { prefer: loadBroConfig().connectors });
  const repo = rev.resolveRepo(rest);
  if (stateRaw === 'none') {
    clearDebtLabels(rev, { repo, pr });
    console.error(`debt mark: cleared debt:* labels on ${rev.prLink(repo, pr)}`);
    return;
  }
  if (!(DEBT_STATES as readonly string[]).includes(stateRaw)) {
    console.error(`error: unknown state ${stateRaw}`);
    process.exit(2);
  }
  ensureDebtLabels(rev, repo);
  applyDebtLabel(rev, { repo, pr, state: stateRaw as DebtPrState });
  console.error(`debt mark: ${rev.prLink(repo, pr)} → debt:${stateRaw}`);
}

// --- set -------------------------------------------------------------------

type DebtRowStatus = DebtStatus;

interface SetArgs {
  threadIds: string[];
  fixPr: number | null;
  notes: string | null;
}

/** --threads-file rows: one id per line, '#' comments allowed. */
function readThreadIdsFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

function parseSetFlags(argv: string[]): SetArgs {
  const out: SetArgs = { threadIds: [], fixPr: null, notes: null };
  const flags: Record<string, (v: string) => void> = {
    '--thread-id': v => out.threadIds.push(v),
    '--threads-file': v => out.threadIds.push(...readThreadIdsFile(v)),
    '--fix-pr': v => (out.fixPr = parsePositiveInt('--fix-pr', v)),
    '--notes': v => (out.notes = v),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const set = flags[argv[i]!];
    const value = readOption(argv, i);
    if (set !== undefined && value !== null) {
      set(value);
      i += 1;
    }
  }
  return out;
}

export function cmdSet(argv: string[]): void {
  // Status is strictly the first positional — scanning all argv would let a
  // flag value like --notes "done" get picked up as the status.
  const status = argv[0] as DebtRowStatus | undefined;
  const { threadIds, fixPr, notes } = parseSetFlags(argv.slice(1));

  const badStatus =
    status === undefined || !(DEBT_ROW_STATUSES as readonly string[]).includes(status);
  if (badStatus || threadIds.length === 0) {
    console.error(
      `Usage: bro debt set <${DEBT_ROW_STATUSES.join('|')}> --thread-id ID… ` +
        '[--threads-file PATH] [--fix-pr N] [--notes T]'
    );
    process.exit(2);
  }

  applyVerdicts(
    [...new Set(threadIds)].map(thread_id => ({
      thread_id,
      status,
      fix_pr: fixPr ?? undefined,
      notes: notes ?? undefined,
    }))
  );
}

/** Apply verdicts to the ledger — shared by `debt set` (argv → uniform
 *  verdicts) and the debt plan runner (`bro run debt.toml`). */
export function applyVerdicts(verdicts: DebtVerdict[]): void {
  const { applied, missing } = applyDebtVerdicts(verdicts);
  writeSummary(buildSummary(readDebtRecords()));
  console.error(`debt set: ${applied} row(s) updated`);
  if (missing.length > 0) {
    console.error(`warning: thread id(s) not in ledger: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}
