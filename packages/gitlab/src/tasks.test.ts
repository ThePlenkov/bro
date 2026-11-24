import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { facade, facadeName, registerConnector, scrubEnv, testGit } from '@broject/core';
import { gitlabConnector } from './index.ts';
import { gitlabTasks, gitlabTasksAsync } from './tasks.ts';

// ambient repo/agent/store pins must not reach fixture git children
// or the code-under-test spawns — scrub once, restore after the file;
// GITLAB_HOST is the facade's own host pin and must not leak in either
after(scrubEnv(['GITLAB_HOST']));

const WIN32 = process.platform === 'win32';

/** Scripted glab on PATH — records argv + the GITLAB_HOST pin to
 *  $FAKE_GLAB_LOG, answers REST reads by endpoint shape and writes by
 *  method+endpoint. Payloads are env-driven:
 *    FAKE_GLAB_PAGES     — dir of <state>-<page>.json / <state>.json
 *                         list bodies (glabPaged's per_page=100&page=N)
 *    FAKE_GLAB_ISSUES    — fallback list body when no PAGES dir
 *    FAKE_GLAB_ISSUE     — every issues/<iid> read body
 *    FAKE_GLAB_ISSUE_SEQ — dir of <n>.json bodies: the Nth issues/<iid>
 *                         read answers file <n> — claim interleavings
 *    FAKE_GLAB_ISSUE_404 / _500 — comma iids the read fails for
 *    FAKE_GLAB_ACTOR / _USER_ID — `api user` / `users?username=`
 *    FAKE_GLAB_CREATED   — POST /issues response
 *    FAKE_GLAB_FAIL_ALL / _NOTE_FAIL / _PUT_FAIL — transport failures
 *    FAKE_GLAB_LINK_NEEDS_PROJECT — first links POST demands
 *                         target_project_id (the retry the code runs) */
const FAKE_GLAB = `#!/bin/sh
echo "$@" >> "$FAKE_GLAB_LOG"
echo "env:GITLAB_HOST=$GITLAB_HOST" >> "$FAKE_GLAB_LOG"
if [ "$FAKE_GLAB_FAIL_ALL" = "1" ]; then echo 'token expired' >&2; exit 1; fi
case "$1 $2" in
  "api -X") case "$3 $4" in
      "POST "*"/issues/"*"/notes")
        if [ "$FAKE_GLAB_NOTE_FAIL" = "1" ]; then echo 'note refused' >&2; exit 1; fi
        echo '{"id":99}' ;;
      "POST "*"/issues/"*"/links")
        case "$*" in
          *target_project_id*) echo '{}' ;;
          *) if [ "$FAKE_GLAB_LINK_NEEDS_PROJECT" = "1" ]; then echo 'target_project_id is required' >&2; exit 1; fi; echo '{}' ;;
        esac ;;
      "POST "*"/labels") echo '{}' ;;
      "POST "*"/issues")
        if [ -n "$FAKE_GLAB_CREATED" ]; then printf '%s\\n' "$FAKE_GLAB_CREATED";
        else echo '{"iid":42,"state":"opened","title":"created"}'; fi ;;
      "PUT "*"/issues/"*)
        if [ "$FAKE_GLAB_PUT_FAIL" = "1" ]; then echo 'put refused' >&2; exit 1; fi
        echo '{}' ;;
      "DELETE "*"/issues/"*) echo '{}' ;;
    esac ;;
  "api "*) case "$2" in
      user) printf '%s\\n' "{\\"username\\":\\"$FAKE_GLAB_ACTOR\\"}" ;;
      "users?username="*) printf '%s\\n' "[{\\"id\\":\${FAKE_GLAB_USER_ID:-7},\\"username\\":\\"$FAKE_GLAB_ACTOR\\"}]" ;;
      *"/issues?state="*)
        st=$(echo "$2" | sed 's/.*state=\\([a-z]*\\).*/\\1/')
        pg=$(echo "$2" | sed 's/.*page=\\([0-9]*\\).*/\\1/')
        if [ -n "$FAKE_GLAB_PAGES" ]; then
          for f in "$FAKE_GLAB_PAGES/$st-$pg.json" "$FAKE_GLAB_PAGES/$st.json"; do
            if [ -f "$f" ]; then cat "$f"; exit 0; fi
          done
        fi
        printf '%s\\n' "\${FAKE_GLAB_ISSUES:-[]}" ;;
      *"/issues/"*)
        iid=$(echo "$2" | sed 's/.*issues\\///; s/[^0-9].*//')
        case ",$FAKE_GLAB_ISSUE_404," in *",$iid,"*) echo '404 Not Found' >&2; exit 1 ;; esac
        case ",$FAKE_GLAB_ISSUE_500," in *",$iid,"*) echo '500 Server Error' >&2; exit 1 ;; esac
        n=$(grep -c "issues/$iid\$" "$FAKE_GLAB_LOG")
        if [ -n "$FAKE_GLAB_ISSUE_SEQ" ] && [ -f "$FAKE_GLAB_ISSUE_SEQ/$n.json" ]; then
          cat "$FAKE_GLAB_ISSUE_SEQ/$n.json"
        elif [ -n "$FAKE_GLAB_ISSUE" ]; then printf '%s\\n' "$FAKE_GLAB_ISSUE"
        else printf '%s\\n' "{\\"iid\\":$iid,\\"state\\":\\"opened\\",\\"title\\":\\"issue $iid\\"}"
        fi ;;
      *) echo '[]' ;;
    esac ;;
esac
exit 0
`;

