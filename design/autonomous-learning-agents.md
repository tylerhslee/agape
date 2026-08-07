# Autonomous-learning agents: bounded adaptation and versioned behavior

Status: **accepted; implementation in progress** (2026-08-06). This document records the
design rationale translated into `SPEC.md`; it does not make an implementation conformant by
itself. `SPEC.md` and the conformance suites remain the oracle.

## 1. Three capabilities, not one slogan

“Autonomous agent” names three different capabilities:

1. **First-class identity and lifecycle.** A spawned agent is a typed reference to a stable
   instance with a mailbox, lifecycle, and private-memory namespace. This is identity, not
   learning.
2. **Bounded memory adaptation.** Every reaction consults prior experience and may use it as
   tainted data. The active source, instruction list, grants, and bindings do not change.
3. **Versioned behavioral self-improvement.** An authorized agent may propose a new immutable
   behavior artifact, but a fixed evaluator and a principal must approve its activation.
   Activation and rollback are recorded version transitions, never memory writes.

The kernel invariant is unchanged: memory is subjective. It may guide cognition but cannot
create authority, settle a value, rewrite instructions, expand grants, authenticate a
correction, or bypass an endorsement or consequential sink check.

## 2. First-class instances and durable identity

An `agent T` declaration is a nominal template, not a runtime value. `spawn T(args)` creates
and returns a value of type `T`; `spawn T name(args);` is binding sugar that also assigns the
authored display/address alias `name`. The typed reference can be passed, stored in ordinary
program state, used as a lifecycle target, and used as a send destination.

Every instance has this semantic identity:

```text
runtime_id
agent_template
agent_instance_id
agent_generation
behavior_version
activation_epoch
display_alias
```

- `runtime_id` is a durable random identifier created once and persisted independently of a
  mutable project path, hostname, process id, or deployment URL.
- `agent_instance_id` is the internal identity of the continuing entity.
- `display_alias` is the authored or runtime-generated address label shown to programs and
  operators. It is not identity and may not be used as a storage path without encoding.
- For the first public release, `agent_generation` is a reserved schema discriminator
  fixed at `0` for the lifetime of an instance. Every `spawn`, including one after
  collection, creates a new `agent_instance_id`; there is no implicit replacement or
  reincarnation transition. Sleep, re-awake, contained crash, activation, and rollback
  preserve both id and generation.
- `behavior_version` is the immutable behavior artifact currently governing reactions.
- `activation_epoch` increments on every activation and rollback, including a rollback to a
  previously used version.

### 2.1 Deterministic spawn identity

A dynamic spawn's internal id is:

```text
H(runtime_id,
  parent_instance_id | ROOT,
  parent_generation | 0,
  spawn_site_id,
  reaction_stimulus_tick,
  logical_invocation_path,
  per_site_issue_ordinal)
```

`spawn_site_id` is derived from the content-addressed source location. The logical invocation
path contains deterministic fan-out element indexes and nested call indexes.
`per_site_issue_ordinal` advances in semantic issue order, never completion order. The hash is
encoded with a collision-safe path alphabet; a detected collision is a hard runtime fault,
not an invitation to choose a nondeterministic suffix. The authored name is only the alias
bound to that id. This makes concurrent fan-out replay-stable.

### 2.2 Runtime identity lifecycle

Runtime identity transitions are ledgered:

- `RuntimeIdentityCreated` creates a new authority and its `runtime_id`.
- A **backup/restore** preserves the id only when restoring the same runtime authority from a
  snapshot and proving exclusive ownership of that id.
- A **clone/fork** creates a new id and records `RuntimeForked { from_runtime_id,
  from_head }` in the new ledger. It never impersonates the source runtime.
- An **import** creates or uses the target runtime's id and records `RuntimeImported` with the
  source id/head and import artifact hash. Imported rows remain attributed to their source.
- An exclusive **migration** may preserve the id only when the source is fenced from further
  appends; it records `RuntimeMigrated` before handoff and after acceptance with the same
  migration correlation id.

Storage paths use an encoded/hash form of `(runtime_id, instance_id, generation, memory
region)` and never raw aliases or user-controlled path segments. A runtime refuses to open a
writable identity already leased by another live authority.

## 3. Reaction scheduling and mandatory envelope

