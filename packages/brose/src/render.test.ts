import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render } from './render.ts';
import { parseTemplate } from './template.ts';

describe('render', () => {
  it('interpolates {{key}} placeholders into a body string', () => {
    assert.equal(
      render('# {{title}}\nby {{ author }}\n', { title: 'Hi', author: 'x' }),
      '# Hi\nby x\n'
    );
  });

  it('renders a Template object via its body', () => {
    const t = parseTemplate('---\nname: t\nversion: 1\n---\n# {{title}}\n## Fixed\n');
    assert.equal(render(t, { title: 'Yo' }), '# Yo\n## Fixed\n');
  });

  it('empties missing values and stringifies non-strings', () => {
    assert.equal(render('{{a}} {{b}} {{c}}', { b: 3 }), ' 3 ');
  });
});
