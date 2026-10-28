#!/usr/bin/env node
/**
 * A minimal fake ACP backend for the acp-watch end-to-end test —
 * speaks NDJSON JSON-RPC, answers initialize/session/new, emits one
 * of each rendered update shape, asks for permission once, then
 * answers the prompt end_turn and exits. No test-only flags: the
 * wire is the whole contract.
 */
import { createInterface } from 'node:readline';

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const notify = (update: unknown): void => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-1', update } });
};

let askedPermission = false;

/** One scripted turn — the update stream the e2e test asserts on. */
function pumpTurn(promptId: number | undefined): void {
  notify({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking about the task…' },
  });
  const planEntries = [
    { content: 'Do the thing', priority: 'medium', status: 'in_progress' },
    { content: 'Report it', priority: 'low', status: 'pending' },
  ];
  notify({ sessionUpdate: 'plan', entries: planEntries });
  const tool = { toolCallId: 'exec:0#fake', title: 'Run ls', kind: 'execute' };
  notify({ sessionUpdate: 'tool_call', ...tool, status: 'pending' });
  notify({ sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, status: 'in_progress' });
  if (!askedPermission) {
    askedPermission = true;
    send({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'fake-1',
        toolCall: { ...tool, status: 'in_progress' },
        options: [
          { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'a2', name: 'Always', kind: 'allow_always' },
          { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  }
  notify({ sessionUpdate: 'tool_call_update', toolCallId: tool.toolCallId, status: 'completed' });
  notify({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Done — the files ' },
  });
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'are listed.' } });
  notify({ sessionUpdate: 'usage_update', used: 1234, size: 262000 });
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line) as { id?: number; method?: string };
  if (m.id !== undefined && m.method === undefined) return; // a response (permission answer) — nothing to do
  switch (m.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } },
      });
      return;
    case 'session/new':
      send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'fake-1' } });
      return;
    case 'session/prompt':
      pumpTurn(m.id);
      return;
    case 'session/cancel':
      process.exit(0);
    default:
      if (m.id !== undefined) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
      }
  }
});
rl.on('close', () => process.exit(0));
