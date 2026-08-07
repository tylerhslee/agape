# AGENTS.md — agape-runtime-conformance

Black-box conformance for the runtime **contract** (`../SPEC.md` §16, §16.7–16.9,
§17.5–17.6). Tests are derived from the spec only and never import any implementation.
They drive a runtime **exclusively through an adapter** — this is a pure black box.

## Commands (verified green)
```sh
npm run test:agape-ts     # AGAPE_RUNTIME_ADAPTER=../agape-ts/src/runtime_adapter.ts vitest run -> 48/48
npm test                  # no adapter set -> 48 skipped (clean; proves the harness is green)
AGAPE_RUNTIME_ADAPTER=/abs/path/to/adapter.js npm test   # any other implementation
```

## Adapter contract
- Point the suite at a runtime with `AGAPE_RUNTIME_ADAPTER`. The module exports
  `default`, `adapter`, or `createAdapter()` and implements `RuntimeConformanceAdapter`
  in `src/adapter.ts`.
- With no `AGAPE_RUNTIME_ADAPTER`, **every test skips by design** — that keeps the package
  installable without blessing any implementation as the reference runtime.
- The agape-ts adapter lives at `../agape-ts/src/runtime_adapter.ts` (+ `_desugar`,
  `_memory` helpers). Programs run on the real agape-ts kernel; gate/taint/authority/
  scheduling/ledger semantics come from the kernel, not the shim.
- Test-mode surface is transport-neutral (HTTP/MCP/stdio/direct all valid); the assertion
  is semantic. `implementationLearningLoop` is deterministic: a fixed bad source must be
  checked, stored as decomposed experience, retrieved later, and corrected.

## Coverage (SPEC §17.5 mandatory items)
Explicit `MemoryConsulted` for authored recall or `memoryContext`; `agentRespond`
is memory-free; per-agent isolation; artifact decomposition
(summary/chunks/facts/graph/vectors/provenance); idempotent unchanged ingestion; failure
+ success experience internalization; longitudinal learning loop; user-correction
precedence; provenance to ledger ticks; replay without re-invoking oracles; no
memory-to-action trust laundering; canonical hashing excludes non-canonical fields;
`config.write` cannot set decision policy.

## Boundaries
**Always:** exercise a runtime only through `RuntimeConformanceAdapter`; derive assertions
from `SPEC.md`; keep `npm test` (adapterless) an all-skip clean run.
**Ask first:** changing the adapter interface (`src/adapter.ts`) or a test's spec mapping.
**NEVER:** import or assume a concrete runtime in a test; weaken/delete a test to pass;
make the adapterless run anything other than an all-skip clean pass.

## Stale doc to fix (NOT resolved here — report to owner)
`README.md` line 28 still reads "33 passed / 2 failed / 0 skipped" with 16_4 / 16_8 listed
as open gaps. The real run is **48/48** — those gaps are closed. `.github/workflows/ci.yml`
(the agape-ts adapter step comment) similarly says "35/35". Both are stale.
