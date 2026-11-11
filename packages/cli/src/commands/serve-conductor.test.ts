/** `bro serve` conductor — /v1/messages answers from an acp provider
 *  session instead of an HTTP upstream (spec bro-xeozo). */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agent,
  type SessionConfigOption,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { fakeAcpAgent } from '@broject/providers/testkit';
import { otelJournal, type AcpTerminals } from '@broject/providers';
import { conductorConfig, conductorProxy, parseReply, sweepSessions } from './serve-conductor.ts';
import type { ConductorConfig, ConvSession } from './serve-conductor.ts';
import { authHeaders, listen, serveDeps as deps } from './serve-testkit.ts';
import { scrubEnv } from '@broject/core';

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'swe-x',
  options: [
    { value: 'swe-x', name: 'SWE X' },
    { value: 'swe-y', name: 'SWE Y' },
  ],
};

const auth = authHeaders;

/** Each entry becomes its own agent_message_chunk — splits inside a
 *  <tool_call> tag exercise the conductor's incremental parser. */
const chunks = (...texts: string[]): SessionUpdate[] =>
  texts.map(text => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text' as const, text },
  }));

/** The client's own tool — Claude Code's Bash, with the schema the
 *  request carries. */
const BASH_TOOL = [
  {
    name: 'Bash',
    description: 'run a command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
];

/** An agent that CALLS a tool and then answers — the call in ACP's
 *  shape (the bridge's input), the answer in text. */
function agentCallingTool(toolCallId: string) {
  const call: SessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Ran ls',
    kind: 'execute',
    rawInput: { command: 'ls -la' },
  } as SessionUpdate;
  return fakeAcpAgent({
    updates: [call, ...chunks('done')],
    configOptions: [MODEL_OPTION],
  });
}

/** Boot the conductor over `fake` — caller owns close() and gets a
 *  bound post() for repeated /v1/messages sends. */
async function boot(
  fake: ReturnType<typeof fakeAcpAgent>,
  cfg: ConductorConfig = CFG
): Promise<{
  url: string;
  post: (body: unknown) => Promise<Response>;
  close: () => Promise<void>;
}> {
  const { url, close } = await listen(
    deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
  );
  const post = (body: unknown) =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { url, post, close };
}

/** Boot the conductor over `fake` and POST /v1/messages —
 *  caller owns close() and reads `r`. */
async function postMessages(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }], stream: false },
  cfg: ConductorConfig = CFG
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  const { url, post, close } = await boot(fake, cfg);
  return { r: await post(body), url, close };
}

/** Collected text_delta payloads from a parsed SSE stream. */
function textDeltas(ev: Awaited<ReturnType<typeof sseEvents>>): string[] {
  return ev
    .filter(
      e =>
        e.event === 'content_block_delta' &&
        (e.data.delta as { type: string }).type === 'text_delta'
    )
    .map(e => (e.data.delta as { text: string }).text);
}

/** The turn's terminal stop_reason off the message_delta event. */
function stopReason(ev: Awaited<ReturnType<typeof sseEvents>>): string {
  const md = ev.find(e => e.event === 'message_delta');
  return (md?.data.delta as { stop_reason: string }).stop_reason;
}

/** Boot the conductor over `fake` and POST a streamed /v1/messages —
 *  caller owns close() (stream:true is the shape under test here). */
async function postStream(
  fake: ReturnType<typeof fakeAcpAgent>,
  body: unknown = { messages: [{ role: 'user', content: 'x' }], stream: true },
  cfg: ConductorConfig = CFG
): Promise<{ r: Response; url: string; close: () => Promise<void> }> {
  return postMessages(fake, body, cfg);
}

const CFG: ConductorConfig = {
  backend: 'dv-acp',
  entry: { type: 'acp' as const, command: 'dv acp' } as {
    type: 'acp';
    command: string;
    model?: string;
  },
  cwd: '/repo',
  timeoutMs: 10_000,
  agents: {},
};

