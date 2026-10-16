/** Conductor (spec bro-xeozo) — `/v1/*` answers from a configured
 * `providers.<name>` acp entry instead of an HTTP upstream. The model
 * is an agent: `devin acp` carries claude-class models through the
 * operator's existing devin auth — no Anthropic key in the loop.
 *
 *   BRO_PROVIDER_BACKEND=<name>   providers.<name> entry — must be
 *                                 `type: "acp"` (cli entries can't
 *                                 stream a session). Set = conductor;
 *                                 unset = the byte proxy keeps /v1.
 *   BRO_PROVIDER_MODEL=<id>       optional pin — wins over entry.model;
 *                                 the client's requested id is never
 *                                 trusted (provenance maps to served).
 *   BRO_PROVIDER_CATALOG=<name>   optional providers.<name> entry whose
 *                                 catalog answers GET /v1/models
 *                                 instead of the backend's — for
 *                                 tool-less backends (a summarizer
 *                                 advertises no model option) the
 *                                 catalog is what clients may pick.
 *                                 Any provider kind works (spec
 *                                 bro-wxfls).
 *   BRO_PROVIDER_TIMEOUT_MS       per-call deadline (default 120000).
 */

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { acpOpen, acpPooledTurn, acpSessionRetain, otelEvent, otelParent, otelSpan } from '@broject/providers'
import type { AcpContentBlock, AcpPeer, AcpRetainedSession, OtelCtx, ProviderWireOpts } from '@broject/providers'
import { peerAttrs } from './peer.ts'
import { catalogModels } from './providers.ts'

type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>

export interface ConductorConfig {
  backend: string
  entry: AcpEntry
  /** The /v1/models source — defaults to the backend itself; a
   *  BRO_PROVIDER_CATALOG pin points at a different providers entry
   *  (a tool-less backend advertises nothing, the catalog still can). */
  catalog?: { name: string; entry: ProviderEntry }
  model?: string
  cwd: string
  timeoutMs: number
}

/** BRO_PROVIDER_BACKEND resolves to the conductor's acp entry — a name
 *  no registry knows is a loud startup error naming what IS configured,
 *  never a silent fall back to the byte proxy. */
export function conductorConfig(
  env: NodeJS.ProcessEnv,
  dir: string,
  providers?: Record<string, ProviderEntry>
): ConductorConfig | undefined {
  const backend = env.BRO_PROVIDER_BACKEND?.trim()
  if (backend === undefined || backend === '') {
    return undefined
  }
  providers ??= (loadConfig(dir).providers ?? {}) as Record<string, ProviderEntry>
  const entry = providers[backend]
  if (entry === undefined) {
    throw new Error(
      `BRO_PROVIDER_BACKEND=${backend} — providers.${backend} is not configured ` +
        `(configured: ${Object.keys(providers).join(', ') || 'none'})`
    )
  }
  if (entry.type !== 'acp') {
    throw new Error(
      `providers.${backend} is type '${entry.type}' — the conductor needs an 'acp' entry ` +
        `(session-grade wire; cli entries spawn once, they don't converse)`
    )
  }
  const model = env.BRO_PROVIDER_MODEL?.trim()
  const t = Number(env.BRO_PROVIDER_TIMEOUT_MS)
  const catalogName = env.BRO_PROVIDER_CATALOG?.trim()
  let catalog: ConductorConfig['catalog']
  if (catalogName !== undefined && catalogName !== '') {
    const catalogEntry = providers[catalogName]
    if (catalogEntry === undefined) {
      throw new Error(
        `BRO_PROVIDER_CATALOG=${catalogName} — providers.${catalogName} is not configured ` +
          `(configured: ${Object.keys(providers).join(', ') || 'none'})`
      )
    }
    catalog = { name: catalogName, entry: catalogEntry }
  }
  return {
    backend,
    entry,
    catalog,
    model: model === undefined || model === '' ? entry.model : model,
    cwd: dir,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 120_000,
  }
}

// --- anthropic request shapes (the subset claude-code sends) ----------

