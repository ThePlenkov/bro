/**
 * pipelineEmit — the production accept `emit` transport
 * (specs/bro-qjji2.11.md). The customer identity routes the evidence
 * bundle: agent addresses → the A2A surface (`sendSessionMessage`),
 * everything else → the notify/mailbox broadcast through the events
 * facade. Idempotency is the contract: the same bundle for the same
 * (runId, stage) dedupes on a content-scoped sentinel; a changed
 * bundle (the post-rejection re-entry) delivers fresh; an undelivered
 * emit leaves no sentinel and retries on the next wake.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  AgentRegistryEntry,
  EventsFacade,
  EventInput,
  EventPublishResult,
  LedgerFacade,
  SessionRow,
} from '@broject/core';
import { type EvidenceBundle, pipelineDir, type StageCall } from '@broject/pipeline';
import type {
  SendSessionMessageOpts,
  SendSessionMessageResult,
  SentDelivery,
} from './commands/session-msg.ts';
import { initRepo, insideAsync } from './commands/testrepo.ts';
import { pipelineEmit, type PipelineEmitDeps } from './pipeline-emit.ts';

const RUN = 'run-emit1';
const ITEM = 'bro-emit1';
const TS = '2026-11-13T00:00:00Z';

const stage = { name: 'accept', engine: 'accept', verdicts: ['accepted', 'rejected', 'abandon'] };

const call = (customer: string | undefined, over: Partial<StageCall> = {}): StageCall =>
  ({
    runId: RUN,
    item: ITEM,
    stage,
    attempt: 1,
    ...(customer !== undefined ? { customer } : {}),
    ctx: {},
    journal: {},
    ...over,
  }) as StageCall;

const bundle = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  runId: RUN,
  item: ITEM,
  verify: [
    {
      stage: 'verify',
      verdict: 'verified',
      ts: TS,
      payload: { rows: [{ ac: 'ships', verdict: 'pass', proof: 'run-1' }] },
    },
  ],
  ...over,
});

/** The events stub — records every publish, answers `published`
 *  (default true). */
const eventsStub = (published = true) => {
  const calls: EventInput[] = [];
  const facade: EventsFacade = {
    publish: async (e: EventInput): Promise<EventPublishResult> => {
      calls.push(e);
      return { published, locator: published ? '/mb/drop.txt' : undefined };
    },
    subscribe: async () => ({ close: () => {} }),
    probe: async () => ({ events: [], gapped: false }),
  };
  return { calls, facade };
};

/** The A2A stub — records every sendSessionMessage opts, answers the
 *  given deliveries (default one published mailbox delivery). */
const sendStub = (deliveries?: SentDelivery[]) => {
  const calls: SendSessionMessageOpts[] = [];
  const fn = async (opts: SendSessionMessageOpts): Promise<SendSessionMessageResult> => {
    calls.push(opts);
    return {
      deliveries: deliveries ?? [
        { to: opts.target, label: opts.target, channel: 'mailbox', published: true },
      ],
      warnings: [],
    };
  };
  return { calls, fn };
};

/** A ledger stub answering fixed session rows. */
const ledgerStub = (rows: SessionRow[]): LedgerFacade =>
  ({
    append: async () => {},
    sessions: async () => rows,
    installs: async () => [],
    stats: async () => [],
    setMode: async () => {},
  }) as LedgerFacade;

const sessionRow = (over: Partial<SessionRow>): SessionRow => ({
  host: 'devin',
  sid: 'sess-1',
  project: null,
  cwd: null,
  branch: null,
  mode: 'code',
  state: 'live',
  pid: null,
  pidStart: null,
  started: Date.now(),
  lastSeen: Date.now(),
  spawnedBy: null,
  ...over,
});

const registryStub = (agentIds: string[]) => (): Record<string, AgentRegistryEntry> =>
  Object.fromEntries(
    agentIds.map((id, i) => [
      `step-${i}`,
      { agentId: id, backend: 'devin', spawnedAt: TS } as AgentRegistryEntry,
    ])
  );

const warnStub = () => {
  const msgs: string[] = [];
  return { msgs, fn: (m: string) => msgs.push(m) };
};

/** Hermetic deps — every seam injected, only the sentinel touches
 *  the fixture repo's pipeline plane. Returns the deps plus the
 *  stubs for assertions. */
const deps = (dir: string, over: Partial<PipelineEmitDeps> = {}) => {
  const events = eventsStub();
  const send = sendStub();
  const warn = warnStub();
  const d: PipelineEmitDeps = {
    dir,
    env: {},
    ledger: ledgerStub([]),
    events: over.events ?? events.facade,
    sendMessage: (over.sendMessage ?? send.fn) as PipelineEmitDeps['sendMessage'],
    registry: registryStub([]),
    warn: warn.fn,
    ...over,
  };
  return { d, events, send, warn };
};

