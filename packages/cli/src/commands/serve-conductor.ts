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
import { join } from 'node:path'
import { gitCommonDir, loadConfig } from '@broject/core'
import type { ProviderEntry } from '@broject/core'
import { acpOpen, acpPooledTurn, acpSessionRetain, otelEvent, otelJournal, otelParent, otelSpan } from '@broject/providers'
import type { AcpContentBlock, AcpPeer, AcpRetainedSession, OtelCtx, PooledTurnOpts, ProviderWireOpts } from '@broject/providers'
import { peerAttrs } from './peer.ts'
import { catalogModels } from './providers.ts'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

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
  /** SSE ping cadence while a streamed turn is open — claude's read
   *  timeout is the real constraint on slow acp turns. */
  keepaliveMs?: number
}

/** BRO_PROVIDER_BACKEND resolves to the conductor's acp entry — a name
 *  no registry knows is a loud startup error naming what IS configured,
 *  never a silent fall back to the byte proxy. */
export function conductorConfig(
  env: NodeJS.ProcessEnv,
  dir: string,
  providers?: Record<string, ProviderEntry>
): ConductorConfig | undefined {
  const cfg = loadConfig(dir)
  // env pins the backend explicitly; a repo whose conductor is not
  // ambient (an apiKeyHelper-spawned serve never sees settings.env)
  // carries it as serve.backend — env still wins over config
  const configured = cfg.serve.backend?.trim()
  const backend = env.BRO_PROVIDER_BACKEND?.trim() || configured
  if (backend === undefined || backend === '') {
    return undefined
  }
  providers ??= (cfg.providers ?? {}) as Record<string, ProviderEntry>
  const entry = providers[backend]
  if (entry === undefined) {
    throw new Error(
      `provider backend '${backend}' (BRO_PROVIDER_BACKEND or serve.backend) — ` +
        `providers.${backend} is not configured ` +
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
    keepaliveMs: (() => {
      const k = Number(env.BRO_CONDUCTOR_KEEPALIVE_MS)
      return Number.isFinite(k) && k > 0 ? k : 10_000
    })(),
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
  tool_choice?: { type?: string; name?: string }
  stop_sequences?: string[]
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

/** The tool contract — the agent's only way to answer tool_use.
 *  tool_choice steers the contract tail: any/tool carry a must-call
 *  line (none withholds the whole contract upstream in prefixText). */
function toolContract(
  tools: NonNullable<MessagesRequest['tools']>,
  choice: MessagesRequest['tool_choice']
): string {
  const defs = tools
    .filter((t) => typeof t.name === 'string')
    .map(
      (t) =>
        `- ${t.name}: ${t.description ?? ''} input_schema: ${JSON.stringify(t.input_schema ?? {})}`
    )
    .join('\n')
  let must: string | undefined
  if (choice?.type === 'any') {
    must = 'You MUST respond with a tool call.'
  } else if (choice?.type === 'tool' && typeof choice.name === 'string') {
    must = `You MUST call the tool "${choice.name}".`
  }
  return [
    '<tools>',
    'Call tools by emitting exactly, one per call:',
    '<tool_call>{"name":"<name>","input":{<args>}}</tool_call>',
    defs === '' ? 'No tools available.' : `Available tools:\n${defs}`,
    ...(must !== undefined ? [must] : []),
    '</tools>',
  ].join('\n')
}

/** tool_choice → the MUST clause of the injected contract. */
function mustText(choice: MessagesRequest['tool_choice']): string | undefined {
  if (choice?.type === 'any') return 'You MUST respond with a tool call.'
  if (choice?.type === 'tool' && typeof choice.name === 'string') {
    return `You MUST call the tool "${choice.name}".`
  }
  return undefined
}

const turnRole = (m: { role?: string }): string =>
  m.role === 'assistant' ? 'assistant' : 'user'

/** stop_sequences on the wire is an array of non-empty strings —
 *  anything else is a 400-class request error, never a 500. */
function stopSeqsOf(body: MessagesRequest): string[] | undefined {
  const raw = body.stop_sequences
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || s === '')) {
    return undefined
  }
  return raw
}

/** The request's stop settings as one hashable string — part of the
 *  conversation identity: changed markers must not replay a reply
 *  recorded under different ones. */
const stopKeyOf = (seqs: string[]): string => JSON.stringify(seqs)

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
  if (
    body.tools !== undefined &&
    body.tools.length > 0 &&
    body.tool_choice?.type !== 'none'
  ) {
    parts.push(toolContract(body.tools, body.tool_choice))
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
  /** sha256 over prefix+turnHashInput(messages[0..consumed-1]) — the
   *  prefix proof; a changed system/tools fails it and evicts. */
  historyHash: string
  /** raw request-model id the session currently runs — a resend that
   *  pins a different model re-pins instead of replaying. */
  requestModel?: string
  /** sha256 of the prefix (system+tools) the session last ran under —
   *  a chained request carrying changed instructions injects them
   *  instead of silently answering under the old ones. */
  prefixHash?: string
  lastReply: ReplyView
  busy: boolean
  lastSeen: number
}

/** One settled reply as the wire renders it — buffered, streamed, or
 *  replayed from conv.lastReply. Bundling keeps the emit/settle
 *  signatures under the parameter cap. */
interface ReplyView {
  blocks: OutBlock[]
  model: string
  stopReason: string
  stopSequence?: string
  inputTokens: number
}

const CONV_TTL_MS = 10 * 60_000
const CONV_CAP = 32

/** What the fingerprint/history proofs hash: the canonical turn text
 *  PLUS a digest of any image payload — `serTurn` collapses images to
 *  `[image]`, so without this two histories differing only in pixels
 *  would collide (codeant #569). */
const turnHashInput = (m: ClientMessage): string => {
  const imgs =
    typeof m.content === 'string'
      ? ''
      : (m.content ?? [])
          .filter((b) => b.type === 'image' && typeof (b as ImageBlock).source?.data === 'string')
          .map((b) =>
            createHash('sha256')
              .update((b as ImageBlock).source?.data ?? '')
              .digest('hex')
          )
          .join(',')
  return `${serTurn(m)}\x00${imgs}`
}

const hashTurns = (
  prefix: string,
  msgs: ClientMessage[],
  n: number,
  stopKey: string
): string =>
  createHash('sha256')
    .update(`${prefix}\n${stopKey}\n${msgs.slice(0, n).map(turnHashInput).join('\n')}`)
    .digest('hex')

/** Prefix-only digest — chained requests carry no client history to
 *  hash, so the system+tools freshness is proven standalone. */
const prefixSha = (prefix: string): string =>
  createHash('sha256').update(prefix).digest('hex')

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
    .update(
      `${prefixText(body)}\n${stopKeyOf(stopSeqsOf(body) ?? [])}\n${turnHashInput(first)}`
    )
    .digest('hex')
  return `f:${fp}`
}

/** Drop a session handle without surfacing transport noise — the
 *  dispose is bookkeeping (eviction, teardown, failure cleanup), never
 *  an error path worth reporting. */
function disposeQuiet(live: { dispose(): void }): void {
  try {
    live.dispose()
  } catch {
    // dead transport — the drop is the point
  }
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
    // a session mid-turn is off-limits — disposing a live handle would
    // kill the in-flight prompt; its own failure path evicts it
    if (s.busy) {
      continue
    }
    if (now - s.lastSeen > CONV_TTL_MS || overflow-- > 0) {
      sessions.delete(k)
      disposeQuiet(s.live)
    }
  }
}

/** Every session the transport owns dies with it — clear the whole
 *  map so no stale handle is ever reused on a respawned child. */
function dropSessions(sessions: Map<string, ConvSession>): void {
  for (const s of sessions.values()) {
    disposeQuiet(s.live)
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

/** One completed <tool_call>'s payload — parseable JSON carrying a
 *  string name, else undefined: the markup stays raw text, the wire
 *  never invents a call (shared by the buffered and live splits). */
function toolCall(raw: string): { name: string; input: unknown } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const p = parsed as { name?: unknown; input?: unknown }
  if (typeof p.name !== 'string') return undefined
  let input: unknown
  if (typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)) {
    input = p.input
  } else if (p.input === undefined) {
    input = {}
  } else {
    input = { value: p.input }
  }
  return { name: p.name, input }
}

/** Reply → ordered anthropic blocks: text segments stay text, each
 *  parseable <tool_call> becomes tool_use (unparseable JSON stays raw
 *  text — the wire never invents a call). */
