import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tailArchive } from '@broject/acp-session';
import {
  busProbe,
  busSocketPath,
  busSocketPathForCommon,
  gitCommonDir,
  scrubEnv,
  startBusBrokerAt,
  testGit,
  testRepoInit,
  type BusBroker,
} from '@broject/core';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  AGENT_ARCHIVE_KEEP_BYTES,
  AGENT_ARCHIVE_MAX_BYTES,
  agentEventRecord,
  agentTurnPlane,
  DRAIN_DEFAULT_MS,
} from './acp-events.ts';

// in-process git + the BRO_* badge read must never inherit the OUTER
// session's pins — same scrub rule every fixture suite carries
after(scrubEnv());

/** mkdtemp + git init — the bus socket and the archive both anchor on
 *  the repo's common dir. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-acpev-'));
  testGit(['init', '-q', dir]);
  return dir;
}

const toolOpen = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-1',
  title: 'Read src/foo.ts',
  kind: 'read',
  status: 'in_progress',
} as SessionUpdate;

const toolDone = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tc-1',
  status: 'completed',
  content: [{ type: 'terminal', terminalId: 'term-9' }],
} as unknown as SessionUpdate;

const chunk = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'hello' },
} as SessionUpdate;

const subagent = {
  sessionUpdate: 'subagent_update',
  sessionId: 'child-1',
  title: 'researcher',
} as SessionUpdate;

const usage = (used: number) =>
  ({ sessionUpdate: 'usage_update', used, size: 200_000 }) as SessionUpdate;

function readArchive(dir: string, agentId: string): Array<Record<string, unknown>> {
  const common = gitCommonDir(dir)!;
  const file = join(common, 'bro', 'agents', `${agentId}.events.jsonl`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

async function probeAgent(dir: string) {
  const res = await busProbe(busSocketPath(dir)!, {
    filter: { topics: ['agent'] },
    windowMs: 250,
  });
  return res.events;
}

describe('agentTurnPlane', () => {
  test('a badged turn publishes normalized agent events in order and archives every update', async () => {
    const dir = repo();
    const broker: BusBroker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      process.env.BRO_AGENT_ID = 'native-t1';
      process.env.BRO_BEAD_ID = 'bro-x1';
      const plane = agentTurnPlane({ cwd: dir, by: "acp provider 'kilo'", sessionId: 'sess-1' });
      plane.start();
      plane.update(chunk); // text deltas archive only — never the bus
      plane.update(toolOpen);
      plane.update(toolDone);
      plane.update(subagent);
      plane.update(usage(100));
      plane.update(usage(200)); // inside the throttle window — coalesced
      plane.stop('end_turn', { replyLen: 5 });
      await plane.drain();

      const events = await probeAgent(dir);
      assert.deepEqual(
        events.map(e => `${e.kind}:${(e.payload as { phase?: string }).phase ?? ''}`),
        [
          'turn:start',
          'tool_call:open',
          'tool_call:finish',
          'subagent:open',
          'usage:',
          'usage:',
          'turn:stop',
        ]
      );
      for (const e of events) {
        assert.equal(e.key, 'native-t1');
        assert.equal(e.cause, 'bro-x1');
        assert.equal(e.source, "acp provider 'kilo'");
        assert.equal(e.topic, 'agent');
      }
      const finish = events.find(
        e => e.kind === 'tool_call' && (e.payload as { phase?: string }).phase === 'finish'
      );
      assert.deepEqual(
        { ...(finish!.payload as object) },
        {
          phase: 'finish',
          toolCallId: 'tc-1',
          status: 'completed',
          terminalId: 'term-9',
        }
      );
      // the pending usage counter flushed at stop — the newest wins
      const usages = events.filter(e => e.kind === 'usage');
      assert.deepEqual(
        usages.map(e => (e.payload as { used: number }).used),
        [100, 200]
      );

      const rows = readArchive(dir, 'native-t1');
      assert.equal(rows[0]!.kind, 'turn');
      assert.equal(rows[0]!.phase, 'start');
      const updates = rows.filter(r => r.kind === 'update');
      assert.equal(updates.length, 6); // chunk + tool open + tool done + sub + 2 usage
      assert.equal((updates[0]!.update as SessionUpdate).sessionUpdate, 'agent_message_chunk');
      // the wire shape survives verbatim — the card renderer's
      // content/rawInput/locations ride the row untouched
      assert.deepEqual(
        updates.map(r => r.update),
        [chunk, toolOpen, toolDone, subagent, usage(100), usage(200)]
      );
      const last = rows.at(-1)!;
      assert.equal(last.kind, 'turn');
      assert.equal(last.phase, 'stop');
      assert.equal(last.stopReason, 'end_turn');
    } finally {
      await broker.close();
    }
  });

  test('usage archive rows carry known provider/model and only reported accounting', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'usage-agent';
    const plane = agentTurnPlane({
      cwd: dir,
      by: 'acp provider kilo',
      sessionId: 'usage-session',
      provider: 'kilo',
      model: 'swe-2',
    });
    plane.update({
      sessionUpdate: 'usage_update',
      inputTokens: 12,
      outputTokens: 7,
      cost: { amount: 0.004, currency: 'USD' },
    } as unknown as SessionUpdate);
    const row = readArchive(dir, 'usage-agent').find(r => r.kind === 'usage');
    assert.deepEqual(
      {
        provider: row?.provider,
        model: row?.model,
        inputTokens: row?.inputTokens,
        outputTokens: row?.outputTokens,
        costUsd: row?.costUsd,
      },
      { provider: 'kilo', model: 'swe-2', inputTokens: 12, outputTokens: 7, costUsd: 0.004 }
    );
    process.env.BRO_AGENT_ID = 'unknown-agent';
    const unknown = agentTurnPlane({ cwd: dir, by: 't', sessionId: 'unknown' });
    unknown.update({ sessionUpdate: 'usage_update', used: 3 } as unknown as SessionUpdate);
    const unknownRow = readArchive(dir, 'unknown-agent').find(r => r.kind === 'usage');
    assert.equal(unknownRow?.tokens, 3);
    assert.equal('inputTokens' in (unknownRow ?? {}), false);
    assert.equal('costUsd' in (unknownRow ?? {}), false);
  });

  // spec bro-l8c4f.4 — the archive carries raw prompts/replies: it must
  // land 0600 and repair a permissive pre-existing file on first write
  test('the archive is owner-only — created 0600, a legacy 0644 repaired', async t => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits do not apply on win32');
      return;
    }
    const dir = repo();
    const broker: BusBroker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      process.env.BRO_AGENT_ID = 'native-t1';
      const common = gitCommonDir(dir)!;
      const file = join(common, 'bro', 'agents', 'native-t1.events.jsonl');
      const turn = async () => {
        const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
        plane.start();
        plane.stop('end_turn');
        await plane.drain();
      };
      await turn();
      assert.equal(statSync(file).mode & 0o777, 0o600);
      chmodSync(file, 0o644);
      await turn();
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      await broker.close();
    }
  });

  test('agentEventRecord lands an out-of-band row in the same archive (spec bro-l8wqu)', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'native-t1';
    try {
      agentEventRecord(dir, 'sess-1', "acp provider 'kilo'", {
        kind: 'permission',
        title: 'rm -rf /',
        verdict: 'denied',
      });
      const rows = readArchive(dir, 'native-t1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, 'permission');
      assert.equal(rows[0]!.title, 'rm -rf /');
      assert.equal(rows[0]!.verdict, 'denied');
      assert.equal(rows[0]!.session, 'sess-1');
      assert.equal(rows[0]!.by, "acp provider 'kilo'");
      assert.equal(rows[0]!.key, 'native-t1');
    } finally {
      delete process.env.BRO_AGENT_ID;
    }
  });

  test('unbadged agentEventRecord writes nothing — the archive stays absent', () => {
    const dir = repo();
    delete process.env.BRO_AGENT_ID;
    agentEventRecord(dir, 's', 'x', { kind: 'permission', verdict: 'denied' });
    const common = gitCommonDir(dir)!;
    assert.equal(existsSync(join(common, 'bro', 'agents')), false);
  });

  test('plane.note lands an out-of-band row in the plane\u2019s own archive (spec bro-9qopj)', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'native-t1';
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 'acp proxy', sessionId: 'sess-1' });
      plane.start();
      // a permission verdict is a client-bound exchange — the update
      // funnel never carries it, so it journals through note()
      plane.note({ kind: 'permission', title: 'rm -rf /', decidedBy: 'proxy', verdict: 'denied' });
      plane.stop('end_turn');
      const rows = readArchive(dir, 'native-t1');
      const perm = rows.find(r => r.kind === 'permission');
      assert.equal(perm?.verdict, 'denied');
      assert.equal(perm?.title, 'rm -rf /');
      assert.equal(perm?.decidedBy, 'proxy');
      // the stamp rides: session/by/key land like any archived row
      assert.equal(perm?.session, 'sess-1');
      assert.equal(perm?.key, 'native-t1');
    } finally {
      delete process.env.BRO_AGENT_ID;
    }
  });

  test('plane.note on the unbadged proxy scope archives under bro/proxy — where agentEventRecord writes nothing', () => {
    const dir = repo();
    delete process.env.BRO_AGENT_ID;
    const plane = agentTurnPlane({
      cwd: dir,
      by: 'acp proxy',
      sessionId: 'sess-9',
      plane: 'proxy',
    });
    plane.note({ kind: 'permission', title: 'bd ready', decidedBy: 'client', verdict: 'approved' });
    const common = gitCommonDir(dir)!;
    const pdir = join(common, 'bro', 'proxy');
    const files = readdirSync(pdir).filter(f => f.startsWith('acp-sess-9-'));
    assert.equal(files.length, 1);
    const rows = readFileSync(join(pdir, files[0]!), 'utf8')
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'permission');
    assert.equal(rows[0]!.verdict, 'approved');
    assert.equal(rows[0]!.session, 'sess-9');
  });

  test('unbadged turns key acp:<sessionId> and never write an archive', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      delete process.env.BRO_AGENT_ID;
      delete process.env.BRO_BEAD_ID;
      const plane = agentTurnPlane({ cwd: dir, by: 'conductor:kilo', sessionId: 'sess-9' });
      plane.start();
      plane.update(usage(50));
      plane.stop('end_turn');
      await plane.drain();
      const events = await probeAgent(dir);
      assert.equal(events.length, 3);
      for (const e of events) {
        assert.equal(e.key, 'acp:sess-9');
        assert.equal(e.source, 'conductor:kilo');
        assert.equal(e.cause, undefined);
      }
      const common = gitCommonDir(dir)!;
      assert.equal(existsSync(join(common, 'bro', 'agents')), false);
    } finally {
      await broker.close();
    }
  });

  test('mid-flight tool_call repeats stay off the bus; first-seen terminal publishes finish', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      plane.update(toolOpen);
      // a repeated non-terminal tool_call for the same id is churn
      plane.update({ ...toolOpen, title: 'Read src/foo.ts (still)' } as SessionUpdate);
      // a terminal tool_call_update for an id never opened still lands finish
      plane.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-other',
        status: 'failed',
      } as SessionUpdate);
      // a tool_call first seen already-terminal emits its open edge
      // before the finish — consumers pair the two
      plane.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-late',
        title: 'bash pwd',
        status: 'completed',
      } as SessionUpdate);
      // a duped terminal edge re-announces a landing, not a new edge —
      // LiveTurn dedupes identically (bro-btccj finish-count parity)
      plane.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-other',
        status: 'failed',
      } as SessionUpdate);
      plane.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-late',
        title: 'bash pwd',
        status: 'completed',
      } as SessionUpdate);
      plane.stop('end_turn');
      await plane.drain();
      const events = await probeAgent(dir);
      assert.deepEqual(
        events.map(e =>
          [
            e.kind,
            (e.payload as Record<string, unknown>).phase,
            (e.payload as Record<string, unknown>).toolCallId,
          ].join('/')
        ),
        [
          'turn/start/',
          'tool_call/open/tc-1',
          'tool_call/finish/tc-other',
          'tool_call/open/tc-late',
          'tool_call/finish/tc-late',
          'turn/stop/',
        ]
      );
    } finally {
      await broker.close();
    }
  });

  test('usage events throttle — one per window plus the pending flush at stop', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      for (const u of [1, 2, 3, 4, 5]) plane.update(usage(u));
      plane.stop('end_turn');
      await plane.drain();
      const usages = (await probeAgent(dir)).filter(e => e.kind === 'usage');
      assert.deepEqual(
        usages.map(e => (e.payload as { used: number }).used),
        [1, 5]
      );
    } finally {
      await broker.close();
    }
  });

  test('drain() honors a finite timeout override', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      plane.stop('end_turn');
      await plane.drain(50);
      assert.ok(true);
    } finally {
      await broker.close();
    }
  });

  test('drain() clamps an above-max timeout without throwing', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      plane.stop('end_turn');
      await plane.drain(3_000_000_000);
      assert.ok(true);
    } finally {
      await broker.close();
    }
  });

  test('drain() falls back to the default for NaN/0/negative', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      for (const v of [NaN, 0, -1]) {
        const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
        plane.start();
        plane.stop('end_turn');
        await plane.drain(v);
      }
      assert.equal(DRAIN_DEFAULT_MS, 3_000);
    } finally {
      await broker.close();
    }
  });

  test('outside a repo every call is a no-op — telemetry never fails a turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-acpev-norepo-'));
    const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
    plane.start();
    plane.update(chunk);
    plane.update(toolOpen);
    plane.stop('end_turn');
    await plane.drain();
    // no bus socket and no common dir — nothing may have been written
    assert.deepEqual(readdirSync(dir), []);
  });

  test('an unsafe BRO_AGENT_ID badge degrades to the session key, never a path escape', async () => {
    const dir = repo();
    const broker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      process.env.BRO_AGENT_ID = '../escape';
      delete process.env.BRO_BEAD_ID;
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 'sess-x' });
      plane.start();
      plane.stop('end_turn');
      await plane.drain();
      const events = await probeAgent(dir);
      assert.equal(events[0]!.key, 'acp:sess-x');
      const common = gitCommonDir(dir)!;
      assert.equal(existsSync(join(common, 'bro', 'agents')), false);
    } finally {
      await broker.close();
    }
  });

  // spec bro-9ti7h — ~256KiB rows: 17 of them cross the 4 MiB ceiling,
  // so 24 force the cap at least twice
  const fatChunk = (tok: string): SessionUpdate =>
    ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${tok}-${'x'.repeat(256 * 1024)}` },
    }) as SessionUpdate;

  test('a chatty turn self-caps — the archive keeps only its newest whole rows', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'native-cap';
    try {
      const common = gitCommonDir(dir)!;
      const file = join(common, 'bro', 'agents', 'native-cap.events.jsonl');
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 'sess-cap' });
      const ROWS = 24;
      plane.start();
      for (let i = 0; i < ROWS; i++) {
        plane.update(fatChunk(`tok-${i}`));
      }
      plane.stop('end_turn');
      const size = statSync(file).size;
      assert.ok(
        size <= AGENT_ARCHIVE_MAX_BYTES,
        `archive ${size}B exceeds the ${AGENT_ARCHIVE_MAX_BYTES}B cap`
      );
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l !== '');
      // every retained line is a WHOLE row — a torn head would throw here
      const rows = lines.map(l => JSON.parse(l) as Record<string, unknown>);
      assert.ok(rows.length > 0);
      const text = lines.join('\n');
      // the newest data survives — the last update and the stop bookend
      assert.ok(text.includes(`tok-${ROWS - 1}-`), 'the newest update survived the cap');
      const last = rows.at(-1)!;
      assert.equal(last.kind, 'turn');
      assert.equal(last.phase, 'stop');
      // retention is a tail, not a stub — an over-truncating cap that
      // kept only the last row would still pass the marker checks
      assert.ok(rows.length >= 5, `kept ${rows.length} rows — the tail should hold many`);
      assert.ok(text.includes(`tok-${ROWS - 4}-`), 'a mid-tail row survived, not just the last');
      // the oldest rows dropped — ~6 MiB written into a ≤4 MiB file
      // proves the file truncated rather than merely growing slowly
      assert.ok(!text.includes('tok-0-'), 'the oldest rows dropped under the cap');
      assert.ok(!text.includes('tok-7-'), 'the kept tail is far smaller than the corpus');
      // the shared consumer pump reads the capped file clean
      const tail = tailArchive(file);
      assert.ok(tail !== undefined);
      assert.ok(tail.rows.length > 0);
      assert.equal(tail.offset, size);
    } finally {
      delete process.env.BRO_AGENT_ID;
    }
  });

  test('the proxy-scope archive self-caps the same way', () => {
    const dir = repo();
    delete process.env.BRO_AGENT_ID;
    const plane = agentTurnPlane({
      cwd: dir,
      by: 'acp proxy',
      sessionId: 'sess-pcap',
      plane: 'proxy',
    });
    const ROWS = 20;
    plane.start();
    for (let i = 0; i < ROWS; i++) {
      plane.update(fatChunk(`p-${i}`));
    }
    plane.stop('end_turn');
    const pdir = join(gitCommonDir(dir)!, 'bro', 'proxy');
    const files = readdirSync(pdir).filter(f => f.startsWith('acp-sess-pcap-'));
    assert.equal(files.length, 1);
    const file = join(pdir, files[0]!);
    assert.ok(statSync(file).size <= AGENT_ARCHIVE_MAX_BYTES);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(`p-${ROWS - 1}-`), 'the newest proxy row survived');
    assert.ok(!text.includes('p-0-'), 'the oldest proxy rows dropped');
    // whole rows only — the retained head parses clean, and the kept
    // tail is a tail: an over-truncating cap keeping only the last
    // row fails this bound
    const lines = text.split('\n').filter(l => l !== '');
    assert.ok(lines.length >= 5, `kept ${lines.length} rows`);
    for (const l of lines) {
      JSON.parse(l);
    }
  });

  test('a pre-existing oversized archive converges on the next write — and stays owner-only', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'native-old';
    try {
      const common = gitCommonDir(dir)!;
      const file = join(common, 'bro', 'agents', 'native-old.events.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      // a legacy archive already past the bound — valid rows at the
      // umask-022 mode the pre-pin era could leave
      const row = JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'y'.repeat(1024) },
        },
      });
      const repeats = Math.ceil((AGENT_ARCHIVE_MAX_BYTES + 4096) / (row.length + 1));
      writeFileSync(file, `${row}\n`.repeat(repeats), { mode: 0o644 });
      assert.ok(statSync(file).size > AGENT_ARCHIVE_MAX_BYTES);
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      plane.stop('end_turn');
      const size = statSync(file).size;
      // the tail read kept only KEEP bytes; the turn's two small rows
      // landed after — the file converged far under the ceiling
      assert.ok(
        size <= AGENT_ARCHIVE_KEEP_BYTES + 4096,
        `converged archive ${size}B should sit at the kept tail`
      );
      // the turn's own rows are the newest — they rode the cap through
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n').filter(l => l !== '');
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      assert.equal(last.kind, 'turn');
      assert.equal(last.phase, 'stop');
      // the kept tail retains seeded rows — an over-truncating cap
      // that dropped every legacy row keeps the file small too
      assert.ok(lines.length > 100, `kept ${lines.length} rows — seeded rows survive`);
      assert.ok(text.includes('yyyy'), 'a seeded legacy row is inside the kept tail');
      // the cap's rewrite went through the private seam — the staged
      // file it renames in is created 0600, so a permissive staged
      // write would leak 0644 here. (An in-place unpinned rewrite
      // keeps the mode the append already repaired — out of this
      // assert's reach.)
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      delete process.env.BRO_AGENT_ID;
    }
  });

  test('a row bigger than the keep window still converges — only complete rows survive', () => {
    const dir = repo();
    process.env.BRO_AGENT_ID = 'native-giant';
    try {
      const common = gitCommonDir(dir)!;
      const file = join(common, 'bro', 'agents', 'native-giant.events.jsonl');
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 'sess-giant' });
      plane.start();
      // one update row over the 2 MiB keep window — its fragment can
      // never parse, so the cap keeps nothing of it
      plane.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `giant-${'g'.repeat(3 * 1024 * 1024)}` },
      } as SessionUpdate);
      for (let i = 0; i < 6; i++) {
        plane.update(fatChunk(`tail-${i}`));
      }
      plane.stop('end_turn');
      const size = statSync(file).size;
      assert.ok(size <= AGENT_ARCHIVE_MAX_BYTES, `archive ${size}B exceeds the cap`);
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l !== '');
      // EVERY retained line is a complete row — a fragment of the
      // giant row would throw here, and 'giant-' is nowhere inside
      for (const l of lines) {
        JSON.parse(l);
      }
      assert.ok(!lines.join('\n').includes('giant-'), 'the oversized row left no fragment');
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      assert.equal(last.phase, 'stop');
      assert.ok(
        lines.join('\n').includes('tail-5-'),
        'the small rows after the giant one survived'
      );
    } finally {
      delete process.env.BRO_AGENT_ID;
    }
  });

  test('a broken archive path never fails the turn — the bus still gets every event', async () => {
    const dir = repo();
    const broker: BusBroker = await startBusBrokerAt(busSocketPath(dir)!);
    try {
      process.env.BRO_AGENT_ID = 'native-broken';
      const common = gitCommonDir(dir)!;
      // the archive path planted as a DIRECTORY — every append EISDIRs
      mkdirSync(join(common, 'bro', 'agents', 'native-broken.events.jsonl'), {
        recursive: true,
      });
      const plane = agentTurnPlane({ cwd: dir, by: 't', sessionId: 's' });
      plane.start();
      plane.update(toolOpen);
      plane.update(toolDone);
      plane.stop('end_turn');
      await plane.drain(); // resolves — the archive's ruin is not the turn's
      const events = await probeAgent(dir);
      assert.deepEqual(
        events.map(e => `${e.kind}:${(e.payload as { phase?: string }).phase ?? ''}`),
        ['turn:start', 'tool_call:open', 'tool_call:finish', 'turn:stop']
      );
    } finally {
      await broker.close();
    }
  });
});

describe('BRO_STATE_DIR — runtime state redirects wholesale (bro-eajeu)', () => {
  /** The reported leak shape: a main repo plus its LINKED worktree —
   *  `gitCommonDir(linked)` resolves `main/.git`, so a test driving a
   *  session path with the linked cwd appends to the main checkout's
   *  live `bro/` state. The pin stands the common dir in so a harness
   *  keeps every byte in a sandbox. */
  function worktree(): { main: string; linkRoot: string; linked: string } {
    const main = mkdtempSync(join(tmpdir(), 'bro-state-main-'));
    testRepoInit(main);
    const linkRoot = mkdtempSync(join(tmpdir(), 'bro-state-link-'));
    const linked = join(linkRoot, 'linked');
    testGit(['-C', main, 'worktree', 'add', '-q', linked, '-b', 'work/state']);
    return { main, linkRoot, linked };
  }

  /** Drop the whole fixture — the linked worktree registration dies
   *  with `main/.git`, so the roots are all that need removing. */
  function cleanup(...roots: string[]): void {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function readJsonl(file: string): Array<Record<string, unknown>> {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  test('turn archives and the bus socket resolve the pin — the worktree common stays untouched', async () => {
    const { main, linkRoot, linked } = worktree();
    const pin = mkdtempSync(join(tmpdir(), 'bro-state-pin-'));
    const prev = process.env.BRO_STATE_DIR;
    process.env.BRO_STATE_DIR = pin;
    try {
      // proxy scope — the unbadged archive an acp proxy run writes
      const plane = agentTurnPlane({
        cwd: linked,
        by: 'acp proxy',
        sessionId: 'sess-1',
        plane: 'proxy',
      });
      plane.start('do a thing');
      plane.update(chunk);
      plane.stop('end_turn');
      await plane.drain();
      const pfiles = readdirSync(join(pin, 'bro', 'proxy')).filter(f =>
        f.startsWith('acp-sess-1-')
      );
      assert.equal(pfiles.length, 1, 'the proxy archive lands under the pin');
      const rows = readJsonl(join(pin, 'bro', 'proxy', pfiles[0]!));
      assert.equal(rows[0]!.kind, 'turn');
      assert.equal(rows.at(-1)!.phase, 'stop');

      // agents scope — a badged worker's out-of-band row
      process.env.BRO_AGENT_ID = 'native-t9';
      agentEventRecord(linked, 'sess-1', 'w', { kind: 'permission', verdict: 'denied' });
      const arows = readJsonl(join(pin, 'bro', 'agents', 'native-t9.events.jsonl'));
      assert.equal(arows.length, 1);
      assert.equal(arows[0]!.kind, 'permission');

      // the bus socket hashes the pin, not the worktree's real common
      assert.equal(busSocketPath(linked), busSocketPathForCommon(pin));
      assert.notEqual(busSocketPath(linked), busSocketPathForCommon(gitCommonDir(linked)!));

      // the sentinel — nothing reached the "live" common dir
      assert.equal(existsSync(join(main, '.git', 'bro')), false);
    } finally {
      if (prev === undefined) delete process.env.BRO_STATE_DIR;
      else process.env.BRO_STATE_DIR = prev;
      delete process.env.BRO_AGENT_ID;
      cleanup(main, linkRoot, pin);
    }
  });

  test('BRO_STATE_DIR=0 resolves "no repo" — archives and the socket go dark', () => {
    const { main, linkRoot, linked } = worktree();
    const prev = process.env.BRO_STATE_DIR;
    process.env.BRO_STATE_DIR = '0';
    try {
      delete process.env.BRO_AGENT_ID;
      const plane = agentTurnPlane({
        cwd: linked,
        by: 'acp proxy',
        sessionId: 'sess-1',
        plane: 'proxy',
      });
      plane.start('x');
      plane.stop('end_turn');
      assert.equal(busSocketPath(linked), null);
      assert.equal(existsSync(join(main, '.git', 'bro')), false);
    } finally {
      if (prev === undefined) delete process.env.BRO_STATE_DIR;
      else process.env.BRO_STATE_DIR = prev;
      cleanup(main, linkRoot);
    }
  });
});
