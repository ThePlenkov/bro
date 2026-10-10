/**
 * GitHub webhook ingest — verify a delivery, map it onto the `github:*`
 * bus topic space, and wake PR consumers on matching events.
 * Spec: specs/bro-huy5o.7.md.
 *
 * The module owns GitHub semantics only: the HMAC check, the two body
 * encodings GitHub sends, and the event→EventInput projection. The HTTP
 * route lives in `bro serve`; the transport is whatever `publish` the
 * caller injects (the repo's bus socket in production).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  busSocketPath,
  busWake,
  type BusWake,
  type EventEnvelope,
  type EventInput,
  type EventPublishResult,
} from '@broject/core'

/** The env var arming webhook ingest — read per request so a test or a
 *  rotated secret needs no restart. argv/config would leak it (`ps`,
 *  committed files); an env var is the same-UID boundary serve.json
 *  already uses. */
export const GITHUB_WEBHOOK_SECRET_ENV = 'BRO_GITHUB_WEBHOOK_SECRET'

/** Topic namespace — `github:<x-github-event>`; a `github:*` glob
 *  subscribes to the whole source. */
export const GITHUB_TOPIC_PREFIX = 'github:'

// --- delivery plumbing ----------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined

const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined

const header1 = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

/** `X-Hub-Signature-256` is `sha256=<hex hmac over the raw body>`. A
 *  missing or malformed header fails the check, never the process. */
