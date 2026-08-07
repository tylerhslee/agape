# Changelog

All notable changes to Agape are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project follows
[Semantic Versioning](https://semver.org). The language/runtime, the conformance
suite, and the studio move in lockstep — a release is the whole bundle at one
version.

## [Unreleased]

### Changed

- **Agent semantics are lifecycle- and authority-defined.** Agents are addressable
  source-defined entities; learning is an advertised adaptation capability.
- **Runtime memory is configured and explicitly accessed.** Every runtime session
  receives a memory driver, while source and host operations control every memory
  consultation, write, and forget.
  Provider replies and adapter `agent.respond` turns no longer create or consult
  hidden memory.
- **Recalled experience preserves typed outcomes and provenance.** Explicitly
  stored successful examples and rejected counterexamples retain their typed value
  summaries and origin metadata across Local and Markdown drivers; recall remains
- **Memory receipts are private and truthful.** Public ledger rows expose hashes,
  resolvable driver references, and actual cell/view deltas without memory plaintext
  or fabricated fact, graph, vector, or blob effects.
  tainted and requires a fresh gate before consequential use.
- **Calibration evidence is profile-scoped.** Core gates record truthful methods and
  scores; the Studio Fact Checker profile preserves raw-logprob evidence and exposes
  it through the authorized, non-enumerable `calibration.evidence.inspect` operation.

## [1.0.0-beta.2026.8.6.0] - 2026-08-06

This beta adds the compiler-grounded Agentic Flow builder to Agape Studio and
hardens the TypeScript fact-checker dogfood path. Studio can inspect the complete
compiler-emitted topology while safely rewriting supported `.ag` properties without
inventing execution edges or overwriting concurrent source changes.

### Added

- **Compiler-grounded Agentic Flow builder.** Studio combines editable,
  source-backed constructs with the compiler graph, exposes agents, functions,
  handlers, hooks, principals, prompts, gates, outputs, and validation context,
  and labels compiler-derived topology as read-only truth.
- **Safe property editing.** Literal model instructions, literal `say` templates,
  and confidence thresholds can be edited from the canvas while preserving exact
  interpolation tokens and rejecting unsupported or ill-typed changes.
- **Fact-checker navigation and coverage.** The canvas supports focus, filtering,
  and local drag layout. Public CI always exercises the repository-owned fact
  checker, while an explicit environment-controlled test covers the larger
  dogfood program's functions, handlers, hooks, principal, and compiler edges.

### Security

- **Fail-closed source saves.** Project paths remain confined to the attached
  project; optimistic revisions and a per-file FIFO prevent lost updates; a
  last-moment revision check catches external edits; every candidate is
  compiler-checked before atomic replacement and cleaned up on failure.
- **Audited dependency graph.** Shipped dependencies move to patched
  `protobufjs` 7.6.5, Monaco 0.56, and DOMPurify 3.4.12; the contributor
  toolchain moves to patched Vite 6.4.3 and Vitest 3.2.x while retaining the
  documented Node 20 compatibility. Production and full npm audits are clean
  across all four JavaScript packages.

### Validation

- **Studio flow coverage.** Backend safety/integration tests and web component
  tests exercise the new flow surface. The broader unchanged release gates also
  pass: production build, shipped-bundle smoke, packaged CLI verification, and
  the existing Playwright application journeys.

## [1.0.0-beta.2026.7.16.1] - 2026-07-16

Same-day patch over the second beta: concurrent §6c task delivery — overlapping worker execution with unchanged replay determinism, measured 2.78× on a 3-task workload.

### Changed

- **Background task delivery runs concurrently (§16.1/§16.3a), with replay determinism
  unchanged (§16.5).** A drain batch's background (handle-bound) deliveries now overlap their
  worker-side oracle calls — exactly as a `|>` fan-out overlaps its dependency calls (§12) —
  instead of the scheduler awaiting each delivery to completion in submission order. On a
  scripted 3-task workload with per-task latency injected, this lifts observed concurrency from
  ~0.8–0.9× (effectively sequential) to **~2.8×** (three provider calls simultaneously in
  flight). Determinism is achieved the same way as fan-out: a cooperative **turn scheduler**
  commits every ledger append in issue order (the append order is a function of the journal, not
  of wall-clock oracle timing), so a recorded run replays to the identical chain-head (T4, §16.5)
  with zero oracle re-invocation. The per-task receipt-chain invariants
  (`Sent → Delivered → Resolved → TaskCompleted`, first-terminal-wins) are unchanged; only the
  inter-task interleave — always a deterministic, journal-derived function of submission order —
  is now overlapped. SPEC §16.3a gains a normative **Concurrent delivery** clause and §16.1's
  asynchrony note now names concurrent background deliveries; the delegation runtime-contract
  suite (§16.3a) gains three tests: genuine overlap, concurrent record→replay chain-head
  equality under unequal latency, and per-task ordering preserved under the interleave.
- **The conformance harness journals structured-provider results in issue order (§16.5).** The
  scripted provider previously appended each structured reply to the replay journal at
  *resolution* time; under concurrent delivery with unequal latency a call could resolve out of
  issue order, so replay (which answers the i-th call in issue order) served a mismatched result
  and diverged. The harness now reserves each call's journal slot at invocation, filling it on
  resolution — restoring the §16.5 issue-order contract independent of wall-clock timing.

## [1.0.0-beta.2026.7.16.0] - 2026-07-16

The second beta hardens **recovery semantics**, lands the **attestation protocol**,
and closes the **delegation contract** coverage gap. Faults now surface where they
happen and stay contained: a schema-violating structured reply faults at the send
site, a provider connector error crashes unretried (distinct from a bad reply), the
bounded `retry N` recovery block returns to the core kernel, a fault inside a `when`
body is contained like any other handler crash, and every runtime fault carries an
informative message. The principal-attestation protocol becomes a durable,
attester-verified end-to-end path (deferral → durable pending decision → attested
ruling → resume). And the §6c delegation contract, previously proven only at the
language level, gains a dedicated runtime-contract test file. Owner ruling; SPEC-first
(spec → conformance → implementation).

### Changed

- **A schema-violating typed/structured reply faults AT the send (§8, §16.6).**
  Previously the runtime recorded a `TypeMismatch` and silently **null-filled**
  the typed binding, so the program crashed later at the first field access
  ("no field 'X' on null") with no way to guard. Now the send appends its
  `TypeMismatch` and **faults the reaction** — the same contained crash path as
  any runtime fault (`AgentCrashed`, recoverable via `on crash`). A null never
  enters a typed binding from a structured send. The §17.5 fault-injection path
  behaves identically. The typing rule is unchanged (T-Send still types to the
  reply type); a new operational rule `E-Send-TypeMismatch` states the fault.
- **A provider connector error CRASHES unretried, distinct from a schema-violating
  reply (§8, §16.4, §16.6).** The structured send path conflated two failures: any
  rejection of `provider.structured` — an HTTP 4xx, a network failure, a refusal (a
  **connector** error, a bad *request*) — was treated exactly like a schema-violating
  **reply**, appending a `TypeMismatch` and throwing a *retryable* error. So a
  `retry N` block re-asked the provider `N` times on a deterministic request-level
  rejection that could never succeed, then crashed with a misleading "did not match
  the declared type." Now a connector error is a **crash** (unretried, like an empty
  seam result) per §16.6's connector-error rule — the fault names the provider status
  and message; only a reply that comes back and cannot be parsed into the declared
  type stays a retryable `TypeMismatch`. The seam tags each outcome
  `connector | parse | raw` so the three cases are distinct. Relatedly, the
  type→schema generator is documented as **strict by construction** (§8): recursively
  `additionalProperties: false` with every field required on every object — the shape
  strict structured-decoding modes require.

