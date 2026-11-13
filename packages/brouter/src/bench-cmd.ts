/**
 * `brouter bench replay` — the classifier bench (spec bro-0ykhg.5).
 *
 * Re-asks every eligible journaled decision with each listed contender —
 * the built-in code stages (static-table, t1-recall) and configured
 * provider judges (`--judges provider[/model]`) — and scores the picks
 * against the verified outcome oracle. Offline by construction: no
 * worker dispatches, no journal rows land, no cache entries write.
 *
 *   brouter bench replay [--since ISO|epoch-ms] [--judges a,b,c]
 *     [--invoke always|ambiguous|never] [--context ID] [--path P]
 *     [--out DIR] [--json]
 *
 * Reports land under `.evidence/brouter-bench/` — `replay.json` and
 * `replay.md` — and the markdown table prints to stdout (`--json`
 * prints the report instead).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '@broject/core';
import { judgeConfig, synthesizedProviders } from '@broject/judge';
import { routerStorePath } from '@broject/router-store';
import type { InvokeMode } from './cascade.ts';
import {
  BUILTIN_CONTENDERS,
  formatBenchReport,
  parseJudgeId,
  runBenchReplay,
  type BenchReplayReport,
} from './bench-replay.ts';

const INVOKE_MODES: readonly InvokeMode[] = ['always', 'ambiguous', 'never'];

/** `--since` — an ISO timestamp or epoch milliseconds. */
export function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    // a safe integer can still sit outside Date's range — new Date()
    // would be Invalid and the report's toISOString() would RangeError
    if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) {
      console.error(
        `brouter bench: --since epoch must be a safe integer inside Date range — got ${raw}`
      );
      process.exit(2);
    }
    return ms;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    console.error(
      `brouter bench: --since must be an ISO timestamp or epoch ms — got ${JSON.stringify(raw)}`
    );
    process.exit(2);
  }
  return ms;
}

/** A `--judges` id names a built-in or a configured provider — anything
 *  else is a usage error BEFORE the journal is even opened. */
function validateJudges(judges: string[], dir: string): void {
  const { judge, providers } = judgeConfig(dir);
  const registry = synthesizedProviders(judge, providers);
  for (const id of judges) {
    const parsed = parseJudgeId(id);
    if (parsed === undefined || 'builtin' in parsed) continue;
    if (!Object.hasOwn(registry, parsed.provider)) {
      console.error(
        `brouter bench: unknown contender "${id}" — built-ins: ${BUILTIN_CONTENDERS.join(', ')}; ` +
          `providers: ${Object.keys(registry).join(', ') || '(none configured)'}`
      );
      process.exit(2);
    }
  }
}

/** `brouter bench replay` — run the replay, write the evidence, print
 *  the report. */
export async function runBenchReplayCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== 'replay') {
    console.error(`brouter bench: unknown subject "${sub ?? ''}" — replay`);
    process.exit(2);
  }
  const dir = process.cwd();
  const since = parseSince(flag(rest, '--since'));
  const judgesRaw = flag(rest, '--judges');
  const judges =
    judgesRaw === undefined
      ? undefined
      : judgesRaw
          .split(',')
          .map(j => j.trim())
          .filter(j => j !== '');
  if (judges !== undefined && judges.length === 0) {
    console.error('brouter bench: --judges needs at least one contender id');
    process.exit(2);
  }
  if (judges !== undefined) {
    validateJudges(judges, dir);
  }
  const invokeRaw = flag(rest, '--invoke');
  let invoke: InvokeMode | undefined;
  if (invokeRaw !== undefined) {
    if (!(INVOKE_MODES as readonly string[]).includes(invokeRaw)) {
      console.error(`brouter bench: --invoke must be one of ${INVOKE_MODES.join('|')}`);
      process.exit(2);
    }
    invoke = invokeRaw as InvokeMode;
  }
  const contextId = flag(rest, '--context');
  const storePath = flag(rest, '--path') ?? routerStorePath();
  const outDir = flag(rest, '--out') ?? join(dir, '.evidence', 'brouter-bench');
  const asJson = rest.includes('--json');

  let report: BenchReplayReport;
  try {
    report = await runBenchReplay({
      dir,
      storePath,
      ...(since === undefined ? {} : { since }),
      ...(contextId === undefined ? {} : { contextId }),
      ...(judges === undefined ? {} : { judges }),
      ...(invoke === undefined ? {} : { invoke }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // a contender id that validated but cannot bind is a run failure;
    // anything the engine rejects up front is usage
    console.error(`brouter bench: ${message}`);
    process.exit(message.startsWith('unknown contender') ? 2 : 1);
  }

  // the evidence artifacts — JSON + the markdown table, always, even
  // when stdout carries the JSON form
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'replay.json');
  const mdPath = join(outDir, 'replay.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, formatBenchReport(report));

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatBenchReport(report));
  }
  console.error(`brouter bench: wrote ${jsonPath} + ${mdPath}`);
}
