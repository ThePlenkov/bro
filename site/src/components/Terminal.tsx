import { useEffect, useState } from 'react'
import { groups, type Line } from '../scenarios'

const LINE_DELAY = 650
const TYPE_DELAY = 35
const HOLD = 4200

const glyph: Record<Line['kind'], string> = {
  user: '>',
  agent: '●',
  tool: '●',
  out: '└',
  hook: '└',
}

// autoplay walks every case in reading order: a group's cases, then the next group
const order = groups.flatMap((g, gi) => g.scenarios.map((_, si) => [gi, si] as const))

function TermLine({ line, typed }: { line: Line; typed?: string }) {
  const text = typed ?? line.text
  return (
    <div className={`tl tl-${line.kind}`}>
      <span className="tl-glyph">{glyph[line.kind]}</span>
      <span className="tl-text">
        {text}
        {typed !== undefined && <span className="cursor">▋</span>}
      </span>
    </div>
  )
}

export function Terminal() {
  const [pos, setPos] = useState(0)
  const [gi, si] = order[pos]
  const group = groups[gi]
  const lines = group.scenarios[si].lines
  const [shown, setShown] = useState(lines.length)
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setAnimate(true)
      setShown(0)
    }
  }, [])

  useEffect(() => {
    if (!animate) return
    if (shown >= lines.length) {
      const t = setTimeout(() => {
        setPos((p) => (p + 1) % order.length)
        setShown(0)
      }, HOLD)
      return () => clearTimeout(t)
    }
    const next = lines[shown]
    if (next.kind === 'user') {
      const len = typed?.length ?? -1
      if (len < next.text.length) {
        const t = setTimeout(() => setTyped(next.text.slice(0, len + 1)), len < 0 ? LINE_DELAY : TYPE_DELAY)
        return () => clearTimeout(t)
      }
      const t = setTimeout(() => {
        setTyped(undefined)
        setShown((s) => s + 1)
      }, LINE_DELAY)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setShown((s) => s + 1), LINE_DELAY)
    return () => clearTimeout(t)
  }, [animate, shown, typed, lines])

  const select = (g: number, s: number) => {
    const p = order.findIndex(([a, b]) => a === g && b === s)
    setPos(p)
    setTyped(undefined)
    setShown(animate ? 0 : groups[g].scenarios[s].lines.length)
  }

  const pending = lines[shown]

  return (
    <div className="terminal">
      <div className="term-bar">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title">your agent · ~/app · bro plugin on</span>
      </div>
      <div className="term-groups" role="tablist" aria-label="use case groups">
        {groups.map((g, i) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={i === gi}
            className={i === gi ? 'on' : ''}
            onClick={() => select(i, 0)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="term-tabs" role="tablist" aria-label={`${group.label} use cases`}>
        {group.scenarios.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === si}
            className={i === si ? 'on' : ''}
            onClick={() => select(gi, i)}
          >
            {s.tab}
          </button>
        ))}
      </div>
      <p className="term-gist">{group.gist}</p>
      <div className="term-body" role="tabpanel">
        {lines.slice(0, shown).map((l, i) => (
          <TermLine key={`${pos}-${i}`} line={l} />
        ))}
        {typed !== undefined && pending && <TermLine line={pending} typed={typed} />}
        {typed === undefined && shown < lines.length && <span className="cursor idle">▋</span>}
      </div>
    </div>
  )
}
