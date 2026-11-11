/**
 * Parse — the section model. markdown-it's token stream carries heading
 * tokens with `map` line ranges, so fenced code blocks and inline `#`
 * are handled correctly where a heading regex would get them wrong.
 * md→tokens only: brose never serializes a doc, which keeps future
 * splice-preserving edits byte-stable where untouched.
 */
import { ioExists, ioRead } from './io.ts';
import MarkdownIt from 'markdown-it';
import { parseFrontmatter } from './frontmatter.ts';

const md = new MarkdownIt();

/** One heading and the section it heads. `line`/`endLine` are 0-based
 *  source lines; `endLine` is exclusive (the next sibling-or-shallower
 *  heading's line, or the doc's last line). */
export interface SectionNode {
  title: string;
  /** heading depth — 1 for `#`, 2 for `##`, … */
  level: number;
  /** 0-based line of the heading itself */
  line: number;
  /** 0-based exclusive end of the section's content */
  endLine: number;
  children: SectionNode[];
}

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  /** 1-based source line of each top-level frontmatter key */
  keyLines: Map<string, number>;
  sections: SectionNode[];
  /** the doc with the frontmatter block stripped */
  body: string;
  /** 0-based line where `body` begins in the source */
  bodyOffset: number;
  path?: string;
}

/** Pre-order flatten — document order, parents before children. */
export const flatSections = (sections: SectionNode[]): SectionNode[] =>
  sections.flatMap(s => [s, ...flatSections(s.children)]);

function sectionTree(body: string, bodyOffset: number): SectionNode[] {
  const tokens = md.parse(body, {});
  const total = bodyOffset + body.split('\n').length;
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  for (const [i, tok] of tokens.entries()) {
    if (tok.type !== 'heading_open') {
      continue;
    }
    const inline = tokens[i + 1];
    const node: SectionNode = {
      title: inline?.type === 'inline' ? inline.content.trim() : '',
      level: Number.parseInt(tok.tag.slice(1), 10),
      line: (tok.map?.[0] ?? 0) + bodyOffset,
      endLine: total,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) {
      stack.pop()!.endLine = node.line;
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/** `parse(file|content)` — a `{path}` or `{content}` object is explicit;
 *  a bare string is a path when it names an existing file and carries no
 *  newline, content otherwise. */
export function parse(input: string | { path: string } | { content: string }): ParsedDoc {
  if (typeof input === 'object' && 'path' in input) {
    return parseFile(input.path);
  }
  if (typeof input === 'object') {
    return parseContent(input.content);
  }
  if (!input.includes('\n') && ioExists(input)) {
    return parseFile(input);
  }
  return parseContent(input);
}

export function parseFile(path: string): ParsedDoc {
  return { ...parseContent(ioRead(path)), path };
}

export function parseContent(content: string): ParsedDoc {
  const fm = parseFrontmatter(content);
  return {
    frontmatter: fm.data,
    keyLines: fm.keyLines,
    sections: sectionTree(fm.body, fm.bodyOffset),
    body: fm.body,
    bodyOffset: fm.bodyOffset,
  };
}