export function parseReply(text: string, parseTools = true): OutBlock[] {
  const out: OutBlock[] = []
  let at = 0
  for (const m of text.matchAll(TOOL_CALL)) {
    if (!parseTools) break
    const call = toolCall(m[1] ?? '')
    if (call === undefined) continue
    const lead = text.slice(at, m.index)
    if (lead.trim() !== '') out.push({ type: 'text', text: lead })
    out.push({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name: call.name,
      input: call.input,
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

/** The anthropic envelope's first frame — shared by the buffered
 *  emitBlocks path and the live pump so the shape never forks. */
function messageStartEvent(model: string, inputTokens: number): object {
  return {
    type: 'message_start',
    message: {
      id: `msg_${randomBytes(12).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }
}

/** The buffered SSE answer — the whole settled reply emitted as one
 *  anthropic event sequence. Used where no live turn ran: a replayed
 *  resend answers from conv.lastReply, never a fresh pump. */
function emitBlocks(res: ServerResponse, view: ReplyView): void {
  const { blocks, model, stopReason, inputTokens, stopSequence } = view
  const outTokens = estTokens(JSON.stringify(blocks))
  sse(res, 'message_start', messageStartEvent(model, inputTokens))
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
    delta: { stop_reason: stopReason, stop_sequence: stopSequence ?? null },
    usage: { output_tokens: outTokens },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/** Narration label — a tool_call title can carry a whole command
 *  string; first line only, capped. */
function shortLabel(s: string): string {
  const line = s.split('\n', 1)[0] ?? s
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/** Longest suffix of `s` that is a prefix of `tag` — the tail bytes a
 *  tag split across deltas must hold back until more of the turn
 *  arrives (or the turn ends and they flush as plain text). */
function tagSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(-n))) return n
  }
  return 0
}

/** stop_sequences as an incremental cut — the marker can span deltas,
 *  so feed() holds back the longest suffix that still prefixes any
 *  sequence. A hit returns the pre-marker text once; everything after
 *  is swallowed (generation stops — the wire's own semantics). */
class StopFilter {
  private tail = ''
  private out = ''
  hit: string | undefined

  constructor(private readonly seqs: string[]) {}

  feed(s: string): string {
    const o = this.cut(s)
    this.out += o
    return o
  }

  private cut(s: string): string {
    if (this.hit !== undefined || this.seqs.length === 0) {
      return this.hit === undefined ? s : ''
    }
    const buf = this.tail + s
    let best = -1
    let seq: string | undefined
    for (const q of this.seqs) {
      const i = buf.indexOf(q)
      if (i !== -1 && (best === -1 || i < best)) {
        best = i
        seq = q
      }
    }
    if (best !== -1) {
      this.hit = seq
      this.tail = ''
      return buf.slice(0, best)
    }
    const hold = this.seqs.reduce((n, q) => Math.max(n, tagSuffix(buf, q)), 0)
    this.tail = buf.slice(buf.length - hold)
    return buf.slice(0, buf.length - hold)
  }

  /** Turn end without a hit — the held tail was never a marker. */
  flush(): string {
    const t = this.hit === undefined ? this.tail : ''
    this.tail = ''
    this.out += t
    return t
  }

  /** Everything the filter let through — byte-identical to what the
   *  client saw, whatever the delta boundaries were. The recorded
   *  reply comes from this, never from a re-run of the raw text. */
  get emitted(): string {
    return this.out
  }
}

/** The incremental <tool_call> pump every dialect renderer shares:
 *  feed() appends a delta and pumps whatever is provably outside a
 *  tag (a partial-tag tail holds for the next delta); inside a tag
 *  everything holds until the close, when a valid call emits — or bad
 *  markup falls back to plain text, never an invented call. */
abstract class TagPump {
  private pending = ''
  private inCall = false

  /** tools=false — the request withheld the tool contract; markup an
   *  agent emits anyway stays raw text, matching the recorded reply. */
  constructor(private readonly tools = true) {
    // no base state — the flag is the whole constructor
  }

  protected abstract text(s: string): void
  protected abstract call(name: string, input: unknown): void

  /** Replay recorded blocks through the live emitters — a stream:true
   *  resend sees the same event sequence the original turn produced
   *  (fresh ids, consistent within this replay). */
  replay(blocks: OutBlock[]): void {
    for (const b of blocks) {
      if (b.type === 'text') this.text(b.text ?? '')
      else if (b.type === 'tool_use') this.call(b.name ?? '', b.input ?? {})
    }
  }

  /** Append a delta and pump whatever is provably outside a tag. */
  feed(s: string): void {
    this.pending += s
    this.drain(false)
  }

  /** Turn end — every held byte flushes (final drops the tail-hold). */
  drainAll(): void {
    this.drain(true)
  }

  protected drain(final: boolean): void {
    if (!this.tools) {
      this.text(this.pending)
      this.pending = ''
      return
    }
    for (;;) {
      // each step returns true when the pending buffer stalls on a
      // boundary — the pump keeps going while a tag let it through
      if (this.inCall ? this.drainCall(final) : this.drainText(final)) return
    }
  }

  /** Inside <tool_call>: emit the call on its close tag, else hold —
   *  a final flush turns the unclosed remnant back into plain text. */
  private drainCall(final: boolean): boolean {
    const j = this.pending.indexOf(CLOSE_TAG)
    if (j === -1) {
      if (final) {
        this.text(OPEN_TAG + this.pending)
        this.pending = ''
      }
      return true
    }
    const raw = this.pending.slice(0, j)
    this.pending = this.pending.slice(j + CLOSE_TAG.length)
    this.inCall = false
    const c = toolCall(raw)
    if (c === undefined) this.text(OPEN_TAG + raw + CLOSE_TAG)
    else this.call(c.name, c.input)
    return false
  }

  /** Free text: emit down to the next open tag — or everything but a
   *  partial-tag tail that more deltas might complete. */
  private drainText(final: boolean): boolean {
    const i = this.pending.indexOf(OPEN_TAG)
    if (i === -1) {
      const hold = final ? 0 : tagSuffix(this.pending, OPEN_TAG)
      this.text(this.pending.slice(0, this.pending.length - hold))
      this.pending = this.pending.slice(this.pending.length - hold)
      return true
    }
    this.text(this.pending.slice(0, i))
    this.pending = this.pending.slice(i + OPEN_TAG.length)
    this.inCall = true
    return false
  }
}

/** Live SSE emission for a streaming turn (bro-728wl) — message_start
 *  leaves at turn start, text deltas flow inside one open text block,
 *  and each completed <tool_call> swaps to a tool_use block at the
 *  next index. The tag can span deltas, so free text is emitted only
 *  once it is provably outside a tag — parseReply's contract applied
 *  incrementally (bad JSON stays raw text, never an invented call). */
class LiveTurn extends TagPump {
  private idx = 0
  private open = false
  private sawTool = false
  private acc = ''
  stopReason = 'end_turn'

  private readonly ping?: NodeJS.Timeout

  constructor(
    private readonly res: ServerResponse,
    model: string,
    inputTokens: number,
    private readonly stops: StopFilter | undefined,
    pingMs?: number,
    tools = true
  ) {
    super(tools)
    if (pingMs !== undefined && pingMs > 0) {
      this.ping = setInterval(() => sse(res, 'ping', { type: 'ping' }), pingMs)
      this.ping.unref()
    }
    sse(res, 'message_start', messageStartEvent(model, inputTokens))
  }

  readonly onUpdate: NonNullable<PooledTurnOpts['onUpdate']> = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      // a stop_sequence hit cuts the wire here — later chunks swallow
      this.feed(this.stops?.feed(u.content.text) ?? u.content.text)
      return
    }
    const line = this.narrateTool(u)
    if (line !== undefined) {
      // pending may hold a held-back partial-tag tail — flush what
      // drain releases first so narration never lands inside buffered
      // text (drain still holds a live tag prefix; that tail completes
      // into a block later, so text order is preserved either way)
      this.drain(false)
      // narration rides the same stop gate — a marker inside a tool
      // label cuts identically, and post-hit lines emit nothing
      const kept = this.stops?.feed(line) ?? line
      if (kept !== '') this.text(kept)
    }
  }

  private readonly toolStarted = new Set<string>()
  private readonly toolDone = new Set<string>()
  private readonly toolLabels = new Map<string, string>()

  /** The session's own tool_call lifecycle — the client's only view of
   *  agent-side work (exec, file ops, subagent spawns): narrated as
   *  text edges, never tool_use (the tool already ran — a tool_use
   *  would make the client execute it again). One line per start, one
   *  per terminal status; content/plan/usage updates are chatter.
   *  Dedup keys on toolCallId when the agent supplies one — an id-less
   *  update can't be correlated, so it narrates every time. */
  private narrateTool(u: SessionUpdate): string | undefined {
    if (u.sessionUpdate === 'tool_call') return this.narrateStart(u)
    if (u.sessionUpdate === 'tool_call_update') return this.narrateTerminal(u)
    return undefined
  }

  /** Id-keyed once-only gate — an id-less update can't be correlated,
   *  so it always passes (narrates every time). */
  private once(id: string | undefined, seen: Set<string>): boolean {
    if (id === undefined) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }

  private narrateStart(u: SessionUpdate): string | undefined {
    if (u.sessionUpdate !== 'tool_call') return undefined
    const terminal = u.status === 'completed' || u.status === 'failed'
    if (!this.once(u.toolCallId, this.toolStarted)) {
      // a repeated tool_call can carry the terminal edge (the provider
      // layer emits it as finish) — narrate it once, with the cached label
      if (!terminal || !this.once(u.toolCallId, this.toolDone)) return undefined
      const known = u.toolCallId !== undefined ? this.toolLabels.get(u.toolCallId) : undefined
      const label = shortLabel(u.title ?? u.name ?? known ?? 'tool call')
      return `\n${u.status === 'failed' ? '✗' : '✓'} ${label}\n`
    }
    const label = shortLabel(u.title ?? u.name ?? u.kind ?? 'tool call')
    if (u.toolCallId !== undefined) this.toolLabels.set(u.toolCallId, label)
    const start = `\n⏺ ${label}\n`
    // a tool_call can itself arrive already terminal — open and close
    // the edge in one update so nothing stays mid-flight forever
    if (!terminal) return start
    if (u.toolCallId !== undefined) this.toolDone.add(u.toolCallId)
    return `${start}${u.status === 'failed' ? '✗' : '✓'} ${label}\n`
  }

  private narrateTerminal(u: SessionUpdate): string | undefined {
    if (
      u.sessionUpdate !== 'tool_call_update' ||
      (u.status !== 'completed' && u.status !== 'failed')
    ) {
      return undefined
    }
    if (!this.once(u.toolCallId, this.toolDone)) return undefined
    const known = u.toolCallId !== undefined ? this.toolLabels.get(u.toolCallId) : undefined
    const label = shortLabel(u.title ?? u.name ?? known ?? 'tool call')
    return `\n${u.status === 'failed' ? '✗' : '✓'} ${label}\n`
  }

  private blockStart(contentBlock: unknown): void {
    sse(this.res, 'content_block_start', {
      type: 'content_block_start',
      index: this.idx,
      content_block: contentBlock,
    })
  }

  private delta(d: unknown): void {
    sse(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.idx,
      delta: d,
    })
  }

  private blockStop(): void {
    sse(this.res, 'content_block_stop', { type: 'content_block_stop', index: this.idx })
    this.idx++
  }

  private closeBlock(): void {
    if (this.open) {
      this.blockStop()
      this.open = false
    }
  }

  protected text(s: string): void {
    if (s === '') return
    if (!this.open) {
      this.blockStart({ type: 'text', text: '' })
      this.open = true
    }
    this.delta({ type: 'text_delta', text: s })
    this.acc += s
  }

  protected call(name: string, input: unknown): void {
    this.closeBlock()
    this.blockStart({
      type: 'tool_use',
      id: `toolu_${randomBytes(8).toString('hex')}`,
      name,
      input: {},
    })
    const json = JSON.stringify(input)
    this.delta({ type: 'input_json_delta', partial_json: json })
    this.blockStop()
    this.sawTool = true
    this.acc += json
  }

  finish(stopReason: string): void {
    if (this.stops !== undefined) this.feed(this.stops.flush())
    this.drainAll()
    this.closeBlock()
    if (this.ping !== undefined) clearInterval(this.ping)
    if (this.idx === 0 && !this.sawTool) {
      // parity with the buffered shape — a silent turn still answers
      // with one (empty) text block
      this.blockStart({ type: 'text', text: '' })
      this.delta({ type: 'text_delta', text: '' })
      this.blockStop()
    }
    let reason = stopReason
    if (this.stops?.hit !== undefined) reason = 'stop_sequence'
    if (this.sawTool) reason = 'tool_use'
    this.stopReason = reason
    sse(this.res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: this.stops?.hit ?? null },
      usage: { output_tokens: this.outputTokens() },
    })
    sse(this.res, 'message_stop', { type: 'message_stop' })
  }

  error(type: string, message: string): void {
    if (this.ping !== undefined) clearInterval(this.ping)
    this.drainAll()
    this.closeBlock()
    sse(this.res, 'error', { type: 'error', error: { type, message } })
  }

  outputTokens(): number {
    // estTokens floors at 1 — a genuinely silent turn reports 0, not
    // a phantom token (amazon-q #566)
    return this.acc === '' ? 0 : estTokens(this.acc)
  }
}

/** The model message_start names — the applied pin (a `provider/model`
 *  request id or the configured entry pin) wins; a bare foreign id
 *  (claude-sonnet-*) is a display label and echoes as one. */
function servedModel(
  requestModel: string | undefined,
  opts: ProviderWireOpts,
  cfg: ConductorConfig,
  body: MessagesRequest
): string {
  const id =
    requestModel ??
    opts.model ??
    cfg.entry.model ??
    (typeof body.model === 'string' ? body.model : undefined)
  return id?.split('/').pop() ?? 'unknown'
}

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  res.end(`${JSON.stringify({ type: 'error', error: { type, message } })}\n`)
}

/** Request bodies carry base64 images, so the cap is generous — but
 *  unbounded reads are a memory-exhaustion door on any listener.
 *  32MB matches the upstream wire's own payload ceiling. */
const MAX_BODY = 32 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buf.length
    if (bytes > MAX_BODY) {
      // leave the socket open — the caller still owes the 413 answer
      throw new Error('request body too large')
    }
    parts.push(buf)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** The 413 answer — the body stays open until the response lands, then
 *  the socket closes (we never read the rest of the request). */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close')
  apiError(res, 413, 'request_too_large', 'request body exceeds 32MB')
  res.once('finish', () => req.destroy())
}

/** Same ceiling on the OpenAI dialects — its own error envelope. */
function openaiTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close')
  openaiError(res, 413, 'invalid_request_error', 'request body exceeds 32MB')
  res.once('finish', () => req.destroy())
}

const AVAIL = /unavailable|timeout|timed out/i
/** Quota walls are their own wire class — the client retries on a
 *  schedule, never on a 5xx hunch. */
const RATE = /rate.?limit|too many|quota|429/i

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
  view: ReplyView,
  sessionKey?: string
): void {
  const { blocks, model, stopReason, inputTokens, stopSequence } = view
  const sessionHdr = sessionKey?.startsWith('h:') === true ? { 'x-bro-session': sessionKey } : {}
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
        stop_sequence: stopSequence ?? null,
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
  emitBlocks(res, view)
  res.end()
}

/** Evict a conversation — failed turns, stale prefixes, dead repins
 *  all land here: out of the map, handle dropped, never reused. */
function evict(
  sessions: Map<string, ConvSession>,
  key: string | undefined,
  conv: ConvSession
): void {
  if (key !== undefined) {
    sessions.delete(key)
  }
  disposeQuiet(conv.live)
}

type PooledReply = Awaited<ReturnType<typeof acpPooledTurn>>

interface TurnOutcome {
  reply?: PooledReply
  conv?: ConvSession
  reused: boolean
  inputTokens: number
  /** the resend carried nothing new — caller replays conv.lastReply */
  replay: boolean
}

/** Everything one /v1/messages turn shares — built once per request so
 *  the routing helpers stay narrow. */
interface TurnEnv {
  body: MessagesRequest
  msgs: ClientMessage[]
  prefix: string
  peer: AcpPeer
  cfg: ConductorConfig
  opts: ProviderWireOpts
  sessions: Map<string, ConvSession>
  pendingOpens: Set<string>
  key: string | undefined
  /** request's stop settings — hashed into the conversation proofs so
   *  changed markers never replay a reply cut under different ones */
  stopKey: string
  /** /v1/responses chaining: the key came from the
   *  previous_response_id ledger — msgs are the DELTA only, the
   *  session itself holds the history; skip the fingerprint proof. */
  chained?: boolean
  /** The consumed count the predecessor response was recorded at —
   *  a session past it means the caller branched off a superseded
   *  point; linear chains match exactly. */
  chainConsumed?: number
  parent: OtelCtx | undefined
  requestModel: string | undefined
  deadline: number
  signal: AbortSignal
  by: string
  imageOk: boolean
  /** Called the moment a real turn is chosen (never on replay or a
   *  failed open) — it commits the wire to SSE and hands back the
   *  session-update sink the prompt pump streams deltas into
   *  (bro-728wl). Undefined for `stream:false` requests. */
  openStream?: (inputTokens: number) => PooledTurnOpts['onUpdate']
}

/** A proven continuation — the delta turns only; an empty tail is a
 *  replay (with a repin if the resend pins a different model). */
async function continuationTurn(env: TurnEnv, cand: ConvSession): Promise<TurnOutcome> {
  // a chained request's msgs ARE the tail — the session holds the
  // head; a fingerprinted request's msgs are the resend, slice proven
  let tail = env.chained === true ? env.msgs : tailTurns(env.msgs, cand.consumed)
  // a chained request carrying a CHANGED prefix (new instructions,
  // tools, tool_choice) — the delta alone would answer under the old
  // contract; prepend the new prefix as its own turn. Unchanged
  // prefixes resend nothing.
  if (
    env.chained === true &&
    env.prefix !== '' &&
    prefixSha(env.prefix) !== cand.prefixHash
  ) {
    tail = [{ role: 'user', content: env.prefix }, ...tail]
  }
  if (tail.length === 0) {
    // a pure retry — nothing new for the session; the caller replays
    // the recorded reply. A resend pinning a DIFFERENT model is not a
    // replay — the session re-pins and the recorded answer stays
    // honest (it was generated under the old pin either way).
    if (env.requestModel !== undefined && env.requestModel !== cand.requestModel) {
      try {
        await cand.live.repin(env.requestModel, env.deadline)
        cand.requestModel = env.requestModel
      } catch (err) {
        evict(env.sessions, env.key, cand)
        throw err
      }
    }
    cand.lastSeen = Date.now()
    return { reused: true, inputTokens: 0, replay: true, conv: cand }
  }
  // the delta only — prior turns live in the session's own context
  const prompt = tailBlocks(tail, env.imageOk)
  const inputTokens = inputTokensOf(prompt)
  cand.busy = true
  cand.lastSeen = Date.now()
  try {
    const reply = await cand.live.prompt(prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    return { reply, reused: true, inputTokens, replay: false, conv: cand }
  } catch (err) {
    // a failed turn poisons cacheability — evict and let the retry
    // open a fresh session rather than pile onto unknown state
    evict(env.sessions, env.key, cand)
    throw err
  } finally {
    cand.busy = false
  }
}

/** A first (or restarted) turn — a keyed request retains a session;
 *  a keyless, busy, or already-opening key takes the one-shot path. */
async function freshTurn(env: TurnEnv, candBusy: boolean): Promise<TurnOutcome> {
  // image blocks ride the wire only when the agent advertised the
  // prompt capability — serialize after link() so the negotiated
  // caps are known (bro-7izjx)
  const prompt = serializeBlocks(env.body, env.imageOk)
  const inputTokens = inputTokensOf(prompt)
  const key = env.key
  if (key === undefined || candBusy || env.pendingOpens.has(key)) {
    // a keyless request, or the conversation's own turn is still in
    // flight — one-shot over the same link, nothing stored
    const reply = await acpPooledTurn(env.peer, env.cfg.entry, env.opts, prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    return { reply, reused: false, inputTokens, replay: false }
  }
  // mark BEFORE the await — a concurrent first request on the same key
  // takes the one-shot path instead of opening a twin session whose
  // loser leaks out of the map (codeant #569)
  env.pendingOpens.add(key)
  let live: AcpRetainedSession | undefined
  try {
    live = await acpSessionRetain(env.peer, env.cfg.entry, env.opts, env.deadline, {
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
    })
    const reply = await live.prompt(prompt, env.deadline, {
      signal: env.signal,
      by: env.by,
      requestModel: env.requestModel,
      parent: env.parent,
      onUpdate: env.openStream?.(inputTokens),
    })
    const conv: ConvSession = {
      live,
      peer: env.peer,
      consumed: env.msgs.length,
      historyHash: hashTurns(env.prefix, env.msgs, env.msgs.length, env.stopKey),
      prefixHash: prefixSha(env.prefix),
      requestModel: env.requestModel,
      lastReply: { blocks: [], model: '', stopReason: '', inputTokens: 0 },
      busy: false,
      lastSeen: Date.now(),
    }
    return { reply, reused: false, inputTokens, replay: false, conv }
  } catch (err) {
    // the first turn died — nothing is cached yet but the acp side
    // still holds the session; drop it before surfacing
    if (live !== undefined) {
      disposeQuiet(live)
    }
    throw err
  } finally {
    env.pendingOpens.delete(key)
  }
}

/** A chained request whose predecessor no longer resolves — expired,
 *  superseded, or mid-turn. The dialect maps it to a 4xx: answering
 *  from the bare delta would fabricate a history the session lost. */
class ChainBroken extends Error {}

/** Why a chained predecessor can't be honored — expired/evicted, a
 *  dead transport, an in-flight turn, or a session that moved past
 *  the recorded point (a branch attempt). */
function chainWhy(cand: ConvSession | undefined, env: TurnEnv): string | undefined {
  if (cand === undefined) return 'expired or evicted'
  if (cand.peer !== env.peer) return 'lost its transport'
  if (cand.busy) return 'has a turn in flight'
  if (env.chainConsumed !== undefined && cand.consumed !== env.chainConsumed) {
    return 'was superseded by a later response'
  }
  return undefined
}

/** One request's acp turn — proves a stored conversation (or evicts a
 *  stale one), then routes to continuation/fresh/one-shot. */
async function acpTurn(env: TurnEnv): Promise<TurnOutcome> {
  sweepSessions(env.sessions, Date.now())
  const cand = env.key !== undefined ? env.sessions.get(env.key) : undefined
  if (env.chained === true) {
    // chained routing is strict: the named predecessor must still sit
    // at the recorded point — else fail loudly, never answer
    // history-less.
    const why = chainWhy(cand, env)
    if (why !== undefined) {
      throw new ChainBroken(`previous_response_id ${why}`)
    }
    return continuationTurn(env, cand as ConvSession)
  }
  const usable =
    cand !== undefined &&
    cand.peer === env.peer &&
    !cand.busy &&
    cand.consumed <= env.msgs.length &&
    hashTurns(env.prefix, env.msgs, cand.consumed, env.stopKey) === cand.historyHash
  if (usable === true) {
    return continuationTurn(env, cand)
  }
  const candBusy = cand?.busy === true
  if (cand !== undefined && !candBusy && env.key !== undefined) {
    // a stale key — the stored context never proved this client;
    // its session is poison for THIS conversation, retire it
    evict(env.sessions, env.key, cand)
  }
  return freshTurn(env, candBusy)
}

/** The wire surface `messages` needs — one listener's cfg, provider
 *  opts, link factory, and the session maps it owns. */
interface WireCtx {
  cfg: ConductorConfig
  opts: ProviderWireOpts
  link: (parent?: OtelCtx) => Promise<AcpPeer>
  sessions: Map<string, ConvSession>
  pendingOpens: Set<string>
}

/** `provider/model` ids are a real pin — resolved against the agent's
 *  own catalog; bare foreign ids (claude-sonnet-*) are display labels.
 *  Claude pins context variants as `model[1m]` — the bracket suffix is
 *  a client-side opt-in, not a different model; strip it or the
 *  catalog lookup 500s (bro-0g2l3). */
function requestModelOf(body: MessagesRequest): string | undefined {
  const raw = typeof body.model === 'string' ? body.model.trimEnd() : undefined
  const open = raw?.lastIndexOf('[') ?? -1
  const inner = open >= 0 && raw?.endsWith(']') ? raw.slice(open + 1, -1) : undefined
  const m =
    inner !== undefined && /^\d+[km]?$/i.test(inner) ? raw?.slice(0, open).trimEnd() : raw
  return m?.includes('/') ? m : undefined
}

/** A failed turn — on an open SSE stream the failure travels as an
 *  in-stream error event (the wire's own dead-stream shape); pre-commit
 *  it is an anthropic-shaped HTTP status. */
function turnError(
  res: ServerResponse,
  err: unknown,
  live: LiveTurn | undefined,
  backend: string,
  t0: number
): void {
  const msg = err instanceof Error ? err.message : String(err)
  const avail = AVAIL.test(msg)
  const rate = RATE.test(msg)
  let liveType = 'api_error'
  if (avail) liveType = 'overloaded_error'
  if (rate) liveType = 'rate_limit_error'
  if (live !== undefined) {
    live.error(liveType, `bro conductor: ${msg}`)
    res.end()
    otelEvent('conductor.error', {
      backend,
      status: 200,
      duration_ms: Date.now() - t0,
      error: msg.slice(0, 200),
    })
    return
  }
  let status = 500
  if (avail) status = 529
  if (rate) status = 429
  if (rate) res.setHeader('retry-after', '30')
  otelEvent('conductor.error', {
    backend,
    status,
    duration_ms: Date.now() - t0,
    error: msg.slice(0, 200),
  })
  apiError(res, status, liveType, `bro conductor: ${msg}`)
}

/** The turn settled — every client message (including the echoes the
 *  session just proved it holds) is consumed context now. Re-insert on
 *  every hit: insertion order is the LRU order sweepSessions' overflow
 *  eviction relies on. */
function settleConv(
  wire: WireCtx,
  key: string | undefined,
  conv: ConvSession,
  body: MessagesRequest,
  view: ReplyView,
  stopKey: string,
  chained?: boolean
): void {
  const all = body.messages ?? []
  if (chained === true) {
    // the delta already landed in the session's own context — the
    // cumulative count is bookkeeping only; no client-side history
    // exists to re-hash, so the fingerprint proof can never apply
    conv.consumed += all.length
    conv.historyHash = ''
  } else {
    conv.consumed = all.length
    conv.historyHash = hashTurns(prefixText(body), all, all.length, stopKey)
  }
  conv.prefixHash = prefixSha(prefixText(body))
  conv.lastReply = view
  if (key === undefined) return
  wire.sessions.delete(key)
  wire.sessions.set(key, conv)
}

/** Request validation → 4xx answers. Returns the parsed body, or
 *  undefined once the error was written. */
async function parseMessagesBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<MessagesRequest | undefined> {
  let body: MessagesRequest
  try {
    body = JSON.parse(await readBody(req)) as MessagesRequest
  } catch (err) {
    if (err instanceof Error && err.message === 'request body too large') {
      tooLarge(req, res)
      return undefined
    }
    apiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    return undefined
  }
  if (body === null || typeof body !== 'object') {
    apiError(res, 400, 'invalid_request_error', 'request body must be a JSON object')
    return undefined
  }
  const badTurn = (m: unknown): boolean =>
    m === null ||
    typeof m !== 'object' ||
    ((m as ClientMessage).role !== 'user' && (m as ClientMessage).role !== 'assistant') ||
    (typeof (m as ClientMessage).content !== 'string' &&
      !Array.isArray((m as ClientMessage).content))
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.some(badTurn)
  ) {
    apiError(
      res,
      400,
      'invalid_request_error',
      'messages: a non-empty array of {role: user|assistant, content} turns is required'
    )
    return undefined
  }
  if (stopSeqsOf(body) === undefined) {
    apiError(
      res,
      400,
      'invalid_request_error',
      'stop_sequences: an array of non-empty strings is required'
    )
    return undefined
  }
  return body
}

/** stop_reason for the settled record — a parsed tool_use or a stop
 *  hit outrank the transport's raw code. */
function settledStopReason(
  blocks: OutBlock[],
  reply: PooledReply,
  stopHit: string | undefined
): string {
  if (blocks.some((b) => b.type === 'tool_use')) return 'tool_use'
  if (stopHit !== undefined) return 'stop_sequence'
  return STOP_REASON[reply.stopReason] ?? 'end_turn'
}

async function messages(
  req: IncomingMessage,
  res: ServerResponse,
  wire: WireCtx,
  parent: OtelCtx | undefined
): Promise<void> {
  const body = await parseMessagesBody(req, res)
  if (body === undefined) return
  const t0 = Date.now()
  const key = conversationKey(req, body)
  const stopSeqs = stopSeqsOf(body) ?? []
  const stopKey = stopKeyOf(stopSeqs)
  // one filter per turn — the streamed leg feeds it delta-by-delta,
  // the buffered leg cuts the settled text post-hoc. Either way the
  // recorded reply is `stops.emitted` — exactly what the client saw.
  const stops = new StopFilter(stopSeqs)
  // set when a streamed turn actually opens — a replay or a failed
  // session open never commits the wire to SSE
  let live: LiveTurn | undefined
  let out: TurnOutcome
  try {
    const peer = await wire.link(parent)
    const ac = new AbortController()
    // a dropped client cancels the acp turn — no orphan devin session
    res.once('close', () => ac.abort())
    const msgs = body.messages ?? []
    const requestModel = requestModelOf(body)
    out = await acpTurn({
      body,
      msgs,
      prefix: prefixText(body),
      peer,
      cfg: wire.cfg,
      opts: wire.opts,
      sessions: wire.sessions,
      pendingOpens: wire.pendingOpens,
      key,
      stopKey,
      parent,
      requestModel,
      deadline: Date.now() + wire.cfg.timeoutMs,
      signal: ac.signal,
      by: `conductor:${wire.cfg.backend}`,
      imageOk: peer.caps?.image === true,
      // a streamed answer commits to SSE at turn start — headers and
      // message_start leave before the first delta; a failed turn lands
      // as an in-stream error event, the wire's own dead-stream shape.
      // x-accel-buffering:no stops a proxy from re-buffering the stream
      // back into one end-of-turn burst (amazon-q #566). The turn layer
      // fires this only once a real pump is chosen — a replay never
      // opens the stream, a failed open still answers an HTTP status.
      openStream:
        body.stream === false
          ? undefined
          : (inputTokens) => {
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
                // h: pins echo like respond()'s — the internal f:
                // fingerprint stays server-side
                ...(key?.startsWith('h:') === true ? { 'x-bro-session': key } : {}),
              })
              live = new LiveTurn(
                res,
                servedModel(requestModel, wire.opts, wire.cfg, body),
                inputTokens,
                stops,
                wire.cfg.keepaliveMs ?? 10_000,
                body.tool_choice?.type !== 'none'
              )
              return live.onUpdate
            },
    })
  } catch (err) {
    turnError(res, err, live, wire.cfg.backend, t0)
    return
  }
  // a resend that carried nothing new — replay the recorded reply,
  // no agent round-trip was paid
  if (out.replay === true) {
    respond(res, body, out.conv?.lastReply ?? EMPTY_VIEW, key)
    return
  }
  const reply = out.reply as PooledReply
  const inputTokens = out.inputTokens
  // a live stream pushed the wire deltas as they landed — finish()
  // closes the event shape; the recorded reply is whatever the filter
  // let through — byte-identical to the client's own view
  live?.finish(STOP_REASON[reply.stopReason] ?? 'end_turn')
  if (live === undefined) {
    // the buffered leg's cut lands post-hoc through the same filter
    stops.feed(reply.text)
    stops.flush()
  }
  const view: ReplyView = {
    blocks: parseReply(stops.emitted, body.tool_choice?.type !== 'none'),
    model: reply.model,
    stopReason: live?.stopReason ?? '',
    stopSequence: stops.hit,
    inputTokens,
  }
  if (live === undefined) {
    view.stopReason = settledStopReason(view.blocks, reply, stops.hit)
  }
  if (out.conv !== undefined) {
    settleConv(wire, key, out.conv, body, view, stopKey)
  }
  otelEvent('conductor.turn', {
    backend: wire.cfg.backend,
    model: reply.model,
    stop_reason: view.stopReason,
    stream: body.stream !== false,
    session_reused: out.reused,
    input_tokens: inputTokens,
    output_tokens: live?.outputTokens() ?? estTokens(reply.text),
    duration_ms: Date.now() - t0,
  })
  if (live !== undefined) {
    // the streamed answer already wrote itself — finish() closed the
    // event sequence; only the socket remains
    res.end()
    return
  }
  respond(res, body, view, key)
}

/** Replay fallback shape — a replay always carries a conv, the empty
 *  view only keeps the types honest. */
const EMPTY_VIEW: ReplyView = { blocks: [], model: '', stopReason: '', inputTokens: 0 }

// --- openai /v1/responses dialect (bro-zkpju) --------------------------
//
// Codex's wire. The dialect owns ingress translation (input items →
// the canonical MessagesRequest — sessions, retention, the tools
// contract, and stop filters all reuse the anthropic machinery) and
// egress rendering (OpenAI's item-ordered SSE or a buffered Response).

interface RespItem {
  type?: string
  role?: string
  content?: string | { type?: string; text?: string; image_url?: string }[]
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  output?: string
}

interface ResponsesRequest {
  model?: string
  instructions?: string
  input?: string | RespItem[]
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[]
  tool_choice?: string | { type?: string; name?: string }
  reasoning?: { effort?: string }
  previous_response_id?: string
  store?: boolean
  stream?: boolean
  max_output_tokens?: number
}

function openaiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' })
  }
  res.end(JSON.stringify({ error: { message, type, param: null, code: null } }))
}

/** reasoning.effort folds into the composite model pin — `base-effort`
 *  resolves base + thought_level leaf in one pin (devin's swe-2
 *  family). An existing effort leaf is replaced, not stacked. */
const EFFORT = /-(none|min|minimal|low|medium|high|max)$/i
function effortModel(model: string | undefined, effort: string | undefined): string | undefined {
  if (effort === undefined || effort === '') return model
  const base = model?.replace(EFFORT, '') ?? model
  return base === undefined ? undefined : `${base}-${effort}`
}

/** One input item → canonical turn rows. function_call carries the
 *  call's markup through the tool_use block type — blockText's
 *  serialization IS the <tool_call> wire form, so history replays
 *  verbatim. */
function itemToMessages(it: RespItem): ClientMessage[] {
  if (it.type === 'function_call') {
    let input: unknown = {}
    try {
      input = JSON.parse(it.arguments ?? '{}')
    } catch {
      input = {}
    }
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: it.call_id ?? it.id ?? '',
            name: it.name ?? '',
            input,
          } as InBlock,
        ],
      },
    ]
  }
  if (it.type === 'function_call_output') {
    return [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: it.call_id ?? '',
            content: it.output ?? '',
          } as InBlock,
        ],
      },
    ]
  }
  if (it.type === 'message' || it.type === undefined) {
    const raw =
      typeof it.content === 'string'
        ? [{ type: 'input_text', text: it.content }]
        : (it.content ?? [])
    const parts: InBlock[] = raw
      .map((p): InBlock => {
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
          return { type: 'text', text: p.text ?? '' } as InBlock
        }
        if (p.type === 'input_image' && typeof p.image_url === 'string') {
          const m = /^data:([^;]+);base64,(.+)$/.exec(p.image_url)
          if (m !== null) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: m[1], data: m[2] },
            } as InBlock
          }
          // remote images aren't fetched — a silent drop would let the
          // agent "answer" about an image it never saw
          throw new Error('input_image: only data: URLs are supported')
        }
        // anything else (input_file, input_audio, computer_screenshot,
        // refusal, …) would be a silent semantic drop — the model would
        // answer blind to content the caller paid to send. Fail loudly.
        throw new Error(`unsupported input part type: ${p.type ?? 'unknown'}`)
      })
    return [{ role: it.role ?? 'user', content: parts }]
  }
  // reasoning items, item_reference — opaque to the backend's own
  // reasoning; nothing to replay
  return []
}

function respToolChoice(c: ResponsesRequest['tool_choice']): MessagesRequest['tool_choice'] {
  const t = typeof c === 'string' ? c : c?.type
  if (t === 'required' || t === 'any') return { type: 'any' }
  if (t === 'none') return { type: 'none' }
  if (t === 'function') {
    const name = typeof c === 'object' ? c.name : undefined
    return name === undefined ? { type: 'any' } : { type: 'tool', name }
  }
  return undefined
}

/** A bare-string input is one user turn. */
const stringInput = (s: string): ClientMessage[] =>
  s === '' ? [] : [{ role: 'user', content: s }]

/** Text content of an input item, whatever its wire shape. */
const itemText = (it: RespItem): string =>
  typeof it.content === 'string'
    ? it.content
    : (it.content ?? [])
        .map((p) => {
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            return p.text ?? ''
          }
          // system-tier items take this path, not itemToMessages —
          // a dropped file/image here is the same blind-answer bug
          throw new Error(`unsupported input part type: ${p.type ?? 'unknown'}`)
        })
        .join('')

/** The whole request → canonical body. A translation failure (a
 *  field the dialect can't carry) throws with a client-readable
 *  message — never a silent semantic drop. */
function responsesToBody(r: ResponsesRequest): MessagesRequest {
  const items = typeof r.input === 'string' ? [] : (r.input ?? [])
  // developer- and system-tier items join `instructions` in the
  // canonical body's system slot — never a downgraded user turn
  const isDev = (i: RespItem): boolean =>
    (i.type === 'message' || i.type === undefined) &&
    (i.role === 'developer' || i.role === 'system')
  const systemText = [r.instructions, ...items.filter(isDev).map(itemText)]
    .filter((t): t is string => t !== undefined && t !== '')
    .join('\n')
  const messages: ClientMessage[] =
    typeof r.input === 'string'
      ? stringInput(r.input)
      : items.filter((i) => !isDev(i)).flatMap(itemToMessages)
  const tools = (r.tools ?? [])
    .filter((t) => t.type === 'function' || t.type === undefined)
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  return {
    model: effortModel(r.model, r.reasoning?.effort),
    system: systemText === '' ? undefined : [{ text: systemText }],
    messages,
    tools: tools.length === 0 ? undefined : tools,
    tool_choice: respToolChoice(r.tool_choice),
    stream: r.stream,
  }
}

/** Output items from the canonical reply blocks — the mirror of
 *  itemToMessages. */
function blocksToOutput(blocks: OutBlock[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  if (text !== '' || blocks.every((b) => b.type !== 'tool_use')) {
    items.push({
      id: `msg_${randomBytes(8).toString('hex')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: text === '' ? [] : [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue
    items.push({
      id: b.id,
      type: 'function_call',
      call_id: b.id,
      name: b.name,
      arguments: JSON.stringify(b.input ?? {}),
      status: 'completed',
    })
  }
  return items
}

/** Live OpenAI SSE emission — the same pending/drain pump as LiveTurn
 *  (a <tool_call> tag can still span deltas), rendered as
 *  output_item/content_part events. */
class RespLive extends TagPump {
  private idx = 0
  private open = false
  private acc = ''
  private itemId = `msg_${randomBytes(8).toString('hex')}`
  private partIdx = 0
  private curText = ''
  /** Completed output items in stream order — the SAME ids and shapes
   *  the wire saw; response.completed reports these verbatim so a
   *  client can match the final snapshot to the items it streamed. */
  private readonly items: Record<string, unknown>[] = []

  private capped = false

  constructor(
    private readonly res: ServerResponse,
    private readonly respId: string,
    private readonly model: string,
    private readonly inputTokens: number,
    private readonly store: boolean,
    tools = true,
    private readonly cap?: number
  ) {
    super(tools)
    sse(res, 'response.created', {
      type: 'response.created',
      response: this.respObj('in_progress'),
    })
  }

  private respObj(status: string): Record<string, unknown> {
    return {
      id: this.respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output: this.items,
      store: this.store,
      usage: { input_tokens: this.inputTokens, output_tokens: 0, total_tokens: this.inputTokens },
      error: null,
      ...(status === 'incomplete'
        ? { incomplete_details: { reason: 'max_output_tokens' } }
        : {}),
    }
  }

  readonly onUpdate: NonNullable<PooledTurnOpts['onUpdate']> = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      this.feed(u.content.text)
    }
  }

  private ev(type: string, data: Record<string, unknown>): void {
    sse(this.res, type, { type, ...data })
  }

  private openText(): void {
    if (this.open) return
    this.itemId = `msg_${randomBytes(8).toString('hex')}`
    this.partIdx = 0
    this.curText = ''
    this.ev('response.output_item.added', {
      output_index: this.idx,
      item: {
        id: this.itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    })
    this.ev('response.content_part.added', {
      item_id: this.itemId,
      output_index: this.idx,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
    this.open = true
  }

  protected text(s: string): void {
    if (s === '' || this.capped) return
    let emit = s
    if (this.cap !== undefined && this.acc.length + s.length > this.cap) {
      emit = s.slice(0, Math.max(0, this.cap - this.acc.length))
      this.capped = true
      if (emit === '') return
    }
    this.openText()
    this.ev('response.output_text.delta', {
      item_id: this.itemId,
      output_index: this.idx,
      content_index: this.partIdx,
      delta: emit,
    })
    this.acc += emit
    this.curText += emit
  }

  protected call(name: string, input: unknown): void {
    const json = JSON.stringify(input)
    // a call straddling the cap drops whole — half a function_call is
    // malformed output; the cut flips the terminal event to incomplete
    if (
      this.capped ||
      (this.cap !== undefined && this.acc.length + json.length > this.cap)
    ) {
      this.capped = true
      return
    }
    this.closeItem('completed')
    const callId = `call_${randomBytes(8).toString('hex')}`
    const callItem = {
      id: callId,
      type: 'function_call',
      call_id: callId,
      name,
      arguments: json,
      status: 'completed',
    }
    this.ev('response.output_item.added', {
      output_index: this.idx,
      item: { ...callItem, arguments: '', status: 'in_progress' },
    })
    this.ev('response.function_call_arguments.delta', {
      item_id: callId,
      output_index: this.idx,
      delta: json,
    })
    this.ev('response.function_call_arguments.done', {
      item_id: callId,
      output_index: this.idx,
      arguments: json,
    })
    this.ev('response.output_item.done', { output_index: this.idx, item: callItem })
    this.items.push(callItem)
    this.idx++
    this.acc += json
  }

  private closeItem(status: string): void {
    if (!this.open) return
    const text = this.curText
    this.ev('response.output_text.done', {
      item_id: this.itemId,
      output_index: this.idx,
      content_index: this.partIdx,
      text,
    })
    const part = { type: 'output_text', text, annotations: [] }
    this.ev('response.content_part.done', {
      item_id: this.itemId,
      output_index: this.idx,
      content_index: this.partIdx,
      part,
    })
    const item = {
      id: this.itemId,
      type: 'message',
      status,
      role: 'assistant',
      content: [part],
    }
    this.ev('response.output_item.done', { output_index: this.idx, item })
    this.items.push(item)
    this.open = false
    this.idx++
  }

  /** The settled reply — the terminal event reports the same items
   *  the wire streamed, ids and order intact; a cut-off answer ends
   *  as response.incomplete, not a silent completed. */
  finish(status: string, usageOut: number): void {
    this.drainAll()
    const st = this.capped ? 'incomplete' : status
    this.closeItem(st === 'incomplete' ? 'incomplete' : 'completed')
    this.ev(st === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      response: {
        ...this.respObj(st),
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: usageOut,
          total_tokens: this.inputTokens + usageOut,
        },
      },
    })
  }

  fail(type: string, message: string): void {
    this.drainAll()
    sse(this.res, 'error', { type: 'error', code: type, message })
  }
}

/** Parse-and-translate step shared by the openai dialects — the
 *  request either yields the canonical body or an already-written
 *  error (400 bad shape / untranslatable field, 413 oversized). */
async function parseDialect<T>(
  req: IncomingMessage,
  res: ServerResponse,
  shape: (r: T) => string | undefined,
  translate: (r: T) => MessagesRequest
): Promise<{ rreq: T; body: MessagesRequest } | undefined> {
  let rreq: T
  try {
    rreq = JSON.parse(await readBody(req)) as T
  } catch (err) {
    if (err instanceof Error && err.message === 'request body too large') {
      openaiTooLarge(req, res)
    } else {
      openaiError(res, 400, 'invalid_request_error', 'malformed JSON body')
    }
    return undefined
  }
  const bad = shape(rreq)
  if (bad !== undefined) {
    openaiError(res, 400, 'invalid_request_error', bad)
    return undefined
  }
  try {
    return { rreq, body: translate(rreq) }
  } catch (err) {
    // translation rejects loudly — a remote image, a shape the
    // dialect can't carry; the client fixes the request
    openaiError(
      res,
      400,
      'invalid_request_error',
      err instanceof Error ? err.message : String(err)
    )
    return undefined
  }
}

/** Turn failure → openai wire shape. The in-stream variant reports
 *  'overloaded' for capacity failures while the buffered envelope
 *  keeps 503 as server_error; 429 carries Retry-After either way. */
function openaiFailKind(
  err: unknown,
  msg: string
): { status: number; stream: string; wire: string } {
  if (err instanceof ChainBroken) {
    return { status: 400, stream: 'invalid_request_error', wire: 'invalid_request_error' }
  }
  if (RATE.test(msg)) {
    return { status: 429, stream: 'rate_limit_error', wire: 'rate_limit_error' }
  }
  if (AVAIL.test(msg)) {
    return { status: 503, stream: 'overloaded', wire: 'server_error' }
  }
  return { status: 500, stream: 'server_error', wire: 'server_error' }
}

/** The shared turn-failure tail for both openai dialects. */
function openaiFail(
  res: ServerResponse,
  err: unknown,
  live: { fail(type: string, message: string): void } | undefined
): void {
  const msg = err instanceof Error ? err.message : String(err)
  const kind = openaiFailKind(err, msg)
  if (live !== undefined) {
    live.fail(kind.stream, `bro conductor: ${msg}`)
    res.end()
    return
  }
  if (kind.status === 429) res.setHeader('retry-after', '30')
  openaiError(res, kind.status, kind.wire, `bro conductor: ${msg}`)
}

/** The SSE response preamble — identical across dialects. */
function sseHead(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/** Estimated tokens over recorded blocks — replay output accounting. */
const blocksTokens = (blocks: OutBlock[]): number =>
  estTokens(
    blocks.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b.input ?? {}))).join('')
  )

/** Chain ids a listener can afford to remember — LRU-trimmed like
 *  the sessions map; entries pointing at dead sessions prune away. */
const CHAIN_CAP = 256

function pruneChains(
  chains: Map<string, { key: string; consumed: number }>,
  sessions: Map<string, ConvSession>
): void {
  for (const [id, e] of chains) {
    if (!sessions.has(e.key)) chains.delete(id)
  }
  let overflow = chains.size - CHAIN_CAP
  for (const id of chains.keys()) {
    if (overflow <= 0) break
    chains.delete(id)
    overflow--
  }
}

/** Response envelope — the same object shape streamed or buffered. */
function respEnvelope(
  respId: string,
  model: string,
  status: string,
  output: unknown[],
  store: boolean,
  inputTokens: number,
  outTokens: number
): Record<string, unknown> {
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    store,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outTokens,
      total_tokens: inputTokens + outTokens,
    },
    error: null,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  }
}

/** acp stop_reason → Response.status — a truncated answer is
 *  incomplete, never a silent success. */
const respStatus = (canonicalReason: string): string =>
  canonicalReason === 'max_tokens' ? 'incomplete' : 'completed'

/** A caller's output-token budget expressed in chars — the inverse of
 *  estTokens' ~4-chars-per-token estimate. Honored, not authoritative. */
const capCharsOf = (tokens: number | undefined): number | undefined =>
  typeof tokens === 'number' && tokens > 0 ? tokens * 4 : undefined

/** Cut recorded blocks at the output cap. Text truncates at the cut;
 *  a tool_use block straddling it drops whole — half a function_call
 *  is malformed output. */
function capBlocks(
  blocks: OutBlock[],
  cap: number | undefined
): { blocks: OutBlock[]; capped: boolean } {
  if (cap === undefined) return { blocks, capped: false }
  let used = 0
  const kept: OutBlock[] = []
  for (const b of blocks) {
    const len = blockLen(b)
    if (used + len > cap) {
      if (b.type === 'text' && used < cap) {
        kept.push({ ...b, text: (b.text ?? '').slice(0, cap - used) })
      }
      return { blocks: kept, capped: true }
    }
    kept.push(b)
    used += len
  }
  return { blocks: kept, capped: false }
}

/** A block's weight against an output cap — text by chars, a tool
 *  call by its serialized arguments. */
function blockLen(b: OutBlock): number {
  if (b.type === 'text') return (b.text ?? '').length
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}).length
  return 0
}

