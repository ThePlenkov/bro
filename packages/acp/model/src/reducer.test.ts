// The archive-turn contract (PR #876 review): a `turn_started` event
// opens an OBSERVED turn — items it births carry origin `other`, never
// `self`; and a second start on a turn with nothing pending re-anchors
// `startedAt` so the next turn_end's duration doesn't span the dropped
// turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession, reduce } from './index.ts';
import type { ModelEvent } from './index.ts';

test('an archive-sourced turn marks its items origin "other"', () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  s = reduce(s, {
    type: 'session_update',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    },
    at: 1100,
  } as ModelEvent);
  const item = [...s.items.values()].find(i => i.kind === 'agent_message');
  assert.equal(item?.origin, 'other');
});

test('a prompt-opened turn still marks its items "self"', () => {
  let s = createSession();
  s = reduce(s, { type: 'prompt_sent', text: 'go', at: 1000 } as ModelEvent);
  s = reduce(s, {
    type: 'session_update',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    },
    at: 1100,
  } as ModelEvent);
  const item = [...s.items.values()].find(i => i.kind === 'agent_message');
  assert.equal(item?.origin, 'self');
});

test('a second turn_started re-anchors an idle-pending turn', () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  // no stop row ever landed, but nothing is pending either — the next
  // start begins a new turn, it does not extend the dropped one
  s = reduce(s, { type: 'turn_started', at: 9000 } as ModelEvent);
  s = reduce(s, { type: 'prompt_response', stopReason: 'end_turn', at: 10_000 } as ModelEvent);
  const end = [...s.items.values()].find(i => i.kind === 'marker' && i.markerKind === 'turn_end');
  assert.equal(end?.kind === 'marker' && end.markerKind === 'turn_end' ? end.durationMs : -1, 1000);
});

test('a fresh turn_started seals the dropped turn — an id-less chunk never joins it', () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  const chunk = (text: string, at: number): ModelEvent =>
    ({
      type: 'session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
      at,
    }) as ModelEvent;
  s = reduce(s, chunk('hi', 1100));
  // the first turn's stop was dropped mid-window; the next start
  // seals its live item so a later id-less chunk cannot append to it
  s = reduce(s, { type: 'turn_started', at: 9000 } as ModelEvent);
  s = reduce(s, chunk('there', 9100));
  const texts = [...s.items.values()]
    .filter(i => i.kind === 'agent_message')
    .map(i => (i.kind === 'agent_message' ? i.text : ''));
  assert.deepEqual(texts, ['hi', 'there']);
});

test('a sealed turn abandons its tool call — live status reads failed, never glows live', () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  s = reduce(s, {
    type: 'session_update',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'run it',
      status: 'in_progress',
    },
    at: 1100,
  } as ModelEvent);
  s = reduce(s, { type: 'turn_started', at: 9000 } as ModelEvent);
  const tool = [...s.items.values()].find(i => i.kind === 'tool_call');
  assert.equal(tool?.status, 'final');
  assert.equal(tool?.kind === 'tool_call' ? tool.toolStatus : '', 'failed');
});

test("a fresh turn_started commits the dropped turn's reported plan", () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  s = reduce(s, {
    type: 'session_update',
    update: {
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
    },
    at: 1100,
  } as ModelEvent);
  s = reduce(s, { type: 'turn_started', at: 9000 } as ModelEvent);
  const plans = [...s.items.values()].filter(i => i.kind === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.kind === 'plan' ? plans[0].entries[0]?.content : '', 'step one');
});

test('a second turn_started keeps the pending permission tracking', () => {
  let s = createSession();
  s = reduce(s, { type: 'turn_started', at: 1000 } as ModelEvent);
  s = reduce(s, {
    type: 'permission_opened',
    toolCallId: 't1',
    request: {
      sessionId: 'archive',
      toolCall: { toolCallId: 't1', title: 'run it', status: 'in_progress' },
      options: [],
    },
    at: 1100,
  } as ModelEvent);
  assert.equal(s.state, 'requires_action');
  // a start while a permission is still open re-arms the same turn —
  // the pending request survives (a dropped stop must not unblock it)
  s = reduce(s, { type: 'turn_started', at: 9000 } as ModelEvent);
  assert.equal(s.state, 'requires_action');
  assert.equal(s.turn?.openPermissionToolCallIds.length, 1);
});
