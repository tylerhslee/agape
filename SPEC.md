# Agape Language Specification (v0.1 — POC)

> Status: design-complete for the POC slice. This document is the authoritative
> reference. Where it and any older note disagree, this document wins. It is
> written to be implemented against directly (lexer → parser → interpreter).
>
> Implementation target: a Python POC interpreter with a **mock provider** that
> can be swapped for the Anthropic API by changing one class. The POC must run
> `hello.ag` end-to-end and print the full event spine at the end.

---

## 0. What Agape is

Agape is a programming language for multi-agent systems in which:

- **agents are first-class** (spawn / awake / sleep lifecycle, private memory, a mailbox);
- **cognition is a swappable substrate** reached only through a provider **seam**
  (`think` / `embed`) that program code never names directly;
- **meaning is checkable**: the language has primitives (`~`, `verify`, `entail`)
  for asserting *semantic* properties of agent output, not just structural ones.

Two ideas sit under everything:

1. **The event spine.** Every meaningful action appends an immutable event to a
   single append-only log. The log is the source of truth; state is a projection
   of it; replay re-derives state by folding it.
2. **The provider seam.** Cognition (generate / embed) happens behind a seam.
   Swapping the provider (mock → Anthropic → local) changes no Agape source.

---

## 1. Two orthogonal axes (read this first — it prevents the most common confusion)

Agape tracks **two independent properties** that are easy to conflate. They are
NOT the same axis.

### Axis A — function color: sync vs async

- **Code is asynchronous by DEFAULT.** The common case in an agentic language is
  cognition, which is async.
- **`sync`** is the *marked* keyword. A `sync` function:
  - may NOT touch the seam (no `<-`, `~`, `entail`, `embed`), and
  - may NOT call a non-`sync` function and use its result.
  - The compiler rejects any `sync` body that reaches cognition.
- `sync` is an **affirmative, auditable** claim of cognition-freedom. It
  propagates **downward**: a `sync` function may only call other `sync` functions.
- Rationale: in an agentic language you most want to *see* which code provably
  cannot call a model (hot paths, schedulers, tight loops). So the safe property
  is the marked one.

### Axis B — spine presence: `event<T>` vs bare `T`

- **`event<T>`** means "this value of type `T` is (or will be) sent on the spine
  as a message." It marks **spine presence**, not async-ness.
- A bare `T` is an ordinary in-memory value.
- A function can be **async** (touch the seam) yet **return a bare value**, if
  that value is handed back to the caller rather than emitted to the spine.

### The two axes are independent

| construct                         | async? | on spine? | type            |
|-----------------------------------|--------|-----------|-----------------|
| `x ~ "y"` (bare similarity)       | yes    | no        | `bool`          |
| `verify x ~ "y"`                  | yes    | yes       | `event<Verification>` (emitted) |
| `a entail "b"`                    | yes    | yes       | `event<Verdict>` |
| `dest <- "msg"`                   | yes    | yes       | `event<T>`      |
| `double(3)` (pure)                | no     | no        | `int`           |
| a fn returning `x ~ "y"`          | yes    | no        | `bool`          |

**Key consequences:**
- **Bare `~` yields `bool`** (a similarity threshold test used as a value).
- **`verify ... ~ ...` emits** an `event<Verification>` to the spine (an assertion).
- **`entail` is a spine-emitting keyword**: it ALWAYS produces `event<Verdict>`,
  with no `verify` needed. That asymmetry (`~` is an operator, `entail` is an
  emitting keyword) is why `return x ~ "y"` is `bool` but `return a entail "b"`
  is `event<Verdict>`.

---

## 2. Lexical structure

- **Comments:** `//` to end of line.
- **Whitespace:** insignificant except as a token separator.
- **Statement terminator:** `;` (explicit, required).
- **String:** `"..."` with escapes `\n \t \" \\`.
- **F-string:** `f"...{expr}..."`. Lexed as one `FSTR` token; `{expr}` segments
  are parsed afterward. Interpolation evaluates each `expr` and concatenates.
