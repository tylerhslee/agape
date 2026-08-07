# AGENTS.md - agape-runtime-conformance

Black-box conformance for the runtime contract (`../SPEC.md` sections 10, 16,
16.7-16.9, and 17.5-17.7). Tests are derived from the spec and never import an
implementation. They drive a runtime exclusively through an adapter.

## Commands

```sh
npm run typecheck
npm test                  # no adapter: every test skips cleanly
npm run test:agape-ts     # implementation gate; named-memory cases are TDD-red
AGAPE_RUNTIME_ADAPTER=/abs/path/to/adapter.js npm test
```

## Adapter contract

- The adapter module exports `default`, `adapter`, or `createAdapter()` and
  implements `RuntimeConformanceAdapter` in `src/adapter.ts`.
- With no adapter, every test skips by design.
- Tests are transport-neutral: HTTP, MCP, stdio, and direct adapters are valid.
- Named-memory tests use explicit open, invoke, close, and authenticated-resume
  calls. One opened session fixes host identity context kappa. Invocations select
  a concrete stable agent instance but cannot replace kappa.
- Descriptor schemas are recursively resolved structural schemas. The adapter
  reports consistent schema/descriptor hashes and exact typed recall envelopes.
- Trace phases are normalized semantic boundaries. `prepare`, `finalize`, and
  `reconcile` may be supplied by a physical driver or an equivalent
  runtime-owned transactional adapter; tests do not require a particular API.
- Close destroys the runtime session. Resume creates a fresh runtime instance from
  a host-returned authenticated snapshot.
- Artifact decomposition and `implementationLearningLoop` are advertised
  extension diagnostics, not properties of agenthood or implicit memory.

## Core explicit-memory coverage

A reaction with no source or host memory operation has no `MemoryConsulted`
ledger row. Qualified cases cover exact typed recall, concrete-instance and
authenticated-tuple isolation, episodic origins, deterministic ranking,
tuple-local generations, missing-subject crashes without seam access, retention
preflight, public-receipt privacy, durable close/resume, binding rejection,
ledger-bound reconciliation, and replayed outputs/acks with no live seams.

## Boundaries

**Always:** exercise runtimes only through the adapter; derive assertions from
`SPEC.md`; keep adapterless `npm test` all-skip and clean.

**Ask first:** changing the adapter interface or a test's spec mapping.

**NEVER:** import a concrete runtime in tests; make source operations choose
authenticated identity; expose private values or raw identity in public receipts;
or weaken authority, isolation, durable, or replay invariants to pass an
implementation.
