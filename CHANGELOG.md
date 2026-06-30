# Changelog

All notable changes to Agape are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project follows
[Semantic Versioning](https://semver.org). The language/runtime, the conformance
suite, and the studio move in lockstep — a release is the whole bundle at one
version.

## [1.0.0-alpha.2026.6.30.0] — 2026-06-30

A spec-only release that finalizes the decision-gate model and folds the runtime
contract into the language specification. The `SPEC.md` document is the deliverable;
the conformance suite and the `agape-rs` runtime are **not yet re-aligned** to this
spec (tracked as follow-up work) and remain at the previous alpha for now.

### Language — the decision gate, redesigned

- **The kernel is the dot-form.** `decide c by r` yields a `Decision<E>` with read-only
  `.committed` (a variant of `E`, or the new `abstained` sentinel), `.basis`, and `.margin`.
  `endorse s by d` yields an `Endorsement<T>` — the *settled subject* itself: it coerces to
  `T` at a sink, exposes `T`'s fields, carries the gate metadata, and adds an `e.subject : T`
  accessor.
- **The rule is always present; the principal is a prefix.** A gate is `decide c by r` (rule
  only) or `p decide c by r` (an escalation prefix — the identity dependency is consulted only
  when the rule cannot commit, and the human reply arrives as a variant). The old
  `decide c by <principal>` basis is removed.
- **Arms are sugar.** A `decide`/`endorse` arm block desugars to a binding plus `if` on
  `.committed`; `case` is removed. `if`/`==` over settled values (including `.committed`) is the
  deterministic branch primitive; arms are the cognition-verdict primitive.
- **Safety, restated.** "An abstained/un-committed decision cannot reach a sink" is now a static
  property via flow-sensitive committed-narrowing; the one runtime sink check is the margin floor
  (`MarginFloorViolation`).

### Specification

- **Runtime spec merged.** The former standalone `RUNTIME_SPEC.md` is now §16 (The runtime) and
  §17 (Configuration) of `SPEC.md`: runtime identity/isolation, the mandatory memory envelope,
  knowledge-artifact internalization, learning-from-experience, the runtime API surface, and
  release lockstep. `RUNTIME_SPEC.md` survives only as a redirect.
- **Grammar completed.** Defined previously-missing productions (`block`, `args`, `armhead`,
  lexical terminals) and removed ambiguities, so a front-end can be built from §15.2 alone.
- **Verified.** Two adversarial verification passes over the whole document (90 findings, then 8)
  were applied; the result is internally consistent and implementable, with 0 critical issues
  remaining.

## [1.0.0-alpha.2026.6.29.0] — 2026-06-29

This release resets Agape's public version line to an explicit alpha. Earlier
`v1.0.x` tags were prototype tags and are superseded by this canonical alpha
series.

This release dogfoods Agape Studio against the Agape trust model and sharpens the
gate surface that Studio needs for natural agent conversations. The big language
change is making the trust path smaller and more explicit: `decide` creates sealed
decisions, and `endorse` applies those decisions to exact subject values.

### Language & runtime
- Made `decide c by basis` the only source-level constructor for sealed
  `Decision<E>` values. The old bare collapse form `c by R` is no longer the
  canonical gate surface.
- Reworked `endorse` into subject-scoped arm syntax:
  `endorse subject by d { Variant as e { ... } }`. The arm binder `e` is an
  `Endorsement<T>` about the exact subject value, and only that subject is settled
  inside the matching arm.
- Removed `certify` as a separate source form. Artifact certification is ordinary
  endorsement of an artifact subject by a `Decision<Verification>`.
- Removed `attest` as a separate source form. Human/accountable review is expressed
  as `Decision<E> d = decide c by principal;`, with principal signature recorded in
  `PrincipalDecision` provenance.
- Added subject/dependency-scope checking for endorsement: a decision can endorse
  only values inside the `Credence` provenance scope it decided. This catches
  mechanically irrelevant endorsements such as using a decision about `other_response`
  to endorse `response`.
- Clarified the spec's trust path as
  `Credence<E> -> Decision<E> -> Endorsement<T> -> granted sink -> ledger`.
- Reframed `Credence<E>` as a scored structured judgment rather than an inherently
  calibrated probability, and moved empirical autonomy into ledgered GateProfiles:
  cold gates defer, warm gates use conformal singleton commitment, and mature
  gates may use calibrated expected-loss decisions.
- Added spec semantics for versioned projections and stale-state management:
  materialized facts/views carry `basisHead`, `validThrough`, provenance, and
  dependency scope so unrelated ledger events do not globally invalidate state.
- Added a generic conflict model over declared invariants and active settled
  facts, keeping domain-specific and natural-language contradiction detection as
  Agape programs/libraries rather than hidden kernel magic.

### Conformance
- Marked the older `certify`, `attest`, `c by R`, and `endorse(c by R)` fixtures as
  obsolete for the next conformance pass.
- The next conformance target is coverage for sealed `decide`, subject-scoped
  `endorse`, principal-driven decisions, branch-scoped `Endorsement<T>`, and
  rejection of endorsements whose subject is outside the decision dependency scope.

### Studio
- Reworked the Studio agent response path so badge selection, especially
  `Inspect`, is orchestration input rather than cosmetic UI state.
- Auto-delegated the initial dashboard prompt to a builder instead of forcing the
  user to open the work item and delegate manually.
- Added response routing that decomposes a prompt, gathers project and memory
  context, rejects placeholder planning text, and returns a user-facing answer
  rather than a raw first-step thought.
- Added provider/agent-server tests around conversational response quality and
  project inspection behavior.
- Renamed visible Studio “spine” language to “ledger” to match the language spec.

### Packaging
- Updated the alpha bundle pipeline so the packaged archive includes the updated
  spec, Rust runtime, conformance suite, Studio server, and built Studio web app
  together.

## Pre-alpha Prototype History

The entries below describe the superseded `v1.0.0` through `v1.0.2` prototype
tags. They remain here as engineering history, not as the canonical release line.

### Prototype 1.0.2 — 2026-06-28

This release hardens Agape's trusted kernel contract. It keeps the v1 surface
intact, but makes the core safety boundary explicit: model testimony may affect
the world only through `Credence -> Decision -> recorded endorsement -> granted
sink -> ledger`.

### Language & runtime
- Defined the trusted kernel in the specification: `Credence`, `Decision`,
  recorded gates (`endorse`/`attest`), the taint lattice, default-deny grants,
  consequential sink checks, and ledger record/replay.
- Made fail-closed behavior normative at kernel boundaries: unknown type, trust,
  endorsement, tool effect, grant, or replay standing must reject rather than
  infer authority.
- Clarified that library features, interfaces, memory/query sugar, and readable
  `decide` must erase statically or desugar into the trusted kernel.
- Tightened checker behavior so unknown interfaces and unknown struct literals
  reject instead of being silently tolerated.
- Fixed qualified/re-exported struct literal resolution so legitimate module
  facades and path-package imports remain accepted under the stricter checker.

### Conformance
- Reframed conformance as kernel-bypass resistance: new surface features should
  include negative tests proving they cannot launder taint, invent authority,
  skip endorsement, bypass write-tool settling, or evade replay.
- Added the trusted-kernel bypass matrix as an explicit remaining coverage item.
- Confirmed the reference implementation passes the full **197/197** test suite
  after the stricter checker changes.

### Deployment
- Clarified that Agape is not limited to an app-server role: the same trusted
  kernel can be the cloud control plane, service-fabric, or OS/runtime boundary
  mediating process, storage, network, and tool effects through grants, gates,
  and ledger replay.

### Prototype 1.0.1 — 2026-06-28

This prototype tightened Agape's spec/runtime/conformance lockstep and re-tagged
`v1.0.1` as the then-current mainline patch release. It kept the v1 surface intact
while making the conformance suite much harder to accidentally drift from the
spec.

### Language & runtime
- Added strict multi-field invocation for declared events and actions:
  `emit E(a, b)` and `perform A(a, b)` now match declared fields positionally,
  with exact arity and per-field type checks.
- Preserved declared field names in ledger payload rendering for multi-field
  event/action records, improving audit readability without changing the ledger
  event shape.
- Fixed event handler binding so declared event fields can be accessed
  consistently in handlers, including the scaffolded Q&A example's `Draft.answer`
  path.
- Bumped the reference implementation and spec labels to the then-current prototype tag.

### Conformance
- Expanded the conformance suite from **144** tests in `v1.0.0` to **197** tests.
- Added first-class coverage for multi-field event/action payloads: accepted
  calls, arity rejection, and positional type rejection.
- Added lockstep coverage for previously under-tested spec surfaces, including
  malformed f-strings, unknown operators, undeclared `perform`, struct extra
  fields, sync memory seams, late `DeliveryRefused`, exact ledger spines,
  schema violations, memory tombstones/internalization, expression queries,
  aggregation dependence, attestation ledger events, config binding failures,
  package path dependencies, private visibility checks, non-generic typeargs,
  interface outcome mismatch, and readable-gate cold/tie/read-only behavior.
- Added `agape-conformance/COVERAGE.md` as the audit map for remaining
  spec-to-suite gaps.

### Docs & examples
- Replaced the README's small refund sketch with a more representative support
  workflow: prompt input, typed classification, policy endorsement, safe replies,
  and a consequential credit action gated before money moves.
- Added `agape-rs/examples/support-desk.ag` as the checked-in runnable version of
  that README sample.
- Updated the spec grammar/prose to clarify that event/action declaration fields
  are invoked positionally and checked strictly.

### Studio & CI
- Fixed the default scaffolded project so the Studio backend and browser E2E
  tests deliver the verified answer under the stricter type rules.
- Hardened Studio bundle smoke testing with an ephemeral port and binary lookup
  fallback, so CI exercises the shipped path more reliably.
- Restored the Studio CI path to green: language build/test/conformance,
  manifest drift, Studio backend, Studio web, bundle smoke, and Playwright E2E
  all pass for the prototype commit.

### Prototype 1.0.0 — 2026-06-27

The first canonical release: the Agape language, compiler, runtime, and studio,
packaged as one self-contained `agape` CLI. Agape governs multi-agent systems —
model output is *testimony* with no authority until a calibrated gate endorses it,
and every effect is recorded on an append-only **ledger**.

### Language & runtime
- A clean-room Rust implementation (lexer → parser → checker → interpreter + the
  event **ledger**) passing the full conformance suite — **144/144**, a hard CI gate.
- **The decision surface** — testimony → `Credence<E>` (a graded judgment over a
  closed enum, read from provider score/logprob data or sampling fallback) → a gate (`endorse` /
  `attest` / the readable `decide`, by `c by R` / `conformal α`) → a settled
  `Decision` that alone may drive a `perform` action. Static checks reject
  unauthorized authority, un-endorsed (tainted) values at consequential sinks, and
  ill-typed gates before anything runs.
- **The ledger** — a hash-chained, append-only, tamper-evident event log (the
  objective shared record of what happened), queried deterministically by
  `select … from ledger` and `find … where`. A deterministic scheduler/tick
  cascade, plus injectable seams (cognition / memory / ledger) for test-mode,
  replay, and fault injection.

### Library layer (§19)
- **Modules & imports** — `module path;`; `import m;` / `import m as x;` /
  `import { a, b } from m;`; `pub import` re-export; packages via `[package]` /
  `[dependencies]` in `agape.toml`.
- **Namespacing & visibility** — fully-qualified event types; `pub` (default
  module-private) governs *names, not the ledger* (a private event still lands on
  the ledger for audit; `pub` is shallow).
- **Generics & interfaces** — type parameters on `struct`/`fn`, monomorphized;
  `interface I { when EVENT decide RESULT; requires CAP }` with nominal conformance
  (an implementor is a subtype); single-level **error subtyping** (`event Foo(..) : Error;`).

### The readable decision gate (§20)
- A surface where intent plus one fact about stakes derives and enforces the
  decision theory: `reversible` marks a consequential sink; `decide { … }` carries
  commit / `default:` / `defer` arms with a principal for the contested case; one
  `conformal α` dial sets the error guarantee (file, per-gate, or manifest scope).
  A non-reversible arm with no reachable principal is a **compile error**. It
  desugars to the `endorse` / `c by R` engine, which remains for hand-calibration.

### Compile-time behavior (§5) and private memory (§10)
- **`instruction "…";`** — a compile-time system prompt: global at the top level, or
  agent-scoped (composing after the global block). Procedural behavior lives in
  *source*, versioned and reviewable — no recalled fact or injected memory can
  rewrite it; to change behavior, ship a new version.
- **`mem` private memory** — `mem m <- v` writes a handle, `m -> "q"` recalls,
  `forget m` is an audit-preserving tombstone. A recall is **always tainted**
  (taint-equivalent to a send reply): memory cannot launder trust, so a recalled
  value must be re-gated before it reaches a consequential sink. The ledger, by
  contrast, is the objective record and reads back at recorded trust.

### Gate providers (§17)
- Pluggable LLM backends for the gate's `Credence`: **OpenAI** and **Gemini** read
  per-variant mass from token **logprobs** (OpenAI Chat-Completions `top_logprobs`,
  Gemini enum-mode `responseLogprobs`); **Anthropic** exposes no logprobs and is
  served by the **sampling fallback** (draw the forced choice N times, take the
  empirical frequency). `exposes_logprobs` is **derived from the backend**, not
  hand-set; API secrets bind from the environment, never the manifest.

### CLI & studio
- `agape init` / `run` (`--prompt` / `--claude` / `--samples` / `--temperature` /
  `--json`) / `check` (static guarantees only) / `build` / `configure` / `studio`.
  The mock provider ships in-box, so `run` works offline with no API key; a live
  model is one `configure` step away.
- A project-aware IDE: inspect, edit, and run a project's agents, with a question →
  verified-answer view over the ledger; offline on the deterministic mock provider
  or against a live model. One-process bundle mode (the agent-server serves the
  prebuilt web app — no Vite at runtime).

### Packaging & CI
- `scripts/package.sh` builds a portable, self-contained bundle (binary + studio +
  a runnable example + default `agape.toml`), archived with a SHA-256 sidecar and
  verified by running the *shipped* binary with no repo present.
- `ci.yml` builds and tests the language and gates on conformance (**144/144**) and
  manifest drift; `release.yml` builds the bundle for Linux, macOS, and Windows on a
  `v1.0.0` tag and publishes a GitHub Release.

[1.0.0-alpha.2026.6.30.0]: https://github.com/tylerhslee/agape/releases/tag/v1.0.0-alpha.2026.6.30.0
[1.0.0-alpha.2026.6.29.0]: https://github.com/tylerhslee/agape/releases/tag/v1.0.0-alpha.2026.6.29.0
