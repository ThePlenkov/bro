/**
 * The collectors — the facts of each slice, gathered where the data lives.
 *
 * The contract lives in core (`@broject/core`'s explain module): the slice
 * vocabulary, the fact shape, the renderer. This module is the other half —
 * it turns a resolver's verdict, a health snapshot, a ledger window and a
 * turn's usage into those facts.
 *
 * Every fact carries its reason, and an unknown says "unknown" with the
 * source that failed to answer: a free turn and an unreported one are
 * different facts, and a zero would be a lie the operator bills against.
 */
import { healthKey, unknownFact } from '@broject/core';
import type { ExplainFact, HealthSnapshot } from '@broject/core';
import type { RouteDecision } from '@broject/router-routes';

/** The chain's entry, rendered — the honest id. */
function chainId(entry: { provider: string; model?: string }): string {
  return entry.model === undefined ? entry.provider : `${entry.provider}/${entry.model}`;
}

/** The verdict's own facts — the route and the chain it names. */
function verdictFacts(decision: RouteDecision): ExplainFact[] {
  return [
    {
      label: 'route',
      value: decision.route?.name ?? '(none)',
      because: decision.reason,
      source: decision.picked === 'model' ? 'the decision model' : 'the table',
    },
    {
      label: 'chain',
      value: decision.chain.map(chainId).join(' → ') || '(empty)',
      because:
        decision.chain.length === 0
          ? 'no model in the chain can serve right now'
          : 'the chain the route names — the head serves first',
      source: 'the table',
    },
  ];
}

/** The chain's own facts — the entries health removed. */
function chainFacts(decision: RouteDecision): ExplainFact[] {
  return decision.dropped.map(dropped => ({
    label: `dropped: ${chainId(dropped.entry)}`,
    value: dropped.reason,
    because: 'health removed it from the chain',
    source: 'the ledger',
  }));
}

/** The candidates' facts — how much of the task each route pins. */
function candidateFacts(decision: RouteDecision): ExplainFact[] {
  return decision.candidates.map(candidate => ({
    label: `candidate: ${candidate.route.name}`,
    value: String(candidate.score),
    because:
      candidate.reasons.length === 0
        ? 'the catch-all — it pins nothing of the task'
        : `it pins ${candidate.reasons.join(', ')}`,
    source: 'the table',
  }));
}

/** The rejects' facts — every route that did not make it, and why. */
function rejectFacts(decision: RouteDecision): ExplainFact[] {
  return decision.rejected.map(rejected => ({
    label: `rejected: ${rejected.route.name}`,
    value: rejected.reason,
    because: 'the route does not fit this task',
    source: 'the table',
  }));
}

/** The route's facts — the decision, its candidates, and every reject. */
export function routeFacts(decision: RouteDecision): ExplainFact[] {
  return [
    ...verdictFacts(decision),
    ...chainFacts(decision),
    ...candidateFacts(decision),
    ...rejectFacts(decision),
  ];
}

/** Who pinned the model — the provenance the `model` slice exists for. */
export type ModelPin = 'you' | 'the route' | 'the provider entry' | 'the agent';

/** The lane that serves, and the model it serves — with the reasons. */
export interface ModelPick {
  /** the lane that serves the request */
  agent: string;
  /** the model that serves */
  model: string;
  /** who pinned the model */
  pinnedBy: ModelPin;
  /** the route that pinned it — when the route did */
  route?: string;
  /** the rule that chose the lane */
  rule: string;
  /** where the rule came from */
  ruleSource: string;
}

/** The model's facts — the agent, the model, and who chose each. */
export function modelFacts(pick: ModelPick): ExplainFact[] {
  const pin: Record<ModelPin, string> = {
    you: 'you pinned it',
    'the route': `the route "${pick.route ?? pick.agent}" pins it`,
    'the provider entry': 'the provider entry pins it',
    'the agent': 'nobody pinned it — the agent reported the model it runs',
  };
  return [
    {
      label: 'agent',
      value: pick.agent,
      because: pick.rule,
      source: pick.ruleSource,
    },
    {
      label: 'model',
      value: pick.model,
      because: pin[pick.pinnedBy],
      ...(pick.pinnedBy === 'the agent' ? { source: 'the agent' } : {}),
    },
  ];
}

/** The model's facts for a chain's head — what a request WOULD land on.
 *  The chain pins a model or it does not; the provider entry's own pin and
 *  the agent's report are the fallbacks, and the fact says which. */
export function chainModelFacts(
  chain: { provider: string; model?: string }[],
  route?: string
): ExplainFact[] {
  const head = chain[0];
  if (head === undefined) {
    return [
      {
        label: 'agent',
        value: '(none)',
        because: 'no chain entry can serve this task',
        source: 'the table',
      },
      {
        label: 'model',
        value: '(none)',
        because: 'no chain entry can serve this task',
        source: 'the table',
      },
    ];
  }
  const why = route === undefined ? 'the chain' : `the route "${route}"`;
  return [
    {
      label: 'agent',
      value: head.provider,
      because: `${why} — the chain's head serves first`,
      source: 'the table',
    },
    {
      label: 'model',
      value: head.model ?? '(none pinned)',
      because:
        head.model === undefined
          ? 'the chain pins no model — the provider entry pins it, or the agent reports its own'
          : `${why} pins it`,
      source: 'the table',
    },
  ];
}

