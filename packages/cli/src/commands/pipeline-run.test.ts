/** `bro pipeline run` tests — the queue→runPipeline starter's CLI
 *  surface (specs/bro-qjji2.10.md): formula loading, customer resolution
 *  precedence, queue selection (explicit items vs the label scan),
 *  --limit, --engines module loading, --dry-run, and --json. The heavy
 *  lifting (dedup, runPipeline invocation, sidecar) is starter.test.ts;
 *  these tests pin the command's own contract. `--dry-run` exercises
 *  every resolution step without invoking runPipeline. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { runPipelineCommand } from './pipeline.ts';
import { git, initRepo, insideAsync, installFakeBd } from './testrepo.ts';

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Intercept process.exit + capture console output, AWAITING the
 *  command — `run` is the async verb (it returns a Promise the
 *  dispatcher awaits); accept/answer resolve synchronously and `await`
 *  is a no-op on them. CommandError is the dispatcher contract. */
async function exits(fn: () => unknown): Promise<{ code: number; err: string[]; out: string[] }> {
  const origExit = process.exit;
  const origErr = console.error;
  const origOut = console.log;
  const err: string[] = [];
  const out: string[] = [];
  console.error = (...a: unknown[]) => err.push(a.join(' '));
  console.log = (...a: unknown[]) => out.push(a.join(' '));
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0);
  }) as typeof process.exit;
  try {
    await fn();
    return { code: -1, err, out };
  } catch (e) {
    if (e instanceof Exit) {
      return { code: e.code, err, out };
    }
    if (e !== null && typeof e === 'object' && (e as { name?: unknown }).name === 'CommandError') {
      const ce = e as { code?: unknown; message?: unknown };
      if (ce.message) err.push(String(ce.message));
      return { code: typeof ce.code === 'number' ? ce.code : 1, err, out };
    }
    return { code: -1, err, out };
  } finally {
    process.exit = origExit;
    console.error = origErr;
    console.log = origOut;
  }
}

/** Session/customer env must not leak the dev's own badges into the
 *  signer chain or the customer chain — same isolation the sibling
 *  command tests apply. */
const SESSION_VARS = [
  'BRO_AGENT_ID',
  'BRO_SESSION_ID',
  'BRO_PIPELINE_KEY',
  'BRO_CUSTOMER',
  'BEADS_ACTOR',
  'BD_ACTOR',
];

async function cleanEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of SESSION_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A minimal valid pipeline formula — one stage is enough for the
 *  command's resolution tests (dry-run never drives it). Shape matches
 *  the canonical spec formula: version, [limits], [[stages]] with
 *  name/engine/verdicts, [transitions] inline tables. */
const FORMULA = `version = 1

[limits]
in_flight = 1

[[stages]]
name = "capture"
engine = "learn"
verdicts = ["captured"]

[transitions]
capture = { captured = "end" }
`;

/** Write the formula into the repo and return its path. */
function seedFormula(main: string): string {
  const file = join(main, 'formula.toml');
  writeFileSync(file, FORMULA);
  return file;
}

/** A --engines fixture module — exports `engines` as a plain EngineMap
 *  (dry-run never invokes it). Written per-test into the repo. */
function seedEnginesModule(main: string, name = 'engines-fixture.ts'): string {
  const file = join(main, name);
  writeFileSync(file, `export const engines = { learn: () => ({ verdict: 'captured' }) };\n`);
  return file;
}

/** A --engines fixture exporting a (dir)=>EngineMap factory. */
function seedEnginesFactory(main: string): string {
  const file = join(main, 'engines-factory.ts');
  writeFileSync(
    file,
    `export const engines = (dir) => ({ learn: () => ({ verdict: 'captured' }) });\n`
  );
  return file;
}

