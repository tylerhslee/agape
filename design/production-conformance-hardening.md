# Design: production-path conformance profiles

Status: **accepted reframing; implementation matrix must be revised before it is
made release-blocking** (2026-08-06).

Production tests are valuable only when they prove a capability promised by the
selected Agape profile. A test drives ordinary .ag source through a fresh shipped CLI
process, normal manifest/configuration resolution, and externally observable outputs.
It must not substitute an interpreter helper, memory-driver helper, or Studio learner
for that boundary.

```text
ordinary project + manifest + configured connectors
                    |
                    v
         fresh agape run ... --json process
                    |
                    +-- exit/diagnostics, ledger/head, connector transcript,
                        configured durable state, and replay output
```

The core profile includes configured memory with explicit access. Studio calibration
and research are separately advertised claims.

## 1. Core-agent profile - beta release blocking

This is the smallest mandatory production matrix for every shipped runtime:

1. **Lifecycle and addressability:** spawn, constructor, awake, sleep, contained
   crash, mailbox delivery/refusal, and fresh spawn versus continuation.
2. **Source-settled instructions:** global/inherited/agent-local source instructions
   compose in order; task, prompt, tool, and recall values remain data and cannot
   rewrite source instructions.
3. **Bounded authority:** reach/default-deny, taint, decision, endorsement, and
   consequential sink enforcement work through the CLI.
4. **Ledger/replay:** ordinary recorded oracle calls replay without reinvocation and
   reproduce the promised canonical event projection.
5. **Scheduling:** same-instance observable effects preserve issue order; any
   cross-instance concurrency remains deterministic at the ledger boundary.

The existing language and runtime conformance suites remain the oracle for grammar
and fast diagnostics. A small black-box CLI matrix supplements them. It requires a
configured memory driver and explicit memory-operation coverage; raw logprobs,
behavior patches, import, and deployment transitions remain outside core.

## 2. Core explicit-memory matrix

Every shipped runtime must pass this matrix for each shipped driver:

1. Explicit mem store produces a receipt and modifies only the configured substrate;
   every non-zero modality count/ref resolves to actual durable state.
2. Explicit recall retrieves only the owning instance's cells and remains tainted.
   Forget truthfully reports the configured tombstone/archive/delete transition.
3. Two live instances, a re-awakened instance, and a newly spawned instance preserve
   documented isolation. If persistence keys use paths, path encoding is
   collision-safe and contained beneath the configured root.
4. Stored cells and recall candidates preserve available origin/provenance. A manual
   file edit enters as unauthenticated external data, never as a forged correction
   or trusted origin.
5. Restart/replay assertions are required only when the selected memory driver
   advertises those features.

The matrix asserts that reactions consult, write, rank, or retain memory only through
an explicit source or host memory operation.

## 3. Studio Fact Checker profile

The Fact Checker is a product using Agape, not a second set of universal language
semantics. Its release tests may require:

- the configured OpenAI-compatible connector and typed Credence request shape;
- protected recording of raw candidate/logprob evidence when the connector exposes it;
- the Studio/API authorization path that resolves evidence for an approved inspector;
  and
- visible threshold, margin, and gate-score arithmetic.

A runtime that does not advertise raw logprob inspection remains eligible for the
core-agent profile. It must not fabricate logprobs or claim this Studio calibration
feature.

## 4. Non-blocking research profile

The following are experimental and must not be beta release-gating requirements:
causal retrieval adaptation/ablation, autonomous lesson selection, candidate behavior
artifacts, std.behavior, evaluator/holdout isolation, principal-gated activation or
rollback, behavior-promotion gaming, runtime fork/import/migration, and
protected-content export protocols.

Research tests should be reproducible, adversarial, and profile-labeled. They may
fail while beta core and any advertised shipped optional profile remain green. They
become mandatory only after a separate SPEC change, source syntax or runtime surface,
implementation, and conformance proposal are accepted.

## 5. Harness rules

For any profile, the black-box harness:

- starts a fresh CLI process and uses only normal source, manifest, environment, and
  connector paths;
- records no real credentials and uses deterministic local loopbacks where needed;
- asserts diagnostics, ledger events, connector transcript, and only durable state
  promised by that profile;
- keeps failed artifacts for diagnosis and removes successful temporary projects; and
- treats a missing capability as a failed assertion only when the selected profile
  advertises it.

The manifest must encode profile membership and must not use required-pending entries
to make unrelated beta CI red by construction.

## 6. Migration from P01-P16

The previous P01-P16 inventory is useful as a backlog, but not as one mandatory
release gate:

| Former item | New disposition |
|---|---|
| P01 | Core-agent instruction test, narrowed to source semantics |
| P02-P03 | Core ordinary-send tests with configured memory and zero implicit memory operations |
| P04-P07 | Core explicit-memory matrix |
| P08 | Split core same-instance scheduling from optional persistence atomicity |
| P09 | Core ledger replay; memory restart/replay only when advertised |
| P10 | Research/policy experiment, not language semantics |
| P11 | Studio Fact Checker calibration profile |
| P12 | Non-blocking research |
| P13-P14 | Non-blocking future behavior-evolution research |
| P15 | Core lifecycle identity subset; storage import/migration research or optional runtime extension |
| P16 | Optional protected-memory/evidence profile |

No profile may claim that store/recall changes an agent's active instructions, grants,
evaluator, behavior, provider binding, or model weights.
