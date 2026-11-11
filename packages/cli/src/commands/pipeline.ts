/**
 * `bro pipeline` — the customer-verdict surface for the agile
 * pipeline (specs/bro-7d5nb.md §accept, §customer channels). A run
 * suspended at a customer gate waits on durable input; this command
 * writes that input into the run's customer channel
 * (`<git-common>/bro/pipeline/<run>.customer.jsonl`):
 *
 *   bro pipeline accept <item> accepted|rejected|abandon [--notes …]
 *   bro pipeline answer <item> (-m <text>|--answers-file <path>)
 *
 * `accept` journals the verdict the accept gate's `verdictStore` seam
 * reads back on the next wake — signed with `accepted_by`, which the
 * gate compares against the run's recorded customer; only that
 * identity can move the gate (a worker can never self-accept, and a
 * `rejected` verdict without `--notes` is refused here — the gate
 * would park it the same way). `answer` lands the customer's replies
 * for an intake `questions` park.
 *
 * The target run resolves by scanning the pipeline plane for the run
 * parked at the gate for `<item>`; `--run` pins it explicitly.
 */
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bdActor, hasHelpFlag, printUsage } from '@broject/core';
import {
  type AwaitingRun,
  appendCustomerRecord,
  awaitingCustomerRuns,
  contentDigest,
  customerChannelPath,
  type EngineMap,
  loadPipelineFormula,
  pipelineKey,
  signCustomerRecord,
  startRuns,
  type StartReport,
  verdictDigest,
} from '@broject/pipeline';
import { readyBeads } from '@broject/rig';
import { engines as productionEngines } from '../pipeline-engines.ts';
import { flag, flagAll, positionals } from './args.ts';

const USAGE = `usage: bro pipeline <command> [args…]

commands:
  run [<item>…]             start fresh pipeline runs for queued items —
                            scans ready beads carrying --label (default
                            'pipeline'), or the explicit <item>/--item ids
  accept <item> <verdict>   record the customer's accept-gate verdict
                            (accepted|rejected|abandon; --notes required
                            on rejected — it is the fix scope)
  answer <item>             record the customer's answers for an intake
                            questions park

run flags:
  --formula <file>          REQUIRED — the pipeline formula (TOML) every
                            run stamps and drives
  --engines <module>        path to a module exporting 'engines' (an
                            EngineMap or (dir)=>EngineMap) — replaces the
                            built-in production map wholesale
  --customer <id>           the recorded customer (accept authority) —
                            default: $BRO_CUSTOMER, else the bd actor
  --label <label>           the queue label to scan (default 'pipeline')
  --item <id>               explicit bead id (repeatable) — bypasses the
                            label scan, not dedup/admission/occupancy
  --limit <n>               cap how many candidates this invocation scans
  --dry-run                 resolve queue/customer/formula/dedup; report
                            what WOULD start without invoking runPipeline
  --json                    machine-readable report

flags:
  --notes <text>            the customer's notes (required on rejected)
  --by <id>                 signer identity — default: $BRO_AGENT_ID, else
                            the store's actor chain
  --run <id>                the run to write to — default: the sole run
                            parked at the gate for <item>
  -m, --message <text>      answer text for 'answer'
  --answers-file <path>     answers from a file (JSON parsed when it
                            parses, else the raw text)
  --help                    this usage
`;

/** accept's declared verdict words — the formula enum's own order. */
const ACCEPT_VERDICTS = ['accepted', 'rejected', 'abandon'] as const;

function fail(msg: string, code = 1): never {
  console.error(`pipeline: ${msg}`);
  process.exit(code);
}

/** The env-badge identity — `BRO_AGENT_ID` set and non-empty, else
 *  undefined (an empty badge is no badge — never a signer). */
const envSigner = (): string | undefined => {
  const badge = process.env.BRO_AGENT_ID?.trim();
  return badge === undefined || badge === '' ? undefined : badge;
};

/** One command's invocation — the normalized argv it parses and the
 *  repo dir it resolves the pipeline plane under. Internal only;
 *  the exported command surfaces keep their argv shape. */
interface CmdCtx {
  argv: string[];
  dir: string;
}

/** The gate a record targets — which stage's park for which item the
 *  run scan looks for (verdicts narrow the parked wait state). */
interface Gate {
  item: string;
  stage: string;
  verdicts?: readonly string[];
}

/** The command's flag reads — parsed once per invocation so
 *  downstream code reads fields instead of repeated argv lookups. */
interface Flags {
  run?: string;
  by?: string;
  notes?: string;
  message?: string;
  answersFile?: string;
}

