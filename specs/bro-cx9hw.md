# bro-cx9hw — dogfood claude headless: config-driven conductor backend + per-run port

Two client-side breaks killed the first real `bro self dogfood run
claude-plugin --provider claude` before any wire traffic, plus one
review finding on the fix:

1. **`settings.model`, not `--model` in the provider command** —
   claude's sonnet1m migration appends `[1m]` to env-var model names and
   the SDK catalog check hard-rejects unknown suffixed ids in `-p` mode.
   A settings `"model"` key reaches the wire unsuffixed (verified live);
   the `providers.claude.command` template stays generic.
2. **conductor backend from config, not env** — `settings.env` never
   reaches the apiKeyHelper subprocess, so a spawned serve had no
   `BRO_PROVIDER_BACKEND` and `/v1/*` fell to the byte-proxy 404.
   `conductorConfig` gains a config fallback: `env.BRO_PROVIDER_BACKEND
   ?? config.serve.backend`; `serve` becomes a core config section
   (`{backend?: string}`), also declared `configKey: 'serve'` on the
   plugin.
3. **per-run port** — `.files` provisioning substitutes `{{PORT}}` with
   a free port allocated per run, so a stale serve from a dead run can
   never squat the next run's port. On terminal status the run reaps
   the scratch's serve via its serve.json pid.

No hardcoded devin identifiers outside the scenario's own `.files`
payload; apiKeyHelper returns to `npx --no-install bro serve ensure
--port {{PORT}}` verbatim.
