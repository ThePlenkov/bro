# bro-84qhx — conductor: permission policy for interactive ACP sessions

Follow-up to bro-xeozo (retro bro-p0baz). The conductor answers every
`session/request_permission` with deny — right for a headless worker,
wrong for a user-driven session: the agent renders the deny as "User
rejected this tool call" though no human saw a prompt, and safe calls
(reads, fetches) die with the dangerous ones.

## Policy surface

One policy shape, two surfaces:

```ts
interface AcpPermissionPolicy {
  autoApprove?: boolean   // allow every ask that offers an allow option
  allow?: string[]        // allowlist matchers (below)
}
```

- `providers.<name>.autoApprove` (existing field) and the new
  `providers.<name>.permissionAllow: string[]` are the entry-level
  policy — both surfaces honor them (worker AND conductor: the field
  means "this agent's asks may be approved without a human").
- The conductor adds per-listener env overrides — a user-facing
  `bro serve` wants its own knob without mutating the entry the
  headless fleet resolves through:
  - `BRO_PROVIDER_AUTO_APPROVE=<bool>` — wins over the entry field.
  - `BRO_PROVIDER_PERMISSION_ALLOW=<comma-separated matchers>` — wins
    over `permissionAllow`; the same list reaches the worker as
    repeated `--allow=<matcher>` argv (`=` spelling — a matcher that
    starts with `--` must not die in the worker's option parser).
    A matcher may itself contain a comma (a `commit -m "fix(a, b)"`
    substring) — for that case the env value takes the newline form:
    one matcher per line, commas literal.

A matcher is `kind:<acp-tool-kind>` (exact, case-insensitive — e.g.
`kind:read`, `kind:fetch`) or a bare string matched case-insensitively
as a substring of the tool call's `title` or serialized `rawInput`.
An ask with no matching allow option still denies — approval is never
invented.

## Render deny as policy, never as user choice

- Denied responses carry `_meta: { 'bro/policyDenied': true }` — the
  wire-level fact an agent/IDE can render distinctly.
- The conductor tracks per-session policy denials on the pooled link
  and annotates the anthropic reply with a trailing text block naming
  the denied calls and the remediation env/field — the human reading
  the transcript sees "denied by bro policy" instead of the agent's
  "User rejected" alone. An `acp.permission` OTEL event records each
  verdict (allow/deny + matcher) for the serve trace.

## Non-goals

- Interactive prompting — bro stays the client, never a UI; policy is
  config, not a dialog.
- Judge/one-shot call surfaces keep default-deny unless a caller
  passes a policy — no config surface there by design.