const flagsOf = (argv: string[]): Flags => ({
  run: flag(argv, '--run'),
  by: flag(argv, '--by'),
  notes: flag(argv, '--notes'),
  message: flag(argv, '--message'),
  answersFile: flag(argv, '--answers-file'),
});

/** The signer identity — explicit --by wins, else the env badge a
 *  spawned agent-customer carries, else the store's actor chain. An
 *  unresolvable identity is a hard fail: a verdict with no signer
 *  can never pass the gate, so recording it is worse than refusing. */
function signer(ctx: CmdCtx, f: Flags): string {
  const by = f.by ?? envSigner() ?? bdActor(ctx.dir);
  if (by === '') {
    fail('cannot resolve the signer — pass --by or set BRO_AGENT_ID');
  }
  return by;
}

/** The run this record belongs to: --run pins it, else the sole run
 *  parked at the gate wins, else we refuse — a verdict for no run
 *  (or an ambiguous one) must never land in a channel. */
function targetRun(ctx: CmdCtx, gate: Gate, f: Flags): AwaitingRun {
  const pinned = f.run;
  if (pinned !== undefined) {
    return { runId: pinned, stage: gate.stage, via: 'pending' };
  }
  const hits = awaitingCustomerRuns(ctx.dir, gate);
  if (hits.length === 0) {
    fail(`no run parked at ${gate.stage} for ${gate.item} — nothing awaits this input`);
  }
  if (hits.length > 1) {
    fail(
      `${hits.length} runs parked at ${gate.stage} for ${gate.item} — pin one with --run ` +
        `(${hits.map(h => h.runId).join(', ')})`
    );
  }
  return hits[0] ?? fail(`no run parked at ${gate.stage} for ${gate.item}`);
}

/** Append a record to a run's channel — the path's null case means no
 *  pipeline plane exists under this repo at all. */
function appendToRun(
  ctx: CmdCtx,
  run: AwaitingRun,
  rec: Parameters<typeof appendCustomerRecord>[1]
): void {
  const file = ((): string | null => {
    try {
      return customerChannelPath({ dir: ctx.dir, runId: run.runId });
    } catch (e) {
      fail(`unsafe run id: ${(e as Error).message}`, 2);
    }
  })();
  if (file === null) {
    fail(`no pipeline plane under ${ctx.dir} — not a git repo`);
  }
  appendCustomerRecord(file, rec);
}

/** A string with no non-whitespace content — no answer, no fix
 *  scope, nothing to record. */
const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

function cmdAccept(argv: string[]): void {
  const pos = positionals(argv, new Set(['--notes', '--by', '--run']), { strict: true });
  if (pos.length !== 2) {
    console.error('usage: bro pipeline accept <item> <accepted|rejected|abandon> [--notes …]');
    process.exit(2);
  }
  const [item, verdict] = pos as [string, string];
  if (!(ACCEPT_VERDICTS as readonly string[]).includes(verdict)) {
    fail(`verdict must be one of ${ACCEPT_VERDICTS.join('|')} — got ${JSON.stringify(verdict)}`, 2);
  }
  const f = flagsOf(argv);
  if (verdict === 'rejected' && blank(f.notes)) {
    fail("--notes is required on rejected — it is the customer's fix scope", 2);
  }
  const ctx: CmdCtx = { argv, dir: process.cwd() };
  const run = targetRun(ctx, { item, stage: 'accept' }, f);
  const acceptedBy = signer(ctx, f);
  const ts = new Date().toISOString();
  const key = pipelineKey();
  appendToRun(ctx, run, {
    kind: 'verdict',
    item,
    verdict,
    accepted_by: acceptedBy,
    ...(f.notes !== undefined ? { notes: f.notes } : {}),
    // a channel key resolved → the record carries its MAC proof;
    // the accept gate will require it. The content slot digests the
    // {verdict, notes} payload — rewritten fix-scope notes break
    // the MAC too. No key → unsigned (the label-check degraded
    // mode — operator trust)
    ...(key !== undefined
      ? {
          signature: signCustomerRecord(key, {
            runId: run.runId,
            item,
            kind: 'verdict',
            content: verdictDigest({ verdict, notes: f.notes }),
            signer: acceptedBy,
            ts,
          }),
        }
      : {}),
    ts,
  });
  console.log(
    `recorded ${verdict} for ${item} on run ${run.runId} — resume the run to settle the gate`
  );
}

/** The --answers-file payload — JSON when the file parses (a
 *  structured qid→answer map), the raw text otherwise. An unreadable
 *  file is a hard fail — recording nothing is worse than refusing. */