describe('conductorConfig', () => {
  // loadConfig merges the GLOBAL layer — a dev box pinning serve.backend
  // in ~/.config/bro would leak a backend into the 'unset env' assertions;
  // this suite reads an empty global config dir instead
  after(scrubEnv());
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'bro-conductor-xdg-'));
  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });
  const providers = {
    'dv-acp': { type: 'acp' as const, command: 'dv acp', model: 'swe-y' },
    cli1: { type: 'cli' as const, command: 'x run' },
  };
  test('unset env → undefined; resolves backend+model pin', () => {
    assert.equal(conductorConfig({}, '/r', providers), undefined);
    assert.equal(conductorConfig({ BRO_PROVIDER_BACKEND: ' ' }, '/r', providers), undefined);
    const cfg = conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, '/r', providers);
    assert.equal(cfg?.backend, 'dv-acp');
    assert.equal(cfg?.model, 'swe-y');
    assert.equal(
      conductorConfig(
        { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_MODEL: 'swe-z' },
        '/r',
        providers
      )?.model,
      'swe-z'
    );
  });
  test('serve.backend in config is the env-less backend pin; env wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp' },
        providers: {
          'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' },
          other: { type: 'acp', command: 'o acp' },
        },
      })
    );
    // no env — the config section carries the backend
    const cfg = conductorConfig({}, dir);
    assert.equal(cfg?.backend, 'dv-acp');
    assert.equal(cfg?.model, 'swe-y');
    // env is the explicit operator pin — it overrides the config
    assert.equal(conductorConfig({ BRO_PROVIDER_BACKEND: 'other' }, dir)?.backend, 'other');
  });
  test('a negative/zero timeout falls back to the default', () => {
    for (const raw of ['-5', '0', 'abc']) {
      const cfg = conductorConfig(
        { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_TIMEOUT_MS: raw },
        '/r',
        providers
      );
      assert.equal(cfg?.timeoutMs, 120_000, raw);
    }
  });
  test('the provider windows read the config, and the env pins win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: {
          backend: 'dv-acp',
          idleReleaseMs: 60_000,
          acpMaxOpens: 4,
          acpMaxAbandoned: 16,
          acpStallMs: 120_000,
        },
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' } },
      })
    );
    const cfg = conductorConfig({}, dir);
    assert.equal(cfg?.idleReleaseMs, 60_000);
    assert.equal(cfg?.acpMaxOpens, 4);
    assert.equal(cfg?.acpMaxAbandoned, 16);
    assert.equal(cfg?.acpStallMs, 120_000);
    // the env pins are the operator's explicit knob — they win
    const pinned = conductorConfig(
      {
        BRO_PROVIDER_IDLE_RELEASE_MS: '0',
        BRO_PROVIDER_ACP_MAX_OPENS: '2',
        BRO_PROVIDER_ACP_MAX_ABANDONED: '8',
        BRO_PROVIDER_ACP_STALL_MS: '30000',
      },
      dir
    );
    assert.equal(pinned?.idleReleaseMs, 0);
    assert.equal(pinned?.acpMaxOpens, 2);
    assert.equal(pinned?.acpMaxAbandoned, 8);
    assert.equal(pinned?.acpStallMs, 30_000);
    // a garbage pin falls back to the file's value
    const garbage = conductorConfig({ BRO_PROVIDER_ACP_STALL_MS: 'abc' }, dir);
    assert.equal(garbage?.acpStallMs, 120_000);
    // a FRACTIONAL value is not a window nor a count: it must not floor
    // into 0 and switch the watchdog off, nor become a 0.5 budget that
    // refuses the first open
    const fractional = conductorConfig(
      { BRO_PROVIDER_ACP_STALL_MS: '0.5', BRO_PROVIDER_ACP_MAX_OPENS: '0.5' },
      dir
    );
    assert.equal(fractional?.acpStallMs, 120_000);
    assert.equal(fractional?.acpMaxOpens, 4);
    // a window above node's timer ceiling is clamped — late, not instant
    const huge = conductorConfig({ BRO_PROVIDER_IDLE_RELEASE_MS: '9999999999' }, dir);
    assert.equal(huge?.idleReleaseMs, 2_147_483_647);
    // the stall bound takes the same clamp — an oversized pin must not
    // wrap the watchdog into firing at once
    const hugeStall = conductorConfig({ BRO_PROVIDER_ACP_STALL_MS: '9999999999' }, dir);
    assert.equal(hugeStall?.acpStallMs, 2_147_483_647);
  });
  test('the session workspace pin reads the config, and the env pin wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', acpCwd: '/srv/acp-workspace' },
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' } },
      })
    );
    assert.equal(conductorConfig({}, dir)?.acpCwd, '/srv/acp-workspace');
    // the env pin is the operator's explicit knob — it wins
    assert.equal(
      conductorConfig({ BRO_PROVIDER_ACP_CWD: '/env/workspace' }, dir)?.acpCwd,
      '/env/workspace'
    );
    // a blank env pin falls back to the file's value
    assert.equal(
      conductorConfig({ BRO_PROVIDER_ACP_CWD: '   ' }, dir)?.acpCwd,
      '/srv/acp-workspace'
    );
    // a relative pin resolves against the listener's cwd — session/new
    // requires an absolute cwd (review bro-sx4hr)
    assert.equal(
      conductorConfig({ BRO_PROVIDER_ACP_CWD: 'rel/ws' }, dir)?.acpCwd,
      resolve('rel/ws')
    );
    // unset everywhere → undefined — the host listener's default anchor applies
    const bare = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(bare, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp' },
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' } },
      })
    );
    assert.equal(conductorConfig({}, bare)?.acpCwd, undefined);
  });
  test('unknown backend and non-acp kind are loud errors', () => {
    assert.throws(
      () => conductorConfig({ BRO_PROVIDER_BACKEND: 'nope' }, '/r', providers),
      /providers\.nope is not configured/
    );
    assert.throws(
      () => conductorConfig({ BRO_PROVIDER_BACKEND: 'cli1' }, '/r', providers),
      /type 'cli' — the conductor needs an 'acp' entry/
    );
  });
  test('BRO_PROVIDER_CATALOG resolves a second entry for /v1/models', () => {
    const cfg = conductorConfig(
      { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_CATALOG: 'cli1' },
      '/r',
      providers
    );
    assert.equal(cfg?.catalog?.name, 'cli1');
    assert.equal(
      conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, '/r', providers)?.catalog,
      undefined
    );
    assert.throws(
      () =>
        conductorConfig(
          { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_CATALOG: 'nope' },
          '/r',
          providers
        ),
      /providers\.nope is not configured/
    );
  });
  test('serve.providers exposes the OTHER acp entries as routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', providers: ['oc-acp', 'dv-acp'] },
        providers: {
          'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' },
          'oc-acp': { type: 'acp', command: 'oc acp', model: 'gpt-5' },
        },
      })
    );
    const cfg = conductorConfig({}, dir);
    assert.equal(cfg?.backend, 'dv-acp');
    // the backend is never re-exposed as its own route
    assert.deepEqual(Object.keys(cfg?.providers ?? {}), ['oc-acp']);
    assert.equal(cfg?.providers?.['oc-acp']?.model, 'gpt-5');
  });
  test("an injected registry does not read the file layer's serve.providers", () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', providers: ['oc-acp'] },
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      })
    );
    // the injected registry owns the whole name space — the file's
    // oc-acp must not leak into it, and must not throw for a name the
    // injected registry does not define
    const cfg = conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, dir, {
      'dv-acp': { type: 'acp' as const, command: 'dv acp' },
    });
    assert.deepEqual(Object.keys(cfg?.providers ?? {}), []);
  });
  test('a served provider name carrying a slash is a loud error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', providers: ['oc/one'] },
        providers: {
          'dv-acp': { type: 'acp', command: 'dv acp' },
          'oc/one': { type: 'acp', command: 'oc acp' },
        },
      })
    );
    // the router reads the FIRST path segment — a name with a slash
    // would be advertised and never reachable
    assert.throws(() => conductorConfig({}, dir), /cannot contain/);
  });
  test('an exposed provider that is not acp is a loud error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', providers: ['cli1'] },
        providers: {
          'dv-acp': { type: 'acp', command: 'dv acp' },
          cli1: { type: 'cli', command: 'x run' },
        },
      })
    );
    assert.throws(
      () => conductorConfig({}, dir),
      /type 'cli' — the conductor needs an 'acp' entry/
    );
  });

  // --- the route table (spec bro-jxw7p) ---------------------------------
  //
  // The map form declares a PUBLIC route per entry: the route is what a
  // client asks for, the entry keeps its own private name.

  const mapDir = (serve: unknown, providers: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(join(dir, 'bro.config.local.json'), JSON.stringify({ serve, providers }));
    return dir;
  };

  test('the map form declares a ROUTE per entry — the entry keeps its own name', () => {
    const dir = mapDir(
      { backend: 'dv-acp', providers: { 'opencode-acp': 'oc-iceman' } },
      {
        'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' },
        'oc-iceman': { type: 'acp', command: 'oc acp', model: 'gpt-5' },
      }
    );
    const cfg = conductorConfig({}, dir);
    assert.equal(cfg?.backend, 'dv-acp');
    // the exposed ENTRY keeps its own name…
    assert.deepEqual(Object.keys(cfg?.providers ?? {}), ['oc-iceman']);
    assert.equal(cfg?.providers?.['oc-iceman']?.model, 'gpt-5');
    // …and the ROUTE reaches it
    const routes = cfg?.routes ?? [];
    assert.deepEqual(
      routes.map(r => [r.name, r.entry]),
      [
        ['dv-acp', 'dv-acp'],
        ['opencode-acp', 'oc-iceman'],
      ]
    );
    // the default lane's own key is routable but never DECLARED — a
    // declared alias takes over the advertisement
    assert.equal(routes[0]?.declared, false);
    assert.equal(routes[1]?.declared, true);
  });

  test('the array form still means route ≡ entry', () => {
    const dir = mapDir(
      { backend: 'dv-acp', providers: ['oc-acp'] },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        'oc-acp': { type: 'acp', command: 'oc acp' },
      }
    );
    const routes = conductorConfig({}, dir)?.routes ?? [];
    assert.deepEqual(
      routes.map(r => [r.name, r.entry]),
      [
        ['dv-acp', 'dv-acp'],
        ['oc-acp', 'oc-acp'],
      ]
    );
  });

  test('the default lane answers to its own key AND to a declared alias', () => {
    const dir = mapDir(
      { backend: 'dv-acp', providers: { devin: 'dv-acp' } },
      { 'dv-acp': { type: 'acp', command: 'dv acp' } }
    );
    const routes = conductorConfig({}, dir)?.routes ?? [];
    // both names reach the SAME entry — one lane, one agent
    assert.deepEqual(
      routes.map(r => [r.name, r.entry]),
      [
        ['dv-acp', 'dv-acp'],
        ['devin', 'dv-acp'],
      ]
    );
  });

  test('two entries under one route is a loud error', () => {
    // the route 'dv-acp' is the default lane's own key AND a declared
    // route for another entry — the router would have no honest answer
    const dir = mapDir(
      { backend: 'dv-acp', providers: { 'dv-acp': 'oc-iceman' } },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        'oc-iceman': { type: 'acp', command: 'oc acp' },
      }
    );
    assert.throws(() => conductorConfig({}, dir), /names two entries/);
  });

  test('a route carrying a slash is a loud error', () => {
    const dir = mapDir(
      { backend: 'dv-acp', providers: { 'oc/one': 'oc-iceman' } },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        'oc-iceman': { type: 'acp', command: 'oc acp' },
      }
    );
    assert.throws(() => conductorConfig({}, dir), /cannot contain/);
  });

  test('a route naming a non-acp entry is a loud error', () => {
    const dir = mapDir(
      { backend: 'dv-acp', providers: { 'opencode-acp': 'cli1' } },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        cli1: { type: 'cli', command: 'x run' },
      }
    );
    assert.throws(
      () => conductorConfig({}, dir),
      /type 'cli' — the conductor needs an 'acp' entry/
    );
  });

  test('a route named like a numeric index is a loud error', () => {
    // an integer index keeps no declared order — the route table's
    // "first declared route" would name a different lane
    const dir = mapDir(
      { backend: 'dv-acp', providers: ['1'] },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        1: { type: 'acp', command: 'oc acp' },
      }
    );
    assert.throws(() => conductorConfig({}, dir), /numeric index/);
  });

  test('an entry named __proto__ is refused — it is a reserved key', () => {
    // raw JSON: an object literal would set the prototype instead of
    // naming an entry
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      '{"serve":{"backend":"dv-acp","providers":{"route-x":"__proto__"}},' +
        '"providers":{"dv-acp":{"type":"acp","command":"dv acp"},' +
        '"__proto__":{"type":"acp","command":"oc acp"}}}'
    );
    // '__proto__' is a setter on Object.prototype, not a mergeable key —
    // the config layer refuses it everywhere else too, so the route
    // names an entry that does not exist: a loud error, never a lane
    // that silently lost its entry
    assert.throws(() => conductorConfig({}, dir), /providers\.__proto__/);
  });

  test('an entry with no declared route is not exposed at all', () => {
    // the map form owns the public names — an entry nobody routes to is
    // not a lane
    const dir = mapDir(
      { backend: 'dv-acp', providers: { 'opencode-acp': 'oc-iceman' } },
      {
        'dv-acp': { type: 'acp', command: 'dv acp' },
        'oc-iceman': { type: 'acp', command: 'oc acp' },
        'idle-acp': { type: 'acp', command: 'idle acp' },
      }
    );
    const cfg = conductorConfig({}, dir);
    assert.deepEqual(Object.keys(cfg?.providers ?? {}), ['oc-iceman']);
    assert.equal(
      (cfg?.routes ?? []).some(r => r.entry === 'idle-acp'),
      false
    );
  });
  test('the fast lane arms on the upstream key pair — env pins win (bro-6asnu)', () => {
    const env = { BRO_PROVIDER_BACKEND: 'dv-acp', BRO_PROVIDER_API_KEY: 'k' };
    const cfg = conductorConfig(env, '/r', providers);
    assert.equal(cfg?.fast?.upstream, 'https://api.anthropic.com');
    assert.equal(cfg?.fast?.apiKey, 'k');
    assert.equal(cfg?.fast?.model, undefined);
    assert.equal(cfg?.fast?.maxTokens, 2048);
    // every pin: upstream host, model rewrite, classification cap
    const pinned = conductorConfig(
      {
        ...env,
        BRO_PROVIDER_UPSTREAM: 'http://up.example/v1/',
        BRO_PROVIDER_FAST_MODEL: 'haiku-x',
        BRO_PROVIDER_FAST_MAX_TOKENS: '512',
      },
      '/r',
      providers
    );
    assert.equal(pinned?.fast?.upstream, 'http://up.example/v1');
    assert.equal(pinned?.fast?.model, 'haiku-x');
    assert.equal(pinned?.fast?.maxTokens, 512);
    // a non-positive cap falls back to the default
    assert.equal(
      conductorConfig({ ...env, BRO_PROVIDER_FAST_MAX_TOKENS: '0' }, '/r', providers)?.fast
        ?.maxTokens,
      2048
    );
    // the ambient credential fallbacks arm it like the byte proxy does
    assert.equal(
      conductorConfig(
        { BRO_PROVIDER_BACKEND: 'dv-acp', ANTHROPIC_AUTH_TOKEN: 't' },
        '/r',
        providers
      )?.fast?.apiKey,
      't'
    );
    // no key at all → unarmed, fast shapes still conduct
    assert.equal(
      conductorConfig({ BRO_PROVIDER_BACKEND: 'dv-acp' }, '/r', providers)?.fast,
      undefined
    );
    // the off switch — every spelling
    for (const flag of ['off', '0', 'false', 'OFF']) {
      assert.equal(
        conductorConfig({ ...env, BRO_PROVIDER_FAST_LANE: flag }, '/r', providers)?.fast,
        undefined,
        flag
      );
    }
  });

  test('serve.fastModel + serve.fastLane ride the config file (bro-6asnu)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-fast-'));
    const write = (serve: Record<string, unknown>) =>
      writeFileSync(
        join(dir, 'bro.config.local.json'),
        JSON.stringify({
          serve,
          providers: { 'dv-acp': { type: 'acp', command: 'dv acp', model: 'swe-y' } },
        })
      );
    write({ backend: 'dv-acp', fastLane: false });
    assert.equal(conductorConfig({ BRO_PROVIDER_API_KEY: 'k' }, dir)?.fast, undefined);
    write({ backend: 'dv-acp', fastModel: 'haiku-cfg' });
    assert.equal(conductorConfig({ BRO_PROVIDER_API_KEY: 'k' }, dir)?.fast?.model, 'haiku-cfg');
    // env wins over the committed pin
    assert.equal(
      conductorConfig({ BRO_PROVIDER_API_KEY: 'k', BRO_PROVIDER_FAST_MODEL: 'env-m' }, dir)?.fast
        ?.model,
      'env-m'
    );
  });
});

describe('parseReply', () => {
  test('text segments + tool_use blocks keep reply order', () => {
    const blocks = parseReply(
      'hello <tool_call>{"name":"ls","input":{"dir":"/"}}</tool_call> done'
    );
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]?.type, 'text');
    assert.equal(blocks[1]?.type, 'tool_use');
    assert.equal(blocks[1]?.name, 'ls');
    assert.match(blocks[1]?.id ?? '', /^toolu_[0-9a-f]{16}$/);
    assert.equal(blocks[2]?.type, 'text');
  });
  test('a scalar tool input lands wrapped — anthropic needs an object', () => {
    const blocks = parseReply('<tool_call>{"name":"ls","input":"/tmp"}</tool_call>');
    assert.deepEqual(blocks[0]?.input, { value: '/tmp' });
  });
  test('unparseable tool_call stays raw text — no invented calls', () => {
    const blocks = parseReply('x <tool_call>{nope</tool_call> y');
    assert.equal(blocks.length, 1);
    assert.match(blocks[0]?.text ?? '', /<tool_call>\{nope/);
  });
});

async function sseEvents(r: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const raw = await r.text();
  return raw
    .split('\n\n')
    .filter(b => b.trim() !== '')
    .map(b => {
      const event = b.match(/^event: (.+)$/m)?.[1] ?? '';
      const data = JSON.parse(b.match(/^data: (.+)$/m)?.[1] ?? '{}');
      return { event, data };
    });
}

