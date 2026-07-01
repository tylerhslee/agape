# Agape Conformance Coverage

Target spec: `../SPEC.md` `v1.0.0-alpha.2026.6.30.0`.

This directory is the black-box language conformance suite. Expected behavior is derived only from `SPEC.md`; implementation behavior is not an authority. The `.ag` files are the source of truth, and `MANIFEST.toml` / `MANIFEST.md` are generated from their headers.

Runtime conformance is tested separately in `../agape-runtime-conformance` with TypeScript black-box adapter tests for SPEC sections 16 and 17. UI-specific Studio tests and hosted-runtime tests are additional suites, not substitutes.

## Current Status

- Language suite: `.ag` accept/reject tests under `tests/` — currently `229` tests (`134` accept, `95` reject).
- Runtime suite: TypeScript adapter tests under `../agape-runtime-conformance`.
- Finalized gate surface: tests have been moved off removed `case`, subjectless `endorse (...)`, bare `c by R`, `certify`, `attest`, and removed `Decided`/`Attestation` event names.
- Manifest freshness is enforced by `python3 build_manifests.py --check`.

## Coverage Standard

The suite is complete only when every normative SPEC behavior is covered by at least one of:

- a positive `.ag` language test;
- a negative `.ag` language test proving the correct boundary/error class;
- a runtime TypeScript test where the behavior is not expressible as one source file;
- an explicit out-of-scope note for implementation freedom allowed by the spec.

Every surface feature above the trusted kernel needs bypass tests for taint, endorsement, grants, write-tool gating, replay, and memory trust laundering.

## Runtime/Adapter Coverage

- Section-by-section compiler coverage accounting is tracked in `SPEC_COVERAGE.md`.
- TypeScript runtime conformance tests now cover scheduler/FIFO, illegal communication traces, canonical ledger behavior, replay/no-oracle-reinvocation, memory envelope, artifact ingestion, learning from experience, projection staleness/conflicts, config precedence, sampling fallback, warm conformal behavior, profile staling, and runtime API surfaces.
- Remaining implementation work is adapter work: each runtime must provide an `AGAPE_RUNTIME_ADAPTER` implementation so these tests execute instead of skip.
