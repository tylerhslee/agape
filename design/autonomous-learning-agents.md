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
learning loops do not determine whether an instance is an agent.

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
are optional bounded calibration capabilities. The Fact Checker may require this
profile because it benefits from visual inspection of close threshold and margin
cases. That makes it a Studio/product release requirement, not a universal
requirement for every Agape runtime. Unavailable raw evidence must not be invented.

## 5. Learning and behavior evolution are experiments

Retrieval-assisted adaptation, consolidation into an inert candidate artifact,
isolated candidate evaluation, and deployment transitions are useful experiments.
None is part of beta language semantics. In particular, there is no normative
`std.behavior` module, ambient artifact ingestion, automatic correction precedence,
automatic promotion or rollback, or authority change through memory.

A future proposal may define these operations only after its syntax, authority,
principal review, evaluator isolation, budgets, rollback, and replay semantics have
their own SPEC-first conformance suite. It may not silently mutate a live agent's
source, grants, provider binding, evaluator, or model parameters.

## 6. Research guidance

Long-horizon agency and continual-learning research motivate experiments, not a
claim that a memory store is learning or that an orchestrated model is conscious.
Experiments should independently toggle recurrence, retrieval, consolidation,
self-modeling, and evaluation while measuring baselines and ablations. Model-internal
workspace observations are model-specific protected observations - not language truth,
authority, or a basis for a gate.

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
