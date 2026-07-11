# Agape — Black-Box Conformance Suite (v1.0.0-alpha.2026.7.11.3)

A set of `.ag` programs, each tagged with an expected outcome, that together
define when an implementation of **Agape v1.0.0-alpha.2026.7.11.3** is *valid* (every
behavior matches the spec) and *complete* (every required behavior is exercised). Tests
are derived **only** from `../SPEC.md` — never from any implementation. An
implementation passes by feeding each test through its own front end + runtime
and matching the declared outcome.

The suite is kernel-first. The most important tests are the ones that prove no
surface feature can bypass the trusted path:

```
testimony -> Credence<E> -> Decided Decision<E> -> committed Endorsement<T> -> granted sink -> ledger
```

This is the **core kernel** suite — the complete language with no syntactic sugar.
When a new construct lands — memory store/recall, the ledger query, provider
fallback, runtime adapters — it should add at least one positive conformance case
and, more importantly, negative cases that show it cannot launder taint, invent
authority, skip endorsement, push an unsettled value out through a perform, or evade replay.

```
agape-conformance/
├── README.md            ← this file
├── MANIFEST.toml        ← machine-readable index (generated; do not hand-edit)
├── MANIFEST.md          ← human-readable index table (generated; do not hand-edit)
├── build_manifests.py   ← derives both manifests from the .ag headers
└── tests/<NN_section>/<id>.ag   ← the tests; the single source of truth
```

The `.ag` files are the source of truth — **edit them directly**. The two
`MANIFEST.*` indexes are *derived* from the `//!` headers, so they cannot drift
from the tests. After adding, removing, renaming, or editing the header of a
test, regenerate the indexes:

```
python3 build_manifests.py            # rebuild MANIFEST.toml + MANIFEST.md
python3 build_manifests.py --check    # CI: validate headers + assert indexes are up to date
```

`build_manifests.py` only reads the tests and writes the manifests; it never
touches an `.ag` file. It also validates each header (id matches the filename,
section matches the directory, a `reject` carries a known error class, no
duplicate ids). Tests appear in the indexes in directory order: section then
filename.

## Test file format

Every test is a valid Agape source file. The header is a block of `//!` lines
(themselves ordinary `//` comments, so an implementation that ignores them still
compiles the body), terminated by `//! ---`. Everything after is the program
under test.

```
//! id:        world_pure_perform_reject
//! section:   06b_world
//! expect:    reject
//! error:     ColorViolation
//! spec:      §4, §6b (a perform is an outbound act → async)
//! note:      a pure function may not perform
//! ---
action Ping(text note);
pure null poke() { perform Ping("x"); return; }
```

### Header keys

| key | when | meaning |
|---|---|---|
| `id` | always | unique test id (matches filename stem) |
| `section` | always | spec-section bucket / directory |
| `expect` | always | `accept` \| `reject` |
| `error` | iff `reject` | the error **class** the implementation must raise |
| `ledger` | optional | exact ordered ledger the run must produce |
| `contains` | optional | events the ledger must contain (order-free) |
| `absent` | optional | events the ledger must **not** contain |
| `order` | optional | events that must appear in this relative order (others may interleave) |
| `schema` | optional | compiler structured-output schema assertions; `; `-separated |
| `provider` | optional | stub-provider behavior for the run (§17.5 fault / credence scripting) |
| `principal` | optional | identity-dependency ruling for `decide c by p` (`grant` / `deny`) |
| `manifest` | optional | `[runtime]`/policy fixture values for the run (`; `-separated) |
| `replay` | optional | replay assertion (`chain_head_equal`) |
| `spec` | always | the `SPEC.md` clause(s) the test pins |
| `note` | optional | one-line rationale |

### Outcome statuses

- **accept** — well-formed under the spec; the front end must not reject it, and
  (if `ledger`/`contains`/`absent` are present) the run must produce the asserted ledger.
- **reject** — must be rejected, **with the declared `error` class**. Rejecting for
  the wrong reason is a failure: the class is part of the assertion.

### Error classes (`reject` tests)

