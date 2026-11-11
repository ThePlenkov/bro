/**
 * Validate — check a doc against its template. Frontmatter conforms to
 * the template's `fields:` schema (required, type, enum); the doc's
 * headings must contain the template's heading skeleton — same levels,
 * document order. Every violation is a diagnostic with path+line;
 * invalid docs never throw. A doc pinning `name@1` while `name@2`
 * exists validates against the PINNED version plus a
 * `template-outdated` advisory.
 */
import { readFileSync } from 'node:fs';
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

/** A template heading with `{{placeholders}}` matches any doc title at
 *  that level — literal parts still pin (`RFC {{n}}` ≈ /^RFC .+$/). */
const titleMatch = (tpl: string, doc: string): boolean => {
  if (!/\{\{/.test(tpl)) {
    return tpl.trim() === doc.trim();
  }
  const re = tpl
    .split(/\{\{[^}]*\}\}/)
    .map(p => p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${re}$`).test(doc.trim());
};

function checkFields(
  doc: ReturnType<typeof parseContent>,
  t: Template,
  path: string,
  out: Diagnostic[]
): void {
  for (const [key, spec] of Object.entries(t.fields)) {
    const present = key in doc.frontmatter && doc.frontmatter[key] !== null;
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
    const value = doc.frontmatter[key];
    if (spec.type !== undefined && !FIELD_TYPE[spec.type].safeParse(value).success) {
      out.push({
        severity: 'error',
        rule: 'field-type',
        message: `field '${key}' must be ${spec.type}`,
        path,
        line,
      });
      continue;
    }
    if (spec.enum !== undefined && !spec.enum.some(v => v === value)) {
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
    const anchor = di >= 0 ? have[di]!.line + 2 : doc.bodyOffset + 1;
    out.push(
      earlier !== -1
        ? {
            severity: 'error',
            rule: 'section-order',
            message: `section '${req.title}' appears out of order (line ${have[earlier]!.line + 1})`,
            path,
            line: have[earlier]!.line + 1,
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
    content = readFileSync(file, 'utf8');
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