- **Numbers:** `INT` (`42`) and `FLOAT` (`3.5`).
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`.
- **Operators (multi-char first):** `<-  |>  >=  <=  ==  !=  { } ( ) [ ] ; , . :
  =  +  -  *  /  <  >  ~  !`
- **Single send operator:** there is exactly **one** communication arrow, `<-`.
  There is no `->`. (`->` appears only inside prose comments.)

### Keywords

```
int float bool text null event          // types + spine wrapper
agent extend sync                        // declarations (sync = marked color)
spawn awake sleep self on                // lifecycle
when catch case if else return retry default   // control / reactive
verify entail emit                       // semantic checks / spine emit
find where select from match             // queries
all any                                  // aggregation
true false                               // bool literals
say                                      // builtin print
```

**Not keywords (they are prelude identifiers):** `Verification`, `Verdict`,
`Entailment`, `Contradiction`, `Neutral`, `Event`, `Error`, and the retrieval
built-ins `SuccessfulVerification`, `FailedVerification`. These live in the
**prelude** (see §9), not the grammar.

---

## 3. Types

### Scalars
`int`, `float`, `bool`, `text`, `null`.

### `event<T>` — spine-message type
Wraps any `T` to mean "on the spine." Produced by spine-emitting constructs
(`<-`, `verify`, `entail`, `emit`) and consumed by spine constructs (`catch`,
`when`, retrieval built-ins, field storage). `event<null>` = "sent, but no typed
reply is bound" (fire-and-record).

### Structs (prelude + user)
Records with named, typed fields. All fields are required (see §8, structured
output forbids optional-by-omission; optionality would be a nullable union, not
yet in the POC).

### Enums (prelude + user)
A closed set of named variants. `case` pattern-matches them with compile-time
exhaustiveness checking.

### The two verdict types (prelude — see §9)
- **`Verification`** — a **graded** (binary) verdict from `~`/`verify`.
  Struct: `{ passed: bool, score: float, threshold: float, mode: Mode,
  subject: text, expected: text, evidence: text }`. `passed` is derived
  (`score >= threshold`). Use `if (v.passed)` / read `v.score`; you do not
  normally `case` on it.
- **`Verdict`** — a **categorical** (three-valued) verdict from `entail`.
  Enum: `{ Entailment, Contradiction, Neutral }` (plus carried evidence). You
  `case` on it.

These are **distinct types** (different arity, different shape) and do NOT unify
under a generic. New verdict arities = new named prelude types, not a compiler
change.

---

## 4. Functions

```
[sync]? RET_TYPE NAME ( [TYPE PARAM] , ... ) { BODY }
```

- Leading optional `sync` marks cognition-free (Axis A). Unmarked = async.
- `RET_TYPE` is type-first (e.g. `sync int double(...)`, `bool is_it_john(...)`,
  `event<Verdict> claims_flush_beats_straight()`).
- A function returns `event<T>` only if it returns something on the spine
  (`<-`, `verify`, `entail` result). A function returning a bare `~` result
  returns `bool` even though it is async.
- `return EXPR;`.

Examples (from `hello.ag`):
```agape
sync int double(int x) { return x * 2; }            // sync, bare int
bool is_about_poker(text x) { return x ~ "a game of poker"; }  // async, bare bool
event<Verdict> claims_flush_beats_straight() {       // async, spine value
    event<text> answer = john <- "Does a flush beat a straight, and why?";
    return answer entail "A flush beats a straight.";
}
```

---

## 5. Agents

### Declaration (template)
```agape
agent NAME ( [TYPE PARAM] , ... ) {
    FIELD_DECLS          // event<T> slots, etc.
    CONSTRUCTOR_STMTS    // run at spawn (top-level statements in the body)
    when (SUBJECT) { ... }   // spine subscriptions
    on awake { ... }     // lifecycle hook: fires when awoken
    on sleep { ... }     // lifecycle hook: fires when slept & collected
}
```

- `agent` is a **template** (like a class).
- A field `event<T> name;` is a typed slot filled from cognition or another agent.
- `self` is the agent's reference to itself.
- `extend PARENT(args);` (first statement) = composition/inheritance: parent's
  fields, constructor, and `when` blocks all apply to the child.

### Lifecycle (each transition is a spine event)
- `spawn TYPE name(args);` — create a named instance; run its constructor body.
- `awake name;` — open the mailbox; queued sends now process.
- `sleep name;` — close the mailbox; new sends queue until next awake. A slept
  agent with no live references is GC'd, firing its `on sleep` hook.

### Lifecycle hooks vs `when`
- **`on awake` / `on sleep`** are dedicated lifecycle hooks tied to the agent's
  own state transitions. This is the canonical syntax for release/startup logic.
- **`when (X)`** is a spine subscription keyed by an arbitrary subject `X`
  (see §7). Do NOT use `when (sleep self)` for lifecycle — use `on sleep`.

---

## 6. Communication — the send operator `<-`

`dest <- message`

- Sends `message` into agent `dest` (or `self`). Sending into the seam is how an
  agent "thinks."
- When bound to a typed slot (`event<T> x = dest <- "...";`), the typed reply is
  produced via the provider seam using structured output for `T` (see §8).
- A send is a spine message → its result type is `event<T>`.
- `event<null> x = dest <- "...";` records the send, binds no reply.

---

## 7. The spine, events, `when`, `catch`

### Events
Every meaningful action appends an immutable `Event`:
`{ tick, etype, subject, payload, corr, agent }`.

- **`tick`**: system-assigned monotonic order. **Ticks are assigned at the system
  level, never by an agent.**
- **`subject`**: the thing the event is ABOUT — the correlation key for
  `catch`/`when`. (For a verification, the left operand; for a send, the
  destination; for a routine error, the routine invocation.)
- **`corr`**: links a `Started` to its `Resolved`.

### Started/Resolved discipline
Every operation with a real **pending window** (anything async that touches the
seam: `<-`, `~` under verify, `entail`, `embed`) appends a PAIR:

```
<Op>Started   (verdict/result unknown)
<Op>Resolved  (result now on the log)
```

correlated by `corr`. **Pending = a Started with no matching Resolved.**
Synchronous deterministic ops (`==`, arithmetic) append a SINGLE event.

### `when` and `catch` — one mechanism, opposite polarity
Both are **spine subscriptions keyed by (event type, subject)**:

- `when (X) { ... }` fires on the **success/resolution** events of subject `X`.
- `catch EVENT_TYPE(subject) as e { ... }` fires on the **failure** events.

Event-type matching is by **subtype**: `Error` is the root error type and
`FailedVerification` / `Contradiction` / `TypeMismatch` / `RetryExhausted` extend
it, so `catch Error` observes any of them while `catch FailedVerification(x)`
stays narrow (one-directional — a leaf never matches a bare `Error`). See §9.

Firing semantics (LOCKED):
- On registration, a subscription fires for the **most recent matching event
  already on the log** (retroactive), then **once per new matching event**
  (prospective).
- To process **all** historical matches, use a **query** (§10), not a
  subscription.

`catch` / `when` are NOT exceptions. Errors are events; the system keeps running;
handlers observe.

### Subject keying examples
```agape
verify Name ~ "John";                 // emits Verification subject=Name
catch FailedVerification(Name) as e { ... }   // fires iff that verdict was Fail
catch Contradiction(john) as c { ... }        // fires on any Contradiction subj=john
catch (Error(claims_flush_beats_straight)) as e { ... }  // routine invocation is the subject
```

A **routine invocation is itself an event source** (like a `<-` or a `verify`),
so errors during its run are subject-keyed to it. (Open design point for later:
whether deep errors carry the innermost source, the routine, or a subject *chain*
so `catch` can key at any granularity. POC may use the routine invocation as
subject.)

---

## 8. Semantic checking

### Similarity `~`
- `a ~ b` asks "is `a` semantically close to `b`?" Resolves by embedding both
  sides through the seam and comparing in the asking agent's semantic memory.
- **Bare `~` returns `bool`** (cleared the threshold or not).
- On a **scalar**: one similarity result.
- On an **array**: the check **decomposes** (considers the parts) but returns
  **ONE** result for the whole; the evidence records where a partial mismatch was.
  The return type stays uniform (one verdict, not an array of verdicts).

### `verify`
`verify EXPR;` turns a check into a spine **assertion**:
- `verify a ~ b;` → emits `event<Verification>` (pass → `SuccessfulVerification`,
  fail → `FailedVerification`), subject = left operand. Async (embeds), so
  Started/Resolved.
- `verify a == b;` → SYNCHRONOUS exact equality. No embedding, single spine event.
- `verify boolExpr;` → synchronous check on an already-computed bool, still emits
  a `Verification` you can subscribe to.

### Entailment `entail`
- `a entail b` asks "does `a` logically COMMIT to claim `b`?" **Three-valued**:
  `Entailment` (commits true), `Contradiction` (commits false), `Neutral`
  (neither — silence ≠ denial).
- `entail` is a **spine-emitting keyword**: ALWAYS produces `event<Verdict>`
  (no `verify` needed). Async → Started/Resolved.
- **`case` pattern-matches the resolved variant** (see §11), with compile-time
  exhaustiveness checking.
- **Mechanism vs policy:** when `entail` resolves to `Contradiction`, the runtime
  ALSO emits a first-class `Contradiction` event to the spine, independent of any
  `case`. A global `catch Contradiction(subject)` can react retroactively. The
  runtime supplies the FACT; the programmer supplies the POLICY and its own
  completion event (there is no built-in "handled" event).

### Structured output (the seam contract)
- The runtime compiles the declared `event<T>` into a **JSON Schema** and the
  provider returns schema-conforming output via **constrained decoding**.
- **Constrained decoding is mandatory** for any Agape provider. There is **no
  regex/fuzzy fallback** in the language — a provider that cannot constrain
  output is not a valid Agape provider. (For the POC, the mock provider
  guarantees conformance; the Anthropic provider uses `output_config` /
  `json_schema`.)
- Type → schema mapping (verified to work): `bool→boolean`, `text→string`,
  `int→integer`, `float→number`, enum→`{type:string, enum:[...]}`,
  struct→`{type:object, properties, required:all, additionalProperties:false}`,
  array→`{type:array, items}`.
- If the provider cannot satisfy the schema → clean `TypeMismatch` (caller may
  `retry`), never a crash or silent garbage.

---

## 9. The prelude

Provided as Agape definitions built on general enum/struct machinery (so new
verdict types never require a compiler change):

```
enum Mode { SIMILARITY, EQUALITY }

