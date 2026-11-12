/**
 * Lint — tree-level diagnostics: duplicate ids, dangling parents,
 * cycles, missing id fields, plus a brose `validate` of every doc that
 * declares `template:` against the protocol's template dirs.
 */
import { createRegistry, validate } from '@broject/brose';
import { graph } from './graph.ts';
import type { Diagnostic, Protocol } from './protocol.ts';
import { scan } from './scan.ts';

export function lint(protocol: Protocol): Diagnostic[] {
  const docs = scan(protocol);
  const out: Diagnostic[] = [];

  const seen = new Map<string, string>();
  for (const d of docs) {
    const first = seen.get(d.id);
    if (first !== undefined) {
      out.push({
        severity: 'error',
        rule: 'duplicate-id',
        message: `id '${d.id}' also used by ${first}`,
        path: d.path,
        line: 1,
      });
    } else {
      seen.set(d.id, d.path);
    }
    if (!Object.hasOwn(d.frontmatter, protocol.idField)) {
      out.push({
        severity: 'warn',
        rule: 'id-missing',
        message: `no '${protocol.idField}' field — id '${d.id}' derived from the name`,
        path: d.path,
        line: 1,
      });
    }
  }

  // same snapshot for the graph checks — a second scan could see a
  // different tree (and different Doc identities) than `docs`.
  const g = graph(protocol, docs);
  out.push(...g.diagnostics);

  // a non-string `template:` is a malformed binding, not "no binding"
  // — it must surface instead of silently skipping validation.
  for (const d of docs) {
    const t = d.frontmatter.template;
    if (t !== undefined && typeof t !== 'string') {
      out.push({
        severity: 'error',
        rule: 'template-malformed',
        message: `'template' must be a string ref like 'name@version', got ${Array.isArray(t) ? 'a list' : typeof t}`,
        path: d.path,
        line: 1,
      });
    }
  }

  const templated = docs.filter(d => typeof d.frontmatter.template === 'string');
  if (templated.length > 0) {
    const registry = createRegistry({ dirs: protocol.templateDirs, cwd: protocol.root });
    for (const d of templated) {
      out.push(...validate(d.path, { registry }));
    }
  }
  return out;
}
