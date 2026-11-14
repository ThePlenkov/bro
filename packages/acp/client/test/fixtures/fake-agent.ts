#!/usr/bin/env node
/**
 * A scriptable fake ACP agent — the wire is the whole contract.
 *
 * It speaks NDJSON JSON-RPC like a real agent and takes its script
 * from `FAKE_AGENT` (JSON), so one fixture covers the handshake, the
 * queue, the cancel, the permission handshake and the dead transport
 * without a test-only flag on the protocol side.
 *
 * The knobs:
 *   caps            — the `initialize` agentCapabilities bag
 *   protocolVersion — the negotiated version (a mismatch must fail)
 *   sessionId       — the session it hands out
 *   mode            — 'instant' (answer the turn at once) | 'hold'
 *                     (keep the turn open until a `session/cancel`)
 *   askPermission   — ask once per turn, with `options`
 *   options         — the agent's own options (the client must not
 *                     invent an optionId of its own)
 *   updates         — the `session/update` payloads of a turn
 *   die             — exit right after the handshake
 */
import { createInterface } from 'node:readline';

interface FakeOption {
  optionId: string;
  name: string;
  kind: string;
}

interface FakeConfig {
  caps?: Record<string, unknown>;
  protocolVersion?: number;
  sessionId?: string;
  mode?: 'instant' | 'hold';
  askPermission?: boolean;
  options?: FakeOption[];
  updates?: unknown[];
  die?: boolean;
}

const CFG: FakeConfig = (() => {
  const raw = process.env.FAKE_AGENT;
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw) as FakeConfig;
  } catch {
    return {};
  }
})();

const SESSION = CFG.sessionId ?? 'fake-1';
/** The permission request's id — far from the client's own id space. */
const PERMISSION_ID = 9001;

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const notify = (update: unknown): void => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update } });
};

/** the turn's prompt request id — the turn ends when it is answered */
let promptId: number | undefined;
/** resolve the permission wait — the answer unblocks the turn */
let releasePermission: (() => void) | undefined;
let permissionAsked = false;

/** One turn — updates, maybe a permission ask, then the end. */
async function pumpTurn(): Promise<void> {
  const updates = CFG.updates ?? [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ];
  for (const update of updates) notify(update);

  if (CFG.askPermission === true && !permissionAsked) {
    permissionAsked = true;
    send({
      jsonrpc: '2.0',
      id: PERMISSION_ID,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: 'tool-1', title: 'Run ls', kind: 'execute', status: 'in_progress' },
        options: CFG.options ?? [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await new Promise<void>(resolve => {
      releasePermission = resolve;
    });
    releasePermission = undefined;
  }

  if (CFG.mode === 'hold') return; // the turn stays open until a cancel
  const id = promptId;
  promptId = undefined;
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

const rl = createInterface({ input: process.stdin });

rl.on('line', line => {
  let msg: {
    id?: number;
    method?: string;
    params?: { sessionId?: string };
    result?: { outcome?: { outcome?: string; optionId?: string } };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // a response to OUR request — the permission answer
  if (msg.method === undefined) {
    if (msg.id === PERMISSION_ID) {
      notify({ sessionUpdate: 'fake/permission_outcome', outcome: msg.result?.outcome });
      releasePermission?.();
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: CFG.protocolVersion ?? 1,
          agentCapabilities: CFG.caps ?? { promptCapabilities: {} },
          agentInfo: { name: 'fake', version: '0' },
        },
      });
      if (CFG.die === true) process.exit(0);
      return;
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION } });
      return;
    case 'session/load':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params?.sessionId ?? SESSION } });
      return;
    case 'session/resume':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params?.sessionId ?? SESSION } });
      return;
    case 'session/prompt':
      promptId = msg.id;
      void pumpTurn();
      return;
    case 'session/cancel': {
      const id = promptId;
      promptId = undefined;
      if (id !== undefined) send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
      return;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
  }
});

rl.on('close', () => process.exit(0));