interface IssueOpts {
  iid: number;
  title?: string;
  state?: string;
  labels?: string[];
  assignees?: string[];
  description?: string | null;
  web_url?: string;
  created_at?: string;
  closed_at?: string | null;
  /** premium flag — open incoming blockers */
  blocked?: boolean;
  /** outgoing count — issues THIS issue blocks; NOT a blocked signal */
  blocking_issues_count?: number;
}

/** A GitLab REST issue row in the shape tasks.ts consumes. */
const issue = (o: IssueOpts): Record<string, unknown> => ({
  iid: o.iid,
  title: o.title ?? `issue ${o.iid}`,
  state: o.state ?? 'opened',
  labels: o.labels ?? [],
  assignees: (o.assignees ?? []).map(username => ({ username })),
  web_url: o.web_url ?? `https://gitlab.com/acme/widgets/-/issues/${o.iid}`,
  created_at: o.created_at ?? `2026-01-${String((o.iid % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  closed_at: o.closed_at ?? null,
  ...(o.description !== undefined ? { description: o.description } : {}),
  ...(o.blocked !== undefined ? { blocked: o.blocked } : {}),
  ...(o.blocking_issues_count !== undefined
    ? { blocking_issues_count: o.blocking_issues_count }
    : {}),
});

const issuesJson = (...rows: Record<string, unknown>[]): string => JSON.stringify(rows);

/** A git repo in a tmpdir with `url` as origin — project resolution
 *  needs a real checkout, the host never sees a call. */
function makeRepo(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gitlab-tasks-'));
  testGit(['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  testGit(['remote', 'add', 'origin', url], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function withFakeGlab(env: Record<string, string>, fn: (log: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-glab-'));
  const log = join(dir, 'glab.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'glab'), FAKE_GLAB);
  chmodSync(join(dir, 'glab'), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  const prevEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, { FAKE_GLAB_LOG: log, ...env });
  try {
    fn(log);
  } finally {
    process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.FAKE_GLAB_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
}

const calls = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n');
const callsMatching = (log: string, re: RegExp): string[] => calls(log).filter(l => re.test(l));

/** Write <name>.json page bodies into a tmpdir and hand it to fn —
 *  the dir is FAKE_GLAB_PAGES material (state-page fallbacks). */
function withPages(files: Record<string, string>, fn: (pagesDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bro-gl-pages-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.json`), body);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFakeGlabAsync(
  env: Record<string, string>,
  fn: (log: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bro-fake-glab-'));
  const log = join(dir, 'glab.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'glab'), FAKE_GLAB);
  chmodSync(join(dir, 'glab'), 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  const prevEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, { FAKE_GLAB_LOG: log, ...env });
  try {
    await fn(log);
  } finally {
    process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.FAKE_GLAB_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** env + a repo on a gitlab.com acme/widgets remote — the common case:
 *  run fn(store-dir, log) with the fake glab on PATH. */
function withRepo(
  env: Record<string, string>,
  fn: (dir: string, log: string) => void,
  url = 'git@gitlab.com:acme/widgets.git'
): void {
  const repo = makeRepo(url);
  try {
    withFakeGlab(env, log => fn(repo, log));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** async twin — the env pins must outlive fn's awaits, so the harness
 *  has to await it instead of restoring PATH at the first suspension. */
async function withRepoAsync(
  env: Record<string, string>,
  fn: (dir: string, log: string) => Promise<void>,
  url = 'git@gitlab.com:acme/widgets.git'
): Promise<void> {
  const repo = makeRepo(url);
  try {
    await withFakeGlabAsync(env, log => fn(repo, log));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('gitlabTasks', { skip: WIN32 }, () => {
  test('list maps state/labels/assignees onto task status', () => {
    const opened = issuesJson(
      issue({ iid: 1, title: 'plain open' }),
      issue({ iid: 2, title: 'claimed label', labels: ['bro:claimed'] }),
      issue({ iid: 3, title: 'assigned', assignees: ['me'] }),
      issue({ iid: 4, title: 'blocked label', labels: ['blocked'] }),
      issue({ iid: 5, title: 'open incoming blockers', blocked: true }),
      // blocking_issues_count counts issues THIS issue blocks —
      // outgoing. A blocker is itself ready work, not 'blocked'.
      issue({ iid: 6, title: 'blocks two others', blocking_issues_count: 2 })
    );
    withRepo({ FAKE_GLAB_ISSUES: opened }, dir => {
      const rows = gitlabTasks(dir).list();
      const status = new Map(rows.map(r => [r.id, r.status]));
      assert.deepEqual(Object.fromEntries(status), {
        '1': 'open',
        '2': 'in_progress',
        '3': 'in_progress',
        '4': 'blocked',
        '5': 'blocked',
        '6': 'open',
      });
    });
  });

  test('row shape — trailer metadata, stripped description, assignee, closed_at', () => {
    const body = 'the prose\n\n<!-- bro: {"type":"bug","priority":1,"external_ref":"jira:X-1"} -->';
    const files = {
      opened: issuesJson(
        issue({
          iid: 7,
          description: body,
          labels: ['type:chore', 'p3'],
          assignees: ['a', 'b'],
        })
      ),
      closed: issuesJson(issue({ iid: 8, state: 'closed', closed_at: '2026-02-02T00:00:00Z' })),
    };
    withPages(files, pages => {
      withRepo({ FAKE_GLAB_PAGES: pages }, dir => {
        const rows = gitlabTasks(dir).list({ all: true });
        const r7 = rows.find(r => r.id === '7')!;
        // labels beat the trailer for type/priority
        assert.equal(r7.issue_type, 'chore');
        assert.equal(r7.priority, 3);
        assert.equal(r7.description, 'the prose');
        assert.equal(r7.external_ref, 'jira:X-1');
        assert.equal(r7.assignee, 'a, b');
        assert.equal(r7.metadata?.type, 'bug');
        const r8 = rows.find(r => r.id === '8')!;
        assert.equal(r8.status, 'closed');
        assert.equal(r8.closed_at, '2026-02-02T00:00:00Z');
      });
    });
  });

  test('trailer wins type/priority when labels do not carry them', () => {
    const body = 'x\n\n<!-- bro: {"type":"feature","priority":0} -->';
    withRepo({ FAKE_GLAB_ISSUES: issuesJson(issue({ iid: 1, description: body })) }, dir => {
      const r = gitlabTasks(dir).list()[0]!;
      assert.equal(r.issue_type, 'feature');
      assert.equal(r.priority, 0);
    });
  });

  test('glabPaged assembles multiple pages until a short page', () => {
    const p1 = Array.from({ length: 100 }, (_, i) => issue({ iid: i + 1 }));
    const files = {
      'opened-1': issuesJson(...p1),
      'opened-2': issuesJson(issue({ iid: 101 }), issue({ iid: 102 }), issue({ iid: 103 })),
    };
    withPages(files, pages => {
      withRepo({ FAKE_GLAB_PAGES: pages }, (dir, log) => {
        const rows = gitlabTasks(dir).list();
        assert.equal(rows.length, 103);
        const listCalls = callsMatching(log, /issues\?state=opened/);
        assert.equal(listCalls.length, 2);
        assert.match(listCalls[0]!, /page=1$/);
        assert.match(listCalls[1]!, /page=2$/);
      });
    });
  });

  test('a limit stops pagination after the first full page', () => {
    const p1 = Array.from({ length: 100 }, (_, i) => issue({ iid: i + 1 }));
    withPages({ 'opened-1': issuesJson(...p1) }, pages => {
      withRepo({ FAKE_GLAB_PAGES: pages }, (dir, log) => {
        const rows = gitlabTasks(dir).list({ limit: 5 });
        assert.equal(rows.length, 5);
        // the fetch cap honors the limit — page 2 is never asked for
        assert.equal(callsMatching(log, /page=2/).length, 0);
      });
    });
  });

  test('list({all:true}) queries opened then closed endpoints', () => {
    const files = {
      opened: issuesJson(issue({ iid: 1 })),
      closed: issuesJson(issue({ iid: 2, state: 'closed' })),
    };
    withPages(files, pages => {
      withRepo({ FAKE_GLAB_PAGES: pages }, (dir, log) => {
        const rows = gitlabTasks(dir).list({ all: true });
        assert.deepEqual(rows.map(r => r.id).sort(), ['1', '2']);
        assert.match(calls(log).join('\n'), /state=opened/);
        assert.match(calls(log).join('\n'), /state=closed/);
      });
    });
  });

  test('status=closed hits the closed endpoint only; labels post-filter', () => {
    withPages({ closed: issuesJson(issue({ iid: 2, state: 'closed' })) }, pages => {
      withRepo({ FAKE_GLAB_PAGES: pages }, (dir, log) => {
        assert.deepEqual(
          gitlabTasks(dir)
            .list({ status: 'closed' })
            .map(r => r.id),
          ['2']
        );
        assert.equal(callsMatching(log, /state=opened/).length, 0);
      });
    });
    withRepo(
      {
        FAKE_GLAB_ISSUES: issuesJson(
          issue({ iid: 1, labels: ['bug'] }),
          issue({ iid: 2, labels: ['feat'] })
        ),
      },
      dir => {
        assert.deepEqual(
          gitlabTasks(dir)
            .list({ labels: ['bug'] })
            .map(r => r.id),
          ['1']
        );
        assert.deepEqual(
          gitlabTasks(dir)
            .list({ excludeLabels: ['feat'] })
            .map(r => r.id),
          ['1']
        );
      }
    );
  });

  test('ready keeps only open rows, ordered priority then created', () => {
    const opened = issuesJson(
      issue({ iid: 1, title: 'blocked', labels: ['blocked', 'p0'] }),
      issue({ iid: 2, title: 'claimed', assignees: ['me'], labels: ['p0'] }),
      issue({ iid: 3, title: 'p1 later', labels: ['p1'], created_at: '2026-01-02T00:00:00Z' }),
      issue({ iid: 4, title: 'p2', labels: ['p2'], created_at: '2026-01-01T00:00:00Z' }),
      issue({ iid: 5, title: 'p1 earlier', labels: ['p1'], created_at: '2026-01-01T00:00:00Z' })
    );
    withRepo({ FAKE_GLAB_ISSUES: opened }, dir => {
      assert.deepEqual(
        gitlabTasks(dir)
          .ready()
          .map(r => r.id),
        ['5', '3', '4']
      );
    });
  });

  test('id forms — bare, #-prefixed, URL, project-scoped, cross-project', () => {
    withRepo({}, (dir, log) => {
      const store = gitlabTasks(dir);
      for (const id of ['42', '#42', 'https://gitlab.com/acme/widgets/-/issues/42']) {
        assert.equal(store.get(id)?.id, '42', id);
      }
      // a project path that matches the remote resolves to this store
      assert.equal(store.get('acme/widgets#9')?.id, '9');
      assert.equal(store.get('acme/widgets:10')?.id, '10');
      // a different project path is a permissive cross-project read —
      // the row carries the foreign id form (spec bro-l8c4f.16)
      const foreign = store.get('other/proj#5')!;
      assert.equal(foreign.id, 'other/proj#5');
      assert.match(calls(log).join('\n'), /projects\/other%2Fproj\/issues\/5/);
      // ...while the URL form is strict about the store it names
      assert.throws(
        () => store.get('https://gitlab.com/other/proj/-/issues/5'),
        /is for other\/proj — this store serves acme\/widgets/
      );
      assert.throws(
        () => store.get('https://ghe.corp/acme/widgets/-/issues/5'),
        /is from ghe\.corp — this store serves gitlab\.com/
      );
      for (const bad of ['abc', 'issue-42', '0', '-3', '4.5']) {
        assert.throws(() => store.get(bad), /not an issue reference/, bad);
      }
    });
  });

  test('nested groups keep their slashes in the project path', () => {
    withRepo(
      {},
      (dir, log) => {
        gitlabTasks(dir).get('9');
        assert.match(calls(log).join('\n'), /api projects\/group%2Fsub%2Fproj\/issues\/9/);
      },
      'git@gitlab.com:group/sub/proj.git'
    );
    withRepo(
      {},
      (dir, log) => {
        gitlabTasks(dir).get('9');
        assert.match(calls(log).join('\n'), /api projects\/group%2Fsub%2Fproj\/issues\/9/);
      },
      'https://gitlab.com/group/sub/proj.git'
    );
  });

  test('ssh:// and scp-style remotes pin GITLAB_HOST to their host', () => {
    // scp-style, self-hosted — the facade's env pin reaches every spawn
    withRepo(
      {},
      (dir, log) => {
        gitlabTasks(dir).get('9');
        assert.match(readFileSync(log, 'utf8'), /env:GITLAB_HOST=gitlab\.corp\.com/);
        assert.match(calls(log).join('\n'), /api projects\/team%2Fproj\/issues\/9/);
      },
      'git@gitlab.corp.com:team/proj.git'
    );
    // ssh:// with a user — the user is not part of the host
    withRepo(
      {},
      (dir, log) => {
        gitlabTasks(dir).get('9');
        assert.match(readFileSync(log, 'utf8'), /env:GITLAB_HOST=gitlab\.com/);
        assert.match(calls(log).join('\n'), /api projects\/group%2Fsub%2Fproj\/issues\/9/);
      },
      'ssh://git@gitlab.com/group/sub/proj.git'
    );
    // self-hosted ssh:// with a port — the port stays on the host
    withRepo(
      {},
      (dir, log) => {
        gitlabTasks(dir).get('9');
        assert.match(readFileSync(log, 'utf8'), /env:GITLAB_HOST=gitlab\.corp\.com:2222/);
      },
      'ssh://git@gitlab.corp.com:2222/team/proj.git'
    );
  });

  test('no GitLab remote fails loud — never a silent default project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bro-gl-noremote-'));
    testGit(['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    try {
      withFakeGlab({}, () => {
        assert.throws(() => gitlabTasks(dir).list(), /no GitLab remote/);
        // prefix() is the one probe that answers instead of throwing
        assert.equal(gitlabTasks(dir).prefix(), undefined);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a nonzero glab propagates — auth failure is not an empty list', () => {
    withRepo({ FAKE_GLAB_FAIL_ALL: '1' }, dir => {
      assert.throws(() => gitlabTasks(dir).list(), /glab api failed: token expired/);
      // a get() outage must not masquerade as "task doesn't exist"
      assert.throws(() => gitlabTasks(dir).get('5'), /glab api failed/);
    });
  });

  test('get maps 404 to undefined but rethrows other failures', () => {
    withRepo({ FAKE_GLAB_ISSUE_404: '99', FAKE_GLAB_ISSUE_500: '66' }, dir => {
      assert.equal(gitlabTasks(dir).get('99'), undefined);
      assert.throws(() => gitlabTasks(dir).get('66'), /glab api failed: 500/);
    });
  });

  test('claim assigns the actor and lands bro:claimed after verification', () => {
    const seq = mkdtempSync(join(tmpdir(), 'bro-gl-seq-'));
    try {
      writeFileSync(join(seq, '1.json'), JSON.stringify(issue({ iid: 42 })));
      writeFileSync(join(seq, '2.json'), JSON.stringify(issue({ iid: 42, assignees: ['me'] })));
      writeFileSync(
        join(seq, '3.json'),
        JSON.stringify(issue({ iid: 42, assignees: ['me'], labels: ['bug'] }))
      );
      withRepo({ FAKE_GLAB_ACTOR: 'me', FAKE_GLAB_ISSUE_SEQ: seq }, (dir, log) => {
        gitlabTasks(dir).claim('42');
        const lines = calls(log);
        // actor resolves via api user → users?username= → assignee PUT
        assert.match(lines.join('\n'), /api user/);
        assert.match(lines.join('\n'), /users\?username=me/);
        const assignIdx = lines.findIndex(l => /-f assignee_id=7/.test(l));
        const labelIdx = lines.findIndex(l => /-f labels=.*bro:claimed/.test(l));
        assert.ok(assignIdx >= 0, lines.join('\n'));
        // the label lands LAST — it is the commit flag
        assert.ok(labelIdx > assignIdx, lines.join('\n'));
        // ensureLabel ran first (best-effort label creation)
        assert.match(lines.join('\n'), /POST projects\/acme%2Fwidgets\/labels -f name=bro:claimed/);
      });
    } finally {
      rmSync(seq, { recursive: true, force: true });
    }
  });

  test('claim race: the higher-login loser unassigns and throws', () => {
    const seq = mkdtempSync(join(tmpdir(), 'bro-gl-seq-'));
    try {
      writeFileSync(join(seq, '1.json'), JSON.stringify(issue({ iid: 42 })));
      writeFileSync(
        join(seq, '2.json'),
        JSON.stringify(issue({ iid: 42, assignees: ['zz-me', 'aaa-rival'] }))
      );
      withRepo({ FAKE_GLAB_ACTOR: 'zz-me', FAKE_GLAB_ISSUE_SEQ: seq }, (dir, log) => {
        assert.throws(() => gitlabTasks(dir).claim('42'), /claim contested — aaa-rival holds it/);
        assert.match(calls(log).join('\n'), /-f assignee_id=0/);
        // the loser must NOT land the commit flag
        assert.equal(callsMatching(log, /-f labels=.*bro:claimed/).length, 0);
      });
    } finally {
      rmSync(seq, { recursive: true, force: true });
    }
  });

  test('claim race: the lower-login winner keeps the claim and labels', () => {
    const seq = mkdtempSync(join(tmpdir(), 'bro-gl-seq-'));
    try {
      writeFileSync(join(seq, '1.json'), JSON.stringify(issue({ iid: 42 })));
      writeFileSync(
        join(seq, '2.json'),
        JSON.stringify(issue({ iid: 42, assignees: ['aaa-me', 'zz-rival'] }))
      );
      writeFileSync(
        join(seq, '3.json'),
        JSON.stringify(issue({ iid: 42, assignees: ['aaa-me', 'zz-rival'], labels: [] }))
      );
      withRepo({ FAKE_GLAB_ACTOR: 'aaa-me', FAKE_GLAB_ISSUE_SEQ: seq }, (dir, log) => {
        gitlabTasks(dir).claim('42');
        assert.equal(callsMatching(log, /-f labels=.*bro:claimed/).length, 1);
        // the winner never unassigns itself — the loser's removal is theirs to run
        assert.equal(callsMatching(log, /-f assignee_id=0/).length, 0);
      });
    } finally {
      rmSync(seq, { recursive: true, force: true });
    }
  });

  test('claim refuses before any write — claimed, closed, or no identity', () => {
    for (const [body, pattern] of [
      [issue({ iid: 42, assignees: ['other'] }), /already claimed by other/],
      [issue({ iid: 42, labels: ['bro:claimed'] }), /already claimed/],
      [issue({ iid: 42, state: 'closed' }), /only open issues are claimable/],
    ] as const) {
      withRepo({ FAKE_GLAB_ACTOR: 'me', FAKE_GLAB_ISSUE: JSON.stringify(body) }, (dir, log) => {
        assert.throws(() => gitlabTasks(dir).claim('42'), pattern);
        assert.equal(callsMatching(log, /-X PUT/).length, 0);
      });
    }
    withRepo({ FAKE_GLAB_ACTOR: '', FAKE_GLAB_ISSUE: JSON.stringify(issue({ iid: 42 })) }, dir => {
      assert.throws(() => gitlabTasks(dir).claim('42'), /claim needs a glab identity/);
    });
    // a missing issue is a miss, not a claim
    withRepo({ FAKE_GLAB_ACTOR: 'me', FAKE_GLAB_ISSUE_404: '42' }, dir => {
      assert.throws(() => gitlabTasks(dir).claim('42'), /issue 42 not found/);
    });
  });

  test('claimCapability declares best-effort assignment — never a lease', () => {
    withRepo({}, dir => {
      assert.deepEqual(gitlabTasks(dir).claimCapability?.(), {
        strength: 'best-effort',
        identity: 'viewer',
        authority: 'service',
      });
      assert.equal(typeof gitlabTasks(dir).actor, 'function');
    });
  });

  test('close lands the reason as a note first, then state_event=close', () => {
    withRepo({}, (dir, log) => {
      gitlabTasks(dir).close('#42', 'landed via MR 7');
      const lines = calls(log).join('\n');
      assert.match(
        lines,
        /POST projects\/acme%2Fwidgets\/issues\/42\/notes -f body=landed via MR 7/
      );
      assert.match(lines, /PUT projects\/acme%2Fwidgets\/issues\/42 -f state_event=close/);
    });
    // a failed note aborts the close — the state write must not follow
    withRepo({ FAKE_GLAB_NOTE_FAIL: '1' }, (dir, log) => {
      assert.throws(() => gitlabTasks(dir).close('42', 'nope'), /failed to add close note/);
      assert.equal(callsMatching(log, /state_event=close/).length, 0);
    });
  });

  test('reopen re-queues: state_event, unassign, drop claim markers', () => {
    const closedClaimed = JSON.stringify(
      issue({
        iid: 42,
        state: 'closed',
        labels: ['bug', 'bro:claimed', 'blocked'],
        assignees: ['me'],
      })
    );
    withRepo({ FAKE_GLAB_ISSUE: closedClaimed }, (dir, log) => {
      gitlabTasks(dir).reopen('42');
      const lines = calls(log).join('\n');
      assert.match(lines, /PUT projects\/acme%2Fwidgets\/issues\/42 -f state_event=reopen/);
      assert.match(lines, /-f assignee_id=0/);
      // bro:claimed and blocked labels are dropped; the rest survive
      assert.equal(callsMatching(log, /-f labels=bug$/).length, 1);
    });
    // already-open: the reopen verb is skipped, the release still runs
    const openClaimed = JSON.stringify(
      issue({ iid: 42, state: 'opened', labels: ['bro:claimed'], assignees: ['me'] })
    );
    withRepo({ FAKE_GLAB_ISSUE: openClaimed }, (dir, log) => {
      gitlabTasks(dir).reopen('42');
      assert.equal(callsMatching(log, /state_event=reopen/).length, 0);
      assert.equal(callsMatching(log, /-f assignee_id=0/).length, 1);
      // every claim marker is gone — the labels write lands empty
      const labelPuts = callsMatching(log, /-f labels=/);
      assert.equal(labelPuts.length, 1);
      assert.match(labelPuts[0]!, /-f labels=$/);
    });
  });

  test('note posts to the issue notes endpoint', () => {
    withRepo({}, (dir, log) => {
      gitlabTasks(dir).note('5', 'progress so far');
      assert.match(
        calls(log).join('\n'),
        /POST projects\/acme%2Fwidgets\/issues\/5\/notes -f body=progress so far/
      );
    });
  });

  test('remove deletes the issue resource', () => {
    withRepo({}, (dir, log) => {
      gitlabTasks(dir).remove('5');
      assert.match(calls(log).join('\n'), /DELETE projects\/acme%2Fwidgets\/issues\/5/);
    });
  });

  test('create posts title/description/labels and writes the bro trailer', () => {
    withRepo(
      { FAKE_GLAB_CREATED: JSON.stringify(issue({ iid: 42, labels: ['bug'] })) },
      (dir, log) => {
        const row = gitlabTasks(dir).create({
          title: 'new task',
          type: 'bug',
          priority: 1,
          labels: ['bug'],
          description: 'the work',
        });
        assert.equal(row.id, '42');
        const created = calls(log).join('\n');
        assert.match(created, /POST projects\/acme%2Fwidgets\/issues -f title=new task/);
        assert.match(created, /"type":"bug"/);
        assert.match(created, /"priority":1/);
        assert.match(created, /-f labels\[\]=bug/);
      }
    );
  });

  test('create with parent/deps throws — GitLab has no dep write-back on create', () => {
    withRepo({}, (dir, log) => {
      assert.throws(
        () => gitlabTasks(dir).create({ title: 'x', parent: '1' }),
        /create does not support parent\/deps/
      );
      assert.throws(
        () => gitlabTasks(dir).create({ title: 'x', deps: ['blocked:1'] }),
        /create does not support parent\/deps/
      );
      assert.equal(callsMatching(log, /POST .*\/issues /).length, 0);
    });
  });

  test('update patches allowed fields; status/assignee/unknown throw', () => {
    withRepo({}, (dir, log) => {
      gitlabTasks(dir).update('42', { title: 'renamed', labels: 'a,b' });
      assert.match(
        calls(log).join('\n'),
        /PUT projects\/acme%2Fwidgets\/issues\/42 -f title=renamed -f labels=a,b/
      );
      assert.throws(() => gitlabTasks(dir).update('42', { status: 'closed' }), /use reopen\/close/);
      assert.throws(
        () => gitlabTasks(dir).update('42', { assignee: 'me' }),
        /assignee updates not supported/
      );
      assert.throws(
        () => gitlabTasks(dir).update('42', { bogus: '1' }),
        /unsupported update field 'bogus'/
      );
    });
  });

  test('link related and blocks hit the links endpoint; retry carries project id', () => {
    withRepo({}, (dir, log) => {
      gitlabTasks(dir).link('1', '2', 'related');
      gitlabTasks(dir).link('3', '4', 'blocked');
      const lines = calls(log).join('\n');
      assert.match(lines, /POST projects\/acme%2Fwidgets\/issues\/1\/links -f target_issue_iid=2/);
      assert.match(
        lines,
        /POST projects\/acme%2Fwidgets\/issues\/3\/links -f target_issue_iid=4 -f link_type=blocks/
      );
    });
    // older API shapes require target_project_id — the retry adds it
    withRepo({ FAKE_GLAB_LINK_NEEDS_PROJECT: '1' }, (dir, log) => {
      gitlabTasks(dir).link('1', '2', 'related');
      assert.match(
        calls(log).join('\n'),
        /links -f target_project_id=acme%2Fwidgets -f target_issue_iid=2/
      );
    });
  });

  test('link rejects cross-project pairs and non-linkable rels', () => {
    withRepo({}, (dir, log) => {
      assert.throws(
        () => gitlabTasks(dir).link('1', 'other/proj#2', 'related'),
        /cross-project links not supported/
      );
      for (const rel of ['parent', 'parent-child', 'tracks', 'discovered', 'mystery']) {
        assert.throws(
          () => gitlabTasks(dir).link('1', '2', rel),
          /unsupported dependency operations/,
          rel
        );
      }
      assert.equal(callsMatching(log, /\/links/).length, 0);
    });
  });

  test('unsupported surfaces throw — never faked', () => {
    withRepo({}, dir => {
      const store = gitlabTasks(dir);
      assert.throws(() => store.children('1'), /children not supported/);
      assert.throws(() => store.deps(['1']), /deps not supported/);
      assert.throws(() => store.neighbors('1'), /neighbors not supported/);
    });
  });

  test('newlines in title/labels are rejected — argv is the injection surface', () => {
    withRepo({}, (dir, log) => {
      assert.throws(() => gitlabTasks(dir).create({ title: 'a\nb' }), /newlines not allowed/);
      assert.throws(
        () => gitlabTasks(dir).create({ title: 'ok', labels: ['x\ny'] }),
        /newlines not allowed/
      );
      assert.throws(() => gitlabTasks(dir).update('1', { title: 'a\nb' }), /newlines not allowed/);
      assert.equal(callsMatching(log, /api -X/).length, 0);
    });
  });

  test('prefix() is the project name from the remote path', () => {
    withRepo({}, dir => {
      assert.equal(gitlabTasks(dir).prefix(), 'widgets');
    });
  });

  test('tasksAsync delegates the sync store — same reads, same throws', async () => {
    await withRepoAsync(
      {
        FAKE_GLAB_ACTOR: 'me',
        FAKE_GLAB_ISSUES: issuesJson(issue({ iid: 1 }), issue({ iid: 2, labels: ['blocked'] })),
      },
      async dir => {
        const store = gitlabTasksAsync(dir);
        assert.deepEqual(
          (await store.ready()).map(r => r.id),
          ['1']
        );
        assert.equal((await store.get('1'))?.id, '1');
        assert.equal(await store.actor?.(), 'me');
        await assert.rejects(() => store.children('1'), /children not supported/);
        await assert.rejects(() => store.deps(['1']), /deps not supported/);
        await assert.rejects(() => store.neighbors('1'), /neighbors not supported/);
      }
    );
  });
});

describe('gitlab tasks connector selection', { skip: WIN32 }, () => {
  test('tasks stays beads on a gitlab remote — opt-in is name-only', () => {
    registerConnector(gitlabConnector);
    const dir = makeRepo('git@gitlab.com:acme/widgets.git');
    try {
      // remote match would claim reviews/queries/stacks; tasks must NOT follow it
      assert.equal(facadeName('reviews', { dir }), 'gitlab');
      assert.equal(facadeName('tasks', { dir }), 'beads');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('connectors.tasks=gitlab resolves the gitlab TaskStore', () => {
    registerConnector(gitlabConnector);
    const dir = makeRepo('git@gitlab.com:acme/widgets.git');
    try {
      assert.equal(facadeName('tasks', { dir }, { prefer: { tasks: 'gitlab' } }), 'gitlab');
      const store = facade('tasks', { dir }, { prefer: { tasks: 'gitlab' } });
      assert.equal(typeof store.ready, 'function');
      assert.equal(typeof store.claim, 'function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('connectors.tasks=gitlab resolves on a non-gitlab remote too', () => {
    registerConnector(gitlabConnector);
    // an explicit pin is an operator choice — the remote only drives
    // auto-match, never the pin
    const dir = makeRepo('git@github.com:acme/widgets.git');
    try {
      assert.equal(facadeName('tasks', { dir }, { prefer: { tasks: 'gitlab' } }), 'gitlab');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tasksAsync honors the same opt-in', () => {
    registerConnector(gitlabConnector);
    const dir = makeRepo('git@gitlab.com:acme/widgets.git');
    try {
      assert.equal(facadeName('tasksAsync', { dir }), 'beads');
      assert.equal(
        facadeName('tasksAsync', { dir }, { prefer: { tasksAsync: 'gitlab' } }),
        'gitlab'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
