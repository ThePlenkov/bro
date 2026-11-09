/**
 * The formula title patterns (bro-4cxnd).
 *
 * bd copies a formula step's title into the issue, with the formula's
 * `{{var}}`s interpolated — so the formula's pattern is matched with
 * each variable as a wildcard, against the poured step's title.
 *
 * The matcher is a string walk, not a regex: a regex over the pattern
 * is super-linear on hostile input (CodeQL), and a RegExp built from a
 * non-literal is a finding of its own (Codacy).
 */

/** A formula title pattern, split into its literal parts and its
 *  `{{var}}` wildcards. */
type TitleSegment = { kind: 'literal'; text: string } | { kind: 'wildcard' };

/** What the matcher walks — the pattern's segments and the title they
 *  are matched against. One context, so the title is not threaded down
 *  every step of the walk. */
interface TitleMatch {
  segments: TitleSegment[];
  title: string;
}

/** Is this segment a literal? */
function isLiteral(seg: TitleSegment): seg is { kind: 'literal'; text: string } {
  return seg.kind === 'literal';
}

/** Where a `{{var}}` ends in the pattern — the offset just past its
 *  `}}`, or -1 when the pattern holds no variable there. A name holds
 *  no `}`: `{{a}b}}` is no variable. */
function variableEnd(pattern: string, at: number): number {
  const close = pattern.indexOf('}}', at + 2);
  if (close < 0) return -1;
  if (pattern.slice(at + 2, close).includes('}')) return -1;
  return close + 2;
}

/** The pattern's segments — the literals and the wildcards. */
function titleSegments(pattern: string): TitleSegment[] {
  const segments: TitleSegment[] = [];
  let literal = '';
  let i = 0;
  while (i < pattern.length) {
    const end = pattern.startsWith('{{', i) ? variableEnd(pattern, i) : -1;
    if (end > 0) {
      segments.push({ kind: 'literal', text: literal });
      segments.push({ kind: 'wildcard' });
      literal = '';
      i = end;
      continue;
    }
    literal += pattern.charAt(i);
    i += 1;
  }
  segments.push({ kind: 'literal', text: literal });
  return segments;
}

/** The pattern's literal text — the parts that match themselves. */
function literalText(segments: TitleSegment[]): string {
  return segments.filter(isLiteral).map((seg) => seg.text).join('');
}

/** The literal at the pattern's edge — '' when the edge is a wildcard,
 *  for then the title's edge is free. */
function edgeText(seg: TitleSegment | undefined): string {
  if (seg === undefined) return '';
  return isLiteral(seg) ? seg.text : '';
}

/** The pattern's inner literals — the ones that must appear, in order,
 *  between the edges. */
function innerLiterals(m: TitleMatch): string[] {
  const head = m.segments[0];
  const tail = m.segments[m.segments.length - 1];
  const parts: string[] = [];
  for (const seg of m.segments) {
    if (!isLiteral(seg)) continue;
    if (seg === head || seg === tail) continue;
    if (seg.text === '') continue;
    parts.push(seg.text);
  }
  return parts;
}

/** Do the pattern's inner literals appear, in order, between the
 *  edges? */
function orderedInside(m: TitleMatch, from: number, to: number): boolean {
  let at = from;
  for (const text of innerLiterals(m)) {
    const found = m.title.indexOf(text, at);
    if (found < 0) return false;
    if (found + text.length > to) return false;
    at = found + text.length;
  }
  return true;
}

/** The anchored match — the pattern's edge literals hold the title's
 *  edges, and the inner literals must appear, in order, between them.
 *  The edges must not overlap: a title shorter than the two edges
 *  cannot carry both. */
function anchoredMatch(m: TitleMatch): boolean {
  const head = edgeText(m.segments[0]);
  const tail = edgeText(m.segments[m.segments.length - 1]);
  if (!m.title.startsWith(head) || !m.title.endsWith(tail)) return false;
  if (head.length + tail.length > m.title.length) return false;
  return orderedInside(m, head.length, m.title.length - tail.length);
}

/** Does the title match the pattern's segments? */
function segmentsMatch(m: TitleMatch): boolean {
  if (!m.segments.some((seg) => !isLiteral(seg))) {
    // no free part: the title is the pattern, exactly
    return m.title === literalText(m.segments);
  }
  return anchoredMatch(m);
}

/** A formula step's title against a poured step's title.
 *
 *  bd copies the formula's title into the issue, with the formula's
 *  `{{var}}`s interpolated — so the formula's pattern is matched with
 *  each variable as a wildcard. */
export function titleMatches(pattern: string, title: string): boolean {
  return segmentsMatch({ segments: titleSegments(pattern), title: title.trim() });
}