/** Terminal reason for a Responses turn: the post-hoc cap wins over
 *  a tool_use that survived it, else the canonical backend reason. */
function finalRespReason(capped: boolean, blocks: OutBlock[], canonical: string): string {
  if (capped) return 'max_tokens'
  if (blocks.some((b) => b.type === 'tool_use')) return 'tool_use'
  return canonical
}

/** input shape gate for /v1/responses. */
const respShape = (r: ResponsesRequest): string | undefined =>
  r.input === undefined || (typeof r.input !== 'string' && !Array.isArray(r.input))
    ? 'input: a string or an items array is required'
    : undefined

/** The model label a recorded reply or the wire config resolves to. */
function respModel(wire: WireCtx, body: MessagesRequest, recorded?: string): string {
  if (recorded !== undefined && recorded !== '') return recorded
  return servedModel(undefined, wire.opts, wire.cfg, body)
}

/** Replay branch — a resend carried nothing new; answer the recorded
 *  reply in the openai envelope (or the SSE sequence when the resend
 *  asked for a stream). The replay id registers too: chaining off a
 *  replayed response lands on the same live conversation. */
interface RespReplayCtx {
  rreq: ResponsesRequest
  out: TurnOutcome
  respId: string
  key: string | undefined
  store: boolean
  chains: Map<string, { key: string; consumed: number }>
}

