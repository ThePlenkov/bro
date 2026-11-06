import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskRow, TaskStore } from './tasks.ts';
import { parseTaskSpecBody, taskSpecFacade, type TaskSpec } from './taskspec.ts';

/** In-memory TaskStore — the facade's only demands are get/update;
 *  update applies the patch back so a spec() re-read sees the write. */
function fakeStore(rows: TaskRow[]): {
  store: TaskStore;
  updates: [string, Record<string, string | number>][];
} {
  const updates: [string, Record<string, string | number>][] = [];
  const store = {
    get: (id: string) => rows.find(r => r.id === id),
    update: (id: string, patch: Record<string, string | number>) => {
      updates.push([id, patch]);
      const r = rows.find(x => x.id === id);
      if (r !== undefined && patch.description !== undefined) {
        r.description = String(patch.description);
      }
    },
  } as unknown as TaskStore;
  return { store, updates };
}

const spec = (rows: TaskRow[], id: string): TaskSpec | undefined =>
  taskSpecFacade(fakeStore(rows).store).spec(id);

describe('parseTaskSpecBody — section projection', () => {
  test('a bead carrying every section projects all fields', () => {
    const f = parseTaskSpecBody(
      'the work to do\n\nmore context\n\n' +
        '## Acceptance\n- AC one\n- AC two\n\n' +
        '## DoD\ntests green, docs updated\n\n' +
        '## DoR\nscope agreed, deps landed\n\n' +
        '## Scenarios\n- happy path\n- sad path\n\n' +
        '## Notes\nunmanaged prose stays'
    );
    assert.deepEqual(f.acceptance, ['AC one', 'AC two']);
    assert.equal(f.dod, 'tests green, docs updated');
    assert.equal(f.dor, 'scope agreed, deps landed');
    assert.deepEqual(f.scenarios, ['happy path', 'sad path']);
    assert.equal(f.body, 'the work to do\n\nmore context\n\n## Notes\nunmanaged prose stays');
  });

  test('a bead without ## Acceptance is the unverifiable shape', () => {
    const f = parseTaskSpecBody('just a description\n\n## DoD\ndone means done');
    assert.equal(f.acceptance, undefined);
    assert.equal(f.dod, 'done means done');
    assert.equal(f.body, 'just a description');
  });

  test('an empty ## Acceptance section is absent, not an empty list', () => {
    const f = parseTaskSpecBody('body\n\n## Acceptance\n\n## DoD\ntext');
    assert.equal(f.acceptance, undefined);
    assert.equal(f.dod, 'text');
  });

  test('an absent body projects nothing', () => {
    assert.deepEqual(parseTaskSpecBody(undefined), {});
    assert.deepEqual(parseTaskSpecBody('   '), {});
  });
});

