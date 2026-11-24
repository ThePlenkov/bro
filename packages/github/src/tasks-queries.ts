/**
 * The github connector's read path — the issue node shape, repo/id
 * resolution, and the GraphQL queries `gh` carries (moved from
 * tasks.ts).
 *
 * `gh` is the transport: `gh api graphql` for reads. GHES fallback:
 * `blockedBy`/`subIssues`/`parent`/`issueType` are github.com schema
 * additions — a schema error on them retries without relation fields.
 */
import { ghHost, ghJson, ghJsonAsync, ghTry, resolveRepo, resolveRepoAsync } from '@broject/core';

// --- issue node shape ---------------------------------------------------------

export interface Ref {
  number: number;
  state: string;
}

export interface IssueNode {
  number: number;
  /** GraphQL node id — mutations that take issueId want this. */
  id: string;
  /** REST databaseId — dependencies/sub-issues endpoints want this. */
  databaseId?: number;
  title: string;
  body?: string;
  url: string;
  state: string;
  stateReason?: string | null;
  createdAt: string;
  closedAt?: string | null;
  issueType?: { name: string } | null;
  labels?: { nodes: { name: string }[] };
  assignees?: { nodes: { login: string }[] };
  parent?: { number: number } | null;
  blockedBy?: { nodes: Ref[] };
  blocking?: { nodes: Ref[] };
  subIssues?: { nodes: Ref[] };
}

const CORE_FIELDS = `
  number id databaseId title body url state stateReason createdAt closedAt
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login } }
`;

const REL_FIELDS = `
  parent { number }
  issueType { name }
  blockedBy(first: 25) { nodes { number state } }
  blocking(first: 25) { nodes { number state } }
  subIssues(first: 50) { nodes { number state } }
`;

const nodeFields = (rel: boolean): string => (rel ? CORE_FIELDS + REL_FIELDS : CORE_FIELDS);

/** Schema-drift marker: github.com fields a GHES schema lacks. */
const DRIFT_FIELD = /blockedBy|blocking|subIssues|issueType|parent\b/;
const DRIFT_MSG = /Cannot query field|does not exist|Field .* doesn't exist/i;
const isDriftError = (err: unknown): boolean =>
  DRIFT_FIELD.test(String(err)) && DRIFT_MSG.test(String(err));

// --- id + repo resolution -----------------------------------------------------

/** '42' | '#42' | this repo's issue URL → 42. Anything else is a usage
 *  error — a foreign ref must not silently target a wrong number: a URL
 *  naming another repo would mutate that repo's issue NUMBER against
 *  this one. */
export function issueNumber(dir: string, id: string): number {
  const t = id.trim();
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(t);
  if (url) {
    const slug = `${url[2]}/${url[3]}`.toLowerCase();
    const mine = repoOf(dir).toLowerCase();
    if (url[1]!.toLowerCase() !== ghHost().toLowerCase() || slug !== mine) {
      throw new Error(
        `github tasks: "${id}" is a ${url[1]}/${slug} issue — this store serves ${ghHost()}/${mine}`
      );
    }
    return Number(url[4]);
  }
  if (!/^(#\d+|\d+)$/.test(t)) {
    throw new Error(
      `github tasks: "${id}" is not an issue reference (want 42, #42, or an issue URL)`
    );
  }
  const n = Number(t.replace(/^#/, ''));
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `github tasks: "${id}" is not an issue reference (want 42, #42, or an issue URL)`
    );
  }
  return n;
}

const repoCache = new Map<string, string>();

export function repoOf(dir: string): string {
  let r = repoCache.get(dir);
  if (r === undefined) {
    r = resolveRepo([], dir);
    repoCache.set(dir, r);
  }
  return r;
}

export async function repoOfAsync(dir: string): Promise<string> {
  let r = repoCache.get(dir);
  if (r === undefined) {
    r = await resolveRepoAsync([], dir);
    repoCache.set(dir, r);
  }
  return r;
}

const splitRepo = (repo: string): { o: string; r: string } => {
  const [o, r] = repo.split('/');
  return { o: o!, r: r! };
};

// --- graphql read path --------------------------------------------------------

const ISSUES_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$states:[IssueState!]!,$cursor:String){
  repository(owner:$o,name:$r){
    issues(first:100,after:$cursor,states:$states,orderBy:{field:CREATED_AT,direction:ASC}){
      nodes{${nodeFields(rel)}}
      pageInfo{hasNextPage endCursor}
    }
  }
}`;

const ISSUE_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){ issue(number:$n){${nodeFields(rel)}} }
}`;

