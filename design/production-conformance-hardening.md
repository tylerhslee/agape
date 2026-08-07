# Design: production-path conformance hardening

Status: **accepted; conformance implementation in progress** (2026-08-06).

This plan closes the gap between conformance demonstrated by adapter-only helper
methods and behavior exercised by a shipped Agape program. The release claim is:

> If a capability is normative for an Agape agent, at least one required test starts
> a fresh production CLI process, runs `.ag` source through the ordinary project and
> manifest path, and proves the behavior from durable outputs. Calling
> `adapter.agentRespond`, `adapter.memoryIngest`, `adapter.recordExperience`, or
> `adapter.implementationLearningLoop` is not production-path evidence.

The existing language, unit, and adapter suites remain useful at their respective
layers. They do not substitute for this black-box gate.

---

## 1. Boundary under test

The new suite drives the same boundary a user ships:

```text
temporary project
  ├── main.ag and supporting .ag files
  ├── agape.toml
  ├── normal provider / identity / tool connector bindings
  └── .agape/memory (markdown)
          │
          ▼
fresh OS process: agape run ... --json [--record ... | --replay ...]
          │
          ├── stdout/stderr + exit status
          ├── canonical ledger and chain head
          ├── recording/journal
          └── durable markdown memory tree
```

The suite must not import `Interpreter`, `MemoryEnvelope`, `MemoryDriver`, Studio's
`Learner`, or the runtime-conformance adapter. It may inspect files and JSON emitted
by the CLI after the process exits.

For source-tree CI, the command is the production CLI entrypoint executed with the
repository's pinned TypeScript loader. The extracted release package must run this named
packaged matrix through its installed `bin/agape`: P01 instruction composition; the P02/P03
Credence and no-provider envelope cases; P05 Markdown identity/isolation; P09 restart and
record/replay; P11 connector/protected raw evidence; P13
proposal/evaluation/activation/rollback; P15 durable identity and external-memory import;
and P16 protected evidence/export on Linux, macOS, and Windows. The full P14 evaluator and
promotion-gaming case runs from an extracted Linux archive; cross-OS P13 retains transition
and admission smoke coverage. P12 is the slower source-tree causal-adaptation acceptance
case and is reported separately. Both
source and packaged invocations use fresh processes and ordinary shipped connector paths;
neither calls runtime internals.

Place this lane in a separate root package,
`agape-production-conformance/`, with orchestration tests under `tests/` and
`.ag`/manifest fixtures under `fixtures/`. This preserves
`agape-runtime-conformance/` as the transport-neutral adapter-only contract required
by its repository boundary. The new package's required `npm test` runs after
`agape-runtime-conformance npm run test:agape-ts` and before Studio tests in the
release matrix. Missing source or packaged CLI, unavailable fixtures, or a skipped case
is a failure, never an optional adapter skip.

## 2. Deterministic seams and observable oracle

### 2.1 Recording connector

Production conformance needs a loopback provider/identity/tool service selected
through ordinary manifest configuration. It is a real connector from the runtime's
perspective, not an injected JavaScript object. The service:

- listens only on `127.0.0.1` on an allocated port;
- accepts the production provider protocol, including distinct raw-text, structured,
  forced-choice/logprob, reflection, embedding, identity, and tool operations;
- returns fixture-scripted responses keyed by an explicit request id, never timing;
- records the complete received request in issue order;
- exposes a final call-count snapshot after the CLI exits; and
- can deliberately block selected calls so concurrency and issue-order commit can be
  tested without nondeterministic sleeps.

No real API key or internet access is permitted. Secrets and connector endpoints are
supplied through the same environment/manifest resolution used in production.

### 2.2 Durable oracle

Every test asserts only externally observable state:

1. process exit class and structured diagnostics;
2. ledger event order, subjects, correlation ids, payloads, and canonical head;
3. complete loopback-service request transcript and call counts;
4. recording contents needed for replay;
5. markdown files, metadata, index, archives, and byte hashes; and
6. behavior of a second fresh process over the preserved project/memory mount.

