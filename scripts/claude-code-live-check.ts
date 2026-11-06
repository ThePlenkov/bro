/**
 * The live check — the REAL client against a RUNNING router.
 *
 * The bead asks for a proof, not a promise. The proof has four facts,
 * and this script measures every one of them against a real Claude
 * Code and a real router:
 *
 *   1. THE CLIENT SENDS THE SERVED ID — the block's row is taken
 *      verbatim; the router re-pins it onto its lane.
 *   2. THE CLIENT KNOWS THE MODEL — the client's handling of the served
 *      id is the BORROWED model's handling, down to the effort profile
 *      and the output cap. The unknown-model fallback (effort high, a
 *      32k cap) is gone: the client recognized the model.
 *   3. THE CLIENT'S MODEL LIST IS THE ROUTER'S CATALOG — the picker row
 *      carries the router's own label, not the client's.
 *   4. THE LOOP IS GONE — the router's tool_use runs, the client sends
 *      the tool result, the agent answers, and nothing repeats.
 *
 * The check never touches the operator's own settings: the block lands
 * in a scratch config dir and the client is pointed at it with
 * CLAUDE_CONFIG_DIR. The operator's ~/.claude/settings.json is read at
 * most, never written.
 *
 *   node scripts/claude-code-live-check.ts [--url <url> --token <token>]
 *                                           [--config-dir <dir>] [--keep]
 *
 * The router's endpoint comes from the router's own state file unless
 * the operator names one. The token is never printed.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_CODE_BEHAVES_AS,
  claudeCodeAdapter,
  modelFamily,
  type RouterEndpoint,
  readCatalog,
  readRouterEndpoint,
  routerUrl,
  type ServedModel,
} from '../packages/brouter/src/index.ts';

/** The prompt — the agent must run a tool, or the loop is never tested. */
const TOOL_PROMPT = 'Run the command `echo bro-live-check` and then answer with its output.';

/** The directories the client may run its own tools from — fixed, never the
 *  shell's PATH: a tampered PATH must not decide what the client executes. */
const FIXED_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

/** The client binary — an ABSOLUTE path, found once, so the child needs no
 *  PATH to find it and no PATH can swap it for something else. */