### Added

- **`retry N` is back in the core kernel as the bounded recovery (§11).** A
  `{ … } retry(N)` block re-asks the provider on a `TypeMismatch`, re-running
  the block for at most `N` attempts; each attempt's `TypeMismatch` stays on the
  ledger for audit. On exhaustion it appends `RetryExhausted` and faults per the
  send-fault rule. It recovers **only** a `TypeMismatch` — an unrecoverable
  `empty` seam failure still crashes unretried. The core-kernel grammar
  (§15.2 EBNF) and the parser's `assertCore` gate admit it again; `RetryExhausted`
  is now a documented `Error` subtype (§9).
- **`RunOptions.onEvent` — a live ledger-append observer for embedding hosts
  (§17.7).** `createSession(program, { onEvent })` invokes the callback once per
  ledger append, in tick order, immediately after the event commits. It is a
  read-only sink (Studio timelines, a streaming fact-checker UI): it adds no
  authority and changes no semantics, and an exception it throws is contained so
  a faulty observer never corrupts the run.
- **The attestation protocol — deferral, a durable pending decision, and the
  attested ruling (§13, §16.4).** A principal-prefixed `p decide c by r` that
  cannot commit now **defers** by appending a durable
  `PendingPrincipalDecision { who, credence, corr }` receipt (its tick is the
  correlation id) *before* the ruling resolves it. Notification stays an ordinary
  §6b action (no `notify` keyword); the ruling arrives as an attested response
  correlated to `corr`; and the resulting `PrincipalDecision` /
  `FailedPrincipalDecision` references `corr`, so the whole defer→notify→ruling→
  resume path is on the ledger and replays deterministically. Every escalation is
  now ledger-auditable as a pending decision — the supervised cold start is
  explicit, not implicit. `PendingPrincipalDecision` is added to the prelude (§9).
