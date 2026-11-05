/**
 * `brouter ask` — one question to an ACP agent, the answer printed.
 *
 * The protocol is the binding's: `acpConverse` runs initialize →
 * session/new → model pin → prompt → pump and hands back the agent's
 * text. brouter adds the CLI around it — the provider's name, the
 * deadline, the shape of the answer.
 *
 * The LANE is the router's own business, and the rule that chose it is
 * part of the answer: the route table decides when the operator declares
 * one, the operator's `--provider` overrides the table, and with neither
 * the first acp entry answers. Whichever rule fired, the explanation
 * names it — "the first acp provider in the config" and "the route
 * `edit` — its first acp entry" are different facts.
 *
 * The turn is recorded in the router's own ledger: the traffic counters
 * and the session it ran in. Best-effort — a ledger that cannot take it
 * costs the numbers, never the answer.
 */
import { estimateTokens, getProvider, healthKey, loadConfig, withSlice } from '@broject/core';
import type {
  ExplainFact,
  ExplainSlice,
  Explanation,
  HealthSnapshot,
  ProviderEntry,
} from '@broject/core';
import { acpConverse } from '@broject/providers';
import type { AcpUsage } from '@broject/providers';
import { readRouteTable, unservedChains } from '@broject/router-routes';
import type { RouteDecision, RouteTable } from '@broject/router-routes';
import { costFacts, healthFacts, modelFacts, routeFacts, type ModelPin } from './explain.ts';
import { ledgerHealth, recordTurn, windowCounters } from './ledger.ts';
import { decideRoute, type TaskDecision } from './route-decide.ts';

/** An acp provider entry — the shape the ask path speaks. */
type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

/** The providers the ask may pick from — the config's own map. */
type Providers = Record<string, ProviderEntry>;

/** The ask request. */
export interface AskRequest {
  /** the provider entry — absent resolves through the route table */
  provider?: string;
  /** the question */
  question: string;
  /** the model to pin — the entry's own pin when absent */
  model?: string;
  /** the round-trip budget */
  timeoutMs?: number;
  /** the working directory of the session */
  cwd?: string;
  /** the route table the request is routed by — absent = no table */
  routes?: string;
  /** the explanation's slices — absent = no explanation */
  slices?: ExplainSlice[];
}

/** What the agent answered. */
export interface AskOutcome {
  provider: string;
  model: string;
  stopReason: string;
  text: string;
  /** the turn's reported usage — absent when the agent reports none */
  usage?: AcpUsage;
  /** the explanation — when the caller asked for one */
  explanation?: Explanation;
}

/** The lane that serves an ask — and the rule that chose it. */
export interface LanePick {
  /** the lane's provider name */
  provider: string;
  /** the entry behind it */
  entry: AcpEntry;
  /** the model the route pins — absent when the route pins none */
  model?: string;
  /** who pinned the model */
  pinnedBy: ModelPin;
  /** the route that chose the lane — when the table did */
  route?: string;
  /** the rule that chose the lane */
  rule: string;
  /** where the rule came from */
  ruleSource: string;
  /** the table's verdict — when the table was consulted */
  decision?: RouteDecision;
  /** the health the decision read — what the router saw when it chose.
   *  Absent when nobody decided (the operator named the lane). */
  snapshot?: HealthSnapshot;
  /** false when the ledger could not be read at decision time */
  healthKnown?: boolean;
}

/** The acp entries, in config order. */
export function acpProviders(providers: Providers): string[] {
  return Object.entries(providers)
    .filter(([, entry]) => entry.type === 'acp')
    .map(([name]) => name);
}

/** The provider the operator named — an unknown name is an error naming
 *  the known ones, a non-acp entry an error naming its kind. */
function namedProvider(providers: Providers, wanted: string): string {
  const entry = providers[wanted];
  if (entry === undefined) {
    throw new Error(
      `unknown provider "${wanted}" — configured: ${Object.keys(providers).join(', ') || 'none'}`
    );
  }
  if (entry.type !== 'acp') {
    throw new Error(`provider "${wanted}" is a ${entry.type} entry — ask needs an acp one`);
  }
  return wanted;
}

/** The first acp entry — the fallback when nobody named one. */
function firstAcp(providers: Providers): string {
  const first = acpProviders(providers)[0];
  if (first === undefined) {
    throw new Error('no acp provider configured — add providers.<name> to bro.config.json');
  }
  return first;
}

/** The provider an ask runs against — the named one, else the first
 *  acp entry. */
export function resolveProvider(providers: Providers, name?: string): string {
  const wanted = name?.trim();
  if (wanted === undefined || wanted === '') {
    return firstAcp(providers);
  }
  return namedProvider(providers, wanted);
}