describe('parseTaskSpecBody — malformed input', () => {
  test('a heading without the space is prose, not a section', () => {
    const f = parseTaskSpecBody('intro\n\n##Acceptance\n- not an ac\n');
    assert.equal(f.acceptance, undefined);
    assert.equal(f.body, 'intro\n\n##Acceptance\n- not an ac');
  });

  test('heading names match case-insensitively', () => {
    const f = parseTaskSpecBody(
      '## acceptance\n- a\n\n## dod\nd\n\n## DOR\nr\n\n## SCENARIOS\n- s'
    );
    assert.deepEqual(f.acceptance, ['a']);
    assert.equal(f.dod, 'd');
    assert.equal(f.dor, 'r');
    assert.deepEqual(f.scenarios, ['s']);
  });

  test('the first of two same-named sections wins; the rest is body', () => {
    const f = parseTaskSpecBody('## Acceptance\n- real\n\n## Acceptance\n- impostor\n\n## DoD\nd');
    assert.deepEqual(f.acceptance, ['real']);
    assert.ok(f.body?.includes('## Acceptance\n- impostor'));
  });

  test('a bullet-less section still yields its non-empty lines', () => {
    const f = parseTaskSpecBody('## Acceptance\nmust not regress\nmust stay fast\n');
    assert.deepEqual(f.acceptance, ['must not regress', 'must stay fast']);
  });

  test('mixed prose and bullets keeps only the bullets', () => {
    const f = parseTaskSpecBody('## Acceptance\nintro prose\n- ac\noutro prose\n');
    assert.deepEqual(f.acceptance, ['ac']);
  });

  test('numbered and star/plus/bullet-dot items all count', () => {
    const f = parseTaskSpecBody('## Scenarios\n1. first\n2) second\n* third\n+ fourth\n• fifth');
    assert.deepEqual(f.scenarios, ['first', 'second', 'third', 'fourth', 'fifth']);
  });

  test('a ### subsection inside a managed section is body, not content', () => {
    const f = parseTaskSpecBody('## DoD\n### Detail\nkept verbatim\n\n## Acceptance\n- a');
    assert.equal(f.dod, undefined);
    assert.equal(f.body, '### Detail\nkept verbatim');
    assert.deepEqual(f.acceptance, ['a']);
  });

  test('### Examples bullets under ## Acceptance never become criteria', () => {
    const f = parseTaskSpecBody(
      '## Acceptance\n- real\n\n### Examples\n- example, not an ac\n\n## DoD\nd'
    );
    assert.deepEqual(f.acceptance, ['real']);
    assert.ok(f.body?.includes('### Examples\n- example, not an ac'));
  });

  test('ATX headings with up to three leading spaces count; four is code', () => {
    const f = parseTaskSpecBody('  ## Acceptance\n- a\n\n   ## Scenarios\n- s');
    assert.deepEqual(f.acceptance, ['a']);
    assert.deepEqual(f.scenarios, ['s']);
    // four spaces — indented code, never a heading
    const g = parseTaskSpecBody('    ## Acceptance\n- not an ac');
    assert.equal(g.acceptance, undefined);
    assert.ok(g.body?.includes('## Acceptance'));
  });

  test('a section inside a fenced code block is an example, not a spec', () => {
    const f = parseTaskSpecBody(
      'the body\n\n```md\n## Acceptance\n- example check\n```\n\n## DoD\nreal done'
    );
    assert.equal(f.acceptance, undefined);
    assert.equal(f.dod, 'real done');
    assert.ok(f.body?.includes('## Acceptance'));
  });

  test('~~~ fences hide sections the same way', () => {
    const f = parseTaskSpecBody('~~~\n## Acceptance\n- fake\n~~~\n\n## Acceptance\n- real');
    assert.deepEqual(f.acceptance, ['real']);
  });

  test('a fenced bullet under ## Acceptance never becomes an item', () => {
    const f = parseTaskSpecBody('## Acceptance\n```\n- fake ac\n```\n- real ac');
    assert.deepEqual(f.acceptance, ['real ac']);
  });

  test('an unclosed fence swallows the rest — nothing after it parses', () => {
    const f = parseTaskSpecBody('## DoD\nd\n\n```\n## Acceptance\n- fake');
    // the fence is DoD's own verbatim content — what it hides is the section
    assert.equal(f.dod, 'd\n\n```\n## Acceptance\n- fake');
    assert.equal(f.acceptance, undefined);
  });

  test('prototype-member heading names stay body — never a managed section', () => {
    for (const h of ['## Constructor', '## __proto__', '## ToString', '## HasOwnProperty']) {
      const f = parseTaskSpecBody(`${h}\nkeep me`);
      assert.equal(f.acceptance, undefined, h);
      assert.equal(f.dod, undefined, h);
      assert.equal(f.dor, undefined, h);
      assert.equal(f.scenarios, undefined, h);
      assert.equal(f.body, `${h}\nkeep me`, h);
    }
  });

  test('a pathological whitespace heading parses in linear time', () => {
    const t0 = Date.now();
    const f = parseTaskSpecBody(`## ${' '.repeat(200_000)}`);
    assert.ok(Date.now() - t0 < 1000, 'heading scan must not backtrack');
    assert.equal(f.acceptance, undefined);
  });

  test('an ATX closing sequence is not part of the name', () => {
    const f = parseTaskSpecBody('## Acceptance ##\n- a');
    assert.deepEqual(f.acceptance, ['a']);
  });

  test('the bro: metadata trailer never leaks into body', () => {
    const f = parseTaskSpecBody('notes\n\n## Acceptance\n- a\n\n<!-- bro: {"type":"task"} -->');
    assert.deepEqual(f.acceptance, ['a']);
    assert.equal(f.body, 'notes');
  });
});

describe('taskSpecFacade — spec read', () => {
  test('a missing item answers undefined, not a phantom spec', () => {
    assert.equal(spec([], 't1'), undefined);
  });

  test('id/title mirror the row; a description-less row is the minimum', () => {
    const s = spec([{ id: 't1', title: 'the task' }], 't1');
    assert.equal(s?.id, 't1');
    assert.equal(s?.title, 'the task');
    assert.equal(s?.body, undefined);
    assert.equal(s?.acceptance, undefined);
  });

  test('a title-less row still projects — title degrades to empty', () => {
    const s = spec([{ id: 't1', description: '## Acceptance\n- a' }], 't1');
    assert.equal(s?.title, '');
    assert.deepEqual(s?.acceptance, ['a']);
  });
});

