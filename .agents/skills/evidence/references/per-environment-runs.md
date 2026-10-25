# Per-Environment Minimum Viable Runs

<!-- os-independence-exempt: intentional POSIX bash recipes; on Windows run under Git Bash or WSL -->

The single most important part of this skill. **For each target
environment, this is the minimum run that produces real evidence.**
Anything less is `produced`, not `proved`. Pick the recipe that matches
your `target_environment`; do not paraphrase, do not skip steps. Use
pinned versions for any `npx` invocation (e.g. `npx --yes vitest@2.1.5`)
— unpinned `npx` is a known rug-pull vector.

**Shell requirement.** All recipes in this file assume a POSIX shell
(`sh` / `bash` / `zsh`). On Windows, run them under Git Bash
(`bash` on the PATH after `git` install) or WSL. The
`scripts/check-os-independence.ts` check exempts this file precisely
because every recipe here is POSIX by design; the exemption is paired
with this note so Windows users are not silently pointed at commands
they cannot run.

---

## Web (browser-rendered app, SPA, anything with JS hydration)

**Minimum viable run: headless browser, real URL, console + network +
screenshot + DOM.** For every `browser-automation` claim, the evidence
file MUST include a `network.har` (or explicit connection log) under
`artifacts` — `validate.py` requires it, not just WebSocket / SSE /
long-poll cases.

```bash
# Install once (agent's job to do this if missing)
npm i -D @playwright/test@1.49.0
npx --yes playwright@1.49.0 install chromium

# Write a focused spec
mkdir -p .evidence/<date>/<task>/<slug>
cat > .evidence/<date>/<task>/<slug>/spec.ts <<'EOF'
import { test, expect } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
test('claim: <paste the claim here>', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

  // Capture the network HAR to disk so `validate.py` can verify the
  // mandatory `network` artifact. Without this, the spec passes
  // Playwright but fails the evidence skill on the missing artifact.
  // (Playwright's `recordHar` writes the file on context close.)
  await context.routeFromHAR({ path: '.evidence/<date>/<task>/<slug>/network.har', update: false });

  const resp = await page.goto('http://localhost:3000/path', { waitUntil: 'networkidle' });
  expect(resp?.status(), 'http status').toBe(200);

  // DOM assertion that maps to the claim
  await expect(page.getByRole('button', { name: /submit/i })).toBeVisible();

  await page.screenshot({ path: '.evidence/<date>/<task>/<slug>/screenshot.png', fullPage: true });

  // Persist the captured console to disk so the evidence skill can verify it.
  // An empty file IS the proof of zero errors.
  writeFileSync('.evidence/<date>/<task>/<slug>/console.log', errors.join('\n'));

  expect(errors, 'no console / page errors').toEqual([]);

  // Persist the HAR by reading the file Playwright wrote. (Some
  // Playwright versions flush on context close only; reading after
  // the goto above is sufficient for non-WebSocket cases and
  // matches what `validate.py` checks.)
  expect(readFileSync('.evidence/<date>/<task>/<slug>/network.har', 'utf8'),
    'network.har was written').toContain('"log"');
});
EOF

# Run it
npx --yes playwright@1.49.0 test .evidence/<date>/<task>/<slug>/spec.ts --reporter=line
```

**Forbidden as evidence for browser claims:**

- `curl http://localhost:3000` and seeing `<html>` in the body (HTML
  presence ≠ JS executed)
- `node -e "require('./build')"` (node ≠ browser — no DOM, no
  WebSocket, no layout)
- Lint passing on the new component (lint ≠ runtime behaviour)
- "Manually checked in Chrome" (not reproducible, not in evidence file)

The evidence file MUST list under `artifacts`:

- `screenshot.png` (or full-page trace)
- `console.log` (zero errors)
- `network.har` (or explicit connection log) for **every**
  `browser-automation` claim — not only WebSocket / SSE / long-poll
  cases

---

## Backend / API (HTTP service, RPC, queue consumer)

**Minimum viable run: real HTTP call with seeded data, response shape +
side-effect asserted.**