describe('bro pipeline run', () => {
  test('--formula is required', async () => {
    const { root, main } = initRepo('bro-pipe-run-nof-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const r = await exits(() => runPipelineCommand(['run']));
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /--formula/);
      })
    );
  });

  test('an unreadable/bad formula is a usage error', async () => {
    const { root, main } = initRepo('bro-pipe-run-badf-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        writeFileSync(join(main, 'bad.toml'), 'this is not = = toml [[[', { flag: 'w' });
        const r = await exits(() =>
          runPipelineCommand(['run', '--formula', join(main, 'bad.toml'), '--dry-run'])
        );
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /--formula/);
      })
    );
  });

  test('customer-unresolved is a hard fail — nothing starts', async () => {
    const { root, main } = initRepo('bro-pipe-run-nocust-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        // every customer source must be empty: no --customer/BRO_CUSTOMER
        // (cleanEnv), bd config actor is unset (real bd → "(not set)"),
        // git user.name is blanked to '' (local-empty beats the global
        // ~/.gitconfig), and USER is unset — bdActor's whole chain ''
        git(['config', 'user.name', ''], main);
        const savedUser = process.env.USER;
        delete process.env.USER;
        try {
          const r = await exits(() =>
            runPipelineCommand([
              'run',
              '--formula',
              formula,
              '--engines',
              engines,
              '--dry-run',
              'fx-1',
            ])
          );
          assert.equal(r.code, 1);
          assert.match(r.err.join('\n'), /customer-unresolved/);
        } finally {
          if (savedUser === undefined) delete process.env.USER;
          else process.env.USER = savedUser;
        }
      })
    );
  });

  test('--customer resolves the recorded customer; explicit items would-start', async () => {
    const { root, main } = initRepo('bro-pipe-run-cust-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'petr',
            '--dry-run',
            '--json',
            'fx-1',
            'fx-2',
          ])
        );
        assert.equal(r.code, -1);
        const report = JSON.parse(r.out.join('\n')) as {
          customer?: string;
          dryRun: boolean;
          scanned: number;
          items: Array<{ item: string; action: string }>;
        };
        assert.equal(report.customer, 'petr');
        assert.equal(report.dryRun, true);
        assert.equal(report.scanned, 2);
        assert.deepEqual(
          report.items.map(i => i.action),
          ['would-start', 'would-start']
        );
      })
    );
  });

  test('BRO_CUSTOMER env resolves when --customer is absent; --customer wins', async () => {
    const { root, main } = initRepo('bro-pipe-run-envcust-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        process.env.BRO_CUSTOMER = 'env-cust';
        // env path
        const r1 = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--dry-run',
            '--json',
            'fx-1',
          ])
        );
        assert.equal((JSON.parse(r1.out.join('\n')) as { customer?: string }).customer, 'env-cust');
        // --customer overrides env
        const r2 = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'flag-cust',
            '--dry-run',
            '--json',
            'fx-1',
          ])
        );
        assert.equal(
          (JSON.parse(r2.out.join('\n')) as { customer?: string }).customer,
          'flag-cust'
        );
      })
    );
  });

  test('repeatable --item collects explicit ids alongside positionals', async () => {
    const { root, main } = initRepo('bro-pipe-run-items-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'c',
            '--dry-run',
            '--json',
            'fx-pos',
            '--item',
            'fx-a',
            '--item=fx-b',
          ])
        );
        const report = JSON.parse(r.out.join('\n')) as {
          items: Array<{ item: string; action: string }>;
        };
        assert.deepEqual(
          report.items.map(i => i.item),
          ['fx-pos', 'fx-a', 'fx-b']
        );
      })
    );
  });

  test('--limit bounds the candidates scanned', async () => {
    const { root, main } = initRepo('bro-pipe-run-limit-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'c',
            '--dry-run',
            '--json',
            '--limit',
            '2',
            'fx-1',
            'fx-2',
            'fx-3',
          ])
        );
        const report = JSON.parse(r.out.join('\n')) as { scanned: number };
        assert.equal(report.scanned, 2);
      })
    );
  });

  test('a malformed --limit is a usage error', async () => {
    const { root, main } = initRepo('bro-pipe-run-badlim-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'c',
            '--limit',
            'abc',
            'fx-1',
          ])
        );
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /--limit/);
      })
    );
  });

  test('--engines loads an EngineMap object', async () => {
    const { root, main } = initRepo('bro-pipe-run-eng-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'c',
            '--dry-run',
            '--json',
            'fx-1',
          ])
        );
        assert.equal(r.code, -1);
        assert.equal((JSON.parse(r.out.join('\n')) as { scanned: number }).scanned, 1);
      })
    );
  });

  test('--engines loads a (dir)=>EngineMap factory', async () => {
    const { root, main } = initRepo('bro-pipe-run-engf-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesFactory(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            engines,
            '--customer',
            'c',
            '--dry-run',
            '--json',
            'fx-1',
          ])
        );
        assert.equal(r.code, -1);
        assert.equal((JSON.parse(r.out.join('\n')) as { scanned: number }).scanned, 1);
      })
    );
  });

  test('--engines module with no engines export is a usage error', async () => {
    const { root, main } = initRepo('bro-pipe-run-noeng-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const bad = join(main, 'no-engines.ts');
        writeFileSync(bad, `export const other = 1;\n`);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            bad,
            '--customer',
            'c',
            '--dry-run',
            'fx-1',
          ])
        );
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /exports no 'engines'/);
      })
    );
  });

  test('--engines module that cannot be imported is a usage error', async () => {
    const { root, main } = initRepo('bro-pipe-run-badeng-');
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const r = await exits(() =>
          runPipelineCommand([
            'run',
            '--formula',
            formula,
            '--engines',
            join(main, 'missing.ts'),
            '--customer',
            'c',
            '--dry-run',
            'fx-1',
          ])
        );
        assert.equal(r.code, 2);
        assert.match(r.err.join('\n'), /--engines/);
      })
    );
  });

  test('empty queue → empty report, nothing started', async () => {
    const { root, main } = initRepo('bro-pipe-run-empty-');
    const { binDir, db } = installFakeBd(root, []);
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const savedPath = process.env.PATH;
        const savedDb = process.env.FAKE_BD_DB;
        process.env.PATH = `${binDir}:${savedPath ?? ''}`;
        process.env.FAKE_BD_DB = db;
        try {
          const r = await exits(() =>
            runPipelineCommand([
              'run',
              '--formula',
              formula,
              '--engines',
              engines,
              '--customer',
              'c',
              '--dry-run',
              '--json',
            ])
          );
          const report = JSON.parse(r.out.join('\n')) as { scanned: number; items: unknown[] };
          assert.equal(report.scanned, 0);
          assert.equal(report.items.length, 0);
        } finally {
          if (savedPath === undefined) delete process.env.PATH;
          else process.env.PATH = savedPath;
          if (savedDb === undefined) delete process.env.FAKE_BD_DB;
          else process.env.FAKE_BD_DB = savedDb;
        }
      })
    );
  });

  test('the label scan picks only pipeline-labeled ready beads', async () => {
    const { root, main } = initRepo('bro-pipe-run-label-');
    const { binDir, db } = installFakeBd(root, [
      {
        id: 'fx-pipe',
        title: 'queued',
        status: 'open',
        issue_type: 'task',
        priority: 1,
        created_at: '2026-01-01',
        labels: ['pipeline'],
      },
      {
        id: 'fx-other',
        title: 'not queued',
        status: 'open',
        issue_type: 'task',
        priority: 1,
        created_at: '2026-01-01',
        labels: ['other'],
      },
      {
        id: 'fx-nolabel',
        title: 'plain',
        status: 'open',
        issue_type: 'task',
        priority: 1,
        created_at: '2026-01-01',
      },
    ]);
    await insideAsync(main, root, () =>
      cleanEnv(async () => {
        const formula = seedFormula(main);
        const engines = seedEnginesModule(main);
        const savedPath = process.env.PATH;
        const savedDb = process.env.FAKE_BD_DB;
        process.env.PATH = `${binDir}:${savedPath ?? ''}`;
        process.env.FAKE_BD_DB = db;
        try {
          const r = await exits(() =>
            runPipelineCommand([
              'run',
              '--formula',
              formula,
              '--engines',
              engines,
              '--customer',
              'c',
              '--dry-run',
              '--json',
            ])
          );
          const report = JSON.parse(r.out.join('\n')) as {
            items: Array<{ item: string; action: string }>;
          };
          // only the pipeline-labeled ready bead is a candidate
          assert.deepEqual(
            report.items.map(i => i.item),
            ['fx-pipe']
          );
        } finally {
          if (savedPath === undefined) delete process.env.PATH;
          else process.env.PATH = savedPath;
          if (savedDb === undefined) delete process.env.FAKE_BD_DB;
          else process.env.FAKE_BD_DB = savedDb;
        }
      })
    );
  });
});
