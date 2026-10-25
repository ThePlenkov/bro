# Adversarial Review Verification Checklist

After applying adversarial review:

- [ ] Every non-trivial decision (per the critical-thinking skill's definition) was named explicitly as a CLAIM before standing
- [ ] At least one fresh-context review per non-trivial artifact (a failing test produced by TDD's RED step satisfies this for behavioral claims)
- [ ] The reviewer received ARTIFACT + CONTRACT — NOT the CLAIM, NOT your reasoning
- [ ] The reviewer's prompt was adversarial ("find issues"), not validating ("is it good")
- [ ] Findings were classified against the artifact text (not rubber-stamped) using the precedence: contract misread / actionable / trade-off / noise
- [ ] A stop condition was met (trivial findings, 3 cycles, or user override)
- [ ] In interactive mode, cross-model was **explicitly offered** to the user (regardless of artifact stakes) and the response was acknowledged in the output
- [ ] In non-interactive mode, cross-model was skipped and the skip was announced
- [ ] Any external CLI invocation was preceded by a PATH check, a working-binary test, syntax confirmation with the user, and explicit authorization to run
