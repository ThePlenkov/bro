/** `rigNext` unit tests — the verdict ladder over durable state with no
 *  CLI in the loop (bro-jamp7's boundary rule): a scripted `bd` on PATH
 *  answers show/ready/list/dep, a tmpdir git repo holds the registry and
 *  linked worktrees, a `registerConnector`'d reviews host fakes the
 *  forge. No plugin registry, no `process.exit`, no spawned `bro`. */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  type ReviewFacade,
  registerConnector,
  testGitEnv,
  unregisterConnector,
} from '@broject/core';
import { rigFocus, rigNext } from './next.ts';

/** `show <id>` answers `$FAKE_BD_DIR/show-<id>.json` when the fixture
 *  wrote one — the miss is bd's real contract (`Issue <id> not found`
 *  on stderr + exit 1) so `store.get` reads undefined, not an error. */
const FAKE_BD = `#!/bin/sh
case "$1" in
  --version) echo 'bd 0.0' ;;
  info) echo '{"schema_version":1}' ;;
  show)
    f="$FAKE_BD_DIR/show-$2.json"
    if [ -f "$f" ]; then cat "$f"; else echo "Issue $2 not found" >&2; exit 1; fi ;;
  ready) cat "$FAKE_BD_READY" ;;
  dep) cat "$FAKE_BD_DEPS" ;;
  undefer) echo '[]' ;;
  list)
    case "$*" in
      *deferred*) echo '[]' ;;
      *drill*) cat "$FAKE_BD_DRILL" ;;
      *queue:*) cat "$FAKE_BD_QUEUE" ;;
      *) echo '[]' ;;
    esac ;;
  *) echo '[]' ;;
esac
`;

interface Fixture {
  dir: string;
  /** stage a `bd show` row for id */
  row: (id: string, row: Record<string, unknown>) => void;
  /** what `bd ready` answers */
  ready: (rows: unknown[]) => void;
  /** what `bd dep list` answers — hydrated neighbor rows */
  deps: (rows: unknown[]) => void;
  /** what `bd list -l queue:*` / `-l drill` answer */
  listed: (rows: unknown[], label?: 'queue' | 'drill') => void;
  /** `<git-common>/bro/agents.json` entries */
  agents: (entries: Record<string, unknown>) => void;
  restore: () => void;
}

const git = (dir: string, args: string[]): void => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: testGitEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};

function createGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-rig-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);
  return dir;
}

interface FakeBdSetup {
  fakeDir: string;
  files: Record<'ready' | 'deps' | 'queue' | 'drill', string>;
  restore: () => void;
}

