import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { MergeProbe, MergeTarget } from '@broject/convoy';
import { runConvoyCommand } from './convoy.ts';

/** A scripted `bd` — the molecule, the formula and the task rows the
 *  convoy reads, plus a log of the closes it was asked for. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  info) echo '{"schema_version":1}' ;;
  config)
    case "$2" in
      get) echo 'agent,human,merge-step' ;;
      set) : ;;
    esac ;;
  mol)
    case "$2" in
      show) cat "$FAKE_BD_MOL" ;;
    esac ;;
  formula)
    case "$2" in
      show) cat "$FAKE_BD_FORMULA" ;;
    esac ;;
  show) cat "$FAKE_BD_TASKS" ;;
  close) printf '%s\\n' "$*" >> "$FAKE_BD_LOG" ;;
  list) echo '[]' ;;
  ready) echo '[]' ;;
  *) : ;;
esac
`;

const MERGE_TITLE = 'Merge — bro act wait --merge';
const PR = 958;

/** The molecule: a closed verify step and a ready merge step. */
function moleculeJson(mergeType: string): string {
  return JSON.stringify({
    root: { id: 'm-1', title: 'ship-bead', status: 'open', issue_type: 'molecule' },
    issues: [
      { id: 'm-1', title: 'ship-bead', status: 'open', issue_type: 'molecule' },
      {
        id: 's-0',
        title: 'Verify — bro act status until exit 0',
        status: 'closed',
        issue_type: 'agent',
      },
      { id: 's-1', title: MERGE_TITLE, status: 'open', issue_type: mergeType },
    ],
    dependencies: [{ issue_id: 's-1', depends_on_id: 's-0', type: 'blocks' }],
  });
}

/** The formula the molecule was poured from — the declaration lives
 *  here when bd flattened the poured type. */
function formulaJson(stepType: string): string {
  return JSON.stringify({
    formula: 'ship-bead',
    steps: [
      { id: 'work', title: 'Implement {{bead}} per its spec', type: 'agent' },
      { id: 'pr-gate', title: 'Verify — bro act status until exit 0', type: 'agent' },
      { id: 'merge', title: MERGE_TITLE, type: stepType },
    ],
  });
}

function tasksJson(reason: string): string {
  return JSON.stringify([
    {
      id: 's-0',
      title: 'Verify — bro act status until exit 0',
      status: 'closed',
      close_reason: reason,
    },
  ]);
}

interface Fixture {
  closes: () => string;
  cleanup: () => void;
  run: (
    args: string[],
    probe?: (target: MergeTarget) => Promise<MergeProbe>
  ) => Promise<void>;
}

/** A fake bd on PATH + the molecule/formula it serves. */
function fixture(opts: {
  mergeType: string;
  formulaType: string;
  upstreamReason?: string;
}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'bro-convoy-merge-'));
  writeFileSync(join(dir, 'bd'), FAKE_BD);
  chmodSync(join(dir, 'bd'), 0o755);
  const mol = join(dir, 'mol.json');
  const formula = join(dir, 'formula.json');
  const tasks = join(dir, 'tasks.json');
  const log = join(dir, 'closes.log');
  writeFileSync(mol, moleculeJson(opts.mergeType));
  writeFileSync(formula, formulaJson(opts.formulaType));
  writeFileSync(
    tasks,
    tasksJson(opts.upstreamReason ?? `Gate green on [#${PR}](https://github.com/o/r/pull/${PR})`)
  );
  const prev = {
    PATH: process.env.PATH,
    FAKE_BD_MOL: process.env.FAKE_BD_MOL,
    FAKE_BD_FORMULA: process.env.FAKE_BD_FORMULA,
    FAKE_BD_TASKS: process.env.FAKE_BD_TASKS,
    FAKE_BD_LOG: process.env.FAKE_BD_LOG,
  };
  process.env.PATH = `${dir}:${prev.PATH ?? ''}`;
  process.env.FAKE_BD_MOL = mol;
  process.env.FAKE_BD_FORMULA = formula;
  process.env.FAKE_BD_TASKS = tasks;
  process.env.FAKE_BD_LOG = log;
  return {
    closes: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    cleanup: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    run: async (args, probe) => {
      await runConvoyCommand(args, probe ? { probe } : undefined);
    },
  };
}