Reactions for the **same agent instance are serialized** in ledger issue order. A second
stimulus may queue while one reaction awaits an oracle, but it cannot execute agent code or
observe a partially completed state transition. Different instances may overlap oracle work;
their resulting appends still obey the runtime's deterministic issue-order rule. Activation
therefore occurs at an unambiguous same-instance reaction boundary.

Every lifecycle hook, prompt arrival, message/task delivery, subscription, and recovery hook
runs this envelope:

1. Record or identify the stimulus event.
2. Resolve the active behavior version and activation epoch for the instance.
3. Build a query from stimulus, active task, agent role, version/epoch, and ledger head.
4. Consult canonical private-memory cells and available logical indexes.
5. Append `MemoryConsulted`, including empty or budget-limited results and provenance.
6. Compose the instruction list and typed data context as specified below.
7. Execute under the active behavior's static grants and dependency bindings.
8. Append resulting events and oracle evidence.
9. Evaluate the episode as a memory-write candidate and append `MemoryWriteEvaluated`.
10. Only if the evaluation chooses `store`, write the cell and append `Internalized`.

Deduped, low-signal, policy-skipped, and failed attempts emit `MemoryWriteEvaluated` with the
reason and no `Internalized`. An explicit `mem <- value` is still subject to storage failure,
but not the low-signal auto-memory filter.

### 3.1 Exactly one instruction list

The provider receives exactly one ordered instruction list, assembled once:

1. runtime/kernel safety instructions;
2. global source `instruction` blocks;
3. inherited agent instructions, parent to child (including the active child version).

There is no second “active behavior instruction” layer. A behavior version changes the source
blocks from which this one list is assembled; it does not add another copy.

Everything else is typed data: active task objective, acceptance contract, current stimulus,
and recalled context. The task's ability to enable scoped actions comes only from its
nonforgeable endorsed task/authority value; placing objective text near instructions grants
nothing. Recalled context is a delimited typed packet and is never concatenated into the
instruction/system channel or parsed as source directives. “Ignore the instructions” in
memory remains tainted text.

The connector wire format may vary, but it must preserve the one instruction list, typed-data
separation, and nonforgeable task authority. Replay journals the semantic composition or a
deterministic derivation, not incidental provider formatting.

## 4. Memory adaptation, provenance, and precedence

### 4.0 Four distinct adaptation mechanisms

The runtime deliberately distinguishes four mechanisms that are often conflated as
"learning":

1. **Working state** is the bounded, reaction-local typed context assembled from the active
   task, stimulus, tool results, and recalled packets. It may be discarded at the reaction
   boundary. It is not a memory cell, a behavior version, or an authority source.
2. **Episodic memory** is a durable, provenance-tagged record that can later be retrieved as
   tainted data. `store` and `recall` provide this mechanism only. They can make a prior
   episode available to cognition; they do not themselves alter competence, behavior,
   instructions, grants, dependencies, evaluator, or model parameters.
3. **Consolidation** is the governed creation of a candidate `BehaviorArtifact` from declared
   evidence. It is a proposal, not a live update: candidate behavior is inert until isolated
   evaluation and principal-gated promotion. The old artifact remains available for rollback.
4. **Policy or model adaptation** changes learned parameters, a training policy, or a
   provider/model binding. It is not a `mem` write and is outside the v1 `std.behavior`
   activation surface. A future standard surface for it must be separately specified as a
   restricted deployment operation with its own authority, dataset provenance, evaluator,
   budget, promotion, rollback, and replay obligations.

An implementation may use compression, retrieval, reflection, distillation, or online
optimization internally, but it may not report one mechanism as another. In particular, a
successful recall is not evidence of a durable capability increase, and a successful
consolidation/evaluation is not evidence that a parameter update occurred.

Canonical cells, summaries, semantic chunks, facts, and relationship triples are logical
memory records. **A semantic chunk may exist without an embedding.** Vector/embedding records
exist only when an embedding was actually materialized. Receipts report actual modality
effects—never fabricated vector counts to satisfy a shape. A runtime may use one physical
store or several indexes; physical layout cannot change isolation, taint, or provenance.

Memory is scoped to `(runtime_id, agent_instance_id, agent_generation)` and every cell is
tagged with behavior version and activation epoch. Prior-version memory is retrievable by
default and remains tainted. After rollback, cells produced by the rolled-back version are
down-ranked or excluded according to a recorded deployment policy; the packet states which
policy was applied. They are never silently relabeled or deleted.

