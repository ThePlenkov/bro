# macOS parity for process probes

## Problem
Process attribution and liveness probes support Linux `/proc` and macOS
`ps`/`lsof`, but unsupported operating systems currently fall through to
empty or absent results. That makes a capability limitation indistinguishable
from “no process”, and CI does not exercise the macOS implementations.

## Design
Add a macOS unit-test leg to CI for the core and CLI projects only. Expose
unsupported process inspection as a typed platform result at the core live
process seam, and make CLI callers report the platform explicitly (including
the doctor report). Existing Linux and Darwin behavior remains unchanged;
unsupported platforms are fail-open for safety but never silently described as
empty evidence.

## Verify
Run the core and CLI typechecks/tests locally, run the full build, and inspect
workflow YAML. CI's `macos-latest` leg is the verification for Darwin
`ps`/`lsof` paths; on unsupported platforms tests assert the tagged result or
explicit degradation text.
