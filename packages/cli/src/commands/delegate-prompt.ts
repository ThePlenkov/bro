/** The delegate request's prompt channel — --prompt and --prompt-file
 *  are the same channel (mutually exclusive). The file read is a
 *  bounded regular file only: a prompt file is one turn's payload,
 *  never an unbounded stream or a device. (spec bro-z8tng) */
import { readFileSync, statSync, type Stats } from 'node:fs';
import { SpawnInputError } from './agents.ts';
import { MAX_PROMPT_FILE_BYTES, type DelegateRequest } from './delegate.ts';

/** Read a --prompt-file — size + regularity gate before the read. */
function promptFileText(path: string): string {
  let st: Stats;
  try {
    st = statSync(path);
  } catch {
    throw new SpawnInputError(`prompt file ${path} does not exist or is not a regular file`);
  }
  if (!st.isFile()) {
    throw new SpawnInputError(`prompt file ${path} is not a regular file`);
  }
  if (st.size > MAX_PROMPT_FILE_BYTES) {
    throw new SpawnInputError(
      `prompt file ${path} is ${st.size} bytes — a turn payload caps at ${MAX_PROMPT_FILE_BYTES}`
    );
  }
  return readFileSync(path, 'utf8');
}

/** Absent or whitespace is no prompt at all — both refuse. */
function requirePrompt(text: string | undefined): string {
  if (text === undefined) {
    throw new SpawnInputError(
      'delegate requires a prompt — --prompt <text> or --prompt-file <file>'
    );
  }
  if (text.trim() === '') {
    throw new SpawnInputError('prompt must not be empty');
  }
  return text;
}

/** The prompt text the request carries. */
export function delegatePrompt(req: DelegateRequest): string {
  if (req.prompt !== undefined && req.promptFile !== undefined) {
    throw new SpawnInputError('prompt and promptFile are mutually exclusive');
  }
  const text =
    req.prompt ?? (req.promptFile === undefined ? undefined : promptFileText(req.promptFile));
  return requirePrompt(text);
}
