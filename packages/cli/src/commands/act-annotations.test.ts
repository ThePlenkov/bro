import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { collectAnnotations } from './act-annotations.ts';

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

function fakeGh(responses: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gh-'));
  const file = join(dir, 'gh');
  const encoded = JSON.stringify(responses);
  writeFileSync(
    file,
    `#!/bin/sh
key="$2"
if [ "$key" = "--paginate" ]; then key="$4"; fi
key=$(printf '%s' "$key" | cut -d '?' -f 1)
case "$key" in
${Object.keys(responses)
  .map(
    key => `  ${key}) printf '%s' '${JSON.stringify(responses[key]).replaceAll("'", "'\\''")}';;`
  )
  .join('\n')}
  *) exit 1;;
esac
`
  );
  chmodSync(file, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  void encoded;
}

const target = { repo: 'acme/widgets', pr: 7 };

describe('act annotations', () => {
  test('prints the failing check and its annotation rows in the collected document', () => {
    fakeGh({
      'repos/acme/widgets/pulls/7': { head: { sha: 'abc123' } },
      'repos/acme/widgets/commits/abc123/check-runs': [
        {
          check_runs: [
            {
              name: 'SonarCloud',
              conclusion: 'failure',
              output: { annotations_url: 'annotations/1' },
            },
          ],
        },
      ],
      'annotations/1': [
        [{ annotation_level: 'failure', path: 'src/main.ts', start_line: 12, title: 'Fix this' }],
      ],
    });
    assert.deepEqual(collectAnnotations(target), {
      pr: 7,
      head_sha: 'abc123',
      checks: [
        {
          name: 'SonarCloud',
          annotations: [{ level: 'failure', path: 'src/main.ts', line: 12, title: 'Fix this' }],
        },
      ],
    });
  });

  test('clean check runs produce an empty checks list', () => {
    fakeGh({
      'repos/acme/widgets/pulls/7': { head: { sha: 'abc123' } },
      'repos/acme/widgets/commits/abc123/check-runs': [
        {
          check_runs: [
            { name: 'CI', conclusion: 'success', output: { annotations_url: 'annotations/1' } },
          ],
        },
      ],
      'annotations/1': [[]],
    });
    assert.deepEqual(collectAnnotations(target).checks, []);
  });

  test('--json document conforms to the frozen schema', () => {
    fakeGh({
      'repos/acme/widgets/pulls/7': { head: { sha: 'abc123' } },
      'repos/acme/widgets/commits/abc123/check-runs': [{ check_runs: [] }],
    });
    const schema = JSON.parse(
      readFileSync(
        new URL('../../schemas/cli/act-annotations.schema.json', import.meta.url),
        'utf8'
      )
    ) as object;
    const valid = new Ajv2020().compile(schema)(collectAnnotations(target));
    assert.equal(valid, true);
  });
});
