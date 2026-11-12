/**
 * Validate — check a doc against its template. Frontmatter conforms to
 * the template's `fields:` schema (required, type, enum); the doc's
 * headings must contain the template's heading skeleton — same levels,
 * document order. Every violation is a diagnostic with path+line;
 * invalid docs never throw. A doc pinning `name@1` while `name@2`
 * exists validates against the PINNED version plus a
 * `template-outdated` advisory.
 */
import { isDeepStrictEqual } from 'node:util';
import { ioRead } from './io.ts';
import { ownValue } from './own.ts';
import { z } from 'zod';
import { flatSections, parseContent, type SectionNode } from './parse.ts';
import {
  createRegistry,
  parseTemplateRef,
  type FieldSpec,
  type Registry,
  type Template,
} from './template.ts';

export interface Diagnostic {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
  path: string;
  /** 1-based source line */
  line: number;
}

export interface ValidateOpts {
  /** `--template name@version` — overrides/supplies the doc's binding */
  template?: string | Template;
  dirs?: string[];
  registry?: Registry;
  cwd?: string;
}

const FIELD_TYPE: Record<NonNullable<FieldSpec['type']>, z.ZodType> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  list: z.array(z.unknown()),
  map: z.record(z.string(), z.unknown()),
};

/** Type/enum check for one supplied field value — `create` runs this
 *  before writing so a generated doc can never fail the same checks
 *  `validate` would apply after the fact. Missing/null handling (the
 *  `required` half) stays with the caller. */
export const fieldValueError = (value: unknown, spec: FieldSpec): string | undefined => {
  const typeCheck =
    spec.type === undefined ? undefined : ownValue<z.ZodType>(FIELD_TYPE, spec.type);
  if (typeCheck !== undefined && !typeCheck.safeParse(value).success) {
    return `must be ${spec.type}`;
  }
  // enum entries may be maps/lists — strict === would reject a value
  // equal in structure but not identity.
  if (spec.enum !== undefined && !spec.enum.some(v => isDeepStrictEqual(v, value))) {
    return `must be one of ${spec.enum.map(String).join(', ')}`;
  }
  return undefined;
};

/** A template heading with `{{placeholders}}` matches any doc title at
 *  that level — literal parts still pin (`RFC {{n}}` ≈ /^RFC .+$/).
 *  Whitespace between literals is significant (`RFC {{n}}` needs the
 *  space); only the pattern's outer edges trim, matching doc.trim(). */