`LexError` · `ParseError` · `TypeError` · `ColorViolation` · `TaintViolation` ·
`AuthorityViolation` · `ConfigError` ·
`GateError` (a consequential `endorse`/`perform` path with no principal escalation and no mature
profile — the deference requirement, §13; the spec calls this a "compile error" and `GateError` is
the suite's category for it). An implementation may use its own internal names but must map to these
categories; the suite asserts the category, not the message text.

## Ledger matcher vocabulary

`ledger`/`contains`/`absent` use a compact event vocabulary. `x` is a subject.

```
Spawned(x) AgentAwake(x) SleepEvent(x) PromptOpened(x) Prompt(x)
Event Error  Decided(x) Endorsed(x) PrincipalDecision(x)
Contradiction(x) QueryResult(x)  MemoryConsulted(x) ArtifactObserved(x) Internalized(x) Forgotten(x)
TypeMismatch MarginFloorViolation(x)
pair(op@subj)   ← a Started/Resolved pair for async op `op` on subject `subj`
single(op@subj) ← a single (synchronous) event
```

`ledger:` is an exact ordered match. `contains:`/`absent:` are order-free. `order:` is an
**ordered subsequence** — every listed event must appear, in the given relative order, with
anything allowed in between. Subtype matching follows §9: every `decide` records `Decided(x)`
(committed or abstained); an `endorse` records `Endorsed(x)` only after a committed Decision has
been flow-narrowed; a principal-prefixed `decide` may also record `PrincipalDecision(x)` or
`FailedPrincipalDecision(x)` before `Decided(x)`; `Error` matches any `Error` subtype (e.g.
`Contradiction`).

The message lifecycle and async pairs use ordinary event tokens: `Sent(x)` `Delivered(x)`
`Resolved(x)` `Expired(x)` `DeliveryRefused(x)`, plus `AgentCrashed(x)` `FailedPrincipalDecision(x)`.

## Run directives — the §17.5 harness contract

The dynamic guarantees (faults, replay, configuration) can't be asserted on one deterministic
run. A conformant implementation must expose a **test mode** (§17.5) the suite drives through
these header directives. A test with no directives runs under the default recorded provider.

- `provider:` — the cognition stub's behavior for the run:
  - `empty` — returns nothing (an unrecoverable seam failure) → the agent **crashes**
    (`AgentCrashed`, §5): contained and recorded, not a death.
  - `schema_violation` — returns output violating the constrained-decoding schema → a
    `TypeMismatch` (§8), catchable and retryable.
  - `credence(V=p, …)` — scripts the next graded judgment's distribution so a test can pin a
    margin, e.g. `credence(true=0.62, false=0.38)`.
- `principal:` — the identity dependency's ruling for `decide c by p`: `grant` (default) or
  `deny` (→ `FailedPrincipalDecision`, §13).
- `schema:` — compiler assertion for generated structured-output schemas (§8). The assertion
  string is intentionally transport-neutral; implementations map it to their internal schema
  representation. Example: `event<Ticket> closed_enum(Billing,Bug)`.
- `manifest:` — connector/dependency fixture config, `; `-separated, e.g.
  `manifest: provider.exposes_logprobs=false` or
  `manifest: tools.search.driver=mcp; tools.search.server=stdio:local-search`.
  The old shorthand `tools.search=mock` is accepted as `{ driver = "mock" }`.
  Provider fixtures exercise the sampling fallback (§16.8); dependency fixtures exercise
  manifest bindings (§17.1).
  Decision rules are in the test's own source (an inline rule on the gate, §13), never the manifest.
- `replay:` — `chain_head_equal`: record the run's journal, replay it, and assert the ledger's
  terminal hash is identical (§15.4.2 / T4). Replay re-serves every oracle/tool result from the
  recording and re-invokes nothing.

## How an implementation consumes the suite

1. Read `MANIFEST.toml` for the tests and their expectations.
2. For each test, strip the `//!` header and feed the body to the front end.
3. **reject**: assert rejection occurs **and** the raised error maps to the declared class.
4. **accept**: assert no rejection; if ledger matchers are present, run under the
   recorded/stub provider and assert the ledger.
5. Report `passed / failed` per section.

An implementation is **conformant** iff it satisfies *every* test: all `reject`
tests reject with the correct error class, and all `accept` tests are accepted
(matching any asserted ledger).

A feature is not considered covered merely because its happy path parses. It is
covered when the suite also exercises the kernel boundary it touches: type,
taint, endorsement, authority, tool effect, configuration binding, and replay.
