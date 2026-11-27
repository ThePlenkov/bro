import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { tailCommand } from '../src/renderers.ts';

const run = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    const stop = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    }, 120);
    child.on('close', () => {
      clearTimeout(stop);
      resolve(output);
    });
    child.on('error', reject);
  });

describe('events pane broker status', () => {
  test('collapses repeated failures and reports recovery and other errnos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-herdr-renderers-'));
    const broker = join(dir, 'fake-bro');
    writeFileSync(
      broker,
      `#!/bin/sh
count_file='${join(dir, 'count')}'
n=$(cat "$count_file" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"$count_file"
case "$n" in
  1|2) echo 'error: connect ENOENT /run/user/1000/bro-bus/test.sock' >&2; exit 1 ;;
  3) echo '{"topic":"worker","kind":"recovered"}'; exit 0 ;;
  *) echo 'error: connect EACCES /run/user/1000/bro-bus/test.sock' >&2; exit 1 ;;
esac
`
    );
    chmodSync(broker, 0o755);
    const command = tailCommand(join(dir, 'workspace'), broker)
      .replace(
        `cd '${join(dir, 'workspace')}'`,
        `mkdir -p '${join(dir, 'workspace')}' && cd '${join(dir, 'workspace')}'`
      )
      .replaceAll('sleep 5', 'sleep 0.01');

    const output = await run(command);
    assert.equal((output.match(/\n── broker down/g) ?? []).length, 1);
    assert.match(output, /broker down — run bro bus serve/);
    assert.match(output, /broker up — events resumed/);
    assert.match(output, /broker error — error: connect EACCES/);
  });
});
