import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin, { collectBroSkills, skillRoots } from './opencode.ts';
import { Bro } from './rpc.ts';

const dir = mkdtempSync(join(tmpdir(), 'bro-oc-rpc-'));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface AnyCb {
  (event: unknown, context?: unknown): void | Promise<void>;
}

/** A ctx with just the surfaces the RPC + skill paths read. */
function harness(options: Record<string, unknown> = {}) {
  const rpcHandlers = new Map<string, AnyCb>();
  const emitted: { name: string; data: unknown }[] = [];
  const skillsAdded: Record<string, unknown>[] = [];
  const prompts: { sessionID: string; text: string }[] = [];
  let registered: { events: { emit(name: string, data: unknown): Promise<void> } } | undefined;

  const ctx = {
    location: { directory: dir },
    options,
    app: { version: '2.2.5', channel: 'latest', name: 'cli' },
    session: {
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push(input);
        return { id: 'inbox' };
      },
      switchAgent: async () => undefined,
    },
    rpc: {
      register: async (definition: { id: string }, handlers: Record<string, AnyCb>) => {
        for (const [name, cb] of Object.entries(handlers)) {
          rpcHandlers.set(name, cb);
        }
        registered = {
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push({ name, data });
            },
          },
        };
        return registered;
      },
    },
    skill: {
      transform: async (cb: (e: { add(s: Record<string, unknown>): void }) => void) => {
        cb({ add: s => skillsAdded.push(s) });
        return { dispose: async () => undefined };
      },
    },
  };

  return {
    ctx,
    rpcHandlers,
    emitted,
    skillsAdded,
    prompts,
    get registered() {
      return registered;
    },
  };
}

describe('rpc contract', () => {
  test('the contract is a portable definition with the documented id', () => {
    assert.equal(Bro.id, 'bro');
    assert.deepEqual(Object.keys(Bro.methods).sort(), ['board', 'notify', 'prompt']);
    assert.deepEqual(Object.keys(Bro.events).sort(), ['attention', 'changed']);
  });

  test('the contract declares a not-found error for a missing session', () => {
    assert.ok(Bro.methods.prompt.errors !== undefined);
    assert.ok('no_session' in Bro.methods.prompt.errors);
  });
});

describe('rpc registration', () => {
  test('setup registers the bro contract', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    assert.ok(h.rpcHandlers.has('board'));
    assert.ok(h.rpcHandlers.has('notify'));
    assert.ok(h.rpcHandlers.has('prompt'));
    await teardown();
  });

  test('a ctx without rpc registers nothing and never throws', async () => {
    const teardown = await plugin.setup({} as never);
    await teardown();
  });
});

describe('rpc board', () => {
  test('board returns the parsed bro status snapshot', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const board = (await h.rpcHandlers.get('board')?.({})) as unknown as {
      inWork: { id: string }[];
      ready: { id: string }[];
      readyTotal: number;
      agents: { id: string }[];
      attention: number;
    };
    assert.ok(Array.isArray(board.inWork));
    assert.ok(Array.isArray(board.ready));
    assert.equal(typeof board.readyTotal, 'number');
    assert.equal(typeof board.attention, 'number');
    await teardown();
  });
});

describe('rpc notify', () => {
  test('notify with a session lands a message in that session', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const result = await h.rpcHandlers.get('notify')?.({
      sessionID: 'ses_1',
      text: 'PR #42 needs a fix',
      title: 'bro',
    });
    assert.deepEqual(result, { delivered: true });
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].sessionID, 'ses_1');
    assert.match(h.prompts[0].text, /PR #42 needs a fix/);
    await teardown();
  });

  test('notify without a session broadcasts on the attention event', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const result = await h.rpcHandlers.get('notify')?.({ text: 'board changed' });
    assert.deepEqual(result, { delivered: true });
    assert.equal(h.prompts.length, 0);
    const attention = h.emitted.find(e => e.name === 'attention');
    assert.ok(attention !== undefined);
    assert.match(String((attention.data as { message: string }).message), /board changed/);
    await teardown();
  });

  test('an empty text is not delivered', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const result = await h.rpcHandlers.get('notify')?.({ text: '   ' });
    assert.deepEqual(result, { delivered: false });
    await teardown();
  });
});

