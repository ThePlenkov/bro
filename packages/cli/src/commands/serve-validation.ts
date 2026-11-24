import type { StepSpawnRequest } from './agents.ts';

/** Fail-closed request error carrying its status. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    public status: number,
    message: string,
    public close = false
  ) {
    super(message);
  }
}

const SPAWN_FIELDS = new Set([
  'molStep',
  'worktree',
  'prompt',
  'promptFile',
  'connector',
  'beadsDir',
  'provider',
  'model',
  'profile',
  'class',
  'autoApprove',
  'lane',
  'resumeSessionId',
]);

function spawnDoc(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') {
    throw new HttpError(400, 'POST /api/v1/agents needs a JSON body');
  }
  return validateSpawnDocument(parseJson(raw));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function validateSpawnDocument(doc: unknown): Record<string, unknown> {
  if (!isObjectDocument(doc)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  const unknown = Object.keys(doc).filter(k => !SPAWN_FIELDS.has(k));
  if (unknown.length > 0) {
    throw new HttpError(400, `unknown field(s): ${unknown.join(', ')}`);
  }
  return doc as Record<string, unknown>;
}

function isObjectDocument(doc: unknown): doc is object {
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc);
}

function assertSpawnField(k: string, v: unknown): void {
  if (k === 'autoApprove') {
    assertBooleanField(v);
    return;
  }
  assertStringField(k, v);
}

function assertBooleanField(v: unknown): void {
  if (v !== undefined && typeof v !== 'boolean') {
    throw new HttpError(400, 'field "autoApprove" must be a boolean');
  }
}

function assertStringField(k: string, v: unknown): void {
  if (v === undefined) {
    return;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    throw new HttpError(400, `field "${k}" must be a non-empty string`);
  }
}

function spawnLane(req: Record<string, unknown>): 'batch' | 'interactive' {
  if (req.lane === undefined) {
    return 'interactive';
  }
  if (req.lane !== 'batch' && req.lane !== 'interactive') {
    throw new HttpError(400, 'field "lane" must be "batch" or "interactive"');
  }
  return req.lane;
}

/** POST body → StepSpawnRequest — strict: a misspelled field is a 400. */
export function parseSpawnBody(raw: string | undefined): StepSpawnRequest {
  const req = spawnDoc(raw);
  validateSpawnFields(req);
  return {
    lane: spawnLane(req),
    molStep: req.molStep as string,
    worktree: req.worktree as string | undefined,
    prompt: req.prompt as string | undefined,
    promptFile: req.promptFile as string | undefined,
    connector: req.connector as string | undefined,
    beadsDir: req.beadsDir as string | undefined,
    provider: req.provider as string | undefined,
    model: req.model as string | undefined,
    profile: req.profile as string | undefined,
    class: req.class as string | undefined,
    autoApprove: req.autoApprove as boolean | undefined,
    resumeSessionId: req.resumeSessionId as string | undefined,
  };
}

function validateSpawnFields(req: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(req)) {
    assertSpawnField(k, v);
  }
  if (typeof req.molStep !== 'string' || req.molStep.trim() === '') {
    throw new HttpError(400, 'field "molStep" is required');
  }
}
