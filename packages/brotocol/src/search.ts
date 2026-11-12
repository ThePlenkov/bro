/**
 * Search — filter docs by frontmatter field equality plus a `text`
 * substring over id + title (the `title` field, else the first
 * heading). A list-typed field matches by membership.
 */
import { flatSections, parseFile } from '@broject/brose';
import type { Doc, Protocol } from './protocol.ts';
import { scan } from './scan.ts';

export interface Query {
  /** substring over id + title */
  text?: string;
  [field: string]: unknown;
}

const titleOf = (doc: Doc): string => {
  const t = doc.frontmatter.title;
  if (typeof t === 'string') {
    return t;
  }
  try {
    const h = flatSections(parseFile(doc.path).sections)[0];
    return h?.title ?? '';
  } catch {
    return '';
  }
};

const fieldMatch = (value: unknown, want: unknown): boolean =>
  Array.isArray(value) ? value.some(v => v === want) : value === want;

export function search(protocol: Protocol, query: Query): Doc[] {
  const { text, ...fields } = query;
  const needle = text?.toLowerCase();
  return scan(protocol).filter(doc => {
    for (const [k, want] of Object.entries(fields)) {
      // getOwnPropertyDescriptor is the injection-safe keyed read —
      // `frontmatter[k]` on a query key like `__proto__` would reach
      // the prototype chain.
      const value = Object.getOwnPropertyDescriptor(doc.frontmatter, k)?.value;
      if (!fieldMatch(value, want)) {
        return false;
      }
    }
    if (needle === undefined) {
      return true;
    }
    return `${doc.id} ${titleOf(doc)}`.toLowerCase().includes(needle);
  });
}
