/** `bro debt`'s argv layer — the usage text, the option reader every
 *  subcommand shares, and the collect flag parser. Split out of
 *  debt.ts — the module was past the CodeScene file-size bar. */
import { type ExitCode, printUsage, type ReviewFacade } from '@broject/core';
import {
  ALL_SOURCES,
  DEBT_SOURCES,
  DEBT_STATES,
  hasHarvestSelection,
  type HarvestPrFilters,
  parseCsvInts,
  parseCsvStrings,
} from '@broject/debt';

export function readOption(argv: string[], index: number): string | null {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    return null;
  }
  return value;
}

export function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro debt <command> [args…]

Commands:
  collect [OWNER REPO] [filters]  Collect findings from unprocessed merged PRs
                                  Filters: --pr-ids, --merged-since, --merged-until,
                                  --last, --pr-author, --labels, --thread-author
                                  Flags: --dry-run, --list-only, --reharvest, --no-label,
                                  --closed
                                  Sources: debt.sources config — default review-threads;
                                  opt in: ${DEBT_SOURCES.join(', ')}
                                  debt.stale_days tunes stale-prs (default 14)
                                  --source a,b overrides debt.sources for one run
  import <file.sarif>… [--dry-run]    Explicit import of a completed sverka/SARIF
        [--repo OWNER/REPO]           artifact — resolves rows only inside the
                                      imported files' own scope
  status                          Ledger summary + unprocessed merged PR count
  stats [--by author|source|area] Signal per reviewer/source/area — fix% is
        [--json]                  done share of decided rows (default: author)
  trend [--by author|source|area] Burn-down — open debt per time bucket
        [--bucket week|day]       (ungrouped renders a single "all" series;
        [--since DATE] [--json]   --json is chart-ready data)
  prs [--limit N] [--all]         Unprocessed merged PRs (--all: full matrix)
  list [filters]                  Ledger rows (--status, --area, --author,
                                  --priority, --pr, --limit)
  mark PR <state> [OWNER REPO]    Set debt label: ${[...DEBT_STATES, 'none'].join('|')}
  set <status> --thread-id ID…    Ledger status: open|claimed|done|wontfix|duplicate
        [--threads-file PATH] [--fix-pr N] [--notes T]
  sync [--dry-run]                Project the ledger into beads (bd) — idempotent
  next [--json] [--claim]         Top open finding for an agent to fix
        [--area A] [--author U]   (--claim marks it claimed atomically)
  watch [collect flags]           Collect on an interval until Ctrl-C
        [--interval SEC=300]`,
    exitCode
  );
}

export function parsePositiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`error: ${flag} must be a positive integer, got "${value}"`);
    process.exit(2);
  }
  return n;
}

export function enumFlag<T extends string>(
  arg: string,
  value: string | null,
  allowed: readonly T[]
): T {
  if (value !== null && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  console.error(`error: ${arg} must be one of ${allowed.join('|')}, got "${value}"`);
  process.exit(2);
}

export function dateFlag(arg: string, value: string | null): string {
  if (value !== null && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  console.error(`error: ${arg} must be a date, got "${value}"`);
  process.exit(2);
}

// --- collect args ------------------------------------------------------------

export interface CollectArgs {
  repo: string;
  filters: HarvestPrFilters;
  threadAuthor: string | null;
  runId: string;
  dryRun: boolean;
  listOnly: boolean;
  reharvest: boolean;
  noLabel: boolean;
  /** --source override — replaces debt.sources for this run. */
  sources: string[] | null;
  includeClosed: boolean;
}

export function parseCollectArgs(rev: ReviewFacade, argv: string[]): CollectArgs {
  const positional: string[] = [];
  const filters: HarvestPrFilters = {
    prIds: [],
    mergedSince: null,
    mergedUntil: null,
    lastN: null,
    prAuthor: null,
    labels: [],
  };
  let threadAuthor: string | null = null;
  let runId = 'local';
  let sources: string[] | null = null;
  const bools = {
    dryRun: false,
    listOnly: false,
    reharvest: false,
    noLabel: false,
    includeClosed: false,
  };
  const boolFlags: Record<string, keyof typeof bools> = {
    '--dry-run': 'dryRun',
    '--list-only': 'listOnly',
    '--reharvest': 'reharvest',
    '--no-label': 'noLabel',
    '--closed': 'includeClosed',
  };
  const valueFlags: Record<string, (v: string) => void> = {
    // An all-invalid --pr-ids parses to [] — which reads as "no explicit
    // selection" and silently falls back to the default 50-PR queue.
    '--pr-ids': v => {
      const ids = parseCsvInts(v);
      if (ids.length === 0) {
        console.error(`error: --pr-ids has no valid PR numbers in "${v}"`);
        process.exit(2);
      }
      filters.prIds = ids;
    },
    '--merged-since': v => (filters.mergedSince = v),
    '--merged-until': v => (filters.mergedUntil = v),
    '--last': v => (filters.lastN = parsePositiveInt('--last', v)),
    '--pr-author': v => (filters.prAuthor = v),
    '--labels': v => (filters.labels = parseCsvStrings(v)),
    '--thread-author': v => (threadAuthor = v),
    '--run-id': v => (runId = v),
    // An all-invalid --source parses to [] — which reads as "no explicit
    // selection" and silently falls back to configured sources.
    '--source': v => {
      const picked = parseCsvStrings(v).filter(s => (ALL_SOURCES as readonly string[]).includes(s));
      if (picked.length === 0) {
        console.error(
          `error: --source has no valid sources in "${v}" (known: ${ALL_SOURCES.join(', ')})`
        );
        process.exit(2);
      }
      sources = picked;
    },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const bool = boolFlags[arg];
    if (bool) {
      bools[bool] = true;
      continue;
    }
    const set = valueFlags[arg];
    if (set) {
      const value = readOption(argv, i);
      // A value flag without a value must not silently parse as absent —
      // a dropped selection flag downgrades to the default 50-PR queue.
      if (value === null) {
        console.error(`error: ${arg} requires a value`);
        process.exit(2);
      }
      set(value);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const repo = rev.resolveRepo(positional);

  // No explicit selection → default queue: last 50 merged PRs.
  if (!hasHarvestSelection(filters)) {
    filters.lastN = 50;
  }

  return {
    repo,
    filters,
    threadAuthor,
    runId,
    sources,
    ...bools,
  };
}