function setupFakeBd(): FakeBdSetup {
  const fakeDir = mkdtempSync(join(tmpdir(), 'bro-fake-bd-'));
  writeFileSync(join(fakeDir, 'bd'), FAKE_BD);
  chmodSync(join(fakeDir, 'bd'), 0o755);
  const files = {
    ready: join(fakeDir, 'ready.json'),
    deps: join(fakeDir, 'deps.json'),
    queue: join(fakeDir, 'queue.json'),
    drill: join(fakeDir, 'drill.json'),
  };
  for (const file of Object.values(files)) {
    writeFileSync(file, '[]');
  }
  const previous: Record<string, string | undefined> = {};
  const setEnv = ({ key, value }: { key: string; value: string | undefined }): void => {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  setEnv({ key: 'PATH', value: `${fakeDir}:${process.env.PATH}` });
  setEnv({ key: 'FAKE_BD_DIR', value: fakeDir });
  setEnv({ key: 'FAKE_BD_READY', value: files.ready });
  setEnv({ key: 'FAKE_BD_DEPS', value: files.deps });
  setEnv({ key: 'FAKE_BD_QUEUE', value: files.queue });
  setEnv({ key: 'FAKE_BD_DRILL', value: files.drill });
  setEnv({ key: 'BEADS_ACTOR', value: 'tester' });
  setEnv({ key: 'BEADS_DIR', value: undefined });
  setEnv({ key: 'BD_ACTOR', value: undefined });
  return {
    fakeDir,
    files,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** A real git repo + a scripted `bd` on PATH. The store, the registry
 *  dir, and the worktree plane are all real reads — only the backend
 *  binaries are canned. */
function fixture(): Fixture {
  const dir = createGitFixture();
  const fake = setupFakeBd();
  return {
    dir,
    row: (id, row) => writeFileSync(join(fake.fakeDir, `show-${id}.json`), JSON.stringify([row])),
    ready: rows => writeFileSync(fake.files.ready, JSON.stringify(rows)),
    deps: rows => writeFileSync(fake.files.deps, JSON.stringify(rows)),
    listed: (rows, label = 'queue') =>
      writeFileSync(label === 'queue' ? fake.files.queue : fake.files.drill, JSON.stringify(rows)),
    agents: entries => {
      const bro = join(dir, '.git', 'bro');
      mkdirSync(bro, { recursive: true });
      writeFileSync(join(bro, 'agents.json'), JSON.stringify(entries));
    },
    restore: fake.restore,
  };
}

const bead = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('rigNext — the verdict ladder', () => {
  test('dead act-wait markers are the re-entry verdict before bead work', () => {
    const f = fixture();
    try {
      const bro = join(f.dir, '.git', 'bro', 'watches');
      mkdirSync(bro, { recursive: true });
      writeFileSync(
        join(bro, '7-4242-nonce.json'),
        JSON.stringify({
          pr: 7,
          link: '[#7](https://github.com/o/r/pull/7)',
          pid: 4242,
          merge: false,
          startedAt: Date.now(),
          timeoutMin: 10,
        })
      );
      assert.deepEqual(rigNext(f.dir), {
        verdict: 'step',
        detail: 'dead act-wait marker for PR #7 — act rearm',
      });
    } finally {
      f.restore();
    }
  });

  test('an armed supervisor without a live lock is a re-entry verdict', () => {
    const f = fixture();
    try {
      const bro = join(f.dir, '.git', 'bro');
      mkdirSync(bro, { recursive: true });
      writeFileSync(
        join(bro, 'drive.json'),
        JSON.stringify({ everySec: 60, armedAt: new Date().toISOString() })
      );
      assert.deepEqual(rigNext(f.dir), {
        verdict: 'step',
        detail: 'armed drive marker is dead — rearm',
      });
    } finally {
      f.restore();
    }
  });

  test('empty store reports done; an unknown id reports blocked', () => {
    const f = fixture();
    try {
      assert.deepEqual(rigNext(f.dir), { verdict: 'done' });
      assert.deepEqual(rigNext(f.dir, 'nope'), {
        verdict: 'blocked',
        id: 'nope',
        detail: 'unknown id',
      });
    } finally {
      f.restore();
    }
  });

  test('closed row is done; waiting label is wait with its WAKE predicate', () => {
    const f = fixture();
    try {
      f.row('c-1', bead('c-1', { status: 'closed' }));
      f.row(
        'w-1',
        bead('w-1', {
          labels: ['drill', 'waiting'],
          notes: 'context\nWAKE: gate green on #7',
        })
      );
      assert.deepEqual(rigNext(f.dir, 'c-1'), { verdict: 'done', id: 'c-1' });
      assert.deepEqual(rigNext(f.dir, 'w-1'), {
        verdict: 'wait',
        id: 'w-1',
        detail: 'gate green on #7',
      });
    } finally {
      f.restore();
    }
  });

  test('a live registry agent is wait; a remote one is wait too; a recorded exit falls through', () => {
    const f = fixture();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    assert.ok(sleeper.pid !== undefined);
    try {
      f.row('a-1', bead('a-1', { status: 'in_progress', assignee: 'tester' }));
      f.row('r-1', bead('r-1', { status: 'in_progress', assignee: 'tester' }));
      f.row('x-1', bead('x-1'));
      f.row('y-1', bead('y-1'));
      f.ready([bead('x-1'), bead('y-1')]);
      f.agents({
        'a-1': { agentId: 'native-zz', backend: 'native', pid: sleeper.pid },
        'r-1': { agentId: 'devin-zz', backend: 'devin', sessionId: 'sess-1' },
        'x-1': { agentId: 'native-yy', backend: 'native', exitStatus: 0 },
        'y-1': { agentId: 'native-yq', backend: 'native', pid: sleeper.pid },
      });
      assert.equal(rigNext(f.dir, 'a-1').verdict, 'wait');
      assert.match(rigNext(f.dir, 'a-1').detail ?? '', /agent native-zz in flight/);
      assert.equal(rigNext(f.dir, 'r-1').verdict, 'wait');
      // the recorded death drops the wait — the open+ready row steps
      assert.equal(rigNext(f.dir, 'x-1').verdict, 'step');
      // paired on the SAME row: in-flight waits, the recorded exit is
      // what clears it — not a different row's luck
      assert.equal(rigNext(f.dir, 'y-1').verdict, 'wait');
      f.agents({ 'y-1': { agentId: 'native-yq', backend: 'native', exitStatus: 0 } });
      assert.equal(rigNext(f.dir, 'y-1').verdict, 'step');
    } finally {
      sleeper.kill('SIGKILL');
      f.restore();
    }
  });

  test('stopped marker on a live pid still waits — SIGTERM has not landed', () => {
    const f = fixture();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    assert.ok(sleeper.pid !== undefined);
    try {
      f.row('s-1', bead('s-1', { status: 'in_progress', assignee: 'tester' }));
      f.agents({
        's-1': { agentId: 'native-zz', backend: 'native', pid: sleeper.pid, stopped: true },
      });
      assert.equal(rigNext(f.dir, 's-1').verdict, 'wait');
    } finally {
      sleeper.kill('SIGKILL');
      f.restore();
    }
  });

  test('foreign claim is blocked; own claim is step; dep-gated open is blocked', () => {
    const f = fixture();
    try {
      f.row('c-1', bead('c-1', { status: 'in_progress', assignee: 'other-actor' }));
      f.row('c-2', bead('c-2', { status: 'in_progress', assignee: 'tester' }));
      f.row('g-1', bead('g-1')); // open, gated by a live 'blocked' dep
      f.deps([{ ...bead('x-1'), dependency_type: 'blocks' }]);
      assert.equal(rigNext(f.dir, 'c-1').verdict, 'blocked');
      assert.match(rigNext(f.dir, 'c-1').detail ?? '', /claimed by other-actor/);
      assert.deepEqual(rigNext(f.dir, 'c-2'), {
        verdict: 'step',
        id: 'c-2',
        detail: 'own claim — resume',
      });
      assert.equal(rigNext(f.dir, 'g-1').verdict, 'blocked');
      assert.match(rigNext(f.dir, 'g-1').detail ?? '', /dep-gated by x-1/);
    } finally {
      f.restore();
    }
  });

  test('dependency verdict wins over a future deferral', () => {
    const f = fixture();
    try {
      f.row(
        'g-1',
        bead('g-1', {
          defer_until: new Date(Date.now() + 60_000).toISOString(),
        })
      );
      f.deps([{ ...bead('x-1'), dependency_type: 'blocks' }]);
      assert.deepEqual(rigNext(f.dir, 'g-1'), {
        verdict: 'blocked',
        id: 'g-1',
        detail: 'dep-gated by x-1',
      });
    } finally {
      f.restore();
    }
  });

  test('a future deferral only parks deferred rows', () => {
    const f = fixture();
    try {
      const deferUntil = new Date(Date.now() + 60_000).toISOString();
      f.row('o-1', bead('o-1', { defer_until: deferUntil }));
      f.row('d-1', bead('d-1', { status: 'deferred', defer_until: deferUntil }));
      assert.deepEqual(rigNext(f.dir, 'o-1'), {
        verdict: 'step',
        id: 'o-1',
        detail: undefined,
      });
      assert.deepEqual(rigNext(f.dir, 'd-1'), {
        verdict: 'blocked',
        id: 'd-1',
        detail: `deferred until ${deferUntil}`,
      });
    } finally {
      f.restore();
    }
  });

  test('open + ready is step; a queued row reports its rank', () => {
    const f = fixture();
    try {
      f.row('r-1', bead('r-1'));
      f.row('q-1', bead('q-1', { labels: ['queue:root', 'qrank:1'] }));
      f.ready([bead('r-1'), bead('q-1', { labels: ['queue:root', 'qrank:1'] })]);
      f.listed([bead('q-1', { labels: ['queue:root', 'qrank:1'] })]);
      assert.deepEqual(rigNext(f.dir, 'r-1'), { verdict: 'step', id: 'r-1', detail: undefined });
      assert.deepEqual(rigNext(f.dir, 'q-1'), {
        verdict: 'step',
        id: 'q-1',
        detail: 'queue rank 1',
      });
    } finally {
      f.restore();
    }
  });
});

describe('rigFocus — the no-arg item resolution', () => {
  test('the frame queue top beats the ready list', () => {
    const f = fixture();
    try {
      f.row('q-1', bead('q-1', { labels: ['queue:root', 'qrank:1'] }));
      f.listed([bead('q-1', { labels: ['queue:root', 'qrank:1'] })]);
      f.ready([bead('r-1')]);
      assert.equal(rigFocus(f.dir), 'q-1');
      // and the no-arg verdict walks the same pick — the queue member
      // steps with its rank as the detail
      assert.deepEqual(rigNext(f.dir), {
        verdict: 'step',
        id: 'q-1',
        detail: 'queue rank 1',
      });
    } finally {
      f.restore();
    }
  });

  test('the drill leaf is the fallback when the queue is empty', () => {
    const f = fixture();
    try {
      f.listed(
        [
          {
            ...bead('d-1', { labels: ['drill'] }),
            updated_at: '2026-01-02T00:00:00Z',
          },
        ],
        'drill'
      );
      f.ready([bead('r-1')]);
      assert.equal(rigFocus(f.dir), 'd-1');
    } finally {
      f.restore();
    }
  });

  test('the ready list is the last resort; epics are not work items', () => {
    const f = fixture();
    try {
      f.ready([bead('e-1', { issue_type: 'epic' }), bead('r-1')]);
      assert.equal(rigFocus(f.dir), 'r-1');
    } finally {
      f.restore();
    }
  });
});

describe('rigNext — the gate probe', () => {
  const reviews = (open: number[], all: number[]): ReviewFacade =>
    ({
      prsForBranch: (b, state) => (b.startsWith('work/') ? (state === 'all' ? all : open) : []),
    }) as ReviewFacade;

  /** The gate probe's shared stage: a bro.config connector pin, the
   *  registered reviews host, the staged open row, and a linked
   *  worktree on branch `work/<id>`. Returns the worktree path for the
   *  caller's remove. */
  const stageGate = (f: Fixture, name: string, host: () => ReviewFacade, id: string): string => {
    writeFileSync(
      join(f.dir, 'bro.config.json'),
      JSON.stringify({ connectors: { reviews: name } })
    );
    registerConnector({ name, reviews: host });
    f.row(id, bead(id));
    const wt = join(f.dir, '..', `${f.dir.split('/').pop()}--${id}`);
    git(f.dir, ['worktree', 'add', '-b', `work/${id}`, wt]);
    return wt;
  };

  test('an open PR on the item worktree branch is gate; settled is the cleanup step', () => {
    const f = fixture();
    try {
      const wt = stageGate(f, 'fakegate', () => reviews([7], [7]), 'g-1');
      assert.deepEqual(rigNext(f.dir, 'g-1'), {
        verdict: 'gate',
        id: 'g-1',
        detail: 'pr=#7',
      });
      // gate:false skips the forge probe entirely — the open row's
      // own status decides (an ungated open row steps)
      assert.equal(rigNext(f.dir, 'g-1', { gate: false }).verdict, 'step');
      git(f.dir, ['worktree', 'remove', '--force', wt]);
    } finally {
      unregisterConnector('fakegate');
      f.restore();
    }
  });

  test('a settled PR + open bead is the finalize step', () => {
    const f = fixture();
    try {
      const wt = stageGate(f, 'fakesettled', () => reviews([], [7]), 'g-2');
      assert.equal(rigNext(f.dir, 'g-2').verdict, 'step');
      assert.match(rigNext(f.dir, 'g-2').detail ?? '', /pr settled/);
      git(f.dir, ['worktree', 'remove', '--force', wt]);
    } finally {
      unregisterConnector('fakesettled');
      f.restore();
    }
  });

  test('an unreachable host is the honest wait, never a double-work step', () => {
    const f = fixture();
    try {
      const wt = stageGate(
        f,
        'fakedown',
        () => {
          throw new Error('host down');
        },
        'g-3'
      );
      assert.deepEqual(rigNext(f.dir, 'g-3'), {
        verdict: 'wait',
        id: 'g-3',
        detail: 'review host unreachable',
      });
      git(f.dir, ['worktree', 'remove', '--force', wt]);
    } finally {
      unregisterConnector('fakedown');
      f.restore();
    }
  });

  test('no reviews provider at all — the probe skips to the work ladder, never waits', () => {
    const f = fixture();
    try {
      f.row('n-1', bead('n-1'));
      f.ready([bead('n-1')]);
      // a worktree exists (so the probe WOULD have something to check)
      // but the connector plane has no reviews facade — absent a gate
      // to consult, the open+ready row steps
      const wt = join(f.dir, '..', `${f.dir.split('/').pop()}--n-1`);
      git(f.dir, ['worktree', 'add', '-b', 'work/n-1', wt]);
      try {
        assert.equal(rigNext(f.dir, 'n-1').verdict, 'step');
      } finally {
        git(f.dir, ['worktree', 'remove', '--force', wt]);
      }
    } finally {
      f.restore();
    }
  });
});