describe('pipelineEmit — routing', () => {
  test('a user customer publishes one broadcast notify/ask event — no A2A send', async () => {
    const { root, main } = initRepo('bro-emit-user-');
    await insideAsync(main, root, async () => {
      const { d, events, send } = deps(main);
      const emit = pipelineEmit(d);
      await emit(call('petr'), bundle());
      assert.equal(events.calls.length, 1);
      const e = events.calls[0]!;
      assert.equal(e.topic, 'notify');
      assert.equal(e.kind, 'ask');
      assert.equal(e.to, undefined, 'a user broadcast carries no address');
      assert.equal(e.cause, RUN);
      assert.match(String(e.key), new RegExp(`pipeline-accept:${RUN}:accept:`));
      assert.match(String(e.payload), /reached the accept gate for bro-emit1/);
      assert.match(String(e.payload), /Evidence bundle/);
      assert.equal(send.calls.length, 0, 'user customer must not hit the A2A leg');
    });
  });

  test('a registry agentId customer takes the A2A leg — sendSessionMessage, not notify', async () => {
    const { root, main } = initRepo('bro-emit-agent-reg-');
    await insideAsync(main, root, async () => {
      const { d, events, send } = deps(main, { registry: registryStub(['fixer-7']) });
      const emit = pipelineEmit(d);
      await emit(call('fixer-7'), bundle());
      assert.equal(send.calls.length, 1);
      const opts = send.calls[0]!;
      assert.equal(opts.target, 'fixer-7');
      assert.equal(opts.kind, 'ask');
      assert.equal(opts.inReplyTo, RUN);
      assert.match(String(opts.key), /pipeline-accept:run-emit1:accept:/);
      assert.match(opts.text, /Evidence bundle/);
      assert.equal(events.calls.length, 0, 'agent customer must not broadcast to notify');
    });
  });

  test('a ledger-resolved agentId (spawnedBy) takes the A2A leg', async () => {
    const { root, main } = initRepo('bro-emit-agent-ledger-');
    await insideAsync(main, root, async () => {
      const { d, events, send } = deps(main, {
        ledger: ledgerStub([sessionRow({ spawnedBy: 'fixer-9', sid: 'w-1' })]),
      });
      const emit = pipelineEmit(d);
      await emit(call('fixer-9'), bundle());
      assert.equal(send.calls.length, 1);
      assert.equal(send.calls[0]!.target, 'fixer-9');
      assert.equal(events.calls.length, 0);
    });
  });

  test('session-key and orchestrator customers are agent-addressed by grammar', async () => {
    const { root, main } = initRepo('bro-emit-agent-grammar-');
    await insideAsync(main, root, async () => {
      for (const customer of ['claude:abc123', 'orchestrator']) {
        const { d, events, send } = deps(main);
        const emit = pipelineEmit(d);
        await emit(call(customer), bundle({ runId: `${RUN}-${customer}` }));
        assert.equal(send.calls.length, 1, `${customer} must take the A2A leg`);
        assert.equal(events.calls.length, 0);
      }
    });
  });

  test('an unresolved bare token is a user — broadcast, never an addressed drop', async () => {
    const { root, main } = initRepo('bro-emit-unknown-');
    await insideAsync(main, root, async () => {
      const { d, events, send } = deps(main); // empty ledger, empty registry
      const emit = pipelineEmit(d);
      await emit(call('some-stranger'), bundle());
      assert.equal(events.calls.length, 1);
      assert.equal(events.calls[0]!.to, undefined);
      assert.equal(send.calls.length, 0);
    });
  });
});

