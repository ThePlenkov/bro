#!/usr/bin/env python3
"""
validate.py — runtime cross-check for evidence.claim.v1.

For every claim.json passed on the command line, this script:

  1. Validates the parsed claim against `references/claim.json` (JSON Schema
     v1) using `jsonschema`. Any schema violation fails the claim
     immediately, BEFORE the runtime quote check.
  2. For every `assertions[].evidence_quote`, verifies that the quoted
     text appears as a CONTIGUOUS VERBATIM BLOCK in at least one of:
       - commands[*].stdout_excerpt
       - commands[*].stderr_excerpt
       - The on-disk file at artifacts[].path (read in full, subject to
         the path-traversal guard below)
       - For kind=log artifacts, also artifacts[].content_excerpt
  3. Re-runs the per-environment sanity checks (db-migration log not
     empty; browser claims with browser-automation require network
     artifact and an empty console.log; static-analysis quotes must
     contain a clean-tool marker from a real linter / typechecker run).

Exit 0 when every claim is OK, 1 when any is invalid.

The path-traversal guard rejects any artifact path that resolves
outside the claim directory or the current working directory. This
prevents a malicious claim.json from reading files outside the
project tree and surfacing their contents in this script's stdout
(which is shared in CI logs / PR comments).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


SCHEMA_PATH = Path(__file__).resolve().parent.parent / "references" / "claim.json"


# Path-traversal guard. A path is considered safe if, after resolution
# (which follows symlinks and `..` segments), it lies within:
#   (a) the claim directory itself, OR
#   (b) the current working directory itself.
# We deliberately do NOT walk up to the filesystem root (that would
# re-allow any absolute path via "everything is inside /").
def is_safe_path(resolved: Path, claim_dir: Path, cwd: Path) -> bool:
    try:
        resolved.relative_to(claim_dir.resolve())
        return True
    except ValueError:
        pass
    try:
        resolved.relative_to(cwd.resolve())
        return True
    except ValueError:
        pass
    return False


def load_text(path: Path) -> str:
    """Read a text file. Returns '' if it does not exist or is unreadable."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def load_safe_artifact(
    raw_path: str, claim_dir: Path, cwd: Path
) -> tuple[str, str | None]:
    """Read an artifact file, enforcing the path-traversal guard.

    Returns (text, error_message). text is '' if the file is missing,
    empty, or unreadable; error_message is set on policy violations
    (unsafe path) or resolve errors. On success, error_message is None.
    """
    if not raw_path:
        return "", "  artifact path is empty"
    try:
        resolved = (
            (claim_dir / raw_path).resolve(strict=False)
            if not os.path.isabs(raw_path)
            else Path(raw_path).resolve(strict=False)
        )
    except (OSError, RuntimeError) as e:
        return "", f"  artifact path={raw_path!r}: cannot resolve ({e})"
    if not is_safe_path(resolved, claim_dir, cwd):
        return (
            "",
            f"  artifact path={raw_path!r} resolves to {resolved!s} which is "
            f"outside the project tree (claim_dir={claim_dir!s}, cwd={cwd!s}); "
            f"refusing to read it (path-traversal guard)",
        )
    return load_text(resolved), None


def contiguous_block_present(quote: str, blob: str) -> bool:
    """True iff `quote` appears verbatim as a contiguous substring of
    `blob`, with line boundaries preserved.

    A single-line quote is matched as a whole line (anchor at line
    boundaries). A multi-line quote is matched as the exact block
    'quote_line_1\\n...\\nquote_line_N' appearing in the source — no
    stitching of unrelated surrounding lines is allowed.
    """
    quote_lines = quote.splitlines()
    # Empty quote: caller already rejected this; treat as not present.
    if not quote_lines or not any(ql.strip() for ql in quote_lines):
        return False
    if len(quote_lines) == 1:
        return quote_lines[0] in blob.splitlines()
    # Multi-line: must be the exact joined block (whitespace preserved).
    block = "\n".join(quote_lines)
    return block in blob


