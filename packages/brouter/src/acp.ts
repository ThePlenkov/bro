/**
 * `brouter acp` — the router as an ACP agent.
 *
 * acpx's shape: an endpoint in front, a target behind, the session kept
 * alive between the client's turns. Any ACP client (an IDE, another
 * agent, a TUI) drives the router's configured agent as if the router
 * were one agent.
 *
 * The protocol is the binding's: `acpOpen` opens the target peer (the
 * bridge to the real client lives inside it) and `acpSessionRetain`
 * keeps the target's session alive between the client's prompts. The
 * facade's own job is the wire: an ACP agent app over stdio, the
 * target's session/new answer, and the target's updates relayed to the
 * client as its own.
 */
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';
import { loadConfig } from '@broject/core';
import type { ProviderEntry } from '@broject/core';
import { acpOpen, acpSessionRetain, promptText } from '@broject/providers';
import type { AcpPeer, AcpRetainedSession, ProviderWireOpts } from '@broject/providers';
import { acpEntry, resolveProvider } from './ask.ts';

/** The acp entry — the provider kind the facade can drive. */
type AcpEntry = Extract<ProviderEntry, { type: 'acp' }>;

/** The facade request. */
export interface AcpFacadeRequest {
  /** the provider entry — absent resolves to the first acp entry */
  provider?: string;
  /** the model to pin */
  model?: string;
  /** the working directory of the session */
  cwd?: string;
  /** the round-trip budget per turn */
  timeoutMs?: number;
}

/** The facade's own session id — what the client sees. The target's
 *  session id stays behind the facade. */
export function localSessionId(): string {
  return randomUUID();
}

/** The handshake — the peer and the session it retains, with the
 *  keep-alive that holds the event loop while it runs.
 *
 *  The target agent is spawned UNREF'd (the binding's discipline: a
 *  pooled peer must not hold the host open), so the facade keeps its
 *  own ref'd handle from the FIRST await — the handshake itself waits
 *  on that child's unref'd stdio, and without a ref the event loop
 *  empties mid-handshake and node exits under the client.
 *
 *  The keep-alive belongs to the handshake: a handshake that failed
 *  clears it, or the interval would keep the process alive and the
 *  failure would hang instead of reaching the caller. */
async function openSession(
  provider: string,
  entry: AcpEntry,
  wire: ProviderWireOpts,
  timeoutMs: number
): Promise<{ peer: AcpPeer; session: AcpRetainedSession; keepAlive: NodeJS.Timeout }> {
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    const peer = await acpOpen(provider, entry, wire, Date.now() + timeoutMs);
    const session = await acpSessionRetain(peer, entry, wire, Date.now() + timeoutMs);
    return { peer, session, keepAlive };
  } catch (err) {
    clearInterval(keepAlive);
    throw err;
  }
}

/** Serve the ACP endpoint over stdio until the client disconnects. */
export async function runAcpFacade(request: AcpFacadeRequest, dir: string): Promise<void> {
  const providers = loadConfig(dir).providers ?? {};
  const provider = resolveProvider(providers, request.provider);
  const entry = acpEntry(providers, provider);
  const timeoutMs = request.timeoutMs ?? 120_000;
  const wire = {
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.cwd === undefined ? {} : { acp: { cwd: request.cwd } }),
  };

  const { peer, session, keepAlive } = await openSession(provider, entry, wire, timeoutMs);
  const sessionId = localSessionId();

  const app = agent({ name: 'brouter' });

  app.onRequest('initialize', async () => peer.init);

  app.onRequest('session/new', async () => ({
    sessionId,
    modes: session.newSessionResponse.modes,
    configOptions: session.newSessionResponse.configOptions ?? [],
    mcpServers: [],
  }));

  app.onRequest('session/prompt', async ctx => {
    const text = promptText(ctx.params.prompt);
    const result = await session.prompt(text, Date.now() + timeoutMs, {
      by: provider,
      onUpdate: update => {
        void ctx.client.notify('session/update', { sessionId, update });
      },
    });
    return { stopReason: result.stopReason };
  });

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  // the connection's own close is the facade's lifetime: the client
  // disconnects (or stdin ends) and the facade exits with it — a
  // never-settling await would leave the process with nothing to do
  const connection = app.connect(stream);
  try {
    await connection.closed;
  } finally {
    clearInterval(keepAlive);
    session.dispose();
    peer.close();
  }
}
