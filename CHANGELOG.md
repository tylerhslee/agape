# Changelog

All notable changes to Agape are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project follows
[Semantic Versioning](https://semver.org). The language/runtime, the conformance
suite, and the studio move in lockstep — a release is the whole bundle at one
version.

## [1.0.0-alpha.2026.7.11.3] - 2026-07-11

Studio cost-inspection alpha. Every Studio run now carries an explicit estimated cost surface beside ledger latency and provider metadata.

### Added

- Studio run responses include an estimated-cost object derived from Resolved ledger prompts/replies, with provider call count, estimated input/output tokens, model, and basis text.
- Studio verdict strips and inspection panels show estimated cost for completed and attestation-paused runs.

### Verified

- TypeScript runtime typecheck, version check, unit suite (84), and packaged node-linux-x64 archive verification.

## [1.0.0-alpha.2026.7.11.2] - 2026-07-11

Pure-function alpha: the seam-free function marker is now `pure`, not `sync`, so the language no longer overloads a scheduling term for a taint/effect guarantee. Plus prompt-block dedent, so indented Markdown blocks read the way they nest.

### Changed

- Replaced the Agape source keyword `sync` with `pure` across the lexer, parser, checker diagnostics, spec, kernel notes, distribution docs, examples, and conformance labels. Unmarked functions remain async-capable by default; `pure` means no provider/world/principal/memory-recall seam reach and only calls to other `pure` functions.
- Clarified SPEC Axis A as function reachability rather than scheduler behavior. `pure` is a seam-freedom claim; runtimes may still meter or cooperatively schedule local work.

### Added

- Prompt blocks dedent: the common leading whitespace of all non-blank lines is stripped
  (Java-text-block style), so `prompt { ... }` content can be indented with the surrounding
  source without pushing indentation into the rendered prompt. Indentation-based Markdown code
  blocks are consequently not expressible in a prompt block — use ``` fences. Column-0 blocks
  are byte-identical to before.
- `examples/predictive_recursion.ag`: a bounded recursive predictive observer that updates an internal `WorldModel` field until prediction error is below a hard-coded threshold or fuel is exhausted.
- Kernel regression coverage proving bounded `pure` recursion runs and updates an agent field, and pinning prompt-block dedent (nested relative indent survives).

### Fixed

- Agent field slots are initialized at spawn and identifier assignment now updates an existing agent field instead of shadowing it with a local binding.
- The bounded-pure-recursion kernel test: its Agape source used unescaped `${…}` inside a JS
  template literal (evaluated by JS before Agape saw it), and expected qualified enum rendering
  (`FitStatus.Settled`) where f-string interpolation renders the bare variant (`Settled`,
  `render()` — the same convention as ledger payloads).

### Verified

- TypeScript runtime typecheck, version check, unit suite (84) + certification suite (3), and
  packaged `node-linux-x64` archive verification.
- Direct run of `examples/predictive_recursion.ag` on the mock provider: the model settled with error `0.0390625` under the `0.05` threshold.

## [1.0.0-alpha.2026.7.11.1] - 2026-07-11

The memory layer owns memory-text policy. Follow-up to 7.11.0's reflective memory: the
recollection-rendering that lived in the interpreter moves into the memory runtime, episodes
arrive structured instead of pre-rendered, and reflection prose keeps facts attributed to the
right person.

### Changed

- `MemoryWriteRequest` gains a structured `episode` field (`act: "store" | "provider_reply"`,
  plus the asking prompt for replies). The interpreter passes the episode; it no longer composes
  memory prose. This replaces 7.11.0's `episode_prompt` metadata side-channel, which is removed.
- The deterministic recollection templates ("I stored … I learned …") moved from `interp.ts` into
  the memory runtime as `renderStoreRecollection` / `renderReplyRecollection` /
  `compactMemoryText` — one owner for memory-text policy, and the `STOP_WORDS` blacklist stops
  being the only thing standing between the template and recall ranking.
- Receipts carry the stored text (`receipt.memory`, including what was considered on
  skipped/deduped writes), and `Internalized` ledger payloads read it back — with reflection on,
  the ledger records the prose actually stored, not a template describing something else.
- The reflection prompt attributes facts to the right person: things the user states about
  themselves are stored as facts about the user ("Tyler's favorite tea is jasmine."), never
  first-person claims by the agent.
- Reflect-off behavior is byte-identical (templates moved verbatim; pinned by the certification
  golden traces).

### Verified

- TypeScript runtime typecheck, version check, unit suite (82) + certification suite (3), and
  packaged `node-linux-x64` archive verification, plus a live provider run against the LeeHaRin
  dogfood project.

## [1.0.0-alpha.2026.7.11.0] - 2026-07-11

Reflective memory alpha: the first dogfood-driven memory-runtime feature, from the LeeHaRin
assistant. Storing raw episode transcripts and recalling them verbatim turned an agent's memory
into a style feedback loop — it imitated its own prior replies. The fix is the runtime owning
reflection at write time, as §16.7's decomposition promises.

### Added

- `[memory] reflect = true`: provider-assisted reflection in the memory runtime. Before a cell is
  stored, the provider rewrites the raw episode as a short first-person prose memory (concrete
  facts, preferences, and instructions kept; greetings, filler, and formatting noise dropped;
  standing user instructions restated imperatively). Opt-in, default off — offline/mock runs are
  unchanged.
- The memory runtime now takes the session's provider handle (`createMemoryDriver(manifest,
  { cwd, provider })`), so reflection runs behind the same provider seam as every other cognition
  call. Without a handle the write path is purely lexical, as before.
- Receipts record the reflection outcome (`reflected` / `empty_fallback_raw` /
  `failed_fallback_raw`), carry the stored prose in `refs.stored_memory`, and keep the raw
  episode's canonical hash (`reflected_from_hash`) so the rewrite never hides provenance. Provider
  failure falls back to storing the raw episode — memory is never dropped by a failed reflection.
- Classification/tagging runs on the reflected prose (what recall will actually see), while write
  judgment and dedupe run on the raw episode before any cognition is spent.
- Reflection reads the RAW episode, not the interpreter's recollection template: the driver
  reconstructs it from the rendered value + memory scope, and provider replies forward the asking
  prompt as `episode_prompt` metadata (consumed by the runtime, never written to the substrate —
  reflect-off disk output stays byte-identical). No storage scaffolding leaks into the prose.
- `memory_reflection.test.ts`: reflection on/off/failure/no-provider/classification coverage, plus
  episode framing (store and provider-reply) and `episode_prompt` consumption.
- Quote-free Markdown prompt blocks: `prompt { ... ${expr} ... }`, with plain `{...}` preserved as literal Markdown/JSON text.
- `md "path.md"` text imports for attaching Markdown prompt material from project files.

### Changed

- F-string interpolation now uses `${expr}` consistently with prompt blocks; examples and tests were migrated from the old `{expr}` form.

### Fixed

- Markdown imports enter the runtime as `raw` / `external_unscreened`, so interpolating external Markdown into provider prompts triggers the existing ingress warning/deny policy instead of laundering the file as settled source text.
- The bundled `bin/agape` wrapper now resolves symlinks before locating its install root, and package verification checks the PATH-link shape from an unrelated working directory.

### Verified

- TypeScript runtime typecheck, version check, unit suite, and packaged `node-linux-x64` archive verification.


## [1.0.0-alpha.2026.7.10.0] - 2026-07-10

Beta-readiness alpha on top of the TypeScript markdown-memory runtime release.

### Added

- Core Agape testkit for asserting ledger events, decisions, endorsements, memory writes, tool calls, prompt inputs, and golden traces.
- Certification tests for the typed gate chain, project-root markdown memory, and built-in HTTP tool bindings.
- Dogfood smoke runner for `league-analyzer`, `agape-fact-checker`, and `agape-soma`.
- `BETA.md` compatibility contract covering `agape.toml`, markdown memory layout, tool bindings, runtime receipts, Studio/project behavior, and Soma deployment.


### Verified

- TypeScript runtime typecheck and unit suite.
- Soma v0.3.0 `agape-app` deployment contract for persistent project-root markdown memory shared by app and Studio.

## [1.0.0-alpha.2026.7.5.0] — 2026-07-05

Concurrent subagent delegation, done right: `|>` fan-out to workers now runs their tasks in
parallel (a runtime fix), and a new `spawn` expression makes a *dynamic* collection of distinct
workers expressible. Plus the external-ingress screening from the prior line. SPEC, conformance
suite (207 tests), and `agape-ts` move together.

### Language — the `spawn` expression: dynamic, distinct workers (§6/§15.4)

- **A second spawn form.** `Verifier v = spawn Verifier;` mints a **fresh** instance per
  evaluation, bound to a value — beside the existing `spawn Verifier v;`, which stays a **named
  singleton** (identity = the declared name, addressable by name). The expression form lets a
  delegating function be fanned out with `|>` over a runtime-sized collection and give **each path
  its own distinct worker** — which the static-name statement form cannot express.
- **Deterministic identity.** A spawned instance's name is derived from `(call-site, fan-out
  element index)`, never execution order, so `xs |> f` that spawns inside `f` replays
  byte-identically (§0.2). `awake`/`sleep` resolve an agent-ref variable, so `awake w` works for
  an expression-spawned worker.

### Runtime — concurrent task delivery (§6c, fixes T3/§0.2 for `|>`-of-delegation)

- **One worker can run many overlapping tasks.** The active assigned task was tracked in a slot
  keyed by agent *name* (nested-only, save/restore); concurrent handlers on one agent clobbered
  it, so `complete`/`fail` resolved the wrong task and it expired. It is now scoped to the async
  execution (`AsyncLocalStorage`), so `plan.claims |> (delegate to a shared worker)` completes
  every task concurrently. Determinism is unchanged — it comes from serialized ledger effects,
  not serialized execution — so the fan-out replays identically.
- New `06c_delegation` conformance cases pin both patterns (shared worker; distinct workers via
  the `spawn` expression), each asserting all-complete **and** replay-equivalence.

### Language — gate external ingress to provider prompts (§6b anti-injection, extends T3)

- **Un-screened external data may not drive cognition.** A value that entered the process
  from outside — a prompt-ingress payload (§5b) or a wired result-event payload (§6b) — is
  *ingress-tainted*; interpolating it into a `self <- …` provider prompt is gated. Flowing it
  in un-screened is a **deny** (or **warn**, per policy); a screened/endorsed value flows
  cleanly. This closes the reflection where an attacker-controlled observation could rewrite
  the agent's own instructions.
- **Runtime + checker.** `agape-ts` (`check.ts`, `interp.ts`, `config.ts`, `runtime.ts`) enforce
  the ingress→provider path; the manifest carries the screening policy. New conformance cases:
  `agent_prompt_ingress_to_provider_{deny,warn}`, `agent_prompt_screened_ingress_to_provider_ok`,
  `world_result_event_{ingress_to_provider_warn,screened_ingress_to_provider_ok}`.

## [1.0.0-alpha.2026.7.3.0] — 2026-07-03

Subagent delegation (§6c) and the wired world interface (§6b). Designs in
`design/delegation-and-actions.md` and `design/world-interface.md`; SPEC, conformance
suite (200 tests), and `agape-ts` move together.

### Language — the world interface: `tool` leaves the language (§6b)

- **Source speaks only `event` (inbound) and `action` (outbound).** The `tool`, `read`,
  `write` keywords, the `uses` binding, and the `use` grant class are removed; grants are
  exactly `perform` + `reach`. "Tool" survives only as the manifest's `[tools.*]` endpoint
  catalog; `[actions.NAME]`/`[events.NAME]` wire declared names to catalog entries
  (optionally naming the `result_event` a reply lands as). Unwired = pure record/performative.
- **Read vs write moves to which verb you wire.** An emit-wired event is the loose
  observation channel (emit is not a sink; the result event's payload JOINS the request's
  trust — no laundering). A perform is the gated channel: **settled args only, uniformly**
  — no un-endorsed cognition ever leaves the process (anti-exfiltration; T3 extends to
  observation requests). Every `perform` is async.
- **Foreground perform binding.** `text hits = perform Search("prior art") expires 5;` —
  the §6c delegation discipline applied to the world: mandatory expires, reply typed from
  the manifest-named result event, `ToolStarted`/`ToolResolved` demoted to the seam's
  replay journal beneath the named domain rows.


### Language — delegation is a send with a governed payload and a programmatic reply (§6c)

- **The task literal.** `T r = worker <- task { objective o; acceptance a; } expires ttl;`
  builds a `TaskSpec` and sends it. `objective`/`acceptance` are required `text`; `expires`
  is **mandatory** (every task is terminal by construction); trust is the join of the fields —
  delegation never launders trust.
- **Two bindings, no keyword.** Result-bound = foreground (the continuation waits; a failed/
  expired/cancelled task faults the awaiting invocation via the contained-crash path).
  `Task<T>`-bound = background (a settled handle for `when (… about h)` and `cancel h;`).
  Bare statement-form delegation is a compile error.
- **Worker verbs and hooks.** `complete r;` / `fail reason;` resolve the assigned task
  programmatically (task handlers only); `on assigned` / `on cancelled` are `when` sugar.
  The active task composes into provider context after `instruction` blocks, **as data**.
- **Cooperative cancel.** `cancel h;` appends the authoritative `TaskCancelled` tombstone; a
  late `complete`/`fail` is refused (`CompletionRefused`), mirroring `DeliveryRefused`.
- **Lean ledger.** `TaskSubmitted`/`TaskAssigned`/`TaskExpired` are subscription **aliases**
  over `Sent`/`Delivered`/`Expired` (no rows); real events are `TaskCompleted`, `TaskFailed`,
  `TaskCancelled`, `TaskProgress`; unified task status is a ledger projection.
- **Authority = static grant ∧ endorsed-task enablement.** A scoped task
  (`scope { perform X }`) must be sent as `Endorsement<TaskSpec>` and can only attenuate the
  delegator's own authority; the sink check (`TaskScopeViolation`) sits beside the margin
  floor. §14's never-widened invariant and T1 are unchanged.

### Language — the single door (§6b, superseded within this release by the world interface above)

- **Write tools are declared, not callable.** A direct write-tool call is a `TypeError`;
  `action NAME(fields) uses TOOL;` binds a performative to at most one write tool and
  `perform` becomes the only source syntax that executes one. `use` grants naming a write
  tool are illegal. Unbound actions remain legal (pure ledgered performatives). Source binds
  action→tool; config still binds tool→endpoint.
- `expires` now takes any settled numeric expression (was: numeric literal).

## [1.0.0-alpha.2026.6.30.0] — 2026-06-30

A spec-led release that finalizes the decision-gate model and folds the runtime
contract into the language specification. The whole bundle is version-tagged at
`1.0.0-alpha.2026.6.30.0` per the lockstep convention, but the deliverable is the
`SPEC.md` document: the conformance suite and the `agape-rs` runtime carry the new
version yet are **not yet conformance-aligned** to the finalized gate model
(tracked as follow-up work in `agape-conformance/AUDIT.md`).

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
