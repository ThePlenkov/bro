import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentEntry,
  displayAgentOf,
  pidAlive,
  registryHomeOf,
  workerLedState,
} from './registry.ts';

const withBase = (fn: (base: string) => void): void => {
  const base = mkdtempSync(join(tmpdir(), 'reg-'));
  try {
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const seedReg = (base: string, reg: object): void => {
  mkdirSync(join(base, 'bro'), { recursive: true });
  writeFileSync(join(base, 'bro', 'agents.json'), JSON.stringify(reg));
};

const deadPid = (): number => {
  let pid = 4_194_300;
  while (pidAlive(pid)) pid += 1;
  return pid;
};

test('agentEntry — registry key first, then the log stem the pane argv carries', () => {
  withBase(base => {
    seedReg(base, {
      'bro-vp8ma': { agentId: 'native-87a699fc', log: '/x/native-87a699fc.log', pid: 1 },
      'bro-2bv6q': { agentId: 'native-ab656051', log: '/x/native-ab656051.log', pid: 2 },
    });
    // key lookup — the registry's own run id
    assert.equal(agentEntry(base, 'bro-vp8ma')?.pid, 1);
    // stem lookup — the pane's `--agent native-<hash>` resolves the same entry
    assert.equal(agentEntry(base, 'native-87a699fc')?.agentId, 'native-87a699fc');
    assert.equal(agentEntry(base, 'native-ab656051')?.agentId, 'native-ab656051');
    assert.equal(agentEntry(base, 'native-nope'), undefined);
    assert.equal(agentEntry(base, undefined), undefined);
  });
});

test('displayAgentOf — provider wins over the run id, stem is the last resort (bro-m2du9)', () => {
  withBase(base => {
    seedReg(base, {
      'bro-vp8ma': {
        agentId: 'native-87a699fc',
        log: '/x/native-87a699fc.log',
        provider: 'opencode-iceman',
      },
      'bro-2bv6q': { agentId: 'native-ab656051', log: '/x/native-ab656051.log', provider: 'devin' },
      'bro-nopro': { agentId: 'native-00000000', log: '/x/native-00000000.log' },
      'bro-empty': { agentId: 'native-11111111', log: '/x/native-11111111.log', provider: '' },
      'bro-nonst': { agentId: 'native-22222222', log: '/x/native-22222222.log', provider: 42 },
    });
    // the true agent name — provider — even resolving via the archive stem
    assert.equal(displayAgentOf(base, 'native-87a699fc'), 'opencode-iceman');
    assert.equal(displayAgentOf(base, 'bro-2bv6q'), 'devin');
    // a provider-less entry falls back to the readable run id
    assert.equal(displayAgentOf(base, 'bro-nopro'), 'bro-nopro');
    assert.equal(displayAgentOf(base, 'native-00000000'), 'bro-nopro');
    // an empty-string provider is as absent as a missing one
    assert.equal(displayAgentOf(base, 'bro-empty'), 'bro-empty');
    // a non-string provider at the JSON boundary is not a display name
    assert.equal(displayAgentOf(base, 'bro-nonst'), 'bro-nonst');
    // an unknown id keeps the argv value — the caller's surface stands
    assert.equal(displayAgentOf(base, 'native-lost'), 'native-lost');
    assert.equal(displayAgentOf(base, undefined), undefined);
  });
});

test('registryHomeOf — only the <git-common>/bro/agents layout resolves a home', () => {
  withBase(base => {
    // a journal under <root>/bro/agents resolves the registry root
    const events = join(base, 'bro', 'agents', 'native-x.events.jsonl');
    assert.equal(registryHomeOf(events), base);
    // a proxy journal under bro/proxy is NOT an agents dir — no home
    assert.equal(registryHomeOf(join(base, 'bro', 'proxy', 'x.events.jsonl')), undefined);
    // a bare or shallow filename has no layout to recover
    assert.equal(registryHomeOf('native-x.events.jsonl'), undefined);
    assert.equal(registryHomeOf(join(base, 'native-x.events.jsonl')), undefined);
  });
});

test('workerLedState — working needs an unfinished run AND a live pid AND a fresh journal', () => {
  withBase(base => {
    const events = join(base, 'native-x.events.jsonl');
    writeFileSync(events, '{}\n');
    const live = { pid: process.pid, exitStatus: undefined };
    // live pid + fresh journal → working
    assert.equal(workerLedState(live, events), 'working');
    // live pid + stale journal → idle (a live supervisor is not work)
    utimesSync(events, new Date(0), new Date(0));
    assert.equal(workerLedState(live, events), 'idle');
    // live pid + missing journal → idle
    assert.equal(workerLedState(live, join(base, 'absent.events.jsonl')), 'idle');
    utimesSync(events, new Date(), new Date());
    // a respawned run's exit fields go stale — a live pid + fresh
    // journal beats them (registry showed exitStatus on a streaming
    // respawn; the field is attempt-scoped, not current-state)
    assert.equal(workerLedState({ ...live, exitStatus: 1 }, events), 'working');
    assert.equal(workerLedState({ ...live, stopped: true }, events), 'working');
    // a dead pid without a clean exit → blocked (the crash posture)
    assert.equal(workerLedState({ pid: deadPid() }, events), 'blocked');
    assert.equal(workerLedState({ pid: deadPid(), exitStatus: 1 }, events), 'blocked');
    // but the attempt's own .exit is proof before the registry
    // harvest lands — a clean finish must not read red
    mkdirSync(join(base, 'agents'), { recursive: true });
    const agentEvents = join(base, 'agents', 'native-x.events.jsonl');
    writeFileSync(agentEvents, '{}\n');
    writeFileSync(join(base, 'agents', 'native-x.exit'), '0\n');
    assert.equal(workerLedState({ pid: deadPid() }, agentEvents), 'idle');
    writeFileSync(join(base, 'agents', 'native-x.exit'), '1\n');
    assert.equal(workerLedState({ pid: deadPid() }, agentEvents), 'blocked');
    // an empty .exit is a truncated write, not exit 0 — `Number('')`
    // would read the crash window as a clean finish
    writeFileSync(join(base, 'agents', 'native-x.exit'), '');
    assert.equal(workerLedState({ pid: deadPid() }, agentEvents), 'blocked');
    // a `down` on a crashed worker writes stopped:true on top of the
    // failed exitStatus — the recorded failure still reads blocked
    assert.equal(
      workerLedState({ pid: deadPid(), exitStatus: 1, stopped: true }, events),
      'blocked'
    );
    // a live pid + a FRESH but EMPTY journal → idle, not working: a
    // failed first append leaves exactly that file behind
    writeFileSync(events, '');
    assert.equal(workerLedState(live, events), 'idle');
    writeFileSync(events, '{}\n');
    // runId'd entries read the attempt-scoped name
    writeFileSync(join(base, 'agents', 'native-x.ab12cd34.exit'), '0\n');
    rmSync(join(base, 'agents', 'native-x.exit'));
    assert.equal(workerLedState({ pid: deadPid(), runId: 'ab12cd34' }, agentEvents), 'idle');
    // a dead pid with a clean exit → idle
    assert.equal(workerLedState({ pid: deadPid(), exitStatus: 0 }, events), 'idle');
    assert.equal(workerLedState({ pid: deadPid(), stopped: true }, events), 'idle');
    // no entry → unknown (nothing provable; the archive rides)
    assert.equal(workerLedState(undefined, events), 'unknown');
    // an entry that never started → idle
    assert.equal(workerLedState({}, events), 'idle');
    // live pid, no journal path known → idle: a pid alone proves
    // nothing — 'working' needs a journal provably being written
    assert.equal(workerLedState(live, undefined), 'idle');
  });
});
