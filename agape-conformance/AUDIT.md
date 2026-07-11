# Conformance Suite Audit

Date: 2026-06-30.

Audited spec: `../SPEC.md` `v1.0.0-alpha.2026.7.11.0`.

Authority rule: this audit is derived from the finalized SPEC only. Existing runtimes, Studio behavior, Rust behavior, and prior implementation quirks are not sources of expected behavior.

## Verdict

The compiler/language conformance suite is now pointed at the finalized 6.30 spec, uses the finalized gate surface, and has direct compiler-visible coverage for every language section. Runtime-only obligations remain in the TypeScript runtime conformance track.

## Closed In This Pass

- Updated conformance metadata and manifest generator version to `v1.0.0-alpha.2026.7.11.0`.
- Removed old language forms from active `.ag` tests:
  - `case` branching;
  - `default:` arms;
  - subjectless `endorse (...)`;
  - bare `c by R`;
  - principal-as-rule syntax instead of principal-prefixed `p decide c by R`;
  - removed `Decided` / `Attestation` event names.
- Added direct kernel-boundary tests for:
  - memory recall cannot drive a consequential sink without a gate;
  - an endorsement subject must be in the decision dependency scope.
- Added compiler-visible tests for lexical numeric/f-string edge cases, schema assertions, helper-call taint flow, memory/ledger separation, match-hit taint, abstain non-narrowing, gate arm validity, endorsement subject field collisions, decision-policy config rejection, whole-prefix `pub import`, explicit module headers, and public interface/private-name leakage.
- Added a TypeScript runtime conformance suite for the SPEC 16/17 runtime contract, including scheduler, ledger, seam/fault, replay, memory, projection, calibration, config, and learning-loop coverage.

## Open Runtime Work

- Expand runtime conformance adapters for every runtime implementation.
- Increase statistical power/sample sizes in implementation CI if a runtime wants stronger empirical confidence than the portable multi-run checks in the adapter suite.
