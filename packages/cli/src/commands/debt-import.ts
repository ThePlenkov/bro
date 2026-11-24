/** `bro debt import` — explicit import of a completed sverka/SARIF
 *  artifact (spec bro-l8c4f.15). Split out of debt.ts — the module was
 *  past the CodeScene file-size bar. */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { gitTry, normalizeRemote, remoteUrl, resolveRepo } from '@broject/core';
import {
  importSarifFiles,
  readDebtRecords,
  resolvedThreadIds,
  sarifArtifactPath,
  sverkaFileScope,
  upsertLedgerOverlays,
  writeHarvestFile,
  type CollectCtx,
  type DebtRecord,
} from '@broject/debt';
import { readOption, usage } from './debt-args.ts';
import { reopenTerminalRows } from './debt-scan.ts';
import { refreshDebtLedger } from './debt-sources.ts';

/** `bro debt import` repo identity — `--repo` wins, then the origin
 *  remote (no gh needed: host is dropped to match gh's OWNER/REPO), then
 *  `gh repo view`. Failing all three is a loud usage error: identity
 *  must never silently degrade. */
function resolveImportRepo(flag: string | undefined, root: string): string {
  if (flag !== undefined) {
    if (!/^\S+\/\S+$/.test(flag)) {
      console.error(`error: --repo expects OWNER/REPO, got "${flag}"`);
      process.exit(2);
    }
    return flag;
  }
  const remote = remoteUrl(root);
  const normalized = remote === undefined ? '' : normalizeRemote(remote); // host/owner/repo
  const slash = normalized.indexOf('/');
  if (slash > 0 && slash < normalized.length - 1) {
    return normalized.slice(slash + 1);
  }
  try {
    return resolveRepo([], root);
  } catch {
    console.error('error: cannot determine repo from git remote or gh — pass --repo OWNER/REPO');
    process.exit(2);
  }
}

/** Positional must be a readable file — a directory is a usage error
 *  pointing at the dir-scan; an unreadable path is a hard failure.
 *  The canonical path must stay inside the canonical repo root — a
 *  lexical check alone is symlink-blind, and an escaping positional
 *  would import arbitrary file contents into the ledger. */
function assertImportableFile(root: string, f: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(f);
  } catch (err) {
    console.error(`error: cannot read ${f} — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!st.isFile()) {
    console.error(
      `error: ${f} is not a file — the .sverka dir sweep is \`bro debt collect --source sverka\``
    );
    process.exit(2);
  }
  const rel = relative(realpathSync(root), realpathSync(f));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`error: ${f} resolves outside the repo root`);
    process.exit(2);
  }
}

interface ImportArgs {
  files: string[];
  repo?: string;
  dryRun: boolean;
}

/** Argv → an import plan. Flags dispatch through a table — one row per
 *  flag; the handler returns how many extra argv slots it consumed.
 *  Bare positionals are the SARIF files. */
function parseImportArgs(argv: string[]): ImportArgs {
  const out: ImportArgs = { files: [], dryRun: false };
  const flags = new Map<string, (index: number) => number>([
    [
      '--dry-run',
      () => {
        out.dryRun = true;
        return 0;
      },
    ],
    [
      '--repo',
      index => {
        const v = readOption(argv, index);
        if (v === null) {
          console.error('error: --repo requires a value');
          process.exit(2);
        }
        out.repo = v;
        return 1;
      },
    ],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const handler = flags.get(arg);
    if (handler !== undefined) {
      i += handler(i);
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`error: unknown flag ${arg}`);
      usage();
    }
    out.files.push(arg);
  }
  if (out.files.length === 0) {
    console.error('error: bro debt import needs at least one SARIF file');
    usage();
  }
  return out;
}

/** Parse every artifact before anything writes — one unreadable or
 *  malformed file aborts the whole import, so a partial snapshot can
 *  never reach the resolve sweep looking like "findings fixed". */
function readImportRecords(ctx: CollectCtx, root: string, files: string[]): DebtRecord[] {
  try {
    return importSarifFiles(ctx, root, files);
  } catch (err) {
    console.error(`debt import: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/** The writes of a non-dry import — the harvest file, then the in-scope
 *  resolve overlays. The import IS a complete snapshot of exactly the
 *  artifacts it read: a row scoped to one of them but absent from the
 *  fresh read resolved upstream (spec bro-l8c4f.15). */
function writeImport(ctx: CollectCtx, records: DebtRecord[], gone: string[]): void {
  if (records.length > 0) {
    writeHarvestFile({
      pr: 0,
      source: 'sverka',
      runId: ctx.runId,
      harvestedAt: ctx.harvestedAt,
      records,
    });
    reopenTerminalRows(records);
  }
  if (gone.length === 0) {
    return;
  }
  upsertLedgerOverlays(
    gone.map(thread_id => ({
      thread_id,
      status: 'done' as const,
      fix_pr: null,
      fixed_at: new Date().toISOString(),
      notes: 'resolved upstream — no longer reported',
    }))
  );
  console.error(`debt: sverka — resolved ${gone.length} row(s) no longer reported`);
}

/** Explicit import of a completed sverka/SARIF artifact (spec
 *  bro-l8c4f.15). Parse-all-then-write: one unreadable/malformed file
 *  aborts the whole import — a partial snapshot must never close rows.
 *  The resolve sweep is scoped to exactly the artifacts imported: rows
 *  belonging to other files are out of scope and stay untouched. */
export function cmdImport(argv: string[]): void {
  const args = parseImportArgs(argv);
  const root = gitTry(['rev-parse', '--show-toplevel']).out.trim() || process.cwd();
  const ctx: CollectCtx = {
    repo: resolveImportRepo(args.repo, root),
    runId: `import-${randomUUID().slice(0, 8)}`,
    harvestedAt: new Date().toISOString(),
    dir: root,
  };
  // Positionals resolve against the checkout top once — the spawn cwd
  // may be a repo subdirectory, and validation, reading, and artifact
  // keys must all see the same (root-relative) file.
  const files = args.files.map(f => resolve(root, f));
  for (const f of files) {
    assertImportableFile(root, f);
  }
  const records = readImportRecords(ctx, root, files);
  const artifacts = [...new Set(files.map(f => sarifArtifactPath(root, f)))];
  const gone = resolvedThreadIds(readDebtRecords(), 'sverka', records, sverkaFileScope(artifacts));
  console.error(
    `debt: sverka — ${records.length} finding(s) from ${artifacts.length} artifact(s)` +
      (args.dryRun ? ` — would resolve ${gone.length} row(s)` : '')
  );
  if (args.dryRun) {
    for (const row of records) {
      console.log(JSON.stringify(row));
    }
    for (const id of gone) {
      console.log(id);
    }
    return;
  }
  writeImport(ctx, records, gone);
  refreshDebtLedger();
}