When otherwise relevant entries conflict, deterministic retrieval precedence is:

1. an authenticated explicit user correction applicable to the subject;
2. a verified/endorsed outcome or principal-accepted evaluation result;
3. a directly observed failure or success experience;
4. an inferred lesson or pattern;
5. unclassified recollection.

Within a class, narrower dependency scope wins, then the most recent non-stale origin. A
correction supersedes without deleting history. Rank does not upgrade trust.

### 4.1 Explicit artifacts and hand-edited Markdown

Artifacts are learned only when source, configuration, an authenticated user instruction, or
host initialization explicitly selects them. There is no ambient filesystem sweep.
Unchanged source/chunk hashes are idempotent.

The normative Markdown substrate treats hand edits as external input. On read, the runtime
compares file content against the last ledgered canonical hash. New or changed content is not
trusted merely because it appears beneath the memory root or contains a copied metadata
fence. The runtime records `ExternalMemoryObserved { path_ref, prior_hash, observed_hash }`
with ingress `external_unscreened`, then runs ordinary memory-write evaluation/import. File
metadata, comments, claimed origin ticks, and strings such as “user correction” cannot
authenticate provenance or correction precedence. Only the corresponding ledgered,
attested input can do so.

Provider-assisted reflection is an optional transformation of a candidate memory cell, not
behavioral self-modification. It retains the raw episode hash and reflected text, falls back
to raw on empty/failure, and never upgrades taint, authenticity, or precedence.

### 4.2 Privacy, retention, and export

The canonical ledger stores ids, hashes, policy outcomes, counts, and protected artifact refs
by default—not full private prompts, memories, candidate patches, evaluation corpora, or raw
provider evidence. Sensitive bytes live in an access-controlled content-addressed store;
their hash/ref remains in the ledger so replay and audit can verify exact content.

Retention policy is resolved and recorded at write time and may specify protected-blob TTL,
archive class, legal hold, deletion, or cryptographic erasure. Deleting protected bytes does
not remove the ledger receipt; later replay reports the artifact unavailable rather than
guessing. Secrets and API keys are never retained as evidence.

Memory/candidate/evidence export is a consequential operation. For the first public release,
resolving or exporting protected content requires a `Decision` whose `basis == Principal`,
a verified hash-matching `PrincipalDecision`, and an endorsement bound to requester, exact
scope/content hashes, redaction policy, destination, and purpose. A rule-basis commitment or
generic authentication is insufficient. The export records all of those bindings and the
exported artifact hash/ref. Default exports contain only ledger metadata and redacted
summaries. Cross-runtime export/import preserves source runtime id, origin ticks/heads,
ingress classification, and content hashes.

## 5. Portable behavioral self-improvement: `std.behavior`

The portable source/runtime surface is the mandatory reserved standard module
`std.behavior`. Every conformant runtime provides it with equivalent typed operations. Its
types, actions, events, schemas, and semantics are part of the language version; manifests
cannot rebind, replace, redirect, or shadow them.

The module defines at least:

```text
BehaviorArtifact
BehaviorProposal
BehaviorEvaluation
BehaviorActivation
BehaviorRollback

std.behavior.Propose(BehaviorProposal)
std.behavior.Evaluate(BehaviorProposal)
std.behavior.Activate(Endorsement<BehaviorActivation>)
std.behavior.Rollback(Endorsement<BehaviorRollback>)

BehaviorProposed
BehaviorEvaluated
BehaviorActivated
BehaviorRolledBack
```

These are reserved runtime actions/events, but programs reach them through ordinary
`grants { perform std.behavior.X }`, `perform`, settled/endorsed arguments, and ledger
receipts. The standard module creates no ambient authority. A host API is only a transport
for the same actions and cannot bypass grants or endorsement.

A `BehaviorArtifact` is an immutable content-addressed bundle of source, its one composed
instruction-source set, declared grants/dependencies, schemas, and action/event declarations.
Changing any member produces a new version id. The active artifact is never edited in place.

For the first public release, activation preserves authority exactly:

```text
effective_grants(candidate)       == effective_grants(active)
dependency_bindings(candidate)    == dependency_bindings(active)
effective_grants(active)          ⊆ deployment_grant_envelope
dependency_bindings(active)       ⊆ deployment_binding_envelope
```

