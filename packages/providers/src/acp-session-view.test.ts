import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { runAcpSessionView } from './acp-session-view.ts';
import type { AcpSessionViewSpec } from './acp-session-view.ts';
import { fakeAcpAgent } from './testkit.ts';

/** A session-view spec over the in-process peer — the command string
 *  never spawns when `peer` is set, the wire is the real protocol. */
function viewSpec(over: Partial<AcpSessionViewSpec> = {}): {
  spec: AcpSessionViewSpec;
  updates: SessionUpdate[];
  notes: string[];
} {
  const updates: SessionUpdate[] = [];
  const notes: string[] = [];
  return {
    updates,
    notes,
    spec: {
      command: 'unused-with-peer',
      sessionId: 'sess-1',
      cwd: '/repo/trees/t1',
      update: u => updates.push(u),
      note: l => notes.push(l),
      ...over,
    },
  };
}

const chunk = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
});

describe('runAcpSessionView — the readonly session/load attach (bro-nwl5g)', () => {
  test('loadSession gates: an agent without the cap refuses fast', async () => {
    const ac = new AbortController();
    const fake = fakeAcpAgent();
    const { spec } = viewSpec({ peer: fake.app, signal: ac.signal });
    const r = await runAcpSessionView(spec);
    assert.equal(r.attached, false);
    assert.match(r.reason, /loadSession/);
    assert.deepEqual(fake.loads, []);
  });

  test('a loadSession agent replays the stream, then stays attached', async () => {
    const ac = new AbortController();
    const fake = fakeAcpAgent({
      agentCapabilities: { loadSession: true },
      loadUpdates: [chunk('one'), chunk('two')],
    });
    let attached = false;
    const { spec, updates } = viewSpec({
      peer: fake.app,
      signal: ac.signal,
      attached: () => {
        attached = true;
      },
    });
    const done = runAcpSessionView(spec);
    // the attach resolves only on detach — wait for the handshake
    // marker, then prove the replay landed and the stream is still live
    for (let i = 0; i < 50 && !attached; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(attached, 'session/load never resolved');
    assert.deepEqual(fake.loads, [{ sessionId: 'sess-1', cwd: '/repo/trees/t1' }]);
    assert.equal(updates.length, 2);
    // post-load updates still stream — the attach is live, not drained
    await fake.loadClient?.notify('session/update', {
      sessionId: 'sess-1',
      update: chunk('live'),
    });
    for (let i = 0; i < 50 && updates.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(updates.length, 3);
    // updates for a different session are filtered out
    await fake.loadClient?.notify('session/update', {
      sessionId: 'sess-other',
      update: chunk('noise'),
    });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(updates.length, 3);

    ac.abort();
    const r = await done;
    assert.equal(r.attached, true);
    assert.match(r.reason, /detach|closed/);
  });

  test('a failed load reports attached:false — the caller falls back', async () => {
    const fake = fakeAcpAgent({
      agentCapabilities: { loadSession: true },
      failLoad: true,
    });
    const { spec } = viewSpec({ peer: fake.app });
    const r = await runAcpSessionView(spec);
    assert.equal(r.attached, false);
    assert.match(r.reason, /session not found|Internal error/);
  });

  test('permission asks are auto-denied — a viewer never authorizes', async () => {
    const ac = new AbortController();
    const fake = fakeAcpAgent({ agentCapabilities: { loadSession: true } });
    const { spec } = viewSpec({ peer: fake.app, signal: ac.signal });
    const done = runAcpSessionView(spec);
    for (let i = 0; i < 100 && fake.loadClient === undefined; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    const res = await fake.loadClient?.request('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 't1', title: 'rm -rf /' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    assert.deepEqual(res?.outcome, { outcome: 'selected', optionId: 'deny' });
    ac.abort();
    await done;
  });

  test('unadvertised agent→client calls answer method-not-found', async () => {
    const ac = new AbortController();
    const fake = fakeAcpAgent({ agentCapabilities: { loadSession: true } });
    const { spec, notes } = viewSpec({ peer: fake.app, signal: ac.signal });
    const done = runAcpSessionView(spec);
    for (let i = 0; i < 100 && fake.loadClient === undefined; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    await assert.rejects(
      fake.loadClient!.request('fs/read_text_file', {
        sessionId: 'sess-1',
        path: '/etc/passwd',
      }),
      /method not found|Method not found|-32601/
    );
    assert.ok(notes.some(n => n.includes('fs/read_text_file')));
    ac.abort();
    await done;
  });

  test('the readonly capability posture: nothing served is advertised', async () => {
    const ac = new AbortController();
    const fake = fakeAcpAgent({ agentCapabilities: { loadSession: true } });
    const { spec } = viewSpec({ peer: fake.app, signal: ac.signal });
    const done = runAcpSessionView(spec);
    for (let i = 0; i < 100 && fake.loadClient === undefined; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    const caps = fake.clientCapabilities as {
      fs?: { readTextFile?: boolean; writeTextFile?: boolean };
      terminal?: boolean;
      elicitation?: unknown;
    };
    assert.deepEqual(caps.fs, { readTextFile: false, writeTextFile: false });
    assert.equal(caps.terminal, false);
    assert.deepEqual(caps.elicitation, {});
    ac.abort();
    await done;
  });

  test('abort mid-load settles viewer-detached, not attached', async () => {
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const fake = fakeAcpAgent({
      agentCapabilities: { loadSession: true },
      holdLoadUntil: gate,
    });
    const { spec } = viewSpec({ peer: fake.app, signal: ac.signal });
    const done = runAcpSessionView(spec);
    // the load is parked inside holdLoadUntil — detach now must not
    // report an attach
    for (let i = 0; i < 50 && fake.loads.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    ac.abort();
    release();
    const r = await done;
    assert.equal(r.attached, false);
  });

  test('an initialize timeout attaches false instead of hanging', async () => {
    // a peer that never answers initialize — the initMs bound trips
    const { agent } = await import('@agentclientprotocol/sdk');
    const silent = agent({ name: 'silent' });
    const { spec } = viewSpec({ peer: silent, initMs: 50, loadMs: 50 });
    const r = await runAcpSessionView(spec);
    assert.equal(r.attached, false);
  });
});
