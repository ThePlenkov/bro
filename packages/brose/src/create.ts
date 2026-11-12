/**
 * Create — render a template into a new doc. The doc's frontmatter is
 * `template: name@version` plus the declared `fields:` values; the body
 * is `render()`'d `{{placeholder}}` interpolation. `createFile` refuses
 * to overwrite without `{force: true}`.
 */
import { ioWrite } from './io.ts';
import { ownValue } from './own.ts';
import { dumpFrontmatter } from './frontmatter.ts';
import { render } from './render.ts';
import { createRegistry, type Registry, type Template } from './template.ts';
import { fieldValueError } from './validate.ts';

export interface CreateOpts {
  dirs?: string[];
  registry?: Registry;
  cwd?: string;
}

export function create(
  templateRef: string | Template,
  values: Record<string, unknown> = {},
  opts: CreateOpts = {}
): string {
  const t =
    typeof templateRef === 'string'
      ? (opts.registry ?? createRegistry({ dirs: opts.dirs, cwd: opts.cwd })).resolve(templateRef)
      : templateRef;
  if (t === undefined) {
    throw new Error(`unknown template '${templateRef}'`);
  }
  const missing = Object.entries(t.fields)
    // null counts as absent — validate() treats it the same, and a
    // `required: null` doc written here would fail there.
    .filter(([k, spec]) => spec.required === true && (ownValue(values, k) ?? null) === null)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
    );
  }
  // a provided value must satisfy its spec — `brose new` never writes a
  // doc `brose validate` would reject.
  for (const [k, spec] of Object.entries(t.fields)) {
    const v = ownValue(values, k);
    if (v === undefined || v === null) {
      continue;
    }
    const err = fieldValueError(v, spec);
    if (err !== undefined) {
      throw new Error(`field '${k}' ${err}`);
    }
  }
  // the `name@version` pin is emitted last so a template that declares
  // a `template` field can never shadow which template made the doc.
  const fm = Object.fromEntries([
    ...Object.keys(t.fields)
      .map(k => [k, ownValue(values, k)] as const)
      .filter((e): e is readonly [string, unknown] => e[1] !== undefined),
    ['template', `${t.name}@${t.version}`],
  ]);
  return `---\n${dumpFrontmatter(fm)}---\n\n${render(t, values)}`;
}

export function createFile(
  path: string,
  templateRef: string | Template,
  values: Record<string, unknown> = {},
  opts: CreateOpts & { force?: boolean } = {}
): void {
  const content = create(templateRef, values, opts);
  if (opts.force === true) {
    ioWrite(path, content);
    return;
  }
  try {
    ioWrite(path, content, { exclusive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`file exists: ${path} (pass force to overwrite)`);
    }
    throw e;
  }
}
