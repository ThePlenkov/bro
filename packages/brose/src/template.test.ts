import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { flatSections } from './parse.ts';
import { createRegistry, parseTemplate, parseTemplateRef, resolveTemplate } from './template.ts';

const dir = mkdtempSync(join(tmpdir(), 'brose-tpl-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (root: string, rel: string, text: string): void => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

const T1 = `---\nname: t\nversion: 1\nfields:\n  a: {required: true}\n---\n# {{a}}\n## One\n`;
const T2 = `---\nname: t\nversion: 2\n---\n# {{a}}\n## One\n## Two\n`;
const OTHER = `---\nname: other\nversion: 1\n---\n# x\n`;
const PLAIN = '# just a doc\nnot a template\n';

write(dir, 'one/t.md', T1);
write(dir, 'one/t2.md', T2);
write(dir, 'one/nested/other.md', OTHER);
write(dir, 'one/plain.md', PLAIN);
write(dir, 'two/t.md', '---\nname: t\nversion: 1\n---\n# {{a}}\n## Shadow\n');

describe('parseTemplateRef', () => {
  it('splits name@version at the last @', () => {
    assert.deepEqual(parseTemplateRef('note@1'), { name: 'note', version: 1 });
    assert.deepEqual(parseTemplateRef('brotocol/spec@1'), {
      name: 'brotocol/spec',
      version: 1,
    });
    assert.deepEqual(parseTemplateRef('note'), { name: 'note' });
  });
});

describe('parseTemplate', () => {
  it('extracts name, version, fields, body, sections', () => {
    const t = parseTemplate(T1);
    assert.equal(t.name, 't');
    assert.equal(t.version, 1);
    assert.deepEqual(t.fields, { a: { required: true } });
    assert.deepEqual(
      flatSections(t.sections).map(s => s.title),
      ['{{a}}', 'One']
    );
  });

  it('rejects a non-template doc', () => {
    assert.throws(() => parseTemplate(PLAIN), /not a template/);
  });
});

describe('createRegistry', () => {
  const reg = createRegistry({ dirs: [join(dir, 'one'), join(dir, 'two')] });

  it('indexes recursive *.md templates, skipping plain docs', () => {
    assert.equal(reg.templates.length, 3);
    assert.deepEqual(reg.templates.map(t => `${t.name}@${t.version}`).sort(), [
      'other@1',
      't@1',
      't@2',
    ]);
  });

  it('resolves exact name@version and bare name → highest', () => {
    assert.equal(reg.resolve('t@1')!.version, 1);
    assert.equal(reg.resolve('t@2')!.version, 2);
    assert.equal(reg.resolve('t')!.version, 2);
    assert.equal(reg.resolve('other')!.version, 1);
    assert.equal(reg.resolve('nope'), undefined);
    assert.equal(reg.resolve('t@9'), undefined);
    assert.equal(resolveTemplate(reg, 't@1')!.version, 1);
  });

  it('first dir wins a duplicate name@version', () => {
    const t = reg.resolve('t@1')!;
    assert.equal(t.sections[0]!.children[0]!.title, 'One'); // dir 'one', not the 'two' shadow
  });

  it('auto-prepends <cwd>/.brose/templates', () => {
    const cwd = join(dir, 'proj');
    mkdirSync(join(cwd, '.brose/templates'), { recursive: true });
    writeFileSync(join(cwd, '.brose/templates/t.md'), '---\nname: proj\nversion: 1\n---\n# x\n');
    const local = createRegistry({ cwd });
    assert.equal(local.resolve('proj@1')!.name, 'proj');
  });
});
