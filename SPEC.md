# Agape Language Specification (v1.0.0)

> Agape is a programming language for multi-agent systems. This document is the
> authoritative reference. The prose (§0–§14) defines the language for a reader; the
> formal semantics (§15) defines it precisely enough that two implementations are
> obligated to agree. Where the prose and §15 conflict, §15 wins.
>
> Agape draws on established results from probability theory, distributed systems,
> decision theory, and information-flow security; these are cited inline where they are
> first used.

---

## 0. What Agape is

Agape is a language for multi-agent systems in which:

- **agents are first-class** — a spawn / awake / sleep lifecycle, private memory,
  a mailbox;
- **cognition is a swappable substrate** reached only through a provider **seam**
  (`think` / `embed`) that program code never names directly;
- **meaning is checkable, and its uncertainty is typed** — a semantic judgment asks
  the cognition seam to commit to one variant of a closed enum and returns a **graded
  judgment** (`Credence<E>`, §3); a **gate** (`decide` / `verify`) is the only thing
  that collapses a graded judgment into a committed decision;
- **the world is reached only through declared, capability-gated tools** — every
  world-affecting effect (I/O, an API call, a database, heavyweight computation) is a
  **tool** on the tool seam (§6b), enumerated and granted, never an ambient call;
- **authority is governed** — what an agent may do, which cognition-derived values may
  drive consequential actions, and which tools it may use, are bounded at compile time
  (§13).

Two ideas underlie the language:

1. **The event spine.** Every meaningful action appends an immutable event to a single
   append-only log. The log is the source of truth; state is a projection of it; replay
   re-derives state by folding it.
