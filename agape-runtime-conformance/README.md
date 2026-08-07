# Agape Runtime Conformance

This package is the transport-neutral black-box suite for the Agape runtime
contract in [`../SPEC.md`](../SPEC.md), especially sections 10, 16.1a, 16.5,
16.7, 17.5, and 17.7. It does not import a runtime implementation.

## Running the suite

```sh
AGAPE_RUNTIME_ADAPTER=/absolute/path/to/adapter.js npm test
npm run test:agape-ts
```

With no `AGAPE_RUNTIME_ADAPTER`, all tests skip cleanly. The qualified
named-memory cases are TDD oracles and remain red until the runtime implements
the current SPEC.

## Named-memory test-mode contract

The adapter exposes four lifecycle operations:

- `openNamedMemorySession` constructs a runtime with one immutable host identity
  context, an adapter-neutral resolved program/schema, and concrete spawned agent
  instances.
- `invokeNamedMemory` invokes explicit store/recall/forget operations for one
  stable agent instance. It never accepts an identity override.
- `closeNamedMemorySession` destroys that runtime and returns its authenticated
  snapshot, recording, exact normalized invocation results, and mutation
  acknowledgements.
- `resumeNamedMemorySession` creates a fresh runtime instance from the
  host-returned snapshot and revalidates program, manifest, ledger, project, and
  lineage bindings before any driver read.

Driver namespaces let independent runtime sessions exercise one substrate while
the normative key still includes the stable agent instance, full authenticated
scope tuple, retention tier, handle, and generation.

Schemas are structural (`scalar`, `enum`, `array`, or recursively resolved
`struct`), not a caller-supplied type label. Recall envelopes carry the exact
decoded value, schema, schema/descriptor hashes, cell id, score, origin,
generation, and raw trust. Public receipts must contain protected hashes and must
not expose memory plaintext or raw project/user subjects.

The ordered trace uses normalized semantic phases:
`prepare -> ledger-commit -> finalize`, followed by `reconcile` when needed.
These are observable transaction boundaries, not mandatory physical driver method
names; an atomic driver wrapped by a runtime-owned transaction adapter is valid.

Recorded replay exposes the exact journaled named-memory invocation outputs and
mutation acknowledgements. Tests compare them structurally to the live run and
also require zero added provider calls, memory-driver calls, or live mutation.

## Explicit-only coverage

Agent turns do not consult memory merely because they occur. The core oracle
covers exact typed misses, equal-value episodic origins, two-instance and
project/user tuple isolation, tuple-local forget generations, missing-user crash
with no memory seam access, score/id ordering before `top_k`, local durable
preflight, Markdown close/resume with stable instance restoration, precise
lineage-mismatch rejection, public-receipt privacy, lost-ack reconciliation, and
seam-free replay.

The suite also carries scheduler, ledger, delegation, attestation, fault,
calibration, and explicitly advertised extension diagnostics. Extension learning
helpers do not define an Agape agent and cannot modify source-defined behavior or
authority.