function responsesReplay(res: ServerResponse, wire: WireCtx, ctx: RespReplayCtx): void {
  const { rreq, out, respId, key, store, chains } = ctx
  const lr = out.conv?.lastReply
  const capped = capBlocks(lr?.blocks ?? [], capCharsOf(rreq.max_output_tokens))
  const blocks = capped.blocks
  const model = respModel(wire, {}, lr?.model)
  const status = capped.capped ? 'incomplete' : respStatus(lr?.stopReason ?? '')
  if (store && out.conv !== undefined && key !== undefined) {
    chains.set(respId, { key, consumed: out.conv.consumed })
    pruneChains(chains, wire.sessions)
  }
  if (rreq.stream === true) {
    sseHead(res)
    const rl = new RespLive(
      res,
      respId,
      model,
      lr?.inputTokens ?? 0,
      store,
      true,
      capCharsOf(rreq.max_output_tokens)
    )
    rl.replay(blocks)
    rl.finish(status, blocksTokens(blocks))
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify(
      respEnvelope(
        respId,
        model,
        status,
        blocksToOutput(blocks),
        store,
        lr?.inputTokens ?? 0,
        blocksTokens(blocks)
      )
    )
  )
}

/** The retained-conversation key a responses turn writes under — a
 *  chained predecessor wins; else store:true (or an explicit session
 *  pin) fingerprints this request. An unknown predecessor just starts
 *  fresh (fingerprint), never an invention; a KNOWN-but-broken one
 *  fails inside acpTurn rather than answering from history-less
 *  state. */