describe('pipelineEmit — idempotency', () => {
  test('the same bundle re-emitted (recheck) delivers once — sentinel dedup', async () => {
    const { root, main } = initRepo('bro-emit-dedup-');
    await insideAsync(main, root, async () => {
      const { d, events } = deps(main);
      const emit = pipelineEmit(d);
      const b = bundle();
      await emit(call('petr'), b);
      await emit(call('petr'), b);
      await emit(call('petr'), b);
      assert.equal(events.calls.length, 1, 'recheck re-emits must dedupe');
    });
  });

  test('a changed bundle (post-rejection re-entry) delivers fresh', async () => {
    const { root, main } = initRepo('bro-emit-reentry-');
    await insideAsync(main, root, async () => {
      const { d, events } = deps(main);
      const emit = pipelineEmit(d);
      await emit(call('petr'), bundle());
      // the fix round journaled new verify rows — new evidence, new key
      await emit(
        call('petr'),
        bundle({
          verify: [
            {
              stage: 'verify',
              verdict: 'verified',
              ts: '2026-11-13T01:00:00Z',
              payload: { rows: [{ ac: 'ships', verdict: 'pass', proof: 'run-2' }] },
            },
          ],
        })
      );
      assert.equal(events.calls.length, 2, 'fresh evidence is a new delivery, not a double');
      assert.notEqual(events.calls[0]!.key, events.calls[1]!.key);
    });
  });

  test('an undelivered emit writes no sentinel — the next wake retries', async () => {
    const { root, main } = initRepo('bro-emit-retry-');
    await insideAsync(main, root, async () => {
      const failing = eventsStub(false);
      const warn = warnStub();
      const first = deps(main, { events: failing.facade, warn: warn.fn });
      const emit = pipelineEmit(first.d);
      const b = bundle();
      await emit(call('petr'), b);
      assert.equal(failing.calls.length, 1);
      assert.ok(warn.msgs.length > 0, 'a failed publish must warn');
      // transport recovers — the SAME bundle delivers on retry
      const ok = eventsStub(true);
      const second = deps(main, { events: ok.facade });
      const emit2 = pipelineEmit(second.d);
      await emit2(call('petr'), b);
      assert.equal(ok.calls.length, 1, 'no sentinel was written — retry delivers');
      // and now it dedupes
      await emit2(call('petr'), b);
      assert.equal(ok.calls.length, 1);
    });
  });

  test('an agent delivery that lands nowhere writes no sentinel — retries', async () => {
    const { root, main } = initRepo('bro-emit-agent-retry-');
    await insideAsync(main, root, async () => {
      const send = sendStub([
        { to: 'fixer-7', label: 'fixer-7', channel: 'mailbox', published: false },
      ]);
      const { d } = deps(main, {
        registry: registryStub(['fixer-7']),
        sendMessage: send.fn as PipelineEmitDeps['sendMessage'],
      });
      const emit = pipelineEmit(d);
      const b = bundle();
      await emit(call('fixer-7'), b);
      await emit(call('fixer-7'), b);
      assert.equal(send.calls.length, 2, 'undelivered agent emits must not dedupe');
    });
  });

  test('a run with no recorded customer delivers nothing', async () => {
    const { root, main } = initRepo('bro-emit-nocus-');
    await insideAsync(main, root, async () => {
      const { d, events, send, warn } = deps(main);
      const emit = pipelineEmit(d);
      await emit(call(undefined), bundle());
      assert.equal(events.calls.length, 0);
      assert.equal(send.calls.length, 0);
      assert.ok(warn.msgs.some(m => m.includes('no recorded customer')));
    });
  });
});

describe('pipelineEmit — real transports', () => {
  test('user customer: the events facade drops a notify file in the repo mailbox', async () => {
    const { root, main } = initRepo('bro-emit-real-user-');
    await insideAsync(main, root, async () => {
      const state = join(root, 'state');
      const d: PipelineEmitDeps = {
        dir: main,
        env: { XDG_STATE_HOME: state, HOME: state } as NodeJS.ProcessEnv,
        ledger: ledgerStub([]),
        registry: registryStub([]),
        warn: () => {},
        // events left unresolved — facade('events') picks the mailbox
        // connector, the same surface `bro notify` writes
      };
      const emit = pipelineEmit(d);
      await emit(call('petr'), bundle());
      const plane = pipelineDir({ dir: main });
      assert.ok(plane !== null);
      const notify = join(plane, '..', 'notify');
      const drops = readdirSync(notify).filter(f => f.endsWith('.txt'));
      assert.equal(drops.length, 1, 'one mailbox drop for the bundle');
      const text = readFileSync(join(notify, drops[0]!), 'utf8');
      const ev = JSON.parse(text) as EventInput;
      assert.equal(ev.topic, 'notify');
      assert.equal(ev.kind, 'ask');
      assert.match(String(ev.payload), /reached the accept gate/);
      // recheck re-emit — still one drop + one sentinel
      await emit(call('petr'), bundle());
      assert.equal(readdirSync(notify).filter(f => f.endsWith('.txt')).length, 1);
    });
  });

  test('agent customer: sendSessionMessage publishes an addressed msg record', async () => {
    const { root, main } = initRepo('bro-emit-real-agent-');
    await insideAsync(main, root, async () => {
      const state = join(root, 'state');
      const d: PipelineEmitDeps = {
        dir: main,
        env: { XDG_STATE_HOME: state, HOME: state } as NodeJS.ProcessEnv,
        ledger: ledgerStub([]), // no live rows — orchestrator resolves to the role address
        registry: registryStub([]),
        warn: () => {},
      };
      const emit = pipelineEmit(d);
      await emit(call('orchestrator'), bundle());
      const plane = pipelineDir({ dir: main });
      assert.ok(plane !== null);
      const notify = join(plane, '..', 'notify');
      const drops = readdirSync(notify).filter(f => f.endsWith('.txt'));
      assert.equal(drops.length, 1, 'one addressed msg drop for the bundle');
      const ev = JSON.parse(readFileSync(join(notify, drops[0]!), 'utf8')) as EventInput;
      assert.equal(ev.topic, 'msg');
      assert.equal(ev.to, 'orchestrator');
      assert.match(String(ev.payload), /reached the accept gate/);
    });
  });
});