- **The attester-identity seam — `[security.attesters.NAME]` (§13, §17.1, §17.7).**
  The runtime now verifies that the attester answering a `p decide` deferral **is**
  the principal `p`, via a per-principal authenticator. The default `none` (any
  principal with no table) takes the attester on trust and records the ruling
  marked `attester_verification = "unverified"` — the spec states plainly this is
  unverified, a local-dev posture. A bound authenticator (`driver = "host"` or an
  implementation-defined verifier) enforces the match: an attester that resolves to
  a **different** principal, or fails to verify, **rejects** the ruling —
  `FailedPrincipalDecision`, decision `abstained`, fail-closed. Hosts supply the
  verified identity via `createSession(program, { attesterVerifier })` (§17.7);
  it is journaled inside the ruling's attestation and replayed, never re-consulted.
- **Runtime-contract coverage for the §6c delegation dispatch (§16.3a).** Delegation
  was proven at the language level (`agape-conformance/06c_delegation`, 31 tests) but
  had no dedicated runtime-contract file exercising scheduler dispatch, `Task*`
  receipts/correlation, fault recovery, and replay. New
  `agape-runtime-conformance/tests/16_3a_task_dispatch.test.ts` adds **8** black-box
  tests: the full `Sent → Delivered → Resolved → TaskCompleted` receipt chain,
  background completion delivered to `when(TaskCompleted about h)`, a `TaskFailed`
  resting at the delivered prefix, a foreground terminal fault recovering via
  `on crash`, an endorsed completion settling a direct `perform`, a late completion
  after a tombstone becoming `CompletionRefused` (first terminal wins), an unendorsed
  task perform faulting with `TaskScopeViolation`, and a delegation trace replaying to
  an identical chain-head with zero oracle re-invocation. No adapter or kernel change.
- **Explicit provider API keys in agape-ts (`agape-ts/src/config.ts`).** The runtime
  secrets can now carry `openaiApiKey` / `anthropicApiKey` / `geminiApiKey` directly;
  each provider client is constructed with the explicit key when present, falling back
  to the environment (`GEMINI_API_KEY` / `GOOGLE_API_KEY` for Gemini) otherwise.

### Fixed