def validate_against_schema(claim: object) -> list[str]:
    """If the claim violates the JSON schema, return the error messages.
    Returns an empty list when the claim is schema-valid.

    If `jsonschema` is not installed, returns a single warning telling
    the caller to `pip install jsonschema` — schema validation is
    non-optional, so the warning is treated as a failure by the caller.
    """
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return [
            "  schema validation SKIPPED — install jsonschema "
            "(pip install jsonschema) to enforce references/claim.json"
        ]
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return [f"  cannot load schema at {SCHEMA_PATH}: {e}"]

    errors: list[str] = []
    validator = jsonschema.Draft202012Validator(schema)
    for err in sorted(validator.iter_errors(claim), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"  schema: {path}: {err.message}")
    return errors


# This is a large evidence validator with environment-specific checks;
# the cognitive-complexity cost is intentional and concentrated here.
def check_claim(claim_path: Path, claim_dir: Path, cwd: Path) -> list[str]:  # NOSONAR
    """Return a list of error messages for this claim (empty = OK)."""
    errors: list[str] = []
    resolved = claim_path.resolve(strict=False)
    if not is_safe_path(resolved, cwd, cwd):
        return [
            f"  unsafe claim path: {claim_path!r} resolves to {resolved!s} which is "
            f"outside the project tree ({cwd!s}); refusing to read it"
        ]
    try:
        claim = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"  invalid JSON: {e}"]

    # Step 1: schema validation (fail-fast, BEFORE we read any files or
    # accept any evidence_quote as a pass).
    errors.extend(validate_against_schema(claim))
    if errors:
        # Don't bother with the rest of the checks if the claim is
        # structurally invalid — the report would be confusing.
        return errors

    commands = claim.get("commands", [])
    artifacts = claim.get("artifacts", [])
    assertions = claim.get("assertions", [])

    # Step 2: pre-load all command excerpts.
    command_blobs: list[tuple[str, str]] = []
    for i, c in enumerate(commands):
        for field in ("stdout_excerpt", "stderr_excerpt"):
            blob = c.get(field) or ""
            if blob:
                command_blobs.append((f"commands[{i}].{field}", blob))

    # Step 3: pre-load all artifact files (subject to path-traversal guard).
    artifact_blobs: list[tuple[str, str]] = []
    for a in artifacts:
        path = a.get("path") or ""
        if not path:
            continue
        text, err = load_safe_artifact(path, claim_dir, cwd)
        if err is not None:
            errors.append(err)
            continue
        if text:
            artifact_blobs.append((f"artifact:{path}", text))
        ce = a.get("content_excerpt")
        if ce:
            artifact_blobs.append((f"artifact:{path}.content_excerpt", ce))

    # Step 4: cross-check every assertion. Multi-line evidence_quote must
    # appear as a contiguous verbatim block in at least one source blob.
    for i, a in enumerate(assertions):
        name = a.get("name", f"assertion[{i}]")
        quote = a.get("evidence_quote") or ""
        if not quote:
            errors.append(f"  assertion[{i}] {name!r}: empty evidence_quote")
            continue

        quote_lines = [ln for ln in quote.splitlines() if ln.strip()]
        if not quote_lines:
            errors.append(f"  assertion[{i}] {name!r}: evidence_quote has no non-empty line")
            continue

        found_in: list[str] = []
        for src, blob in command_blobs + artifact_blobs:
            if contiguous_block_present(quote, blob):
                found_in.append(src)
                # Don't break — collect all sources for transparency.

        if not found_in:
            preview = quote_lines[0][:80]
            kind = "multi-line" if len(quote_lines) > 1 else "single-line"
            errors.append(
                f"  assertion[{i}] {name!r}: evidence_quote ({kind}) not found "
                f"as a contiguous verbatim block anywhere\n"
                f"    quote preview: {preview!r}\n"
                f"    searched in: {len(command_blobs)} command excerpt(s), "
                f"{len(artifact_blobs)} artifact blob(s)"
            )

    # Step 5: per-environment runtime sanity checks (re-do what the
    # schema enforces structurally, but with friendlier diagnostics and
    # an additional on-disk check the schema cannot do).
    env = claim.get("target_environment")
    if env == "db-migration":
        log_artifacts = [a for a in artifacts if a.get("kind") == "log"]
        if not log_artifacts:
            errors.append("  db-migration: missing log artifact")
        for a in log_artifacts:
            ce = a.get("content_excerpt") or ""
            if len(ce) < 80:
                errors.append(
                    f"  db-migration: log artifact {a.get('path')!r} has "
                    f"content_excerpt of {len(ce)} chars (expected ≥ 80)"
                )
            on_disk, err = load_safe_artifact(a.get("path", ""), claim_dir, cwd)
            if err is not None:
                errors.append(f"  db-migration: {err.strip()}")
                continue
            if not on_disk.strip():
                errors.append(
                    f"  db-migration: log artifact {a.get('path')!r} is empty or unreadable"
                )
    elif env == "static-analysis":
        # Runtime anti-fabrication check: at least one assertion's
        # evidence_quote must contain a clean-tool marker (the linter /
        # typechecker's own line that proves zero findings). This is the
        # rule the schema's allOf used to enforce; we moved it here so
        # the schema stays free of scan-triggering literals.
        clean_marker_re = re.compile(
            r"(?:^|\b)(?:0\s+(?:errors?|warnings?)|no\s+(?:errors?|warnings?)|"
            r"\b0\s+problems?\b|\bno\s+problems?\b)"
        )
        has_clean_marker = False
        for a in assertions:
            eq = a.get("evidence_quote") or ""
            if clean_marker_re.search(eq):
                has_clean_marker = True
                break
        if not has_clean_marker:
            errors.append(
                "  static-analysis: no assertion quotes a clean-tool marker "
                "(e.g. a line reporting zero findings from a linter, typechecker, "
                "or scanner). The anti-fabrication check requires the agent to "
                "CITE the actual tool output, not paraphrase 'lint passed'."
            )
    elif env == "browser":
        # Browser-automation claims must have a `network` artifact AND an
        # empty `console.log`. The schema enforces presence; we re-check
        # the empty-console claim by reading the log file from disk.
        vm = claim.get("verification_method")
        if vm == "browser-automation":
            kinds = {a.get("kind") for a in artifacts}
            if "network" not in kinds:
                errors.append(
                    "  browser (browser-automation): missing `network` artifact "
                    "(HAR or connection log) — required for WebSocket/SSE/long-poll claims"
                )
            log_paths = [a.get("path") for a in artifacts if a.get("kind") == "log"]
            if not log_paths:
                errors.append("  browser (browser-automation): missing `log` artifact (console capture)")
            else:
                for p in log_paths:
                    if not p:
                        continue
                    on_disk, err = load_safe_artifact(p, claim_dir, cwd)
                    if err is not None:
                        errors.append(f"  browser (browser-automation): {err.strip()}")
                        continue
                    if on_disk.strip():
                        errors.append(
                            f"  browser (browser-automation): console.log {p!r} is "
                            f"non-empty ({len(on_disk)} chars) — an empty file is the "
                            f"proof of zero console errors"
                        )

    return errors


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: validate.py <claim.json> [<claim.json> ...]", file=sys.stderr)
        return 2

    cwd = Path.cwd()
    total_errors = 0
    for arg in argv:
        claim_path = Path(arg)
        if not claim_path.is_file():
            print(f"❌ {claim_path}: file not found", file=sys.stderr)
            total_errors += 1
            continue
        claim_dir = claim_path.parent
        errors = check_claim(claim_path, claim_dir, cwd)
        if errors:
            print(f"❌ {claim_path}:")
            for e in errors:
                print(e)
            total_errors += 1
        else:
            print(f"✅ {claim_path}")

    return 0 if total_errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