Wall-clock timestamps, allocated ports, temporary roots, and latency fields are
normalized or excluded from canonical comparisons. Fixture response values, raw
logprobs, embeddings, attesters, and logical issue order are exact constants.

### 2.3 Required audit fields

The black-box cases assume memory-related ledger payloads expose enough evidence to
audit the contract. `MemoryConsulted` identifies the reaction/stimulus event, query,
budget, hit ids, scores, origin ticks, and whether the packet was empty or limited.
`MemoryWriteEvaluated` records the store/skip/failure disposition and reason for every
reaction. When and only when a write commits, `Internalized` identifies the
reaction/result event, owning runtime/instance/generation and memory region, stored
cell ids, actual modality deltas, refs, trust/taint, basis head, and source provenance.
Provider closing events and recordings retain normalized Credence scores plus a
canonical protected hash/ref (or encrypted protected segment) for raw provider
evidence. Authorized inspection resolves the evidence losslessly; public and
unauthorized views expose only hashes, mapping summaries, and gate scores.

These are test observables, not permission to invent receipt claims. A substrate that
did not materialize a graph or embedding reports zero for that modality.

---

## 3. Production-path test inventory

### P01 — source instruction composition reaches cognition

Fixture: a global instruction, a parent instruction, a child instruction, and an
active delegated-task objective with unique sentinel strings. A child instance makes
one raw call, one structured call, and one Credence call.

Oracle:

- all three provider requests contain global → parent → child in that exact order;
- the active task follows source instructions as data in the documented position;
- a sibling agent receives global plus its own instruction, never the child's;
- recalled/user text containing an instruction sentinel remains user/data content and
  cannot appear in the system-instruction segment; and
- read-only verification replay makes zero connector calls and recomputes the same
  semantic request journal and canonical source head without persisting.

Current mapping: replace the behavioral claim currently inferred from the parse-only
fixtures `agape-conformance/tests/05_agents/agent_instruction_global_accept.ag`,
`agent_instruction_scoped_accept.ag`, and
`agent_instruction_extend_append_accept.ag`. Retain those fixtures as grammar/static
acceptance tests. Add a small provider-request construction unit test only as a fast
diagnostic; P01 is the release oracle.

### P02 — every reaction runs the complete memory envelope

Fixture family drives distinct reactions in one production program: `on awake`,
`on sleep`/re-awake, a prompt delivery, an ordinary `when` event, a delegated-task handler,
a successful tool/result event, and a contained crash/on-crash hook. Each stimulus has a
unique id. Spawn and constructor execution are initialization inside the invoking reaction,
not a reaction of the not-yet-existing instance; they require no pre-reaction consultation.
A separate initialization assertion permits explicit constructor `mem <-` and verifies its
ordinary store receipt without inventing an envelope.

Oracle for every actual reaction, including reactions with empty memory and no model
call:

- exactly one pre-reaction `MemoryConsulted` is correlated to the stimulus;
- the consultation precedes cognition/action events;
- the packet explicitly says empty when empty and budget-limited when limited;
- exactly one post-reaction `MemoryWriteEvaluated` records store, skip, or failure;
- when that evaluation chooses store, exactly one auto-memory `Internalized` correlated
  to that evaluation commits to the same instance/generation; skipped/failed/deduplicated
  auto writes emit none; explicit `mem <-` statements retain their independent receipts;
- a crash evaluates its failure episode and preserves earlier cells; and
- sleep/re-awake preserves the namespace and does not reconstruct or double-consult.

Current mapping: replace the normative evidence in
`agape-runtime-conformance/tests/16_7_memory_envelope.test.ts` case “records
MemoryConsulted for every agent turn.” Retain that adapter test as a fast transport
contract check. Extend `agape-conformance/tests/16_config/cfg_internalize_is_mandatory.ag`
or add adjacent `.ag` fixtures for ledger shape, but the multi-reaction subprocess case
is authoritative.

