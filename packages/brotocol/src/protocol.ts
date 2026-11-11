/**
 * Protocol — the filetree contract: which files are docs, what makes a
 * directory a doc (index convention), which frontmatter fields carry
 * identity and parentage. Operations over it never re-derive these —
 * they read the Protocol record.
 */

export interface Protocol {
  /** tree root directory */
  root: string;
  /** glob for doc files, e.g. '**\/*.spec.md' */
  docGlob: string;
  /** dir-doc index convention — `<dirname>.spec.md` for the spec protocol */
  indexName?: (dirname: string) => string;
  /** legacy index basenames that also make a dir a doc ('spec.md', 'README.md') */
  indexAliases?: string[];
  /** frontmatter field holding the doc id, e.g. 'id' */
  idField: string;
  /** frontmatter field holding the parent id, e.g. 'parent' */
  parentField?: string;
  /** template lookup dirs for create/validate */
  templateDirs?: string[];
}

export type ParentEdge = 'frontmatter' | 'position' | 'none';

/** One doc in the tree. `path` is absolute; `parentId` is the declared
 *  parent — resolved against the tree by `graph`, not here. */
export interface Doc {
  id: string;
  path: string;
  parentId?: string;
  parentEdge: ParentEdge;
  frontmatter: Record<string, unknown>;
  isDirDoc: boolean;
}

export interface Diagnostic {
  severity: 'error' | 'warn';
  rule: string;
  message: string;
  path: string;
  /** 1-based source line */
  line: number;
}

/** `**\/*.spec.md` → '.spec.md'; `*.md` → '.md'; `*` → ''. The suffix a
 *  doc filename carries — create names files `<id><suffix>`. */
export const docSuffix = (docGlob: string): string => {
  const base = docGlob.slice(docGlob.lastIndexOf('/') + 1);
  const star = base.indexOf('*');
  return star === -1 ? '' : base.slice(star + 1);
};

/** Minimal glob → RegExp: `**` spans separators, `*`/`?` stay inside
 *  one path segment. Matched against the posix relative path. */
export const globRe = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
};
