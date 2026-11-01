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
const SNAPSHOT_KEY = 'bro:debt:snapshot:v1'

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

interface CachedSnapshot {
  fetched_at: string
  sha: string
  summary: Summary
  rows: Row[]
  findings: Finding[]
}

type LoadError =
  | { kind: 'rate_limited'; status: number; retryAfter?: string | null; message: string }
  | { kind: 'ref_missing'; message: string }
  | { kind: 'summary_failed'; message: string }
  | { kind: 'unknown'; message: string }

function isRateLimitedStatus(status: number) {
  return status === 403 || status === 429
}

function getRateLimitHeaders(res: Response) {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  const retryAfter = res.headers.get('retry-after')
  return { remaining, reset, retryAfter }
}

function readSnapshot(): CachedSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CachedSnapshot
  } catch {
    return null
  }
}

function writeSnapshot(snapshot: CachedSnapshot) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // ignore quota/errors
  }
}

function formatAge(iso: string): string {
  try {
    const ts = Date.parse(iso)
    if (Number.isNaN(ts)) return 'unknown age'
    const diffMs = Date.now() - ts
    if (diffMs < 0) return 'just now'
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    const date = new Date(ts)
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return 'unknown age'
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
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
    .sort((a, b) => a.localeCompare(b))
    .slice(-HARVEST_FETCH)
  const texts = await Promise.all(
    paths.map((p) => fetch(`${RAW}/${sha}/${p}`).then((r) => (r.ok ? r.text() : '')))
  )
  return texts.flatMap((t) => parseJsonl<Finding>(t))
}

async function load(): Promise<{ data: Data; source: 'live' | 'cache'; fetchedAt: string; sha?: string }> {
  let refRes: Response
  try {
    refRes = await fetch(REF_API)
  } catch (err) {
    const cached = readSnapshot()
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    throw { kind: 'unknown', message: err instanceof Error ? err.message : String(err) } satisfies LoadError
  }

  if (isRateLimitedStatus(refRes.status)) {
    const cached = readSnapshot()
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    const { retryAfter } = getRateLimitHeaders(refRes)
    throw {
      kind: 'rate_limited',
      status: refRes.status,
      retryAfter,
      message: retryAfter ? `GitHub API rate limit reached (HTTP ${refRes.status}); retry after ${retryAfter}s.` : `GitHub API rate limit reached (HTTP ${refRes.status}).`,
    } satisfies LoadError
  }

  if (!refRes.ok) {
    const cached = readSnapshot()
    if (cached && refRes.status === 404) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    throw { kind: refRes.status === 404 ? 'ref_missing' : 'unknown', message: `Failed to resolve bro/data ref (HTTP ${refRes.status}).` } satisfies LoadError
  }

  let refJson: any
  try {
    refJson = await refRes.json()
  } catch (err) {
    const cached = readSnapshot()
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    throw { kind: 'unknown', message: err instanceof Error ? err.message : String(err) } satisfies LoadError
  }

  const sha = refJson?.object?.sha
  if (!sha) {
    const cached = readSnapshot()
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    throw { kind: 'ref_missing', message: 'data ref not found' } satisfies LoadError
  }

  try {
    const [summary, ledgerRes, findings] = await Promise.all([
      fetch(`${RAW}/${sha}/${SUMMARY_PATH}`).then((r) => {
        if (!r.ok) throw { kind: 'summary_failed', message: `summary fetch failed (HTTP ${r.status})` } satisfies LoadError
        return r.json() as Promise<Summary>
      }),
      // the status overlay is optional — a fresh ledger may not exist yet;
      // a 404 means "no rows", not a broken dashboard
      fetch(`${RAW}/${sha}/${LEDGER_PATH}`).then((r) => (r.ok ? r.text() : '')),
      fetchHarvests(sha).catch(() => []), // harvests missing ≠ broken dashboard
    ])
    const data: Data = { summary, rows: parseJsonl<Row>(ledgerRes), findings }
    const fetchedAt = new Date().toISOString()
    writeSnapshot({ fetched_at: fetchedAt, sha, summary, rows: data.rows, findings: data.findings })
    return { data, source: 'live', fetchedAt, sha }
  } catch (err) {
    if ((err as LoadError)?.kind) {
      const cached = readSnapshot()
      if (cached) {
        return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
      }
      throw err
    }
    const cached = readSnapshot()
    if (cached) {
      return { data: { summary: cached.summary, rows: cached.rows, findings: cached.findings }, source: 'cache', fetchedAt: cached.fetched_at, sha: cached.sha }
    }
    throw err
  }
}

const STATUS_ORDER = ['open', 'claimed', 'done', 'wontfix', 'duplicate']

function DebtDashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<LoadError['kind'] | null>(null)
  const [retryAfter, setRetryAfter] = useState<string | null>(null)
  const [source, setSource] = useState<'live' | 'cache' | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [sha, setSha] = useState<string | undefined>(undefined)

  useEffect(() => {
    load().then(
      (res) => {
        setData(res.data)
        setSource(res.source)
        setFetchedAt(res.fetchedAt)
        setSha(res.sha)
        setError(null)
        setErrorKind(null)
        setRetryAfter(null)
      },
      (err: unknown) => {
        console.error('debt dashboard:', err)
        if (err && typeof err === 'object' && 'kind' in err) {
          const e = err as LoadError
          setErrorKind(e.kind)
          if (e.kind === 'rate_limited') {
            setRetryAfter(e.retryAfter ?? null)
            setError(e.message)
          } else if (e.kind === 'ref_missing') {
            setError('data ref not found — the review-debt snapshot may not be published yet.')
          } else if (e.kind === 'summary_failed') {
            setError('summary fetch failed — could not load the latest review-debt summary.')
          } else {
            setError('could not load the ledger — check the console for details')
          }
        } else if (err instanceof Error) {
          setErrorKind('unknown')
          setError(err.message === 'data ref not found' ? 'data ref not found — the review-debt snapshot may not be published yet.' : 'could not load the ledger — check the console for details')
        } else {
          setErrorKind('unknown')
          setError('could not load the ledger — check the console for details')
        }
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
            <p>
              ⚠ {error}
              {errorKind === 'rate_limited' && (
                <>
                  {' '}
                  <a href="https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api">GitHub rate limits</a> apply to unauthenticated requests.
                </>
              )}
            </p>
          </section>
        )}
        {source === 'cache' && data !== null && (
          <section className="debt-empty">
            <p>
              Showing last available snapshot{fetchedAt ? ` from ${formatDateTime(fetchedAt)} (${formatAge(fetchedAt)})` : ''}.
              {sha ? (
                <>
                  {' '}Saved snapshot is pinned to commit{' '}
                  <a href={`${GITHUB}/commit/${sha}`}>
                    <code>{sha.slice(0, 7)}</code>
                  </a>
                  .
                </>
              ) : null}{' '}
              Live data may be temporarily unavailable due to GitHub API limits.
            </p>
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
                <span className="stat-l">
                  last sync {new Date(data.summary.generated_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  {source === 'cache' && fetchedAt ? ` · snapshot ${formatAge(fetchedAt)}` : ''}
                </span>
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
          <a href={DOCS}>docs</a> · <a href={`${BASE_URL}debt`}>debt</a> · <a href={GITHUB}>github</a> ·{' '}
          <a href="https://www.npmjs.com/package/@broject/bro">npm</a> · MIT
        </p>
      </footer>
    </>
  )
}