interface TextBlock {
  type: 'text'
  text: string
}
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | { text?: string }[]
}
type InBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string }

interface ImageBlock {
  type: 'image'
  source?: { type?: string; media_type?: string; data?: string; url?: string }
}

interface MessagesRequest {
  model?: string
  system?: string | { text?: string }[]
  messages?: { role?: string; content?: string | InBlock[] }[]
  tools?: { name?: string; description?: string; input_schema?: unknown }[]
  stream?: boolean
}

// --- translation -----------------------------------------------------

function blockText(b: InBlock): string {
  if (b.type === 'text') return (b as TextBlock).text
  if (b.type === 'tool_use') {
    const t = b as ToolUseBlock
    return `<tool_call>${JSON.stringify({ name: t.name, input: t.input })}</tool_call>`
  }
  if (b.type === 'tool_result') {
    const r = b as ToolResultBlock
    const body =
      typeof r.content === 'string'
        ? r.content
        : (r.content ?? []).map((c) => c.text ?? '').join('')
    return `<tool_result for="${r.tool_use_id}">${body}</tool_result>`
  }
  return `[${b.type}]`
}

/** The tool contract — the agent's only way to answer tool_use. */
function toolContract(tools: NonNullable<MessagesRequest['tools']>): string {
  const defs = tools
    .filter((t) => typeof t.name === 'string')
    .map(
      (t) =>
        `- ${t.name}: ${t.description ?? ''} input_schema: ${JSON.stringify(t.input_schema ?? {})}`
    )
    .join('\n')
  return [
    '<tools>',
    'Call tools by emitting exactly, one per call:',
    '<tool_call>{"name":"<name>","input":{<args>}}</tool_call>',
    defs === '' ? 'No tools available.' : `Available tools:\n${defs}`,
    '</tools>',
  ].join('\n')
}

const turnRole = (m: { role?: string }): string =>
  m.role === 'assistant' ? 'assistant' : 'user'

type ClientMessage = NonNullable<MessagesRequest['messages']>[number]

/** One message's canonical serialization — shared by serializeRequest
 *  (the cold prompt) and the conversation-fingerprint hashes, so a
 *  resent byte-identical turn always matches. */
function serTurn(m: ClientMessage): string {
  const text =
    typeof m.content === 'string'
      ? m.content
      : (m.content ?? []).map(blockText).join('')
  return `<turn role="${turnRole(m)}">${text}</turn>`
}

/** system + tools — the transcript prefix shared by serializeRequest
 *  (one merged text block) and turnsToBlocks (its own leading block). */
function prefixText(body: MessagesRequest): string {
  const parts: string[] = []
  const system =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((s) => s.text ?? '').join('')
  if (system !== '') {
    parts.push(`<system>\n${system}\n</system>`)
  }
  if (body.tools !== undefined && body.tools.length > 0) {
    parts.push(toolContract(body.tools))
  }
  return parts.join('\n\n')
}

function serializeRequest(body: MessagesRequest): string {
  const parts = [prefixText(body)]
  for (const m of body.messages ?? []) {
    parts.push(serTurn(m))
  }
  return parts.filter((p) => p !== '').join('\n\n')
}

/** An inbound image block → ACP image content. Only base64 sources
 *  carry the payload ACP needs (`data` + `mimeType`) — url/file
 *  sources degrade to the `[image]` marker rather than a block the
 *  agent can't read. */
function acpImage(b: InBlock): AcpContentBlock | undefined {
  const s = (b as ImageBlock).source
  if (s?.type === 'base64' && s.data !== undefined && s.media_type !== undefined) {
    return { type: 'image', data: s.data, mimeType: s.media_type }
  }
  return undefined
}

/** The request as ACP content blocks — same transcript as
 *  serializeRequest, but when the agent advertised
 *  promptCapabilities.image the wire carries real image content;
 *  without the capability the request stays one text block with the
 *  `[image]` marker exactly as before (bro-7izjx). */