const SUBISSUES_QUERY = (rel: boolean): string => `
query($o:String!,$r:String!,$n:Int!){
  repository(owner:$o,name:$r){ issue(number:$n){ subIssues(first:50){nodes{${nodeFields(rel)}}} } }
}`;

interface IssuePage {
  data?: {
    repository?: {
      issues?: { nodes?: IssueNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
    };
  };
}

function stateVars(states: string[], cursor: string | undefined): string[] {
  return [...states.flatMap(s => ['-f', `states=${s}`]), '-f', `cursor=${cursor ?? ''}`];
}

/** argv for one issues page — the sync/async fetchers share the shape. */
const issuesPageArgs =
  (o: string, r: string, states: string[], cursor: string | undefined) =>
  (rel: boolean): string[] => [
    'api',
    'graphql',
    '-f',
    `query=${ISSUES_QUERY(rel)}`,
    '-f',
    `o=${o}`,
    '-f',
    `r=${r}`,
    ...stateVars(states, cursor),
  ];

/** The next page cursor — undefined ends pagination (no more pages, or
 *  a pageInfo-less response the loop must not guess past). */
function pageBoundary(
  conn: { pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | undefined
): string | undefined {
  return conn?.pageInfo?.hasNextPage === true && conn.pageInfo.endCursor
    ? conn.pageInfo.endCursor
    : undefined;
}

export function queryIssuesSync(dir: string, states: string[], limit: number): IssueNode[] {
  const { o, r } = splitRepo(repoOf(dir));
  const out: IssueNode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const args = issuesPageArgs(o, r, states, cursor);
    let page: IssuePage;
    try {
      page = ghJson<IssuePage>(args(true), dir);
    } catch (err) {
      if (!isDriftError(err)) {
        throw err;
      }
      page = ghJson<IssuePage>(args(false), dir);
    }
    const conn = page.data?.repository?.issues;
    out.push(...(conn?.nodes ?? []));
    if (out.length >= limit) {
      break;
    }
    cursor = pageBoundary(conn);
    if (cursor === undefined) {
      break;
    }
  }
  return out.slice(0, limit);
}

export async function queryIssuesAsync(
  dir: string,
  states: string[],
  limit: number
): Promise<IssueNode[]> {
  const { o, r } = splitRepo(await repoOfAsync(dir));
  const out: IssueNode[] = [];
  let cursor: string | undefined;
  for (;;) {
    const args = issuesPageArgs(o, r, states, cursor);
    let page: IssuePage;
    try {
      page = await ghJsonAsync<IssuePage>(args(true), dir);
    } catch (err) {
      if (!isDriftError(err)) {
        throw err;
      }
      page = await ghJsonAsync<IssuePage>(args(false), dir);
    }
    const conn = page.data?.repository?.issues;
    out.push(...(conn?.nodes ?? []));
    if (out.length >= limit) {
      break;
    }
    cursor = pageBoundary(conn);
    if (cursor === undefined) {
      break;
    }
  }
  return out.slice(0, limit);
}

export function queryIssueSync(dir: string, n: number): IssueNode | undefined {
  const { o, r } = splitRepo(repoOf(dir));
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`];
  const run = (rel: boolean) =>
    ghJson<{ data?: { repository?: { issue?: IssueNode | null } } }>(
      ['api', 'graphql', '-f', `query=${ISSUE_QUERY(rel)}`, ...vars],
      dir
    ).data?.repository?.issue ?? undefined;
  try {
    return run(true);
  } catch (err) {
    if (!isDriftError(err)) {
      throw err;
    }
    return run(false);
  }
}

export async function queryIssueAsync(dir: string, n: number): Promise<IssueNode | undefined> {
  const { o, r } = splitRepo(await repoOfAsync(dir));
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`];
  const run = async (rel: boolean) =>
    (
      await ghJsonAsync<{ data?: { repository?: { issue?: IssueNode | null } } }>(
        ['api', 'graphql', '-f', `query=${ISSUE_QUERY(rel)}`, ...vars],
        dir
      )
    ).data?.repository?.issue ?? undefined;
  try {
    return await run(true);
  } catch (err) {
    if (!isDriftError(err)) {
      throw err;
    }
    return run(false);
  }
}