/** The health's facts — the walls the router knew, and its sessions. */
export function healthFacts(snapshot: HealthSnapshot, keys: string[]): ExplainFact[] {
  const facts: ExplainFact[] = [];
  for (const key of keys) {
    const verdict = snapshot[key];
    if (verdict === undefined) {
      facts.push({
        label: key,
        value: 'available',
        because: 'the router holds no limit for it',
        source: 'the ledger',
      });
      continue;
    }
    facts.push({
      label: key,
      value: verdict.available ? 'available' : `walled — ${verdict.reason ?? 'unavailable'}`,
      because: verdict.detail ?? 'the router holds no limit for it',
      source: 'the ledger',
    });
    if (verdict.openSessions !== undefined && verdict.openSessions > 0) {
      facts.push({
        label: `sessions: ${key}`,
        value: String(verdict.openSessions),
        because: 'the router holds this many open sessions for it',
        source: 'the ledger',
      });
    }
  }
  return facts;
}

/** The turn's own numbers — reported by the agent, or estimated by bro. */
export interface TurnUsage {
  /** the agent's own numbers — present when the agent reports usage */
  reported?: { inputTokens?: number; outputTokens?: number };
  /** bro's estimate — used only when nothing was reported */
  estimated?: { inputTokens?: number; outputTokens?: number };
  /** the provider's reported cost, in USD */
  costUsd?: number;
}

/** The ledger's window — the counters for one model. */
export interface WindowCounters {
  provider: string;
  model: string;
  requests: number;
  tokens: number;
}

/** The cost's facts — the context, the output, the window, the money. */
export function costFacts(input: {
  turn?: TurnUsage;
  window?: WindowCounters;
  /** false when the ledger could not be read at all */
  ledgerKnown?: boolean;
}): ExplainFact[] {
  const facts: ExplainFact[] = [];
  facts.push(...turnFacts(input.turn));
  facts.push(...windowFacts(input.window, input.ledgerKnown !== false));
  return facts;
}

/** The turn's own context and output — reported, estimated, or unknown. */
function turnFacts(turn: TurnUsage | undefined): ExplainFact[] {
  if (turn === undefined) {
    return [
      unknownFact({ label: 'context', because: 'nothing was served yet', source: 'the router' }),
      unknownFact({ label: 'cost', because: 'nothing was served yet', source: 'the router' }),
    ];
  }
  const facts: ExplainFact[] = [];
  facts.push(tokenFact('context', turn.reported?.inputTokens, turn.estimated?.inputTokens));
  facts.push(tokenFact('output', turn.reported?.outputTokens, turn.estimated?.outputTokens));
  if (turn.costUsd === undefined) {
    facts.push(unknownFact({ label: 'cost', because: 'the agent reports no cost', source: 'the agent' }));
  } else {
    facts.push({
      label: 'cost',
      value: `$${turn.costUsd.toFixed(4)}`,
      because: 'the provider reported it for this turn',
      source: 'the provider',
    });
  }
  return facts;
}

/** One token fact — the reported number wins; the estimate is labelled. */
function tokenFact(
  label: string,
  reported: number | undefined,
  estimated: number | undefined
): ExplainFact {
  if (reported !== undefined) {
    return {
      label,
      value: `${reported} tokens`,
      because: 'the agent reported the turn',
      source: 'the agent',
    };
  }
  if (estimated !== undefined) {
    return {
      label,
      value: `≈${estimated} tokens`,
      because: 'nobody reported the turn — bro estimated it',
      source: 'estimated (4 chars/token)',
    };
  }
  return unknownFact({
    label,
    because: 'the agent reported no usage and bro has no text to estimate',
    source: 'the agent',
  });
}

/** The ledger's window counters — the scale around this turn. */
function windowFacts(
  window: WindowCounters | undefined,
  known: boolean
): ExplainFact[] {
  if (!known) {
    return [
      unknownFact({ label: 'requests', because: 'the ledger could not be read', source: 'the ledger' }),
      unknownFact({ label: 'tokens', because: 'the ledger could not be read', source: 'the ledger' }),
    ];
  }
  if (window === undefined) {
    return [
      unknownFact({
        label: 'requests',
        because: 'the ledger holds no counter for this model',
        source: 'the ledger',
      }),
      unknownFact({
        label: 'tokens',
        because: 'the ledger holds no counter for this model',
        source: 'the ledger',
      }),
    ];
  }
  return [
    {
      label: 'requests',
      value: String(window.requests),
      because: `the router served this many requests for ${healthKey(window.provider, window.model)} in the last hour`,
      source: 'the ledger',
    },
    {
      label: 'tokens',
      value: String(window.tokens),
      because: `the router served this many tokens for ${healthKey(window.provider, window.model)} in the last hour`,
      source: 'the ledger',
    },
  ];
}