- **A fault raised inside a `when` reaction body is now CONTAINED (§16.6).**
  The reaction boundary says a `when`-body firing is a handler invocation just
  like `on awake` or a task handler, so an uncaught fault must be contained —
  `AgentCrashed` recorded, the `on crash` hook run, the agent surviving with
  state intact. `fireSubscriptions` did not catch `CrashError`, so a crash in a
  `when` reaction (e.g. a coordinator whose whole pipeline runs under
  `when (Prompt …)`, or a foreground delegation whose worker `fail`s) **escaped
  `run()` entirely**, bypassing the program's `on crash`. It is now contained on
  the same path as the awake-hook and task-handler crashes. Top-level `when`
  firings (no owning agent) abandon just that invocation.
- **Every runtime fault now carries an informative message; `AgentCrashed`
  records the reason (§16.6 observability).** Previously every `CrashError` /
  `TypeMismatchError` was constructed with **no message**, so a fault that
  reached an embedding host surfaced as an empty string. Each throw site now
  names what failed: a `TypeMismatch` names the **declared type** and the schema
  violation (owner ruling); a foreground-delegation fault names the task and the
  correlated `TaskFailed(reason)`; retry-exhaustion, margin-floor, task-scope,
  and empty-seam faults each state their cause. The contained-crash path records
  that reason on the `AgentCrashed` ledger row (additive payload), so the ledger
  — and any ledger view — names **why** an agent crashed.
- **A `return` outside tail position is now a static error instead of a silent
  no-op (§4).** The runtime (interp `callFn`) honors `return` only as the FINAL
  top-level statement of a function body; a `return` nested inside an `if`/gate
  arm/`retry`, a non-final top-level `return`, or a `return` in a non-function
  body (agent hook, `when`, constructor, top-level) was **silently ignored** —
  its expression not even evaluated, its value discarded — so an author who wrote
  an early `return` (e.g. a recursion base case inside an `if`) saw it eaten with
  no diagnostic. The checker now **rejects** any such `return` as a `TypeError`
  at check time (message: "`return` is only honored in tail position…"), so the
  trap fails loudly instead of misbehaving at runtime. SPEC §4 gains the
  tail-position-only clarification. This closes the footgun without adding
  early-return control flow: whether the kernel should grow real early-return
  semantics remains an **open design question deferred to the owner**. Existing
  programs already used the workaround pattern (assign a result variable in the
  branches, `return` it last), so no conformance program or example changed.
- **NUL-byte hygiene in `runtime_adapter`.** Two composite-key separators were
  embedded as raw `0x00` bytes, which made the file classify as **binary** and blocked
  text tooling (grep, diff, agent edits). They are now `\u0000` escapes; behavior is
  identical and the file is plain UTF-8 again.

## [1.0.0-beta.2026.7.14.1] - 2026-07-14

A packaging-only patch over the first beta. The Windows Release job failed in
`package.sh` self-verification; this release fixes the bundle so all three
platform artifacts build. No language, compiler, runtime, or studio semantics
change — the version bump keeps the lockstep surfaces aligned.

### Fixed

- **Windows bundle self-verify.** Under Git Bash / MSYS, `ln -s` copies the
  bash wrapper instead of linking it, so the copied wrapper resolved its own
  directory to the `linkbin` parent and node could not find
  `agape-ts/node_modules/tsx/dist/cli.mjs` (`MODULE_NOT_FOUND`). The
  PATH-install symlink check in `package.sh` is now guarded on a real symlink
  actually being created (`[ -h ]`), and skipped where the platform has no
  native symlink support.

### Added

- **Native `bin/agape.cmd` entry point** staged into the bundle for
  cmd/PowerShell users: it resolves its own `bin/` directory (`%~dp0`), invokes
  node with native Windows paths, and propagates the CLI exit code. The `.cmd`
  shim is verified end-to-end through `cmd.exe` on native Windows only
  (`uname`-gated to `MINGW*/MSYS*/CYGWIN*` so WSL interop `cmd.exe` never runs
  against a UNC path).

## [1.0.0-beta.2026.7.14.0] - 2026-07-14

The first beta: the surfaces documented in `BETA.md` now fall under the
compatibility promise. The language surfaces the compiler and suite already
enforce are specified, licensed, and packaged for a public beta, and the CI
that guards them is rebuilt around the TypeScript toolchain. No language
semantics change — this is a documentation, conformance-surface, tooling, and
packaging pass, with the runtime-contract kernel gaps closed.

