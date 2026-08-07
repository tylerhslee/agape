# Agape Runtime Conformance

This package is the transport-neutral black-box suite for the Agape runtime
contract in [`../SPEC.md`](../SPEC.md), especially sections 10, 16, 16.5, 16.7,
17.5, and 17.7. It does not import or assume the TypeScript, Rust, Studio, or
any other runtime implementation.

## Running the suite

An implementation exports `default`, `adapter`, or `createAdapter()` and
implements `RuntimeConformanceAdapter` from `src/adapter.ts`:

```sh
AGAPE_RUNTIME_ADAPTER=/absolute/path/to/adapter.js npm test
```

With no `AGAPE_RUNTIME_ADAPTER`, every test skips cleanly. The repository's
TypeScript adapter can be exercised with:

```sh
npm run test:agape-ts
```

The qualified named-memory cases are TDD oracles and are expected to remain red
until the TypeScript runtime implements the current SPEC. Adapterless execution
must remain clean.

## Core named-memory test-mode contract

`namedMemoryScenario` runs declared-memory operations against an adapter-owned
ephemeral local or Markdown driver. Its inputs are semantic rather than
implementation-specific:

- one structural descriptor (`type`, `modality`, authenticated `scope`,
  and `retention`);
- immutable host identity contexts;
- explicit store, recall, forget, close, and authenticated-resume steps;
- optional deterministic retrieval candidates for score/id ordering; and
- optional loss of one finalize acknowledgement after the ledger commit.

The result exposes exact typed recall envelopes, public receipts, snapshots, and
one ordered semantic trace of driver and ledger boundaries. The trace is not a
storage API. It exists so conformance can prove prepare -> ledger decision ->
finalize, reconciliation before later access, and zero driver mutation during
recorded replay.

`oracleStats.memoryDriverCalls` and
`oracleStats.memoryMutationCalls` are required for adapters implementing the
named-memory profile. They make the SPEC 16.5 no-live-driver replay rule
observable without exposing private durable contents.

## Explicit-only semantics

Agent turns do not consult, write, or forget memory merely because they occur.
A `MemoryConsulted` receipt is required only for an explicit source recall or
explicit host `memory.context` request. Named memory is always configured, and
every operation remains bound to the owning concrete agent instance, handle,
complete authenticated scope tuple, retention tier, and current generation.

The core oracle covers:

- exact `TYPE[]` misses and provider-free recall;
- equal-value episodic writes with distinct evaluation origins;
- tuple-local forget, repeated forget, and next-generation reopen;
- project/user isolation and missing-user crash with no driver access;
- descending score plus bytewise cell-id ordering before `top_k`;
- local-driver durable preflight rejection;
- Markdown durable close and authenticated resume;
- wrong-lineage resume rejection;
- lost-finalize-ack reconciliation by operation id; and
- replay with identical ledger head, zero provider/memory-driver calls, and no
  live durable mutation.

## Other adapter surfaces

The suite also covers scheduler lifecycle, ledger traces and canonical hashing,
task dispatch, attestation, fault recovery, replay, stochastic idempotency,
projection diagnostics, and advertised calibration evidence.

The repository currently carries explicit host artifact/decomposition and
implementation-learning diagnostics for the TypeScript adapter. Those calls are
advertised extension operations: they are not automatic properties of an Agape
agent, and they do not permit memory to modify source-defined instructions,
grants, dependencies, or authority.