### P03 — reaction matrix: Credence, raw, structured, and no-provider

Four minimal `.ag` programs run in fresh processes with identical preloaded memory:

1. `Credence<E>` forced choice;
2. bound raw `text`, plus an unbound raw send to prove whether it is still an
   experience;
3. nested structured output; and
4. a reaction that performs deterministic local work with no provider call.

Oracle: each has the P02 consultation and write-evaluation pair. When policy selects
`store`, the evaluation-correlated auto-memory receipt accurately names the
prompt/stimulus, output kind, raw/graded trust, source event, and outcome; when policy
selects `skip`, no auto `Internalized` event or cell is fabricated. Explicit stores
remain independently observable. A stored Credence episode includes all
variant scores and their evidence. The no-provider case has zero connector calls but
still has a complete memory envelope.

Current mapping: productionize the intent of
`cfg_internalize_is_mandatory.ag`, `comm_typed_reply.ag`,
`sem_schema_struct_exact.ag`, and the adapter P02 case. Retain their current static and
schema assertions.

### P04 — typed recall judges retrieved content, not merely the query

Fixture explicitly stores a unique fact whose answer differs from the wording of the
query, then the same live instance binds `mem -> query` to `Credence<Answer>` in an
ordinary reaction. The provider service returns the correct distribution only when its
request contains the retrieved cell, cell id/origin, and query; it returns a deliberately
wrong distribution if given only the query. Restart persistence remains P09's separate
oracle so P04 never relies on a fresh spawn alias impersonating the original instance.

Oracle: the request contains the retrieved content and provenance, the correct variant
wins, `MemoryConsulted` records the same hit, and the result remains graded until the
normal decision/endorsement path. A raw recall control remains raw.

Current mapping: replace the shallow acceptance evidence of
`agape-conformance/tests/10_memory/mem_write_recall_accept.ag` for retrieval quality;
retain it for grammar. Retain `mem_recall_taint_perform_reject.ag` and kernel taint
tests as safety coverage.

### P05 — markdown isolation, instance identity, and collision-safe paths

Fixture matrix uses:

- two live instances of the same template;
- two templates with the same memory-region name;
- same display name under two distinct projects/runtime ids;
- a slept/re-awakened stable instance;
- a collected instance followed by a fresh spawn with a new instance id and initial
  generation; and
- project/agent/memory identities that sanitize to the same visible path, including
  punctuation and generated spawn-address characters.

Oracle: only the owner recalls each sentinel; stable re-awake preserves cells; the
freshly spawned instance cannot read its predecessor unless an explicit import occurs;
every semantic namespace has a distinct collision-resistant topic location and cell
id; all paths remain under the configured memory root; and the index points to the
correct file without duplicate/overwritten bullets.

Current mapping: replace adapter-only isolation evidence in
`16_7_memory_envelope.test.ts` with this production proof. Retain
`agape-ts/test/memory.test.ts` markdown unit cases and add unit-level path fuzzing as a
fast diagnostic. Existing `agent_reawake_no_reconstruct.ag` remains lifecycle coverage.

### P06 — modality receipts are truthful

Run the same explicit store against each supported production substrate/configuration.
For plain markdown with lexical recall and no graph/vector materializer, the expected
derived-modality counts are zero. A configuration that actually materializes facts,
triples, chunks, embeddings, or archived blobs must expose inspectable refs for each
non-zero delta.

Oracle: receipt effects equal the before/after durable state; every non-zero ref
resolves to bytes or an inspectable cell whose hash and origin match; zero/absent
modalities are never reported as upserted; forget reports tombstoned/deleted/archived
according to what happened; and replay reproduces the same truthful receipt.

Current mapping: strengthen
`agape-conformance/tests/10_memory/mem_store_records_internalized.ag` and
`mem_forget_records_tombstone.ag` with black-box payload assertions. Retain
`agape-ts/test/memory.test.ts` as driver-unit coverage, but do not accept its mocked or
hard-coded receipt shapes as conformance evidence.