const titleMatch = (tpl: string, doc: string): boolean => {
  if (!/\{\{/.test(tpl)) {
    return tpl.trim() === doc.trim();
  }
  // Wildcard match without RegExp: literals split on `{{…}}` are found
  // in order, each needing ≥1 unmatched char between it and the last
  // (the `.+` semantics). The first literal anchors at 0 only when it
  // opens the pattern; the last must reach the end unless the pattern
  // ends with a wildcard.
  const text = doc.trim();
  const parts = tpl
    .split(/\{\{[^}]*\}\}/)
    .map((p, i, a) => (i === 0 ? p.trimStart() : i === a.length - 1 ? p.trimEnd() : p));
  let cursor = 0;
  let sawLiteral = false;
  for (const [i, p] of parts.entries()) {
    if (p === '') {
      continue;
    }
    // the last literal must be a suffix — indexOf's first hit can sit
    // earlier and leave the end check unreachable (`{{n}} Spec` vs
    // 'Alpha Spec Spec').
    const isLast = i === parts.length - 1;
    let pos = isLast ? (text.endsWith(p) ? text.length - p.length : -1) : text.indexOf(p, cursor);
    while (!isLast && sawLiteral && pos !== -1 && pos <= cursor) {
      pos = text.indexOf(p, pos + 1);
    }
    if (
      pos === -1 ||
      (sawLiteral && pos <= cursor) ||
      (!sawLiteral && (i === 0 ? pos !== 0 : pos < 1))
    ) {
      return false;
    }
    sawLiteral = true;
    cursor = pos + p.length;
  }
  const last = parts.at(-1) ?? '';
  if (last !== '') {
    return cursor === text.length;
  }
  return sawLiteral ? cursor < text.length : text.length > 0;
};

function checkFields(
  doc: ReturnType<typeof parseContent>,
  t: Template,
  path: string,
  out: Diagnostic[]
): void {
  for (const [key, spec] of Object.entries(t.fields)) {
    // own-property only — a prototype key like `constructor` must not
    // read as a present field; the descriptor is the single safe read.
    const desc = Object.getOwnPropertyDescriptor(doc.frontmatter, key);
    const present = desc !== undefined && desc.value !== null;
    const line = doc.keyLines.get(key) ?? 1;
    if (!present) {
      if (spec.required === true) {
        out.push({
          severity: 'error',
          rule: 'field-required',
          message: `required field '${key}' is missing`,
          path,
          line,
        });
      }
      continue;
    }
    const value = desc.value;
    const typeCheck =
      spec.type === undefined ? undefined : ownValue<z.ZodType>(FIELD_TYPE, spec.type);
    if (typeCheck !== undefined && !typeCheck.safeParse(value).success) {
      out.push({
        severity: 'error',
        rule: 'field-type',
        message: `field '${key}' must be ${spec.type}`,
        path,
        line,
      });
      continue;
    }
    // enum entries may be maps/lists — strict === would reject a doc
    // value equal in structure but not identity.
    if (spec.enum !== undefined && !spec.enum.some(v => isDeepStrictEqual(v, value))) {
      out.push({
        severity: 'error',
        rule: 'field-enum',
        message: `field '${key}' must be one of ${spec.enum.map(String).join(', ')}`,
        path,
        line,
      });
    }
  }
}

function checkSections(
  doc: ReturnType<typeof parseContent>,
  t: Template,
  path: string,
  out: Diagnostic[]
): void {
  const required = flatSections(t.sections);
  const have = flatSections(doc.sections);
  let di = -1;
  for (const req of required) {
    const at = have.findIndex(
      (h, i) => i > di && h.level === req.level && titleMatch(req.title, h.title)
    );
    if (at !== -1) {
      di = at;
      continue;
    }
    const earlier = have.findIndex(
      (h, i) => i <= di && h.level === req.level && titleMatch(req.title, h.title)
    );
    const anchor = di >= 0 ? (have.at(di)?.line ?? 0) + 2 : doc.bodyOffset + 1;
    const misplaced = earlier === -1 ? undefined : have.at(earlier);
    out.push(
      misplaced !== undefined
        ? {
            severity: 'error',
            rule: 'section-order',
            message: `section '${req.title}' appears out of order (line ${misplaced.line + 1})`,
            path,
            line: misplaced.line + 1,
          }
        : {
            severity: 'error',
            rule: 'section-missing',
            message: `required section '${'#'.repeat(req.level)} ${req.title}' is missing`,
            path,
            line: anchor,
          }
    );
  }
}

export function validate(file: string, opts: ValidateOpts = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  let content: string;
  try {
    content = ioRead(file);
  } catch {
    return [
      {
        severity: 'error',
        rule: 'file-read',
        message: 'cannot read file',
        path: file,
        line: 1,
      },
    ];
  }
  const doc = parseContent(content);
  const registry = opts.registry ?? createRegistry({ dirs: opts.dirs, cwd: opts.cwd });

  let t: Template | undefined;
  let declaredRef: string | undefined;
  if (opts.template !== undefined) {
    t = typeof opts.template === 'string' ? registry.resolve(opts.template) : opts.template;
    declaredRef =
      typeof opts.template === 'string'
        ? opts.template
        : `${opts.template.name}@${opts.template.version}`;
  } else if (typeof doc.frontmatter.template === 'string') {
    declaredRef = doc.frontmatter.template;
    t = registry.resolve(declaredRef);
  }
  if (t === undefined) {
    out.push({
      severity: 'error',
      rule: declaredRef === undefined ? 'template-missing' : 'template-unknown',
      message:
        declaredRef === undefined
          ? "doc declares no 'template:' frontmatter and no --template was given"
          : `template '${declaredRef}' is not in the registry`,
      path: file,
      line: doc.keyLines.get('template') ?? 1,
    });
    return out;
  }

  const pinned = parseTemplateRef(declaredRef ?? `${t.name}@${t.version}`);
  if (pinned.version !== undefined) {
    const latest = registry.latestVersion(pinned.name);
    if (latest !== undefined && latest > pinned.version) {
      out.push({
        severity: 'warn',
        rule: 'template-outdated',
        message: `${pinned.name}@${latest} available`,
        path: file,
        line: doc.keyLines.get('template') ?? 1,
      });
    }
  }

  checkFields(doc, t, file, out);

  const requiredSections: SectionNode[] = flatSections(t.sections);
  if (requiredSections.length > 0) {
    checkSections(doc, t, file, out);
  }
  return out;
}