describe('rpc prompt', () => {
  test('prompt runs a turn in the named session', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const result = await h.rpcHandlers.get('prompt')?.({ sessionID: 'ses_2', text: 'go' });
    assert.deepEqual(result, { accepted: true });
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].sessionID, 'ses_2');
    await teardown();
  });

  test('prompt without a session is a declared error, not a crash', async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const result = (await h.rpcHandlers.get('prompt')?.({ text: 'go' })) as
      | { type?: string; message?: string }
      | undefined;
    assert.equal(result?.type, 'no_session');
    assert.match(String(result?.message), /sessionID/);
    await teardown();
  });

  test("prompt uses the host's error factory when it has one", async () => {
    const h = harness();
    const teardown = await plugin.setup(h.ctx as never);
    const seen: { type?: string; message?: string; data?: unknown }[] = [];
    const result = await h.rpcHandlers.get('prompt')?.(
      { text: 'go' },
      {
        error: (type: string, message: string, data?: unknown) => {
          seen.push({ type, message, data });
          return { branded: true, type };
        },
      }
    );
    assert.deepEqual(seen, [
      { type: 'no_session', message: 'sessionID is required', data: { sessionID: '' } },
    ]);
    assert.deepEqual(result, { branded: true, type: 'no_session' });
    await teardown();
  });

  test('prompt reports a missing session instead of crashing when the turn fails', async () => {
    const h = harness();
    h.ctx.session.prompt = async () => {
      throw new Error('session is gone');
    };
    const teardown = await plugin.setup(h.ctx as never);
    const result = (await h.rpcHandlers.get('prompt')?.(
      { sessionID: 'ses_3', text: 'go' },
      { error: (type: string, message: string) => ({ type, message }) }
    )) as { type?: string } | undefined;
    assert.equal(result?.type, 'no_session');
    await teardown();
  });
});

describe('bro skills', () => {
  test('skillRoots always offers a sibling and a checkout path', () => {
    const roots = skillRoots(undefined);
    assert.ok(roots.length > 1);
    assert.ok(roots.some(r => r.endsWith('skills')));
  });

  test('an explicit skillsDir wins over the default roots', () => {
    const roots = skillRoots({ skillsDir: '/tmp/explicit-skills' });
    assert.equal(roots[0], '/tmp/explicit-skills');
  });

  test('skills with frontmatter are collected, files without are skipped', async () => {
    const root = join(dir, 'skills');
    mkdirSync(join(root, 'act'), { recursive: true });
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(
      join(root, 'act', 'SKILL.md'),
      '---\nname: act\ndescription: PR review gate\n---\n\nBody.\n'
    );
    writeFileSync(join(root, 'broken', 'SKILL.md'), 'no frontmatter here\n');

    const skills = await collectBroSkills({ skillsDir: root });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, 'act');
    assert.equal(skills[0].name, 'act');
    assert.equal(skills[0].description, 'PR review gate');
    assert.match(skills[0].content, /Body\./);
  });

  test('a missing tree yields no skills instead of throwing', async () => {
    const skills = await collectBroSkills({ skillsDir: join(dir, 'does-not-exist') });
    assert.deepEqual(skills, []);
  });

  test('setup registers the collected skills into opencode registry', async () => {
    const root = join(dir, 'skills');
    mkdirSync(join(root, 'debt'), { recursive: true });
    writeFileSync(
      join(root, 'debt', 'SKILL.md'),
      '---\nname: debt\ndescription: review debt collection\n---\n\nBody.\n'
    );
    const h = harness({ skillsDir: root });
    const teardown = await plugin.setup(h.ctx as never);
    assert.equal(h.skillsAdded.length, 1);
    assert.equal(h.skillsAdded[0].id, 'debt');
    assert.equal(h.skillsAdded[0].description, 'review debt collection');
    await teardown();
  });
});
