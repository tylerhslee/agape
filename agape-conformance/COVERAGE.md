# Agape Conformance Coverage

This file tracks spec-to-suite lockstep work. The `.ag` files remain the source
of truth; this document is the audit map for deciding which tests still need to
be added when the spec grows or a gap is found.

## Current status

- Indexed tests: 197
- Enforced tests: 197
- Current reference result: 197 pass, 0 fail
- Manifest freshness: `python3 build_manifests.py --check` passes

## Recently closed gaps

- Exact `ledger:` assertions are now preserved in `MANIFEST.toml` and matched as
  exact event spines, not loose subsequences.
- `emit`/`perform` now have conformance coverage for undeclared names, strict
  single-field and multi-field payload type checks, and multi-field arity.
- `forget` now has conformance coverage for the `Forgotten` tombstone.
- `store` and `embed` now have color tests and `Internalized` ledger tests.
- `any` now has both bool-disjunction and missing-dependence coverage.
- `attest` now asserts that successful identity gating records `Attestation`.
- `pub import` now has re-export and private-name rejection coverage.
- Visibility now covers private qualified references, not only import/spawn.
- Generics now cover non-generic `enum` and `interface`.
- `Decision` provenance now covers `.committed` and `.margin`, not only `.basis`.
- Readable `decide` now covers reversible tie default/abstain behavior.
- Package path dependencies, required config bindings, fallback-temperature
  config, `sampling_fallback = false`, late `DeliveryRefused`, expression query
  append-nothing behavior, `select` boolean operators, recall-after-forget,
  decision read-only fields, private `reach`/`extend`/`emit`/`perform`/`when`,
  interface outcome mismatch, malformed f-strings, unknown operators, and
  non-generic type-argument rejection are now pinned.

## Remaining lockstep gaps

These are spec-defined behaviors that still need first-class conformance tests
before the suite can honestly be called exhaustive.

- Package resolution: pinned dependency identity beyond local path roots.
- Configuration binding: provider-derived `exposes_logprobs` and full manifest
  precedence across project/package/runtime layers.
- Replay depth: replay of write tools must prove the tool is not re-invoked,
  not only that the chain-head matches.
- Counterfactual replay/forking is described as optional; the suite should mark
  whether it is intentionally out of conformance scope.
- Prompt/tool standing sensors: long-running open-source behavior is only lightly
  covered through prompt opening.
- Structured-output schema generation: exact JSON Schema forms for scalars,
  enums, structs with `additionalProperties:false`, arrays, and nested event
  payloads are not directly asserted by the harness.
- Memory query surface: settled provenance from already-endorsed events.
- Gate calibration: warm conformal behavior, calibration pool scoping per gate
  site, manifest default conformal precedence, deference label re-entry, and
  mixed reversible/non-reversible arm behavior.
- Interfaces: private names in public interface surfaces.
- Lexer/parser: invalid numeric forms and escaped brace behavior.