export function verifyGithubWebhook(
  secret: string,
  rawBody: string,
  signature: string | undefined
): boolean {
  if (!signature?.startsWith('sha256=')) {
    return false
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(signature.slice('sha256='.length), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Decode the delivery body. `application/json` is what
 *  `gh webhook forward` and JSON-configured hooks send;
 *  `application/x-www-form-urlencoded` is a repo webhook's DEFAULT —
 *  the payload rides a single `payload=` field. Anything else gets a
 *  bare JSON try: the signature check already vetted the bytes, so a
 *  parse failure here is a malformed delivery, not an attack. */
export function parseGithubWebhookBody(
  contentType: string | undefined,
  rawBody: string
): unknown {
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (ct === 'application/x-www-form-urlencoded') {
    const payload = new URLSearchParams(rawBody).get('payload')
    if (payload === null) {
      return undefined
    }
    try {
      return JSON.parse(payload) as unknown
    } catch {
      return undefined
    }
  }
  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    return undefined
  }
}

// --- event mapping ---------------------------------------------------------------

/** Every PR number the payload links, deduped. `pull_request*` events
 *  name theirs directly; `issue_comment` counts only when the issue is
 *  a PR (`issue.pull_request` present); check events carry a
 *  `pull_requests[]` linkage that is OFTEN EMPTY on branch pushes — an
 *  empty list is honest, not a bug. */
function payloadPrs(p: Record<string, unknown>): number[] {
  const prs = new Set<number>()
  const pull = obj(p['pull_request'])
  const direct = int(pull?.['number']) ?? int(p['number'])
  if (direct !== undefined) {
    prs.add(direct)
  }
  const issue = obj(p['issue'])
  if (issue !== undefined && obj(issue['pull_request']) !== undefined) {
    const n = int(issue['number'])
    if (n !== undefined) {
      prs.add(n)
    }
  }
  for (const key of ['check_run', 'check_suite'] as const) {
    const linked = obj(p[key])?.['pull_requests']
    if (Array.isArray(linked)) {
      for (const pr of linked) {
        const n = int(obj(pr)?.['number'])
        if (n !== undefined) {
          prs.add(n)
        }
      }
    }
  }
  return [...prs]
}

/** Delivery → EventInput on `github:<event>`: kind is the payload
 *  action (the verb consumers filter on), key a `pr-<n>`/`sha-<head>`
 *  identity, payload a bounded projection — raw deliveries are huge and
 *  the ring is byte-bounded, so only the fields a consumer needs to
 *  match and report cross the socket. Returns undefined when the event
 *  name or payload shape can't produce a routable event. */
export function githubWebhookEvent(
  event: string,
  delivery: string | undefined,
  payload: unknown
): EventInput | undefined {
  const p = obj(payload)
  if (event === '' || p === undefined) {
    return undefined
  }
  const prs = payloadPrs(p)
  const checkRun = obj(p['check_run'])
  const checkSuite = obj(p['check_suite'])
  const sha = str(checkRun?.['head_sha']) ?? str(checkSuite?.['head_sha'])
  const issue = obj(p['issue'])
  const issueIsPr = issue !== undefined && obj(issue['pull_request']) !== undefined
  const ref =
    str(obj(p['pull_request'])?.['html_url']) ??
    (issueIsPr ? str(issue?.['html_url']) : undefined) ??
    str(checkRun?.['html_url']) ??
    str(obj(p['repository'])?.['html_url'])
  const projection: Record<string, unknown> = {
    ...(str(obj(p['repository'])?.['full_name']) !== undefined
      ? { repo: str(obj(p['repository'])?.['full_name']) }
      : {}),
    ...(str(obj(p['sender'])?.['login']) !== undefined
      ? { sender: str(obj(p['sender'])?.['login']) }
      : {}),
    ...(delivery !== undefined && delivery !== '' ? { delivery } : {}),
    prs,
    ...(sha !== undefined ? { sha } : {}),
    ...(str(checkRun?.['name']) !== undefined ? { checkName: str(checkRun?.['name']) } : {}),
    ...(str(checkRun?.['conclusion']) !== undefined || str(checkSuite?.['conclusion']) !== undefined
      ? { conclusion: str(checkRun?.['conclusion']) ?? str(checkSuite?.['conclusion']) }
      : {}),
  }
  let key: string | undefined
  if (prs.length > 0) {
    key = `pr-${String(prs[0])}`
  } else if (sha !== undefined) {
    key = `sha-${sha.slice(0, 12)}`
  }
  return {
    topic: `${GITHUB_TOPIC_PREFIX}${event}`,
    kind: str(p['action']) ?? event,
    ...(key !== undefined ? { key } : {}),
    ...(ref !== undefined ? { ref } : {}),
    source: 'github',
    payload: projection,
  }
}

// --- consumer side ---------------------------------------------------------------

/** Does this `github:*` event concern PR `pr`? A delivery naming no PR
 *  at all still matches — a check_suite on the base branch carries no
 *  pull_requests link yet can still move the gate (BEHIND, required
 *  checks). Under-waking loses the latency the source exists for;
 *  over-waking costs one poll, which is the default behavior anyway. */
export function githubEventConcernsPr(
  event: Pick<EventEnvelope, 'topic' | 'payload'>,
  pr: number
): boolean {
  if (!event.topic.startsWith(GITHUB_TOPIC_PREFIX)) {
    return false
  }
  const prs = obj(event.payload)?.['prs']
  if (Array.isArray(prs) && prs.every((n) => typeof n === 'number')) {
    return prs.length === 0 || prs.includes(pr)
  }
  // a github: event without the projection (hand-published) still wakes
  return true
}

/** Arm the PR's wake-up: a `github:*` bus subscription distilled by
 *  `busWake` to `next()/close()`. Null outside a repo or with the
 *  broker down — the caller's timer stays the only poller. */
export function githubPrWake(dir: string, pr: number): Promise<BusWake | null> {
  const socketPath = busSocketPath(dir)
  if (socketPath === null) {
    return Promise.resolve(null)
  }
  return busWake(socketPath, { topics: [`${GITHUB_TOPIC_PREFIX}*`] }, (e) =>
    githubEventConcernsPr(e, pr)
  )
}

// --- serve route ------------------------------------------------------------------

export interface GithubWebhookRequest {
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

/** Route-local response — serve.ts's ServeResponse structurally, kept
 *  nameless here so the github package never imports the CLI. */
export interface GithubWebhookResponse {
  status: number
  body: unknown
}

export interface GithubWebhookDeps {
  /** The shared secret — undefined means ingest is not configured and
   *  the route refuses: fail-CLOSED, because a browser page can send a
   *  simple form POST to 127.0.0.1, so an unsigned path would let any
   *  local page inject forged bus events. */
  secret(): string | undefined
  publish(event: EventInput): Promise<EventPublishResult>
}

/** `POST /api/v1/webhooks/github` — signature first, everything else
 *  after: a caller without the secret learns nothing beyond "your
 *  signature is wrong". A verified delivery publishes and answers 202
 *  even when the broker is down (`published:false`) — the transport
 *  being absent is a routine state, not a rejected webhook. */
export function githubWebhookHandler(
  deps: GithubWebhookDeps
): (req: GithubWebhookRequest) => Promise<GithubWebhookResponse> {
  return async (req) => {
    const secret = deps.secret()
    if (secret === undefined || secret === '') {
      return {
        status: 503,
        body: { error: `github webhook ingest not configured — set ${GITHUB_WEBHOOK_SECRET_ENV}` },
      }
    }
    if (!verifyGithubWebhook(secret, req.rawBody, header1(req.headers['x-hub-signature-256']))) {
      return { status: 401, body: { error: 'bad or missing X-Hub-Signature-256' } }
    }
    const event = header1(req.headers['x-github-event'])
    if (event === undefined || event === '') {
      return { status: 400, body: { error: 'missing X-GitHub-Event' } }
    }
    const input = githubWebhookEvent(
      event,
      header1(req.headers['x-github-delivery']),
      parseGithubWebhookBody(header1(req.headers['content-type']), req.rawBody)
    )
    if (input === undefined) {
      return { status: 400, body: { error: 'unparseable webhook payload' } }
    }
    const res = await deps.publish(input)
    return {
      status: 202,
      body: {
        accepted: true,
        published: res.published,
        ...(res.seq !== undefined ? { seq: res.seq } : {}),
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
      },
    }
  }
}