### Added

- **`${expr}` interpolation lockstep restored.** The SPEC lexical lines, the
  conformance sources (43 tests migrated `{expr}` → `${expr}`), and the two
  lexical reject tests (now assert `LexError`) agree on the interpolation
  syntax again; the manifests, coverage docs, and `results.json` are regenerated
  at 207/207.
- **Static deny-mode prompt-ingress enforcement** in `check.ts`
  (`checkDenyModePromptIngress()`): a prompt-tainted value reaching a
  deny-mode provider seam is rejected at check time.
- **Beta compatibility surfaces specified in SPEC.** §16.7 defines the
  markdown memory substrate, §17.1 rewrites `[memory]` to the shipped keys and
  adds `[runtime]`/`[policy]` rows, and new §17.7 documents host embedding via
  `toolHandlers`. `BETA.md` now cites these sections.
- **Runtime-contract conformance adapter** for agape-ts
  (`runtime_adapter.ts`, `runtime_adapter_desugar.ts`,
  `runtime_adapter_memory.ts`) plus the `test:agape-ts` script: all 35
  black-box tests pass, and the CI adapter step blocks on any failure.
- **`MarginFloorViolation` enforced at the consequential sink** (§13/§16.6):
  the margin floor is checked where an endorsed value crosses into the world,
  not folded into `decide`, so a below-floor decision faults at the sink.
- **Warm split-conformal prediction sets** (§15.5.6): a warm gate emits a
  calibrated `prediction_set` from a split-conformal calibration pool;
  cold-start behavior (abstain) is unchanged.
- **Apache-2.0 `LICENSE`** at the repository root; the packaged bundle stages
  it alongside `SPEC.md` and the bundle `README`.
- **Beta-capable version checking**: `check-version.mjs` accepts
  `alpha`/`beta` pre-release tags and a `--root` flag; the studio smoke and
  E2E fixtures derive the version instead of pinning it.

### Changed

- **CI rebuilt around agape-ts.** `ci.yml` drops the deleted agape-rs job for
  an agape-ts gate (install → typecheck → test → conformance →
  runtime-contract), de-rusts the studio/E2E/release jobs, and vendors the
  syntax pack under `vendor/agape-syntax/` (consumed by `studio/web` via a
  `file:` dependency). The conformance runner (`run.mts`) now exits nonzero on
  any failure so the gate can catch drift.
- **Packaged-Studio launcher**: the `agape studio` CLI subcommand launches the
  staged Studio (agent-server + web-dist) with an `--inspector` fallback.
- Dependency versions pinned across `agape-ts` and the studio packages with
  consistent lockfiles.
- **Studio E2E rewritten for the new shell** (`studio.spec.ts`): the Playwright
  flow drives the current rail UI and passes 2/2; the CI e2e gate is re-enabled
  (its `continue-on-error` escape removed). The fixture launcher (`serve.mjs`)
  uses the `${expr}` prompt form and preserves version derivation.

### Fixed

