/**
 * The spec specialization — `*.spec.md` docs, `<dirname>.spec.md`
 * dir-docs with `spec.md`/`README.md` legacy indexes, `id`/`parent`
 * fields, the shipped `brotocol/spec@N` template, KEY-N ids and the
 * draft|active|deprecated|removed lifecycle. `bro spec` builds on this.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, Protocol } from './protocol.ts';
import { scan } from './scan.ts';

export const specLifecycle = ['draft', 'active', 'deprecated', 'removed'] as const;
export type SpecStatus = (typeof specLifecycle)[number];

export const specFields = [
  'template',
  'id',
  'title',
  'status',
  'area',
  'owns',
  'aliases',
  'parent',
  'superseded-by',
] as const;

/** `^[A-Z]+-\d+$` — BRO-1, FEAT-12. */
export const keynRe = /^[A-Z]+-\d+$/;

/** The package's shipped templates dir — `templates/` sits beside both
 *  `src/` (dev) and `dist/` (published). */
export const specTemplateDir = fileURLToPath(new URL('../templates', import.meta.url));

export function specProtocol(opts: { dir: string }): Protocol {
  const templateDirs = [specTemplateDir];
  const project = join(opts.dir, '.brose', 'templates');
  if (existsSync(project)) {
    templateDirs.push(project);
  }
  return {
    root: opts.dir,
    docGlob: '**/*.spec.md',
    indexName: dirname => `${dirname}.spec.md`,
    indexAliases: ['spec.md', 'README.md'],
    idField: 'id',
    parentField: 'parent',
    templateDirs,
  };
}

/** Spec-protocol invariants beyond generic `lint`: lifecycle status,
 *  a declared `template:`, and KEY-N identity. */
export function lintSpec(protocol: Protocol): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of scan(protocol)) {
    const status = d.frontmatter.status;
    if (status !== undefined && !(specLifecycle as readonly unknown[]).includes(status)) {
      out.push({
        severity: 'error',
        rule: 'status-not-lifecycle',
        message: `status '${String(status)}' is not one of ${specLifecycle.join(', ')}`,
        path: d.path,
        line: 1,
      });
    }
    if (d.frontmatter.template === undefined) {
      out.push({
        severity: 'warn',
        rule: 'template-missing',
        message: "doc declares no 'template:' field",
        path: d.path,
        line: 1,
      });
    }
    if (!keynRe.test(d.id)) {
      out.push({
        severity: 'warn',
        rule: 'id-not-keyn',
        message: `id '${d.id}' is not a KEY-N id`,
        path: d.path,
        line: 1,
      });
    }
  }
  return out;
}
