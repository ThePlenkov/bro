#!/usr/bin/env node
/**
 * brose — the template engine's CLI. Two verbs; parse/render stay SDK
 * ops (`@broject/brose` the library exposes them).
 *
 *   brose new --template name@version --out path [--set k=v ...] [--force]
 *   brose validate file.md [--template name@version]
 *
 * Both take `--templates-dir <dir>` (repeatable); `<cwd>/.brose/templates/`
 * is auto-prepended when present.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createFile } from './create.ts';
import { scalarValue } from './frontmatter.ts';
import { createRegistry } from './template.ts';
import { validate } from './validate.ts';

const USAGE = `brose — markdown template engine

usage:
  brose new --template <name@version> --out <path> [--set key=value ...] [--force] [--templates-dir <dir>]
  brose validate <file> [--template <name@version>] [--templates-dir <dir>]
`;

const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const opts = () =>
  ({
    template: { type: 'string' },
    out: { type: 'string' },
    set: { type: 'string', multiple: true },
    'templates-dir': { type: 'string', multiple: true },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }) as const;

function cmdNew(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: opts(), allowPositionals: true });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const ref = values.template ?? fail('new needs --template <name@version>');
  const out = values.out ?? fail('new needs --out <path>');
  const sets: Record<string, unknown> = {};
  for (const kv of values.set ?? []) {
    const eq = kv.indexOf('=');
    if (eq === -1) {
      fail(`--set needs key=value, got '${kv}'`);
    }
    sets[kv.slice(0, eq)] = scalarValue(kv.slice(eq + 1));
  }
  const registry = createRegistry({ dirs: values['templates-dir'] });
  try {
    createFile(out, ref, sets, { registry, force: values.force === true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`created ${out}`);
  return 0;
}

function cmdValidate(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: opts(),
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const file = positionals[0] ?? fail('validate needs a file path');
  if (!existsSync(file)) {
    fail(`no such file: ${file}`);
  }
  const registry = createRegistry({ dirs: values['templates-dir'] });
  const diags = validate(file, { template: values.template, registry });
  for (const d of diags) {
    console.log(
      `${d.severity === 'error' ? 'error' : 'warn'} ${d.path}:${d.line}: ${d.rule}: ${d.message}`
    );
  }
  return diags.some(d => d.severity === 'error') ? 1 : 0;
}

const [verb, ...rest] = process.argv.slice(2);
let code: number;
if (verb === 'new') {
  code = cmdNew(rest);
} else if (verb === 'validate') {
  code = cmdValidate(rest);
} else if (verb === '--help' || verb === '-h') {
  console.log(USAGE);
  code = 0;
} else {
  console.error(USAGE);
  code = 1;
}
process.exit(code);
