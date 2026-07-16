# SPEC Coverage Matrix

Target: `SPEC.md` `v1.0.0-beta.2026.7.16.1` — the core kernel.

Scope of this matrix: compiler/language conformance only. Runtime-only obligations in sections 16/17/18 are marked `runtime-suite` because they cannot be proven by feeding `.ag` source to a compiler. They belong in the TypeScript runtime conformance suite and adapters.

Status meanings:

- `covered`: compiler-visible behavior has direct accept/reject and, where needed, manifest/schema assertions.
- `runtime-suite`: not a compiler obligation; covered by runtime adapter tests.
- `out-of-scope`: explanatory/deployment prose with no compiler-visible behavior.

| SPEC section | Compiler status | Coverage basis |
|---|---|---|
| 0 Scope and layering | covered | Trusted-kernel path and static/dynamic separation are covered through authority, taint, gate, and replay-header tests. Runtime execution model is `runtime-suite`. |
| 1 Orthogonal axes | covered | Axis tests cover pure/async, trust tiers, ledger presence, and independence of the axes. |
| 2 Lexical structure | covered | Comments, keywords, strings, f-strings (`${expr}` interpolation with literal plain braces, invalid escapes, unterminated interpolation), operators, missing semicolons, unknown operators, and invalid numeric forms. |
| 3 Types | covered | Scalars, arrays, structs, enums, events/actions, `Credence`, `Decision`, `Endorsement`, `Rule` non-storage, declared dependencies, exact payload arity/types. |
| 4 Functions/color | covered | pure restrictions, dependency reaches, tool/store reaches, in-hand gate operations, and trust flow through helper calls. |
| 5 Agents/lifecycle | covered | Spawn/awake/sleep/crash, `extend`, hooks, instruction blocks, prompts, and agent construction/resume rules. Runtime persistence/generation is `runtime-suite`. |
| 5b Prompt | covered | Prompt declaration, prompt-origin settled input at sinks, and missing prompt config. Long-running source behavior is `runtime-suite`. |
| 6 Communication | covered | Send lifecycle, typed replies, self-send, expiry, lost sends, late delivery refusal, and reach grants. Illegal host-forged traces are `runtime-suite`. |
| 6b Tools | covered | Read/write tools, effect-class requirement, use grants, settled write inputs, and tainted write inputs. Replay non-invocation is `runtime-suite`. |
| 6c Delegation | covered | The task literal (objective/acceptance/expires), foreground and background binding, worker-side `on assigned`/`complete`/`fail`, cooperative cancellation, both failure paths, the ledger aliases plus the four real task events, and delegation authority (static grant ∧ endorsed-task enablement). Runtime task scheduling is `runtime-suite`. |
| 7 Ledger/events/when | covered | Event emission, exact spine assertions, event order, prospective `when`, guards, `about`, query-result events, and tool event pairs. Canonical hashing is `runtime-suite`. |
| 8 Semantic checking | covered | Provider-produced `Credence`, closed enums, entailment, the schema-violation TypeMismatch that faults the send (with `on crash` recovery), and exact schema assertions for enum/struct/array outputs. |
| 9 Prelude | covered | Built-in events, Error subtyping, user Error leaves, Contradiction catching, Expired non-Error behavior, and `say` non-ledger behavior. |
| 10 Memory | covered | `store`, the `mem` handle, recall taint, forget/tombstone, the objective `select … from ledger` query, origin projection, no ledger recall, recall requires a `mem`, and query expression/statement distinction. Memory envelope internals are `runtime-suite`. |
| 11 Control flow | covered | `if`/`else`, branching on a `Decision`'s `.committed` over enum variants, the abstained else case, ungated `Credence` rejection, `Credence`-in-`if` rejection, and the bounded `retry N` recovery block (transient-TypeMismatch recovery, exhaustion crash, and first-attempt success). |
| 12 Aggregation/quorum | covered | `quorum`, total dependence coverage, independent and dependent fusion, mixed independent/dependent clusters, and partial-coverage rejection. Runtime fan-out scheduling is `runtime-suite`. |
| 13 Capabilities/governance | covered | Default-deny grants, subtractive extend, reach/use/perform authority, taint at sinks, subject endorsement, the endorsement binder as the settled subject, sink-admissibility only in a committed `if` branch, non-admissibility in the abstained else branch, raw-subject rejection, subject-scope rejection, the deference requirement, principal decisions, failed principal decisions, the attestation protocol (a durable `PendingPrincipalDecision` receipt on deferral, correlated to the ruling), the attester-match seam (`[security.attesters]`: a wrong-principal attester is rejected/fails closed, a matching attester resumes to the sink, the default `none` is accepted-but-unverified), the inline margin `floor`, and Endorsed ledger records. Margin-floor runtime faults and pending-decision adapter visibility are `runtime-suite`. |
| 14 Trusted kernel/invariants | covered | Bypass matrix is represented across gates, memory store/recall, the ledger query, tools, prompts, and config tests: no construct launders taint, invents authority, skips endorsement, or writes through an unsettled sink. |
| 15 Formal semantics | covered | EBNF surfaces, selected T-rules, W-rules, error categories, replay directives, and conformance harness directives. Stochastic theorems are `runtime-suite`. |
| 15.5 Reproducibility | covered | Compiler suite pins replay directives and ledgered pure `decide`; runtime adapter tests cover replay, no oracle reinvocation, multi-run observational-equivalence/stability checks, and exactly-once idempotency. |
| 15.5.6 Conformal | covered | File-level and per-gate conformal declarations, cold abstain/defer surfaces, and config-aware fallback tests. Statistical coverage is `runtime-suite`. |
| 16 Runtime | runtime-suite | Covered by TypeScript runtime adapter tests for scheduler, ledger, seam protocol, replay, faults, memory, projections, calibration, and API surfaces. |
| 16.7 Memory runtime | runtime-suite | Compiler tests cover memory surface and trust. Runtime adapter tests cover mandatory envelope, artifact ingestion, idempotency, provenance, learning loop, and no memory-to-action laundering. |
| 16.8 Calibration | runtime-suite | Runtime adapter tests cover logprob capability derivation, sampling fallback, warm conformal profiles, and profile staling. |
| 16.9 Runtime API | runtime-suite | Runtime adapter tests cover `health`, `run`, `check`, `ledger.read`, `agent.respond`, memory operations, config restrictions, replay, and adapter-required test-mode hooks. |
| 17 Configuration | covered | Manifest binding errors, connector fallback fixtures, decision-rules-not-in-manifest, and dependency binding requirements. Config precedence execution is `runtime-suite`. |
| 18 Deployment | out-of-scope | Deployment packaging/reporting is not compiler behavior. |

Current language suite index: `211` tests (`132` accept, `79` reject).
