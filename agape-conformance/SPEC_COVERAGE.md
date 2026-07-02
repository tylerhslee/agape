# SPEC Coverage Matrix

Target: `SPEC.md` `v1.0.0-alpha.2026.6.30.0`.

Scope of this matrix: compiler/language conformance only. Runtime-only obligations in sections 16/17/18 are marked `runtime-suite` because they cannot be proven by feeding `.ag` source to a compiler. They belong in the TypeScript runtime conformance suite and adapters.

Status meanings:

- `covered`: compiler-visible behavior has direct accept/reject and, where needed, manifest/schema assertions.
- `runtime-suite`: not a compiler obligation; covered by runtime adapter tests.
- `out-of-scope`: explanatory/deployment prose with no compiler-visible behavior.

| SPEC section | Compiler status | Coverage basis |
|---|---|---|
| 0 Scope and layering | covered | Trusted-kernel path and static/dynamic separation are covered through authority, taint, gate, module, and replay-header tests. Runtime execution model is `runtime-suite`. |
| 1 Orthogonal axes | covered | Axis tests cover sync/async, trust tiers, ledger presence, and independence of the axes. |
| 2 Lexical structure | covered | Comments, keywords, strings, f-strings, operators, missing semicolons, unknown operators, invalid numeric forms, and unsupported escaped f-string braces. |
| 3 Types | covered | Scalars, arrays, structs, enums, events/actions, `Credence`, `Decision`, `Endorsement`, `Rule` non-storage, declared dependencies, exact payload arity/types. |
| 4 Functions/color | covered | Sync restrictions, dependency reaches, tool/memory reaches, in-hand gate operations, and trust flow through helper calls. |
| 5 Agents/lifecycle | covered | Spawn/awake/sleep/crash, `extend`, hooks, instruction blocks, prompts, and agent construction/resume rules. Runtime persistence/generation is `runtime-suite`. |
| 5b Prompt | covered | Prompt declaration, prompt-origin settled input at sinks, and missing prompt config. Long-running source behavior is `runtime-suite`. |
| 6 Communication | covered | Send lifecycle, typed replies, self-send, expiry, lost sends, late delivery refusal, and reach grants. Illegal host-forged traces are `runtime-suite`. |
| 6b Tools | covered | Read/write tools, effect-class requirement, use grants, settled write inputs, tainted write inputs, and reversible tool syntax. Replay non-invocation is `runtime-suite`. |
| 7 Ledger/events/when | covered | Event emission, exact spine assertions, event order, prospective `when`, guards, `about`, query-result events, and tool event pairs. Canonical hashing is `runtime-suite`. |
| 8 Semantic checking | covered | Provider-produced `Credence`, closed enums, entailment, schema-violation TypeMismatch, and exact schema assertions for enum/struct/array outputs. |
| 9 Prelude | covered | Built-in events, Error subtyping, user Error leaves, Contradiction catching, Expired non-Error behavior, and `say` non-ledger behavior. |
| 10 Memory surface | covered | `store`, `embed`, `mem`, recall, forget/tombstone, select/find/match, origin projection, no ledger recall, match-hit taint, recall taint, and query expression/statement distinction. Memory envelope internals are `runtime-suite`. |
| 11 Control flow | covered | `if`, gate arms, abstain, exhaustiveness, ungated Credence rejection, bounded retry, retry exhaustion, and unbounded retry rejection. |
| 12 Aggregation/quorum | covered | `all`, `any`, `quorum`, bool reductions, total dependence coverage, mixed independent/dependent clusters, partial-coverage rejection, and pipe syntax. Runtime fan-out scheduling is `runtime-suite`. |
| 13 Capabilities/governance | covered | Default-deny grants, subtractive extend, reach/use/perform authority, taint at sinks, subject endorsement, subject-scope rejection, arm narrowing, abstain non-narrowing, principal decisions, failed principal decisions, gate arm validity, and Endorsed ledger records. Margin-floor runtime faults are `runtime-suite`. |
| 14 Trusted kernel/invariants | covered | Bypass matrix is represented across modules, generics, interfaces, gates, memory, tools, prompts, packages, and config tests. |
| 15 Formal semantics | covered | EBNF surfaces, selected T-rules, W-rules, error categories, replay directives, and conformance harness directives. Stochastic theorems are `runtime-suite`. |
| 15.5 Reproducibility | covered | Compiler suite pins replay directives and pure off-ledger `decide`; runtime adapter tests cover replay, no oracle reinvocation, multi-run observational-equivalence/stability checks, and exactly-once idempotency. |
| 15.5.6 Conformal | covered | Source-level conformal declarations, per-gate conformal rules, cold abstain/fallback surfaces, and config-aware fallback tests. Statistical coverage is `runtime-suite`. |
| 16 Runtime | runtime-suite | Covered by TypeScript runtime adapter tests for scheduler, ledger, seam protocol, replay, faults, memory, projections, calibration, and API surfaces. |
| 16.7 Memory runtime | runtime-suite | Compiler tests cover memory surface and trust. Runtime adapter tests cover mandatory envelope, artifact ingestion, idempotency, provenance, learning loop, and no memory-to-action laundering. |
| 16.8 Calibration | runtime-suite | Runtime adapter tests cover logprob capability derivation, sampling fallback, warm conformal profiles, and profile staling. |
| 16.9 Runtime API | runtime-suite | Runtime adapter tests cover `health`, `run`, `check`, `ledger.read`, `agent.respond`, memory operations, config restrictions, replay, and adapter-required test-mode hooks. |
| 17 Configuration | covered | Manifest binding errors, connector fallback fixtures, decision-policy-not-in-manifest, and dependency binding requirements. Config precedence execution is `runtime-suite`. |
| 18 Deployment | out-of-scope | Deployment packaging/reporting is not compiler behavior. |
| 19 Library layer | covered | Modules, imports, aliases, selective imports, cycles, ambiguity, package path dependencies, re-export forms, visibility, shallow public surfaces, generics, interfaces, and Error subtyping. |
| 20 Gate ergonomics | covered | Reversible sinks, cold/defer surfaces, conformal defaults/overrides, endorsement arms, escalation syntax, static checks, introspection, read-only fields, and subject field collision behavior. Warm conformal/profile execution is `runtime-suite`; mature expected-loss calibration remains adapter-covered by the generic calibrated-profile contract. |

Current language suite index: `229` tests (`134` accept, `95` reject).