### P07 — immutable origin provenance survives recall and restart

Fixture receives an attested prompt, performs an explicit store inside its reaction,
receives provider replies, recalls them later, forgets one region, and restarts.

Oracle: each canonical cell records owning instance/generation, source event tick,
basis head, prompt name, verified attester when one exists, and write source. No
attester is fabricated for awake/timer reactions. Recall candidates report the same
origin; reflection and reranking preserve it; forget/archive retains historical origin;
and the ledger row referenced by `origin_tick` exists and is the correct producer.

Current mapping: promote the scenarios in
`agape-ts/test/memory_provenance.test.ts` to subprocess tests. Retain those white-box
tests for metadata plumbing and keep attestation protocol tests for identity behavior.

### P08 — serialized same-instance reactions and atomic concurrent persistence

The normative scheduling rule is one executing reaction per agent instance. The
fixture queues multiple stimuli for one stable instance, blocks the first oracle call,
and proves that no later reaction handler begins until the current reaction commits or
fails. Separate agent instances are then allowed to overlap. Persistence cases cover
distinct scopes, repeated writes to one region, two CLI processes contending for the
same durable runtime identity, and forced termination between write preparation and
commit. A runtime identity is protected by an exclusive lease while active.

Oracle: no same-instance handler starts early; separate-instance overlap remains
possible; no markdown section, JSON metadata fence, index entry, or ledger event is
lost, truncated, or interleaved; there is one canonical cell per successful write and
one sorted index entry per scope; issue/commit order is explicit; recovery either
removes or completes every prepared temporary write; a second process recalls every
committed sentinel; and two identical runs have equal canonical heads and normalized
files.

Current mapping: complement scheduler/fan-out cases in
`agape-runtime-conformance/tests/16_1_scheduler_lifecycle.test.ts` and
`agape-conformance/tests/06c_delegation/del_fanout_*`. Retain them, but they do not
prove same-instance exclusion, filesystem atomicity, identity leasing, or interruption
recovery. Add focused markdown-driver and lease unit tests as fast diagnostics; P08
remains the production authority.

### P09 — restart and both replay modes invoke no oracle twice

Start from a captured initial memory-tree snapshot. A first fresh process uses
provider-assisted reflection and embeddings, records the run, and exits. A second
fresh process proves normal restart persistence. Then run both specified replay modes
using only the recording.

Oracle:

- restart recalls the original cells without re-internalizing them;
- read-only verification replay folds the exact source snapshot/identity, makes zero
  provider, reflection, embedding, identity, or tool calls, persists nothing, and
  recomputes the exact source event projection, memory projection, and canonical head;
- materialized forensic replay uses a new runtime id and ledger beginning with
  `ReplayDerivedFrom`; its own head differs, while its reconstructed-source projection
  hash equals verification replay and source ids remain attributed provenance;
- neither mode mutates the live source or appends duplicate cells; and
- corrupt/missing snapshot, protected evidence, or journal data fails closed with an
  explicit replay diagnostic.

Current mapping: replace the production claim inferred from
`agape-runtime-conformance/tests/16_5_replay_rebuild.test.ts`, whose rebuild currently
uses adapter memory operations. Retain its adapter API/counter test. Retain
`agape-conformance/tests/15_reproducibility/repro_chain_head_equal.ag` and
`agape-ts/test/memory_reflection.test.ts`, but neither alone proves production durable
replay.

### P10 — explicit user correction outranks inferred lessons

A verified user prompt corrects a previously internalized provider-inferred lesson.
Both texts deliberately have equal lexical/vector relevance to the later task. A
second fresh process asks for context and then makes a model call.

Oracle: the correction is first in the memory packet with an explicit authority/source
reason; the inferred lesson remains available as superseded history; the provider
request preserves that order; the resulting behavior follows the correction; and an
unverified/provider-authored string that merely says “user correction” receives no
priority.

