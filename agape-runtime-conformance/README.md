# Agape Runtime Conformance

This is the TypeScript black-box conformance suite for the Agape runtime contract in `../SPEC.md` version `v1.0.0-beta.2026.7.16.0`.

The tests are derived only from the spec, especially sections 16, 16.7, 16.8, 16.9, 17.5, and 17.6. They do not import or assume the Rust runtime, Studio runtime, or any existing implementation.

## Running Against A Runtime

An implementation provides an adapter module and points the suite at it:

```sh
AGAPE_RUNTIME_ADAPTER=/absolute/path/to/adapter.js npm test
```

The adapter module must export either `default`, `adapter`, or `createAdapter()`. Its object must implement the `RuntimeConformanceAdapter` interface in `src/adapter.ts`.

If `AGAPE_RUNTIME_ADAPTER` is not set, the tests are skipped. That keeps this package installable without blessing any implementation as the reference runtime.

## Running Against agape-ts

The agape-ts compiler/runtime ships an adapter at `../agape-ts/src/runtime_adapter.ts`:

```sh
npm run test:agape-ts
# equivalent to: AGAPE_RUNTIME_ADAPTER=../agape-ts/src/runtime_adapter.ts npm test
```

Current scorecard: **33 passed / 2 failed / 0 skipped** (see "Known agape-ts gaps" below).

Adapter notes (see the headers of `agape-ts/src/runtime_adapter*.ts` for the full design):

- Programs execute on the real agape-ts kernel (parse, check, interp). This suite's embedded
  sources predate the core-kernel spec strip, so the adapter first applies a transparent
  source-level desugar (`runtime_adapter_desugar.ts`): `policy` declarations become inline gate
  rules, gate arm blocks become `if (d.committed == V) { endorse ...; ... }` chains, `write tool`
  declarations become `action` + manifest `[tools.*]`/`[actions.*]` wiring, `event<T>` reply
  bindings become bare reply types, prompt binder `.body` becomes the kernel `.text`, f-string
  `{x}` becomes `${x}`, `{ ... } retry(N)` is unrolled, and cognition-bearing top-level `when`
  blocks are hoisted into a generated agent. Gate, taint, authority, scheduling, and ledger
  semantics all come from the kernel, not the shim.
- `canonicalHash` is the SPEC 16.2 SHA-256 chain over the six canonical fields.
- `run(record: true)` journals every oracle answer (provider judge/structured/reply, tool
  results); `replay` re-executes with journal-backed seams, so provider/tool/identity/prompt/
  decomposition/embedding oracles are never re-invoked and the canonical head must reproduce.
- The 16.7 memory envelope (artifact decomposition into summary/chunks/facts/triples/vectors,
  experiences, corrections, context ranking) is adapter-level test-mode machinery over real
  session-ledger ticks (`runtime_adapter_memory.ts`); the kernel `mem` substrate does not itself
  decompose artifacts. GateProfile bookkeeping, config resolution, and exactly-once ingress
  dedup (SPEC 15.5) are likewise implemented at the adapter's transport layer.

### Known agape-ts gaps

- `16_4` "raises MarginFloorViolation and prevents the sink": the kernel folds the `floor`
  directive into the decide step (a below-floor margin abstains), so the sink is prevented but
  no `MarginFloorViolation` fault event is ever appended (SPEC 13/16.6 describe a committed
  decision faulting at the sink).
- `16_8` "forms warm conformal prediction sets": the kernel's `conformal` rule is cold-start
  only — it always abstains. There is no calibration-pool fitting, and `Decision.predictionSet`
  is never produced (SPEC 15.5.6/16.8).

## Required Test-Mode Surface

The spec requires an implementation to ship a test mode. The adapter exposes that test mode in a transport-neutral way:

- `health`, `run`, `check`, `ledgerRead`
- `agentRespond`
- `memoryIngest`, `memoryContext`, `memoryInspect`
- `configRead`, `configWrite`
- `recordExperience`, `recordUserCorrection`, `implementationLearningLoop`
- `triggerExternalSource`, `validateLedgerTrace`
- `seedProjection`, `projectionInspect`
- `calibrationScenario`, `resolveConfig`
- `multiRunScenario`, `idempotencyScenario`
- `rebuildMemoryFromRecording`
- `replay`, `oracleStats`, `canonicalHash`

The runtime may implement these over HTTP, MCP, stdio, direct library calls, or any other transport. The conformance assertion is semantic, not transport-specific.

`implementationLearningLoop` is deliberately deterministic. The suite passes a fixed first candidate source file that violates the spec in a known way; the runtime must check that exact source, store the diagnostic as decomposed experience, retrieve it on a later turn, and produce a corrected source. The test does not rely on making an LLM "happen" to write the same bad program.

For learning conformance, a failed coding experience is not just an opaque transcript. The adapter must expose the stored decomposition:

- raw diagnostic/check evidence
- compact lesson summary
- typed facts
- graph triples
- vector texts
- ledger origin tick

## Current Coverage

This first runtime suite covers the mandatory memory-envelope items enumerated in SPEC section 17.5:

- mandatory `MemoryConsulted` on every agent turn, including empty memory
- per-agent memory isolation
- artifact ingestion into summary, chunks, facts, graph, vectors, and provenance
- idempotent unchanged artifact ingestion
- failure and success experience internalization
- longitudinal implementation learning: failed check/run evidence must produce a descriptive diagnostic, be decomposed into memory, be retrieved on a later turn, and change the agent's next implementation attempt
- user-correction precedence
- memory provenance back to ledger ticks
- replay without re-invoking provider/tool/decomposition/embedding oracles
- no memory-to-action trust laundering

It also covers runtime API health/version reporting, canonical ledger hashing excluding non-canonical fields, and the rule that `config.write` cannot set decision policy.

Additional runtime sections are covered by dedicated files:

- `16_1_scheduler_lifecycle.test.ts`: FIFO issue-order scheduling, synchronous subscription cascades, prompt liveness, agent generation stability.
- `16_2_ledger_trace.test.ts`: gap-free ticks, `ledger.read`, canonical hash behavior, illegal lifecycle trace rejection.
- `16_4_fault_recovery.test.ts`: schema `TypeMismatch`, retry behavior, contained crashes, failed principal decisions, margin-floor faults.
- `16_5_replay_rebuild.test.ts`: replay without re-invoking provider/identity/tool/prompt/memory oracles, and memory rebuild from recording.
- `16_7a_projection_conflict.test.ts`: projection staleness metadata and conflict projection.
- `16_8_calibration_config.test.ts`: config precedence, derived `exposes_logprobs`, sampling fallback, warm conformal prediction sets, profile staling.
- `15_5_stochastic_idempotency.test.ts`: multi-run observational-equivalence/stability checks and exactly-once idempotency.
