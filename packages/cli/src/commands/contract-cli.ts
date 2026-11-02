import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BroPlugin } from '@broject/core';
import { flag } from './args.ts';
import { buildDump, type ContractDump } from './contract-dump.ts';
import { asDoc, asDump, parseBreaking, reconcileContract } from './contract-reconcile.ts';
import { emptyDoc, type ContractDoc, type ContractProblem } from './contract-shared.ts';

/** A JSON fixture/snapshot — read + parse, exit 2 on garbage. Typed at
 *  the parse site so no call-site cast can smuggle `undefined` through
 *  when process.exit is stubbed. */
function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error(`contract: ${path} — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

/** tmp + rename — a `check` racing a `gen`, or a crash mid-write, never
 *  sees a truncated snapshot. */
function writeDocAtomic(path: string, doc: ContractDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
}

function printTable(dump: ContractDump): void {
  for (const c of Object.values(dump.commands)) {
    const subs: Record<string, any> = (c.contract as any)?.subs ?? {};
    const flags =
      Object.keys((c.contract as any)?.flags ?? {}).length +
      Object.values(subs).reduce<number>((n, s: any) => n + Object.keys(s.flags ?? {}).length, 0);
    const marker = c.aliasOf !== undefined ? `→ ${c.aliasOf}` : c.hidden ? 'hidden' : String(flags);
    console.log(
      `${c.name.padEnd(12)} ${(c.group ?? '-').padEnd(8)} ${(c.skill ?? '-').padEnd(10)} ` +
        `${marker.padEnd(10)} ${c.summary}`
    );
  }
}

function reportProblems(problems: ContractProblem[]): void {
  for (const p of problems) {
    console.error(`  ${p.kind.padEnd(8)} ${p.path} — ${p.message}`);
  }
}

interface GatePaths {
  contractPath: string;
  breakingPath: string;
  dumpPath?: string;
}

function gatePaths(rest: string[]): GatePaths {
  return {
    contractPath: flag(rest, '--contract') ?? 'contract/cli.json',
    breakingPath: flag(rest, '--breaking') ?? 'contract/BREAKING.md',
    dumpPath: flag(rest, '--dump'),
  };
}

function cmdGen(
  contractPath: string,
  committedRaw: string | undefined,
  doc: ContractDoc,
  problems: ContractProblem[]
): void {
  const fatal = problems.filter(p => p.kind !== 'stale');
  if (fatal.length > 0) {
    console.error(
      `contract: refusing to regenerate — ${fatal.length} unannounced breaking change(s)`
    );
    reportProblems(fatal);
    process.exit(1);
  }
  // optimistic CAS — a second gen or a hand edit landing mid-run must
  // not be silently clobbered
  if (existsSync(contractPath) && readFileSync(contractPath, 'utf8') !== committedRaw) {
    console.error(`contract: ${contractPath} changed mid-gen — rerun`);
    process.exit(1);
  }
  writeDocAtomic(contractPath, doc);
  console.log(
    `${contractPath}: regenerated — ${Object.keys(doc.commands).length} commands, ${Object.keys(doc.removed).length} tombstone(s)`
  );
}

function cmdGate(
  sub: 'check' | 'gen',
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>,
  rest: string[]
): void {
  const { contractPath, breakingPath, dumpPath } = gatePaths(rest);
  const live =
    dumpPath !== undefined
      ? asDump(readJsonFile<unknown>(dumpPath))
      : buildDump(
          // the committed surface is the repo's registry — external
          // plugins are machine-local config and must not drift it
          plugins.filter(p => p.external !== true),
          groupMeta
        );
  const committedRaw = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : undefined;
  const committed =
    committedRaw === undefined ? emptyDoc() : asDoc(readJsonFile<ContractDoc>(contractPath));
  const announced = parseBreaking(
    existsSync(breakingPath) ? readFileSync(breakingPath, 'utf8') : ''
  );
  const { doc, problems } = reconcileContract(committed, live, announced);
  if (sub === 'gen') {
    cmdGen(contractPath, committedRaw, doc, problems);
    return;
  }
  if (problems.length === 0) {
    console.log(`${contractPath}: fresh`);
    return;
  }
  console.error(`contract: ${problems.length} problem(s) in ${contractPath}`);
  reportProblems(problems);
  process.exit(1);
}

export function runContractCommand(
  argv: string[],
  plugins: readonly BroPlugin[],
  groupMeta: ReadonlyArray<readonly [string, string]>
): void {
  const [sub, ...rest] = argv;
  if (sub === 'dump') {
    const dump = buildDump(plugins, groupMeta);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(dump, null, 2));
    } else {
      printTable(dump);
    }
    return;
  }
  if (sub === 'check' || sub === 'gen') {
    cmdGate(sub, plugins, groupMeta, rest);
    return;
  }
  console.error(
    'usage: bro contract dump [--json] | check [--contract f] [--dump f] [--breaking f] | gen [same flags]'
  );
  process.exit(2);
}