function respConvKey(
  req: IncomingMessage,
  rreq: ResponsesRequest,
  body: MessagesRequest,
  hit: { key: string; consumed: number } | undefined,
  store: boolean
): string | undefined {
  if (hit !== undefined) return hit.key
  // store:false — stateless on OUR side: no chain id registers, but
  // a valid previous_response_id (or an x-bro-session pin) still
  // chains the turn — predecessor lookup is independent of whether
  // this response gets stored.
  if (!store && req.headers['x-bro-session'] === undefined) return undefined
  return conversationKey(req, body)
}

/** The SSE opener for a streamed Responses turn — OpenAI semantics:
 *  buffered unless stream === true (inverted vs the anthropic
 *  dialect's own default). `set` hands the RespLive back so the
 *  caller's catch/finish paths can reach it. */
function respStreamOpener(
  rreq: ResponsesRequest,
  res: ServerResponse,
  wire: WireCtx,
  d: {
    respId: string
    body: MessagesRequest
    tools: boolean
    store: boolean
    set: (live: RespLive) => void
  }
): ((inputTokens: number) => PooledTurnOpts['onUpdate']) | undefined {
  if (rreq.stream !== true) return undefined
  return (inputTokens) => {
    sseHead(res)
    const live = new RespLive(
      res,
      d.respId,
      servedModel(requestModelOf(d.body), wire.opts, wire.cfg, d.body),
      inputTokens,
      d.store,
      d.tools,
      capCharsOf(rreq.max_output_tokens)
    )
    d.set(live)
    return live.onUpdate
  }
}

