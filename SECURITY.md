# Security Policy

## Reporting a Vulnerability

Report vulnerabilities through GitHub Security Advisories on this
repository, or open an issue marked `[security]` if advisories are
unavailable. Do not attach exploit payloads or real secrets to public
reports.

## Trust boundaries

- **Prompts and logs are private.** `bro agents` writes prompt files and
  logs under `<git-common>/bro/agents/` — never into argv (every local
  user reads `ps`) and never into world-readable `/tmp`. Code that
  routes agent prompts, beads content, or tool output through command
  lines or world-readable paths is a security finding.
- **Registry paths are hostile input.** `agents.json` entries come from
  past runs and other actors — `agentId`, paths, and env values must be
  validated before use (`SAFE_AGENT_ID`, absolute-path resolution,
  identity pins immune to `spec.env` override). A tampered entry must
  remint, never trust.
- **Host-wide state directories** (`$XDG_DATA_HOME/bro/session-slots`,
  vendor session-lock dirs) are shared across repos and processes.
  Scans fail closed: an unverifiable count throws rather than reads as
  zero, and lock/reservation contents are parsed strictly (numeric
  pids only) so crafted files cannot alias unrelated processes.
- **Hooks fail open.** A hook must never stall or fail the client
  session on missing binaries, empty env vars, or network errors —
  REVIEW.md rates blocking hook paths as critical.
- **Secrets never enter the repo.** Providers resolve credentials from
  the environment at spawn; config files and commits must not embed
  tokens, and connector code must not log them.

## Supported Versions

The latest release line only — bro is pre-1.0 and fixes land on HEAD.
