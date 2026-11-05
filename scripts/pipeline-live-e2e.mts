/** Live e2e proof for the agile pipeline contract (specs/bro-7d5nb.md).
 *  Everything around the contract is REAL: the repo's own durable
 *  pipeline plane (.git/bro/pipeline/), the bd-backed taskSpec facade
 *  reading a real bead's `## Acceptance`, the real intake/verify/accept
 *  stage engines, real shell probes as per-AC evidence, and the built
 *  `bro pipeline accept` CLI writing the customer verdict. The only
 *  seams are the stages not under test (classify/route/work/review/
 *  merge/capture) — work's fleet spawn needs a real provider budget.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { taskSpecFacade, taskStore } from '../packages/core/src/index.ts';
import {
  acceptStage,
  type EngineMap,
  type EngineResult,
  fileAnswerFeed,
  fileVerdictStore,
  formulaSha,
  intakeStage,
  openPipelineJournal,
  parsePipelineFormula,
  resumePipeline,
  type RunResult,
  runPipeline,
  type StageCall,
  verifyStage,
} from '../packages/pipeline/src/index.ts';
import { SPEC_FORMULA } from '../packages/pipeline/src/spec-formula.fixture.ts';

/** the checkout this script sits in — not a fixed absolute path:
 *  task-store, git, evidence, and CLI ops must all use the same
 *  checkout the script's imports come from */
const DIR = fileURLToPath(new URL('..', import.meta.url));
const ITEM = 'bro-qjji2.6';
const CUSTOMER = 'petr';
const EVIDENCE = 'specs/bro-7d5nb-emulation.md';

const formula = parsePipelineFormula(parse(SPEC_FORMULA));
const sha = formulaSha(SPEC_FORMULA);
const spec = taskSpecFacade(taskStore(DIR));

const sh = (args: string[]): string =>
  execFileSync(args[0]!, args.slice(1), { cwd: DIR, encoding: 'utf8' }).trim();

/** one REAL shell probe per declared AC — grep the actual artifact,
 *  the proof string IS the command and its output */
const probe = (ac: string): { verdict: 'pass' | 'fail'; proof: string } => {
  const a = ac.toLowerCase();
  const count = (pat: string): number => {
    // grep -ic exits 1 on zero matches — execFileSync throws; a
    // no-match is the count 0, not a failure (other exits still throw)
    try {
      return Number(sh(['grep', '-ic', pat, EVIDENCE]) || '0');
    } catch (e) {
      if ((e as { status?: number }).status === 1) {
        return 0;
      }
      throw e;
    }
  };
  if (a.includes('run entry')) {
    const n = count('run 8');
    return {
      verdict: n >= 5 ? 'pass' : 'fail',
      proof: `grep -ic 'run 8' ${EVIDENCE} → ${n} run entries (need ≥5 for .1–.5)`,
    };
  }
  if (a.includes('intake')) {
    const n = count('intake');
    return { verdict: n > 0 ? 'pass' : 'fail', proof: `grep -ic 'intake' ${EVIDENCE} → ${n}` };
  }
  if (a.includes('verify') || a.includes('evidence')) {
    const n = count('verify');
    return { verdict: n > 0 ? 'pass' : 'fail', proof: `grep -ic 'verify' ${EVIDENCE} → ${n}` };
  }
  if (a.includes('accept') || a.includes('accepted_by')) {
    const n = count('accept');
    return { verdict: n > 0 ? 'pass' : 'fail', proof: `grep -ic 'accept' ${EVIDENCE} → ${n}` };
  }
  return { verdict: 'fail', proof: `no probe bound for ac ${JSON.stringify(ac)}` };
};

const verdict = (v: string, payload?: Record<string, unknown>): EngineResult =>
  payload === undefined ? { verdict: v } : { verdict: v, payload };

const engines: EngineMap = {
  // judge slot serves classify/route/review — thin scripted verdicts
  judge: (call: StageCall) => {
    if (call.stage.name === 'classify') return verdict('solo', { complexity: 'complex' });
    if (call.stage.name === 'route') {
      return verdict('spawn', {
        provider: 'devin',
        model: 'swe-2-max',
        kind: 'devin',
        orch: 'interactive',
      });
    }
    return verdict('push'); // review → accept
  },
  // REAL intake — the judgment seam reads the real spec honestly,
  // and the customer-channel answer feed lands `bro pipeline answer`
  // records on the item before it judges
  intake: intakeStage({
    taskSpec: spec,
    answers: fileAnswerFeed(DIR),
    intake: (_call, s) =>
      (s.acceptance?.length ?? 0) > 0
        ? { verdict: 'accepted' }
        : { verdict: 'questions', questions: ['which acceptance criteria apply?'] },
  }),
  // work seam — the artifact already exists; journal its real provenance
  fleet: () =>
    verdict('done', {
      diff: { files: [EVIDENCE], head: sh(['git', 'rev-parse', 'HEAD']) },
    }),
  // REAL verify — per-AC evidence rows from real probes
  e2e: verifyStage({
    taskSpec: spec,
    e2e: (_call, ac) => {
      const r = probe(ac);
      return { ac, verdict: r.verdict, proof: r.proof };
    },
  }),
  // REAL accept — durable verdict store + emit surfaces the bundle
  accept: acceptStage({
    emit: (_call, bundle) => {
      console.log(`   [emit] evidence bundle → ${JSON.stringify(bundle).slice(0, 200)}…`);
    },
    verdictStore: fileVerdictStore(DIR),
  }),
  'act-gate': () => verdict('landed'),
  learn: () => verdict('captured'),
};

const show = (label: string, r: RunResult): void =>
  console.log(
    `${label} → ${r.outcome} | stage: ${r.stage}` +
      (r.verdict !== undefined ? ` | verdict: ${r.verdict}` : '') +
      (r.alert !== undefined ? ` | alert: ${r.alert}` : '')
  );

const cli = (...args: string[]): string =>
  execFileSync('node', ['packages/cli/dist/index.js', ...args], {
    cwd: DIR,
    encoding: 'utf8',
  }).trim();

const formulaShaOpt = {
  formulaSha: sha,
  dir: DIR,
  customer: CUSTOMER,
  engines,
  admit: () => true as const, // the go-marker seam — spawn admission granted
};

const r1 = await runPipeline(formula, ITEM, formulaShaOpt);
show('1. run to gate', r1);
if (r1.outcome !== 'park' || r1.stage !== 'accept') process.exit(1);

const resume = () =>
  resumePipeline(formula, ITEM, openPipelineJournal({ dir: DIR, runId: r1.runId })!, {
    ...formulaShaOpt,
  });

// 2. a forged verdict — the CLI auto-discovers the parked run, the
//    identity gate must hold
console.log(`   ${cli('pipeline', 'accept', ITEM, 'accepted', '--by', 'mallory')}`);
const r2 = await resume();
show('2. forged accept (mallory ≠ petr)', r2);

// 3. the recorded customer's verdict — same discovery, gate settles
console.log(`   ${cli('pipeline', 'accept', ITEM, 'accepted', '--by', CUSTOMER)}`);
const r3 = await resume();
show('3. customer accept (petr)', r3);