struct Verification {
    passed: bool;        // derived: score >= threshold
    score: float;
    threshold: float;
    mode: Mode;
    subject: text;
    expected: text;
    evidence: text;
}

enum Verdict { Entailment, Contradiction, Neutral }   // + evidence carried alongside

// Built-in spine events:
//   Event(text)          — user progress/info event (via `emit`)
//   Error(text|subject)  — ROOT error type (see hierarchy below)
//   Contradiction(subj)  — emitted automatically on entail→Contradiction
//   ...Started / ...Resolved pairs for async ops
//
// Event-type hierarchy: `Error` is the root error type. The runtime's failure
// events EXTEND it — `FailedVerification`, `Contradiction`, `TypeMismatch`,
// `RetryExhausted`. `catch`/`when` match by SUBTYPE: `catch Error` observes any
// of these, while `catch FailedVerification(x)` stays narrow. The relation is
// one-directional — a leaf subscription never matches a bare `Error`.

// Subject-keyed retrieval built-ins — `EventType(subject)` retrieves the spine
// event for that subject (overloaded with the type name on purpose):
//   Verification(x)            -> event<Verification>  (either outcome)
//   SuccessfulVerification(x)  -> event<Verification>  (only if passed)
//   FailedVerification(x)      -> event<Verification>  (only if failed)
```

`say(x)` — print to stdout (debug/output builtin).

---

## 10. Memory — three modalities, one unit

Every agent has its own memory architecture, three modalities working as one:

- **FACTS** → a deterministic table (SQLite). Queried with `select`.
- **RELATIONSHIPS** → a graph (NetworkX). Queried with `find ... where`.
- **SEMANTICS** → a vector store. Queried with `match`; also the substrate
  behind `~` and `entail`.

### Internalization (IMPLICIT)
Every event an agent **receives** (via `<-`) is decomposed by the seam into
facts, relationships, and embeddings, and written to that agent's memory. The
agent learns from everything it experiences.

- **Determinism note:** decomposition is non-deterministic in general (an LLM
  does it). The POC de-risks this with a **controlled vocabulary**: facts use a
  fixed schema and the graph uses **SPO triples plus a small typed-predicate
  set** (`is_named`, `beats`, `is_a`, `result_for`, ...). The **shape** is fixed;
  swapping in a real provider improves extraction quality without changing the
  query surface.
- Deterministic *replay* reads the logged facts/verdicts (immutable, timestamped),
  not by re-running the LLM. "What did the agent know at tick N?" =
  `select ... where timestamp <= N`.

### Query surface
- **Graph:** `find BINDING where { PATTERN };` — triple-pattern over relationships.
  With no named target it **fans out across ALL agents' graphs** and aggregates
  (the runtime knows the spawned population at compile time — no central DB).
  Example: `find n where { Coach is_named n };`
- **Facts:** `select COLS from AGENT where { CONDS };` — table scan of one agent's
  fact table. Example:
  `select first_name, source_timestamp from john where { type == "identity" };`
- **Vector:** `match { BINDING: VECTOR } > THRESHOLD;` — embeddings above a
  threshold. Example: `match { m: "poker strategy" } > 0.8;`
- Global queries return ALL matches; **conflict reconciliation is the
  programmer's responsibility** (the language returns matches, does not merge).

### POC mock embeddings
`embed()` in the POC uses **hash-based pseudo-vectors**: deterministic,
fixed-dimension, cosine-comparable — so `~` and `match` produce stable, testable
results without an API key. Swap to real embeddings via the Anthropic provider.

---

## 11. Control flow

### `if` / `else`
Standard. Condition must be `bool`. `!` is boolean negation.

### `case` — enum pattern matching (general)
```agape
case (EXPR_PRODUCING_AN_ENUM) as e {
    VARIANT_A: { ... }
    VARIANT_B: { ... }
    default:   { ... }
}
```
- General over **any** enum (not entailment-specific). `Verdict` just happens to
  be the common case.
- **Exhaustiveness checked at compile time** (warn/error on a missing variant
  without `default`).
- If `EXPR` is a cognition-produced enum (e.g. `entail`), `case` is async: it
  waits for the verdict to resolve, then matches. If `EXPR` is a pure enum, it's
  synchronous. (Falls out of Axis A; no separate rule.)
- `case` is **synchronous value matching** — distinct from `when`/`catch`
  (asynchronous spine subscription). Do not nest one as the other.

### `retry` — bounded re-attempts (honest sugar)
Two forms:
```agape
// (1) block form: re-run until a successful verification (or n attempts)
retry(3) {
    event<bool> still_coach = john <- "Are you still a poker coach?";
    verify still_coach == true;
}