describe('taskSpecFacade — annotate write', () => {
  test('appends the artifact as a section the next read sees', () => {
    const rows: TaskRow[] = [{ id: 't1', title: 'x', description: 'the body' }];
    const { store, updates } = fakeStore(rows);
    const f = taskSpecFacade(store);
    f.annotate('t1', 'Questions', ['- what is the scope?', '- who approves?']);
    assert.deepEqual(updates, [
      ['t1', { description: 'the body\n\n## Questions\n- what is the scope?\n- who approves?' }],
    ]);
    // the intake artifact enriches the spec the next pass reads
    const s = f.spec('t1');
    assert.ok(s?.body?.includes('## Questions\n- what is the scope?'));
  });

  test('an empty body gets the section without leading whitespace', () => {
    const rows: TaskRow[] = [{ id: 't1', title: 'x' }];
    const { store, updates } = fakeStore(rows);
    taskSpecFacade(store).annotate('t1', 'Declined', ['spec is not ready']);
    assert.equal(updates[0]?.[1].description, '## Declined\nspec is not ready');
  });

  test('the bro: trailer keeps its body-last position', () => {
    const rows: TaskRow[] = [{ id: 't1', description: 'body\n\n<!-- bro: {"type":"task"} -->' }];
    const { store, updates } = fakeStore(rows);
    taskSpecFacade(store).annotate('t1', 'Questions', ['- q']);
    assert.equal(
      updates[0]?.[1].description,
      'body\n\n## Questions\n- q\n\n<!-- bro: {"type":"task"} -->'
    );
  });

  test('a managed name can author an absent section once', () => {
    const rows: TaskRow[] = [{ id: 't1', description: 'body' }];
    const f = taskSpecFacade(fakeStore(rows).store);
    f.annotate('t1', 'Acceptance', ['- authored']);
    assert.deepEqual(f.spec('t1')?.acceptance, ['authored']);
  });

  test('a managed name that exists already throws — the dup would be dead text', () => {
    const rows: TaskRow[] = [{ id: 't1', description: '## Acceptance\n- a' }];
    const f = taskSpecFacade(fakeStore(rows).store);
    assert.throws(() => f.annotate('t1', 'Acceptance', ['- b']), /already exists/);
  });

  test('a missing item throws — annotating nothing is a silent drop', () => {
    const f = taskSpecFacade(fakeStore([]).store);
    assert.throws(() => f.annotate('t9', 'Questions', ['- q']), /not in the store/);
  });

  test('empty, whitespace, and multi-line headings throw', () => {
    const f = taskSpecFacade(fakeStore([{ id: 't1' }]).store);
    assert.throws(() => f.annotate('t1', '', ['- q']), /non-empty/);
    assert.throws(() => f.annotate('t1', '   ', ['- q']), /non-empty/);
    assert.throws(() => f.annotate('t1', 'Questions\nextra', ['- q']), /single non-empty line/);
  });

  test('an empty artifact throws', () => {
    const f = taskSpecFacade(fakeStore([{ id: 't1' }]).store);
    assert.throws(() => f.annotate('t1', 'Questions', []), /no artifact/);
  });

  test('a managed name with a closing sequence still hits the dup guard', () => {
    const rows: TaskRow[] = [{ id: 't1', description: '## Acceptance\n- a' }];
    const f = taskSpecFacade(fakeStore(rows).store);
    assert.throws(() => f.annotate('t1', 'Acceptance ##', ['- b']), /already exists/);
  });

  test('artifact lines that open a section throw — no structure injection', () => {
    const f = taskSpecFacade(fakeStore([{ id: 't1', description: 'body' }]).store);
    assert.throws(() => f.annotate('t1', 'Declined', ['## Acceptance', '- fake']), /structure/);
    assert.throws(() => f.annotate('t1', 'Declined', ['  ## DoD']), /structure/);
    // even embedded past a line break inside one element
    assert.throws(() => f.annotate('t1', 'Questions', ['who?\n## Acceptance']), /structure/);
  });

  test('an injected managed name can never author criteria', () => {
    const rows: TaskRow[] = [{ id: 't1', description: 'body' }];
    const f = taskSpecFacade(fakeStore(rows).store);
    assert.throws(
      () => f.annotate('t1', 'Declined', ['weak spec', '## Acceptance', '- x']),
      /structure/
    );
    assert.equal(f.spec('t1')?.acceptance, undefined);
  });

  test('artifact lines that open a fence throw — later artifacts stay live', () => {
    const rows: TaskRow[] = [{ id: 't1', description: 'body' }];
    const f = taskSpecFacade(fakeStore(rows).store);
    assert.throws(() => f.annotate('t1', 'Questions', ['```']), /structure/);
    assert.throws(() => f.annotate('t1', 'Questions', ['~~~ts']), /structure/);
    // inline backticks mid-line are prose, not a fence
    f.annotate('t1', 'Questions', ['how do I use ```ts blocks?']);
  });

  test('non-structural line breaks inside an element stay verbatim', () => {
    const rows: TaskRow[] = [{ id: 't1', description: 'body' }];
    const { store, updates } = fakeStore(rows);
    taskSpecFacade(store).annotate('t1', 'Questions', ['who decides?\nand when?']);
    assert.equal(updates[0]?.[1].description, 'body\n\n## Questions\nwho decides?\nand when?');
  });
});