/** The entry behind a provider name — an acp one, always. */
export function acpEntry(providers: Providers, name: string): AcpEntry {
  const entry = getProvider(providers, name);
  if (entry.type !== 'acp') {
    throw new Error(
      `provider "${name}" is a ${entry.type} entry — the acp clients need an acp one`
    );
  }
  return entry;
}

/** The acp entry of a provider name — undefined when the name is not a
 *  configured acp entry. */
function acpOf(providers: Providers, name: string): AcpEntry | undefined {
  const entry = providers[name];
  return entry !== undefined && entry.type === 'acp' ? entry : undefined;
}

/** The chain's first acp entry — the lane that can answer an ACP ask. A
 *  gateway lane cannot: ask speaks ACP. */
function laneFromChain(
  providers: Providers,
  chain: { provider: string; model?: string }[]
): { provider: string; entry: AcpEntry; model?: string } | undefined {
  for (const link of chain) {
    const entry = acpOf(providers, link.provider);
    if (entry !== undefined) {
      return {
        provider: link.provider,
        entry,
        model: link.model,
      };
    }
  }
  return undefined;
}

/** The table the request is routed by — absent when the operator declares
 *  none. A table that contradicts the served declaration is a config
 *  error, never a silent fallback. */
function tableOf(dir: string, request: AskRequest): RouteTable | undefined {
  if (request.routes === undefined) {
    return undefined;
  }
  let table: RouteTable;
  try {
    table = readRouteTable(request.routes);
  } catch (err) {
    throw new Error(
      `route table ${request.routes} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const unserved = unservedChains(table, loadConfig(dir).brouter?.models ?? {});
  const first = unserved[0];
  if (first !== undefined) {
    throw new Error(`route table ${request.routes} — routes.${first.route}: ${first.reason}`);
  }
  return table;
}

/** The rule that chose the lane — the table's verdict, or the fallback's
 *  reason for standing in. */
function fallbackRule(decision: RouteDecision | undefined): { rule: string; source: string } {
  if (decision === undefined) {
    return { rule: 'the first acp provider in the config', source: 'the config' };
  }
  if (decision.route === undefined) {
    return {
      rule: 'no route in the table fits this task — the first acp provider in the config',
      source: 'the table',
    };
  }
  return {
    rule: `the route "${decision.route.name}" has no acp entry — the first acp provider in the config`,
    source: 'the table',
  };
}

/** The lane the operator named — their choice, the table does not argue. */
function namedLane(providers: Providers, request: AskRequest): LanePick {
  const provider = resolveProvider(providers, request.provider);
  return {
    provider,
    entry: acpEntry(providers, provider),
    pinnedBy: 'the provider entry',
    rule: 'you named it',
    ruleSource: 'you',
  };
}

/** The lane the table's chain points at — its first acp entry. */
function tableLanePick(
  lane: { provider: string; entry: AcpEntry; model?: string },
  task: TaskDecision
): LanePick {
  const decision = task.decision;
  const route = decision.route?.name;
  return {
    provider: lane.provider,
    entry: lane.entry,
    model: lane.model,
    pinnedBy: lane.model === undefined ? 'the provider entry' : 'the route',
    route,
    rule: `the route "${route}" — its first acp entry`,
    ruleSource: 'the table',
    decision,
    snapshot: task.snapshot,
    healthKnown: task.healthKnown,
  };
}

/** The lane that answers when nothing else does — and the rule that
 *  stood in, with the table's verdict beside it. */
function fallbackLane(providers: Providers, task: TaskDecision | undefined): LanePick {
  const fallback = fallbackRule(task?.decision);
  const provider = resolveProvider(providers);
  return {
    provider,
    entry: acpEntry(providers, provider),
    pinnedBy: 'the provider entry',
    rule: fallback.rule,
    ruleSource: fallback.source,
    decision: task?.decision,
    snapshot: task?.snapshot,
    healthKnown: task?.healthKnown,
  };
}

/** The table's verdict for the ask — the task carries no shape, so only
 *  a catch-all route fits it. */
async function tableDecision(
  dir: string,
  table: RouteTable,
  request: AskRequest
): Promise<TaskDecision> {
  const router = loadConfig(dir).brouter?.router;
  return decideRoute({
    dir,
    table,
    task: {},
    text: request.question,
    router,
  });
}

/** The lane the ask runs against — the operator's choice, then the table's
 *  chain, then the first acp entry. */
export async function resolveLane(dir: string, request: AskRequest): Promise<LanePick> {
  const providers = loadConfig(dir).providers ?? {};
  if (request.provider !== undefined && request.provider.trim() !== '') {
    return namedLane(providers, request);
  }
  const table = tableOf(dir, request);
  if (table === undefined) {
    return fallbackLane(providers, undefined);
  }
  const task = await tableDecision(dir, table, request);
  const lane = laneFromChain(providers, task.decision.chain);
  if (lane === undefined) {
    return fallbackLane(providers, task);
  }
  return tableLanePick(lane, task);
}

/** The model's pin — the operator's, then the route's, then the entry's.
 *  Nobody pinned it → the agent's own report is the model. */
export function modelPin(
  request: AskRequest,
  lane: LanePick
): { model?: string; pinnedBy: ModelPin } {
  if (request.model !== undefined && request.model.trim() !== '') {
    return { model: request.model, pinnedBy: 'you' };
  }
  if (lane.model !== undefined) {
    return { model: lane.model, pinnedBy: 'the route' };
  }
  if (lane.entry.model !== undefined) {
    return { model: lane.entry.model, pinnedBy: 'the provider entry' };
  }
  return { pinnedBy: 'the agent' };
}

/** The turn's tokens — the agent's own numbers when it reports them, the
 *  estimate otherwise. */
function turnTokens(
  usage: AcpUsage | undefined,
  texts: { question: string; answer: string }
): number {
  const reported = usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
  if (reported) {
    return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }
  return estimateTokens(texts.question) + estimateTokens(texts.answer);
}

/** The cost slice — the turn's own numbers and the ledger's window. */
async function costSlice(input: {
  lane: LanePick;
  model: string;
  usage?: AcpUsage;
  question: string;
  answer: string;
  ledgerKnown: boolean;
}): Promise<ExplainFact[]> {
  const window = await windowCounters({ provider: input.lane.provider, model: input.model });
  const reported = input.usage?.inputTokens !== undefined;
  const usage = input.usage;
  const turn = reported
    ? {
        reported: {
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        },
      }
    : {
        estimated: {
          inputTokens: estimateTokens(input.question),
          outputTokens: estimateTokens(input.answer),
        },
      };
  return costFacts({
    turn,
    window:
      window === undefined
        ? undefined
        : { ...window, provider: input.lane.provider, model: input.model },
    ledgerKnown: input.ledgerKnown,
  });
}

/** The health the explanation reports — the snapshot the decision read, so
 *  the slice says what the router saw when it chose, not a second reading
 *  after the turn. A lane nobody decided (the operator named it) has no
 *  snapshot: the ledger is read then, and only then. */
async function laneHealth(lane: LanePick): Promise<{ snapshot: HealthSnapshot; known: boolean }> {
  if (lane.snapshot !== undefined) {
    return { snapshot: lane.snapshot, known: lane.healthKnown === true };
  }
  return ledgerHealth();
}

/** The explanation — the slices the caller asked for, gathered where the
 *  facts live. */
async function explainAsk(input: {
  request: AskRequest;
  lane: LanePick;
  pin: { model?: string; pinnedBy: ModelPin };
  model: string;
  usage?: AcpUsage;
  answer: string;
}): Promise<Explanation> {
  const { lane, pin } = input;
  let explanation: Explanation = { slices: {} };
  if (lane.decision !== undefined) {
    explanation = withSlice(explanation, 'route', routeFacts(lane.decision));
  }
  explanation = withSlice(
    explanation,
    'model',
    modelFacts({
      agent: lane.provider,
      model: input.model,
      pinnedBy: pin.pinnedBy,
      route: lane.route,
      rule: lane.rule,
      ruleSource: lane.ruleSource,
    })
  );
  const { snapshot, known } = await laneHealth(lane);
  explanation = withSlice(
    explanation,
    'health',
    healthFacts(snapshot, [healthKey(lane.provider, input.model)])
  );
  explanation = withSlice(
    explanation,
    'cost',
    await costSlice({
      lane,
      model: input.model,
      usage: input.usage,
      question: input.request.question,
      answer: input.answer,
      ledgerKnown: known,
    })
  );
  return explanation;
}

/** Ask one question. */
export async function runAsk(request: AskRequest, dir: string): Promise<AskOutcome> {
  const lane = await resolveLane(dir, request);
  const pin = modelPin(request, lane);
  const timeoutMs = request.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const result = await acpConverse(
    lane.provider,
    lane.entry,
    {
      model: pin.model,
      acp: { cwd: request.cwd },
    },
    request.question,
    () => undefined,
    deadline
  );
  const model = result.model === 'unknown' ? (pin.model ?? 'unknown') : result.model;
  await recordTurn({
    provider: lane.provider,
    model,
    tokens: turnTokens(result.usage, { question: request.question, answer: result.text }),
    tag: request.question.slice(0, 80),
  });
  const explanation =
    request.slices === undefined
      ? undefined
      : await explainAsk({
          request,
          lane,
          pin,
          model,
          usage: result.usage,
          answer: result.text,
        });
  return {
    provider: lane.provider,
    model,
    stopReason: result.stopReason,
    text: result.text,
    usage: result.usage,
    explanation,
  };
}