function serializeBlocks(body: MessagesRequest, imageOk: boolean): AcpContentBlock[] {
  return imageOk ? turnsToBlocks(body) : [{ type: 'text', text: serializeRequest(body) }]
}

/** The image-capable path: the prefix leads, then every turn is its
 *  own text block followed by that turn's image blocks. <turn> tags
 *  stay balanced inside a single text block (amazon-q #558) and
 *  source order holds. */
function turnsToBlocks(body: MessagesRequest): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  const prefix = prefixText(body)
  if (prefix !== '') {
    blocks.push({ type: 'text', text: prefix })
  }
  for (const m of body.messages ?? []) {
    const { text, imgs } = turnParts(m.content)
    blocks.push({ type: 'text', text: `<turn role="${turnRole(m)}">${text}</turn>` }, ...imgs)
  }
  return blocks
}

/** A turn's content → its serialized text (passed-through image
 *  blocks stripped) plus the mappable ACP image blocks, in source
 *  order. Unmappable images stay inline as `[image]`. */
function turnParts(
  content: string | InBlock[] | undefined
): { text: string; imgs: AcpContentBlock[] } {
  if (typeof content === 'string') {
    return { text: content, imgs: [] }
  }
  const imgs: AcpContentBlock[] = []
  const text = (content ?? [])
    .map((b) => {
      const img = b.type === 'image' ? acpImage(b) : undefined
      if (img === undefined) {
        return blockText(b)
      }
      imgs.push(img)
      return ''
    })
    .join('')
  return { text, imgs }
}

const TOOL_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

// --- conversation reuse (bro-whn25) ------------------------------------
//
// The Messages API is stateless but claude resends full history anyway:
// keep a retained acp session per conversation and feed ONLY the tail.
// Identity: explicit `x-bro-session` for clients that can send it, else
// a fingerprint of prefix+first turn. Correctness is never key-trusted —
// a candidate re-proves the consumed prefix byte-for-byte (hash over the
// first `consumed` serializations) before its tail is sliced, so an
// edited or replayed history falls back to a fresh session instead of
// poisoning a live one.

/** A live conversation: the retained session plus just enough client
 *  state to slice the next delta and to replay the last reply when a
 *  resent history carries nothing new. */
interface ConvSession {
  live: AcpRetainedSession
  peer: AcpPeer
  /** body.messages count fully accounted for — sent user turns AND
   *  assistant echoes the session already holds. */
  consumed: number
  /** sha256 over serTurn(messages[0..consumed-1]) — the prefix proof. */
  historyHash: string
  lastReply: { blocks: OutBlock[]; model: string; stopReason: string; inputTokens: number }
  busy: boolean
  lastSeen: number
}

const CONV_TTL_MS = 10 * 60_000
const CONV_CAP = 32

const hashTurns = (msgs: ClientMessage[], n: number): string =>
  createHash('sha256')
    .update(msgs.slice(0, n).map(serTurn).join('\n'))
    .digest('hex')

/** Where the conversation id comes from: an explicit `x-bro-session`
 *  wins (clients that can pin); the fingerprint is the birth
 *  certificate — prefix + first turn — stable across the whole
 *  conversation since clients prepend, never rewrite the start. */
function conversationKey(req: IncomingMessage, body: MessagesRequest): string | undefined {
  const hdr = req.headers['x-bro-session']
  const named = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim()
  if (named !== undefined && named !== '') {
    // client values ALWAYS land in the h: namespace — accepting a
    // client-supplied f: verbatim would let a caller inject into the
    // fingerprint namespace and collide with another conversation
    return `h:${named.slice(0, 200)}`
  }
  const first = body.messages?.[0]
  if (first === undefined) {
    return undefined
  }
  const fp = createHash('sha256')
    .update(`${prefixText(body)}\n${serTurn(first)}`)
    .digest('hex')
  return `f:${fp}`
}

/** Retired sessions must be disposed — a leaked session holds agent
 *  context (and its cost) for nothing. TTL first, then oldest-out to
 *  the cap; the overflow count is captured BEFORE the loop so a live
 *  `size` can't shrink the size-branch mid-iteration. The map is
 *  insertion-ordered and hits re-insert, so front-to-back IS
 *  least-recently-used — overflow evicts the coldest entries. */
