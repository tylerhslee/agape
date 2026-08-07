# Autonomous agents and learning capabilities

Status: **accepted beta design** (2026-08-06).

Agape is a language for inspectable, gated, replayable agent systems. `SPEC.md` and
the applicable conformance profiles remain the oracle.

## 1. Agenthood

An Agape agent is a first-class, typed, addressable instance with a constructor,
typed state, a mailbox, and explicit `spawn`, `awake`, `sleep`, crash, and task
lifecycle. It has bounded authority declared by grants, an append-only ledger, and
source-settled instructions.

Every runtime session is configured with a private-memory driver. Source accesses
memory through explicit handles and operations. Provider use, memory access, and
learning loops are separately advertised runtime capabilities.

An instance continues through sleep, re-awake, and a contained crash while its
ordinary state and ledgered identity remain available. A later `spawn` creates a new
instance; it does not silently reincarnate an older one. Source aliases are the
language-visible address. A durable-identity extension needs its own specification
and implementation before it becomes a language promise.

## 2. Source-settled behavior

`instruction` is source behavior. Global, inherited, and agent-local instructions
compose in source-defined order; recalled text and user/tool data are data, not
instructions. Changing instructions, grants, dependencies, schemas, or action
bindings requires a new source version through the ordinary deployment workflow.

Memory can inform a provider call only as tainted data. It cannot silently modify
active source, expand authority, authenticate itself, make a value settled, or bypass
a decision, endorsement, or sink check. Connector wire formats may vary, but must
preserve this semantic separation without an extra hidden instruction layer.

## 3. Explicit memory

Every runtime session is supplied a memory driver through manifest configuration or
host injection. `mem <- value`, `mem -> query`, and `forget mem` are explicit
source operations. Reactions without a memory operation perform no memory
consultation or write.

When source uses a memory operation:

- memory is scoped to the owning agent instance and cannot create cross-agent mutable
  subjective state;
- recall is tainted (`raw`, or `graded` when bound to `Credence<E>`), so it cannot
  create authority or reach a consequential sink without the normal gate;
- stores and forgets append truthful receipts for the storage state actually changed;
  absent graph/vector/blob materializers report zero derived effects;
- persisted cells retain available origin and ingress provenance; an unverified
  filesystem edit is external data, not authenticated history; and
- a substrate may be markdown, an index, or another backend without changing taint,
  isolation, or authority semantics.

A configured driver may provide retrieval, reflection, compression, ranking, and
episode-selection policies within explicit memory operations. These policies expose
their configuration and receipts and preserve source-defined authority.

## 4. Optional calibration

`Credence<E>`, `decide`, and `endorse` remain core gate semantics. Preservation
and inspection of raw logprob sequences, candidate mapping, and calibration profiles
are advertised bounded calibration capabilities. The Studio Fact Checker profile
requires them for visual inspection of close threshold and margin cases. Runtimes
advertise this profile only when they provide its evidence, authorization, and
retention dependencies. Unavailable raw evidence must not be invented.

## 5. Advertised adaptation capabilities

Adaptation capabilities advertise their syntax, authority model, principal review,
evaluator isolation, budgets, rollback, replay behavior, and conformance profile.
Retrieval-assisted adaptation, consolidation into inert candidate artifacts,
isolated candidate evaluation, and deployment transitions use separate advertised
operations and receipts.

Adaptation preserves the active source version. Deployment of a candidate behavior
uses an explicit source-version transition and does not change grants, provider
bindings, evaluators, or model parameters through memory.

## 6. Research guidance

Long-horizon agency and continual-learning experiments independently toggle
recurrence, retrieval, consolidation,
self-modeling, and evaluation while measuring baselines and ablations. Model-internal
workspace observations are model-specific protected observations and carry no
language authority or gate status.

The preferred experiment loop is:

```text
act -> observe -> propose -> isolated evaluate -> explicit human/deployment decision
```

It records evidence, budget, policy, and rollback conditions; it never silently
changes live source, grants, provider binding, evaluator, or model parameters.

## 7. Conformance profiles

- **Core agent profile:** lifecycle, addressability, source instructions, grants,
  gating, ledger ordering, replay, required runtime memory configuration, explicit
  store/recall/forget, taint, isolation, truthful substrate receipts, and provenance.
- **Studio Fact Checker profile:** provider integration and advertised calibrated
  logprob evidence used by that product.
- **Research profile:** causal adaptation, artifact evaluation, behavior evolution,
  and adversarial tests. It is non-blocking until specified and shipped.

Every conformant runtime supplies and proves its configured memory driver. Calibration
and research profiles make only the additional claims they advertise.
