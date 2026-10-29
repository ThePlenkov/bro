import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hookEventName, otelSection, resolveHookPolicy } from './config.ts';

describe('otelSection', () => {
  test('defaults on junk input — disabled, file exporter, no policies', () => {
    for (const raw of [undefined, 'junk', 42, null, {}]) {
      const cfg = otelSection(raw);
      assert.equal(cfg.enabled, false);
      assert.deepEqual(cfg.exporter, { type: 'file', path: '', endpoint: '', headers: {} });
      assert.deepEqual(cfg.hooks, {});
    }
  });

  test('enabled only on boolean true', () => {
    assert.equal(otelSection({ enabled: true }).enabled, true);
    assert.equal(otelSection({ enabled: 'yes' }).enabled, false);
    assert.equal(otelSection({ enabled: 1 }).enabled, false);
  });

  test('exporter type allowlist, unknown → file', () => {
    assert.equal(otelSection({ exporter: { type: 'otlp' } }).exporter.type, 'otlp');
    assert.equal(otelSection({ exporter: { type: 'stdout' } }).exporter.type, 'stdout');
    assert.equal(otelSection({ exporter: { type: 'kafka' } }).exporter.type, 'file');
  });

  test('exporter fields trim + filter', () => {
    const cfg = otelSection({
      exporter: { endpoint: ' http://x:4318 ', path: ' /tmp/s.jsonl ', headers: { a: '1', b: 2 } },
    });
    assert.equal(cfg.exporter.endpoint, 'http://x:4318');
    assert.equal(cfg.exporter.path, '/tmp/s.jsonl');
    assert.deepEqual(cfg.exporter.headers, { a: '1' });
  });

  test('endpoint trailing slashes strip — the transport joins `${ep}/v1/*`', () => {
    assert.equal(
      otelSection({ exporter: { endpoint: 'http://x:4318/' } }).exporter.endpoint,
      'http://x:4318'
    );
    assert.equal(
      otelSection({ exporter: { endpoint: 'http://x:4318///' } }).exporter.endpoint,
      'http://x:4318'
    );
  });

  test('hooks keys normalize through hookEventName — host spellings match the bro name', () => {
    const cfg = otelSection({
      hooks: { PostToolUse: false, ' SessionStart ': { collect: ['a'] }, '*': true },
    });
    assert.deepEqual(cfg.hooks['post-tool'], { enabled: false, sample: 1, collect: [] });
    assert.deepEqual(cfg.hooks['session-start'], {
      enabled: true,
      sample: 1,
      collect: ['a'],
    });
    assert.equal(cfg.hooks['PostToolUse'], undefined);
  });

  test('hook policies: false / true / object', () => {
    const cfg = otelSection({
      hooks: {
        '*': true,
        'post-tool': { sample: 0.25, collect: ['tool_name', 'tool_response.success'] },
        stop: false,
      },
    });
    assert.deepEqual(cfg.hooks['*'], { enabled: true, sample: 1, collect: [] });
    assert.deepEqual(cfg.hooks['post-tool'], {
      enabled: true,
      sample: 0.25,
      collect: ['tool_name', 'tool_response.success'],
    });
    assert.deepEqual(cfg.hooks.stop, { enabled: false, sample: 1, collect: [] });
  });

  test('sample clamps [0,1], junk falls to 1', () => {
    assert.equal(otelSection({ hooks: { x: { sample: 2 } } }).hooks.x?.sample, 1);
    assert.equal(otelSection({ hooks: { x: { sample: -1 } } }).hooks.x?.sample, 0);
    assert.equal(otelSection({ hooks: { x: { sample: 'a' } } }).hooks.x?.sample, 1);
  });

  test('collect drops non-string entries', () => {
    const p = otelSection({ hooks: { x: { collect: ['a', 1, null, ''] } } }).hooks.x;
    assert.deepEqual(p?.collect, ['a']);
  });
});

describe('resolveHookPolicy', () => {
  const cfg = otelSection({
    enabled: true,
    hooks: { '*': { collect: ['tool_name'] }, 'post-tool': false },
  });

  test('named entry wins over *', () => {
    assert.deepEqual(resolveHookPolicy(cfg, 'post-tool'), {
      enabled: false,
      sample: 1,
      collect: [],
    });
  });

  test('* is the fallback', () => {
    assert.deepEqual(resolveHookPolicy(cfg, 'session-start'), {
      enabled: true,
      sample: 1,
      collect: ['tool_name'],
    });
  });

  test('absent * reads as enabled meta-only — otel.enabled alone lights every hook', () => {
    const bare = otelSection({ enabled: true });
    assert.deepEqual(resolveHookPolicy(bare, 'anything'), {
      enabled: true,
      sample: 1,
      collect: [],
    });
  });

  test('explicit "*": false is the enabled-but-silent spelling', () => {
    const silent = otelSection({ enabled: true, hooks: { '*': false } });
    assert.equal(resolveHookPolicy(silent, 'anything').enabled, false);
  });
});

describe('hookEventName', () => {
  test('host spellings map to bro names', () => {
    assert.equal(hookEventName('SessionStart'), 'session-start');
    assert.equal(hookEventName('sessionStart'), 'session-start');
    assert.equal(hookEventName('UserPromptSubmit'), 'prompt-submit');
    assert.equal(hookEventName('PostToolUse'), 'post-tool');
    assert.equal(hookEventName('PreToolUse'), 'pre-tool');
    assert.equal(hookEventName('PermissionRequest'), 'permission');
    assert.equal(hookEventName('PostCompaction'), 'post-compaction');
    assert.equal(hookEventName('PreCompact'), 'pre-compact');
    assert.equal(hookEventName('Stop'), 'stop');
  });

  test('bro names pass through, casing/space normalized', () => {
    assert.equal(hookEventName('post-tool'), 'post-tool');
    assert.equal(hookEventName(' prompt-submit '), 'prompt-submit');
  });
});