describe('serve /v1/* — the conductor plane', () => {
  test('POST /v1/messages streams the anthropic SSE shape from an acp turn', async () => {
    const fake = fakeAcpAgent({ replyText: 'hi there', configOptions: [MODEL_OPTION] });
    const { r, close } = await postStream(fake, {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'say hi' }],
      stream: true,
    });
    try {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'text/event-stream');
      const ev = await sseEvents(r);
      const kinds = ev.map(e => e.event);
      assert.deepEqual(kinds.slice(0, 2), ['message_start', 'content_block_start']);
      assert.equal(kinds.at(-1), 'message_stop');
      const delta = ev.find(e => e.event === 'content_block_delta');
      assert.deepEqual(delta?.data.delta, { type: 'text_delta', text: 'hi there' });
      const start = ev.find(e => e.event === 'message_start');
      // message_start names the served label at turn start — the bare
      // request id echoes as a display label (a real pin would win)
      assert.equal((start?.data.message as { model: string }).model, 'claude-sonnet-4-5');
      assert.equal(stopReason(ev), 'end_turn');
      // the conversation reached the agent serialized, not the client's model id
      assert.match(fake.prompts[0] ?? '', /say hi/);
      assert.match(fake.prompts[0] ?? '', /<turn role="user">/);
    } finally {
      await close();
    }
  });

  // bro-7izjx — base64 image blocks ride the wire as real ACP image
  // content when the agent advertised promptCapabilities.image;
  // without the capability they degrade to the `[image]` marker.
  const IMAGE_BODY = {
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
          },
        ],
      },
    ],
    stream: true,
  };

  test('an image-capable agent receives the image block on the wire', async () => {
    const fake = fakeAcpAgent({
      replyText: 'a png',
      configOptions: [MODEL_OPTION],
      imageCapable: true,
    });
    const { r, close } = await postStream(fake, IMAGE_BODY);
    try {
      assert.equal(r.status, 200);
      await r.text();
      const img = fake.blocks[0]?.find(b => b.type === 'image');
      assert.deepEqual(img, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
      // the turn wrapper still frames the text around the image
      assert.match(fake.prompts[0] ?? '', /<turn role="user">what is this/);
    } finally {
      await close();
    }
  });

  test('an agent without the image capability gets the [image] marker instead', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] });
    const { r, close } = await postStream(fake, IMAGE_BODY);
    try {
      assert.equal(r.status, 200);
      await r.text();
      assert.equal(
        fake.blocks[0]?.every(b => b.type === 'text'),
        true
      );
      assert.match(fake.prompts[0] ?? '', /\[image\]/);
    } finally {
      await close();
    }
  });

  test('a <tool_call> reply lands as tool_use + stop_reason tool_use', async () => {
    const fake = fakeAcpAgent({
      replyText: 'checking <tool_call>{"name":"ls","input":{"d":"/tmp"}}</tool_call>',
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      const tu = ev.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      );
      assert.ok(tu, 'tool_use delta present');
      assert.deepEqual(JSON.parse((tu.data.delta as { partial_json: string }).partial_json), {
        d: '/tmp',
      });
      assert.equal(stopReason(ev), 'tool_use');
    } finally {
      await close();
    }
  });

  // bro-sy4q3 — the agent's tool call arrives in ACP's shape; the client
  // executes in its own. The bridge translates by CAPABILITY: the agent
  // calls "execute", the client offers "Bash".
  test("the agent's tool call becomes the client's tool_use", async () => {
    const fake = agentCallingTool('exec:0#1');
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
      tools: BASH_TOOL,
    });
    try {
      const ev = await sseEvents(r);
      const start = ev.find(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as { type: string }).type === 'tool_use'
      );
      assert.ok(start, 'the tool_use block is on the wire');
      assert.equal((start.data.content_block as { name: string }).name, 'Bash');
      const delta = ev.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      );
      assert.ok(delta, 'the tool_use carries its input');
      assert.deepEqual(JSON.parse((delta.data.delta as { partial_json: string }).partial_json), {
        command: 'ls -la',
      });
      assert.equal(stopReason(ev), 'tool_use');
      // the agent's own edge is NOT narrated — the client's tool_use is it
      assert.deepEqual(textDeltas(ev), ['done']);
    } finally {
      await close();
    }
  });

  test('a call the client cannot run stays a narrated edge', async () => {
    const fake = agentCallingTool('exec:0#2');
    // no tools offered — the client has nothing that can run the call
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      const tu = ev.find(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as { type: string }).type === 'tool_use'
      );
      assert.equal(tu, undefined, 'no tool_use — the client cannot run it');
      assert.ok(textDeltas(ev).join('').includes('Ran ls'), 'the edge stays narrated');
      assert.equal(stopReason(ev), 'end_turn');
    } finally {
      await close();
    }
  });

  test("the buffered answer carries the client's tool_use too", async () => {
    const fake = agentCallingTool('exec:0#3');
    const { r, close } = await postMessages(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: false,
      tools: BASH_TOOL,
    });
    try {
      const body = (await r.json()) as {
        content: { type: string; name?: string; input?: unknown }[];
      };
      const tu = body.content.find(b => b.type === 'tool_use');
      assert.ok(tu, 'the buffered answer carries the tool_use');
      assert.equal(tu?.name, 'Bash');
      assert.deepEqual(tu?.input, { command: 'ls -la' });
    } finally {
      await close();
    }
  });

  // bro-6fk80 — a cancelled or backend-ended turn must never read as a
  // clean end_turn; the acp reason surfaces as a non-standard
  // stop_reason the client can branch on.
  test('a cancelled turn reports stop_reason cancelled, not end_turn', async () => {
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'cancelled',
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      assert.equal(stopReason(ev), 'cancelled');
    } finally {
      await close();
    }
  });

  test('a non-enum acp reason forwards raw — buffered, then replayed', async () => {
    // devin's adapter emits error/auth_required outside the acp enum —
    // those used to fall back to a silent 'end_turn'
    const fake = fakeAcpAgent({
      replyText: 'partial',
      configOptions: [MODEL_OPTION],
      stopReason: 'auth_required' as StopReason,
    });
    const { post, close } = await boot(fake);
    try {
      const body = { messages: [{ role: 'user', content: 'x' }], stream: false };
      const first = await (await post(body)).json();
      assert.equal(first.stop_reason, 'auth_required');
      // the recorded reply replays the same reason — no second turn,
      // no silent end_turn
      const re = await (await post(body)).json();
      assert.equal(re.stop_reason, 'auth_required');
      assert.equal(fake.prompts.length, 1);
    } finally {
      await close();
    }
  });

  test('a provider/model request id pins the acp session model', async () => {
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] });
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-y',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    });
    try {
      assert.equal(r.status, 200);
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }]);
      assert.equal((await r.json()).model, 'swe-y');
    } finally {
      await close();
    }
  });

  test('a composite <base>-<level> id applies model + thought_level together', async () => {
    // devin's swe-2 family: -medium/-high/-max are the thinking dimension,
    // not catalog ids — 'swe-2-max' = model swe-2-high + thought_level max
    const DEVIN_OPTIONS: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'swe-2-high',
        options: [
          { value: 'swe-2-high', name: 'SWE-2 High' },
          { value: 'swe-1-7-lightning-medium', name: 'Lightning' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'medium', name: 'medium' },
          { value: 'high', name: 'high' },
          { value: 'max', name: 'max' },
        ],
      },
    ];
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: DEVIN_OPTIONS });
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-2-max',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    });
    try {
      assert.equal(r.status, 200);
      assert.deepEqual(fake.configSets, [
        { configId: 'model', value: 'swe-2-high' },
        { configId: 'thought_level', value: 'max' },
      ]);
      assert.equal((await r.json()).model, 'swe-2-max');
    } finally {
      await close();
    }
  });

  test('a spawn-pinned composite already live skips the set calls', async () => {
    const LIVE: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'swe-2-high',
        options: [{ value: 'swe-2-high', name: 'SWE-2 High' }],
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'max',
        options: [
          { value: 'medium', name: 'm' },
          { value: 'max', name: 'x' },
        ],
      },
    ];
    const fake = fakeAcpAgent({ replyText: 'ok', configOptions: LIVE });
    const { r, close } = await postMessages(fake, {
      model: 'dv-acp/swe-2-max',
      messages: [{ role: 'user', content: 'x' }],
      stream: false,
    });
    try {
      assert.equal(r.status, 200);
      assert.deepEqual(fake.configSets, []);
      assert.equal((await r.json()).model, 'swe-2-max');
    } finally {
      await close();
    }
  });

  test('stream:false answers a buffered anthropic message', async () => {
    const fake = fakeAcpAgent({ replyText: 'plain', configOptions: [MODEL_OPTION] });
    const { r, close } = await postMessages(fake);
    try {
      assert.equal(r.headers.get('content-type'), 'application/json');
      const body = await r.json();
      assert.equal(body.type, 'message');
      assert.equal(body.model, 'swe-x');
      assert.equal(body.stop_reason, 'end_turn');
      assert.deepEqual(body.content, [{ type: 'text', text: 'plain' }]);
    } finally {
      await close();
    }
  });

  test('GET /v1/models enumerates the backend catalog; count_tokens estimates', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION] });
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      const r = await fetch(`${url}/v1/models`, { headers: auth });
      const body = await r.json();
      assert.deepEqual(
        body.data.map((m: { id: string }) => m.id),
        ['dv-acp/swe-x', 'dv-acp/swe-y']
      );
      // acp catalog names surface as display_name — pickers show the
      // human label, qualified by the lane that serves it, so two lanes'
      // identically-named models stay distinguishable; clients pin the id
      assert.deepEqual(
        body.data.map((m: { display_name: string }) => m.display_name),
        ['dv-acp/SWE X', 'dv-acp/SWE Y']
      );
      // the lane rides the row as its own field — a reader must never
      // have to guess it back out of the id, whose head is a formatted
      // string and a model's name may carry a slash of its own
      assert.deepEqual(
        body.data.map((m: { source: string }) => m.source),
        ['dv-acp', 'dv-acp']
      );
      const c = await fetch(`${url}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: 'x'.repeat(400),
      });
      assert.equal((await c.json()).input_tokens, 100);
    } finally {
      await close();
    }
  });

  test('a catalog name is qualified by the provider that serves it', async () => {
    // an agent that names its models "vercel/Claude Opus 5" already says
    // where the model comes from — the gateway must not double the prefix.
    // a name whose slash is NOT a provider ("Claude Opus 4 / 1M") still
    // needs one, and a model id carrying its own provider names the row.
    // the second line answers the same question for a picker that shows
    // the origin: the lane plus the agent's provider chain, no model leaf.
    const cases: [string, string, string, string][] = [
      [
        'vercel/anthropic/claude-opus-5',
        'vercel/Claude Opus 5',
        'vercel/Claude Opus 5',
        'dv-acp/vercel/anthropic',
      ],
      ['claude-opus-5-5-medium', 'Claude Opus/fast', 'dv-acp/Claude Opus/fast', 'dv-acp'],
      ['anthropic/claude-opus-5', 'Claude Opus 5', 'anthropic/Claude Opus 5', 'dv-acp/anthropic'],
      ['swe-x', 'SWE X', 'dv-acp/SWE X', 'dv-acp'],
    ];
    for (const [value, name, expected, described] of cases) {
      const named: SessionConfigOption = {
        ...MODEL_OPTION,
        options: [{ value, name }],
      };
      const fake = fakeAcpAgent({ configOptions: [named] });
      const { url, close } = await listen(
        deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
      );
      try {
        const r = await fetch(`${url}/v1/models`, { headers: auth });
        const body = await r.json();
        assert.deepEqual(
          body.data.map((m: { id: string; display_name: string; description: string }) => [
            m.id,
            m.display_name,
            m.description,
          ]),
          [[`dv-acp/${value}`, expected, described]],
          `${value} → ${expected}`
        );
      } finally {
        await close();
      }
    }
  });

  test('a tool-less backend serves its configured pin as label and catalog row', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' });
    const { r, url, close } = await postMessages(
      fake,
      { messages: [{ role: 'user', content: 'x' }], stream: false },
      { ...CFG, entry: { ...CFG.entry, model: 'swe-sum' } }
    );
    try {
      assert.equal(r.status, 200);
      assert.equal((await r.json()).model, 'swe-sum');
      assert.deepEqual(fake.configSets, []);
      // the pin is a one-row catalog — a tool-less backend still names itself
      const m = await fetch(`${url}/v1/models`, { headers: auth });
      assert.deepEqual(
        (await m.json()).data.map((x: { id: string }) => x.id),
        ['dv-acp/swe-sum']
      );
    } finally {
      await close();
    }
  });

  test('an unpinned tool-less backend answers "unknown" and an empty catalog', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' });
    const { r, url, close } = await postMessages(fake);
    try {
      assert.equal(r.status, 200);
      assert.equal((await r.json()).model, 'unknown');
      const m = await fetch(`${url}/v1/models`, { headers: auth });
      assert.deepEqual((await m.json()).data, []);
    } finally {
      await close();
    }
  });

  test('BRO_PROVIDER_CATALOG models come from the catalog entry, not the backend', async () => {
    const fake = fakeAcpAgent({ replyText: 'sum' });
    const cfg = {
      ...CFG,
      catalog: {
        name: 'orcarouter',
        entry: {
          type: 'api' as const,
          baseUrl: 'https://x',
          models: { 'typesafe/jev-1.13': 'systemone' as const },
        },
      },
    };
    const { url, close } = await listen(
      deps({ provider: conductorProxy(cfg, { acp: { peer: fake.app } }) })
    );
    try {
      const r = await fetch(`${url}/v1/models`, { headers: auth });
      assert.deepEqual(
        (await r.json()).data.map((m: { id: string }) => m.id),
        ['orcarouter/typesafe/jev-1.13']
      );
      // the backend itself still answers messages
      const msg = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      });
      assert.equal(msg.status, 200);
    } finally {
      await close();
    }
  });

  test('backend errors map to anthropic-shaped errors, never a hang', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'generic' });
    const { r, close } = await postMessages(fake);
    try {
      assert.equal(r.status, 529);
      const body = await r.json();
      assert.equal(body.type, 'error');
      assert.match(body.error.message, /conductor/);
    } finally {
      await close();
    }
  });

  test('streamed deltas reach the wire before the turn completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fake = fakeAcpAgent({
      updates: chunks('he', 'llo'),
      holdEnd: () => gate,
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      assert.equal(r.status, 200);
      const reader = (r.body as NonNullable<typeof r.body>).getReader();
      const dec = new TextDecoder();
      let buf = '';
      // the turn is still held open — every byte here proves the
      // response left before end_turn, not in a buffered burst
      const readOnce = () =>
        Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('no live deltas — the turn buffered until end_turn')),
              5000
            )
          ),
        ]);
      while (!buf.includes('llo')) {
        const { done, value } = await readOnce();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      assert.match(buf, /"text":"he"/);
      assert.match(buf, /"text":"llo"/);
      release();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      assert.match(buf, /event: message_stop/);
    } finally {
      await close();
    }
  });

  test('a <tool_call> split across deltas lands as one tool_use block', async () => {
    const fake = fakeAcpAgent({
      updates: chunks(
        'checking <tool_ca',
        'll>{"name":"ls","input":{"d":"/tmp"}}</tool',
        '_call> done'
      ),
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'list' }],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      const texts = textDeltas(ev);
      assert.deepEqual(texts, ['checking ', ' done']);
      const tu = ev.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      );
      assert.ok(tu, 'tool_use delta present');
      assert.equal(tu.data.index, 1);
      assert.deepEqual(JSON.parse((tu.data.delta as { partial_json: string }).partial_json), {
        d: '/tmp',
      });
      assert.equal(stopReason(ev), 'tool_use');
    } finally {
      await close();
    }
  });

  test('malformed and unclosed <tool_call> markup streams as plain text', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('x <tool_call>{nope</tool_call> y <tool_call>{"na'),
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const text = textDeltas(ev).join('');
      assert.equal(text, 'x <tool_call>{nope</tool_call> y <tool_call>{"na');
      assert.equal(stopReason(ev), 'end_turn');
    } finally {
      await close();
    }
  });

  test('agent-side tool_call lifecycle narrates as text edges — never tool_use', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('thinking '),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'exec: ls /tmp',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('then '),
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          title: 'exec: ls /tmp',
        } as SessionUpdate,
        // non-terminal chatter and a duped terminal both emit nothing
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          status: 'in_progress',
          title: 'ignored',
        } as SessionUpdate,
        // a tool_call arriving already terminal closes its own edge
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-3',
          title: 'instant',
          kind: 'execute',
          status: 'completed',
        } as SessionUpdate,
        // an id-only terminal update reuses the label cached at start
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-4',
          title: 'exec: pwd',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-4',
          status: 'completed',
        } as SessionUpdate,
        // a repeated tool_call carrying the terminal edge narrates too
        // (tool_call updates keep their title per the acp schema)
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-5',
          title: 'exec: df',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-5',
          title: 'exec: df',
          kind: 'execute',
          status: 'completed',
        } as SessionUpdate,
        ...chunks('done'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const text = textDeltas(ev).join('');
      assert.match(text, /⏺ exec: ls \/tmp/);
      assert.match(text, /✓ exec: ls \/tmp/);
      assert.match(text, /⏺ instant\n✓ instant/);
      assert.match(text, /✓ exec: pwd/);
      assert.match(text, /✓ exec: df/);
      assert.equal((text.match(/✓/g) ?? []).length, 4);
      assert.ok(!text.includes('ignored'));
      // narration is text — no tool_use block invented, no tool_use stop
      assert.equal(
        ev.filter(e => (e.data.delta as { type: string } | undefined)?.type === 'input_json_delta')
          .length,
        0
      );
      assert.equal(stopReason(ev), 'end_turn');
    } finally {
      await close();
    }
  });

  test('tool_call lifecycle also emits structured tool_activity events — 3 tools, in order, before message_stop', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('working '),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'exec: a',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-2',
          title: 'read: b',
          kind: 'read',
          status: 'in_progress',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-3',
          title: 'exec: c',
          kind: 'execute',
          status: 'in_progress',
          content: [{ type: 'terminal', terminalId: 'term-9' }],
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-3',
          status: 'failed',
        } as SessionUpdate,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          status: 'completed',
        } as SessionUpdate,
        ...chunks('done'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const acts = ev.filter(e => e.event === 'tool_activity').map(e => e.data);
      assert.deepEqual(
        acts.map(a => `${a.phase}:${a.toolCallId}`),
        ['open:tc-1', 'open:tc-2', 'finish:tc-1', 'open:tc-3', 'finish:tc-3', 'finish:tc-2']
      );
      // payloads carry the shared bus shape — title/kind/status plus
      // the terminalId lifted out of tool content
      const open1 = acts.find(a => a.phase === 'open' && a.toolCallId === 'tc-1');
      assert.equal(open1?.title, 'exec: a');
      assert.equal(open1?.kind, 'execute');
      assert.equal(open1?.status, 'in_progress');
      const finish3 = acts.find(a => a.phase === 'finish' && a.toolCallId === 'tc-3');
      assert.equal(finish3?.status, 'failed');
      const open3 = acts.find(a => a.phase === 'open' && a.toolCallId === 'tc-3');
      assert.equal(open3?.terminalId, 'term-9');
      // every event precedes message_stop
      const stopIdx = ev.findIndex(e => e.event === 'message_stop');
      assert.ok(stopIdx > 0);
      ev.forEach((e, i) => {
        if (e.event === 'tool_activity') assert.ok(i < stopIdx, 'activity before message_stop');
      });
      // activity is an envelope, not a block — nothing invents tool_use
      assert.equal(stopReason(ev), 'end_turn');
    } finally {
      await close();
    }
  });

  test('tool_activity edges: first-seen-terminal opens+finishes; churn and dupes emit nothing', async () => {
    const fake = fakeAcpAgent({
      updates: [
        // a call first seen already-terminal — open and close in order
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-9',
          title: 'instant',
          kind: 'execute',
          status: 'completed',
        } as SessionUpdate,
        // duped terminal for the same id — no second finish
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-9',
          status: 'completed',
        } as SessionUpdate,
        // non-terminal churn — not an edge
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-8',
          status: 'in_progress',
          title: 'churn',
        } as SessionUpdate,
        ...chunks('x'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const acts = ev.filter(e => e.event === 'tool_activity').map(e => e.data);
      assert.deepEqual(
        acts.map(a => `${a.phase}:${a.toolCallId}`),
        ['open:tc-9', 'finish:tc-9']
      );
      // the synthesized open edge drops the terminal status (it lies)
      assert.equal(acts[0]?.status, undefined);
      assert.equal(acts[1]?.status, 'completed');
    } finally {
      await close();
    }
  });

  test('tool_activity bounds titles like the narration label does', async () => {
    const longTitle = `exec: ${'x'.repeat(300)}\nsecond line ignored`;
    const fake = fakeAcpAgent({
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-t',
          title: longTitle,
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('x'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const open = ev.find(e => e.event === 'tool_activity')?.data;
      assert.equal((open?.title as string).length, 118);
      assert.ok((open?.title as string).endsWith('…'));
      assert.ok(!(open?.title as string).includes('second line'));
    } finally {
      await close();
    }
  });

  test('narration landing mid partial-tag keeps stream order — held tail completes into the block', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('work <tool_ca'),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-9',
          title: 'exec: ls',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('ll>{"name":"ls","input":{}}</tool_call> end'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake);
    try {
      const ev = await sseEvents(r);
      const texts = textDeltas(ev);
      assert.deepEqual(texts, ['work ', '\n⏺ exec: ls\n', ' end']);
      const tu = ev.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      );
      assert.ok(tu, 'the split tag still completes into one tool_use block');
    } finally {
      await close();
    }
  });

  // bro-cfwc1 — narration mid-tag corrupts a post-hoc re-parse of the
  // emitted text; the recorded reply must keep the wire's real shape.
  // bro-sy4q3 — a tool answer is never replayed: the resend asks the
  // agent afresh, so the wire shows the live shape (the narration still
  // outside the tag's markup).
  test('a resend never replays a tool answer — the turn runs again', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('work <tool_ca'),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-9',
          title: 'exec: ls',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks('ll>{"name":"ls","input":{}}</tool_call> end'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { post, close } = await boot(fake);
    try {
      const body = { messages: [{ role: 'user', content: 'list' }], stream: true };
      const ev = await sseEvents(await post(body));
      // live wire: narration rides text, the split tag completes
      assert.ok(
        ev.some(
          e =>
            e.event === 'content_block_delta' &&
            (e.data.delta as { type: string }).type === 'input_json_delta'
        )
      );
      // an identical resend is NOT answered from the record — the agent
      // runs again, so the client never re-executes a recorded call
      const re = await sseEvents(await post(body));
      const tu = re.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as { type: string }).type === 'input_json_delta'
      );
      assert.ok(tu, 'the fresh turn still carries the tool_use — not broken markup');
      // the exact text: narration in place, no markup shards — a mid-tag
      // corruption splits the literal into <tool_ca…ll>, which a
      // doesNotMatch on the full tag would evade
      assert.deepEqual(textDeltas(re), ['work ', '\n⏺ exec: ls\n', ' end']);
      assert.equal(stopReason(re), 'tool_use');
      // two prompts — the resend ran the turn again, never replayed
      assert.equal(fake.prompts.length, 2);
    } finally {
      await close();
    }
  });

  test('a failed streamed turn lands as an in-stream error event', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'generic' });
    const { r, close } = await postStream(fake);
    try {
      // headers commit at turn start — the failure can only travel
      // as an SSE event on the open stream
      assert.equal(r.status, 200);
      const ev = await sseEvents(r);
      const err = ev.find(e => e.event === 'error');
      assert.ok(err, 'error event present');
      // the wrapped acp failure is availability-class — the anthropic
      // wire's own name for a backend outage mid-stream
      assert.equal((err.data.error as { type: string }).type, 'overloaded_error');
      assert.match((err.data.error as { message: string }).message, /conductor/);
    } finally {
      await close();
    }
  });

  test('the conductor surfaces the live link terminal registry (bro-eua0d)', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' });
    const proxy = conductorProxy(CFG, { acp: { peer: fake.app } });
    // no request yet — the pooled link doesn't exist, so no registry
    assert.equal(proxy.terminals(), undefined);
    const { url, close } = await listen(deps({ provider: proxy }));
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      });
      assert.equal(r.status, 200);
      const reg = proxy.terminals();
      assert.ok(reg, 'the pooled acp link carries its terminal registry');
      // the registry is the live one — an agent terminal/create call
      // over the link lands in it (one live lane answers with its own
      // AcpTerminals; the plane-facing type only carries snapshot+follow)
      const live = reg as AcpTerminals;
      const { terminalId } = await live.create({
        params: { command: 'sh', args: ['-c', 'echo via-conductor'], env: [] },
      } as never);
      for (let i = 0; i < 100; i++) {
        const snap = await live.output({ params: { terminalId } } as never);
        if (snap.output.includes('via-conductor')) {
          break;
        }
        await new Promise(r2 => setTimeout(r2, 10));
      }
      const snap = await live.output({ params: { terminalId } } as never);
      assert.match(snap.output, /via-conductor/);
      await live.release({ params: { terminalId } } as never);
    } finally {
      await close();
    }
  });
});

// bro-whn25 — the messages API is stateless but a claude client resends
// full history anyway, so the conductor retains one acp session per
// conversation and feeds it only the delta. Identity is the history
// fingerprint; a pinned x-bro-session namespaces explicitly.
describe('serve /v1/* — retained acp sessions', () => {
  const post = (
    url: string,
    messages: unknown[],
    opts: { headers?: Record<string, string>; model?: string } = {}
  ): Promise<Response> =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({ model: opts.model, messages, stream: false }),
    });

  /** Every case needs the same listener over a scripted acp peer — the
   *  helper carries the boilerplate so each test is just the posts. */
  const withConductor = async (
    fakeOpts: Parameters<typeof fakeAcpAgent>[0],
    fn: (ctx: { fake: ReturnType<typeof fakeAcpAgent>; url: string }) => Promise<void>
  ): Promise<void> => {
    const fake = fakeAcpAgent(fakeOpts);
    const { url, close } = await listen(
      deps({ provider: conductorProxy(CFG, { acp: { peer: fake.app } }) })
    );
    try {
      await fn({ fake, url });
    } finally {
      await close();
    }
  };

  test('a continued conversation reuses one session and sends only the delta', () =>
    withConductor({ replyText: 'r1', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const t1 = await post(url, [{ role: 'user', content: 'first' }]);
      assert.equal(t1.status, 200);
      // the client resends full history — own echo included
      const t2 = await post(url, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'second' },
      ]);
      assert.equal(t2.status, 200);
      const t3 = await post(url, [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'third' },
      ]);
      assert.equal(t3.status, 200);
      // one session/new carried all three turns
      assert.equal(fake.sessions.length, 1);
      assert.equal(fake.prompts.length, 3);
      // turn 2 saw only its delta — the prior turns are session context
      assert.match(fake.prompts[1] ?? '', /second/);
      assert.doesNotMatch(fake.prompts[1] ?? '', /first/);
      assert.match(fake.prompts[2] ?? '', /third/);
      assert.doesNotMatch(fake.prompts[2] ?? '', /first|second/);
      // the internal f: fingerprint is NEVER echoed — a client must not
      // pin back into the fingerprint namespace
      assert.equal(t1.headers.get('x-bro-session'), null);
    }));

  test('an identical resend replays the reply without a new turn', () =>
    withConductor(
      { replyText: 'same answer', configOptions: [MODEL_OPTION] },
      async ({ fake, url }) => {
        const msgs = [{ role: 'user', content: 'ping' }];
        assert.equal((await post(url, msgs)).status, 200);
        const retry = await post(url, msgs);
        assert.equal(retry.status, 200);
        assert.equal((await retry.json()).content[0].text, 'same answer');
        // a retry never reaches the agent — one prompt total
        assert.equal(fake.prompts.length, 1);
        assert.equal(fake.sessions.length, 1);
      }
    ));

  test('x-bro-session keys explicitly; different pins get different sessions', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const msgs = [{ role: 'user', content: 'same first turn' }];
      const ra = await post(url, msgs, { headers: { 'x-bro-session': 'a' } });
      assert.equal(ra.status, 200);
      // a client pin is echoed back for the client to confirm
      assert.equal(ra.headers.get('x-bro-session'), 'h:a');
      assert.equal((await post(url, msgs, { headers: { 'x-bro-session': 'b' } })).status, 200);
      // identical bodies, different pins — two sessions, no replay
      assert.equal(fake.sessions.length, 2);
      assert.equal(fake.prompts.length, 2);
      // pin a keeps its session across a real continuation
      const more = [
        { role: 'user', content: 'same first turn' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'more' },
      ];
      assert.equal((await post(url, more, { headers: { 'x-bro-session': 'a' } })).status, 200);
      assert.equal(fake.sessions.length, 2);
      assert.match(fake.prompts[2] ?? '', /more/);
    }));

  test('a named session outlives the anonymous TTL — probes reuse across cadence', () => {
    // bro-5xm9g: a ~16min probe cadence vs the 10min fingerprint TTL
    // evicted every probe's session — each paid a fresh session/new
    // (~11k input tokens). Named (h:) sessions asked for persistence
    // explicitly and get the longer TTL.
    const now = 1_000_000_000;
    const mk = (lastSeen: number): ConvSession =>
      ({
        busy: false,
        lastSeen,
        live: { dispose() {} },
        releaseCap: () => {},
      }) as unknown as ConvSession;
    const sessions = new Map<string, ConvSession>([
      ['f:abc', mk(now - 11 * 60_000)],
      ['h:bro-live-check', mk(now - 11 * 60_000)],
      ['h:old', mk(now - 61 * 60_000)],
    ]);
    sweepSessions(sessions, now);
    assert.equal(sessions.has('f:abc'), false, 'fingerprint past the 10m TTL evicts');
    assert.equal(
      sessions.has('h:bro-live-check'),
      true,
      'named session at 11m survives — the probe reuses it'
    );
    assert.equal(sessions.has('h:old'), false, 'named session still bounded by its own TTL');
  });

  test('an edited prefix under a pinned key evicts and restarts', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } };
      assert.equal((await post(url, [{ role: 'user', content: 'orig' }], pin)).status, 200);
      // the client rewrote history — the stored prefix proof fails
      const r = await post(
        url,
        [
          { role: 'user', content: 'EDITED' },
          { role: 'assistant', content: 'x' },
          { role: 'user', content: 'next' },
        ],
        pin
      );
      assert.equal(r.status, 200);
      // a fresh session got the FULL body, not a delta
      assert.equal(fake.sessions.length, 2);
      assert.match(fake.prompts[1] ?? '', /EDITED/);
      assert.match(fake.prompts[1] ?? '', /next/);
    }));

  test('a differing model mid-conversation re-pins the live session', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 'pin' } };
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], pin)).status, 200);
      const cont = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'b' },
      ];
      assert.equal((await post(url, cont, { ...pin, model: 'dv-acp/swe-y' })).status, 200);
      // same session, the new pin applied on it
      assert.equal(fake.sessions.length, 1);
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }]);
    }));

  test('histories differing only in image data never collide', () =>
    withConductor({ replyText: 'x', imageCapable: true }, async ({ fake, url }) => {
      const img = (data: string) => [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          ],
        },
      ];
      // serTurn collapses both to `[image]` — the fingerprint must
      // still tell them apart (codeant #569)
      assert.equal((await post(url, img('aGVsbG8='))).status, 200);
      assert.equal((await post(url, img('d29ybGQ='))).status, 200);
      assert.equal(fake.sessions.length, 2);
      assert.equal(fake.prompts.length, 2);
    }));

  test('a resend pinning a different model re-pins without a new turn', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } };
      assert.equal((await post(url, [{ role: 'user', content: 'a' }], pin)).status, 200);
      // same history, new model pin — the session re-pins and the
      // recorded reply replays; no duplicate turn reaches the agent
      const r = await post(url, [{ role: 'user', content: 'a' }], {
        ...pin,
        model: 'dv-acp/swe-y',
      });
      assert.equal(r.status, 200);
      assert.equal(fake.sessions.length, 1);
      assert.equal(fake.prompts.length, 1);
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }]);
    }));

  test('a failed turn evicts — the retry opens a fresh session', () =>
    withConductor({ replyText: 'x', failPrompt: 'generic' }, async ({ fake, url }) => {
      const pin = { headers: { 'x-bro-session': 's' } };
      const turn = { role: 'user', content: 'a' };
      assert.equal((await post(url, [turn], pin)).status, 529);
      assert.equal((await post(url, [turn], pin)).status, 529);
      // each attempt opened (and lost) its own session — a poisoned
      // session is never implicitly retried
      assert.equal(fake.sessions.length, 2);
    }));

  test('a claude [1m] context suffix resolves to the base model pin', () =>
    withConductor({ replyText: 'x', configOptions: [MODEL_OPTION] }, async ({ fake, url }) => {
      // claude pins 1M-context variants as `model[1m]` — the bracket is
      // client-side context opt-in, not a different catalog model
      const r = await post(url, [{ role: 'user', content: 'a' }], {
        model: 'dv-acp/swe-y[1m]',
      });
      assert.equal(r.status, 200);
      assert.deepEqual(fake.configSets, [{ configId: 'model', value: 'swe-y' }]);
    }));

  test('dispose() tears down the pooled transport — the shutdown path the exit hook cannot reach', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] });
    const proxy = conductorProxy(CFG, { acp: { peer: fake.app } });
    // an unused pool — dispose before the first turn must not throw
    proxy.dispose();
    const { url, close } = await listen(deps({ provider: proxy }));
    try {
      // disposed-before-link: the resolve guard kills the fresh peer on
      // arrival — the request reports unavailable, never a half-dead 200
      const r1 = await post(url, [{ role: 'user', content: 'a' }]);
      assert.notEqual(r1.status, 200);
      await r1.text();
    } finally {
      await close();
    }

    // live pool: a turn first, then dispose — the next request must not
    // silently succeed on the dead transport
    const fake2 = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] });
    const proxy2 = conductorProxy(CFG, { acp: { peer: fake2.app } });
    const { url: url2, close: close2 } = await listen(deps({ provider: proxy2 }));
    try {
      assert.equal((await post(url2, [{ role: 'user', content: 'a' }])).status, 200);
      proxy2.dispose();
      proxy2.dispose(); // idempotent — double-dispose is not an error
      const r2 = await post(url2, [{ role: 'user', content: 'a' }]);
      assert.notEqual(r2.status, 200);
      await r2.text();
    } finally {
      await close2();
    }

    // a link still mid-handshake holds no live peer — dispose aborts
    // the open itself, so the request settles now instead of riding
    // out cfg.timeoutMs on a deadline the shutdown capped at 2s
    const hanging = agent({ name: 'hang' }).onRequest(
      'initialize',
      () => new Promise<never>(() => {})
    );
    const proxy3 = conductorProxy(CFG, { acp: { peer: hanging } });
    const { url: url3, close: close3 } = await listen(deps({ provider: proxy3 }));
    try {
      const t0 = Date.now();
      const inflight = post(url3, [{ role: 'user', content: 'a' }]);
      await new Promise(r => setTimeout(r, 50));
      proxy3.dispose();
      const r3 = await inflight;
      assert.notEqual(r3.status, 200);
      await r3.text();
      assert.ok(
        Date.now() - t0 < CFG.timeoutMs,
        'the pending open waited out the request deadline'
      );
    } finally {
      await close3();
    }
  });
});

// bro-bvipw.1 — the anthropic surface beyond the happy path:
// tool_choice steers the contract, stop_sequences truncate the wire,
// errors classify into the wire's own taxonomy, and a held turn keeps
// the stream alive with pings.
describe('serve /v1/* — tool_choice, stop_sequences, error taxonomy, keepalive', () => {
  const tools = [{ name: 'ls', description: 'list', input_schema: { type: 'object' } }];
  const withTools = (choice?: unknown) => ({
    messages: [{ role: 'user', content: 'go' }],
    tools,
    tool_choice: choice,
    stream: false,
  });

  // one boot + one prompt assertion per row — the contract text each
  // tool_choice mode produces (or withholds)
  const choiceCases: { name: string; choice: unknown; want?: RegExp; notWant?: string }[] = [
    {
      name: 'auto leaves the contract alone',
      choice: { type: 'auto' },
      want: /<tools>/,
      notWant: 'MUST',
    },
    {
      name: 'any appends a must-call line to the contract',
      choice: { type: 'any' },
      want: /<tools>[\s\S]*MUST respond with a tool call/,
    },
    {
      name: 'tool names the required call',
      choice: { type: 'tool', name: 'ls' },
      want: /MUST call the tool "ls"/,
    },
    { name: 'none withholds the tools contract', choice: { type: 'none' }, notWant: '<tools>' },
  ];
  for (const c of choiceCases) {
    test(`tool_choice ${c.name}`, async () => {
      const fake = fakeAcpAgent({ replyText: 'ok', configOptions: [MODEL_OPTION] });
      const { close } = await postMessages(fake, withTools(c.choice));
      try {
        const prompt = fake.prompts[0] ?? '';
        if (c.want !== undefined) assert.match(prompt, c.want);
        if (c.notWant !== undefined) assert.ok(!prompt.includes(c.notWant), prompt);
      } finally {
        await close();
      }
    });
  }

  test('stop_sequences cut streamed text at a marker split across deltas', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('hello ST', 'OP world'),
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['STOP'],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      assert.equal(textDeltas(ev).join(''), 'hello ');
      assert.equal(stopReason(ev), 'stop_sequence');
      const md = ev.find(e => e.event === 'message_delta');
      assert.equal((md?.data.delta as { stop_sequence: string }).stop_sequence, 'STOP');
    } finally {
      await close();
    }
  });

  test('a stop hit mutes later tool narration — nothing emits past the cut', async () => {
    const fake = fakeAcpAgent({
      updates: [
        ...chunks('hello STOP'),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-9',
          title: 'exec: rm -rf',
          kind: 'execute',
          status: 'in_progress',
        } as SessionUpdate,
        ...chunks(' trailing'),
      ],
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['STOP'],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      assert.equal(textDeltas(ev).join(''), 'hello ');
      assert.equal(stopReason(ev), 'stop_sequence');
    } finally {
      await close();
    }
  });

  test('stop_sequences truncate the buffered reply and report stop_sequence', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] });
    const { r, close } = await postMessages(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['MARK'],
      stream: false,
    });
    try {
      const body = await r.json();
      assert.equal(body.stop_reason, 'stop_sequence');
      assert.equal(body.stop_sequence, 'MARK');
      assert.equal(body.content[0].text, 'abc ');
    } finally {
      await close();
    }
  });

  test('an absent stop_sequence holds nothing back — tail flushes whole', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('end without ma', 'rker'),
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(fake, {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['NOMATCH'],
      stream: true,
    });
    try {
      const ev = await sseEvents(r);
      assert.equal(textDeltas(ev).join(''), 'end without marker');
    } finally {
      await close();
    }
  });

  test('a missing messages array answers 400 invalid_request_error', async () => {
    const fake = fakeAcpAgent({ replyText: 'x' });
    const { r, close } = await postMessages(fake, { model: 'x', stream: false });
    try {
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.type, 'invalid_request_error');
    } finally {
      await close();
    }
  });

  // claude 2.1.309 sends its environment block as a `role:'system'`
  // turn INSIDE messages — the gate used to 400 on it, so every turn
  // of a current claude-code died before the agent was reached.
  /** The prompt the conductor handed the agent for a request carrying a
   *  `role:'system'` turn — the turn must answer, not 400. */
  async function systemTurnPrompt(body: unknown): Promise<string> {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] });
    const { r, close } = await postMessages(fake, body);
    try {
      assert.equal(r.status, 200);
      return fake.prompts[0] ?? '';
    } finally {
      await close();
    }
  }

  /** The shape gate's 400 — a system-only request and an unknown role
   *  answer the same way. */
  async function expectShape400(messages: unknown[]): Promise<void> {
    const fake = fakeAcpAgent({ replyText: 'x' });
    const { r, close } = await postMessages(fake, { model: 'x', messages, stream: false });
    try {
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.type, 'invalid_request_error');
    } finally {
      await close();
    }
  }

  test("a role:'system' turn rides the system slot, not a user turn", async () => {
    const prompt = await systemTurnPrompt({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'ping' },
        { role: 'system', content: [{ type: 'text', text: '# Environment\ncwd /tmp' }] },
      ],
      stream: false,
    });
    // the system turn's text is context — it sits in a <system> block
    assert.match(prompt, /<system>\n# Environment\ncwd \/tmp\n<\/system>/);
    // and never rides the conversation as a user turn
    assert.doesNotMatch(prompt, /<turn role="user"># Environment/);
    assert.match(prompt, /<turn role="user">ping<\/turn>/);
  });

  test("a role:'system' turn with a non-text block keeps the block visible", async () => {
    const prompt = await systemTurnPrompt({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'ping' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'ctx' },
            { type: 'tool_addition', tool: { type: 'tool_reference', name: 'advisor' } },
          ],
        },
      ],
      stream: false,
    });
    // an unknown block is a marker, never a silent drop
    assert.match(prompt, /\[tool_addition\]/);
  });

  test("an empty role:'system' turn still leaves the conversation", async () => {
    const prompt = await systemTurnPrompt({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'ping' },
        { role: 'system', content: '' },
      ],
      stream: false,
    });
    // a system turn that stayed would ride the transcript as a user turn
    assert.doesNotMatch(prompt, /<turn role="user">\s*<\/turn>/);
    assert.match(prompt, /<turn role="user">ping<\/turn>/);
  });

  test('a client-sent systemTurns field is ignored', async () => {
    const prompt = await systemTurnPrompt({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'ping' },
        { role: 'system', content: [{ type: 'text', text: 'real context' }] },
      ],
      // the conductor's own field — the wire never dictates it
      systemTurns: 'client says otherwise',
      stream: false,
    });
    assert.match(prompt, /<system>\nreal context\n<\/system>/);
    assert.doesNotMatch(prompt, /client says otherwise/);
  });

  test('a client-sent systemTurns array with no system turn is dropped too', async () => {
    // no lift happens here — the wire-sent field must still die
    const prompt = await systemTurnPrompt({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'ping' }],
      systemTurns: ['client says otherwise'],
      stream: false,
    });
    assert.doesNotMatch(prompt, /client says otherwise/);
  });

  test("a request carrying only a role:'system' turn answers 400", async () => {
    await expectShape400([{ role: 'system', content: 'ctx' }]);
  });

  test('an assistant-only request answers 400 — no user turn to answer', async () => {
    await expectShape400([{ role: 'assistant', content: 'x' }]);
  });

  test('an unknown role still answers 400 invalid_request_error', async () => {
    await expectShape400([{ role: 'tool', content: 'x' }]);
  });

  test('a block the renderer cannot read answers 400, not a 500', async () => {
    // a null block throws inside blockText — the shape gate owns it
    await expectShape400([
      { role: 'user', content: 'x' },
      { role: 'system', content: [null] },
    ]);
    // a text block whose text is not a string would join to silence
    await expectShape400([
      { role: 'user', content: 'x' },
      { role: 'system', content: [{ type: 'text', text: null }] },
    ]);
    // a block with no type at all — `[undefined]` is not a marker to send
    await expectShape400([
      { role: 'user', content: 'x' },
      { role: 'system', content: [{}] },
    ]);
    // the nested values a block's renderer touches count too
    await expectShape400([
      { role: 'user', content: 'x' },
      { role: 'system', content: [{ type: 'tool_result', tool_use_id: 't1', content: [null] }] },
    ]);
    await expectShape400([
      { role: 'user', content: 'x' },
      { role: 'system', content: [{ type: 'tool_result', tool_use_id: 't1', content: 5 }] },
    ]);
  });

  test('a rate-limited backend answers 429 + Retry-After', async () => {
    const fake = fakeAcpAgent({ configOptions: [MODEL_OPTION], failPrompt: 'rate-limit' });
    const { r, close } = await postMessages(fake);
    try {
      assert.equal(r.status, 429);
      assert.ok(r.headers.get('retry-after') !== null);
      const body = await r.json();
      assert.equal(body.error.type, 'rate_limit_error');
    } finally {
      await close();
    }
  });

  test('a held stream emits keepalive pings until the turn lands', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fake = fakeAcpAgent({
      updates: chunks('after'),
      holdEnd: () => gate,
      configOptions: [MODEL_OPTION],
    });
    const { r, close } = await postStream(
      fake,
      { messages: [{ role: 'user', content: 'x' }], stream: true },
      { ...CFG, keepaliveMs: 40 }
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      release();
      const ev = await sseEvents(r);
      assert.ok(
        ev.some(e => e.event === 'ping'),
        'ping event present'
      );
      assert.equal(stopReason(ev), 'end_turn');
    } finally {
      await close();
    }
  });

  test('a streamed stop_sequence hit still records the cut reply for replay', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake);
    try {
      const body = {
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: ['MARK'],
        stream: true,
      };
      const ev = await sseEvents(await post(body));
      assert.equal(textDeltas(ev).join(''), 'abc ');
      // the resend replays the recorded reply — the cut text, not ''
      const re = await sseEvents(await post(body));
      assert.equal(textDeltas(re).join(''), 'abc ');
      assert.equal(stopReason(re), 'stop_sequence');
    } finally {
      await close();
    }
  });

  // bro-vfbyc — a trimmed reply leaves the retained session holding
  // text the client never received: it may replay, never continue.
  test('a stop-cut turn retires the session — the trimmed echo reseeds fresh', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake);
    try {
      const stop_sequences = ['MARK'];
      assert.equal(
        (
          await post({
            messages: [{ role: 'user', content: 'first' }],
            stop_sequences,
            stream: false,
          })
        ).status,
        200
      );
      const cont = await post({
        messages: [
          { role: 'user', content: 'first' },
          // the client's own trimmed echo — what it actually received
          { role: 'assistant', content: 'abc ' },
          { role: 'user', content: 'second' },
        ],
        stop_sequences,
        stream: false,
      });
      assert.equal(cont.status, 200);
      // a NEW session re-serialized the resent history whole — the
      // trimmed echo included — so its context IS the client's view
      assert.equal(fake.sessions.length, 2);
      assert.match(fake.prompts[1] ?? '', /first/);
      assert.match(fake.prompts[1] ?? '', /abc /);
      assert.match(fake.prompts[1] ?? '', /second/);
    } finally {
      await close();
    }
  });

  test('a cross-chunk stop hit records the streamed cut, not a full-text re-match', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('abc', 'd'),
      configOptions: [MODEL_OPTION],
    });
    const { post, close } = await boot(fake);
    try {
      const body = {
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: ['abcd', 'bc'],
        stream: true,
      };
      // 'bc' completes first in stream order — the cut is 'a', even
      // though 'abcd' sits earlier in the settled text
      const ev = await sseEvents(await post(body));
      assert.equal(textDeltas(ev).join(''), 'a');
      assert.equal(stopReason(ev), 'stop_sequence');
      const replay = await sseEvents(await post(body));
      assert.equal(textDeltas(replay).join(''), 'a');
      assert.equal(stopReason(replay), 'stop_sequence');
    } finally {
      await close();
    }
  });

  test('changed stop_sequences on identical history take a fresh turn, not a replay', async () => {
    const fake = fakeAcpAgent({ replyText: 'abc MARK tail', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake);
    try {
      const postSeq = (stop_sequences: string[]) =>
        post({
          messages: [{ role: 'user', content: 'x' }],
          stop_sequences,
          stream: false,
        });
      const first = await (await postSeq(['MARK'])).json();
      assert.equal(first.content[0].text, 'abc ');
      // same history, different markers — the recorded reply must not
      // replay; a fresh turn runs and answers under the new stops
      const second = await (await postSeq(['NOMATCH'])).json();
      assert.equal(second.content[0].text, 'abc MARK tail');
      assert.equal(fake.prompts.length, 2);
    } finally {
      await close();
    }
  });

  test('a non-array stop_sequences answers 400 invalid_request_error', async () => {
    const fake = fakeAcpAgent({ replyText: 'x', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake);
    try {
      const r = await post({
        messages: [{ role: 'user', content: 'x' }],
        stop_sequences: 'STOP',
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error.type, 'invalid_request_error');
    } finally {
      await close();
    }
  });
});

describe('serve /v1/* — one gateway, many providers', () => {
  const DV_OPTION: SessionConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'swe-x',
    options: [{ value: 'swe-x', name: 'SWE X' }],
  };
  const OC_OPTION: SessionConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5',
    options: [{ value: 'gpt-5', name: 'GPT 5' }],
  };

  /** The gateway's default lane plus one exposed lane — the listener
   *  serves both providers' models. */
  const MULTI: ConductorConfig = {
    ...CFG,
    providers: {
      'oc-acp': { type: 'acp' as const, command: 'oc acp', model: 'gpt-5' },
    },
  };

  /** The same gateway under a CHOSEN route — the entry keeps its own
   *  name ('oc-iceman'), the client asks for 'opencode-acp'. */
  const ALIAS: ConductorConfig = {
    ...CFG,
    providers: {
      'oc-iceman': { type: 'acp' as const, command: 'oc acp', model: 'gpt-5' },
    },
    routes: [
      { name: 'dv-acp', entry: 'dv-acp', declared: false },
      { name: 'opencode-acp', entry: 'oc-iceman', declared: true },
    ],
  };

  /** One entry under TWO routes — the same provider, two names. */
  const TWO_ROUTES: ConductorConfig = {
    ...CFG,
    providers: {
      'oc-iceman': { type: 'acp' as const, command: 'oc acp', model: 'gpt-5' },
    },
    routes: [
      { name: 'dv-acp', entry: 'dv-acp', declared: false },
      { name: 'opencode-acp', entry: 'oc-iceman', declared: true },
      { name: 'oc-alias', entry: 'oc-iceman', declared: true },
    ],
  };

  type Fake = ReturnType<typeof fakeAcpAgent>;

  /** Boot the gateway over two agents — the in-process seam resolves by
   *  the spawn label, which names the lane. */
  const bootGateway = async (
    dv: Fake,
    oc: Fake,
    cfg: ConductorConfig = MULTI,
    /** The exposed entry's key — the spawn label names the ENTRY, so
     *  the seam resolves the agent by it. */
    ocEntry = 'oc-acp'
  ): Promise<{ url: string; close: () => Promise<void> }> => {
    const { url, close } = await listen(
      deps({
        provider: conductorProxy(cfg, {
          acp: { peer: by => (by.endsWith(ocEntry) ? oc.app : dv.app) },
        }),
      })
    );
    return { url, close };
  };

  /** Two lanes over two agents. */
  const withGateway = async (
    fn: (ctx: { dv: Fake; oc: Fake; url: string }) => Promise<void>
  ): Promise<void> => {
    const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
    const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
    const { url, close } = await bootGateway(dv, oc);
    try {
      await fn({ dv, oc, url });
    } finally {
      await close();
    }
  };

  const post = (url: string, body: unknown): Promise<Response> =>
    fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const textOf = async (r: Response): Promise<string> => {
    const body = (await r.json()) as { content?: { type: string; text?: string }[] };
    return body.content?.find(c => c.type === 'text')?.text ?? '';
  };

  test("/v1/models lists EVERY lane's models", () =>
    withGateway(async ({ url }) => {
      const r = await fetch(`${url}/v1/models`, { headers: { ...auth } });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { data: { id: string }[] };
      const ids = body.data.map(m => m.id);
      assert.ok(ids.includes('dv-acp/swe-x'), `ids: ${ids.join(', ')}`);
      assert.ok(ids.includes('oc-acp/gpt-5'), `ids: ${ids.join(', ')}`);
    }));

  test('a model prefix routes the turn to THAT provider', () =>
    withGateway(async ({ dv, oc, url }) => {
      const r = await post(url, {
        model: 'oc-acp/gpt-5',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      });
      assert.equal(r.status, 200);
      assert.equal(await textOf(r), 'from opencode');
      assert.equal(oc.prompts.length, 1);
      assert.equal(dv.prompts.length, 0);
    }));

  /** The default lane's own cases — a bare id, a prefix naming no lane
   *  and the default's own prefix all ride the default lane. */
  const DEFAULT_CASES: [string, string][] = [
    ['a bare model', 'swe-x'],
    ['a prefix naming no lane', 'nope/swe-x'],
    ["the default lane's own prefix", 'dv-acp/swe-x'],
  ];

  for (const [what, model] of DEFAULT_CASES) {
    test(`${what} rides the default lane`, () =>
      withGateway(async ({ dv, oc, url }) => {
        const r = await post(url, {
          model,
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(r.status, 200);
        assert.equal(await textOf(r), 'from devin');
        assert.equal(dv.prompts.length, 1);
        assert.equal(oc.prompts.length, 0);
      }));
  }

  test('the same conversation under two providers is TWO sessions', () =>
    withGateway(async ({ dv, oc, url }) => {
      const history = [{ role: 'user', content: 'same' }];
      await post(url, { model: 'dv-acp/swe-x', messages: history, stream: false });
      await post(url, { model: 'oc-acp/gpt-5', messages: history, stream: false });
      // one session/new per lane — a conversation never crosses providers
      assert.equal(dv.sessions.length, 1);
      assert.equal(oc.sessions.length, 1);
      // and neither lane replayed the other's turn
      assert.equal(dv.prompts.length, 1);
      assert.equal(oc.prompts.length, 1);
    }));

  test('a healthy lane with an empty catalog is not an outage', () =>
    (async () => {
      // the broken lane's catalog fails; the healthy one advertises
      // nothing — an empty catalog is not an outage
      const dv = fakeAcpAgent({ replyText: 'from devin' });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION], failNew: 'auth' });
      const { url, close } = await bootGateway(dv, oc);
      try {
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 200);
        const ids = ((await m.json()) as { data: { id: string }[] }).data.map(x => x.id);
        assert.deepEqual(ids, []);
      } finally {
        await close();
      }
    })());

  test('one lane down still serves the other — a dead provider is not a dead gateway', () =>
    (async () => {
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION], failPrompt: 'generic' });
      const { url, close } = await bootGateway(dv, oc);
      try {
        // the broken lane's catalog still lists its models
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 200);
        const ids = ((await m.json()) as { data: { id: string }[] }).data.map(x => x.id);
        assert.ok(ids.includes('oc-acp/gpt-5'), `ids: ${ids.join(', ')}`);
        // the healthy lane answers
        const ok = await post(url, {
          model: 'dv-acp/swe-x',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(ok.status, 200);
        assert.equal(await textOf(ok), 'from devin');
        // the broken lane fails its own turn, on its own verdict — the
        // acp layer calls a dead provider unavailable, so the wire
        // answers 529 (retryable), not 500
        const bad = await post(url, {
          model: 'oc-acp/gpt-5',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(bad.status, 529);
      } finally {
        await close();
      }
    })());

  test('a lane whose catalog FAILED says so — a shorter catalog is not a quiet one', () =>
    (async () => {
      // the oc lane's catalog read fails (its session/new refuses)
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION], failNew: 'auth' });
      const { url, close } = await bootGateway(dv, oc);
      try {
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 200);
        // the healthy lane still advertises
        const ids = ((await m.json()) as { data: { id: string }[] }).data.map(x => x.id);
        assert.ok(ids.includes('dv-acp/swe-x'), `ids: ${ids.join(', ')}`);
        // and the FAILED lane rides the response — a client reading a
        // shorter catalog must be able to tell it from the whole truth
        const header = m.headers.get('x-bro-lane-error');
        assert.ok(header !== null, 'the failed lane must ride the response');
        assert.match(header, /oc-acp/);
      } finally {
        await close();
      }
    })());

  test("the catalog read honours the LANE's budget — not a constant 30s", () =>
    (async () => {
      // the agent answers session/new only after 3s; the lane's budget is
      // 150ms — the read must end on the lane's deadline, not on the
      // agent's pace (and not on a 30s constant baked into the provider)
      const dv = fakeAcpAgent({
        replyText: 'from devin',
        configOptions: [DV_OPTION],
        delayNewMs: 3_000,
      });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, { ...MULTI, timeoutMs: 150 });
      try {
        const t0 = Date.now();
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        const elapsed = Date.now() - t0;
        assert.equal(m.status, 200);
        assert.ok(elapsed < 750, `the read took ${elapsed}ms — the lane budget did not bound it`);
        const header = m.headers.get('x-bro-lane-error');
        assert.ok(header !== null, 'the timed-out lane must ride the response');
        assert.match(header, /dv-acp/);
      } finally {
        await close();
      }
    })());

  test("a lane's failure text is CAPPED — a long diagnostic cannot blow the header", () =>
    (async () => {
      // the oc lane's session/new fails with a 50KB diagnostic — a stack
      // trace, a banner, whatever the agent said
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION], failNewMessage: 'x'.repeat(50_000) });
      const { url, close } = await bootGateway(dv, oc);
      try {
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 200);
        const header = m.headers.get('x-bro-lane-error');
        assert.ok(header !== null, 'the failed lane must ride the response');
        assert.ok(
          header.length <= 4096,
          `the header is ${header.length} chars — it must be capped`
        );
        // and the healthy lane's rows still arrive
        const ids = ((await m.json()) as { data: { id: string }[] }).data.map(x => x.id);
        assert.ok(ids.includes('dv-acp/swe-x'), `ids: ${ids.join(', ')}`);
      } finally {
        await close();
      }
    })());

  test('every lane down answers 502 — and says WHICH lane, in the header', () =>
    (async () => {
      const dv = fakeAcpAgent({
        replyText: 'from devin',
        configOptions: [DV_OPTION],
        failNew: 'auth',
      });
      const oc = fakeAcpAgent({ configOptions: [OC_OPTION], failNew: 'auth' });
      const { url, close } = await bootGateway(dv, oc);
      try {
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 502);
        // the same signal rides the failure — a client must not have to
        // parse the body to learn which lane died
        const header = m.headers.get('x-bro-lane-error');
        assert.ok(header !== null, 'the 502 must carry the lane failure');
        assert.match(header, /dv-acp/);
        assert.match(header, /oc-acp/);
      } finally {
        await close();
      }
    })());

  test('a declared ROUTE reaches its entry — the entry key is not routable', () =>
    (async () => {
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, ALIAS, 'oc-iceman');
      try {
        // the ROUTE reaches the entry
        const routed = await post(url, {
          model: 'opencode-acp/gpt-5',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(routed.status, 200);
        assert.equal(await textOf(routed), 'from opencode');
        // the ENTRY's own name is not a route — it rides the default
        // lane, so it answers with the DEFAULT's models
        const unrouted = await post(url, {
          model: 'oc-iceman/swe-x',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(unrouted.status, 200);
        assert.equal(await textOf(unrouted), 'from devin');
        assert.equal(oc.prompts.length, 1);
      } finally {
        await close();
      }
    })());

  test('the catalog advertises a lane under its PRIMARY route only', () =>
    (async () => {
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, TWO_ROUTES, 'oc-iceman');
      try {
        const m = await fetch(`${url}/v1/models`, { headers: { ...auth } });
        assert.equal(m.status, 200);
        const ids = ((await m.json()) as { data: { id: string }[] }).data.map(x => x.id);
        // the lane's models are listed ONCE, under its primary route
        assert.ok(ids.includes('opencode-acp/gpt-5'), `ids: ${ids.join(', ')}`);
        assert.equal(ids.includes('oc-alias/gpt-5'), false);
        assert.equal(ids.includes('oc-iceman/gpt-5'), false);
        assert.equal(ids.filter(id => id.endsWith('/gpt-5')).length, 1);
      } finally {
        await close();
      }
    })());

  test('two routes over ONE entry share the agent and the conversation', () =>
    (async () => {
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, TWO_ROUTES, 'oc-iceman');
      try {
        const first = await post(url, {
          model: 'opencode-acp/gpt-5',
          messages: [{ role: 'user', content: 'one' }],
          stream: false,
        });
        assert.equal(first.status, 200);
        // the same conversation under the ALIAS — the second hop grows
        // the history, so the lane must CONTINUE the session the first
        // hop opened
        const second = await post(url, {
          model: 'oc-alias/gpt-5',
          messages: [
            { role: 'user', content: 'one' },
            { role: 'user', content: 'two' },
          ],
          stream: false,
        });
        assert.equal(second.status, 200);
        // ONE session/new — the alias is the same provider, so the same
        // agent and the same conversation, not a twin
        assert.equal(oc.sessions.length, 1);
        assert.equal(oc.prompts.length, 2);
      } finally {
        await close();
      }
    })());

  test('the journal names the ROUTE that answered', () =>
    (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bro-journal-'));
      const journalPath = join(dir, 'turns.jsonl');
      otelJournal(journalPath);
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, ALIAS, 'oc-iceman');
      try {
        await post(url, {
          model: 'opencode-acp/gpt-5',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        const rows = readFileSync(journalPath, 'utf8')
          .trim()
          .split('\n')
          .map(l => JSON.parse(l) as { event: string; backend?: string });
        const turn = rows.find(r => r.event === 'conductor.turn');
        // the PUBLIC route, not the private entry key
        assert.equal(turn?.backend, 'opencode-acp');
      } finally {
        await close();
        otelJournal(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    })());

  test("a chained turn is journaled under the PREDECESSOR's route", () =>
    (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bro-journal-'));
      const journalPath = join(dir, 'turns.jsonl');
      otelJournal(journalPath);
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({ replyText: 'from opencode', configOptions: [OC_OPTION] });
      const { url, close } = await bootGateway(dv, oc, TWO_ROUTES, 'oc-iceman');
      try {
        const first = await fetch(`${url}/v1/responses`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'opencode-acp/gpt-5', input: 'first', stream: false }),
        });
        assert.equal(first.status, 200);
        const id = ((await first.json()) as { id: string }).id;
        // the chain asks under a DIFFERENT route of the same entry —
        // the chain already lives in the predecessor's context, so the
        // answer belongs to the lane that holds it
        const second = await fetch(`${url}/v1/responses`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'oc-alias/gpt-5',
            input: 'second',
            previous_response_id: id,
            stream: false,
          }),
        });
        assert.equal(second.status, 200);
        const rows = readFileSync(journalPath, 'utf8')
          .trim()
          .split('\n')
          .map(l => JSON.parse(l) as { event: string; backend?: string });
        const turns = rows.filter(r => r.event === 'conductor.turn');
        assert.equal(turns.length, 2);
        // both turns name the PREDECESSOR's route
        assert.deepEqual(
          turns.map(t => t.backend),
          ['opencode-acp', 'opencode-acp']
        );
      } finally {
        await close();
        otelJournal(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    })());

  test('a terminal reads back whichever lane spawned it', () =>
    (async () => {
      let ocTid = '';
      const dv = fakeAcpAgent({ replyText: 'from devin', configOptions: [DV_OPTION] });
      const oc = fakeAcpAgent({
        replyText: 'from opencode',
        configOptions: [OC_OPTION],
        probeClient: async (client, sessionId) => {
          const created = await client.request('terminal/create', {
            sessionId,
            command: 'sh',
            args: ['-c', 'echo oc-term'],
          });
          await client.request('terminal/wait_for_exit', {
            sessionId,
            terminalId: created.terminalId,
          });
          ocTid = created.terminalId;
        },
      });
      const proxy = conductorProxy(MULTI, {
        acp: { peer: by => (by.endsWith('oc-acp') ? oc.app : dv.app) },
      });
      const { url, close } = await listen(deps({ provider: proxy }));
      try {
        // both lanes live — the registry probes each one
        await post(url, {
          model: 'dv-acp/swe-x',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        const r = await post(url, {
          model: 'oc-acp/gpt-5',
          messages: [{ role: 'user', content: 'x' }],
          stream: false,
        });
        assert.equal(r.status, 200);
        assert.ok(ocTid, 'the oc lane spawned a terminal mid-turn');
        const reg = proxy.terminals();
        assert.ok(reg, 'both lanes carry live registries');
        // not the default lane's terminal — the lookup crosses to oc's
        assert.match(reg.snapshot(ocTid).output, /oc-term/);
        assert.throws(() => reg.snapshot('nope' as typeof ocTid), /Unknown terminal/);
      } finally {
        await close();
      }
    })());
});

describe('serve /v1/* — the bridge keeps the answer honest', () => {
  /** The agent's own tool call, in ACP's shape. */
  const call = (id: string, command: string) =>
    ({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'Ran ls',
      kind: 'execute',
      rawInput: { command },
    }) as SessionUpdate;

  /** The answer's blocks — the shape the client reads. */
  type Blocks = { type: string; text?: string; name?: string; input?: unknown }[];

  /** One buffered turn over `updates` — the answer's blocks. */
  async function buffered(
    updates: SessionUpdate[],
    body: Record<string, unknown>
  ): Promise<Blocks> {
    const fake = fakeAcpAgent({ updates, configOptions: [MODEL_OPTION] });
    const { r, close } = await postMessages(fake, body);
    try {
      return ((await r.json()) as { content: Blocks }).content;
    } finally {
      await close();
    }
  }

  test('the buffered text is not fed twice — a held stop prefix lands once', async () => {
    // "EN" is held back as the prefix of the stop sequence "END": the
    // settle path must not feed the whole text a second time
    const content = await buffered(chunks('EN'), {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['END'],
      stream: false,
    });
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('');
    assert.equal(text, 'EN');
  });

  test('the call keeps its place — the text it interrupted lands before it', async () => {
    const content = await buffered([...chunks('before EN'), call('tc-1', 'ls')], {
      messages: [{ role: 'user', content: 'list' }],
      stop_sequences: ['END'],
      stream: false,
      tools: BASH_TOOL,
    });
    assert.equal(content[0]?.type, 'text');
    assert.equal(content[0]?.text, 'before EN');
    assert.equal(content[1]?.type, 'tool_use');
  });

  test('a call past the stop cut is not part of the answer', async () => {
    const content = await buffered([...chunks('hello STOP'), call('tc-2', 'rm -rf /')], {
      messages: [{ role: 'user', content: 'x' }],
      stop_sequences: ['STOP'],
      stream: false,
      tools: BASH_TOOL,
    });
    assert.equal(
      content.find(b => b.type === 'tool_use'),
      undefined,
      'the cut ended the turn — the call is not part of the answer'
    );
  });

  test("the payload's own tag cannot close the call", async () => {
    const content = await buffered([call('tc-3', 'echo "</tool_call>"')], {
      messages: [{ role: 'user', content: 'run' }],
      stream: false,
      tools: BASH_TOOL,
    });
    const tu = content.find(b => b.type === 'tool_use');
    assert.ok(tu, 'the call survives its own payload');
    assert.deepEqual(tu?.input, { command: 'echo "</tool_call>"' });
  });

  test('a repeated tool_call does not reach the client twice', async () => {
    const content = await buffered([call('tc-4', 'ls'), call('tc-4', 'ls')], {
      messages: [{ role: 'user', content: 'list' }],
      stream: false,
      tools: BASH_TOOL,
    });
    assert.equal(
      content.filter(b => b.type === 'tool_use').length,
      1,
      'the client runs the call once'
    );
  });

  test('a chained empty retry fails loudly — the chain is not broken behind the client', async () => {
    const fake = fakeAcpAgent({
      updates: chunks('<tool_call>{"name":"ls","input":{"command":"ls"}}</tool_call>'),
      configOptions: [MODEL_OPTION],
    });
    const { url, close } = await boot(fake);
    const fnTools = [
      {
        type: 'function',
        name: 'Bash',
        description: 'run a command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ];
    try {
      const first = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'go', stream: false, tools: fnTools }),
      });
      assert.equal(first.status, 200);
      const id = ((await first.json()) as { id: string }).id;
      // the client retries with nothing new, while the predecessor holds
      // a tool answer — a chained retry cannot be answered afresh
      const second = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: [],
          previous_response_id: id,
          stream: false,
          tools: fnTools,
        }),
      });
      assert.equal(second.status, 400);
    } finally {
      await close();
    }
  });
});

// --- the fast lane (bro-6asnu) ------------------------------------------
// A classifier-shaped /v1/messages call byte-forwards to the direct
// upstream instead of paying session/new.

/** A canned Messages upstream — records every forwarded call and
 *  answers a fixed anthropic reply; stands in for api.anthropic.com. */
async function upstreamStub(): Promise<{
  url: string;
  calls: { path?: string; apiKey?: string; body: { model?: string } }[];
  close: () => Promise<void>;
}> {
  const calls: { path?: string; apiKey?: string; body: { model?: string } }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
    });
    req.on('end', () => {
      calls.push({
        path: req.url,
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: JSON.parse(raw === '' ? '{}' : raw) as { model?: string },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_up',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'upstream-answer' }],
          model: 'upstream-model',
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
        })
      );
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

describe('conductor fast lane (bro-6asnu)', () => {
  /** fast-lane cfg pointing at the test's stub upstream. */
  const fastCfg = (upstream: string, model?: string): ConductorConfig => ({
    ...CFG,
    fast: { upstream, apiKey: 'up-key', model, maxTokens: 2048 },
  });

  const CLASSIFIER_BODY = {
    model: 'dv-acp/swe-2-max',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content:
          'Evaluate whether this tool call is safe: {"name":"Bash","input":{"command":"rm x"}}',
      },
    ],
    stream: false,
  };

  test('a classifier-shaped call byte-forwards upstream — no session/new', async () => {
    const up = await upstreamStub();
    const fake = fakeAcpAgent({ replyText: 'session answer' });
    const { r, close } = await postMessages(fake, CLASSIFIER_BODY, fastCfg(up.url));
    try {
      assert.equal(r.status, 200);
      const body = (await r.json()) as { content: { text: string }[] };
      assert.equal(body.content[0]?.text, 'upstream-answer');
      // the whole call rode the upstream — credential swapped, path and
      // model forwarded verbatim (no pin configured)
      assert.equal(up.calls.length, 1);
      assert.equal(up.calls[0]?.path, '/v1/messages');
      assert.equal(up.calls[0]?.apiKey, 'up-key');
      assert.equal(up.calls[0]?.body.model, 'dv-acp/swe-2-max');
      // and no acp session was paid
      assert.equal(fake.sessions.length, 0);
      assert.equal(fake.prompts.length, 0);
    } finally {
      await close();
      await up.close();
    }
  });

  test('fast.model rewrites the forwarded body — the inherited-lane fix', async () => {
    const up = await upstreamStub();
    const fake = fakeAcpAgent({ replyText: 'x' });
    const { r, close } = await postMessages(
      fake,
      CLASSIFIER_BODY,
      fastCfg(up.url, 'claude-haiku-4-5')
    );
    try {
      assert.equal(r.status, 200);
      // the conductor-only id never reaches the upstream
      assert.equal(up.calls[0]?.body.model, 'claude-haiku-4-5');
      assert.equal(fake.sessions.length, 0);
    } finally {
      await close();
      await up.close();
    }
  });

  test('a tool-carrying call conducts even inside the token cap', async () => {
    const up = await upstreamStub();
    const fake = fakeAcpAgent({ replyText: 'agent answer', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake, fastCfg(up.url));
    try {
      const r = await post({
        model: 'x',
        max_tokens: 512,
        tools: [{ name: 'Bash', description: 'run', input_schema: {} }],
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      });
      assert.equal(r.status, 200);
      assert.equal(fake.sessions.length, 1);
      assert.equal(up.calls.length, 0);
    } finally {
      await close();
      await up.close();
    }
  });

  test('a session-scale cap conducts — compaction stays on the session lane', async () => {
    const up = await upstreamStub();
    const fake = fakeAcpAgent({ replyText: 'agent answer', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake, fastCfg(up.url));
    try {
      const r = await post({
        model: 'x',
        max_tokens: 32_000,
        messages: [{ role: 'user', content: 'summarize the whole thread' }],
        stream: false,
      });
      assert.equal(r.status, 200);
      assert.equal(fake.sessions.length, 1);
      assert.equal(up.calls.length, 0);
    } finally {
      await close();
      await up.close();
    }
  });

  test('an unarmed lane still conducts the fast-shaped call', async () => {
    const fake = fakeAcpAgent({ replyText: 'agent answer', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake); // CFG carries no fast lane
    try {
      const r = await post({ ...CLASSIFIER_BODY, model: undefined });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { content: { text: string }[] };
      assert.equal(body.content[0]?.text, 'agent answer');
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
    }
  });

  test('a config-disabled lane conducts the fast-shaped call even with a key', async () => {
    // serve.fastLane:false resolves to fast:undefined — the wire sees
    // exactly this cfg; boot it end-to-end so the disable is honored
    // through the routing decision, not just the config read
    const dir = mkdtempSync(join(tmpdir(), 'bro-conductor-fastoff-'));
    writeFileSync(
      join(dir, 'bro.config.local.json'),
      JSON.stringify({
        serve: { backend: 'dv-acp', fastLane: false },
        providers: { 'dv-acp': { type: 'acp', command: 'dv acp' } },
      })
    );
    const cfg = conductorConfig({ BRO_PROVIDER_API_KEY: 'k' }, dir);
    assert.equal(cfg?.fast, undefined);
    const fake = fakeAcpAgent({ replyText: 'agent answer', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake, cfg as ConductorConfig);
    try {
      // model must name an id the agent actually serves — the routed
      // gateway validates the id against the catalog, unlike bare CFG
      const r = await post({ ...CLASSIFIER_BODY, model: 'swe-x' });
      assert.equal(r.status, 200);
      assert.equal(fake.sessions.length, 1);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fast-shaped streamed call conducts over SSE when the lane is unarmed', async () => {
    const fake = fakeAcpAgent({ replyText: 'agent answer', configOptions: [MODEL_OPTION] });
    const { post, close } = await boot(fake);
    try {
      const r = await post({
        model: 'x',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(fake.sessions.length, 1);
      await r.text(); // drain the stream so the server can close
    } finally {
      await close();
    }
  });
});
