# Agape Conformance Coverage

Target spec: `../SPEC.md` `v1.0.0-beta.2026.8.6.0` — the core kernel.

This directory is the black-box language conformance suite. Expected behavior is derived only from `SPEC.md`; implementation behavior is not an authority. The `.ag` files are the source of truth, and `MANIFEST.toml` / `MANIFEST.md` are generated from their headers.

Runtime conformance is tested separately in `../agape-runtime-conformance` with TypeScript black-box adapter tests for SPEC sections 16 and 17. UI-specific Studio tests and hosted-runtime tests are additional suites, not substitutes.

## Current Status

- Language suite: `.ag` accept/reject tests under `tests/` — currently `253` tests (`148` accept, `105` reject), including qualified typed-memory descriptors and recall, `06b_world` (the wired events/actions world interface), `06c_delegation` (the §6c task-send), and the §13 attestation protocol (pending principal decision, attester-match verification).
- Runtime suite: TypeScript adapter tests under `../agape-runtime-conformance`.
- Core kernel only: the suite exercises the core kernel with no syntactic sugar. Gate branching is an ordinary `if` over `.committed` (no arm block); bounded fan-out is `|>`; fusion is `quorum` with `independent`/`dependent` (no `all`/`any`); memory uses structural named-clause `mem` descriptors with typed store/recall plus the objective `select … from ledger` query (no `mem<T>`, `find`, or `match`); rules carry inline `floor`/`readiness` (no `policy` declaration); the bounded `retry N` recovery block (§11) is core and exercised (`11_control`). The deferred library layer (modules, visibility, generics, interfaces) and §20 ergonomics (reversible sinks) are not exercised.
- Manifest freshness is enforced by `python3 build_manifests.py --check`.

## Coverage Standard

The suite is complete only when every normative SPEC behavior is covered by at least one of:

- a positive `.ag` language test;
- a negative `.ag` language test proving the correct boundary/error class;
- a runtime TypeScript test where the behavior is not expressible as one source file;
- an explicit out-of-scope note for implementation freedom allowed by the spec.

Every surface construct above the trusted kernel needs bypass tests for taint, endorsement, grants, write-tool gating, replay, and memory trust laundering.

## Runtime/Adapter Coverage

- Section-by-section compiler coverage accounting is tracked in `SPEC_COVERAGE.md`.
- TypeScript runtime conformance tests cover scheduler/FIFO, illegal communication traces, canonical ledger behavior, replay/no-oracle-reinvocation, existing memory-driver diagnostics, projection staleness/conflicts, config precedence, sampling fallback, warm conformal behavior, profile staling, and runtime API surfaces. Exact typed envelopes, authenticated scope resolution, deterministic capped ranking, durable restart, generation reconciliation, and memory replay without live mutation remain pending runtime/production coverage for the named-clause contract.
- Remaining implementation work is adapter work: each runtime must provide an `AGAPE_RUNTIME_ADAPTER` implementation so these tests execute instead of skip.
