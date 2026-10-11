/**
 * The `<!-- bro: {...} -->` task-metadata trailer — a cross-backend
 * contract (specs bro-huy5o.1, bro-huy5o.2). Task backends without
 * native type/priority/external-ref fields (GitHub Issues, Linear)
 * carry them in a JSON comment appended to the human-written body.
 * One implementation lives here so a row created on one backend parses
 * identically on another.
 */

const META_INNER = /^\s*bro:\s*(\{[\s\S]*\})\s*$/

/** The `<!-- bro: {...} -->` trailer's JSON + span — located by comment
 *  delimiters, not a body-wide regex. A `/<!--\s*bro:...-->/` pattern
 *  re-scans the body at every `<!--` start position, which is quadratic
 *  on hostile bodies (CodeQL polynomial-regex). indexOf + an anchored
 *  inner check keeps each comment span parsed once — linear total.
 *  Position is part of the contract: the trailer is the body's last
 *  element — own line, whitespace only after it (the shape withMeta
 *  writes). A `bro:` comment mid-prose or mid-line is an example, not
 *  metadata — bodyMeta ignores it and stripMeta keeps it in the
 *  description. */
export function broTrailer(body: string): { json: string; start: number; end: number } | null {
  let i = 0
  let last: { json: string; start: number; end: number } | null = null
  for (;;) {
    const s = body.indexOf('<!--', i)
    if (s === -1) {
      break
    }
    const e = body.indexOf('-->', s + 4)
    if (e === -1) {
      break
    }
    const m = META_INNER.exec(body.slice(s + 4, e))
    if (m && (s === 0 || body[s - 1] === '\n')) {
      last = { json: m[1]!, start: s, end: e + 3 }
    }
    i = e + 3
  }
  return last !== null && body.slice(last.end).trim() === '' ? last : null
}

/** The `<!-- bro: {...} -->` body trailer — type/priority/external_ref
 *  the backend has no fields for. Malformed JSON degrades to absent. */
export function bodyMeta(body: string | undefined): Record<string, unknown> {
  const t = broTrailer(body ?? '')
  if (t === null) {
    return {}
  }
  try {
    const v: unknown = JSON.parse(t.json)
    // arrays are objects too — named keys on them don't survive
    // JSON.stringify, so `[]` would silently eat the next update
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Body without the bro trailer — description is the human text. */
export const stripMeta = (body = ''): string => {
  const t = broTrailer(body)
  return (t === null ? body : body.slice(0, t.start) + body.slice(t.end)).trimEnd()
}

/** Rebuild the body with a fresh metadata trailer — preserves any text
 *  the caller didn't touch. */
export function withMeta(body: string | undefined, meta: Record<string, unknown>): string {
  const base = stripMeta(body)
  if (Object.keys(meta).length === 0) {
    return base
  }
  const trailer = `<!-- bro: ${JSON.stringify(meta)} -->`
  return base === '' ? trailer : `${base}\n\n${trailer}`
}
