import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ToolCallItem } from '@broject/acp-model';
import { acpCardRows, lineText } from './acp-lines.ts';

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