function sweepSessions(sessions: Map<string, ConvSession>, now: number): void {
  let overflow = Math.max(0, sessions.size - CONV_CAP)
  for (const [k, s] of sessions) {
    if (now - s.lastSeen > CONV_TTL_MS || overflow-- > 0) {
      sessions.delete(k)
      try {
        s.live.dispose()
      } catch {
        // dead transport — the peer's own close reaps it anyway
      }
    }
  }
}

/** Every session the transport owns dies with it — clear the whole
 *  map so no stale handle is ever reused on a respawned child. */
function dropSessions(sessions: Map<string, ConvSession>): void {
  for (const s of sessions.values()) {
    try {
      s.live.dispose()
    } catch {
      // already dead — the drop is the point
    }
  }
  sessions.clear()
}

/** The turns a reused session has NOT seen: everything past the
 *  consumed boundary, minus assistant messages — those are echoes of
 *  the session's own replies, already in its context. A tail that is
 *  only echoes means a retry, and the replay path answers it. */
function tailTurns(msgs: ClientMessage[], consumed: number): ClientMessage[] {
  return msgs.slice(consumed).filter((m) => m.role !== 'assistant')
}

/** Serialize just the new turns — turnsToBlocks' per-turn shape minus
 *  the prefix (the session saw it on turn one). */
function tailBlocks(msgs: ClientMessage[], imageOk: boolean): AcpContentBlock[] {
  if (!imageOk) {
    return [{ type: 'text', text: msgs.map(serTurn).join('\n\n') }]
  }
  const out: AcpContentBlock[] = []
  for (const m of msgs) {
    const { text, imgs } = turnParts(m.content)
    out.push({ type: 'text', text: `<turn role="${turnRole(m)}">${text}</turn>` }, ...imgs)
  }
  return out
}

interface OutBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

/** Reply → ordered anthropic blocks: text segments stay text, each
 *  parseable <tool_call> becomes tool_use (unparseable JSON stays raw
 *  text — the wire never invents a call). */
export function parseReply(text: string): OutBlock[] {
  const out: OutBlock[] = []
  let at = 0
  for (const m of text.matchAll(TOOL_CALL)) {
    let parsed: { name?: unknown; input?: unknown } | undefined
    try {
      parsed = JSON.parse(m[1])
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || typeof parsed.name !== 'string') continue
    const lead = text.slice(at, m.index)
    if (lead.trim() !== '') out.push({ type: 'text', text: lead })
    const input =
      typeof parsed.input === 'object' && parsed.input !== null && !Array.isArray(parsed.input)
        ? (parsed.input as Record<string, unknown>)
        : parsed.input === undefined
          ? {}
          : { value: parsed.input }
    out.push({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name: parsed.name,
      input,
    })
    at = (m.index ?? 0) + m[0].length
  }
  const tail = text.slice(at)
  if (tail.trim() !== '') out.push({ type: 'text', text: tail })
  if (out.length === 0) out.push({ type: 'text', text: '' })
  return out
}

// --- response emission -------------------------------------------------

/** Anthropic stop_reasons only — acp reasons outside the enum map to the
 *  nearest honest one, never forwarded raw. */
const STOP_REASON: Record<string, string> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'pause_turn',
  refusal: 'refusal',
  cancelled: 'end_turn',
}

/** chars/4 underestimates CJK several-fold — count wide codepoints
 *  (~1 token each) against the ascii quarter-rate. Estimate only —
 *  never billing, never compaction. */
function estTokens(s: string): number {
  let units = 0
  for (const ch of s) units += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 4 : 1
  return Math.max(1, Math.ceil(units / 4))
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function emitBlocks(
  res: ServerResponse,
  blocks: OutBlock[],
  model: string,
  stopReason: string,
  inputTokens: number
): void {
  const msgId = `msg_${randomBytes(12).toString('hex')}`
  const outTokens = estTokens(JSON.stringify(blocks))
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
  blocks.forEach((b, i) => {
    if (b.type === 'tool_use') {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
      })
    } else {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: b.text },
      })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i })
  })
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outTokens },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
}

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  res.end(`${JSON.stringify({ type: 'error', error: { type, message } })}\n`)
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }
  return body
}