/** One scenario: what the fixture serves, what the host answers, what
 *  the convoy must do. The table keeps the cases side by side — one
 *  shape of setup, one shape of assertion. */
interface Scenario {
  name: string;
  /** the poured step's type — bd flattens an unregistered type */
  mergeType?: string;
  /** the type the formula declares */
  formulaType?: string;
  /** the upstream step's close reason */
  upstreamReason?: string;
  /** the agent's own sentence */
  result: string;
  /** the host's answer — absent when the host must not be asked */
  answer?: (target: MergeTarget) => Promise<MergeProbe>;
  /** the exit code the command must leave */
  exit?: number;
  /** the closes the command must have asked for */
  closed?: RegExp[];
  /** the PRs the host was asked about */
  asked?: number[];
}

/** The host's answer for a merged PR — one record, shared by the cases
 *  that need it. */
const MERGED: MergeProbe = {
  state: 'MERGED',
  mergedBy: 'ThePlenkov',
  mergeSha: 'd11788ce1234',
};

/** Run one scenario against the fixture and assert what it must do. */
async function runScenario(s: Scenario): Promise<void> {
  const f = fixture({
    mergeType: s.mergeType ?? 'merge-step',
    formulaType: s.formulaType ?? 'merge-step',
    upstreamReason: s.upstreamReason,
  });
  const asked: number[] = [];
  const answer = s.answer;
  const prev = process.exitCode;
  try {
    await f.run(['done', 's-1', '--result', s.result, '--mol', 'm-1'], async t => {
      asked.push(t.pr);
      if (answer === undefined) throw new Error('the host must not be asked');
      return answer(t);
    });
    assert.equal(process.exitCode, s.exit);
    const closes = f.closes();
    if (s.closed === undefined) {
      assert.equal(closes, '');
    } else {
      for (const want of s.closed) assert.match(closes, want);
    }
    if (s.asked !== undefined) assert.deepEqual(asked, s.asked);
  } finally {
    process.exitCode = prev;
    f.cleanup();
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a merged PR closes the step and the verdict leads the close reason',
    result: `PR #${PR} merged by the watcher`,
    answer: async () => MERGED,
    closed: [/close s-1 --reason/, /verified: PR #958 MERGED \(merge d11788ce, by ThePlenkov\)/],
    asked: [PR],
  },
  {
    name: 'an open PR refuses — the gate holds and the step stays open',
    result: `PR #${PR} merged`,
    answer: async () => ({ state: 'OPEN' }),
    exit: 3,
    asked: [PR],
  },
  {
    name: 'the handoff names the PR when the result does not',
    result: 'merged it',
    answer: async () => ({ state: 'OPEN' }),
    exit: 3,
    asked: [PR],
  },
  {
    name: 'a claim with no PR anywhere is refused before the host is asked',
    upstreamReason: 'Gate green.',
    result: 'merged it',
    answer: async () => MERGED,
    exit: 3,
    asked: [],
  },
  {
    name: 'the formula declares the merge step even when bd flattened the type',
    mergeType: 'task',
    result: `PR #${PR} merged`,
    answer: async () => ({ state: 'OPEN' }),
    exit: 3,
    asked: [PR],
  },
  {
    name: 'a step that is not a merge step closes as before',
    mergeType: 'agent',
    formulaType: 'agent',
    result: 'done',
    closed: [/close s-1 --reason done/],
    asked: [],
  },
];

describe('convoy done — the merge step closes on a verdict', () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      await runScenario(s);
    });
  }
});