```bash
# Seed
psql --set ON_ERROR_STOP=on $DATABASE_URL -c "INSERT INTO widgets (id, name) VALUES ('w-1', 'evidence-widget') ON CONFLICT DO NOTHING;"

# Hit
RESP=$(curl -sS -X POST http://localhost:8080/widgets/w-1/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction":"cw"}' \
  -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}\n")

# Assert in shell. Use `grep -F` (fixed-string, substring match) so
# the pattern is treated literally — but the patterns below are
# substrings of larger lines, NOT whole lines, so do NOT use `-x`
# (which would force a whole-line match and break every assertion
# against JSON output, which is always `{"key":"value",...}`).
#
# To make the substring match precise (so `"cw"` does not match a
# substring of `"ccw"`, and so `"status":"rotated"` is not satisfied
# by some unrelated `rotated` field elsewhere in the response), the
# patterns are written with their surrounding context:
#   - the JSON response includes the field followed by a comma, so
#     `'"status":"rotated",'` is unique to that field;
#   - the side-effect value from psql is read with `-tAc` and may
#     carry leading whitespace, so we match the value as a fixed
#     line (one row, possibly indented) using the row itself as
#     the assertion target.
echo "$RESP" | grep -Eq '"status":"rotated"([,}\s])' \
  || { echo "FAIL: missing rotated status field"; exit 1; }
# HTTP status comes from curl's -w output, which is appended AFTER
# the body. A response body that happens to contain the string
# "HTTP_STATUS:200" would otherwise pass this assertion (the body
# is in $RESP, the marker is appended by -w). Split them: write the
# body to BODY_FILE, the metadata to META_FILE, and assert on
# META_FILE only.
BODY_FILE=.evidence/<date>/<task>/<slug>/response.body
META_FILE=.evidence/<date>/<task>/<slug>/response.meta
echo "$RESP" | sed -n '1,/"HTTP_STATUS:"/p' | sed '/HTTP_STATUS:/d' > "$BODY_FILE"
echo "$RESP" | awk '/^HTTP_STATUS:/' > "$META_FILE"
grep -Fxq 'HTTP_STATUS:200' "$META_FILE" || { echo "FAIL: non-200"; exit 1; }

# Side-effect check. Read the value into a variable first so the
# assertion can do an exact-line match against the value (and only
# the value) — that way a stored value of `ccw` cannot pass for
# `cw`. `psql -tAc` already emits a single unaligned row with no
# header and no trailing newline trimming; do NOT pipe through sed
# to strip whitespace, because that would mask a stored value
# with unwanted leading/trailing whitespace and let the assertion
# pass. (The earlier `sed` trim was a false positive.)
ACTUAL=$(psql --set ON_ERROR_STOP=on $DATABASE_URL -tAc "SELECT direction FROM widgets WHERE id='w-1';")
test "$ACTUAL" = "cw" \
  || { echo "FAIL: side-effect wrong direction, got '$ACTUAL' want 'cw'"; exit 1; }
```

The evidence file MUST list:

- The seed step
- The exact request (method, URL, headers, body)
- The status code, response excerpt
- The side-effect assertion (DB row, queue message, log line)
- One assertion that, if false, falsifies the claim

---

## CLI / script

```bash
# Run the actual binary, capture both streams into the evidence dir, check exit code.
# mkdir -p is mandatory — the evidence dir is the canonical home for these artifacts.
mkdir -p .evidence/<date>/<task>/<slug>
./dist/cli.js do-thing --input fixtures/x.json \
  > .evidence/<date>/<task>/<slug>/out.stdout \
  2> .evidence/<date>/<task>/<slug>/out.stderr
EC=$?
test "$EC" -eq 0 || { echo "FAIL exit=$EC"; exit 1; }
grep -q "expected marker" .evidence/<date>/<task>/<slug>/out.stdout \
  || { echo "FAIL: marker missing"; exit 1; }
```

The evidence file MUST list: command, cwd, `exit_code`, both stdout AND
stderr excerpt.