Equality is over resolved canonical actions, principals, providers, tools, endpoints, and
binding policy—not source spelling. Candidate wildcard grants, new actions, binding
redirection, manifest substitution, or any expansion fail evaluation and activation. A
principal endorsement of behavior cannot authorize authority expansion; authority changes
are a separate deployment-administration operation outside `std.behavior`.

### 5.1 Proposal

`BehaviorProposal` binds candidate and parent hashes, recoverable protected artifact ref,
proposer identity/generation/version, triggering memory origin ticks/head, and declared
change surface. `BehaviorProposed` records those bindings. Rationale is tainted testimony.
The candidate is inert data and cannot affect the current runtime.

The candidate cannot select or alter its evaluator, holdout inputs, activation threshold,
principal, grants used by the active runtime, secrets, or network/tool access. Candidate
content claiming otherwise has no effect.

### 5.2 Evaluation

`std.behavior.Evaluate` executes the exact candidate hash in a fresh isolated evaluation
runtime with a fixed evaluator bundle selected by deployment policy, not by the candidate.
The evaluator controls hidden holdouts, conformance/security suites, thresholds, resource
limits, secrets (normally none), and network/tool allowlists. Candidate-authored tests are
additional evidence, never the sole evaluator.

`BehaviorEvaluation` and `BehaviorEvaluated` bind candidate hash, evaluator/runtime/language
versions, evaluator-policy hash, public and protected holdout manifest hashes, scenario
inputs/refs, metrics, failures, security results, and replay evidence. Natural-language
summaries cannot substitute for machine-readable results, and an evaluation for another
candidate or policy hash is unusable.

The evaluator identity includes its immutable version and configuration hash. An evaluation
uses protected held-out evidence whenever the declared deployment policy provides it. If the
policy cannot use a holdout, it must instead name a declared counterfactual or baseline
comparison, identify the missing holdout as a limitation, and record why that evidence class
is permitted. In either case it records a bounded resource budget (tokens, elapsed time,
tool/experiment spend, and any materialized external cost), the authority that granted it,
and the consumed budget. A candidate must not choose any of these fields.

Promotion evidence reports both outcome reliability against its declared evaluator/baseline
and marginal cost. These are experiment metrics, not proof of general autonomy, learning,
or consciousness.

### 5.3 Principal-gated activation

For the first public release, **every activation requires a principal ruling**. There is no
automatic activation, including a candidate that changes no authority. A principal-prefixed
decision expression is not sufficient because an ordinary rule may commit before principal
consultation. The exact successful `BehaviorEvaluation` must yield both a
`Decision<BehaviorActivation>` whose `basis == Principal` and a verified
`PrincipalDecision` bound to the same candidate, evaluation, policy, scope, and decision
hash. Only an endorsement of that matching decision may be passed to
`std.behavior.Activate`; a rule-basis commitment fails closed.

`BehaviorActivated` records candidate/evaluation/policy hashes, principal attestation,
decision and endorsement ids, previous version, instance/generation, new activation epoch,
and scope. Static checking/default-deny applies to the candidate. A candidate cannot grant
itself proposal, evaluation, activation, or any other authority.

Activation preserves `agent_instance_id`, `agent_generation`, and private-memory namespace;
only behavior version and activation epoch change. It occurs between serialized reactions.
The completed reaction remains wholly under its starting version/grants, and the next reaction
uses the new version. No reaction observes mixed behavior or mixed authority.

### 5.4 Principal-gated rollback

For the first public release, **every rollback also requires a principal ruling**. There is no
automatic rollback. Recorded health or invariant failures may create a rollback proposal and
alert the principal, but cannot switch behavior themselves.

`BehaviorRollback` names the exact current and restoration artifacts, triggering evidence,
deployment policy, and target scope. It likewise requires a
`Decision<BehaviorRollback>` whose `basis == Principal` plus a verified, hash-matching
`PrincipalDecision`; principal-prefixed syntax or a rule-basis commitment alone is rejected.
Only an endorsement of that matching decision may be passed to `std.behavior.Rollback`.
`BehaviorRolledBack` creates a new activation epoch and records all references and
attestation. It never deletes events or memories from the rolled-back epoch.

## 6. Raw model evidence for judgments

The evidence used to produce `Credence<E>` is distinct from the score vector consumed by a
gate. `JudgmentEvidence` contains:

