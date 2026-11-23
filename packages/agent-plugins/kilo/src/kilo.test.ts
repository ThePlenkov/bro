/**
 * The kilo adapter's stop gate — a failed `bro hooks stop` probe is
 * indistinguishable from "nothing armed" unless it is named. The gate
 * is fail-open by contract, so the diagnostic is loud once per
 * interval and quiet after.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import plugin, { hookOutcome } from './kilo.ts';

test('hookOutcome: a spawn or timeout error is its cause', () => {
  const { control, failure } = hookOutcome({
    code: null,
    stdout: '',
    stderr: '',
    error: 'spawn bro ENOENT',
  });
  assert.equal(control, null);
  assert.equal(failure, 'spawn bro ENOENT');
});

test('hookOutcome: a nonzero exit names its code', () => {
  assert.equal(
    hookOutcome({ code: 2, stdout: '', stderr: '', error: null }).failure,
    'the hook exited 2'
  );
  assert.equal(
    hookOutcome({ code: null, stdout: '', stderr: '', error: null }).failure,
    'the hook exited with no exit code'
  );
});

test('hookOutcome: empty stdout on a clean exit is healthy silence', () => {
  assert.deepEqual(hookOutcome({ code: 0, stdout: '', stderr: '', error: null }), {
    control: null,
    failure: null,
  });
});

test('hookOutcome: chatter with no control line is broken output', () => {
  const { control, failure } = hookOutcome({
    code: 0,
    stdout: 'loading beads...\ngarbage\n',
    stderr: '',
    error: null,
  });
  assert.equal(control, null);
  assert.equal(failure, 'the hook answered with no control object');
});

test('hookOutcome: the first parseable object line is the answer', () => {
  // leading chatter is skipped; a trailing JSON line must not shadow
  // the verdict — same contract as adapter-core's and opencode's
  // parseControl
  const { control, failure } = hookOutcome({
    code: 0,
    stdout: 'noise\n{"decision":"block","reason":"dirty"}\n{"level":"warn","msg":"trailing"}\n',
    stderr: '',
    error: null,
  });
  assert.deepEqual(control, { decision: 'block', reason: 'dirty' });
  assert.equal(failure, null);
});

test('hookOutcome: a JSON scalar or array line is chatter, not control', () => {
  for (const stdout of ['42\n', '[1,2,3]\n', '"text"\n', 'null\n', 'true\n']) {
    assert.equal(
      hookOutcome({ code: 0, stdout, stderr: '', error: null }).failure,
      'the hook answered with no control object'
    );
  }
  // …but scalars ahead of the control are skipped, not fatal
  const { control, failure } = hookOutcome({
    code: 0,
    stdout: '42\n{"decision":"block"}\n',
    stderr: '',
    error: null,
  });
  assert.deepEqual(control, { decision: 'block' });
  assert.equal(failure, null);
});

// --- the plugin's idle handler: the warn is loud once, then quiet ----

const dir = mkdtempSync(join(tmpdir(), 'bro-kilo-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// the stub stands in for `bro hooks <event>` — it swallows stdin and
// exits with the code pinned as argv[2], so the plugin tests never
// touch a real CLI or the ambient PATH
const stub = join(dir, 'stub.mjs');
writeFileSync(
  stub,
  `process.stdin.on('data', () => {}).on('end', () => {})
process.exit(Number(process.argv[2] ?? '0'))
`
);

interface Logged {
  level: string;
  message: string;
}

interface IdleEvent {
  event: { type: string; properties: Record<string, unknown> };
}

type Server = (input: { directory: string; client: unknown; broArgv?: string[] }) => Promise<{
  event: (e: IdleEvent) => Promise<void>;
}>;

function makePlugin(
  directory: string,
  broArgv?: string[]
): {
  logs: Logged[];
  idle: (sessionID: string) => Promise<void>;
} {
  const logs: Logged[] = [];
  const client = {
    app: {
      log: async (input: { body: { level: string; message: string } }) => {
        logs.push(input.body);
      },
    },
  };
  const ready = (plugin.server as Server)({ directory, client, broArgv });
  return {
    logs,
    idle: async sessionID => {
      const hooks = await ready;
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
    },
  };
}

test('a dead stop probe warns once, then stays quiet inside the window', async () => {
  // the stub exits 2 — every idle takes the failure path
  // deterministically, no real CLI or PATH mutation involved
  const { logs, idle } = makePlugin(dir, [process.execPath, stub, '2']);
  await idle('s1');
  await idle('s1');
  const warns = logs.filter(l => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0]?.message ?? '', /stop gate did not run/);
  assert.match(warns[0]?.message ?? '', /exited 2/);
});

test('a clean-exit probe with empty stdout is health, never a warning', async () => {
  // the stub answers a clean exit with nothing to say — the gate is
  // open by choice, not outage, so no diagnostic fires
  const { logs, idle } = makePlugin(dir, [process.execPath, stub, '0']);
  await idle('s1');
  assert.equal(logs.filter(l => l.level === 'warn').length, 0);
});

test('an unserializable payload is an outage, never healthy silence', async () => {
  // JSON.stringify throws on circular input — the hook never ran, and
  // mapping that to silence was the invisible-outage bug: the warning
  // must fire instead
  const { logs, idle } = makePlugin(dir, [process.execPath, stub, '0']);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await idle(circular as unknown as string);
  const warns = logs.filter(l => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0]?.message ?? '', /stop gate did not run/);
  assert.match(warns[0]?.message ?? '', /could not be serialized/);
});
