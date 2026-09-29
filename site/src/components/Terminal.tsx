import { useEffect, useState } from 'react'
import { type Line, scenarios } from '../scenarios'

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
  const [active, setActive] = useState(0)
  const [shown, setShown] = useState(scenarios[0].lines.length)
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const [animate, setAnimate] = useState(false)

  const lines = scenarios[active].lines

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
        setActive((a) => (a + 1) % scenarios.length)
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

  const select = (i: number) => {
    setActive(i)
    setTyped(undefined)
    setShown(animate ? 0 : scenarios[i].lines.length)
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
      <div className="term-tabs" role="tablist">
        {scenarios.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={i === active ? 'on' : ''}
            onClick={() => select(i)}
          >
            {s.tab}
          </button>
        ))}
      </div>
      <div className="term-body" role="tabpanel">
        {lines.slice(0, shown).map((l, i) => (
          <TermLine key={`${active}-${i}`} line={l} />
        ))}
        {typed !== undefined && pending && <TermLine line={pending} typed={typed} />}
        {typed === undefined && shown < lines.length && <span className="cursor idle">▋</span>}
      </div>
    </div>
  )
}
