/**
 * Templates — a template IS an example doc: md file + frontmatter
 * `name`/`version` (+ optional `fields:` schema), its headings the
 * required section skeleton, `{{placeholders}}` in the body. The
 * registry scans template dirs and resolves `name@version` (exact)
 * or bare `name` (highest version). First dir wins on a duplicate
 * `name@version`, so the project `.brose/templates/` overrides.
 */
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { ioExists, ioRead, ioReadDir } from './io.ts';
import { z } from 'zod';
import { parseFrontmatter } from './frontmatter.ts';
import { parseContent, type SectionNode } from './parse.ts';

export const fieldSpecSchema = z
  .object({
    required: z.boolean().optional(),
    type: z.enum(['string', 'number', 'boolean', 'list', 'map']).optional(),
    enum: z.array(z.unknown()).optional(),
  })
  .loose();

export type FieldSpec = z.infer<typeof fieldSpecSchema>;

export interface TemplateRef {
  name: string;
  version?: number;
}

export interface Template {
  name: string;
  version: number;
  /** declared frontmatter field schema — {} when unconstrained */
  fields: Record<string, FieldSpec>;
  /** raw body with {{placeholders}} */
  body: string;
  /** the template's own heading skeleton — the required sections */
  sections: SectionNode[];
  /** all template frontmatter (name/version/fields + extras) */
  frontmatter: Record<string, unknown>;
  path?: string;
}

/** `name@version` → ref; a bare `name` resolves to the highest
 *  registered version. `brotocol/spec@1` → `{name: 'brotocol/spec'}`. */
export function parseTemplateRef(ref: string): TemplateRef {
  const m = /^(.*)@(\d+)$/.exec(ref.trim());
  return m === null
    ? { name: ref.trim() }
    : { name: m.at(1) ?? '', version: Number.parseInt(m.at(2) ?? '0', 10) };
}

// Versions are non-negative integers — `name@-1` would register but
// `parseTemplateRef` (`@(\d+)`) could never resolve it back.
const templateish = (fm: Record<string, unknown>): boolean =>
  typeof fm.name === 'string' &&
  ((Number.isInteger(fm.version) && (fm.version as number) >= 0) ||
    /^\d+$/.test(String(fm.version)));

/** Parse one template document. Throws on a doc that is not a template
 *  (registry scanning skips such files instead — see createRegistry). */
export function parseTemplate(content: string, path?: string): Template {
  const fm = parseFrontmatter(content);
  if (!templateish(fm.data)) {
    throw new Error(
      `not a template (frontmatter needs name + integer version)${path ? `: ${path}` : ''}`
    );
  }
  const fieldEntries: [string, FieldSpec][] = [];
  if (fm.data.fields !== undefined && fm.data.fields !== null) {
    if (typeof fm.data.fields !== 'object' || Array.isArray(fm.data.fields)) {
      throw new Error(`template fields must be a map${path ? `: ${path}` : ''}`);
    }
    for (const [key, spec] of Object.entries(fm.data.fields)) {
      const parsed = fieldSpecSchema.safeParse(spec ?? {});
      if (!parsed.success) {
        throw new Error(`template field '${key}' is malformed${path ? `: ${path}` : ''}`);
      }
      fieldEntries.push([key, parsed.data]);
    }
  }
  const fields = Object.fromEntries(fieldEntries);
  const doc = parseContent(content);
  return {
    name: fm.data.name as string,
    version: Number.parseInt(String(fm.data.version), 10),
    fields,
    body: fm.body,
    sections: doc.sections,
    frontmatter: fm.data,
    path,
  };
}

export interface Registry {
  templates: Template[];
  /** exact `name@version`, else bare `name` → highest version */
  resolve(ref: string | TemplateRef): Template | undefined;
  /** highest registered version of `name`, or undefined */
  latestVersion(name: string): number | undefined;
}

export function resolveTemplate(
  registry: Registry,
  ref: string | TemplateRef
): Template | undefined {
  return registry.resolve(ref);
}

const mdFiles = (dir: string): string[] => {
  let out: string[] = [];
  let entries: Dirent[];
  try {
    entries = ioReadDir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out = out.concat(mdFiles(p));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
};

/** Scan `dirs` (recursive `*.md` with template frontmatter) plus
 *  `<cwd>/.brose/templates/` auto-prepended when present. */
export function createRegistry(opts: { dirs?: string[]; cwd?: string } = {}): Registry {
  const dirs = [...(opts.dirs ?? [])];
  const projectDir = join(opts.cwd ?? process.cwd(), '.brose', 'templates');
  if (ioExists(projectDir)) {
    dirs.unshift(projectDir);
  }
  const byRef = new Map<string, Template>();
  const templates: Template[] = [];
  for (const dir of dirs) {
    for (const path of mdFiles(dir)) {
      let t: Template;
      try {
        const content = ioRead(path);
        if (!templateish(parseFrontmatter(content).data)) {
          continue;
        }
        // a malformed template (bad `fields:`…) is skipped like a
        // non-template — one bad file must not sink the whole registry.
        t = parseTemplate(content, path);
      } catch {
        continue;
      }
      if (byRef.has(`${t.name}@${t.version}`)) {
        continue;
      }
      byRef.set(`${t.name}@${t.version}`, t);
      templates.push(t);
    }
  }
  return {
    templates,
    resolve(ref) {
      const { name, version } = typeof ref === 'string' ? parseTemplateRef(ref) : ref;
      if (version !== undefined) {
        return byRef.get(`${name}@${version}`);
      }
      const latest = this.latestVersion(name);
      return latest === undefined ? undefined : byRef.get(`${name}@${latest}`);
    },
    latestVersion(name) {
      let max: number | undefined;
      for (const t of templates) {
        if (t.name === name && (max === undefined || t.version > max)) {
          max = t.version;
        }
      }
      return max;
    },
  };
}