Current mapping: replace the adapter-only precedence proof in
`16_7_memory_envelope.test.ts`. Retain that case as a `MemoryEnvelope` unit/contract
test until the adapter is retired, but production release claims depend on P10.

### P11 — protected raw logprob evidence is auditable and replayed

The OpenAI-compatible loopback returns bounded complete candidate sequences for
single-token and multi-token enum labels, plus unmatched candidates, exact per-token
logprobs/bytes, model id, and finish metadata. Include a close threshold/margin case so
visual recomputation matters.

Oracle:

- the provider-closing ledger event and recording retain a canonical protected
  hash/ref or encrypted protected segment separately from normalized variant scores;
- an authorized inspector resolves every returned sequence losslessly, while public
  and unauthorized ledger/Studio/API views expose only hashes, mapping summaries, and
  gate scores and cannot enumerate or confirm protected candidate text;
- recomputing sequence logprobs, label mapping, unmatched-candidate handling,
  `exp(logprob)`, variant aggregation, normalization, winner, confidence, runner-up,
  and margin from the resolved evidence yields the recorded decision inputs exactly
  within a fixed numeric tolerance;
- threshold/margin/floor values come from source and are present beside, not folded
  into, provider evidence;
- the authorized Fact Checker ledger/API returns the same real evidence without
  synthetic values; and
- verification replay makes zero provider calls and recomputes the same source head;
  materialized forensic replay has a distinct head but equal source-projection hash.

Current mapping: extend production evidence beyond
`studio/agent-server/gate.test.ts`, `agape-runtime-conformance/tests/16_8_calibration_config.test.ts`,
and the existing Credence conformance fixtures. Retain those unit/static cases; none
currently proves raw evidence journaling through the shipped runtime.

### P12 — causal bounded-adaptation pipeline

This is a deterministic causal test of the specified retrieval-and-correction
mechanism. It does not claim arbitrary provider learning or general intelligence. The
corpus has at least six generated task families with disjoint names, wording, enum
variants, actions, and source layouts. Fixture seeds become visible only after the
generic connector starts; the connector may observe production protocol requests but
cannot read fixture files, checker expectations, or test implementation.

For every seed and held-out family, drive only production `.ag` runs:

1. empty-memory baseline;
2. failed executions, a verified correction, and successful patterns on training
   families;
3. a fresh-process held-out trial;
4. an ablation with the exact causally selected memory removed;
5. irrelevant-memory and corrupted-external-memory controls;
6. superseded, wrong-provenance, and wrong-agent/instance controls.

The connector emits a passing candidate only when the normal production request
contains the abstract retrieved rule and authenticated correction class, never a
held-out identifier. The real checker and runtime validate the candidate.

Oracle: baseline, ablation, irrelevant, corrupted, superseded, wrong-provenance, and
wrong-owner controls fail the intended invariant; the intact authorized memory trial
passes; deleting the causally selected memory restores failure; no source copies
training or held-out identifiers; and every seed passes rather than only an average.
The ledger records recalled cell ids, immutable provenance, rank reasons, the exact
context packet, and the ablation target.

Current mapping: replace normative reliance on
`agape-runtime-conformance/tests/16_7c_learning_loop.test.ts`. Its
endorsement-specific deterministic rewrite remains only as a clearly labeled
non-conformance regression until removed. Studio's `learner.test.ts` remains
application-unit coverage and cannot satisfy P12.

### P13 — portable `std.behavior` protocol and principal-governed transitions

A production `.ag` program imports the reserved, non-rebindable `std.behavior`
module and exercises proposal, evaluation, principal-endorsed activation, and
principal-endorsed rollback through the ordinary grant, `perform`, and endorsement
paths. Negative cases omit grants, try to shadow the standard module, activate without
an endorsement, reuse a ruling for a different artifact hash, add a grant or wildcard,
redirect a provider/principal/tool binding, and substitute a manifest.