function clientBinary(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(dir => dir !== '');
  for (const dir of dirs) {
    const candidate = join(dir, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('the claude client was not found on PATH');
}

/** The child's PATH — the fixed directories, plus the client's own one (a
 *  wrapper script needs the interpreter that sits next to it). */
function clientPath(binary: string): string {
  return [dirname(binary), ...FIXED_PATH].join(':');
}

/** The flags the check reads. */
type Flag = '--url' | '--token' | '--config-dir' | '--keep';

/** The command's own arguments. */
interface Args {
  argv: string[];
}

/** The check's own state — one thing the helpers take, not a handful of
 *  strings: the router, the models, the scratch dirs. */
interface Live {
  args: Args;
  endpoint: RouterEndpoint;
  models: ServedModel[];
  /** the served id under test — one the client does not know by its tail */
  model: string;
  /** the model whose handling the served id borrows */
  borrowed: string;
  /** the router's own label for the served id */
  label: string;
  configDir: string;
  workDir: string;
  projectsDir: string;
}

/** One request the client made — its shape, as the client recorded it. */
interface RequestShape {
  model?: string;
  effort?: string;
  maxTokens?: number;
}

/** One assistant message, as the transcript holds it. */
interface AssistantMessage {
  blocks: string[];
  text: string;
}

/** The client's own record of what it did. */
interface Transcript {
  /** the requests the client made */
  requests: RequestShape[];
  /** the assistant messages the client received */
  messages: AssistantMessage[];
  /** how many tool results the client sent back */
  toolResults: number;
}

/** What the client said, and what it recorded. */
interface ClientRun {
  code: number | null;
  output: string;
  transcript: Transcript;
}

/** What the check found. */
interface Findings {
  code: number | null;
  /** the served id under test */
  model: string;
  sent: string[];
  effort: string;
  cap: number;
  borrowedEffort: string;
  borrowedCap: number;
  /** the router's own label for the served id */
  label: string;
  /** what the picker said when asked for the served id */
  listOutput: string;
  warned: boolean;
  ranTool: boolean;
  toolAnswered: boolean;
  repeated: boolean;
  served: boolean;
}

/** The flags the operator may pass. */
function flagOf(args: Args, flag: Flag): string | undefined {
  const at = args.argv.indexOf(flag);
  const value = at >= 0 ? args.argv[at + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** The router's endpoint — the flags win over the state file. */
function endpointOf(args: Args): RouterEndpoint {
  const url = flagOf(args, '--url');
  const token = flagOf(args, '--token');
  if (url !== undefined && token !== undefined) {
    return { url: routerUrl(url), token };
  }
  const found = readRouterEndpoint(process.cwd());
  if (found === undefined) {
    throw new Error('no router found — start one (bro serve) or pass --url and --token');
  }
  return found;
}

/** The transcript files the client wrote in the scratch config dir. */
function transcriptFiles(live: Live): string[] {
  if (!existsSync(live.projectsDir)) return [];
  return readdirSync(live.projectsDir)
    .flatMap(project => {
      const dir = join(live.projectsDir, project);
      return readdirSync(dir)
        .filter(entry => entry.endsWith('.jsonl'))
        .map(entry => join(dir, entry));
    })
    .sort();
}

/** One content block — its type and its text. */
function blockInfo(part: unknown): { type: string; text: string } {
  const block = part as { type?: string; text?: string };
  const type = block.type ?? '';
  return { type, text: type === 'text' ? (block.text ?? '') : '' };
}

/** One request's shape — the model's own handling, as sent. */
function requestShape(row: Record<string, unknown>): RequestShape {
  const params = (row.params ?? {}) as {
    model?: string;
    max_tokens?: number;
    output_config?: { effort?: string };
  };
  return {
    model: params.model,
    effort: params.output_config?.effort,
    maxTokens: params.max_tokens,
  };
}

/** One transcript line → its record, undefined when the line is not JSON. */
function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // a torn line is the client's own; the records around it still count
    return undefined;
  }
}

/** The records the transcript holds. */
function recordsOf(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const row = parseLine(line);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** One record → the assistant message it holds. */
function assistantMessageOf(row: Record<string, unknown>): AssistantMessage | undefined {
  if (row.type !== 'assistant') return undefined;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  const parts = Array.isArray(content) ? content : [];
  const blocks = parts.map(blockInfo);
  return { blocks: blocks.map(b => b.type), text: blocks.map(b => b.text).join('') };
}

/** The assistant messages the client received. */
function assistantMessagesOf(rows: Array<Record<string, unknown>>): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const row of rows) {
    const message = assistantMessageOf(row);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/** How many tool results the client sent back. */
function toolResultCount(rows: Array<Record<string, unknown>>): number {
  return rows
    .filter(row => row.type === 'user')
    .filter(row => {
      const content = (row.message as { content?: unknown } | undefined)?.content;
      return (
        Array.isArray(content) &&
        content.some(part => (part as { type?: string }).type === 'tool_result')
      );
    }).length;
}

/** The transcript, parsed — what the client sent and what it answered. */
function readTranscript(text: string): Transcript {
  const rows = recordsOf(text);
  return {
    requests: rows.filter(row => row.type === 'api-request').map(requestShape),
    messages: assistantMessagesOf(rows),
    toolResults: toolResultCount(rows),
  };
}

/** The client, for real — a scratch cwd, the scratch config, a base URL. */
function runClient(live: Live, prompt: string, extra: string[], baseUrl: string): ClientRun {
  const before = new Set(transcriptFiles(live));
  const binary = clientBinary();
  // the parent's PATH is dropped, not inherited: the child runs with the
  // fixed directories only, and the client binary by its absolute path
  const env = { ...process.env };
  delete env.PATH;
  const result = spawnSync(
    binary,
    ['-p', prompt, ...extra, '--permission-mode', 'bypassPermissions'],
    {
      cwd: live.workDir,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...env,
        PATH: clientPath(binary),
        CLAUDE_CONFIG_DIR: live.configDir,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: live.endpoint.token,
      },
    }
  );
  const fresh = transcriptFiles(live).filter(file => !before.has(file));
  const newest = fresh.at(-1);
  const transcript =
    newest === undefined ? readTranscript('') : readTranscript(readFileSync(newest, 'utf8'));
  return {
    code: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    transcript,
  };
}

/** The served id under test — one the client does not know by its tail,
 *  so the block's effect is visible in the client's handling. */
function modelUnderTest(models: ServedModel[]): ServedModel {
  const foreign = models.find(m => modelFamily(m.id) === 'other' && !/claude/i.test(m.id));
  const first = models[0];
  const model = foreign ?? first;
  if (model === undefined) throw new Error('the router serves no model to ask with');
  return model;
}

/** The scratch config dir — the block lands here, never in the operator's. */
function prepareConfig(live: Live): void {
  mkdirSync(live.workDir, { recursive: true });
  const block = claudeCodeAdapter.renderModelBlock(live.models);
  writeFileSync(
    join(live.configDir, 'settings.json'),
    `${JSON.stringify({ modelPicker: block }, null, 2)}\n`
  );
}

/** A local echo — the probe that measures the client's own handling of a
 *  model it knows, without spending the router's budget. */
function echoServer(): { url: string; close: () => void } {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (!String(req.url).includes('/v1/messages')) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let parsed: { model?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // the body is the client's; an unparsable one is the client's fault
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_echo',
          type: 'message',
          role: 'assistant',
          model: parsed.model ?? 'unknown',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  server.listen(0, '127.0.0.1');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The facts, read from the runs. */
function findingsOf(
  live: Live,
  routerRun: ClientRun,
  listOutput: string,
  probe: RequestShape
): Findings {
  const messages = routerRun.transcript.messages;
  const shapes = routerRun.transcript.requests;
  const first = shapes[0];
  const texts = messages.map(m => m.text).filter(t => t !== '');
  const toolUse = messages.findIndex(m => m.blocks.includes('tool_use'));
  const answered = messages.findIndex((m, i) => i > toolUse && m.blocks.includes('text'));
  return {
    code: routerRun.code,
    model: live.model,
    sent: shapes.map(s => s.model).filter(m => m !== undefined),
    effort: first?.effort ?? '',
    cap: first?.maxTokens ?? 0,
    borrowedEffort: probe.effort ?? '',
    borrowedCap: probe.maxTokens ?? 0,
    label: live.label,
    listOutput: listOutput.trim(),
    warned: routerRun.output.includes("isn't recognized"),
    ranTool: toolUse >= 0,
    toolAnswered: answered > toolUse && toolUse >= 0,
    repeated: texts.some((text, i) => i > 0 && texts[i - 1] === text),
    served: live.models.some(m => m.id === live.model),
  };
}

/** The facts, said one by one. */
function printFindings(findings: Findings): void {
  console.log(`client exit: ${findings.code ?? 'killed'}`);
  console.log(`model sent: ${[...new Set(findings.sent)].join(', ')}`);
  console.log(
    `handling: effort ${findings.effort} / cap ${findings.cap} (borrowed model: effort ${findings.borrowedEffort} / cap ${findings.borrowedCap})`
  );
  console.log(`picker label: ${findings.listOutput}`);
  console.log(`"isn't recognized" warning: ${findings.warned ? 'YES' : 'no'}`);
  console.log(`tool ran: ${findings.ranTool ? 'yes' : 'no'}`);
  console.log(`tool answered: ${findings.toolAnswered ? 'yes' : 'no'}`);
  console.log(`repeated answer: ${findings.repeated ? 'YES — the loop is back' : 'no'}`);
}

/** The failures — what the check refuses to pass. */
function failuresOf(findings: Findings): string[] {
  return [...exitFailures(findings), ...recognitionFailures(findings), ...loopFailures(findings)];
}

/** The client must exit clean, and never warn about the model. */
function exitFailures(findings: Findings): string[] {
  const failures: string[] = [];
  if (findings.code !== 0) failures.push(`the client exited ${findings.code}`);
  if (findings.warned) failures.push('the client warns "isn\'t recognized"');
  return failures;
}

/** The client must send the served id and treat it as the borrowed one. */
function recognitionFailures(findings: Findings): string[] {
  const failures: string[] = [];
  if (!findings.sent.includes(findings.model)) {
    failures.push('the client did not send the served id verbatim');
  }
  if (findings.effort !== findings.borrowedEffort || findings.cap !== findings.borrowedCap) {
    failures.push('the client did not treat the served model as the borrowed one');
  }
  if (!findings.listOutput.includes(findings.label)) {
    failures.push(`the picker did not offer the router's label "${findings.label}"`);
  }
  return failures;
}

/** The tool must run, be answered, and not repeat. */
function loopFailures(findings: Findings): string[] {
  const failures: string[] = [];
  if (!findings.ranTool) failures.push('no tool ran — the client never got a tool_use');
  if (!findings.toolAnswered) failures.push('the tool result was never answered');
  if (findings.repeated) failures.push('the client repeated the same answer — the loop is back');
  return failures;
}

/** The check — the facts, one by one. */
async function main(): Promise<void> {
  const args: Args = { argv: process.argv.slice(2) };
  const endpoint = endpointOf(args);
  const { models } = await readCatalog(endpoint);
  if (models.length === 0) {
    throw new Error('the router serves no models — there is nothing to check');
  }
  const underTest = modelUnderTest(models);
  const configDir = flagOf(args, '--config-dir') ?? mkdtempSync(join(tmpdir(), 'bro-cc-live-'));
  const live: Live = {
    args,
    endpoint,
    models,
    model: underTest.id,
    borrowed: CLAUDE_CODE_BEHAVES_AS[modelFamily(underTest.id)],
    label: underTest.label ?? underTest.id,
    configDir,
    workDir: join(configDir, 'work'),
    projectsDir: join(configDir, 'projects'),
  };
  prepareConfig(live);
  console.log(`router: ${endpoint.url}`);
  console.log(`served: ${models.length} model(s)`);
  console.log(`block: ${models.length} row(s) → ${configDir}/settings.json`);
  console.log(`asking with: ${live.model} (borrows ${live.borrowed})`);

  // the router run — the tool, and whether the answer repeats
  const routerRun = runClient(live, TOOL_PROMPT, ['--model', live.model], endpoint.url);
  // the picker run — the router's own label comes back
  const listRun = runClient(live, `/model ${live.model}`, [], endpoint.url);
  // the probe — the borrowed model's own handling, measured locally
  const echo = echoServer();
  const probeRun = runClient(live, 'ping', ['--model', live.borrowed], echo.url);
  echo.close();
  const probe = probeRun.transcript.requests[0] ?? {};

  const findings = findingsOf(live, routerRun, listRun.output, probe);
  console.log('');
  printFindings(findings);

  if (flagOf(args, '--keep') === undefined) {
    rmSync(configDir, { recursive: true, force: true });
  } else {
    console.log(`kept: ${configDir}`);
  }

  const failures = failuresOf(findings);
  if (failures.length > 0) {
    console.log('');
    console.log(`FAIL — ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('');
  console.log('PASS — the client knows the model, the tool ran, and the request was not repeated');
}

await main();