function answersFromFile(f: Flags): unknown {
  const file = f.answersFile ?? fail('answer needs -m/--message or --answers-file', 2);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`cannot read --answers-file ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The answers payload: -m/--message is raw text; --answers-file
 *  reads a file that parses as JSON when it can (a structured
 *  qid→answer map), else the raw text. */
function answersPayload(f: Flags): unknown {
  if (f.message !== undefined && f.answersFile !== undefined) {
    fail('pass --message OR --answers-file, not both', 2);
  }
  if (f.message !== undefined) {
    return f.message;
  }
  if (f.answersFile === undefined) {
    fail('answer needs -m/--message or --answers-file', 2);
  }
  return answersFromFile(f);
}

/** Flag spellings that take the NEXT token as their value — a bare
 *  token consumes it verbatim (even when it spells `-m`), an inline
 *  `=<v>` spelling never does. */
const VALUE_FLAGS = new Set(['-m', '--message', '--answers-file', '--by', '--run']);

/** One token's emitted spelling + how many further tokens it
 *  consumes, where `next` is the following argv token (undefined at
 *  the tail). `-m` in option position rewrites to `--message`
 *  (`-m=<v>` lands inline, a bare `-m` takes `next` verbatim); a bare
 *  value flag copies `next` untouched even when it spells `-m`; an
 *  inline `=<v>` token carries its value inside and consumes
 *  nothing. Segment equality decides the flag name — `-mfoo` is
 *  literal text, never the option. */
const emitFor = (t: {
  a: string;
  next: string | undefined;
}): { tokens: string[]; consumed: number } => {
  const { a, next } = t;
  const name = a.split('=', 1)[0]!;
  if (name === '-m') {
    // `-m=<v>` lands inline; a bare `-m` takes `next` verbatim
    if (name !== a) {
      return { tokens: [`--message=${a.slice(name.length + 1)}`], consumed: 0 };
    }
    return next === undefined
      ? { tokens: ['--message'], consumed: 0 }
      : { tokens: ['--message', next], consumed: 1 };
  }
  // an inline `=<v>` token carries its value inside — consumes none;
  // only a BARE value flag takes `next`
  if (name !== a) {
    return { tokens: [a], consumed: 0 };
  }
  const bareValueFlag = VALUE_FLAGS.has(a) && next !== undefined;
  return bareValueFlag ? { tokens: [a, next], consumed: 1 } : { tokens: [a], consumed: 0 };
};

/** `-m` → `--message`, ONLY in option position: a `-m` token that is
 *  another option's value (or sits past `--`) is literal answer text,
 *  never a flag — rewriting it would corrupt the very payload being
 *  recorded. Walk once: a bare value flag consumes the next token
 *  verbatim (even when it spells `-m`), and `--` ends flag scanning. */
function normalizeShortFlag(argv: string[]): string[] {
  const out: string[] = [];
  let verbatim = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (verbatim) {
      out.push(a);
      continue;
    }
    if (a === '--') {
      verbatim = true;
      out.push(a);
      continue;
    }
    const step = emitFor({ a, next: argv[i + 1] });
    out.push(...step.tokens);
    i += step.consumed;
  }
  return out;
}

function cmdAnswer(argv: string[]): void {
  // -m is a single-dash spelling — normalize it before the flag pass
  // so the shared parser (which only speaks --flags) sees it
  const norm = normalizeShortFlag(argv);
  const pos = positionals(norm, new Set(['--message', '--answers-file', '--by', '--run']), {
    strict: true,
  });
  if (pos.length !== 1) {
    console.error('usage: bro pipeline answer <item> (-m <text>|--answers-file <path>)');
    process.exit(2);
  }
  const [item] = pos as [string];
  const f = flagsOf(norm);
  const answers = answersPayload(f);
  const ctx: CmdCtx = { argv: norm, dir: process.cwd() };
  // intake's wait states: parked on the `questions` verdict, a pending
  // intake intent, or a repairable intake alert
  const run = targetRun(ctx, { item, stage: 'intake', verdicts: ['questions'] }, f);
  const ts = new Date().toISOString();
  const key = pipelineKey();
  appendToRun(ctx, run, {
    kind: 'answer',
    item,
    answers,
    ...(f.by !== undefined ? { by: f.by } : {}),
    // same keyed MAC as verdicts — the content slot binds a digest
    // of `answers` so swapped payload bytes fail to verify
    ...(key !== undefined
      ? {
          signature: signCustomerRecord(key, {
            runId: run.runId,
            item,
            kind: 'answer',
            content: contentDigest(answers),
            signer: f.by,
            ts,
          }),
        }
      : {}),
    ts,
  });
  console.log(
    `recorded answers for ${item} on run ${run.runId} — resume the run to continue intake`
  );
}

// --- run — the queue→runPipeline starter (specs/bro-qjji2.10.md) -----------

/** run's flag reads — the value flags it declares plus the boolean
 *  switches. `--item` is repeatable (flagAll), so it is not in the
 *  single-value flag set. */
interface RunFlags {
  formula?: string;
  engines?: string;
  customer?: string;
  label?: string;
  limit?: string;
  dryRun: boolean;
  json: boolean;
}

/** The value-flags `run` consumes a following token for — everything
 *  `positionals` must skip over when collecting explicit item ids. */
const RUN_VALUE_FLAGS = new Set([
  '--formula',
  '--engines',
  '--customer',
  '--label',
  '--limit',
  '--item',
]);
const RUN_BOOL_FLAGS = new Set(['--dry-run', '--json']);

const runFlagsOf = (argv: string[]): RunFlags => ({
  formula: flag(argv, '--formula'),
  engines: flag(argv, '--engines'),
  customer: flag(argv, '--customer'),
  label: flag(argv, '--label'),
  limit: flag(argv, '--limit'),
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
});

/** The admit-intent set the run and the engine map share — spawn-like
 *  intents only (the runner's DEFAULT_ADMIT_INTENTS). stageDispatch's
 *  recheck consults the SAME set, so it is computed once and passed to
 *  both; a drift between them would silently change park/re-fire
 *  behavior. */
const RUN_ADMIT_INTENTS = ['spawn'] as const;

/** Resolve the recorded customer — the accept-gate authority. Precedence:
 *  --customer > $BRO_CUSTOMER > the bd actor chain. BRO_AGENT_ID is
 *  deliberately absent: it is the running agent's badge, and letting it
 *  default the customer would let whatever worker invokes `run` become
 *  its own acceptance authority. An unresolvable customer is a hard
 *  fail — a run whose accept gate can never be signed is worse than no
 *  run. */
function resolveRunCustomer(dir: string, f: RunFlags): string {
  const envCustomer = process.env.BRO_CUSTOMER?.trim();
  const actor = bdActor(dir).trim();
  const customer =
    f.customer ??
    (envCustomer !== undefined && envCustomer !== '' ? envCustomer : undefined) ??
    (actor !== '' ? actor : undefined);
  if (customer === undefined) {
    fail('customer-unresolved — pass --customer, set BRO_CUSTOMER, or configure the bd actor', 1);
  }
  return customer;
}

/** The candidate items: explicit ids (positionals + repeatable --item)
 *  bypass the label scan; otherwise the ready-queue scan for beads
 *  carrying --label (default 'pipeline'). Explicit items are NOT
 *  label-filtered — naming a bead is the operator's opt-in. */
function runCandidates(ctx: CmdCtx, argv: string[], f: RunFlags): string[] {
  const explicit = [
    ...positionals(argv, RUN_VALUE_FLAGS, { boolFlags: RUN_BOOL_FLAGS, strict: true }),
    ...flagAll(argv, '--item'),
  ];
  if (explicit.length > 0) {
    return explicit;
  }
  const label = f.label ?? 'pipeline';
  return readyBeads(ctx.dir)
    .filter(b => (b.labels ?? []).includes(label))
    .map(b => b.id);
}

/** `--limit` → a non-negative integer cap on candidates scanned; a
 *  malformed value is a usage error, never a silent drop. */
function runLimit(f: RunFlags): number | undefined {
  if (f.limit === undefined) {
    return undefined;
  }
  const n = Number(f.limit);
  if (!Number.isInteger(n) || n < 0) {
    fail(`--limit must be a non-negative integer, got ${JSON.stringify(f.limit)}`, 2);
  }
  return n;
}

/** Resolve the engine map: `--engines <module>` replaces the WHOLE map
 *  (the waker's contract — no per-slot merge); absent → the built-in
 *  production map bound to this dir + the run's formula identity and
 *  admit-intent set. The module's `engines` export is an EngineMap or a
 *  `(dir) => EngineMap` factory. */
async function resolveRunEngines(ctx: CmdCtx, f: RunFlags, formulaSha: string): Promise<EngineMap> {
  if (f.engines !== undefined) {
    const path = isAbsolute(f.engines) ? f.engines : resolve(process.cwd(), f.engines);
    let mod: { engines?: unknown };
    try {
      mod = (await import(pathToFileURL(path).href)) as { engines?: unknown };
    } catch (e) {
      fail(
        `--engines ${f.engines}: cannot load module — ${e instanceof Error ? e.message : String(e)}`,
        2
      );
    }
    const bound = mod.engines;
    if (bound === undefined) {
      fail(`--engines ${f.engines}: module exports no 'engines'`, 2);
    }
    const resolved =
      typeof bound === 'function'
        ? await (bound as (d: string) => EngineMap | Promise<EngineMap>)(ctx.dir)
        : (bound as EngineMap);
    if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
      fail(`--engines ${f.engines}: 'engines' must be an EngineMap or (dir)=>EngineMap`, 2);
    }
    return resolved;
  }
  return productionEngines(ctx.dir, {
    formula: basename(f.formula ?? 'pipeline'),
    formulaSha,
    admitIntents: RUN_ADMIT_INTENTS,
  });
}

/** Human-readable run report — one line per candidate plus a summary.
 *  The JSON form is the StartReport verbatim. */
function printRunReport(report: StartReport): void {
  const sha = report.formulaSha.slice(0, 12);
  console.log(
    `pipeline run — formula ${sha} customer ${report.customer ?? '(none)'}${report.dryRun ? ' (dry-run)' : ''}`
  );
  for (const it of report.items) {
    switch (it.action) {
      case 'started':
        console.log(
          `  ${it.item}: started run ${it.runId} → ${it.outcome}/${it.stage}` +
            (it.sidecar === true ? ' · formula sidecar' : '') +
            (it.alert !== undefined ? ` · alert ${it.alert}` : '')
        );
        break;
      case 'already-running':
        console.log(`  ${it.item}: already-running`);
        break;
      case 'would-start':
        console.log(`  ${it.item}: would-start`);
        break;
      case 'failed':
        console.log(`  ${it.item}: failed — ${it.error ?? 'unknown'}`);
        break;
    }
  }
  console.log(
    `summary: ${report.started} started, ` +
      `${report.items.filter(i => i.action === 'already-running').length} already-running, ` +
      `${report.items.filter(i => i.action === 'failed').length} failed ` +
      `(scanned ${report.scanned})`
  );
}

/** `bro pipeline run` — scan the queue, resolve the customer, bind the
 *  engine map, stamp formulaSha, and invoke fresh runPipeline runs. The
 *  starter owns dedup/admission/sidecar; this command owns queue
 *  selection, customer resolution, formula loading, and the engine map. */
async function cmdRun(argv: string[]): Promise<void> {
  const f = runFlagsOf(argv);
  const ctx: CmdCtx = { argv, dir: process.cwd() };
  if (f.formula === undefined) {
    fail('run needs --formula <file> — the pipeline formula every run drives', 2);
  }
  let loaded: ReturnType<typeof loadPipelineFormula>;
  let formulaBytes: Buffer;
  try {
    loaded = loadPipelineFormula(f.formula);
    formulaBytes = readFileSync(f.formula);
  } catch (e) {
    fail(`--formula ${f.formula}: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
  const customer = resolveRunCustomer(ctx.dir, f);
  const items = runCandidates(ctx, argv, f);
  const limit = runLimit(f);
  const bounded = limit === undefined ? items : items.slice(0, limit);
  const engines = await resolveRunEngines(ctx, f, loaded.sha);
  const report = await startRuns({
    dir: ctx.dir,
    formula: loaded,
    formulaBytes,
    customer,
    engines,
    items: bounded,
    dryRun: f.dryRun,
    runOptions: {
      admit: () => true,
      admitIntents: [...RUN_ADMIT_INTENTS],
    },
  });
  if (f.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printRunReport(report);
  }
}

/** `bro pipeline <command>` — the customer channel's write surface and
 *  the run starter. `run` is the only async verb (it awaits runPipeline
 *  to each park/halt) — its Promise is returned for the dispatcher to
 *  await; accept/answer stay synchronous so their exit()/output contract
 *  is unchanged. */
export function runPipelineCommand(argv: string[]): void | Promise<void> {
  const [verb, ...rest] = argv;
  if (hasHelpFlag(argv) || verb === undefined) {
    printUsage(USAGE, hasHelpFlag(argv) ? 0 : 2);
  }
  switch (verb) {
    case 'run':
      return cmdRun(rest);
    case 'accept':
      cmdAccept(rest);
      return;
    case 'answer':
      cmdAnswer(rest);
      return;
    default:
      console.error(`pipeline: unknown command ${JSON.stringify(verb)}`);
      printUsage(USAGE, 2);
  }
}