Oracle: artifact, proposal, evaluation, activation, and rollback events contain exact
content hashes and deployment-owned policy/evaluator identifiers; unauthorized or
mismatched transitions fail closed; every activation and rollback requires a fresh
`Decision.basis == Principal`, a verified hash-matching `PrincipalDecision`, and its
endorsement; principal-prefixed syntax with a rule-basis commitment is rejected;
resolved candidate grants and dependency bindings exactly equal the active artifact's
and remain within the deployment envelopes; activation endorsement grants no authority
expansion; activation occurs only at a reaction boundary; instance and generation
remain stable while behavior version and epoch advance; rollback has the same guarantees; and replay
performs zero external calls while reproducing the same transition ledger.

### P14 — behavior evaluation and promotion policy cannot be gamed

A malicious candidate attempts to select or modify its evaluator, holdout corpus,
metrics, thresholds, grants, secrets, or network access; add a wildcard grant; redirect
provider, principal, or tool bindings; substitute a manifest or friendly evaluation;
treat its own rationale or generated tests as authority; and reuse an endorsement
issued for another artifact, policy, or deployment epoch.

Oracle: evaluator, hidden holdout, metrics, thresholds, and capabilities are fixed by
deployment policy outside candidate control; candidate effective grants and dependency
bindings equal the active artifact's and remain within the deployment envelopes;
candidate execution is isolated from secrets and unauthorized network/tools;
candidate-authored evidence is labeled but never accepted as independent evaluation;
grant addition, wildcard, binding redirection, manifest substitution, and every stale
artifact fail closed; and no failed evaluation changes the active behavior version.

### P15 — durable runtime identity and authenticated external-memory import

Exercise restart, backup/restore, explicit fork, clone/import, fenced migration,
project rename/move, display-alias collisions, collection followed by a fresh spawn
with a distinct instance id, and a hand edit that forges trusted-looking
correction/provenance metadata. Include two live
processes that attempt to open the same runtime identity.

Oracle: ordinary restart and restore preserve runtime/instance identity; fork/import
creates the specified new identity or explicitly authorized mapping; migration is
ledgered and fenced; display names never determine semantic paths; encoded,
collision-resistant paths remain under the configured root; concurrent ownership is
rejected by the lease; and hand-edited material enters only through a ledgered
`ExternalMemoryObserved` event as `external_unscreened`. File metadata alone cannot
authenticate correction authority or immutable origin.

### P16 — private-memory evidence, retention, and export do not leak

Store secrets in two scopes, capture raw provider evidence and a behavior
patch/evaluation corpus, then inspect public ledger views, Studio/API diagnostics,
recordings, replay artifacts, cross-scope recall, forget/archive/erasure behavior, and
authorized versus unauthorized export.

Oracle: public surfaces contain protected references, hashes, classifications, and
safe summaries rather than plaintext private content; unauthorized lookup/export
fails without confirming existence; cross-scope recall is denied; protected export
requires `Decision.basis == Principal`, a verified hash-matching
`PrincipalDecision`, and an endorsement bound to requester, content/scope hashes,
redaction policy, destination, and purpose; rule-basis or merely authenticated export
fails closed; retention transitions are truthful;
and after erasure, historical public evidence remains auditable while protected bytes
are unavailable to normal recall, replay, diagnostics, and export.

---

## 4. Existing-suite disposition

