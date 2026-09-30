import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import css from '../styles.css?url'

export const Route = createFileRoute('/debt')({
  head: () => ({ links: [{ rel: 'stylesheet', href: css }] }),
  component: DebtDashboard,
})

const GITHUB = 'https://github.com/ThePlenkov/bro'
const BASE_URL = import.meta.env.BASE_URL
const DOCS = `${BASE_URL}docs`

// bro keeps its own review-debt ledger on refs/bro/data — a data ref, not
// a branch, so it never shows up in MR diffs. The page resolves the ref
// tip through the git API, then reads the artifacts by sha off
// raw.githubusercontent (which serves any commit, not just heads).
const REF_API = 'https://api.github.com/repos/ThePlenkov/bro/git/ref/bro/data'
const RAW = 'https://raw.githubusercontent.com/ThePlenkov/bro'
const SUMMARY_PATH = '.agents/review-debt/debt-summary.json'
const LEDGER_PATH = '.agents/review-debt/ledger.jsonl'

interface Summary {
  generated_at: string
  open_count: number
  by_area: Record<string, number>
  by_author: Record<string, number>
  duplicate_fingerprints: string[]
  oldest_open: string | null
}

interface Row {
  thread_id: string
  status: string
  fix_pr: number | null
  fixed_at: string | null
  notes: string | null
}

interface Data {
  summary: Summary
  rows: Row[]
}

async function load(): Promise<Data> {
  const ref = (await (await fetch(REF_API)).json()) as { object?: { sha?: string } }
  const sha = ref.object?.sha
  if (!sha) {
    throw new Error('refs/bro/data not found — is the debt sync running?')
  }
  const [summary, ledgerText] = await Promise.all([
    fetch(`${RAW}/${sha}/${SUMMARY_PATH}`).then((r) => {
      if (!r.ok) throw new Error(`summary fetch: ${r.status}`)
      return r.json() as Promise<Summary>
    }),
    fetch(`${RAW}/${sha}/${LEDGER_PATH}`).then((r) => {
      if (!r.ok) throw new Error(`ledger fetch: ${r.status}`)
      return r.text()
    }),
  ])
  const rows = ledgerText
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Row)
  return { summary, rows }
}

const STATUS_ORDER = ['open', 'claimed', 'done', 'wontfix', 'duplicate']

function DebtDashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load().then(setData, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const counts: Record<string, number> = {}
  for (const r of data?.rows ?? []) {
    counts[r.status] = (counts[r.status] ?? 0) + 1
  }
  const total = data?.rows.length ?? 0
  const recent = (data?.rows ?? [])
    .filter((r) => r.status === 'done' && r.fix_pr !== null)
    .sort((a, b) => (b.fixed_at ?? '').localeCompare(a.fixed_at ?? ''))
    .slice(0, 10)

  return (
    <>
      <header className="nav">
        <a className="logo" href={BASE_URL}>
          bro <span aria-hidden="true">🤝</span>
        </a>
        <nav>
          <a href={DOCS}>docs</a>
          <a href={GITHUB}>github</a>
        </nav>
      </header>

      <main>
        <section className="hero">
          <p className="kicker">bro keeps books on itself</p>
          <h1>
            Review debt, <em>live</em>.
          </h1>
          <p className="lede">
            This is bro's own ledger — every unresolved review thread a merged PR left behind, fetched straight
            from <code>refs/bro/data</code> on {GITHUB.replace('https://', '')}. No database, no backend: git is
            the store, this page is the view.
          </p>
        </section>

        {error !== null && (
          <section className="debt-empty">
            <p>⚠ {error}</p>
          </section>
        )}
        {data === null && error === null && (
          <section className="debt-empty">
            <p>fetching the ledger…</p>
          </section>
        )}

        {data !== null && (
          <>
            <section className="debt-grid">
              <div className="stat">
                <span className="stat-n">{data.summary.open_count}</span>
                <span className="stat-l">open findings</span>
              </div>
              <div className="stat">
                <span className="stat-n">{total}</span>
                <span className="stat-l">ledger rows</span>
              </div>
              <div className="stat">
                <span className="stat-n">{total === 0 ? '—' : `${Math.round(((counts.done ?? 0) / total) * 100)}%`}</span>
                <span className="stat-l">resolved</span>
              </div>
              <div className="stat">
                <span className="stat-n">
                  {new Date(data.summary.generated_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
                <span className="stat-l">last sync {new Date(data.summary.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </section>

            <section className="debt-cols">
              <div>
                <h2>By status</h2>
                <table className="debt-table">
                  <tbody>
                    {STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
                      <tr key={s}>
                        <td>{s}</td>
                        <td className="num">{counts[s]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h2>By area</h2>
                {Object.keys(data.summary.by_area).length === 0 ? (
                  <p className="debt-note">no open findings — areas show up when the ledger owes</p>
                ) : (
                  <table className="debt-table">
                    <tbody>
                      {Object.entries(data.summary.by_area).map(([area, n]) => (
                        <tr key={area}>
                          <td>{area}</td>
                          <td className="num">{n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <h2>By reviewer</h2>
                {Object.keys(data.summary.by_author).length === 0 ? (
                  <p className="debt-note">empty when nothing is open</p>
                ) : (
                  <table className="debt-table">
                    <tbody>
                      {Object.entries(data.summary.by_author).map(([a, n]) => (
                        <tr key={a}>
                          <td>{a}</td>
                          <td className="num">{n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section>
              <h2>Latest closed debt</h2>
              <table className="debt-table">
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.thread_id}>
                      <td>
                        <a href={`${GITHUB}/pull/${r.fix_pr}`}>#{r.fix_pr}</a>
                      </td>
                      <td>{r.fixed_at?.slice(0, 10)}</td>
                      <td className="debt-note">{r.notes ?? '—'}</td>
                    </tr>
                  ))}
                  {recent.length === 0 && (
                    <tr>
                      <td className="debt-note">nothing closed yet — the ledger just started</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>

      <footer className="foot">
        <p>bro doesn't fix your code. bro makes sure it gets fixed.</p>
        <p className="links">
          <a href={GITHUB}>github</a> · <a href="https://www.npmjs.com/package/@broject/bro">npm</a> ·{' '}
          <a href={DOCS}>docs</a> · MIT
        </p>
      </footer>
    </>
  )
}