async function responses(
  req: IncomingMessage,
  res: ServerResponse,
  wire: WireCtx,
  chains: Map<string, { key: string; consumed: number }>,
  parent: OtelCtx | undefined
): Promise<void> {
  const parsed = await parseDialect<ResponsesRequest>(req, res, respShape, responsesToBody)
  if (parsed === undefined) return
  const { rreq, body } = parsed
  const t0 = Date.now()
  const store = rreq.store !== false
  const respId = `resp_${randomBytes(12).toString('hex')}`
  const hit =
    rreq.previous_response_id !== undefined ? chains.get(rreq.previous_response_id) : undefined
  const key = respConvKey(req, rreq, body, hit, store)
  const tools = body.tool_choice?.type !== 'none'
  let live: RespLive | undefined
  let out: TurnOutcome
  try {
    const peer = await wire.link(parent)
    const ac = new AbortController()
    res.once('close', () => ac.abort())
    out = await acpTurn({
      body,
      msgs: body.messages ?? [],
      prefix: prefixText(body),
      peer,
      cfg: wire.cfg,
      opts: wire.opts,
      sessions: wire.sessions,
      pendingOpens: wire.pendingOpens,
      key,
      stopKey: stopKeyOf(stopSeqsOf(body) ?? []),
      chained: hit !== undefined,
      chainConsumed: hit?.consumed,
      parent,
      requestModel: requestModelOf(body),
      deadline: Date.now() + wire.cfg.timeoutMs,
      signal: ac.signal,
      by: `conductor:${wire.cfg.backend}`,
      imageOk: peer.caps?.image === true,
      openStream: respStreamOpener(rreq, res, wire, {
        respId,
        body,
        tools,
        store,
        set: (l) => (live = l),
      }),
    })
  } catch (err) {
    openaiFail(res, err, live)
    return
  }
  if (out.replay === true) {
    responsesReplay(res, wire, { rreq, out, respId, key, store, chains })
    return
  }
  responsesDeliver(res, wire, {
    rreq,
    body,
    out,
    respId,
    key,
    store,
    chains,
    live,
    t0,
    chained: hit !== undefined,
  })
}

