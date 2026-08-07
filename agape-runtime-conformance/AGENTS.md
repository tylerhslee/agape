# AGENTS.md - agape-runtime-conformance

Black-box conformance for the runtime contract (`../SPEC.md` sections 10, 16,
16.7-16.9, and 17.5-17.7). Tests are derived from the spec and never import an
implementation. They drive a runtime exclusively through an adapter.

## Commands

```sh
npm run typecheck
npm test                  # no adapter: every test skips cleanly
npm run test:agape-ts     # implementation gate; new named-memory cases are TDD-red
AGAPE_RUNTIME_ADAPTER=/abs/path/to/adapter.js npm test
```

## Adapter contract

- Point the suite at a runtime with `AGAPE_RUNTIME_ADAPTER`. The module exports
  `default`, `adapter`, or `createAdapter()` and implements
  `RuntimeConformanceAdapter` in `src/adapter.ts`.
- With no adapter, every test skips by design. This keeps the package installable
  without blessing a reference implementation.
- Tests are transport-neutral: HTTP, MCP, stdio, and direct adapters are valid.
- `namedMemoryScenario` is the deterministic test-mode seam for exact typed
  envelopes, authenticated identity contexts, close/resume, retrieval candidates,
  and recoverable driver faults. The trace exposes only semantic driver/ledger
  boundaries needed to prove the transaction and replay contracts.
- Artifact decomposition and `implementationLearningLoop` are advertised
  extension-profile diagnostics shipped by the TypeScript adapter. They do not
  define agenthood and are not implicit memory operations.

## Core explicit-memory coverage

A reaction with no source or host memory operation has no `MemoryConsulted`.
Qualified named-memory cases cover exact typed empty recall, tuple and
agent-instance isolation, episodic origins, deterministic score/id ranking,
tuple-local generations, authenticated scope faults with no driver access,
retention preflight, durable Markdown close/resume, wrong-resume rejection,
prepare/ledger/finalize reconciliation, and replay with no provider/driver calls
or live durable mutation.

## Boundaries

**Always:** exercise runtimes only through `RuntimeConformanceAdapter`; derive
assertions from `SPEC.md`; keep adapterless `npm test` all-skip and clean.

**Ask first:** changing the adapter interface or a test's spec mapping.

**NEVER:** import a concrete runtime in tests; require implicit consultation or
learning merely because a turn occurred; weaken a source-defined authority,
isolation, durable, or replay invariant to pass an implementation.
