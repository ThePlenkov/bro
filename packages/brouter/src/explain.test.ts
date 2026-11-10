import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExplainFact } from '@broject/core';
import type { RouteDecision } from '@broject/router-routes';
import { chainModelFacts, costFacts, healthFacts, modelFacts, routeFacts } from './explain.ts';

/** The resolver's verdict — a route, its chain, and every reject. */
const DECISION: RouteDecision = {
  route: {
    name: 'edit',
    match: { type: 'edit' },
    chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
  },
  chain: [{ provider: 'devin-acp', model: 'swe-2-max' }],
  dropped: [{ entry: { provider: 'kilo-cli' }, reason: 'rate-limited' }],
  candidates: [
    {
      route: { name: 'edit', match: { type: 'edit' }, chain: [] },
      score: 1,
      reasons: ['type=edit'],
    },
  ],
  rejected: [
    {
      route: { name: 'design', match: { type: 'design' }, chain: [] },
      reason: 'type=edit does not fit type=design',
    },
  ],
  reason: "the table's own order — edit (type=edit)",
  picked: 'static',
};

/** The label of a fact — the collector's facts are found by label. */
function label(facts: ExplainFact[], name: string): string | undefined {
  return facts.find(f => f.label === name)?.value;
}

test('the route facts carry the verdict, the candidates and the rejects', () => {
  const facts = routeFacts(DECISION);
  assert.equal(label(facts, 'route'), 'edit');
  assert.equal(label(facts, 'chain'), 'devin-acp/swe-2-max');
  assert.equal(label(facts, 'dropped: kilo-cli'), 'rate-limited');
  assert.equal(label(facts, 'candidate: edit'), '1');
  assert.equal(label(facts, 'rejected: design'), 'type=edit does not fit type=design');
});

test('every route fact says why it holds', () => {
  for (const fact of routeFacts(DECISION)) {
    assert.ok(fact.because.length > 0, `${fact.label} has no reason`);
  }
});

test("the model's provenance names who pinned it", () => {
  const facts = modelFacts({
    agent: 'devin-acp',
    model: 'swe-2-max',
    pinnedBy: 'the route',
    route: 'edit',
    rule: 'the route "edit" — its first acp entry',
    ruleSource: 'the table',
  });
  assert.equal(label(facts, 'agent'), 'devin-acp');
  assert.equal(label(facts, 'model'), 'swe-2-max');
  const model = facts.find(f => f.label === 'model');
  assert.match(model?.because ?? '', /the route "edit" pins it/);
});

test('an unpinned model says the agent reported it', () => {
  const facts = modelFacts({
    agent: 'devin-acp',
    model: 'swe-2-max',
    pinnedBy: 'the agent',
    rule: 'the first acp provider in the config',
    ruleSource: 'the config',
  });
  const model = facts.find(f => f.label === 'model');
  assert.match(model?.because ?? '', /the agent reported/);
});

test("a chain's head is what a request lands on", () => {
  const facts = chainModelFacts(DECISION.chain, 'edit');
  assert.equal(label(facts, 'agent'), 'devin-acp');
  assert.equal(label(facts, 'model'), 'swe-2-max');
});

test('a chain that pins no model says so', () => {
  const facts = chainModelFacts([{ provider: 'kilo-cli' }], 'edit');
  assert.equal(label(facts, 'model'), '(none pinned)');
});

test('an empty chain has no lane at all', () => {
  const facts = chainModelFacts([], 'edit');
  assert.equal(label(facts, 'agent'), '(none)');
});

test('the health facts read the wall and the sessions', () => {
  const facts = healthFacts(
    {
      'devin-acp/swe-2-max': { available: false, reason: 'rate-limited', detail: 'until 12:00' },
      'kilo-cli': { available: true, openSessions: 2 },
    },
    ['devin-acp/swe-2-max', 'kilo-cli']
  );
  assert.equal(label(facts, 'devin-acp/swe-2-max'), 'walled — rate-limited');
  assert.equal(label(facts, 'kilo-cli'), 'available');
  assert.equal(label(facts, 'sessions: kilo-cli'), '2');
});

test('a model the ledger never heard of is available', () => {
  const facts = healthFacts({}, ['devin-acp/swe-2-max']);
  assert.equal(label(facts, 'devin-acp/swe-2-max'), 'available');
});

test('the reported tokens win over the estimate', () => {
  const facts = costFacts({
    turn: { reported: { inputTokens: 120, outputTokens: 30 }, estimated: { inputTokens: 999 } },
    window: { provider: 'devin-acp', model: 'swe-2-max', requests: 2, tokens: 150 },
  });
  assert.equal(label(facts, 'context'), '120 tokens');
  assert.equal(label(facts, 'output'), '30 tokens');
  assert.equal(label(facts, 'requests'), '2');
});

test('the estimate is labelled as one', () => {
  const facts = costFacts({ turn: { estimated: { inputTokens: 42, outputTokens: 7 } } });
  assert.equal(label(facts, 'context'), '≈42 tokens');
  const context = facts.find(f => f.label === 'context');
  assert.match(context?.source ?? '', /estimated/);
});

test('a provider that reports no cost says unknown — never zero', () => {
  const facts = costFacts({ turn: { reported: { inputTokens: 10 } } });
  assert.equal(label(facts, 'cost'), 'unknown');
});

test('a reported cost carries the number', () => {
  const facts = costFacts({ turn: { reported: { inputTokens: 10 }, costUsd: 0.0123 } });
  assert.equal(label(facts, 'cost'), '$0.0123');
});

test('an unreadable ledger says so — the window is unknown, not zero', () => {
  const facts = costFacts({ ledgerKnown: false });
  assert.equal(label(facts, 'requests'), 'unknown');
  assert.equal(label(facts, 'tokens'), 'unknown');
});