2. **The seams.** External, non-deterministic capability enters only through a **seam**.
   Cognition is the **provider seam** (`think`/`embed`); accountability is the **identity
   seam** (a `Principal`'s attestation, §13); the world is the **tool seam** (§6b).
   Swapping a seam's backend changes no Agape source.

### 0.1 Scope and layering

Agape is a domain language for the cognitive/agentic layer; it is not a general-purpose
language. General-purpose computation — arithmetic-heavy kernels, data structures,
parsers — is imported as a tool (§6b), never reimplemented in Agape: Agape has no
imperative substrate of its own. The deterministic work lives in the host and is
reached, and governed, through the tool seam. The
primitive Agape provides is **verified judgment under uncertainty**: a non-deterministic
semantic decision, taint-tracked, collapsed by an auditable gate, recorded on an
append-only spine.

### 0.2 Execution model

An Agape program is evaluated **top to bottom**, like an ordinary program — not as a
perpetual event loop. Reactivity happens *within* that evaluation: appending an event to
the spine synchronously fires any matching subscription before evaluation continues. The
program **terminates at quiescence** — when the top-level statements are exhausted and no
subscription work remains.

A long-running or simulated environment is expressed explicitly, never by making the
language itself a loop. There are exactly two ways to be non-terminating: an unbounded
predicate `retry` (§11), and an open external input source (`prompt`, §5b, or a standing
tool sensor) that keeps the program from quiescing. An always-on agent is not one long
non-terminating computation; it is an unbounded sequence of finite, terminating reactions
— one per external event — over a single growing spine, so replay and the reproducibility
guarantees (§15.5) hold per event. The default — no open source — is deterministic,
terminating, top-to-bottom evaluation.

**Concurrency and determinism are independent.** Agape is genuinely concurrent,
asynchronous, and event-driven: agents overlap in lifetime, a send returns immediately
and resolves later, and a fan-out (`|>`, §12) can have many seam calls in flight at once.
What Agape excludes is nondeterministically scheduled interleaving. There is no shared
mutable state to race over (each agent owns its memory, §10), and the spine assigns a
total order to observable effects, so independent cognition runs in parallel while the
observable result is serialized. The model is a discrete-event simulation: concurrent and
replayable at once. Determinism here is a property of the scheduler, not a denial of
concurrency.

---

## 1. The three orthogonal axes

Agape tracks three independent properties that are easy to conflate.

### Axis A — function color: sync vs async

- Code is **asynchronous by default**. The common case is cognition, which is async.
- **`sync`** is the marked keyword. A `sync` function may not touch a seam (no `<-`, no
  binding to a `Credence` slot, no `embed`, no tool call, no `verify … by` human gate)
  and may only call other `sync` functions.
- `sync` is an affirmative, auditable claim of cognition-freedom and effect-freedom; it
  propagates downward. Marking the safe property makes visible which code provably cannot
  reach a model, the world, or a human — hot paths, schedulers, loops, the somatic
  kernel, and the gate-collapse `decide`.
- `emit` and an in-hand `verify` are not seam reaches and are permitted in `sync`: `emit`
  is a spine append, and `verify` over a `Credence` value already in hand is `decide`
  (somatic) + `emit` (spine). Only reaching a seam forces async.

### Axis B — value taint: how trusted is the value?

Taint is a property of a value's origin. Agape uses three levels (§13, §15.3.1):

- **`T` (tainted)** — raw, unstructured cognition or untrusted external input: a `<-`
  reply, a `prompt` arrival, a tool result (§6b).
- **`P` (graded)** — the credence tier: a quantified judgment, a `Credence<E>` (a
  constrained distribution over a closed enum's variants, §3). More structured than `T`
  — the model has been forced to commit to a fixed set of outcomes — but not yet
  committed by a gate. Queried memory facts also default to `P` (§10).
- **`U` (untainted)** — a committed value cleared by a gate.

Only a gate moves a value down the lattice toward `U`. A consequential action may consume
only `U` values whose untainting is recorded on the spine (§13).

### Axis C — spine presence: `event<T>` vs bare `T`

- **`event<T>`** means the value is (or will be) present on the spine as a message. It
  marks spine presence, not async-ness or taint.
- A bare `T` is an ordinary in-memory value. A function can be async yet return a bare
  value (handed to the caller, not emitted).

### The axes are independent

| construct                              | async? | taint of result | on spine? | type                  |
|----------------------------------------|--------|------------------|-----------|-----------------------|
| `Credence<bool> c = self <- "is …?"`   | yes    | `P`              | pair      | `Credence<bool>`      |
| `decide(c, r)`                         | no     | `U`              | no        | `bool`                |
| `verify c`                             | no¹    | `U` (authorized) | single    | `event<Verification>` |
| `Credence<Entailment> v = self <- "…"` | yes    | `P`              | pair      | `Credence<Entailment>`|
| `verify memo by alice`                 | yes    | `U` (authorized) | pair      | `event<Attestation>`  |
| `dest <- "msg"` (IPC)                  | yes    | `T`              | chain     | `event<T>`            |
| `search(q)` (tool, §6b)                | yes    | `T`              | pair      | `text`                |
| `double(3)` (pure)                     | no     | `U`              | no        | `int`                 |

¹ `verify` over an in-hand `Credence` is synchronous (decide+emit, no seam); `verify
(self <- "…")` with an inline seam send is async. See §13.

- A semantic judgment yields a `Credence<E>` — a graded distribution over the variants of
  enum `E`, not a `bool`. To obtain a committed value, `decide` it; the threshold is never
  hidden.
- `decide` is the gate-collapse (`P → U`); it is somatic (§4) — the cognition already
  happened in producing the `Credence`, and applying a `Rule` to it is pure comparison.
- `verify` = `decide` + emit: it records the collapse on the spine, which is what
  authorizes the value for consequential use (§13).
- A `Credence` is produced by binding a seam send to a `Credence<E>`-typed slot (§3, §8);
  there is no separate `~` or `entail` operator.

---

## 2. Lexical structure

- **Comments:** `//` to end of line.
- **Whitespace:** insignificant except as a token separator.
- **Statement terminator:** `;` (explicit, required).
- **String:** `"..."` with escapes `\n \t \" \\`.
- **F-string:** `f"...{expr}..."`. Lexed as one `FSTR` token; `{expr}` parsed after.
- **Numbers:** `INT` (`42`) and `FLOAT` (`3.5`).
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`. Type names are conventionally capitalized;
  values and instances are lowercase.
- **Operators (multi-char first):** `<-  |>  >=  <=  ==  !=  { } ( ) [ ] ; , . : =  +
  -  *  /  <  >  !`
- **Send operator:** exactly one communication arrow, `<-`. A `->` is a `LexError`.
- There is no similarity operator. A semantic judgment is a `Credence<E>` produced by
  binding a seam send to a `Credence` slot (§3, §8); vector-store similarity is reached
  through `match` (§10).

### Keywords

```
int float bool text null event           // types + spine wrapper
agent extend sync                         // declarations (sync = marked color)
struct enum                               // user nominal-type declarations
grants authority tool                     // capability typing (§13); tool declaration (§6b)
spawn awake sleep self on prompt          // lifecycle + external input sensor
principal                                 // declare an identity-seam principal (§13)
when catch case if else return retry default   // control / reactive
verify decide emit                        // gate / spine emit
find where select from match              // queries
all any quorum independent dependent      // aggregation, dependence declaration, quorum (§12)
true false                                // bool literals
```

`calibrate`, `~`, and `entail` are not keywords and are not admitted as identifiers in
statement position; using any of them is a `ParseError`. `decide` is the deterministic gate.
`independent` / `dependent` declare the dependence structure of values fused by
`all`/`any`/`quorum` (§12).

**Contextual words** (lexed as identifiers, meaningful only in position): `as`, `by`
(gate parameter), `reach` / `use` (grants), `origin` (find projection), `expires`
(send-lifetime clause, §6), `of` (quorum, §12), `margin` (rule clause).

**Prelude identifiers** (defined in §9, not the grammar): `Verification`, `Entailment`,
`Contradiction`, `Neutral`, `Credence`, `Principal`, `Rule`, `Event`, `Error`,
`Attestation`, `SuccessfulVerification`, `FailedVerification`, `Delivered`, `Resolved`,
`Expired`, `DeliveryRefused`, `QueryResult`, `ToolStarted`, `ToolResolved`, `say`.

---

## 3. Types

### Scalars
`int`, `float`, `bool`, `text`, `null`.

### `event<T>` — spine-message type
Wraps any `T` to mean "on the spine." Produced by spine-emitting constructs (`<-`,
`verify`, `emit`, a tool call's pair, a query statement) and consumed by spine constructs
(`catch`, `when`, retrieval built-ins, field storage). `event<null>` = "sent, but no
typed reply bound."

### User nominal types
User-defined nominal types are explicitly declared. Explicit declaration is what makes
`authority Transfer;` and grant-set checking statically decidable: a consequential event
type is a declared name with a known payload.

```agape
struct Memo  { amount: int, to: text }            // a record; all fields required
enum  Ticket { Billing, Bug, Feature }            // a closed variant set
event Transfer(memo: Memo);                        // a custom spine-event type, payload typed
```

- **`struct NAME { field: T, … }`** — a record with named, typed fields. All fields are
  required: structured output (§8) has no optional-by-omission, so optionality is modeled
  as a nullable union field. A struct literal is `NAME { field: v, … }` and must supply
  every field; a missing field is a `TypeError`.
- **`enum NAME { A, B, … }`** — a closed set of named variants; `case` (§11)
  pattern-matches them with compile-time exhaustiveness.
- **`event NAME(field: T, …);`** — declares a custom spine-event type with a typed
  payload. `emit NAME(v)` requires `NAME` to be declared and `v` to match the payload
  type. Events are not self-declaring; an undeclared `emit` is a `TypeError`. Explicit
  declaration is what lets `authority NAME;` and `grants { emit NAME }` be checked
  statically.

### `Credence<E>` — a graded judgment
A `Credence<E>` is a graded judgment over a closed enum `E`: a distribution over `E`'s
variants that sum to 1, carrying how strongly the cognition seam commits to each outcome.
It unifies graded similarity and entailment into one type:

```agape
Credence<bool>          // graded over { true, false }
Credence<Entailment>    // graded over { Entails, Contradicts, Neutral }
Credence<Ticket>        // graded over a user enum — a constrained classifier
```

A `Credence<E>` is produced only by binding a seam send to a `Credence`-typed slot (§8);
the slot's enum is the output schema, so the model is forced to answer inside `E`. It is
consumed only by the gate (`decide` / `verify`, §13) and by the graded combinators (`all`
/ `any` / `quorum`, §12). It is not a probabilistic-programming distribution object:
there is no inference, conditioning, or sampling combinator. Producing a `Credence<E>`
any other way (e.g. from arithmetic) is a `TypeError`; consuming one anywhere but the gate
or combinators is a `TypeError`.

**Why a distribution over an enum, and not a probability.** The value is categorical (a
distribution over exhaustive, mutually-exclusive variants), not a scalar in `[0,1]`, and
it is a credence — a degree of belief — not a frequency. The variants being mutually
exclusive and exhaustive is exactly why they sum to 1; the type *is* that constraint.

**Where the number comes from (the calibration contract).** A `Credence` is read from the
seam's token-level probability mass on the forced categorical decision — the model's own
distribution over the enum's variants when constrained to answer inside the set — not from
a model's verbalized self-rating. Verbalized confidence is systematically overconfident,
whereas the token-level distribution in a constrained (yes/no, multiple-choice) setting is
well-calibrated. Raw model logits can still be overconfident (e.g. after RLHF), so
calibration (temperature scaling, Platt scaling, isotonic regression) is a contracted
pipeline stage applied between the raw logits and the `Credence` value. A conformant
provider seam (§8) must therefore expose token probabilities for the gated decision; a
text-only provider that cannot, cannot produce an honest `Credence`.

### `Rule` — the parameter a gate decides by
`Rule` is not a first-class type — it is an ordinary prelude struct (`struct Rule {
threshold: float, margin: float }`, §9), exactly as `Verification` is a prelude enum.
`decide(e, r)` takes a `Rule` value; the threshold/float literal is sugar for constructing
one (`> 0.8` ≡ `Rule { threshold: 0.8, margin: 0 }`; `> 0.8 margin 0.1` ≡ `Rule {
threshold: 0.8, margin: 0.1 }`). A spec-defined default rule (`threshold` = the configured
default, `margin` = 0; §16) applies to any gate that omits `by`, so a threshold is always
part of a local, overridable `Rule`, never a hidden global. `decide` never falls back to
the default rule: `decide(e)` with no rule is a `ParseError`. Only `verify` may omit its
rule.

### `Principal` — an accountable identity
`Principal` is a distinct opaque type: an entity that can be held accountable. A
`Principal` value is obtained only from the identity seam (§13) — never constructed from a
literal. There is no `text → Principal` coercion: a name is a forgeable claim, not a
credential, and the type system refuses to let a string become an authority (`verify e by
"alice"` is a `TypeError`). A `Principal`'s own taint is `U`.

A `Principal` enters a program by declaration, the sibling of `prompt` (§5b):

```agape
principal alice;                    // a Principal binding, resolved by config (§16)
```

`principal NAME;` introduces a `Principal`-typed binding resolved by the identity-seam
configuration (`[identity]` in the manifest, §16). The program names the accountable
party; the config binds it. No credential appears in source; authentication and signing
happen at the gate (`verify e by NAME`, §13), not at the declaration. `NAME`'s attest
authority (W-Attest, §13/§15.3.3) is part of its configured identity.

### The judgment enums (prelude — §9)
Both are pure enums — a categorical outcome and nothing more; all contextual metadata
lives on the spine event that carries it.

- **`Verification`** — `enum Verification { Pass, Fail }` — what a `Credence<bool>`
  judgment decides to.
- **`Entailment`** — `enum Entailment { Entails, Contradicts, Neutral }` — what a
  `Credence<Entailment>` judgment decides to.

A `Credence<E>` is the graded judgment before the gate; the enum variant is what `decide`
produces. The graded layer is where a model's "0.87" lives — the `Credence` carries it;
the decided enum does not pretend to.

---

## 4. Functions

```
[sync]? RET_TYPE NAME ( [TYPE PARAM] , ... ) { BODY }
```

- A leading optional `sync` marks cognition-freedom and effect-freedom (Axis A); unmarked
  = async.
- `RET_TYPE` is type-first.
- A function returns `event<T>` only if it returns something on the spine.

```agape
sync int   double(int x)            { return x * 2; }                 // sync, bare int
sync bool  over(Credence<bool> c)   { return decide(c, > 0.9); }      // sync; decide is somatic
Credence<bool> about_poker(text x)  {                                 // async, graded judgment
    Credence<bool> c = self <- f"is {x} a game of poker?";
    return c;
}
```

`decide` is somatic (§13). The cognition is in producing the `Credence` (the seam send
bound to a `Credence` slot, which is async); applying a threshold/margin to a `Credence`
value is pure comparison. So a `sync` function may take a `Credence` and `decide` it; the
judgment is agentic, the collapse is somatic, and the decision is deterministic given the
`Credence` (§15.5). A `sync` function may likewise `emit`, and may `verify` a `Credence`
value in hand (decide+emit, no seam); it may not `verify … by p` (identity seam = async)
and may not make a tool call (§6b).

---

## 5. Agents

### Declaration (template)
```agape
agent NAME ( [TYPE PARAM] , ... ) [grants { CAP , ... }] {
    FIELD_DECLS          // event<T> slots, etc.
    CONSTRUCTOR_STMTS    // run at first awake
    when (SUBJECT) { ... }
    on awake { ... }
    on sleep { ... }
}
```

- `agent` is a template (like a class). A field `event<T> name;` is a typed slot.
- The `( TYPE PARAM , … )` list declares the constructor parameters; they are bound at
  `awake`, not `spawn` (see Lifecycle).
- `self` is the agent's reference to itself.
- `extend PARENT(args);` (first statement) is composition/inheritance.
- `grants { ... }` (optional) declares the agent's authority (§13).

### Lifecycle
Each transition is a spine event. The lifecycle separates coming into existence from
announcing into existence:

- **`spawn TYPE name;`** — allocate only. Bring the instance into existence: give it an
  address, perform runtime-level validation of its connections. It runs no constructor,
  reaches no cognition, binds no constructor arguments, and opens no mailbox. Appends
  `Spawned(name)`.
- **`awake name(args);`** — announce and initialize. Bind the constructor parameters to
  `args`, open the mailbox, and on the first awake append `AgentAwake(name)` and run the
  constructor body. The `on awake` hook runs on every awake; the constructor body runs
  only on the first. `awake name;` (no parens) is permitted when the agent has no
  constructor parameters, or as the re-awake of an already-constructed agent: a subsequent
  `awake name;` re-opens the mailbox and runs the `on awake` hook only — it does not
  re-bind arguments and does not re-run the constructor.
- **`sleep name;`** — close the mailbox; run the `on sleep` hook; a slept agent with no
  live references is collected. A collected agent is re-entered by a fresh `spawn`/`awake`;
  a still-referenced slept agent is re-entered by `awake name;`.

**Sending to a non-awake agent.** An agent that is not awake has no mailbox, so a send to
it is lost (it never `Delivered`, §6) — not an error. The compiler emits a warning (not an
error) when it can statically prove a send is dead.

### `extend` — inheritance
`extend PARENT(args);` (first statement) is composition/inheritance. A child inherits the
parent's fields, constructor, `when` blocks, and `on awake` / `on sleep` hooks; the
parent's constructor runs (with `args`) before the child's constructor body, and inherited
`when`/hooks fire for the child. Authority is subtractive: a child's `grants` must be a
subset of the parent's (§13).

### Lifecycle hooks vs `when`
`on awake` / `on sleep` are hooks tied to the agent's own transitions; `when (X)` is a
general spine subscription keyed by an arbitrary subject `X` (§7).

### §5b — `prompt`: the external input boundary

```agape
prompt text question;          // opens a standing external input SENSOR
```

`prompt TYPE name;` declares an external input source — the push mirror of the pull send
`<-`. Each external arrival lands a `Prompt` event on the spine with subject `name`. React
with `when (name)`.

- A `prompt` source makes a program always-on (§0.2): while open it cannot quiesce; when
  it closes (EOF) the program reaches quiescence and ends.
- Its values are external and untrusted, hence `T`-tainted (§13). An external input may
  not reach an `authority` `emit` without passing a gate.
- `prompt` is one of a family of sensors (socket, timer, queue, file watch, and a standing
  tool sensor, §6b), sharing one runtime contract: an external source that appends events
  to the spine as they arrive, so replay folds the recorded input stream deterministically.

---

## 6. Communication — the send operator `<-`

`dest <- message`

- `self <- p` is cognition: a self-send routes through the provider seam — it is how an
  agent thinks. It is the only cognition primitive; the seam is not an agent.
- `other <- p` is inter-agent messaging (IPC): it delivers into another agent's mailbox.
- A typed reply (`event<T> x = dest <- "…";`) is produced through the seam via structured
  output for `T` (§8); binding to a `Credence<E>` slot constrains that output to `E`'s
  variants (§3, §8). For an IPC send, the reply is the recipient agent's bound response;
  for a self-send it is the model's structured output.
- A send is a spine message → its result type is `event<T>`, taint `T`.

### The message lifecycle — `Sent → Delivered → Resolved`
Every send moves through three phases, each an event on the spine, correlated by `corr`:

- **`Sent`** — the send was issued.
- **`Delivered`** — the recipient's mailbox accepted it.
- **`Resolved`** — the recipient produced the bound reply or completed handling.

The only legal traces are prefixes of this chain: `[]`, `[Sent]`, `[Sent, Delivered]`,
`[Sent, Delivered, Resolved]`. This is a safety property (Alpern & Schneider, *Defining
Liveness*, 1985): any non-prefix trace has a finite bad prefix and is a **Violation**.
Each phase's precondition is its predecessor (Lamport's happens-before, 1978): `Delivered`
requires `Sent`, `Resolved` requires `Delivered`.

### Loss — a stalled prefix, never an event
A send issued but never `Delivered` is lost. Loss is the absence of `Delivered`, not an
event: it is unmet liveness, which is not a violation. Loss is monotonic and revisable;
orphaned (lost) sends are found by query (§10): the sends whose maximum recorded phase is
below `Delivered`. The default delivery contract is at-most-once; a reliable, ordered
channel is an explicit per-channel opt-in.

### Expiry — an optional tombstone
A send may carry a lifetime: `dest <- message expires N;`. Expiry adds a second terminal
branch:

```
Sent ─┬─→ Delivered ─→ Resolved
      └─→ Expired
```

An `Expired(corr)` event is a tombstone. After `Expired`, a `Delivered` for the same
`corr` is illegal (a Violation), and a late physical arrival is refused and recorded as a
separate, synchronous `DeliveryRefused(corr)` event on its own `corr` that references the
expired one. A logical-tick lifetime is purely deterministic; a wall-clock lifetime is
nondeterministic and must be journaled (§15.4.2).

### Delivery timing is a transport property
`Delivered` is always explicit; it is never collapsed away. Whether `Sent → Delivered`
completes within one tick is a property of the transport (local-reliable = synchronous,
same-tick; distributed = may span ticks) — the synchronous-vs-asynchronous system-model
distinction (Lynch, *Distributed Algorithms*).

---

## 6b. Tools — the world seam

Cognition is reached through the provider seam; accountability through the identity seam;
the world is reached through the tool seam. A **tool** is a declared, typed,
capability-gated effect — a file read, an HTTP call, a database query, a payment API, or
heavyweight computation Agape does not express natively. Tools are the controlled-FFI
surface: Agape does not link arbitrary foreign code. The tool seam speaks the **Model
Context Protocol (MCP)** — an enumerated, declared, permissioned tool-call protocol — so a
program imports the MCP tool ecosystem as capabilities without inventing its own ABI.
Tools form an enumerated capability surface (cf. eBPF helper functions: a fixed set of
approved calls, never arbitrary linkage).

```agape
tool search(text query) -> text;             // declares a tool capability, signature typed
tool transfer(int amount, text to) -> bool;  // resolved by config to an MCP server (§16)

agent Researcher grants { use search } {
    text hits = search("agape language");    // a tool call: needs `use search`
}
```

- **Declaration.** `tool NAME(params) -> RET;` declares the capability and its type. The
  binding to a concrete MCP server/endpoint is configuration (`[tools]` in the manifest,
  §16); no endpoint or secret appears in source, exactly as `<-` names no model. An
  undeclared tool call is a `TypeError`.
- **Authority.** A tool call requires a `use NAME` capability in the agent's `grants`
  (§13). Default-deny applies: no `grants` ⇒ no tool calls. `use` is subtractive under
  `extend`, like `emit` and `reach`.
- **Color.** A tool call reaches the tool seam → async (`A`). A `sync` function may not
  call a tool.
- **Taint.** A tool result is external and untrusted → `T`-tainted, exactly like a
  cognition reply or a `prompt` arrival. To drive a consequential action it must pass a
  gate. The membrane governs all three untrusted origins uniformly: provider, input
  boundary, and tool.
- **Spine.** A tool call appends a correlated `ToolStarted(NAME)` / `ToolResolved(NAME)`
  pair (§7). Every world-effect is on the log, so the spine is a complete, replayable
  account of what the program did to the world, not only what it thought.
- **Replay.** A tool result is an external observation and is journaled (§15.4.2) like an
  oracle output; replay re-serves it from the recording and never re-invokes the tool. A
  side-effecting tool is replayed as its recorded result.
- **Standing tool sensors.** A tool may be opened as a push sensor (a subscription, a
  socket, a file watch) rather than a pull call, in which case it behaves like `prompt`
  (§5b): it appends events as they arrive and makes the program always-on.

A tool is not a new trust hole; it is the same membrane discipline (capability + taint +
spine + replay) applied to world-effects. This is what lets the somatic layer be a
general-purpose language reached through a governed boundary rather than reimplemented
inside Agape (§0.1).

---

## 7. The spine, events, `when`, `catch`

### Events
Every meaningful action appends an immutable `Event`: `{ tick, etype, subject, payload,
corr, agent }`. `tick` is system-assigned and monotonic; `subject` is the source the event
is about (the `when`/`catch` correlation key); `corr` links a `Started` to its `Resolved`.

### Subjects: every event has a source
A send `d <- p` produces events with subject `d`; a typed binding `event<T> x = …;` gives
the produced event subject `x`. A gate over a `Credence` produces one event for the
operation (subject = the binding or an ephemeral). A tool call's pair is subjected at the
tool name. A literal operand has an ephemeral address; its event still lands on the spine.

### Async event discipline
A send (`<-`) appends the three-phase `Sent`/`Delivered`/`Resolved` chain (§6). Any other
operation with a pending window that reaches a seam (`embed`, `verify … by p`, a tool
call) appends a `Started`/`Resolved` pair correlated by `corr`. Synchronous ops (`==`,
arithmetic, `decide`, an in-hand `verify`) append a single event or none.

### `when` and `catch` — one mechanism, opposite polarity
Both are spine subscriptions keyed by `(event type, optional subject)`:

- `when (X) { ... }` — fires on the success/resolution events of subject `X`; `when
  EventType(X) { ... }` narrows to a type.
- `catch EventType as e { ... }` — every event of `EventType`, any source; `catch
  EventType(X) as e { ... }` — only those sourced at `X`.

Event-type matching is by subtype (§9). **Subscriptions are prospective and hoisted per
scope**: registered before the scope's statements run, so lexical order between a
subscription and the action it observes does not matter — but a subscription never fires
for an event already on the spine before its scope began. History is reached by query
(§10), never by a subscription. A program that must react to a prior event queries the
spine and acts on the result.

**Multi-handler firing order.** When several subscriptions match one appended event in one
tick, they fire in registration (hoist) order — the order in which they were registered
when their scopes were entered; within a single scope, lexical order. This total order is
part of the semantics so that replay is well-defined.

```agape
Credence<bool> c = self <- f"is {name} 'John'?";
verify c;                                    // emits Verification events (subject: c)
catch FailedVerification(c) as e { ... }     // iff that check decided Fail
catch Contradiction(john) as k { ... }       // any Credence<Entailment> that decided Contradicts at john
catch Error as e { ... }                     // every error, any source (incl. Contradiction)
```

---

## 8. Semantic checking

### The seam
Cognition enters only through the provider seam (`think` / `embed`). Agape source never
names a concrete provider; semantic judgments and structured replies resolve through it;
swapping it changes no source.

### Graded judgments → `Credence<E>`
A semantic judgment is a seam send bound to a `Credence<E>` slot. The slot's enum `E` is
the output schema; the seam is forced to answer inside `E`, and the result is a
distribution over `E`'s variants (the credence).

```agape
Credence<bool> ok        = self <- f"is {x} an approval?";           // over { true, false }
Credence<Entailment> rel = self <- f"does {p} entail {h}?";          // over { Entails, Contradicts, Neutral }
Credence<Ticket> kind    = self <- f"classify this ticket: {body}";  // over a user enum Ticket
```

`Credence<E>` over any user enum is a constrained classifier whose output is taint-tracked
and gate-disciplined. The threshold is not applied here — it lives in the gate's `Rule`
(§13). To use a judgment as a committed value, gate it: `decide(c, r)`.

- On an array operand a judgment decomposes over elements but returns one `Credence<E>`
  for the whole: the parts inform the distribution; the evidence records where a partial
  mismatch was. The result type stays uniform.
- **Mechanism vs policy:** when a gate decides a `Credence<Entailment>` to `Contradicts`,
  the runtime also emits a first-class `Contradiction` event, independent of any `case`,
  so a global `catch Contradiction(subject)` can react.

### Materializing a distribution (cost)
A single seam call already yields the full per-variant distribution. A spread over
repeated judgments — sampling the same question N times — is a separate, heavyweight
operation not in the surface language. A use of `sample` is an unknown-identifier error.
(The stochastic-consistency harness, §15.5.3, samples re-runs externally.)

### Structured output (the seam contract)
- A declared `event<T>` compiles to a JSON Schema; the provider returns schema-conforming
  output via constrained decoding (mandatory; no fuzzy fallback).
- Type → schema: `bool→boolean`, `text→string`, `int→integer`, `float→number`,
  enum→`{type:string,enum:[...]}`, struct→`{type:object,…,additionalProperties:false}`,
  array→`{type:array,items}`. A `Credence<E>` reply is the per-variant token probabilities
  of the constrained decode, calibrated (§3).
- The seam must expose token probabilities for any gated/`Credence` decision.
- On schema failure the runtime raises a clean `TypeMismatch` (catchable, retryable).

---

## 9. The prelude

```
enum Verification { Pass, Fail }                           // decided from a Credence<bool>
enum Entailment   { Entails, Contradicts, Neutral }        // decided from a Credence<Entailment>
type Credence<E>                                           // a graded judgment over enum E (§3)
type Principal                                             // an accountable identity (§3)
struct Rule { threshold: float, margin: float }            // a decision rule (§3)

// Built-in spine events:
//   Event(text)            user progress/info event (via `emit`)
//   Error(text)            ROOT error type (hierarchy below)
//   Verification(subj)     a decided Credence<bool> gate → Successful/FailedVerification
//   Contradiction(subj)    emitted when a Credence<Entailment> decides to Contradicts
//   Attestation(subj)      a human-principal gate (verify … by p)
//   QueryResult(subj)      the event a query STATEMENT lands
//   ToolStarted/ToolResolved   the tool-seam pair (§6b)
//   Spawned / AgentAwake / SleepEvent          lifecycle (§5)
//   Sent / Delivered / Resolved                message lifecycle (§6)
//   Expired(corr) / DeliveryRefused(corr)      message expiry / refused-late-delivery (§6)
//   PromptOpened(name) / Prompt(name)          external input sensor (§5b)
//   <Op>Started / <Op>Resolved                 async seam pairs (embed, verify…by, tool)
```

**Event-type hierarchy.** `Error` is the root; `FailedVerification`, `Contradiction`,
`TypeMismatch`, `RetryExhausted`, `FailedAttestation`, and the lifecycle **Violation**
extend it. `catch`/`when` match by subtype, so `catch Error` catches a `Contradiction`; a
contradiction is an `Error` subtype, and code that wants only faults catches the specific
types. `Expired` and a lost send are not errors.

**`say(x)`** prints its argument; it is not a spine operation.

---

## 10. Memory — three modalities, one unit

Each agent has its own memory:

- **FACTS** → a deterministic table, queried with `select`.
- **RELATIONSHIPS** → a graph, queried with `find ... where`.
- **SEMANTICS** → a vector store, queried with `match`. `match` is a gate: `match { m: q
  } > θ` thresholds similarity, deciding hits against `θ`, and yields `U` (committed) but
  off-spine — like `decide`, it must be `verify`-recorded to authorize a consequential use.

### Internalization
Every event an agent receives (via `<-`) is decomposed through the seam into facts,
relationships, and embeddings written to that agent's memory. Decomposition is
non-deterministic (it is cognition) but its shape is fixed (typed facts; SPO triples over
a typed predicate set).

### Provenance
Every memory cell carries an immutable backpointer to the spine event that produced it;
`find n, origin(n) where { … }` returns the fact and its originating event.

### Taint of queried facts
A queried fact carries the taint of the spine event it traces to (provenance-based).
Because most facts trace to internalized cognition, the default taint of a `find` /
`select` result is `P` (graded — structured but not gate-committed): it may flow through
control flow but must be re-gated before a consequential `emit`. A fact whose origin is an
already-committed (`U`) event carries `U`. `match` hits are `U` but off-spine (a gate,
above). A value's provenance, not its having-been-stored, determines whether it may act.

### Query surface
- **Graph:** `find BINDING [, origin(BINDING)] where { PATTERN };`
- **Facts:** `select COLS from AGENT where { CONDS };`
- **Vector:** `match { BINDING: VECTOR } > THRESHOLD;`
- **Spine:** `select COLS from spine where { CONDS };` — scan the log itself.

Each query has a statement form and an expression form (bound in a declaration, yields its
result set). The statement form lands a `QueryResult(subject)` event, where `subject` is
the query target (the agent name, or `spine`). The expression form lands nothing; it only
reads. A query reads the log; it never re-emits. Replay folds the spine and appends
nothing.

---

## 11. Control flow

### `if` / `else`
The condition is `bool`; `!` is boolean negation. A `Credence<bool>` is not a `bool` — `if
(decide(c, r)) { … }`; a bare `Credence` in an `if` is a `TypeError`.

### `case` — enum pattern matching
```agape
case (EXPR) as e {
    VARIANT_A: { ... }
    default:   { ... }
}
```
- General over any enum; `Entailment`/`Verification`/user enums are the common cases.
- Exhaustiveness is checked at compile time; a non-exhaustive `case` with no `default` is
  an `ExhaustivenessError`.
- If `EXPR : Credence<E>`, `case` decides it first (a default `Rule`, or an explicit `case
  (decide(EXPR, r)) …`): the categorical collapses to the argmax variant if its margin
  over the runner-up clears the rule, else to the abstaining variant (`Neutral` for
  `Entailment`; `Fail` for `bool`). Deciding to `Contradicts` also fires the first-class
  `Contradiction` event (§8). `case` over a pure enum is synchronous.

### `retry` — re-attempts
Bounded block, bounded send-form (a handler runs before each re-attempt), and an unbounded
predicate form `retry(TYPE x: PRED)` — the construct that makes Agape Turing complete.
`retry` is sugar (counter + `catch`, or a loop); bounded exhaustion emits `RetryExhausted`.

---

## 12. Aggregation, pipes, graded combination, and quorum

- `coll |> fn` pipes each element into `fn`. If `fn` is async, `|>` is a concurrent fan-out
  (await-all; no short-circuit).
- `all(...)` / `any(...)` reduce a collection. Over `bool` they are ordinary
  conjunction/disjunction. Over `Credence<bool>` they fuse evidence into a single
  `Credence<bool>` to `decide` once, instead of collapsing each judgment early.

### Fusion must declare its dependence structure
Fusing graded judgments has no assumption-free default. By the Fréchet inequalities, for a
conjunction `p₁…pₙ` the joint is pinned only to an interval, `max(0, Σpᵢ − (n−1)) ≤ p(∧) ≤
min(pᵢ)`, whose value depends entirely on correlation: at independence it is the product
`∏ pᵢ`; at maximal positive dependence, `min(pᵢ)`. Independence is itself a specific
assumption, not the absence of one. The dependence structure of any fused set must be
declared:

```agape
independent c1, c2, c3;           // assert these judgments' errors are uncorrelated
dependent   c4, c5;               // assert these are correlated (e.g. share a source)
Credence<bool> ok = all(c1, c2, c3, c4, c5);
```

- **`independent v…`** — fusion is log-odds addition (Good's weight of evidence;
  naive-Bayes combination): confidence accumulates — several independent confirmations
  fuse higher than any one.
- **`dependent v…`** — fusion takes the conservative Fréchet bound (`min` for conjunction,
  `max` for disjunction): confidence does not accumulate, capped at the weakest link.
- **No default.** Aggregating two or more `Credence` values with no dependence declaration
  covering every pair is a compile error (`TypeError`). Coverage must be total.
- **Mixed sets** compose by the declarations: each `dependent` cluster is fused
  conservatively first, then cluster results combine by the independent rule.

This is the only operation Agape offers over graded values: forward evidence fusion before
the single gate — not general inference (no `observe` / conditioning / `bind`). Fusion
lives entirely in the credence tier (`P → P`); only the gate crosses `P → U`. Independence
is an asserted, unverified claim, recorded on the spine so an over-confident outcome traces
back to the assertion that licensed it. Calibration is the seam's job (§3), not fusion's.

### Quorum
A single non-deterministic judgment can flip run-to-run (its margin bounds the flip
probability, §15.5.5). Multiple judgments that agree flip less often (Condorcet's jury
theorem: independent judges better than chance, combined by majority, have error that
collapses as their number grows). `quorum` expresses this:

```agape
independent j1, j2, j3;                          // diverse judges/evidence
Credence<bool> agreed = quorum(2 of j1, j2, j3); // graded "at least 2 of 3 commit"
verify agreed;                                   // decide the fused quorum once
```

- **`quorum(k of c1, …, cn)`** fuses `n` `Credence<bool>` judgments into a single
  `Credence<bool>` for the proposition "at least `k` of the `n` commit," combined under the
  declared dependence structure. It is a thresholded reduction over the same fusion algebra
  as `all`/`any`; the same total-coverage declaration requirement applies.
- Fusing independent judgments tightens the Stability bound (§15.5.5): the fused margin
  exceeds any single judge's, so `β(δ_fused) ≤ β(δᵢ)`.
- The amplification holds only to the extent the judges' errors are uncorrelated. `n`
  calls to the same model with the same prompt have correlated errors and gain little,
  which is why `quorum`, like all fusion, requires an explicit `independent`/`dependent`
  declaration, and why robustness comes from diverse judges (different models, framings,
  evidence). Declaring `independent` over same-source judges is a programmer error the
  spine records but the type system cannot detect.
- `quorum` is single-runtime evidence fusion, not a consensus protocol (Paxos/BFT); those
  tolerate faults across mutually-distrusting nodes, a concern that arises only at the
  optional distributed-spine boundary (§15.4.2a).

---

## 13. Capabilities and governance

Five properties are bounded by the compiler, not hoped for at runtime: authority, taint,
color, tool use, and the gate that connects them. The formal rules are §15.3.

### Authority (`grants`)
An agent's `grants` clause is its total authority: the events it may `emit`, agents it may
`reach`, and tools it may `use` (§6b). Acting outside it is a compile error. Capabilities
are subtractive under `extend`. `authority Transfer;` (top level) marks a declared event
type consequential — emitting it engages the taint rule below.

```agape
grants { emit Transfer, reach Worker, use search }   // concrete capabilities
grants { * }                                          // the explicit unconstrained opt-out
```
A grant entry is `emit NAME` (may emit event type `NAME`), `reach NAME` (may send into
agents of type `NAME`), or `use NAME` (may call tool `NAME`).

**Default is deny.** No `grants` clause ⇒ emit/reach/use nothing (fails closed). The only
escape hatch is the explicit `grants { * }` (unconstrained, lattice top, visible in source
and spine). `reach` covers every agent-typed binding (parameter, `spawn` result, any
variable of agent type), not only parameters.

### Taint — the three-level lattice
A value's taint records how trusted its origin is: `U ⊑ P ⊑ T` (§15.3.1).

- `<-` (raw reply), `prompt`, a tool result (§6b) → `T` (raw / untrusted).
- a seam send bound to a `Credence<E>` slot → `P` (a graded judgment); a queried fact
  defaults to `P` (§10).
- a gate → `U` (committed).

Taint is contagious upward; only a gate moves toward `U`. A `Principal` is `U`.

### The gate — `decide`, `verify`, and the untaint/authorize split
Two separate properties travel with a gated value:

- **Untaint** (a value property): the value is no longer raw cognition.
- **Authorization** (a provenance property): the untainting is recorded on the spine,
  hence checkable.

```agape
bool b = decide(c, > 0.9 margin 0.1);     // collapse a Credence<bool>; UNTAINTS; off-spine; somatic
verify c [by r];                           // = decide(c, r) + emit Verification ; UNTAINTS + AUTHORIZES
verify memo by alice;                      // human gate: alice attests ; UNTAINTS + AUTHORIZES
```

- **`decide(e, r)`** collapses a `Credence<E>` to a committed variant by a `Rule` `r`. It
  clears taint (`P → U`) and is color-`S` (somatic). A `decide` result is untainted but
  off-spine: it may drive control flow, not a consequential action. `decide`'s rule is
  mandatory.
- **`verify e [by r]`** ≝ `decide` + `emit Verification`. Over an in-hand `Credence` it is
  synchronous (decide+emit, no seam — permitted in `sync`); the inline `verify (self <-
  "…")` form is async (the send reaches the seam). The emitted event is the authorization
  token.
- **`verify e by p`** (`p : Principal`) is the human gate: it calls the identity seam,
  obtains `p`'s signed decision, and emits an `Attestation { who, what, decision,
  signature }`. It is async. On approve, `e` is `U` + authorized; on reject, a
  `FailedAttestation` is emitted and `e` is not cleared.

**The consequential-action rule.** An `authority` `emit` may consume a value only if it is
`U` and authorized (cleared by a recorded gate — `verify`/`verify…by`, not a bare
`decide`) — and, if the gate carried a margin, only if `margin ≥ m`. The authorization
requirement is static (the type system rejects a bare-`decide` value at a consequential
emit); the margin-floor `m` check is runtime: `margin(e) ≥ m` is checked against the
realized judgment's margin at the emit, with `m` supplied by the manifest (`[runtime]
consequential_margin`, §16). A judgment below `m` fails the gate and is the typed trigger
for human escalation (`verify e by p`).

**The `by` clause** is the gate parameter, polymorphic by the operand's type: `by <Rule>`
(or a bare `FLOAT`) selects the model/structural basis; `by <Principal>` selects the
human/accountability basis. The emitted event records which basis cleared the taint.

**Loss direction.** Whether a false accept or a false reject is costlier is a property of
the action's loss function, declared per consequential event type. `m` sets how confident
the gate must be; the loss-direction declaration sets which way to fail when it is not.
Absent a declaration, a consequential gate fails closed.

### The identity seam
A `Principal` is reached through an identity seam mirroring the provider seam. `verify e by
alice` is a send to a human — async, like cognition. Authenticating that alice is alice is
a runtime/somatic concern; the language has the `Principal` type and the `by` gate, and
trusts the seam as it trusts the provider. Attestation is a capability: `verify e by p` is
well-formed only if `p` holds the authority to attest in the relevant domain (W-Attest,
§15.3.3).

### The three seams, one discipline
| seam | oracle | a "send" returns | color | taint of result |
|------|--------|------------------|-------|-----------------|
| provider | a model | a cognitive reply (`self <- p`) | `A` | `T` (raw) / `P` (Credence slot) |
| identity | a principal | a signed attestation (`verify … by p`) | `A` | `U` (authorized) |
| tool | the world (MCP) | a tool result (`name(args)`) | `A` | `T` (raw) |

All three are external, non-deterministic, journaled, and swappable by config. The
membrane — capability + taint + spine + gate — is identical across them.

### Provenance
Authority (including tool use) is bounded at compile time, cognition is decided-and-
recorded before it acts, and every fact's provenance is auditable on an append-only spine.

---

## 14. Invariants the implementation must preserve

**Foundational** — the log is the source of truth; external capability (cognition,
identity, world/tools) enters only through a seam; no hidden runtime (every sugar
desugars).

**Type & effect** — `sync` is the marked color and cannot reach a seam (including a tool
call), though it may `emit` and `verify` an in-hand `Credence`; `event<T>` marks spine
presence; a seam send bound to a `Credence<E>` slot yields a graded judgment, never a
committed value; `decide` is somatic and untaints, `verify` = `decide` + emit, and only an
on-spine gate authorizes a value for a consequential emit; fusion of two or more
`Credence`s (including `quorum`) requires a total `independent`/`dependent` declaration;
`verify … by p` takes a `Principal` (no `text → Principal`); user `struct`/`enum`/`event`
types are explicitly declared; a `tool` call requires a `use` grant and yields a
`T`-tainted result; authority, taint (three-level), color, and tool-use are checked
statically and interprocedurally; a violation is a compile error.

**Runtime** — ticks are system-level; structured output uses constrained decoding;
subscriptions are prospective and hoisted (never retroactive), and history is reached by
query; multi-handler firing is registration-order; a message trace is a prefix of
`Sent→Delivered→Resolved`; every memory write carries a provenance backpointer; all three
seams journal their oracle/tool results to the spine for replay (§15.4.2); the margin floor
`m` is enforced at the consequential emit.

---

# 15. Formal Semantics

> The source of truth: the abstract grammar, a static (type + effect) semantics, a dynamic
> (operational) semantics with the spine as explicit state, and the reproducibility model.
> Where §0–§14 and §15 conflict, §15 wins.

## 15.0 Modeling choices
- Two qualifiers travel with every expression. Color `c ∈ {S, A}` (does it reach a seam?)
  and taint `t ∈ {U, P, T}` (how cognition-derived is the value?). A gate has color `A`
  when its judgment touched the seam, but `decide`/in-hand-`verify` on a `Credence` value
  is `S`.
- Authorization is a runtime provenance property checked at the consequential-emit site;
  modeled as a predicate `auth(·)`.
- Authority is a property of the agent context (its `grants`, including `use`).
- The three seams (provider, identity, tool) are the only sources of dynamic
  non-determinism, modeled as oracle relations (§15.4.2).

## 15.1 Notation
```
c ∈ {S,A}   color   (S ⊑ A)        t ∈ {U,P,T}   taint   (U ⊑ P ⊑ T)
Γ           x ↦ (T, t)             r : Rule       a decision rule {threshold, margin}
Σ           agent signatures       A              event-type names declared `authority`
G           grants set incl. ("emit",E) ("reach",D) ("use",K)
auth(v)     v's untaint is spine-recorded (true only via verify / verify…by)
```
Judgment **`Γ; Σ; A ⊢ e : T ! c · t`**.

## 15.2 Abstract syntax (EBNF)

```
program   ::= decl*
decl      ::= typedecl | authority | tool | agent | fn | stmt
typedecl  ::= "struct" Ident "{" field ("," field)* "}"
            | "enum" Ident "{" Ident ("," Ident)* "}"
            | "event" Ident "(" field ("," field)* ")" ";"   // custom spine event
field     ::= type Ident                                     // "name: T" also accepted
authority ::= "authority" Ident ";"
tool      ::= "tool" Ident params ("->" type)? ";"           // tool-seam capability
agent     ::= "agent" Ident params grants? "{" abody* "}"
grants    ::= "grants" "{" ( "*" | cap ("," cap)* ) "}"
cap       ::= "emit" Ident | "reach" Ident | "use" Ident
abody     ::= extend | on | stmt
extend    ::= "extend" Ident args ";"
on        ::= "on" ("awake"|"sleep") block
fn        ::= "sync"? type Ident params block          // async is the default
params    ::= "(" (type Ident ("," type Ident)*)? ")"
type      ::= "int"|"float"|"bool"|"text"|"null" | "event" "<" type ">"
            | "array" "<" type ">"                     // collection (query results, fan-out source)
            | "Credence" "<" type ">"                  // graded judgment over enum
            | Ident                                    // enum/struct/agent names, incl. Principal, Rule

stmt      ::= vardecl | assign | spawn | prompt | principal | depdecl
            | "awake" Ident args? ";" | "sleep" Ident ";"
            | "emit" Ident "(" expr ")" ";"
            | "verify" gatearg ("by" expr)? ";"
            | "say" "(" expr ")" ";" | "return" expr? ";"
            | "if" "(" expr ")" block ("else" block)?
            | when | catch | case | retry
            | find | select | match
            | expr ";"
vardecl   ::= type Ident ("=" expr)? ";"
assign    ::= (Ident | "self" "." Ident | postfix) "=" expr ";"
spawn     ::= "spawn" Ident Ident ";"                  // allocate only (args bound at awake)
prompt    ::= "prompt" type Ident ";"
principal ::= "principal" Ident ";"
depdecl   ::= ("independent"|"dependent") Ident ("," Ident)* ";"
when      ::= "when" Ident? "(" expr ")" block
catch     ::= "catch" (Ident ("(" expr ")")? | "(" expr ")") "as" Ident block
case      ::= "case" "(" expr ")" "as" Ident "{" (Ident ":" block)* ("default" ":" block)? "}"
retry     ::= retrytail
find      ::= "find" Ident ("," "origin" "(" Ident ")")? "where" "{" triple* "}" ";"
select    ::= "select" (Ident ("," Ident)* | "*") "from" Ident "where" "{" cond* "}" ";"
match     ::= "match" "{" Ident ":" expr "}" ">" Number ";"

retrytail ::= "retry" "(" Int ")" block
            | "retry" "(" type Ident ":" expr ")"

expr      ::= expr "<-" expr ("expires" Number)? retrytail?   // send; optional lifetime
            | expr "|>" expr                            // pipe
            | "decide" "(" expr "," rule ")"            // gate: collapse a Credence
            | "verify" gatearg ("by" expr)?             // verify gate (expr form)
            | "quorum" "(" Int "of" expr ("," expr)* ")"  // quorum over Credence<bool>
gatearg   ::= cmp | expr                                // a Credence expr, ==, bool, or a value (by p)
rule      ::= cmpop Number ("margin" Number)? | expr    // sugar FLOAT→Rule; or a Rule value
cmp       ::= add (("=="|"!="|"<"|">"|"<="|">=") add)?
add       ::= mul (("+"|"-") mul)*
mul       ::= unary (("*"|"/") unary)*
unary     ::= "!" unary | postfix
postfix   ::= primary ("." Ident | args | "[" expr "]")*
primary   ::= Int|Float|String|FString|"true"|"false"|"null"|"self"|Ident
            | "all" args | "any" args | "(" expr ")"
            | Ident "{" (Ident ":" expr ("," Ident ":" expr)*)? "}"  // struct literal
            | "[" (expr ("," expr)*)? "]"               // array literal
```

**Collections.** `array<T>` is the collection type *produced* by queries (`find`, which may
bind many results) and *consumed* by fan-out (`|>`, `all`/`any`, `quorum`, §12). It is a
value to map and reduce over — not an imperative data structure. Agape has no general-purpose
imperative substrate of its own; heavy or world-affecting computation is imported as a tool
(§6b) and governed at the tool seam, never reimplemented in the language.

## 15.3 Static semantics

### 15.3.1 Qualifier lattices
`color: S ⊑ A`. `taint: U ⊑ P ⊑ T`. `⊔` is the join; both contagious upward unless a gate
rule overrides taint.

### 15.3.2 Expression rules (selected)
```
Γ ⊢ d : Agent   Γ ⊢ p : Text                    // self-send = cognition; other-send = IPC
──────────────────────────────  (T-Send)        Γ ⊢ (d <- p) : T_reply ! A · T

Γ ⊢ d : Agent   Γ ⊢ p : Text    E an enum
─────────────────────────────────────────────  (T-Credence)
Γ ⊢ (Credence<E> _ = d <- p) : Credence<E> ! A · P

Γ ⊢ aᵢ : Tᵢ      tool K(T₁..Tₙ) -> R declared      ("use",K) ∈ G ∨ G = {*}
─────────────────────────────────────────────────────────────────────────  (T-Tool)
Γ ⊢ K(a₁..aₙ) : R ! A · T            // tool call: async, T-tainted; ILL-FORMED if use not granted

Γ ⊢ e : Credence<E> ! c · _    r : Rule
──────────────────────────────────────  (T-Decide / GATE, somatic)
Γ ⊢ decide(e, r) : E ! c · U            // taint → U; color inherited; rule MANDATORY

Γ ⊢ e : Credence<Bool> ! S · _    r : Rule       // in-hand Credence: synchronous
─────────────────────────────────────────────  (T-Verify-InHand / GATE, recorded, sync)
Γ ⊢ (verify e by r) : event<Verification> ! S · U   with auth := true

Γ ⊢ e : T' ! _ · _    Γ ⊢ p : Principal    p may-attest dom(e)
──────────────────────────────────────────────────────────────  (T-Attest / GATE, recorded, async)
Γ ⊢ (verify e by p) : event<Attestation> ! A · U    with auth := true

Γ ⊢ cᵢ : Credence<Bool> ! cᵢ_col · P    dep-declared(c₁..cₙ)
──────────────────────────────────────────────────────────────  (T-Fuse)   // all/any/quorum
Γ ⊢ fuse(c₁..cₙ) : Credence<Bool> ! (⊔cᵢ_col) · P
        // ILL-FORMED if any pair in {c₁..cₙ} is neither independent- nor dependent-declared
```
The GATE rules are the only routes to `U`. T-Tool is the third seam: a tool call is async,
`T`-tainted, and requires a `use` grant. T-Verify-InHand is synchronous (no seam); the
inline-seam form inherits `A` from its `<-`. T-Fuse (covering `quorum`) requires total
dependence coverage.

### 15.3.3 Statement & agent well-formedness — the guarantees

**Effect signatures (interprocedural).** Each `f` carries `Φ(f) = (c_f, ρ_f, κ_f)`:
- `c_f ∈ {S,A}` — `A` if its body reaches any seam (including a tool call) or calls any
  `A`-colored `g`; else `S`. A `sync`-declared `f` asserts `c_f = S`.
- `ρ_f` — taint-transparent parameters (taint flows to the result, three-level).
- `κ_f` — consequentially-consumed parameters (fed into an authority emit/reach, or a
  `use` tool whose result is consequentially consumed).

`Φ` is the least fixpoint over the call graph; a builtin is `(A, ∅, ∅)` unless modeled.

```
// COLOR — interprocedural (a tool call forces A):
c_f = S
──────────────────────────────────────  (W-SyncSeamFree)
⊢ f  ok    // body reaches no seam (no <-, no Credence-slot, no verify…by, NO tool call) AND calls only S fns

// AUTHORITY — emit / reach / use (DEFAULT-DENY):
allowed(C,kind,X) ⟺ G ≠ ⊥ ∧ ((kind,X) ∈ G ∨ G = {*})
──────────────────────────────────────────────────────────  (W-Auth)
in C:  ⊢ emit E(e) ok ⟺ allowed(C,"emit",E)
       ⊢ (x <- p) ok ⟺ x = self ∨ allowed(C,"reach",typeof(x))
       ⊢ K(a…)   ok ⟺ allowed(C,"use",K)

// AUTHORITY — subtractive extend:
agent C extends P
──────────────────────  (W-Extend)
grants(C) ⊆ grants(P)        // ⊥ ⊆ G ⊆ {*}; covers emit/reach/use uniformly

// THE CONSEQUENTIAL-ACTION RULE (static authorization; runtime margin):
E ∈ A     Γ ⊢ e : _ · t     ¬( t = U ∧ auth(e) )
──────────────────────────────────────────────────────────────  (W-Emit-Reject-static)
emit E(e)  is ILL-FORMED                       // a bare decide (t=U, ¬auth) rejected at COMPILE time
// at runtime additionally:  margin(e) ≥ m_E   else the emit faults

// ATTEST capability:
Γ ⊢ p : Principal    p may-attest D    e in domain D
──────────────────────────────────────────────────  (W-Attest)
⊢ (verify e by p)  ok

// CALL — taint transfer and consequential-arg rejection:
Γ ⊢ aᵢ : _ ! _ · tᵢ        t_result = ⊔ { tᵢ : i ∈ ρ_f }
∀ i ∈ κ_f.  tᵢ = U ∧ auth(aᵢ)
──────────────────────────────────────────────────────────────  (W-Call)
Γ ⊢ f(a₁..aₙ) : T ! c_f · t_result     // ILL-FORMED if some i∈κ_f is not U-authorized
```

The authorization half of the consequential rule is static (W-Emit-Reject-static); the
margin floor is runtime.

## 15.4 Dynamic semantics

### 15.4.1 Runtime configuration
`⟨ Π | Ψ | Ω | Â | μ | S | k ⟩` — provider `Π`, identity `Ψ`, tool `Ω`, agents `Â`, memory
`μ`, spine `S` (append-only, `tick(S)=|S|`), continuation `k`.

### 15.4.2 The seams as oracles (where stochasticity lives)
```
think  : Π × Prompt × Schema  ⇝  Value × Π             (provider seam; NON-deterministic)
attest : Ψ × Principal × Value ⇝  Decision×Sig × Ψ      (identity seam; external, auditable)
invoke : Ω × Tool × Args      ⇝  Value × Ω              (tool seam; external, effectful)
```
All three oracles' results are journaled to the spine as produced (`ThinkResolved` /
`Attestation` / `ToolResolved`). Replay never re-invokes an oracle or a tool: it serves
each from the recording in order — a side-effecting tool is replayed as its recorded
result, not re-run. The spine is hash-chained, so a faithful replay regenerates an
identical chain — chain-head equality is the proof of replay-equivalence.

### 15.4.2a The spine as an audit log — consensus, forking, forensics
The spine is a hash-linked, append-only log (a Merkle-style commitment), so immutability
and auditability hold by construction. This is the transparency half of a blockchain; the
consensus half is absent: a single Agape runtime is the authority that assigns ticks, so
consensus is pure overhead. Consensus becomes load-bearing only at one boundary — multiple
mutually-distrusting runtimes sharing one spine — and is therefore an optional
distributed-spine layer, never the core. (This is distinct from `quorum`, §12, which is
single-runtime evidence fusion, not multi-node agreement.) Counterfactual/forensic replay
(Jefferson's *Time Warp*, 1985) and fork/merge are scoped to an optional Multi-verse
library.

```
// DECIDE — somatic collapse; no oracle; single (or no) event:
v' = collapse(eval(e), r)        // argmax/threshold; below margin ⇒ abstain (Neutral / Fail)
─────────────────────────────────────────────  (E-Decide)
⟨…|S| decide(e, r) ⟩ → value v', spine S        // off-spine; auth(v') = false

// VERIFY (in-hand Credence) — decide + record; synchronous; single event:
v' = collapse(eval(e), r) ;  ev = v'=Pass ? SuccessfulVerification : FailedVerification
─────────────────────────────────────────────  (E-Verify)
⟨…|S| verify e by r; k⟩ → ⟨…| append(S, ev(src)) | k⟩      // auth := true; no Started/Resolved pair

// VERIFY … BY p (human gate) — identity seam + record; async pair:
(Ψ, p, eval(e)) ⇝ (decision, sig, Ψ')
─────────────────────────────────────────────  (E-Attest)
⟨…|Ψ|S| verify e by p; k⟩ → ⟨…|Ψ'| append(S, Attestation(who:p,what:eval(e),decision,sig)) | k⟩

// TOOL CALL — tool seam + record; async pair; result T-tainted:
("use",K) granted    (Ω, K, eval(a…)) ⇝ (v, Ω')
S' = append(append(S, ToolStarted(K)), ToolResolved(K, v))
─────────────────────────────────────────────  (E-Tool)
⟨…|Ω|μ|S| x = K(a…); k⟩ → ⟨…|Ω'|μ[x↦v (taint T)]|S'| k⟩

// SPAWN — allocate only; no args bound, no constructor, no cognition:
Â' = Â[name ↦ { type, awake:false, constructed:false }]
─────────────────────────────────────────────────────────────  (E-Spawn)
⟨…|Â|μ|S| spawn T name; k⟩ → ⟨…|Â'|μ| append(S, Spawned(name)) |k⟩

// AWAKE (first) — bind ctor args, emit AgentAwake, run constructor, hoist subs:
Â(name).constructed = false   Â'' = Â[name.params := eval(args)]
S1 = append(S, AgentAwake(name)) ;  register-hoisted-subs(ctor-body)
─────────────────────────────────────────────────────────────  (E-Awake-1)
⟨…|Â| awake name(args); k⟩ → ⟨…|Â''| run(ctor-body) then on-awake-hook; k⟩   // constructed:=true

// AWAKE (subsequent / re-awake) — re-open mailbox, on-awake hook only:
Â(name).constructed = true
─────────────────────────────────────────────────────────────  (E-Awake-n)
⟨…| awake name; k⟩ → ⟨…| append(S, AgentAwake(name)); on-awake-hook; k⟩   // no re-bind, no re-construct

// SEND (typed binding x : event<T>) — three-phase chain; reply T-tainted:
awake(dest)   (Π, render(p), schema(T)) ⇝ (v, Π')       // self-send routes through Π (cognition)
S' = append³(S, Sent(x,@d), Delivered(x,@d), Resolved(x,v))
─────────────────────────────────────────────────────────────  (E-Send)
⟨Π|…|μ|S| x = (d <- p); k⟩ → ⟨Π'|…|μ[x↦v]|S'| k⟩

// SEND (lost) — dest not awake at delivery: chain stalls at Sent:
¬awake(dest)
─────────────────────────────────────────────────────────────  (E-Send-Lost)
⟨…|S| x = (d <- p); k⟩ → ⟨…| append(S, Sent(x,@d)) | k⟩         // no Delivered; queryable orphan

// EXPIRE — lifetime elapses before Delivered: tombstone:
Sent(corr) ∈ S   ¬Delivered(corr)   lifetime(corr) elapsed
─────────────────────────────────────────────────────────────  (E-Expire)
⟨…|S| … ⟩ → ⟨…| append(S, Expired(corr)) | … ⟩

// EMIT:
─────────────────────────────────────────────────────────────  (E-Emit)
⟨…|μ|S| emit E(e); k⟩ → ⟨…|μ| append(S, E(subj, eval(e))) | k⟩

// QUERY (statement form) — reads the log, lands a QueryResult:
─────────────────────────────────────────────────────────────  (E-Query-Stmt)
⟨…|μ|S| select … from G where {…}; k⟩ → ⟨…| append(S, QueryResult(G)) | k⟩   // expr form appends nothing

// SUBSCRIPTIONS — prospective, hoisted, registration-ordered:
on scope entry:  register every when/catch in the scope (before its statements run).
on append(S, ev'): for each live sub (in REGISTRATION order) with matches(sub, ev'): fire once.
matches(sub, ev) ⟺ subtype(ev.etype, sub.etype) ∧ (sub.subj = ⊥ ∨ sub.subj = ev.subj)
// A subscription NEVER fires for an event with tick < its registration tick.

// SUBJECTS:
src(x)=x   src(self)=current agent   src(d<-p)=binding name else @vN   src(composite)=@vN
```

## 15.5 Reproducibility, consistency, idempotency

### 15.5.1 Observable outcome vs incidental trace
For a terminal spine `S`, the observable outcome `obs(S)` is the subsequence of committed
events: authority emits (`E ∈ A`), verification verdicts and attestations, `case`-selected
variants, and top-level bindings of bounded type. It excludes the incidental trace:
`Think*` payloads (the wording), `say` output, internalized memory text, raw tool-result
payloads not yet gated, graded `Credence` distributions no gate committed, and raw
`event<text>` replies that never reach a committed event.

### 15.5.2 Observational equivalence `≈`
```
≈_Bool, ≈_Int, ≈_Null, ≈_Entailment, ≈_Verification, ≈_AgentId  :=  structural equality
≈_Text                                                        :=  sim(a,b) ≥ θ   // bounded
≈_record / ≈_list                                            :=  componentwise / pairwise ≈
```
`R1 ≈ R2` iff `obs(R1)`, `obs(R2)` are equal-length and pairwise `≈_τ`-related.

### 15.5.3 Stochastic consistency
`P` is stochastically consistent for provider `𝒫`, inputs `I` iff `∀ R1,R2 ∈ runs(P,I,𝒫).
R1 ≈ R2`. Testable by sampling N runs (§15.5.5 makes the bound quantitative: flip
probability `≤ Σⱼ β(δⱼ)`).

### 15.5.4 Idempotency
`P` is idempotent iff its committed outcome is a function of `I` up to `≈`. The language
guarantees the decision is a stable function of gated inputs; exactly-once delivery is a
sink property (dedup by key).

### 15.5.5 Gates collapse stochasticity — margin-quantified Stability
**Margin.** For a binary gate at threshold `τ`, the margin of judgment `p` is `δ = |p −
τ|`; for a multi-class gate, the gap between the top and runner-up variant. A decision
flips between runs only if run-to-run variation in `p` exceeds `δ`: big margin ⇒ stable,
small margin ⇒ fragile.

A committed `U` value is one of two kinds:

- **exactly-gated** — a finite-schema verdict chosen with high margin. The model is forced
  to answer inside a small fixed set (a `bool`, a verdict enum — constrained decoding, §8)
  and answers confidently (large `δ`). The wording still varies; the bounded choice does
  not.
  > ⚠ This is not string-matching free text. `verify (reply == "approved")` compares model
  > prose to a literal — it flips almost every run and is not exactly-gated. The exact gate
  > is over a bounded judgment — bind the reply to a `Credence<bool>` slot ("is this an
  > approval?") and `verify` that. `==` is exactly-gated only when both operands are already
  > bounded/committed.
- **bounded-gated** — a low-margin verdict, or one carrying open `Text` / a raw tool
  result. Reproducible only up to the margin. The lint (§15.7) flags a consequential value
  cleared only this way; the lint is advisory, not part of the hard conformance bar.

**Oracle model (assumption O).** Fix `𝒫`. For a given `(Π, prompt)` the seam's graded
output is a random variable whose scalar confidence has bounded variance, and two
independent draws satisfy `P(|p₁ − p₂| > δ) ≤ β(δ)` for some nonincreasing `β` with `β(δ) →
0` as `δ →` maximal. For a finite-schema reply via constrained decoding the draw
concentrates, so `β(δ_max) = 0`.

**Lemma 1 — Factoring (non-interference with declassification).** For well-typed `P`,
`obs(P,I) = F(I, d)` is a deterministic function of inputs `I` and the gate-outcome
sequence `d`, independent of every incidental (`T`/`P`) value.
> *Proof.* Read taint as an IFC lattice: `T`,`P` = high, `U` = low; gates are the only
> declassifiers (`P → U`). By W-Emit-Reject-static and W-Call, every constituent of `obs`
> is `U`, hence `I`, a gate outcome `dⱼ`, or a pure `S`-function of these.
> Progress+preservation (§15.6) preserves the invariant under `→`. Non-interference modulo
> delimited release (Sabelfeld–Myers; Sabelfeld–Sands). The tool seam adds no new
> declassifier: a tool result is `T` and reaches `obs` only through a gate, so it is covered
> by the same argument. ∎ *(The two-run bisimulation is the mechanization obligation,
> §15.7.)*

**Lemma 2 — Per-gate flip bound.** For a gate with margin `δⱼ`, the probability its
outcome differs between two fixed-`𝒫` runs is `≤ β(δⱼ)`. For an exactly-gated outcome,
`β(δⱼ)=0`. **Fusion corollary (§12):** the fused margin of `n` `independent` judgments
exceeds each `δᵢ`, so `β(δ_fused) ≤ minᵢ β(δᵢ)` — a quorum tightens the bound.
> *Proof.* The outcome flips only if the draws fall on opposite sides of the boundary,
> requiring `|p₁−p₂| > δⱼ`; apply (O). For the corollary, log-odds fusion of independent
> evidence increases the distance from the boundary (Condorcet/weight-of-evidence). ∎

> **Stability theorem.**
> **(i) Recorded replay.** With `d` fixed by the recording, `obs` is identical under
> structural equality, unconditionally (Lemma 1; hash-chained spine).
> **(ii) Live re-runs (fixed `𝒫`).** `P(obs(R₁) ≉ obs(R₂)) ≤ Σⱼ β(δⱼ)`. If every
> consequential gate is exactly-gated, the bound is `0`. Raising the margin floor `m`
> forces every `δⱼ ≥ m`, so the bound is `≤ k·β(m)`: stability is monotone in `m`, and
> tighter still under independent quorum (Lemma 2 corollary). ∎
>
> *Rests on:* (O) the oracle-variance model and (NI) the non-interference bisimulation
> (§15.7). Given both, the bound is exact.

**Pipeline corollary.** Make every value that writes to a sink exactly-gated, set a high
consequential `m`, and (for noisy judgments) fuse independent judges by `quorum`. A
`recorded` run replays to structural equality unconditionally.

## 15.6 Soundness statements
For well-typed `P`: (1) Authority safety (including tool-use), (2) Verification safety — no
authority event is emitted with a value not `U ∧ auth ∧ margin≥m`, including across calls;
(3) Color safety — no `sync` function reaches a seam (including a tool call;
`decide`/in-hand-`verify` are `S`); (4) Provenance completeness; (5) Reproducibility up to
`≈` (structural if exactly-gated; a recorded run replays to chain-head equality
unconditionally). Technique for (1)–(3): progress+preservation. (5) is the Stability
theorem (§15.5.5), modulo O/NI of §15.7.

## 15.7 Mechanization and open obligations
The Stability proof rests on two assumptions discharged by machine-checked proof. The
intended mechanization (Lean 4 + Mathlib):

1. **Model Agape-core** — an idealized calculus: values, the taint lattice `U⊑P⊑T`, the
   gate (`decide`/`verify`), `commit`, and `obs`. The theorem is proved of the core; the
   implementation is argued to refine it.
2. **(NI) Non-interference (Lemma 1)** — the deterministic part. Define low-equivalence
   `≈_L` (agreement on `U`-data and declassified decisions); prove stepping preserves it by
   a two-run bisimulation. A standard IFC development; no probability.
3. **Replay corollary** — journaled `d` is a constant ⇒ `obs` equal by Lemma 1;
   deterministic.
4. **(O) Oracle bound + amplification (Lemma 2)** — the probabilistic part. State the
   calibration bound as a hypothesis (a property of the seam, not provable from the
   semantics); mechanize monotonicity in `m` and the Condorcet/Hoeffding fusion
   concentration for `quorum`, with the independence hypothesis explicit.
5. **Headline theorem** — compose 2–4.

The proof certifies Agape-core, not the implementation; closing that gap is verified-
compiler-scale work. The probabilistic part assumes the oracle is calibrated; it does not
prove the model is, but isolates exactly which empirical property the guarantees rest on.

Further obligations: re-prove Stability under the three-phase message + tool-seam model;
the identity-seam authentication contract; the reliable/ordered channel surface; the
optional distributed-spine and Multi-verse layers; and interprocedural authority for
top-level (non-agent) functions.

---

## 16. Configuration & the project manager

Every Agape project is governed by the project manager — the `agape` toolchain. A project
is a directory with an `agape.toml` manifest; configuration is baked into the project, not
passed ad hoc. The three seams and the default `Rule` resolve from the manifest.

### 16.1 The manifest

```toml
[project]   name = "my-app"   entry = "main.ag"   version = "0.1.0"

[provider]  backend = "anthropic"   model = "claude-…"   temperature = 0   # COGNITION seam (§8)
[identity]  backend = "local-keyring"                                      # IDENTITY seam  (§13)
[runtime]   threshold = 0.8   margin = 0.0                                 # default Rule   (§3)
            consequential_margin = 0.1                                     # the floor m    (§13)

[tools]                                                                    # the TOOL seam  (§6b)
search   = { mcp = "stdio:mcp-server-brave" }      # binds `tool search` to an MCP server
transfer = { mcp = "https://payments.internal/mcp" }
```

The language-relevant configuration is exactly the three seams (`[provider]`, `[identity]`,
`[tools]`) and the default `Rule` + floor `m` (`[runtime]`). Swapping a seam changes no
source. A `tool NAME` declaration binds to its `[tools].NAME` entry; an undeclared-in-config
tool is a configuration error.

### 16.2 Scopes and precedence (lowest → highest)
1. spec defaults; 2. global user config (`~/.agape/config.toml`); 3. project manifest
(`agape.toml`); 4. per-call override (the gate `by` clause), which always wins. A threshold
is never a hidden global. Secrets (API keys, signing keys, MCP credentials) come from the
environment or OS keychain, never the manifest.

### 16.3 Configuration and reproducibility
The Stability theorem is stated for a fixed provider, and the committed manifest fixes it.
A run is identified by `(I, manifest, recording)`. Changing the manifest changes the
program's meaning, visible in version control.

### 16.4 Reproducibility in practice — two kinds of uncertainty, three knobs
A model's answer varies for two reasons:
- **Aleatoric** (sampling) — governed by `temperature`; `temperature = 0` is greedy
  (near-deterministic); replay eliminates it by re-serving the journal.
- **Epistemic** (genuine ambiguity) — no temperature removes it; a true coin-flip yields a
  low-margin judgment. The remedy is the margin floor `m` → escalate to a human (`verify e
  by p`), or fuse independent judges by `quorum` (§12) to raise the margin.

Three knobs: config (`temperature=0` + pinned model + `m`); gate design (crisp criteria →
high margin → exactly-gated); escalation/quorum (the human path or independent fusion for
the epistemic remainder). All three are explicit, enforced, and checkable.

### 16.5 The conformance harness contract
A conformant implementation ships a test mode the black-box suite drives:
- **Fault injection.** A designated stub provider returns schema-violating output on
  demand, so a `TypeMismatch` is triggerable deterministically.
- **Recorded replay.** The runner can capture a run's journal and replay it; "chain-head
  equality" is equality of the spine's terminal hash under the canonical event
  serialization.
- **Manifest-fixture observation.** A test may set `[runtime] threshold/margin` (and a `by`
  override) in a fixture `agape.toml` and observe which boundary was applied (the gate
  emits the applied `Rule` in its `Verification`/`Attestation` event), so precedence (§16.2)
  is testable.

---

## 17. The system-integration model

Agape is the cognitive/agentic layer (§0.1). This section defines how a runtime is deployed
and how it occupies a privileged system-layer position.

### 17.1 Deployment
The architecture — the runtime mediating agent actions through gates, exposing tools as the
capability surface, writing the spine — runs entirely in userspace. The userspace
runtime/daemon runs Agape programs, exposes the MCP tool surface as the gated capability
boundary, enforces the membrane, and writes every consequential action to the spine (audit
+ replay). No kernel is required.

### 17.2 The enforcement boundary
A system-layer position rests on the membrane — a safety property the system can trust, as
eBPF earns an in-kernel seat by being verifiable and reaches the kernel only through
enumerated helpers, never arbitrary linkage. Agape's tool seam is that enumerated-helper
surface (§6b). The enforcement boundary may migrate inward through three stages while the
policy (what is a capability, what is gated, what is audited) stays constant:

```
userspace runtime   →   seccomp-confined container   →   LSM / eBPF in kernel
   (trust compiler)        (OS-enforced syscall gate)       (privileged mediation)
```

- **Userspace runtime** — enforcement in the runtime; trusts that code passed the checker.
- **Container** — `seccomp-bpf` (itself eBPF) maps capability grants onto OS-enforced
  syscall filtering; enforcement moves to a boundary the OS controls.
- **Kernel** — the membrane as a Linux Security Module (the kernel's framework for
  mediating consequential actions, as SELinux/AppArmor are) or eBPF programs.

The policy is separated from its enforcement so only the enforcement is re-pinned at each
stage. For an untrusted boundary, the membrane is enforced at load time (the analogue of
eBPF's verifier), not assumed because code was compiled upstream.

### 17.3 Position
The kernel mediates app→hardware; Agape mediates agent→system. The membrane is the agentic
analogue of the MMU/syscall boundary, and the spine is the system audit log: a conventional
kernel for the somatic substrate, Agape as the trusted cognitive interface. Stages 17.2
container and kernel are a roadmap; the userspace runtime is the concrete target.