const AVAIL = /unavailable|timeout|timed out/i

/** text-char + image-wire token estimate — an image's true cost is
 *  dimension-based, not size-based; base64-length/4 is the rough wire
 *  proxy so usage reporting doesn't silently zero a large payload
 *  (amazon-q #558). */
function inputTokensOf(prompt: AcpContentBlock[]): number {
  return (
    estTokens(prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')) +
    prompt.reduce((n, b) => n + (b.type === 'image' ? Math.ceil(b.data.length / 4) : 0), 0)
  )
}

/** One settled reply → the wire, streamed or buffered. `x-bro-session`
 *  echoes ONLY an h: (client-pinned) key — echoing the internal f:
 *  fingerprint would let a client pin back into the fingerprint
 *  namespace it must never inject into. */
function respond(
  res: ServerResponse,
  body: MessagesRequest,
  blocks: OutBlock[],
  model: string,
  stopReason: string,
  inputTokens: number,
  sessionKey?: string
): void {
  const sessionHdr =
    sessionKey !== undefined && sessionKey.startsWith('h:')
      ? { 'x-bro-session': sessionKey }
      : {}
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json', ...sessionHdr })
    res.end(
      JSON.stringify({
        id: `msg_${randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: blocks,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: estTokens(JSON.stringify(blocks)) },
      })
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...sessionHdr,
  })
  emitBlocks(res, blocks, model, stopReason, inputTokens)
  res.end()
}

async function messages(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConductorConfig,
  opts: ProviderWireOpts,
  link: (parent?: OtelCtx) => Promise<AcpPeer>,
  parent: OtelCtx | undefined,
  sessions: Map<string, ConvSession>
): Promise<void> {
  let body: MessagesRequest
  try {
    body = JSON.parse(await readBody(req)) as MessagesRequest
  } catch {
    apiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    return
  }
  const t0 = Date.now()
  // a dropped client cancels the acp turn — no orphan devin session
  const ac = new AbortController()
  res.once('close', () => ac.abort())
  let reply: Awaited<ReturnType<typeof acpPooledTurn>>
  let inputTokens = 0
  let reused = false
  const key = conversationKey(req, body)
  let conv: ConvSession | undefined
  try {
    const peer = await link(parent)
    const msgs = body.messages ?? []
    const imageOk = peer.caps?.image === true
    // `provider/model` ids are a real pin — resolved against the agent's
    // own catalog; bare foreign ids (claude-sonnet-*) are display labels
    const requestModel =
      typeof body.model === 'string' && body.model.includes('/') ? body.model : undefined
    const deadline = Date.now() + cfg.timeoutMs
    sweepSessions(sessions, t0)
    const cand = key !== undefined ? sessions.get(key) : undefined
    const usable =
      cand !== undefined &&
      cand.peer === peer &&
      !cand.busy &&
      cand.consumed <= msgs.length &&
      hashTurns(msgs, cand.consumed) === cand.historyHash
    if (usable === true) {
      const tail = tailTurns(msgs, cand.consumed)
      if (tail.length === 0) {
        // a pure retry — nothing new for the session; replay the
        // recorded reply instead of paying a duplicate turn
        cand.lastSeen = Date.now()
        respond(
          res,
          body,
          cand.lastReply.blocks,
          cand.lastReply.model,
          cand.lastReply.stopReason,
          cand.lastReply.inputTokens,
          key
        )
        return
      }
      // the delta only — prior turns live in the session's own context
      const prompt = tailBlocks(tail, imageOk)
      inputTokens = inputTokensOf(prompt)
      cand.busy = true
      cand.lastSeen = Date.now()
      try {
        reply = await cand.live.prompt(prompt, deadline, {
          signal: ac.signal,
          by: `conductor:${cfg.backend}`,
          requestModel,
          parent,
        })
      } catch (err) {
        // a failed turn poisons cacheability — evict and let the retry
        // open a fresh session rather than pile onto unknown state
        if (key !== undefined) {
          sessions.delete(key)
        }
        try {
          cand.live.dispose()
        } catch {
          // already dead — the drop is the point
        }
        throw err
      } finally {
        cand.busy = false
      }
      conv = cand
      reused = true
    } else {
      const candBusy = cand?.busy === true
      if (cand !== undefined && !candBusy && key !== undefined) {
        // a stale key — the stored context never proved this client;
        // its session is poison for THIS conversation, retire it
        sessions.delete(key)
        try {
          cand.live.dispose()
        } catch {
          // dead transport — the peer's close reaps it anyway
        }
      }
      // image blocks ride the wire only when the agent advertised the
      // prompt capability — serialize after link() so the negotiated
      // caps are known (bro-7izjx)
      const prompt = serializeBlocks(body, imageOk)
      inputTokens = inputTokensOf(prompt)
      if (key !== undefined && !candBusy) {
        const live = await acpSessionRetain(peer, cfg.entry, opts, deadline, {
          by: `conductor:${cfg.backend}`,
          requestModel,
          parent,
        })
        try {
          reply = await live.prompt(prompt, deadline, {
            signal: ac.signal,
            by: `conductor:${cfg.backend}`,
            requestModel,
            parent,
          })
        } catch (err) {
          // the first turn died — nothing is cached yet but the acp
          // side still holds the session; drop it before surfacing
          try {
            live.dispose()
          } catch {
            // already gone — the drop is the point
          }
          throw err
        }
        conv = {
          live,
          peer,
          consumed: msgs.length,
          historyHash: hashTurns(msgs, msgs.length),
          lastReply: { blocks: [], model: '', stopReason: '', inputTokens: 0 },
          busy: false,
          lastSeen: Date.now(),
        }
      } else {
        // a keyless request, or the conversation's own turn is still in
        // flight — one-shot over the same link, nothing stored
        reply = await acpPooledTurn(peer, cfg.entry, opts, prompt, deadline, {
          signal: ac.signal,
          by: `conductor:${cfg.backend}`,
          requestModel,
          parent,
        })
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = AVAIL.test(msg) ? 529 : 500
    otelEvent('conductor.error', {
      backend: cfg.backend,
      status,
      duration_ms: Date.now() - t0,
      error: msg.slice(0, 200),
    })
    apiError(
      res,
      status,
      AVAIL.test(msg) ? 'overloaded_error' : 'api_error',
      `bro conductor: ${msg}`
    )
    return
  }
  const blocks = parseReply(reply.text)
  const stopReason = blocks.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : (STOP_REASON[reply.stopReason] ?? 'end_turn')
  if (conv !== undefined) {
    // the turn settled — every client message (including the echoes the
    // session just proved it holds) is consumed context now
    const all = body.messages ?? []
    conv.consumed = all.length
    conv.historyHash = hashTurns(all, all.length)
    conv.lastReply = { blocks, model: reply.model, stopReason, inputTokens }
    if (key !== undefined) {
      // re-insert on every hit — insertion order is the LRU order
      // sweepSessions' overflow eviction relies on
      sessions.delete(key)
      sessions.set(key, conv)
    }
  }
  otelEvent('conductor.turn', {
    backend: cfg.backend,
    model: reply.model,
    stop_reason: stopReason,
    stream: body.stream !== false,
    session_reused: reused,
    input_tokens: inputTokens,
    output_tokens: estTokens(reply.text),
    duration_ms: Date.now() - t0,
  })
  respond(res, body, blocks, reply.model, stopReason, inputTokens, key)
}

/** The anthropic /v1/models rows — the configured catalog source
 *  (`BRO_PROVIDER_CATALOG`, else the backend itself) through the SAME
 *  `bro providers models` surface, so ids arrive `<entry>/<model>` and
 *  re-pin on /v1/messages. */
async function models(
  res: ServerResponse,
  cfg: ConductorConfig,
  opts: ProviderWireOpts
): Promise<void> {
  try {
    const source = cfg.catalog ?? { name: cfg.backend, entry: cfg.entry }
    const list = await catalogModels(source.name, source.entry, { acp: opts.acp })
    const data = list.map((m) => ({
      type: 'model',
      id: m.id,
      display_name: m.name ?? m.id,
      created_at: '2025-01-01T00:00:00Z',
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        object: 'list',
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      })
    )
  } catch (err) {
    apiError(res, 502, 'api_error', `bro conductor: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `(req, res)` handler for `/v1/*` — the conductor's answer when
 *  `BRO_PROVIDER_BACKEND` resolves an acp provider. Same raw-stream
 *  seat as the byte proxy — Messages bodies exceed the envelope cap. */
export function conductorProxy(
  cfg: ConductorConfig,
  opts: ProviderWireOpts = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const wireOpts: ProviderWireOpts = {
    ...opts,
    model: opts.model ?? cfg.model,
    acp: { cwd: cfg.cwd, ...opts.acp },
  }
  // warm pool: one acp child serves every /v1/messages turn — spawn +
  // initialize is paid once per listener; session/new per request is
  // cheap and concurrent sessions multiplex on the same connection.
  // A dead transport drops the link so the next request respawns.
  let link: Promise<AcpPeer> | undefined
  let live: AcpPeer | undefined
  // retained conversations — one acp session per client conversation
  // (x-bro-session pin or history fingerprint). Transport death kills
  // every session it carried, so the abort listener drops the map.
  const sessions = new Map<string, ConvSession>()
  const getLink = (parent?: OtelCtx): Promise<AcpPeer> => {
    if (link === undefined) {
      otelEvent('acp.spawn', { backend: cfg.backend })
      link = acpOpen(
        `conductor:${cfg.backend}`,
        cfg.entry,
        wireOpts,
        Date.now() + cfg.timeoutMs,
        parent
      )
      link.then(
        (p) => {
          live = p
          p.signal.addEventListener(
            'abort',
            () => {
              link = undefined
              live = undefined
              dropSessions(sessions)
            },
            { once: true }
          )
        },
        () => (link = undefined)
      )
    }
    return link
  }
  // the pooled child outlives any request — without a close on process
  // exit serve shutdown orphans it on a dead transport (the zombie
  // acp worker of the original incident). close() is sync, safe in an
  // 'exit' handler; an in-flight link resolve is a ms-scale window.
  process.once('exit', () => live?.close())
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    const t0 = Date.now()
    // one session = one trace: an instrumented caller's traceparent
    // parents every span we emit; local agents that don't propagate are
    // still attributed by process tree (peer.*)
    const httpSpan = otelSpan(
      `serve.http ${method} ${path}`,
      { backend: cfg.backend, 'http.method': method, 'http.route': path, ...peerAttrs(req.socket) },
      { parent: otelParent(req.headers.traceparent) }
    )
    res.once('finish', () => {
      httpSpan.end(
        { 'http.status': res.statusCode, 'http.duration_ms': Date.now() - t0 },
        res.statusCode >= 500 ? 'error' : 'ok'
      )
      otelEvent('serve.request', {
        route: `${method} ${path}`,
        status: res.statusCode,
        duration_ms: Date.now() - t0,
        backend: cfg.backend,
      })
    })
    if (method === 'POST' && path === '/v1/messages') {
      await messages(req, res, cfg, wireOpts, getLink, httpSpan.ctx, sessions)
      return
    }
    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      const raw = await readBody(req)
      apiErrorCountTokens(res, raw)
      return
    }
    if (method === 'GET' && path === '/v1/models') {
      await models(res, cfg, wireOpts)
      return
    }
    apiError(res, 404, 'not_found_error', `bro conductor: no route ${method} ${path}`)
  }
}

function apiErrorCountTokens(res: ServerResponse, raw: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ input_tokens: estTokens(raw) }))
}