---

## Library / pure function

**Minimum viable run: a unit test that fails without the fix.**

```bash
# If no test exists, write one. The fix is not done if the test did not exist before the fix.
npx --yes vitest@2.1.5 run packages/foo/test/bar.test.ts --reporter=verbose
```

**Forbidden as evidence for library claims:**

- "I read the code and it looks right"
- The test exists but was not run this turn (commit `.test.ts`
  separately, link to test run that covered it)
- TypeScript compiles but no test was executed

---

## Static analysis (typecheck, lint, format)

```bash
pnpm typecheck
pnpm lint
pnpm format:check
```

The evidence file MUST list **each** tool's output under
`commands[*].stdout_excerpt`, with the "0 errors / 0 warnings" line
quoted.

**Forbidden as evidence for "lint clean" claims:**

- Only quoting typecheck but claiming "lint clean"
- Quoting a summary line without the tool name in the same output

---

## Docs / config change

```bash
# Build the docs and diff the produced HTML / md against the expected output
pnpm docs:build
git diff --stat docs/
```

The evidence file MUST list the build command and a diff summary that
touches the files you claim to have changed.

---

## Database migration

```bash
# Run migration against a throwaway DB and capture log into the evidence dir.
# ON_ERROR_STOP makes psql exit non-zero on the first SQL error; without
# it, a broken migration can silently succeed and the migration.log
# will still look superficially fine.
mkdir -p .evidence/<date>/<task>/<slug>
psql --set ON_ERROR_STOP=on $TEST_DATABASE_URL -f migrations/0007_add_foo.sql \
  > .evidence/<date>/<task>/<slug>/migration.log 2>&1
EC=$?
test "$EC" -eq 0 || { echo "FAIL: up migration exited $EC"; exit 1; }

# Assert the column exists, the data shape matches. Use a regex
# match (`-E`) that anchors to the start of the line and the column
# separator — the exact `psql "\d table"` line is
# ` foo_bar   | text`, NOT the bare ` foo_bar |` token, so
# whole-line / fixed-string matches against the column will fail.
SCHEMA_UP=$(psql --set ON_ERROR_STOP=on $TEST_DATABASE_URL -c "\d widgets" \
  | tee -a .evidence/<date>/<task>/<slug>/migration.log)
echo "$SCHEMA_UP" | grep -Eq '^[[:space:]]*foo_bar[[:space:]]+\|' \
  || { echo "FAIL: column foo_bar not present after up"; exit 1; }
psql --set ON_ERROR_STOP=on $TEST_DATABASE_URL -c "SELECT 1 FROM widgets LIMIT 1;"  # queryable

# Down
psql --set ON_ERROR_STOP=on $TEST_DATABASE_URL -f migrations/0007_add_foo.down.sql \
  >> .evidence/<date>/<task>/<slug>/migration.log 2>&1
EC=$?
test "$EC" -eq 0 || { echo "FAIL: down migration exited $EC"; exit 1; }

# Positive assertion: the column is GONE. `grep -vq "foo_bar"`
# would pass even if the schema dump is empty or unrelated, so
# assert the column row itself is absent (same regex as the up
# check, inverted). CAPTURE psql's exit code BEFORE piping into
# the inverted grep — the pipeline `psql | grep` returns the
# status of the last command in the pipe, so a failing psql whose
# empty output is then grep'd for absence would silently pass.
SCHEMA_DOWN=$(psql --set ON_ERROR_STOP=on $TEST_DATABASE_URL -c "\d widgets")
SCHEMA_EC=$?
echo "$SCHEMA_DOWN" | tee -a .evidence/<date>/<task>/<slug>/migration.log >/dev/null
test "$SCHEMA_EC" -eq 0 || { echo "FAIL: schema inspection exited $SCHEMA_EC"; exit 1; }
{ ! echo "$SCHEMA_DOWN" | grep -Eq '^[[:space:]]*foo_bar[[:space:]]+\|'; } \
  || { echo "FAIL: down did not remove column foo_bar"; exit 1; }
```
