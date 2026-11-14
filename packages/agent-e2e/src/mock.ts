/** @copilotkit/aimock wrapper — one deterministic LLM endpoint speaking
 *  every provider wire (OpenAI chat/responses, Anthropic messages, …).
 *  Agent CLIs point their provider baseURL at `url`; requests are
 *  journaled at `GET /__aimock/journal` for assertions. */
import { LLMock } from '@copilotkit/aimock';
import type { Fixture, FixtureMatch, FixtureResponse } from '@copilotkit/aimock';

export interface LlmMock {
  /** `http://127.0.0.1:<port>` — append `/v1` for OpenAI-shaped bases. */
  url: string;
  mock: LLMock;
  stop(): Promise<void>;
  /** Journal entries — every request the mock served. */
  journal(): Promise<JournalEntry[]>;
  /** `await using` support — stops the server on scope exit. */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  body: unknown;
  response: { status: number };
}

export type { Fixture, FixtureMatch, FixtureResponse };

export async function startMock(): Promise<LlmMock> {
  const mock = new LLMock({ port: 0 });
  await mock.start();
  return {
    url: mock.url,
    mock,
    stop: () => mock.stop(),
    async journal() {
      const res = await fetch(`${mock.url}/__aimock/journal`);
      if (!res.ok) {
        return [];
      }
      const data = (await res.json()) as { entries?: JournalEntry[] } | JournalEntry[];
      return Array.isArray(data) ? data : (data.entries ?? []);
    },
    [Symbol.asyncDispose]: () => mock.stop(),
  };
}
