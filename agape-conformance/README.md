# Agape — Black-Box Conformance Suite (v1.0)

A set of `.ag` programs, each tagged with an expected outcome, that together
define when an implementation of **Agape v1.0** is *valid* (every behavior
matches the spec) and *complete* (every required behavior is exercised). Tests
are derived **only** from `SPEC-1.0.md` — never from any implementation. An
implementation passes by feeding each test through its own front end + runtime
and matching the declared outcome.

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
//! id:        fn_sync_tool_call_reject
//! section:   04_functions
//! expect:    reject
//! error:     ColorViolation
//! spec:      §4, §6b (a tool call reaches the tool seam → async)
//! note:      a sync function may not call a tool
//! ---
tool text search(text q);
sync text find(text q) { return search(q); }
```

### Header keys

| key | when | meaning |
|---|---|---|
| `id` | always | unique test id (matches filename stem) |
| `section` | always | spec-section bucket / directory |
| `expect` | always | `accept` \| `reject` |
| `error` | iff `reject` | the error **class** the implementation must raise |
| `spine` | optional | exact ordered spine the run must produce |
| `contains` | optional | events the spine must contain (order-free) |
| `absent` | optional | events the spine must **not** contain |
| `order` | optional | events that must appear in this relative order (others may interleave) |
| `provider` | optional | stub-provider behavior for the run (§16.5 fault / credence scripting) |
| `attest` | optional | identity-dependency ruling for `attest` (`grant` / `deny`) |
| `manifest` | optional | `[runtime]`/policy fixture values for the run (`; `-separated) |
| `replay` | optional | replay assertion (`chain_head_equal`) |
| `spec` | always | the SPEC-1.0 clause(s) the test pins |
| `note` | optional | one-line rationale |

### Outcome statuses

- **accept** — well-formed under the spec; the front end must not reject it, and
  (if `spine`/`contains`/`absent` are present) the run must produce the asserted spine.
- **reject** — must be rejected, **with the declared `error` class**. Rejecting for
  the wrong reason is a failure: the class is part of the assertion.

### Error classes (`reject` tests)

`LexError` · `ParseError` · `TypeError` · `ColorViolation` · `TaintViolation` ·
`AuthorityViolation` · `ExhaustivenessError`. An implementation may use its own
internal names but must map to these categories; the suite asserts the category,
not the message text.

## Spine matcher vocabulary

`spine`/`contains`/`absent` use a compact event vocabulary. `x` is a subject.

```
Spawned(x) AgentAwake(x) SleepEvent(x) PromptOpened(x) Prompt(x)
Event Error  Decided(x) Abstained(x)
Contradiction(x) Attestation(x)  QueryResult(x)  RetryExhausted TypeMismatch
pair(op@subj)   ← a Started/Resolved pair for async op `op` on subject `subj`
single(op@subj) ← a single (synchronous) event
```

`spine:` is an exact ordered match. `contains:`/`absent:` are order-free. `order:` is an
**ordered subsequence** — every listed event must appear, in the given relative order, with
anything allowed in between. Subtype matching follows §9: a gate records `Decided(x)` (a
singleton commit) or `Abstained(x)`; `Error` matches any `Error` subtype (e.g. `Contradiction`).

The message lifecycle and async pairs use ordinary event tokens: `Sent(x)` `Delivered(x)`
`Resolved(x)` `Expired(x)` `DeliveryRefused(x)`, plus `AgentCrashed(x)` `FailedAttestation(x)`.

## Run directives — the §16.5 harness contract

The dynamic guarantees (faults, replay, configuration) can't be asserted on one deterministic
run. A conformant implementation must expose a **test mode** (§16.5) the suite drives through
these header directives. A test with no directives runs under the default recorded provider.

- `provider:` — the cognition stub's behavior for the run:
  - `empty` — returns nothing (an unrecoverable seam failure) → the agent **crashes**
    (`AgentCrashed`, §5): contained and recorded, not a death.
  - `schema_violation` — returns output violating the constrained-decoding schema → a
    `TypeMismatch` (§8), catchable and retryable.
  - `credence(V=p, …)` — scripts the next graded judgment's distribution so a test can pin a
    margin, e.g. `credence(true=0.62, false=0.38)`.
- `attest:` — the identity dependency's ruling for `attest … by p`: `grant` (default) or
  `deny` (→ `FailedAttestation`, §13).
- `manifest:` — `[runtime]`/policy fixture values, `; `-separated, e.g.
  `manifest: runtime.threshold=0.9; runtime.consequential_margin=0.2` — to exercise precedence
  (§16.2) and the runtime margin floor (§13).
- `replay:` — `chain_head_equal`: record the run's journal, replay it, and assert the spine's
  terminal hash is identical (§15.4.2 / T4). Replay re-serves every oracle/tool result from the
  recording and re-invokes nothing.

## How an implementation consumes the suite

1. Read `MANIFEST.toml` for the tests and their expectations.
2. For each test, strip the `//!` header and feed the body to the front end.
3. **reject**: assert rejection occurs **and** the raised error maps to the declared class.
4. **accept**: assert no rejection; if spine matchers are present, run under the
   recorded/stub provider and assert the spine.
5. Report `passed / failed` per section.

An implementation is **conformant** iff it satisfies *every* test: all `reject`
tests reject with the correct error class, and all `accept` tests are accepted
(matching any asserted spine).
