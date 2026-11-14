/**
 * `bro plan` — the plan contract surface: which kinds exist and at what
 * schema version, plus `validate` so an author can check a file before
 * `bro run` executes it, and `describe` so an author can read the kind's
 * shipped JSON Schema (spec bro-hp0su).
 *
 *   bro plan                    list plan kinds + schema versions
 *   bro plan validate <file>    validate without executing — same TOML
 *                               parse → kind routing → version gate →
 *                               planSchema pipeline `bro run` applies,
 *                               minus runPlan
 *   bro plan describe <kind>    the kind's shipped JSON Schema
 *                               (schemas/plans/<kind>.schema.json) —
 *                               --json prints it raw; human output is
 *                               the schema's example as a TOML template
 *
 * resolvePlanDoc is the shared resolve step — `bro run` (plugins.ts)
 * calls it too, so validate can never disagree with execute.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlanVersion, hasHelpFlag, planKind, printUsage, readPlanDoc } from '@broject/core';
import type { BroPlugin, ExitCode } from '@broject/core';
import { stringify } from 'smol-toml';

/** Parse + route + schema-validate a plan file — the `bro run` pipeline
 *  minus execution. Returns the owning plugin and the validated plan;
 *  the caller decides whether to runPlan or just report. */
export function resolvePlanDoc(
  file: string,
  plugins: readonly BroPlugin[]
): { plugin: BroPlugin; plan: unknown } {
  const kinds = planKinds(plugins);
  const doc = readPlanDoc(file);
  const kind = planKind(doc);
  if (!kind) {
    throw new Error(`${file}: no kind field — known plan kinds: ${kinds.join(', ')}`);
  }
  const plugin = plugins.find(p => p.name === kind);
  if (!plugin) {
    throw new Error(`${file}: kind "${kind}" is unknown — known plan kinds: ${kinds.join(', ')}`);
  }
  if (!plugin.planSchema || !plugin.runPlan) {
    throw new Error(`${file}: plugin "${kind}" does not accept plans`);
  }
  // the version gate runs before the schema: a contract pinned newer
  // than this bro understands must fail loudly, never misparse
  const verrs: string[] = [];
  checkPlanVersion(doc.version, kind, plugin.planVersion ?? 1, verrs);
  if (verrs.length > 0) {
    throw new Error(`${file}:\n  ${verrs.join('\n  ')}`);
  }
  return { plugin, plan: plugin.planSchema(doc, file) };
}

/** The shipped JSON Schema for a plan kind — packages/cli ships
 *  schemas/ next to dist/, while src/commands sits one level deeper in
 *  dev; walk up to the dir holding schemas/plans/<kind>.schema.json.
 *  Missing means the kind has no published schema (an external kind —
 *  externals cannot ship files into this package). */
function planSchemaFile(kind: string): string | undefined {
  // `kind` lands in a filesystem path below — the argv boundary already
  // restricts it to a declared plan kind; keep the join safe anyway so a
  // path-shaped string can never reach readFileSync (CWE-22).
  if (!/^[a-z][a-z0-9_-]*$/.test(kind)) {
    return undefined;
  }
  let dir = fileURLToPath(import.meta.url);
  for (let i = 0; i < 8; i += 1) {
    dir = dirname(dir);
    const file = join(dir, 'schemas', 'plans', `${kind}.schema.json`);
    if (existsSync(file)) {
      return file;
    }
  }
  return undefined;
}

function planKinds(plugins: readonly BroPlugin[]): string[] {
  return plugins.filter(p => p.planSchema && p.runPlan).map(p => p.name);
}

function describeKind(kind: string, plugins: readonly BroPlugin[], json: boolean): void {
  const plugin = plugins.find(p => p.name === kind && p.planSchema && p.runPlan);
  if (!plugin) {
    throw new Error(
      `plan describe: kind "${kind}" is unknown — known plan kinds: ${planKinds(plugins).join(', ')}`
    );
  }
  const file = planSchemaFile(kind);
  if (file === undefined) {
    throw new Error(
      `plan describe: kind "${kind}" has no shipped schema — expected schemas/plans/${kind}.schema.json`
    );
  }
  const schema = JSON.parse(readFileSync(file, 'utf8')) as { examples?: unknown[] };
  const version = plugin.planVersion ?? 1;
  if (json) {
    console.log(JSON.stringify({ kind, version, schema }, null, 2));
    return;
  }
  console.log(`${kind} — plan schema v${version} — schemas/plans/${kind}.schema.json`);
  const example = schema.examples?.[0];
  if (example !== undefined) {
    console.log(`\n${stringify(example as Parameters<typeof stringify>[0]).trimEnd()}`);
  }
}

function usage(exitCode: ExitCode = 2): never {
  printUsage(
    `Usage: bro plan [command]

Commands:
  list              plan kinds and their schema versions (default)
  validate <file>   validate a plan file without executing it
  describe <kind>   print a kind's plan schema — --json for the raw
                    JSON Schema, else the example as a TOML template`,
    exitCode
  );
}

export function runPlanCommand(argv: string[], plugins: readonly BroPlugin[]): void {
  const [sub, ...rest] = argv;
  const positional = rest.filter(a => !a.startsWith('-'));
  if (sub === '--help' || sub === '-h' || hasHelpFlag(rest)) {
    usage(0);
  }
  if (sub === undefined || sub === 'list') {
    for (const p of plugins.filter(x => x.planSchema && x.runPlan)) {
      console.log(`${p.name.padEnd(12)} v${p.planVersion ?? 1}${p.external ? ' (external)' : ''}`);
    }
    return;
  }
  if (sub === 'validate') {
    if (positional.length !== 1) {
      console.error(
        'error: bro plan validate takes exactly one file — `bro plan validate <plan.toml>`'
      );
      process.exit(2);
    }
    const file = positional[0] as string;
    const { plugin } = resolvePlanDoc(file, plugins);
    console.log(`${file}: ok — ${plugin.name} plan, schema v${plugin.planVersion ?? 1}`);
    return;
  }
  if (sub === 'describe') {
    if (positional.length !== 1) {
      console.error('error: bro plan describe takes exactly one kind — `bro plan describe <kind>`');
      process.exit(2);
    }
    // `kind` leaves argv into a filesystem path inside describeKind —
    // validate it against the declared plan-kind set BEFORE the join;
    // an unknown name is a loud error, never a silent disk probe.
    const kind = positional[0] as string;
    if (!planKinds(plugins).includes(kind)) {
      throw new Error(
        `plan describe: kind "${kind}" is unknown — known plan kinds: ${planKinds(plugins).join(', ')}`
      );
    }
    describeKind(kind, plugins, rest.includes('--json'));
    return;
  }
  usage();
}
