import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flatSections, parse, parseContent } from './parse.ts';

const DOC = `---
a: 1
---
# Top

intro

## Alpha

text

### Alpha.One

deep

## Beta

\`\`\`md
# not a heading — fenced
\`\`\`

a # inline hash is not a heading

# Second Top
`;

describe('parse section tree', () => {
  const doc = parseContent(DOC);

  it('builds a nested tree in document order', () => {
    assert.deepEqual(
      doc.sections.map(s => s.title),
      ['Top', 'Second Top']
    );
    const [top, second] = doc.sections;
    assert.deepEqual(
      top!.children.map(s => s.title),
      ['Alpha', 'Beta']
    );
    assert.equal(top!.children[0]!.children[0]!.title, 'Alpha.One');
    assert.equal(second!.children.length, 0);
  });

  it('ignores fenced code and inline hashes', () => {
    const titles = flatSections(doc.sections).map(s => s.title);
    assert.equal(titles.filter(t => t.includes('not a heading')).length, 0);
    assert.equal(titles.length, 5);
  });

  it('carries 0-based line ranges offset by frontmatter', () => {
    const top = doc.sections[0]!;
    const beta = top.children[1]!;
    assert.equal(top.level, 1);
    assert.equal(top.line, 3); // '# Top' — after ---/a:1/---
    assert.equal(beta.level, 2);
    assert.equal(beta.line, 15);
    const flat = flatSections(doc.sections);
    assert.equal(flat.at(-1)!.endLine, DOC.split('\n').length);
  });

  it('exposes body without the frontmatter block', () => {
    assert.equal(doc.bodyOffset, 3);
    assert.ok(doc.body.startsWith('# Top'));
    assert.deepEqual(doc.frontmatter, { a: 1 });
  });
});

describe('parse input variants', () => {
  it('treats {content} as content and a newline string as content', () => {
    const a = parse({ content: '# hi\n' });
    const b = parse('# hi\n');
    assert.equal(a.sections[0]!.title, 'hi');
    assert.equal(b.sections[0]!.title, 'hi');
  });
});