- **Studio run-panel payload-rendering crash** (React error #31): `fmtPayload`
  in `ProjectView.jsx` now renders object-valued ledger payloads instead of
  passing an object as a React child, so runs with structured payloads display.

### Verified

- agape-ts typecheck; unit suite (105); conformance 207/207 (exit 0).
- `check-version.mjs` ok at `1.0.0-beta.2026.7.14.0`; conformance manifests
  up to date (no drift).
- Runtime-contract: 35 skipped without an adapter (exit 0); 35/35 with the
  agape-ts adapter (both former kernel gaps closed).
- Studio agent-server 51/51; studio web 15/15 + build; bundle smoke and
  `package.sh` self-verify (LICENSE lands in the tarball).

## [1.0.0-alpha.2026.7.11.7] - 2026-07-11

Type-safety fix: an assignment to a typed lvalue now threads that lvalue's declared type into the RHS, so a `self <- prompt {…}` structured send on the right of a bare assignment requests the SAME schema a typed declaration would. Previously the assignment path evaluated the RHS with no expected type, silently skipping the structured path and dropping a scalar `text` into a typed slot (e.g. `text[] xs = []; xs = self <- prompt {…}` returned text and crashed at `len(xs)`) — a hole in a type-safe language. Surfaced dogfooding LeeHaRin's intent decomposition.

### Fixed

- `interp.ts`: `Scope` now records each `var`-bound name's declared `TypeRef`; the `assign` handler looks it up and passes it as the expected type/bind-name into the RHS evaluation, matching the declaration path. Robust to empty collections (uses the declared type, not a runtime-value guess). Assignments with no recorded type (params, loop bindings) are unchanged.

### Added

- Regression test: a bare assignment of a `self <- prompt` array reply into a pre-declared `text[]` lands as an array (len/index work), not a scalar.

### Verified

- Typecheck, unit suite (100), conformance cert (3).

## [1.0.0-alpha.2026.7.11.6] - 2026-07-11

Array-walking builtins: `skip(xs, n)` (drop the first n) and `len(xs)` (settled int count) join `take`. Head/tail decomposition (`take(xs, 1)` / `skip(xs, 1)` / `len(xs) == 0`) makes the §11 bounded reactive re-dispatch idiom iterate over collections — an event handler processes the head and re-emits the tail — without any loop entering the core grammar.

### Added

- Kernel builtins `skip(xs, n)` and `len(xs)`; both pure-legal (no world reach), both shadowed by user functions of the same name. `len` returns settled trust — the count is the kernel's own tally, not cognition.

### Verified

- TypeScript runtime typecheck, version check, unit suite (98), conformance cert (3).

## [1.0.0-alpha.2026.7.11.5] - 2026-07-11

Provenance + kernel-clock alpha. Memory cells now record WHO the originating episode came from, and programs can read the kernel's own clock — both direct answers to dogfood findings (test contamination indistinguishable from the real user; assistant time-blindness).

### Added

- **Memory-cell provenance**: the reaction's originating prompt attestation is threaded into every memory internalization made inside that reaction (explicit `mem` stores, declare-with-init stores, provider-reply internalizations, and background task handlers via the delegating reaction). Cells persist `metadata.provenance = { attester, prompt_name }` in the markdown json block; recall candidates and the reranker carry it through. Additive only — reflect-off stored bytes are unchanged; reactions with no originating prompt delivery omit the key. New `MemoryProvenance` interface in `memory.ts`.
- **Kernel builtins `now()` and `take(xs, n)`** — the only self-declaring calls, shadowed by user functions of the same name. `now()` renders the kernel clock (settled: world-fact from the trusted kernel, not cognition) as "Sat 2026-07-11 01:05 PM"; `AGAPE_FIXED_NOW` pins it for deterministic tests and replays; a `pure` body may not call it (a clock read is a world reach → ColorViolation). `take(xs, n)` keeps the first n elements of an array.
- **Array `+` concatenation** (trust/ingress join, no laundering) — with `take` this is the rolling-window primitive, so bounded program state needs no numbered bindings.
- **Array rendering**: interpolated arrays render one item per line (prose in prompt blocks, not debug syntax); `show` is unchanged.

### Verified

- TypeScript runtime typecheck, version check, unit suite (97: 85 prior + 7 provenance + 5 builtins), conformance cert (3).

## [1.0.0-alpha.2026.7.11.4] - 2026-07-11

Memory-reflection hygiene fix: the reflection instruction no longer contains any example proper name. The previous attribution rule illustrated itself with a literal name ("Tyler uses …"), and small reflection models copy instruction examples into real memories — an agent with an anonymous user could invent that name for them. Dogfooding surfaced this: an isolated LeeHaRin verify run with zero recall hits internalized "Tyler said he was heading to bed".

### Fixed

- `memory_runtime.ts` reflection prompt: attribution example is now name-free ("the user uses …"), and a new rule forbids referring to people by any name that does not appear in the raw episode itself.

### Added

- Regression test asserting the reflection instruction contains no proper-name example and carries the no-invented-names rule.

### Verified

- TypeScript runtime typecheck, version check, and full unit suite.

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