/** Post-turn settlement for /v1/responses — settle the retained
 *  conversation (always: a non-stored chained turn still consumed its
 *  delta in the predecessor's session — skipping it leaves consumed
 *  behind and later chains read hidden turns), register the chain id
 *  when storing, emit the turn event, write the terminal response. */
function responsesDeliver(
  res: ServerResponse,
  wire: WireCtx,
  d: {
    rreq: ResponsesRequest
    body: MessagesRequest
    out: TurnOutcome
    respId: string
    key: string | undefined
    store: boolean
    chains: Map<string, { key: string; consumed: number }>
    live: RespLive | undefined
    t0: number
    chained: boolean
  }
): void {
  const reply = d.out.reply as PooledReply
  const inputTokens = d.out.inputTokens
  // withheld tool contracts never produce tool blocks — an agent
  // emitting markup anyway stays raw text, not an invented call
  const tools = d.body.tool_choice?.type !== 'none'
  // the cap reports the same canonical reason the acp's own ceiling
  // would — replay and status agree the answer was cut
  const capped = capBlocks(parseReply(reply.text, tools), capCharsOf(d.rreq.max_output_tokens))
  const outBlocks = capped.blocks
  const canonicalReason = capped.capped
    ? 'max_tokens'
    : (STOP_REASON[reply.stopReason] ?? 'end_turn')
  const outTokens = capped.capped ? blocksTokens(outBlocks) : estTokens(reply.text)
  const status = respStatus(finalRespReason(capped.capped, outBlocks, canonicalReason))
  if (d.out.conv !== undefined && d.key !== undefined) {
    settleConv(
      wire,
      d.key,
      d.out.conv,
      d.body,
      {
        blocks: outBlocks,
        model: reply.model,
        stopReason: canonicalReason,
        inputTokens,
      },
      stopKeyOf(stopSeqsOf(d.body) ?? []),
      d.chained
    )
    if (d.store) {
      d.chains.set(d.respId, { key: d.key, consumed: d.out.conv.consumed })
      pruneChains(d.chains, wire.sessions)
    }
  }
  otelEvent('conductor.turn', {
    backend: wire.cfg.backend,
    dialect: 'responses',
    model: reply.model,
    stream: d.rreq.stream === true,
    session_reused: d.out.reused,
    input_tokens: inputTokens,
    output_tokens: outTokens,
    duration_ms: Date.now() - d.t0,
  })
  if (d.live !== undefined) {
    d.live.finish(status, outTokens)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify(
      respEnvelope(
        d.respId,
        servedModel(requestModelOf(d.body), wire.opts, wire.cfg, d.body),
        status,
        blocksToOutput(outBlocks),
        d.store,
        inputTokens,
        outTokens
      )
    )
  )
}

// --- openai /v1/chat/completions dialect -------------------------------
//
// The legacy chat wire — stateless by contract (the client resends
// history every turn), so the fingerprint path does all retention
// work unmodified; only ingress translation and the choice/delta
// egress shape are new.

interface ChatMessage {
  role?: string
  content?: string | { type?: string; text?: string; image_url?: string | { url?: string } }[]
  tool_calls?: {
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
  tool_call_id?: string
}

interface ChatRequest {
  model?: string
  messages?: ChatMessage[]
  tools?: { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[]
  tool_choice?: string | { type?: string; function?: { name?: string } }
  reasoning_effort?: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_completion_tokens?: number
  max_tokens?: number
}

function chatContent(c: ChatMessage['content']): InBlock[] {
  if (typeof c === 'string') return c === '' ? [] : [{ type: 'text', text: c } as InBlock]
  return (c ?? []).map((p): InBlock => {
    if (p.type === 'text') return { type: 'text', text: p.text ?? '' } as InBlock
    if (p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url
      const m = url !== undefined ? /^data:([^;]+);base64,(.+)$/.exec(url) : null
      if (m != null) {
        return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } as InBlock
      }
      // remote images aren't fetched — a silent drop would let the
      // agent "answer" about an image it never saw
      throw new Error('image_url: only data: URLs are supported')
    }
    // unknown content parts (audio, file, …) fail loudly — the model
    // must not answer blind to content the caller sent
    throw new Error(`unsupported content part type: ${p.type ?? 'unknown'}`)
  })
}

/** One chat message → canonical rows. assistant.tool_calls ride as
 *  tool_use blocks (history replays verbatim); role:'tool' is the
 *  caller's own tool result — a user-side tool_result. */
function chatToMessages(m: ChatMessage): ClientMessage[] {
  if (m.role === 'system' || m.role === 'developer') return []
  if (m.role === 'tool') {
    const toolText =
      typeof m.content === 'string'
        ? m.content
        : chatContent(m.content)
            .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
            .join('')
    return [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: toolText,
          } as InBlock,
        ],
      },
    ]
  }
  const content = chatContent(m.content)
  for (const tc of m.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(tc.function?.arguments ?? '{}')
    } catch {
      input = {}
    }
    content.push({
      type: 'tool_use',
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      input,
    } as InBlock)
  }
  return [{ role: m.role === 'assistant' ? 'assistant' : 'user', content }]
}

function chatToolChoice(c: ChatRequest['tool_choice']): MessagesRequest['tool_choice'] {
  const t = typeof c === 'string' ? c : c?.type
  if (t === 'required') return { type: 'any' }
  if (t === 'none') return { type: 'none' }
  if (t === 'function') {
    const name = typeof c === 'object' ? c.function?.name : undefined
    return name === undefined ? { type: 'any' } : { type: 'tool', name }
  }
  return undefined
}

function chatToBody(r: ChatRequest): MessagesRequest {
  const system = (r.messages ?? [])
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => ({
      text: chatContent(m.content)
        .map((b) => {
          if (b.type === 'text') return (b as { text: string }).text
          // a parsed image/file block folded to '' is a silent drop —
          // system-tier messages carry text or they 400
          throw new Error('system/developer messages support text content only')
        })
        .join(''),
    }))
  const messages = (r.messages ?? [])
    .filter((m) => m.role !== 'system' && m.role !== 'developer')
    .flatMap(chatToMessages)
  const tools = (r.tools ?? [])
    .filter((t) => t.type === 'function' || t.type === undefined)
    .map((t) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    }))
  return {
    model: effortModel(r.model, r.reasoning_effort),
    system: system.length === 0 ? undefined : system,
    messages,
    tools: tools.length === 0 ? undefined : tools,
    tool_choice: chatToolChoice(r.tool_choice),
    stream: r.stream,
  }
}

/** Canonical reply blocks → the assistant message row —
 *  tool_use becomes OpenAI tool_calls, text joins into content. */
function chatMessage(blocks: OutBlock[]): Record<string, unknown> {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const calls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id === '' ? `call_${randomBytes(8).toString('hex')}` : b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }))
  return {
    role: 'assistant',
    content: text === '' ? null : text,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  }
}

const CHAT_FINISH = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
  max_tokens: 'length',
} as const

/** Live chat-completion SSE — the same pending/drain pump rendered
 *  as choices[0].delta rows; [DONE] is the wire's own terminator. */
class ChatLive extends TagPump {
  private callIdx = 0
  private first = true
  private accLen = 0
  private capped = false

  constructor(
    private readonly res: ServerResponse,
    private readonly id: string,
    private readonly model: string,
    private readonly created: number,
    tools = true,
    private readonly cap?: number
  ) {
    super(tools)
  }