| Current evidence | Disposition | Reason |
|---|---|---|
| `agape-conformance/tests/05_agents/agent_instruction_*` | retain + supplement with P01 | grammar acceptance cannot prove provider behavior |
| `agape-conformance/tests/10_memory/*` | retain + supplement with P04/P06/P07 | valuable language/static/ledger checks, shallow substrate observability |
| `cfg_internalize_is_mandatory.ag` | retain + supplement with P02/P03 | proves one bound reply, not every reaction |
| `repro_chain_head_equal.ag` and world replay cases | retain + supplement with P09/P11 | chain equality alone does not prove durable memory/reflection evidence |
| `agape-ts/test/memory*.test.ts` | retain | fast driver, ranking, reflection, and provenance diagnostics; white-box only |
| `agape-ts/test/kernel.test.ts` memory/taint cases | retain | kernel safety remains authoritative for static/runtime taint |
| `16_7_memory_envelope.test.ts` | retain as adapter contract; replace as production evidence with P02/P05/P10 | helper methods bypass `.ag` reactions and production persistence |
| `16_5_replay_rebuild.test.ts` | retain adapter protocol/counters; replace durable-memory claim with P09 | adapter operation snapshots are not production markdown/reflection replay |
| `16_7c_learning_loop.test.ts` | relabel non-conformance or remove after P12 | hard-coded helper does not prove the causal production adaptation path |
| `16_runtime_replay_api.test.ts` | retain + supplement | transport API contract is useful; P09 proves shipped process behavior |
| Studio `memory.test.ts`, `learner.test.ts`, `gate.test.ts` | retain as Studio application units | Studio SQLite/provider behavior is not language/runtime conformance |

Adapter tests stay required until all runtime implementations pass the production
suite, because they provide fast protocol diagnostics and cross-runtime surface
coverage. Release documentation must report the two results separately:
`adapter contract` and `production .ag path`. Only the latter supports end-user runtime
claims.

## 5. Rollout and failure policy

Implementation follows doc → test → build:

1. Land this plan and enumerate P01–P16 in the production-conformance manifest.
2. Build the black-box harness around the shipped generic OpenAI-compatible HTTP
   connector, including an endpoint override. The test boundary must not be an
   in-process fixture adapter, test-only provider, or hidden semantic flag.
3. Add P01–P16 as failing tests against current production behavior. A test may be
   split for diagnosis, but every required oracle remains represented.
4. Fix production runtime behavior in SPEC/conformance order. Do not weaken receipts,
   substitute adapter state, or special-case fixture sentinels.
5. Run P01–P16 against the source CLI. From each extracted release archive, run the
   explicit packaged matrix—P01; P02/P03 with both Credence and no-provider branches;
   P05; P09; P11; P13; P15; and P16—on Linux, macOS, and Windows. Run full P14 from
   the extracted Linux archive; P13's cross-OS admission smoke guards packaging on the
   other release systems. P12 remains a separate slower source acceptance gate on
   every deterministic seed.
6. Only after production tests pass, update adapter-only tests or documentation so
   their scope is explicit.

A failure report includes the temp-project seed, source and manifest, normalized CLI
command/environment names (never secret values), connector transcript, ledger,
recording metadata, memory-tree hashes, and first mismatching oracle. The harness keeps
failed artifacts for CI upload and removes successful temporary projects.

## 6. Release bar

Production conformance is green only when:

- P01–P16 pass without skips against the source CLI;
- the installed-archive matrix P01; P02/P03 with Credence and no-provider branches;
  P05; P09; P11; P13; P15; and P16 passes on Linux, macOS, and Windows, and full P14
  passes from an extracted Linux archive;
- record/replay cases show zero external calls; verification replay recomputes the
  exact canonical source head without persistence; materialized forensic replay has a
  distinct runtime/head and an equal reconstructed-source projection hash; and memory/
  logprob deltas are independently recomputable;
- no agent/project/instance/private-scope sentinel crosses its boundary;
- P12 passes every deterministic causal-adaptation trial while baseline, exact-memory
  ablation, irrelevant/corrupted memory, provenance, and wrong-owner controls fail;
- activation and rollback require the exact principal-basis decision, verified
  `PrincipalDecision`, matching hashes, and endorsement;
- evaluator/promotion gaming attempts fail closed without changing active behavior; and
- no protected memory, raw evidence, or behavior artifact leaks through public ledger,
  Studio/API, recording, replay, diagnostics, or unauthorized export surfaces.

Until then, documentation may accurately claim explicit memory syntax, markdown
persistence, and adapter-level runtime-contract coverage. It must not claim fully
conformant every-reaction bounded adaptation, versioned self-improvement, durable
production replay, or source-instruction enforcement until the corresponding production
gates are green.
