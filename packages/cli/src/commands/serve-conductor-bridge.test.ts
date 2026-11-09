/** The bridge — an agent's tool call, in the client's vocabulary
 *  (spec bro-sy4q3). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientCall } from './serve-conductor-bridge.ts';
import { capabilityOf } from './serve-conductor-capabilities.ts';
import { clientTools } from './serve-conductor-tools.ts';

const CLAUDE_TOOLS = clientTools([
  {
    name: 'Bash',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
]);

test('the capability decides the tool — the name never does', () => {
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls -la' } },
    CLAUDE_TOOLS
  );
  assert.equal(call?.name, 'Bash');
  assert.deepEqual(call?.input, { command: 'ls -la' });
});

test("the agent's 'path' is the client's 'file_path'", () => {
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x' } },
    CLAUDE_TOOLS
  );
  assert.equal(call?.name, 'Read');
  assert.deepEqual(call?.input, { file_path: '/tmp/x' });
});

test('a call that already ran is a report, not a request', () => {
  // the agent ran it in its own sandbox and the update says so: a
  // tool_use would make the CLIENT run the same call a second time, on
  // the client's own machine
  assert.equal(
    clientCall(
      {
        sessionUpdate: 'tool_call',
        kind: 'execute',
        rawInput: { command: 'rm -rf /' },
        status: 'completed',
      },
      CLAUDE_TOOLS
    ),
    undefined
  );
  assert.equal(
    clientCall(
      {
        sessionUpdate: 'tool_call',
        kind: 'execute',
        rawInput: { command: 'ls' },
        status: 'failed',
      },
      CLAUDE_TOOLS
    ),
    undefined
  );
  // a call still in flight is a request, and it is bridged
  assert.equal(
    clientCall(
      {
        sessionUpdate: 'tool_call',
        kind: 'execute',
        rawInput: { command: 'ls' },
        status: 'pending',
      },
      CLAUDE_TOOLS
    )?.name,
    'Bash'
  );
});

test('the first candidate whose required fields are covered wins', () => {
  const edit = clientCall(
    {
      sessionUpdate: 'tool_call',
      kind: 'edit',
      rawInput: { path: '/tmp/x', old_string: 'a', new_string: 'b' },
    },
    CLAUDE_TOOLS
  );
  assert.equal(edit?.name, 'Edit');
  assert.deepEqual(edit?.input, { file_path: '/tmp/x', old_string: 'a', new_string: 'b' });
  // the same kind, an input only the Write can take
  const write = clientCall(
    { sessionUpdate: 'tool_call', kind: 'edit', rawInput: { path: '/tmp/x', content: 'hi' } },
    CLAUDE_TOOLS
  );
  assert.equal(write?.name, 'Write');
  assert.deepEqual(write?.input, { file_path: '/tmp/x', content: 'hi' });
});

test('a call the client cannot run is not invented', () => {
  // no tool of that capability
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'search', rawInput: { q: 'x' } }, CLAUDE_TOOLS),
    undefined
  );
  // the client offers nothing at all
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls' } }, []),
    undefined
  );
  // a required field the call does not carry — no invented argument
  assert.equal(
    clientCall(
      { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { timeout: 5 } },
      CLAUDE_TOOLS
    ),
    undefined
  );
  // not a tool call at all
  assert.equal(
    clientCall({ sessionUpdate: 'agent_message_chunk', kind: 'execute' }, CLAUDE_TOOLS),
    undefined
  );
  // the raw input is not an object
  assert.equal(
    clientCall({ sessionUpdate: 'tool_call', kind: 'execute', rawInput: 'ls' }, CLAUDE_TOOLS),
    undefined
  );
});

test("the request's contract decides the call — none bridged, none named", () => {
  // tool_choice: none — the request withheld its tools
  assert.equal(
    clientCall(
      { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls' } },
      CLAUDE_TOOLS,
      { allowed: false }
    ),
    undefined
  );
  // a request that named its tool asked for THAT tool — another tool of
  // the same capability is a different contract
  assert.equal(
    clientCall(
      { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'ls' } },
      CLAUDE_TOOLS,
      { allowed: true, name: 'Read' }
    ),
    undefined
  );
  const named = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x' } },
    CLAUDE_TOOLS,
    { allowed: true, name: 'Read' }
  );
  assert.equal(named?.name, 'Read');
});

test('the schema shapes the input — a number where it says string is dropped', () => {
  // the client's Bash schema says command is a string
  assert.equal(
    clientCall(
      { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 42 } },
      CLAUDE_TOOLS
    ),
    undefined
  );
  // null is a value the schema allows — the client validates its own input
  const nullable = clientTools([
    {
      name: 'read',
      input_schema: {
        properties: { path: { type: 'string' }, offset: { type: ['number', 'null'] } },
        required: ['path'],
      },
    },
  ]);
  const withNull = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x', offset: null } },
    nullable
  );
  assert.deepEqual(withNull?.input, { path: '/tmp/x', offset: null });
});

test('the property names cannot reshape what we send', () => {
  const tools = clientTools([
    {
      name: 'read',
      input_schema: JSON.parse('{"properties":{"__proto__":{"type":"string"}},"required":[]}'),
    },
  ]);
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: JSON.parse('{"__proto__":"x"}') },
    tools
  );
  assert.equal(call, undefined);
});

test('a call with no input still runs a tool that takes no arguments', () => {
  const tools = clientTools([{ name: 'read', input_schema: { properties: {}, required: [] } }]);
  const call = clientCall({ sessionUpdate: 'tool_call', kind: 'read', rawInput: {} }, tools);
  assert.equal(call?.name, 'read');
  assert.deepEqual(call?.input, {});
});

test("the kind is the agent's — an inherited name is not a capability", () => {
  // every object carries "toString" and "constructor": a plain lookup finds
  // the prototype's function there and hands it to the tool matcher
  for (const kind of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.equal(
      clientCall({ sessionUpdate: 'tool_call', kind, rawInput: { command: 'ls' } }, CLAUDE_TOOLS),
      undefined
    );
  }
});

test("the schema's own shape wins — the extra fields are dropped", () => {
  const call = clientCall(
    {
      sessionUpdate: 'tool_call',
      kind: 'execute',
      rawInput: { command: 'ls', description: 'list it', sandbox: 'off' },
    },
    CLAUDE_TOOLS
  );
  assert.deepEqual(call?.input, { command: 'ls', description: 'list it' });
});

test("the client's own spelling wins — 'file_path' is the client's 'path'", () => {
  // the agent says file_path, the client's tool calls the property path:
  // a call the client CAN run must not be dropped for the spelling
  const tools = clientTools([
    {
      name: 'read',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]);
  const call = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { file_path: '/tmp/x' } },
    tools
  );
  assert.equal(call?.name, 'read');
  assert.deepEqual(call?.input, { path: '/tmp/x' });
});

test("the client's own schema decides — a value below its minimum is not sent", () => {
  const tools = clientTools([
    {
      name: 'read',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'number', minimum: 0 } },
        required: ['path'],
      },
    },
  ]);
  const bad = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x', offset: -5 } },
    tools
  );
  assert.equal(bad, undefined, 'the client would reject the call — the wire sends no such call');
  const good = clientCall(
    { sessionUpdate: 'tool_call', kind: 'read', rawInput: { path: '/tmp/x', offset: 5 } },
    tools
  );
  assert.deepEqual(good?.input, { path: '/tmp/x', offset: 5 });
});

test("the vocabulary reads the request's own definitions", () => {
  const tools = clientTools([
    { name: 'Bash', input_schema: { properties: { command: {} }, required: ['command'] } },
    { name: '' },
    { description: 'no name' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'Bash');
  assert.deepEqual(tools[0]?.required, ['command']);
  assert.deepEqual(tools[0]?.properties, ['command']);
  assert.deepEqual(clientTools(undefined), []);
});

test('a property the client names __proto__ is an ordinary entry, not a prototype swap', () => {
  const tools = clientTools([
    {
      name: 'read',
      input_schema: JSON.parse('{"properties":{"__proto__":{"type":"string"}},"required":[]}'),
    },
  ]);
  const types = tools[0]?.types ?? {};
  assert.equal(Object.getPrototypeOf(types), null);
  // an OWN entry, with the type the client declared for it
  assert.deepEqual(Object.getOwnPropertyDescriptor(types, '__proto__')?.value, ['string']);
  // and nothing else — a name the client never declared has no answer to
  // give, the table has no prototype to fall back on
  assert.deepEqual(Object.keys(types), ['__proto__']);
});

test('a kind that is not a capability is not one', () => {
  // a plain object's prototype carries names of its own — "toString",
  // "constructor" — and none of them is a capability
  assert.equal(capabilityOf('toString'), undefined);
  assert.equal(capabilityOf('constructor'), undefined);
  assert.equal(capabilityOf('__proto__'), undefined);
  assert.equal(capabilityOf(42), undefined);
  assert.equal(capabilityOf(undefined), undefined);
  assert.deepEqual(capabilityOf('read'), ['read', 'view', 'cat']);
});
