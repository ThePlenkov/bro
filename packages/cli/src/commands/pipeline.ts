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
import { bdActor, hasHelpFlag, printUsage } from '@broject/core';
import {
  appendCustomerRecord,
  awaitingCustomerRuns,
  type AwaitingRun,
  customerChannelPath,
} from '@broject/pipeline';
import { flag, positionals } from './args.ts';

const USAGE = `usage: bro pipeline <command> [args…]

commands:
  accept <item> <verdict>   record the customer's accept-gate verdict
                            (accepted|rejected|abandon; --notes required
                            on rejected — it is the fix scope)
  answer <item>             record the customer's answers for an intake
                            questions park

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

/** The signer identity — explicit --by wins, else the env badge a
 *  spawned agent-customer carries, else the store's actor chain. An
 *  unresolvable identity is a hard fail: a verdict with no signer
 *  can never pass the gate, so recording it is worse than refusing. */
function signer(argv: string[], dir: string): string {
  const badge = process.env.BRO_AGENT_ID?.trim();
  const by = flag(argv, '--by') ?? (badge !== undefined && badge !== '' ? badge : bdActor(dir));
  if (by === '') {
    fail('cannot resolve the signer — pass --by or set BRO_AGENT_ID');
  }
  return by;
}

/** The run this record belongs to: --run pins it, else the sole run
 *  parked at `stage` for `item` wins, else we refuse — a verdict for
 *  no run (or an ambiguous one) must never land in a channel. */
function targetRun(
  argv: string[],
  dir: string,
  item: string,
  stage: string,
  verdicts: readonly string[] = []
): AwaitingRun {
  const pinned = flag(argv, '--run');
  if (pinned !== undefined) {
    return { runId: pinned, stage, via: 'pending' };
  }
  const hits = awaitingCustomerRuns(dir, item, stage, verdicts);
  if (hits.length === 0) {
    fail(`no run parked at ${stage} for ${item} — nothing awaits this input`);
  }
  if (hits.length > 1) {
    fail(
      `${hits.length} runs parked at ${stage} for ${item} — pin one with --run ` +
        `(${hits.map(h => h.runId).join(', ')})`
    );
  }
  return hits[0] ?? fail(`no run parked at ${stage} for ${item}`);
}

/** Append a record to a run's channel — the path's null case means no
 *  pipeline plane exists under this repo at all. */
function appendToRun(
  dir: string,
  runId: string,
  rec: Parameters<typeof appendCustomerRecord>[1]
): void {
  const file = ((): string | null => {
    try {
      return customerChannelPath({ dir, runId });
    } catch (e) {
      fail(`unsafe run id: ${(e as Error).message}`, 2);
    }
  })();
  if (file === null) {
    fail(`no pipeline plane under ${dir} — not a git repo`);
  }
  appendCustomerRecord(file, rec);
}

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
  const notes = flag(argv, '--notes');
  if (verdict === 'rejected' && (notes === undefined || notes.trim() === '')) {
    fail("--notes is required on rejected — it is the customer's fix scope", 2);
  }
  const dir = process.cwd();
  const run = targetRun(argv, dir, item, 'accept');
  appendToRun(dir, run.runId, {
    kind: 'verdict',
    item,
    verdict,
    accepted_by: signer(argv, dir),
    ...(notes !== undefined ? { notes } : {}),
    ts: new Date().toISOString(),
  });
  console.log(
    `recorded ${verdict} for ${item} on run ${run.runId} — resume the run to settle the gate`
  );
}

/** The answers payload: -m/--message is raw text; --answers-file
 *  reads a file that parses as JSON when it can (a structured
 *  qid→answer map), else the raw text. */
function answersPayload(argv: string[]): unknown {
  const message = flag(argv, '--message');
  const file = flag(argv, '--answers-file');
  if (message !== undefined && file !== undefined) {
    fail('pass --message OR --answers-file, not both', 2);
  }
  if (message !== undefined) {
    return message;
  }
  if (file === undefined) {
    fail('answer needs -m/--message or --answers-file', 2);
  }
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

/** `-m` → `--message`, ONLY in option position: a `-m` token that is
 *  another option's value (or sits past `--`) is literal answer text,
 *  never a flag — rewriting it would corrupt the very payload being
 *  recorded. Walk once: a bare value flag consumes the next token
 *  verbatim (even when it spells `-m`), and `--` ends flag scanning. */
function normalizeShortFlag(argv: string[]): string[] {
  const valueFlags = new Set(['-m', '--message', '--answers-file', '--by', '--run']);
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
    if (a.startsWith('-m=')) {
      out.push(`--message=${a.slice(3)}`);
      continue;
    }
    const name = a.split('=', 1)[0]!;
    out.push(a === '-m' ? '--message' : a);
    // a known value flag in bare form consumes the next token as its
    // value — copied untouched, so `--message -m=x` keeps `-m=x` as text
    if (a === name && valueFlags.has(name) && i + 1 < argv.length) {
      i += 1;
      out.push(argv[i]!);
    }
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
  const answers = answersPayload(norm);
  const dir = process.cwd();
  // intake's wait states: parked on the `questions` verdict, a pending
  // intake intent, or a repairable intake alert
  const run = targetRun(norm, dir, item, 'intake', ['questions']);
  const by = flag(norm, '--by');
  appendToRun(dir, run.runId, {
    kind: 'answer',
    item,
    answers,
    ...(by !== undefined ? { by } : {}),
    ts: new Date().toISOString(),
  });
  console.log(
    `recorded answers for ${item} on run ${run.runId} — resume the run to continue intake`
  );
}

/** `bro pipeline <command>` — the customer channel's write surface. */
export function runPipelineCommand(argv: string[]): void {
  const [verb, ...rest] = argv;
  if (hasHelpFlag(argv) || verb === undefined) {
    printUsage(USAGE, hasHelpFlag(argv) ? 0 : 2);
  }
  switch (verb) {
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
