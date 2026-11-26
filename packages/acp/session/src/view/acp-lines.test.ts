import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolCallItem } from '@broject/acp-model';
import { acpCardRows, acpLine, lineText } from './acp-lines.ts';

const toolWithDiff = (oldText: string, newText: string): ToolCallItem =>
  ({
    kind: 'tool_call',
    content: [{ type: 'diff', path: 'example.txt', oldText, newText }],
  }) as unknown as ToolCallItem;

describe('ACP diff card rows', () => {
  test('preserves blank lines while keeping subsequent line numbers honest', () => {
    const rows = acpCardRows(toolWithDiff('before\n\nold third', 'before\n\nnew third'), 80);
    const text = rows.map(row => lineText(row.segments));

    assert.deepEqual(text, [
      'example.txt',
      '-  1 before',
      '-  2 ',
      '-  3 old third',
      '+  1 before',
      '+  2 ',
      '+  3 new third',
    ]);
  });
});

const tool = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'tool_call',
    toolCallId: 't1',
    toolName: 'shell',
    title: 'a very long title\nleaked second line',
    toolKind: null,
    toolStatus: 'completed',
    content: [],
    index: 1,
    ...overrides,
  }) as never;

test('tool titles are reduced to their first line', () => {
  const row = acpLine(tool(), { width: 80, frame: 0, findTool: () => undefined });
  assert.equal(lineText(row).includes('leaked second line'), false);
});

test('clipped tool rows retain the status glyph', () => {
  const row = acpLine(tool(), { width: 20, frame: 0, findTool: () => undefined });
  assert.equal(row[0]?.text, '✓ ');
  assert.equal(lineText(row).startsWith('✓ '), true);
});