  private ev(delta: Record<string, unknown>, finish: string | null = null): void {
    const obj = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
    this.res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  private head(): void {
    if (!this.first) return
    this.first = false
    this.ev({ role: 'assistant' })
  }

  readonly onUpdate: NonNullable<PooledTurnOpts['onUpdate']> = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
      this.feed(u.content.text)
    }
  }

  protected text(s: string): void {
    if (s === '' || this.capped) return
    let emit = s
    if (this.cap !== undefined && this.accLen + s.length > this.cap) {
      emit = s.slice(0, Math.max(0, this.cap - this.accLen))
      this.capped = true
      if (emit === '') return
    }
    this.head()
    this.ev({ content: emit })
    this.accLen += emit.length
  }

  protected call(name: string, input: unknown): void {
    const json = JSON.stringify(input)
    // a call straddling the cap drops whole — half a tool_call is
    // malformed output; the cut reports finish_reason 'length'
    if (
      this.capped ||
      (this.cap !== undefined && this.accLen + json.length > this.cap)
    ) {
      this.capped = true
      return
    }
    this.head()
    this.accLen += json.length
    this.ev({
      tool_calls: [
        {
          index: this.callIdx,
          id: `call_${randomBytes(8).toString('hex')}`,
          type: 'function',
          function: { name, arguments: json },
        },
      ],
    })
    this.callIdx++
  }

  /** Final delta + optional usage chunk + [DONE]. */
  finish(stopReason: string, usage?: Record<string, unknown>): void {
    this.drainAll()
    this.head()
    const finishReason = this.capped
      ? 'length'
      : (CHAT_FINISH[stopReason as keyof typeof CHAT_FINISH] ?? 'stop')
    this.ev({}, finishReason)
    if (usage !== undefined) {
      this.res.write(
        `data: ${JSON.stringify({
          id: this.id,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [],
          usage,
        })}\n\n`
      )
    }
    this.res.write('data: [DONE]\n\n')
  }

  fail(type: string, message: string): void {
    this.drainAll()
    this.res.write(`data: ${JSON.stringify({ error: { message, type } })}\n\n`)
    this.res.write('data: [DONE]\n\n')
  }
}

/** messages shape gate for /v1/chat/completions. */
const chatShape = (r: ChatRequest): string | undefined =>
  !Array.isArray(r.messages) || r.messages.length === 0
    ? 'messages: a non-empty array is required'
    : undefined

/** The canonical stop reason over a turn outcome — a replay reports
 *  the recorded reason, a live turn reads the reply's own. */
function chatStopReason(
  replay: boolean,
  lr: ConvSession['lastReply'] | undefined,
  blocks: OutBlock[],
  reply: PooledReply | undefined
): string {
  if (replay) return lr?.stopReason ?? 'end_turn'
  if (blocks.some((b) => b.type === 'tool_use')) return 'tool_use'
  return STOP_REASON[reply?.stopReason ?? ''] ?? 'end_turn'
}

/** Chat outcome materialization — a replay reads the recorded reply;
 *  a fresh turn parses live text. Either way the caller gets one
 *  normalized bundle. */
function chatOutcome(
  out: TurnOutcome,
  tools: boolean
): {
  replay: boolean
  lr: ConvSession['lastReply'] | undefined
  reply: PooledReply | undefined
  inputTokens: number
  blocks: OutBlock[]
  outTokens: number
  stopReason: string
  finish: string
} {
  const replay = out.replay === true
  const lr = out.conv?.lastReply
  const reply = replay ? undefined : (out.reply as PooledReply)
  const inputTokens = replay ? (lr?.inputTokens ?? 0) : out.inputTokens
  const blocks = replay ? (lr?.blocks ?? []) : parseReply(reply?.text ?? '', tools)
  const outTokens = replay ? blocksTokens(blocks) : estTokens(reply?.text ?? '')
  const stopReason = chatStopReason(replay, lr, blocks, reply)
  const finish =
    CHAT_FINISH[stopReason as keyof typeof CHAT_FINISH] ??
    (blocks.some((b) => b.type === 'tool_use') ? 'tool_calls' : 'stop')
  return { replay, lr, reply, inputTokens, blocks, outTokens, stopReason, finish }
}

/** POST /v1/chat/completions — the stateless chat dialect. No chain
 *  ledger: retention is the client's resend, proven by fingerprint. */
async function chatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  wire: WireCtx,
  parent: OtelCtx | undefined
): Promise<void> {
  const parsed = await parseDialect<ChatRequest>(req, res, chatShape, chatToBody)
  if (parsed === undefined) return
  const { rreq: creq, body } = parsed
  const t0 = Date.now()
  const key = conversationKey(req, body)
  const chatId = `chatcmpl-${randomBytes(12).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const model = servedModel(requestModelOf(body), wire.opts, wire.cfg, body)
  const tools = body.tool_choice?.type !== 'none'
  let live: ChatLive | undefined
  let out: TurnOutcome
  try {
    const peer = await wire.link(parent)
    const ac = new AbortController()
    res.once('close', () => ac.abort())
    out = await acpTurn({
      body,
      msgs: body.messages ?? [],
      prefix: prefixText(body),
      peer,
      cfg: wire.cfg,
      opts: wire.opts,
      sessions: wire.sessions,
      pendingOpens: wire.pendingOpens,
      key,
      stopKey: stopKeyOf(stopSeqsOf(body) ?? []),
      parent,
      requestModel: requestModelOf(body),
      deadline: Date.now() + wire.cfg.timeoutMs,
      signal: ac.signal,
      by: `conductor:${wire.cfg.backend}`,
      imageOk: peer.caps?.image === true,
      openStream:
        creq.stream === true
          ? () => {
              sseHead(res)
              live = new ChatLive(
                res,
                chatId,
                model,
                created,
                tools,
                capCharsOf(creq.max_completion_tokens ?? creq.max_tokens)
              )
              return live.onUpdate
            }
          : undefined,
    })
  } catch (err) {
    openaiFail(res, err, live)
    return
  }
  chatDeliver(res, wire, { creq, body, out, key, chatId, created, model, tools, live, t0 })
}

/** Post-turn settlement for /v1/chat/completions — replay → recorded
 *  blocks; fresh → settle the conversation, emit the turn event, then
 *  answer SSE (stream:true resends never see a JSON snapshot) or the
 *  buffered completion. */
function chatDeliver(
  res: ServerResponse,
  wire: WireCtx,
  d: {
    creq: ChatRequest
    body: MessagesRequest
    out: TurnOutcome
    key: string | undefined
    chatId: string
    created: number
    model: string
    tools: boolean
    live: ChatLive | undefined
    t0: number
  }
): void {
  const o = chatOutcome(d.out, d.tools)
  const cap = capCharsOf(d.creq.max_completion_tokens ?? d.creq.max_tokens)
  const capped = capBlocks(o.blocks, cap)
  const blocks = capped.blocks
  // the cap reports the same canonical reason the acp's own ceiling
  // would — a resend replays the cut, not the uncut original
  const stopReason = capped.capped ? 'max_tokens' : o.stopReason
  const finish = capped.capped ? 'length' : o.finish
  const outTokens = capped.capped ? blocksTokens(blocks) : o.outTokens
  if (!o.replay && d.out.conv !== undefined) {
    settleConv(
      wire,
      d.key,
      d.out.conv,
      d.body,
      {
        blocks,
        model: (o.reply as PooledReply).model,
        stopReason,
        inputTokens: o.inputTokens,
      },
      stopKeyOf(stopSeqsOf(d.body) ?? [])
    )
  }
  const usage = {
    prompt_tokens: o.inputTokens,
    completion_tokens: outTokens,
    total_tokens: o.inputTokens + outTokens,
  }
  otelEvent('conductor.turn', {
    backend: wire.cfg.backend,
    dialect: 'chat_completions',
    model: o.reply?.model ?? o.lr?.model ?? '',
    stream: d.creq.stream === true,
    session_reused: d.out.reused,
    input_tokens: o.inputTokens,
    output_tokens: outTokens,
    duration_ms: Date.now() - d.t0,
  })
  const usageOrUndef =
    d.creq.stream_options?.include_usage === true ? usage : undefined
  if (o.replay && d.creq.stream === true) {
    sseHead(res)
    const rl = new ChatLive(res, d.chatId, d.model, d.created, d.tools, cap)
    rl.replay(blocks)
    rl.finish(stopReason, usageOrUndef)
    res.end()
    return
  }
  if (d.live !== undefined) {
    d.live.finish(stopReason, usageOrUndef)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: d.chatId,
      object: 'chat.completion',
      created: d.created,
      model: o.reply?.model ?? o.lr?.model ?? d.model,
      choices: [
        { index: 0, message: chatMessage(blocks), finish_reason: finish, logprobs: null },
      ],
      usage,
    })
  )
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
  // the store-side evidence trail — every conductor.* event lands as a
  // JSONL row next to serve.json so a dogfood analyst can read routing,
  // model pin and session reuse without an OTLP collector
  const common = gitCommonDir(cfg.cwd)
  if (common !== null) otelJournal(join(common, 'bro', 'serve-turns.jsonl'))
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
  // keys whose first session/new is in flight — a concurrent same-key
  // request must not open a twin (the loser would leak unmapped)
  const pendingOpens = new Set<string>()
  // /v1/responses chain ledger: response id → the conv key + the
  // consumed count it was recorded at. The count is what makes a
  // previous_response_id a real predecessor: a session that moved
  // past it means the caller branched — rejected, not resumed.
  const chains = new Map<string, { key: string; consumed: number }>()
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
  const wire: WireCtx = { cfg, opts: wireOpts, link: getLink, sessions, pendingOpens }
  const routes = new Map<
    string,
    (r: IncomingMessage, s: ServerResponse, p: OtelCtx | undefined) => void | Promise<void>
  >([
    ['POST /v1/messages', (r, s, p) => messages(r, s, wire, p)],
    ['POST /v1/responses', (r, s, p) => responses(r, s, wire, chains, p)],
    ['POST /v1/chat/completions', (r, s, p) => chatCompletions(r, s, wire, p)],
    ['POST /v1/messages/count_tokens', (r, s) => countTokens(r, s)],
    ['GET /v1/models', (_r, s) => models(s, cfg, wireOpts)],
  ])
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    const httpSpan = httpTap(req, res, cfg, method, path)
    const route = routes.get(`${method} ${path}`)
    if (route === undefined) {
      apiError(res, 404, 'not_found_error', `bro conductor: no route ${method} ${path}`)
      return
    }
    await route(req, res, httpSpan.ctx)
  }
}

/** The per-request span + request-finished telemetry tap — one
 *  session = one trace: an instrumented caller's traceparent parents
 *  every span we emit; local agents that don't propagate are still
 *  attributed by process tree (peer.*). */
function httpTap(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ConductorConfig,
  method: string,
  path: string
): ReturnType<typeof otelSpan> {
  const t0 = Date.now()
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
  return httpSpan
}

/** POST /v1/messages/count_tokens — the heuristic estimate; an
 *  oversized body gets the same 413 lifecycle as the dialects. */
async function countTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    apiErrorCountTokens(res, await readBody(req))
  } catch (err) {
    if (err instanceof Error && err.message === 'request body too large') {
      tooLarge(req, res)
    } else {
      apiError(res, 400, 'invalid_request_error', 'malformed request body')
    }
  }
}

function apiErrorCountTokens(res: ServerResponse, raw: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ input_tokens: estTokens(raw) }))
}
