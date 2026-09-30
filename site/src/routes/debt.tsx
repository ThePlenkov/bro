import { useEffect, useMemo, useState } from 'react'
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
const TREE_API = 'https://api.github.com/repos/ThePlenkov/bro/git/trees'
const RAW = 'https://raw.githubusercontent.com/ThePlenkov/bro'
const SUMMARY_PATH = '.agents/review-debt/debt-summary.json'
const LEDGER_PATH = '.agents/review-debt/ledger.jsonl'
const HARVEST_PREFIX = '.agents/review-debt/harvests/'
// harvests/ holds one .jsonl per collect run — filenames sort by time;
// only the newest few are needed for the recent-findings table
const HARVEST_FETCH = 10

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

/** A harvested review finding — these land before any status verdict,
 *  so the dashboard needs them beyond the ledger's status overlay. */
interface Finding {
  thread_id: string
  thread_url?: string
  status: string
  priority?: string
  source_pr: number
  source_pr_title?: string
  path?: string
  line?: number
  author?: string
  body_preview?: string
  area?: string
  fingerprint?: string
  harvested_at?: string
}

interface Data {
  summary: Summary
  rows: Row[]
  findings: Finding[]
}

function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T]
      } catch {
        return [] // a malformed line drops that row, not the page
      }
    })
}

/** Newest harvest files under <sha> — the trees API lists paths, raw
 *  serves the content by sha (one repo, one dashboard: a handful of GETs). */
const isHarvestBlob = (e: { path: string; type: string }) =>
  e.type === 'blob' && e.path.startsWith(HARVEST_PREFIX) && e.path.endsWith('.jsonl')

async function fetchHarvests(sha: string): Promise<Finding[]> {
  const treeRes = await fetch(`${TREE_API}/${sha}?recursive=1`)
  if (!treeRes.ok) {
    return []
  }
  const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string }> }
  const paths = (tree.tree ?? [])
    .filter(isHarvestBlob)
    .map((e) => e.path)
    .sort()
    .slice(-HARVEST_FETCH)
  const texts = await Promise.all(
    paths.map((p) => fetch(`${RAW}/${sha}/${p}`).then((r) => (r.ok ? r.text() : '')))
  )
  return texts.flatMap((t) => parseJsonl<Finding>(t))
}

async function load(): Promise<Data> {
  const ref = (await (await fetch(REF_API)).json()) as { object?: { sha?: string } }
  const sha = ref.object?.sha
  if (!sha) {
    throw new Error('data ref not found')
  }
  const [summary, ledgerRes, findings] = await Promise.all([
    fetch(`${RAW}/${sha}/${SUMMARY_PATH}`).then((r) => {
      if (!r.ok) throw new Error('summary fetch failed')
      return r.json() as Promise<Summary>
    }),
    // the status overlay is optional — a fresh ledger may not exist yet;
    // a 404 means "no rows", not a broken dashboard
    fetch(`${RAW}/${sha}/${LEDGER_PATH}`).then((r) => (r.ok ? r.text() : '')),
    fetchHarvests(sha).catch(() => []), // harvests missing ≠ broken dashboard
  ])
  return { summary, rows: parseJsonl<Row>(ledgerRes), findings }
}

const STATUS_ORDER = ['open', 'claimed', 'done', 'wontfix', 'duplicate']

function DebtDashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load().then(
      setData,
      (err: unknown) => {
        console.error('debt dashboard:', err)
        setError('could not load the ledger — check the console for details')
      }
    )
  }, [])

  const { counts, total, recent } = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of data?.rows ?? []) {
      c[r.status] = (c[r.status] ?? 0) + 1
    }
    const closed = (data?.rows ?? [])
      .filter((r) => r.status !== 'open' && r.status !== 'claimed' && r.fix_pr !== null)
      .sort((a, b) => (b.fixed_at ?? '').localeCompare(a.fixed_at ?? ''))
      .slice(0, 10)
    return { counts: c, total: data?.rows.length ?? 0, recent: closed }
  }, [data])

  const openFindings = useMemo(() => {
    // findings with a closed ledger overlay are not open anymore —
    // and the same finding repeats across harvest runs, so dedupe
    const closedIds = new Set(
      (data?.rows ?? [])
        .filter((r) => r.status !== 'open' && r.status !== 'claimed')
        .map((r) => r.thread_id)
    )
    const seen = new Set<string>()
    const out: Finding[] = []
    for (const f of data?.findings ?? []) {
      if (f.status !== 'open' || closedIds.has(f.thread_id)) continue
      const key = f.fingerprint ?? f.thread_id
      if (seen.has(key)) continue
      seen.add(key)
      out.push(f)
    }
    out.sort((a, b) => (b.harvested_at ?? '').localeCompare(a.harvested_at ?? ''))
    return out.slice(0, 12)
  }, [data])

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
              <h2>Open findings</h2>
              {openFindings.length === 0 ? (
                <p className="debt-note">nothing owed — the ledger is clean</p>
              ) : (
                <table className="debt-table">
                  <tbody>
                    {openFindings.map((f) => (
                      <tr key={f.fingerprint ?? f.thread_id}>
                        <td>
                          {f.source_pr > 0 ? (
                            <a href={`${GITHUB}/pull/${f.source_pr}`}>#{f.source_pr}</a>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{f.priority ?? '—'}</td>
                        <td className="debt-note">
                          {f.path ?? ''}
                          {f.line ? `:${f.line}` : ''} — {f.body_preview ?? f.author ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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
                      <td>{r.status}</td>
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