export function querySubIssuesSync(dir: string, n: number): IssueNode[] {
  const { o, r } = splitRepo(repoOf(dir));
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`];
  const run = (rel: boolean) =>
    ghJson<{ data?: { repository?: { issue?: { subIssues?: { nodes?: IssueNode[] } } | null } } }>(
      ['api', 'graphql', '-f', `query=${SUBISSUES_QUERY(rel)}`, ...vars],
      dir
    ).data?.repository?.issue?.subIssues?.nodes ?? [];
  try {
    return run(true);
  } catch (err) {
    if (!isDriftError(err)) {
      throw err;
    }
    // the drifted field may sit INSIDE the sub-issue nodes (issueType,
    // blockedBy, parent) while subIssues itself is supported — retry
    // core-only before declaring the feature absent; an empty list
    // must mean "no children", never "the query died"
    try {
      return run(false);
    } catch (retryErr) {
      if (!isDriftError(retryErr)) {
        throw retryErr;
      }
      return []; // GHES: subIssues itself absent — declared, not faked
    }
  }
}

export async function querySubIssuesAsync(dir: string, n: number): Promise<IssueNode[]> {
  const { o, r } = splitRepo(await repoOfAsync(dir));
  const vars = ['-f', `o=${o}`, '-f', `r=${r}`, '-F', `n=${n}`];
  const run = async (rel: boolean) =>
    (
      await ghJsonAsync<{
        data?: { repository?: { issue?: { subIssues?: { nodes?: IssueNode[] } } | null } };
      }>(['api', 'graphql', '-f', `query=${SUBISSUES_QUERY(rel)}`, ...vars], dir)
    ).data?.repository?.issue?.subIssues?.nodes ?? [];
  try {
    return await run(true);
  } catch (err) {
    if (!isDriftError(err)) {
      throw err;
    }
    // the drifted field may sit INSIDE the sub-issue nodes (issueType,
    // blockedBy, parent) while subIssues itself is supported — retry
    // core-only before declaring the feature absent; an empty list
    // must mean "no children", never "the query died"
    try {
      return await run(false);
    } catch (retryErr) {
      if (!isDriftError(retryErr)) {
        throw retryErr;
      }
      return []; // GHES: subIssues itself absent — declared, not faked
    }
  }
}

// --- actor + mutation helpers -----------------------------------------------------

const actorCache = new Map<string, string>();

export function ghActor(dir: string): string {
  let a = actorCache.get(dir);
  if (a === undefined) {
    a = ghJson<{ login?: string }>(['api', 'user'], dir).login ?? '';
    actorCache.set(dir, a);
  }
  return a;
}

export async function ghActorAsync(dir: string): Promise<string> {
  let a = actorCache.get(dir);
  if (a === undefined) {
    a = (await ghJsonAsync<{ login?: string }>(['api', 'user'], dir)).login ?? '';
    actorCache.set(dir, a);
  }
  return a;
}

/** `gh label create --force` is idempotent — a create failure is fine
 *  (the label may exist; the later add reports the real error). */
export function ensureLabel(dir: string, name: string): void {
  ghTry(
    ['label', 'create', name, '--force', '--color', '8b949e', '--description', 'bro-managed'],
    dir
  );
}