// (2) send form with a handler that runs BEFORE each RE-attempt (never the first)
text q = "Name one rule of poker.";
event<text> rule = john <- q retry(3) {
    q = q + " Answer in one short sentence.";   // mutate the prompt between tries
};
```
- The **first run is not a retry**; only re-attempts count against `n`.
- The handler block runs **before each re-attempt**, after a failure, and may
  mutate enclosing variables (capture by reference). It does NOT run before the
  first attempt.
- `retry` is **pure sugar**: it desugars to a loop + an attempt counter (in the
  agent's own memory) + `catch`. Nothing it does is something the programmer
  could not write by hand. **Requires** the loop primitive, `break`, numeric
  literals, and `>=` to desugar — build those first.
- On exhaustion it emits the failure to the spine (catchable).

---

## 12. Aggregation and pipes

- `coll |> fn` pipes each element of `coll` into `fn`.
- If `fn` is **async** (touches the seam), `|>` is a **concurrent fan-out**:
  every element's cognition launches together, then all are awaited.
  - POC semantics: **await all, then reduce. No cancellation / short-circuit**
    (a v2 feature needing seam support).
  - Each invocation emits its own Started/Resolved pair, correlated by id.
- `all(...)` / `any(...)` reduce a collection of bools.
  Example: `bool everyone_john = all(names |> is_it_john);`

---

## 13. POC scope (what to build first)

**Build, in this order:**
1. Lexer (done in reference impl).
2. Numeric literals, arithmetic, comparisons (`>= <= == != < >`), `if`/`else`,
   `!`, loop primitive + `break` (needed by `retry`).
3. The **spine** (done in reference impl): append-only log, system ticks,
   Started/Resolved pairs, subject-keyed `when`/`catch` subscriptions, queries.
4. Provider seam: `MockProvider` (keyword-rule `think`, hash pseudo-vector
   `embed`) behind an interface; an `AnthropicProvider` stub that uses
   `output_config`/`json_schema`. Swappable by one line.
5. Type → JSON Schema compiler + round-trip to typed values (verified design;
   no regex fallback).
6. Agents + lifecycle (`spawn`/`awake`/`sleep`, `on awake`/`on sleep`), `<-`,
   typed `event<T>` bindings, f-strings, `self`, fields, `emit`, `say`.
7. `verify` (`~` and `==`), `Verification` prelude, `FailedVerification` /
   `SuccessfulVerification` retrieval built-ins.
8. Memory: per-agent SQLite (facts) + NetworkX (graph) + vector store; implicit
   internalization against the controlled vocabulary (SPO + typed predicates).
9. `find/where`, `select/from/where`, `match` — fanning out across agents.
10. `entail` + `Verdict` + `case` (with exhaustiveness) + auto `Contradiction`
    spine event.
11. `extend` (agent inheritance).
12. `|>` + `all`/`any` concurrent fan-out (await-all).
13. `retry` sugar (desugars to loop + counter + catch).

**Acceptance:** `hello.ag` runs end-to-end on the mock provider and prints the
full ordered spine at the end. Swapping `MockProvider` → `AnthropicProvider`
(with an API key) runs the same program against real cognition with no source
changes.

---

## 14. Open design points (NOT resolved — decide during/after POC)

1. **Subject granularity for routine errors.** Does an error deep in a routine
   carry the innermost event source, the routine invocation, or a subject
   *chain* (so `catch` can key at any level)? POC: routine invocation as subject.
2. **`when`/`catch` historical reach.** Locked as "most recent at registration,
   then live." All-history is a query. (Recorded; revisit only if needed.)
3. **`|>` cancellation / short-circuit** for `all`/`any` over async fns. POC:
   await-all, no cancel.
4. **Optional struct fields** (would require nullable unions, since structured
   output forbids optional-by-omission). Not in POC.
5. **Distributed ticks** (vector clocks). POC: single-machine system counter.
   The agent-side API (`emit`, send) is decoupled from tick assignment so the
   switch to logical clocks later changes only the runtime, not Agape source.
6. **Internalization semantic stability** (the one research-flavored risk):
   keeping predicate extraction consistent. POC mitigates via controlled
   vocabulary; production path is constrained extraction against a fixed ontology.

---

## 15. Invariants the implementation must preserve

- **The log is the source of truth.** State is a projection; nothing that matters
  happens off the spine.
- **No hidden runtime.** Every piece of sugar (`retry`, `case`, `safe` if added)
  must desugar to primitives a programmer could write by hand.
- **Ticks are system-level**, monotonic, never agent-controlled.
- **Constrained decoding is mandatory**; there is no regex fallback in the
  language semantics.
- **`sync` is the marked color**; async is default; `sync` cannot reach cognition
  and propagates downward.
- **`event<T>` marks spine presence**, orthogonal to async-ness.
- **`~` is a bool operator; `verify` and `entail` are spine emitters.**
- **Verdict types are concrete, not generic;** new arities = new named types.
