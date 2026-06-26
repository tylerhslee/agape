# Agape — Black-Box Conformance Suite (v1.0)

A set of `.ag` programs, each tagged with an expected outcome, that together
define when an implementation of **Agape v1.0** is *valid* (every behavior
matches the spec) and *complete* (every required behavior is exercised). Tests
are derived **only** from `SPEC-1.0.md` — never from any implementation. An
implementation passes by feeding each test through its own front end + runtime
and matching the declared outcome.

```
agape-conformance/
├── README.md          ← this file
├── MANIFEST.toml      ← machine-readable index (every test + expectation)
├── MANIFEST.md        ← human-readable index table
├── gen.py             ← the generator: all test definitions live here, in one place
└── tests/<NN_section>/<id>.ag
```

`gen.py` is test infrastructure, not the implementation. Re-run it
(`python3 gen.py`) to regenerate the `.ag` files + both manifests after edits.

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
tool search(text q) -> text;
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

`spine:` is an exact ordered match. `contains:`/`absent:` are order-free. Subtype
matching follows §9: a gate records `Decided(x)` (a singleton commit) or `Abstained(x)`;
`Error` matches any `Error` subtype (e.g. `Contradiction`).

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
