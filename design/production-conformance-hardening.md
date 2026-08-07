# Design: production-path conformance profiles

Status: **accepted beta design** (2026-08-06).

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

The Studio Fact Checker requirements are scoped to its advertised product profile.
Its release tests require:

- the configured OpenAI-compatible connector and typed Credence request shape;
- protected recording of raw candidate/logprob evidence when the connector exposes it;
- the Studio/API authorization path that resolves evidence for an approved inspector;
  and
- visible threshold, margin, and gate-score arithmetic.

The core-agent profile makes no raw-logprob inspection claim. Connectors report
unavailable evidence truthfully; only the Studio profile exposes the calibrated
inspection feature.

## 4. Non-blocking research profile

The non-blocking research profile contains:
causal retrieval adaptation/ablation, autonomous lesson selection, candidate behavior
artifacts, std.behavior, evaluator/holdout isolation, principal-gated activation or
rollback, behavior-promotion gaming, runtime fork/import/migration, and
protected-content export protocols.

Research tests are reproducible, adversarial, and profile-labeled. They are
non-blocking for core and advertised shipped profiles. A capability moves to a
release-blocking profile with its SPEC rule, runtime surface, implementation, and
conformance oracle.

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

## 6. P01-P16 capability allocation

| Capability | Profile |
|---|---|
| P01 | Core agent instructions |
| P02-P03 | Core configured-memory boundary |
| P04-P07 | Core explicit-memory matrix |
| P08-P09 | Planned core scheduling, restart, and replay |
| P10 | Research correction policy |
| P11 | Studio Fact Checker calibration evidence |
| P12-P14 | Research adaptation and evaluation |
| P15 | Planned core durable identity |
| P16 | Studio calibration evidence authorization and retention |

No profile may claim that store/recall changes an agent's active instructions, grants,
evaluator, behavior, provider binding, or model weights.