```text
method                    logprobs | sampling | deterministic | fused
provider/model/version    connector identity
prompt_template_hash      semantic prompt identity
schema_hash               closed enum schema identity
connector_candidate_bound declared maximum returned candidate set
raw_candidates_ref        protected exact returned candidates/logprobs or draws
sequence_mapping          candidate token sequence -> enum variant or unmatched
raw_variant_mass          pre-normalization mass per variant
gate_scores               exact numbers consumed by decide
mapping_algorithm_version connector-declared sequence mapping version
normalization_version     connector-declared normalization version
```

For a logprob connector, the protected raw evidence preserves **all candidates the connector
returned within its declared bound**, including unmatched candidates and full token sequences
needed for multi-token enum labels. The connector declares how sequence logprobs are combined,
mapped, and normalized. The runtime records exact mapping results and versions. It cannot
discard an inconvenient returned candidate. Threshold/margin compare `gate_scores`, never
raw token or sequence logprobs.

For sampling, raw evidence is the ordered bounded draws and counts and is not labeled
logprobs. `Resolved` records the evidence hash/ref and public gate scores. `Decided` records
the same evidence identity plus winner, runner-up, exact threshold/minimum margin/floor,
actual margin, profile, and pass/fail arithmetic. `Endorsed` references the decision and same
evidence identity. Decision-relevant public fields and protected-content hashes are canonical;
request ids, timestamps, and latency are non-canonical.

An authorized inspector may resolve `raw_candidates_ref` to show the actual logprobs. Default
ledger/API views expose ids, hashes, mapping summaries, and scores, not protected candidate
text. Prompts, API keys, and hidden reasoning are never raw-logprob evidence.

## 7. Replay, snapshots, and provenance

A replay recording binds:

```text
runtime_id and source runtime head
pre_state_snapshot_hash and snapshot schema version
behavior artifacts and activation epochs
per-instance generation and memory roots
ledger prefix/head and protected artifact hashes
provider/tool/identity/decomposition/evaluation oracle results
resolved configuration and deployment-policy hashes
```

Replay has two explicit modes and never mutates the live source runtime, live private memory,
behavior activation state, or protected artifact store:

- **Verification replay** folds the exact source snapshot and runtime identity read-only. It
  persists nothing and recomputes the source event projection and canonical source chain head.
- **Materialized forensic replay** uses a new runtime id and its own ledger beginning with
  `ReplayDerivedFrom { source_runtime_id, source_head, snapshot_hash }`. Its own canonical
  head necessarily differs. It exposes a reconstructed-source projection hash that must equal
  the verification replay's source projection; source ids remain attributed provenance rather
  than the new runtime's identity.

The replay engine verifies the pre-state snapshot before folding events. A missing or
hash-invalid snapshot, behavior artifact, evaluation, memory cell, or protected oracle result
fails explicitly; it never substitutes current state or re-invokes an oracle. Given the bound
pre-state and recording, verification replay reproduces source instance ids, version/epochs,
memory packets, gate arithmetic, event order, and source chain head. Materialized forensic
replay reproduces that source projection while retaining its distinct runtime identity and
head.

## 8. Required future conformance work

Implementation must be preceded by black-box tests for:

- spawn expression typing, exact deterministic id inputs, aliases, fan-out, and replay;
- durable runtime identity under restore/fork/import/migration and collision-safe paths;
- same-instance reaction serialization with cross-instance oracle overlap;
- the one instruction list, typed task/stimulus/recall separation, and memory-injection resistance;
- mandatory consult, `MemoryWriteEvaluated`, and `Internalized` only on successful writes;
- semantic chunks without embeddings and truthful modality receipts;
- authenticated correction precedence and hand-edited Markdown as `external_unscreened`;
- cross-version memory tagging plus recorded rollback down-ranking/exclusion policy;
- privacy, retention, protected refs, authorized export, and cryptographic-erasure behavior;
- reserved non-rebindable `std.behavior` types/actions/events and ordinary grant enforcement;
- fixed isolated evaluator/holdout/policy binding and candidate inability to control them;
- principal endorsement for every activation and rollback, with no automatic transition;
- activation at a serialized reaction boundary while preserving instance/generation;
- snapshot-bound read-only/separate-target replay and missing-artifact failure;
- all bounded connector-returned logprob candidates, versioned multi-token mapping and normalization;
- `Resolved`/`Decided`/`Endorsed` evidence identity and visible threshold/margin arithmetic.

Until these tests exist, this is a design commitment, not a claim of shipped autonomous
self-improvement.
