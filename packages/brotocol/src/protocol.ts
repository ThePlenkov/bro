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

/** Byte-order path compare — `localeCompare` is host-locale dependent,
 *  so 'path-first' resolution would differ across machines. */
export const pathCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `**\/*.spec.md` → '.spec.md'; `???.md` → '.md'; `*` → ''. The suffix
 *  a doc filename carries — create names files `<id><suffix>`. Derived
 *  from the last wildcard of either kind so a `?`-only glob still
 *  yields its extension. */
export const docSuffix = (docGlob: string): string => {
  const base = docGlob.slice(docGlob.lastIndexOf('/') + 1);
  const wild = Math.max(base.lastIndexOf('*'), base.lastIndexOf('?'));
  return wild === -1 ? '' : base.slice(wild + 1);
};

/** Minimal glob matcher — no RegExp: `**` spans separators, `*`/`?`
 *  stay inside one path segment. Matched against the posix relative
 *  path, segment by segment, so a configured glob is data, never code. */
const segMatch = (pat: string, seg: string): boolean => {
  // `*`/`?` wildcards inside one path segment, anchored at both ends.
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = -1;
  while (si < seg.length) {
    const pc = pi < pat.length ? pat.charAt(pi) : '';
    if (pc === '?' || pc === seg.charAt(si)) {
      pi += 1;
      si += 1;
    } else if (pc === '*') {
      starP = pi;
      starS = si;
      pi += 1;
    } else if (starP !== -1) {
      pi = starP + 1;
      starS += 1;
      si = starS;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat.charAt(pi) === '*') {
    pi += 1;
  }
  return pi === pat.length;
};

export const globMatch = (glob: string, path: string): boolean => {
  const gs = glob.split('/');
  const ps = path.split('/');
  const match = (gi: number, pi: number): boolean => {
    if (gi === gs.length) {
      return pi === ps.length;
    }
    if (gs.at(gi) === '**') {
      for (let k = pi; k <= ps.length; k++) {
        if (match(gi + 1, k)) {
          return true;
        }
      }
      return false;
    }
    return pi < ps.length && segMatch(gs.at(gi) ?? '', ps.at(pi) ?? '') && match(gi + 1, pi + 1);
  };
  return match(0, 0);
};
