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
- **cognition is a swappable substrate** reached only through the **provider** — a declared
dependency (the cognition backend, §16) that program code never names directly;
- **meaning is checkable, and its uncertainty is typed** — a semantic judgment asks
the provider to commit to one variant of a closed enum and returns a **graded
judgment** (`Credence<E>`, §3); a **gate** (`c by R`, `endorse`/`attest`) is the only thing that
collapses a graded judgment into a committed decision, or **abstains** (§13);
- **the world is reached only through declared, capability-gated tools** — every
world-affecting effect (I/O, an API call, a database, heavyweight computation) is a
**tool**, a declared dependency on a world capability (§6b), enumerated and granted, never
an ambient call;
- **authority is governed** — what an agent may do, which cognition-derived values may
drive consequential actions, and which tools it may use, are bounded at compile time
(§13).

Two ideas underlie the language:

1. **The event spine.** Every meaningful action appends an immutable event to a single
  append-only log. The log is the source of truth; state is a projection of it; replay
   re-derives state by folding it.
2. **Declared dependencies.** Everything outside the program — the model, an accountable
  identity, the world — is reached through a **declared dependency**: a name the program
   declares but does not define, whose value configuration supplies at run time (§16). Cognition
   is the **provider**; accountability is a `**principal`**; the world is a `**tool`**. Swapping a
   dependency's backend changes no Agape source.

### 0.1 Scope and layering

Agape is a domain language for the cognitive/agentic layer; it is not a general-purpose
language. General-purpose computation — arithmetic-heavy kernels, data structures,
parsers — is imported as a tool (§6b), never reimplemented in Agape: Agape has no
imperative substrate of its own. The deterministic work lives in the host and is
reached, and governed, through the tool dependency. The
primitive Agape provides is **endorsed judgment under uncertainty**: a non-deterministic
semantic decision, trust-tracked, collapsed by an auditable gate, recorded on an
append-only spine.

### 0.2 Execution model

An Agape program is evaluated **top to bottom**, like an ordinary program — not as a
perpetual event loop. Reactivity happens *within* that evaluation: appending an event to
the spine synchronously fires any matching subscription before evaluation continues. The
program **terminates at quiescence** — when the top-level statements are exhausted and no
subscription work remains.

A long-running or simulated environment is expressed explicitly, never by making the
language itself a loop. Computation is **total**: every reaction terminates, since the only
loop — `retry(N)` — is bounded. The one way a program stays live is an open external input
source (`prompt`, §5b, or a standing tool sensor) that keeps it from quiescing. An always-on
agent is not one long non-terminating computation; it is an unbounded sequence of finite,
terminating reactions — one per external event — over a single growing spine, so replay and
the reproducibility guarantees (§15.5) hold per event. The default — no open source — is
deterministic, terminating, top-to-bottom evaluation.

**Concurrency and determinism are independent.** Agape is genuinely concurrent,
asynchronous, and event-driven: agents overlap in lifetime, a send returns immediately
and resolves later, and a fan-out (`|>`, §12) can have many dependency calls in flight at once.
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
- `**sync`** is the marked keyword. A `sync` function may not touch a declared dependency (no `<-`, no
binding to a `Credence` slot, no tool call, no `attest`)
and may only call other `sync` functions.
- `sync` is an affirmative, auditable claim of cognition-freedom and effect-freedom; it
propagates downward. Marking the safe property makes visible which code provably cannot
reach a model, the world, or a human — hot paths, schedulers, loops, and the gate-collapse
`c by R`.
- `emit` and an in-hand `endorse` are not dependency reaches and are permitted in `sync`: `emit`
is a spine append, and `endorse` over a `Credence` value already in hand collapses (`c by R`)
and records — no dependency reach. Only reaching a declared dependency forces async.

### Axis B — value trust: how settled is the value?

Trust records a value's cognition-provenance. Agape uses three levels (§13, §15.3.1):

- **raw** — raw, unstructured model output: a `<-` reply before it is bound to a `Credence`.
- **graded** — the credence tier: a quantified judgment, a `Credence<E>` (a
constrained distribution over a closed enum's variants, §3). More structured than **raw**
— the model has been forced to commit to a fixed set of outcomes — but not yet
committed by a gate. Queried memory facts also default to **graded** (§10).
- **settled** — a committed value carrying no un-endorsed cognition: a gated `Decision`, a constant, or external data settled by origin (a `prompt`, a read-tool result over settled inputs).

Trust is contagious upward; only a gate moves a value down toward **settled**. A consequential action may consume only a **settled** value whose settling is recorded on the spine — endorsed (§13). External data is settled by origin; only un-endorsed cognition is withheld.

### Axis C — spine presence: `event<T>` vs bare `T`

- `event<T>` means the value is (or will be) present on the spine as a message. It
marks spine presence, not async-ness or trust.
- A bare `T` is an ordinary in-memory value. A function can be async yet return a bare
value (handed to the caller, not emitted).

### The axes are independent


| construct                            | async? | trust of result      | # events | type             |
| ------------------------------------ | ------ | -------------------- | --------- | ---------------- |
| `Credence<bool> c = self <- "is …?"` | yes    | `graded`             | lifecycle | `Credence<bool>` |
| `c by confidence 0.9`                | no     | `settled`            | no        | `Decision<bool>` |
| `endorse (c by …) { … }`             | no¹    | `settled` (endorsed) | single    | `Decision<bool>` |
| `attest memo by alice`               | yes    | `settled` (endorsed) | pair      | `Decision`       |
| `Credence<E> c = peer <- "…?"`       | yes    | `graded`             | lifecycle | `Credence<E>`    |
| `search(q)` (read tool, §6b)         | yes    | `⊔ inputs`           | pair      | `text`           |
| `double(3)` (pure)                   | no     | `settled`            | no        | `int`            |


¹ `endorse` over an in-hand `Credence` is synchronous (collapse + record, no dependency reach); `endorse (self <- "…" by …)` with an inline send is async. See §13.

- A semantic judgment yields a `Credence<E>` — a graded distribution over the variants of
enum `E`, not a `bool`. To obtain a committed value, gate it (`c by R`); the threshold is
never hidden.
- The collapse `c by R` is the gate (`graded → settled`); it is `sync` — the cognition already
happened in producing the `Credence`, and applying a `Rule` to it is pure comparison.
- `endorse` records the collapse on the spine, which is what makes the value endorsed and
admissible for consequential use (§13).
- A `Credence` is produced by binding a send to a `Credence<E>`-typed slot (§3, §8), whatever
the destination; there is no separate `~` or `entail` operator.

---

## 2. Lexical structure

- **Comments:** `//` to end of line.
- **Whitespace:** insignificant except as a token separator.
- **Statement terminator:** `;` (explicit, required).
- **String:** `"..."` with escapes `\n \t \" \\`.
- **F-string:** `f"...{expr}..."`. Lexed as one `FSTR` token; `{expr}` parsed after.
- **Numbers:** `int`(`42`) and `float`(`3.5`).
- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]`*. Type names are conventionally capitalized;
values and instances are lowercase.
- **Operators (multi-char first):** `<-  |>  >=  <=  ==  !=  { } ( ) [ ] ; , . : =  +
  - - /  <  >  !`
- **Send operator:** exactly one communication arrow, `<-`. A `->` is a `LexError`.
- **Semantic judgment**: `Credence<E>` produced by binding a send to a `Credence` slot (§3, §8); vector-store similarity is reached through `match` (§10).

### Keywords

```
int float bool text null event action array  // types + spine wrappers (event = record, action = performative; array = collection)
agent extend sync                         // declarations (sync = marked color)
struct enum                               // user nominal-type declarations
grants tool read write                    // capability typing (§13); tool decl + effect class (§6b)
spawn awake sleep self on prompt          // lifecycle + external input sensor
principal policy                          // declared dependency + decision policy (§3, §13)
when case if else return retry default         // control / reactive
endorse attest perform emit abstain       // gate / attest / action perform / event emit / abstain clause
find where select from match              // queries
all any quorum independent dependent      // aggregation, dependence declaration, quorum (§12)
true false                                // bool literals
```

 `endorse` is the gate; the collapse
`c by R` yields a `Decision` that `endorse` records and authorizes, or `abstain`s (§13).
`independent` / `dependent` declare the dependence structure of values fused by
`all`/`any`/`quorum` (§12).

**Contextual words** (lexed as identifiers, meaningful only in position): `as`, `by`
(gate rule / principal-defer clause), `about` (the `when` subject filter, §7), `reach` /
`use` (grants), `origin` (find projection), `expires` (send-lifetime clause, §6), `of`
(quorum, §12), `confidence` / `margin` / `conformal` / `over` (rule clauses, §13).

**Prelude identifiers** (defined in §9, not the grammar): `Entailment`, `Contradiction`,
`Neutral`, `Credence`, `Decision`, `Principal`, `Rule`, `Event`, `Error`,
`Attestation`, `Decided`, `Abstained`, `AgentCrashed`, `Delivered`, `Resolved`, `Expired`,
`DeliveryRefused`, `QueryResult`, `ToolStarted`, `ToolResolved`, `say`.

---

## 3. Types

### Scalars

`int`, `float`, `bool`, `text`, `null`.

### `event<T>` — spine-message type

Wraps any `T` to mean "on the spine." Produced by spine-emitting constructs (`<-`,
`endorse`, `emit`, `perform`, a tool call's pair, a query statement) and consumed by spine
constructs (`when`, retrieval built-ins, field storage). `event<null>` = "sent, but no
typed reply bound."

### User nominal types

User-defined nominal types are explicitly declared. Explicit declaration is what makes the
`event`/`action` distinction and grant-set checking statically decidable: an `action`
type is a declared name with a known payload.

```agape
struct Memo  { amount: int, to: text }            // a record; all fields required
enum  Ticket { Billing, Bug, Feature }            // a closed variant set
action Transfer(memo: Memo);                       // a performative; performing it needs a settled value
```

- `**struct NAME { field: T, … }**` — a record with named, typed fields. All fields are
required: structured output (§8) has no optional-by-omission, so optionality is modeled
as a nullable union field. A struct literal is `NAME { field: v, … }` and must supply
every field; a missing field is a `TypeError`.
- `**enum NAME { A, B, … }**` — a closed set of named variants; `case` (§11)
pattern-matches them with compile-time exhaustiveness.
- `**event NAME(field: T, …);**` — a plain record (assertive); anyone may `emit` it, no power
needed. `**action NAME(field: T, …);**` — a performative: `perform NAME(v)` is a consequential
act that needs the `perform NAME` power (§13) and a `settled` value. Both require `NAME` to be
declared and `v` to match the payload; an undeclared `emit`/`perform` is a `TypeError`. Explicit
declaration is what lets `grants { perform NAME }` be checked statically.

### `Credence<E>` — a graded judgment

A `Credence<E>` is a graded judgment over a closed enum `E`: a distribution over `E`'s
variants that sum to 1, carrying how strongly the provider commits to each outcome.
It unifies graded similarity and entailment into one type:

```agape
Credence<bool>          // graded over { true, false }
Credence<Entailment>    // graded over { Entails, Contradicts, Neutral }
Credence<Ticket>        // graded over a user enum — a constrained classifier
```

A `Credence<E>` is produced only by binding a send to a `Credence`-typed slot (§8);
the slot's enum is the output schema, so the model is forced to answer inside `E`. It is
consumed only by the gate (`c by R`, `endorse`/`attest`, §13) and by the graded combinators (`all`
/ `any` / `quorum`, §12). It is not a probabilistic-programming distribution object:
there is no inference, conditioning, or sampling combinator. Producing a `Credence<E>`
any other way (e.g. from arithmetic) is a `TypeError`; consuming one anywhere but the gate
or combinators is a `TypeError`.

**Why a distribution over an enum, and not a probability.** The value is categorical (a
distribution over exhaustive, mutually-exclusive variants), not a scalar in `[0,1]`, and
it is a credence — a degree of belief — not a frequency. The variants being mutually
exclusive and exhaustive is exactly why they sum to 1; the type *is* that constraint.

**Where the number comes from (the calibration contract).** A `Credence` is read from the
provider's token-level probability mass on the forced categorical decision — the model's own
distribution over the enum's variants when constrained to answer inside the set — not from a
model's verbalized self-rating. Verbalized confidence is systematically overconfident, whereas
the token-level distribution in a constrained (yes/no, multiple-choice) setting is *better*
calibrated — not honest out of the box: raw logits remain overconfident (e.g. after RLHF), so
calibration (temperature/Platt/isotonic) is a **fitted, distribution-specific** pipeline stage
applied between the raw logits and the `Credence`. A provider that exposes token probabilities
(`exposes_logprobs`, §16) yields a `Credence` directly; one that does not (a text-only backend)
is served by the **sampling fallback** — drawing the forced choice `fallback_samples` times and
taking the empirical frequency (§16). Per-variant scores are journaled on the spine (§15.5.1) so
the calibration pipeline (§13) can read them.

### `Rule` — the gate's parameter (not a primitive)

A `Rule` is **not** a first-class type or a primitive — it is the parameter a gate decides by, a
value that carries its own *basis*, so the gate is uniform ("apply this rule to this `Credence`")
whatever basis the rule holds. Two bases (§13):

- **threshold** — `confidence θ` (optionally `confidence θ margin δ`): commit the top variant when
its mass ≥ `θ` and its lead over the runner-up ≥ `δ`. `margin` is a threshold-basis refinement,
meaningful only for three-plus variants (for `bool` it is redundant with `θ`). Cheap, needs no
data, no guarantee — its principled value is the loss ratio `θ = c_FA / (c_FA + c_FR)` (§13).
- **conformal** — `conformal α`: a distribution-free, finite-sample error bound at level `α`,
calibrated from the gate's own recorded decisions on the spine (§13). The conformal procedure is
library code, not kernel.

A `Rule` is a value — a literal (`confidence 0.9`), a reference (`conformal 0.1`), one a pipeline
computed (`self.policy_rule`), or a named `policy` (§13) bundling a rule with its cold-start
fallback. A gate requires its rule (`c by` with no rule is a `ParseError`).

### Declared dependencies — `principal` (and `tool`, `prompt`)

Everything the program reaches but does not define is a **declared dependency**: a name declared in
source, bound to a concrete resource by configuration (§16). It is one construct, fixed by a single
fact — *it is supplied from outside the program* — from which the rest follows: **declared, not
constructed** (no literal form — `text → Principal`, etc. are `TypeError`s);
**config-bound**; **opaque** (the program cannot read a signing key or a tool endpoint's credentials);
**unforgeable** (only configuration may supply it); and **used only at a governed site**, recorded
on the spine. Four flavours differ only in what they supply:


| declaration        | supplies                       | used at                      |
| ------------------ | ------------------------------ | ---------------------------- |
| `prompt T name;`   | an external input source (§5b) | `when (Prompt p about name)` |
| `tool R name(..);` | a world capability (§6b)       | a tool call                  |
| `principal name;`  | an accountable identity        | `attest e by name`           |


```agape
principal alice;          // an accountable identity, resolved by config (§16)
```

A `principal` is the basis of an external gate (`attest e by alice`, §13); its own trust is
`settled`, and a name is a forgeable claim, not a credential (`attest e by "alice"` is a
`TypeError`). A conformal gate needs no separate dependency: it calibrates from its own recorded
decisions on the spine, and below a configured minimum of labelled cases (§13, §16) it abstains. No
credential appears in source; it is bound in the manifest (`[identity]`, §16), and
authentication/signing happen at the gate, not the declaration. `Credence<E>` is **not** a declared
dependency — it is a value *received* from the provider, not a declared name.

### The judgment enums (prelude — §9)

A pure enum — a categorical outcome and nothing more; all contextual metadata lives on the
spine event that carries it.

- `**Entailment`** — `enum Entailment { Entails, Contradicts, Neutral }` — what a
`Credence<Entailment>` judgment commits to. A `Credence<bool>` commits to `true`/`false`.

A `Credence<E>` is the graded judgment before the gate; the committed variant is what the gate
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
sync Decision<bool> over(Credence<bool> c) { return c by confidence 0.9; }  // sync; the collapse is deterministic
Credence<bool> about_poker(text x)  {                                 // async, graded judgment
    Credence<bool> c = self <- f"is {x} a game of poker?";
    return c;
}
```

The collapse `c by R` is `sync` (§13). The cognition is in producing the `Credence` (the provider
send bound to a `Credence` slot, which is async); applying a threshold/margin to a `Credence`
value is pure comparison. So a `sync` function may take a `Credence` and collapse it; the
judgment is agentic, the collapse is deterministic, and the decision is fixed given the
`Credence` (§15.5). A `sync` function may likewise `emit`, and may `endorse` a `Credence`
value in hand (collapse + record, no dependency reach); it may not `attest … by p` (identity dependency = async)
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
    on crash { ... }     // a contained fault — recover here; state is intact
}
```

- `agent` is a template (like a class). A field `event<T> name;` is a typed slot.
- The `( TYPE PARAM , … )` list declares the constructor parameters; they are bound at
`awake`, not `spawn` (see Lifecycle).
- `self` is the agent's reference to itself.
- `extend PARENT(args);` (first statement) is composition/inheritance.
- `grants { ... }` (optional) declares the agent's authority (§13).

### Lifecycle

Each transition is a spine event. Construction is at `spawn`; `awake` and `sleep` toggle the
mailbox:

- `**spawn TYPE name(args);**` — allocate and construct. Give the instance an address, bind the
constructor parameters to `args`, run the constructor body, and hoist its subscriptions. It
reaches no cognition and opens no mailbox yet. Appends `Spawned(name)`.
- `**awake name;**` — announce: open the mailbox, append `AgentAwake(name)`, and run the
`on awake` hook. It takes no arguments; the constructor already ran at `spawn`. A re-`awake`
after `sleep` resumes the agent — and loses nothing, because the agent's state is a function of
the spine, not fragile in-memory state.
- `**sleep name;**` — close the mailbox; run the `on sleep` hook; a slept agent with no
live references is collected. A collected agent is re-entered by a fresh `spawn`; a
still-referenced slept agent is re-entered by `awake name;`.
- **Crash (involuntary).** A fault within a single handler invocation — an unrecoverable
seam failure (e.g. the provider returns nothing) or an uncaught error — does **not** end
the agent. The faulting invocation is abandoned, `AgentCrashed(name)` is appended, the
`on crash` hook runs, and the agent continues with its fields and memory intact. An agent
is a persistent cognitive entity; a crash is a contained, recorded interruption, not a
death. Recovery is the agent's own (`on crash`); a pathological crash loop is a policy
concern for an ordinary `when (AgentCrashed …)` subscription to handle (e.g. by `sleep`ing
the agent), not a built-in. Unlike `sleep`, a crash is involuntary and does not close the
mailbox.

**Sending to a non-awake agent.** An agent that is not awake has no mailbox, so a send to
it is lost (it never `Delivered`, §6) — not an error. The compiler emits a warning (not an
error) when it can statically prove a send is dead.

### `extend` — inheritance

`extend PARENT(args);` (first statement) is composition/inheritance. A child inherits the
parent's fields, constructor, `when` blocks, and `on awake` / `on sleep` / `on crash` hooks; the
parent's constructor runs (with `args`) before the child's constructor body, and inherited
`when`/hooks fire for the child. Authority is subtractive: a child's `grants` must be a
subset of the parent's (§13).

### Lifecycle hooks vs `when`

`on awake` / `on sleep` / `on crash` are hooks tied to the agent's own transitions; `when (X)`
is a general spine subscription keyed by an arbitrary subject `X` (§7). `on crash` runs in the
agent's own context after a contained fault (see Lifecycle), with state preserved, so it can
compensate for or retry the abandoned work.

### §5b — `prompt`: the external input boundary

```agape
prompt text question;          // opens a standing external input SENSOR
```

`prompt TYPE name;` declares an external input source — the push mirror of the pull send
`<-`. Each external arrival lands a `Prompt` event on the spine with subject `name`. React
with `when (Prompt p about name)`, where `p` evaluates to the arrived value.

- A `prompt` source makes a program always-on (§0.2): while open it cannot quiesce; when
it closes (EOF) the program reaches quiescence and ends.
- Its values are external data, `settled` by origin (§13): they carry no un-endorsed cognition,
so they may drive an action. Agape gates the model's judgment, not the correctness of input.
- `prompt` is one of a family of sensors (socket, timer, queue, file watch, and a standing
tool sensor, §6b), sharing one runtime contract: an external source that appends events
to the spine as they arrive, so replay folds the recorded input stream deterministically.

---

## 6. Communication — the send operator `<-`

`dest <- message`

- A send `dest <- p` goes to the agent at `dest`, which answers by thinking — invoking the
model through the provider. `self` is just your own address: every agent reasons through the
same provider, so the destination changes only which agent thinks, never the kind of operation.
- A typed reply (`event<T> x = dest <- "…";`) is the responder's structured output for `T`
(§8); binding it to a `Credence<E>` slot constrains that output to `E`'s variants and yields
a graded `Credence` (§3, §8) — for any destination.
- A bare reply is `raw`; the `Credence` binding is what grades it. Either way a reply is an
ordinary value: it reaches the spine only by being emitted, performed, or gated, never by
being produced — so a send logs its lifecycle, not its content (§15.4).
- Every send is asynchronous and actor-routed: it carries the `Sent → Delivered → Resolved`
lifecycle (below) and may be lost or expire — `self` included. A send is a send; the
destination is only an address.

### The message lifecycle — `Sent → Delivered → Resolved`

Every send moves through three phases, each an event on the spine, correlated by `corr`:

- `**Sent**` — the send was issued.
- `**Delivered**` — the recipient's mailbox accepted it.
- `**Resolved**` — the recipient produced the bound reply or completed handling.

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

## 6b. Tools — the world dependency

Cognition is reached through the provider; accountability through the identity dependency;
the world is reached through the tool dependency. A **tool** is a declared, typed,
capability-gated effect — a file read, an HTTP call, a database query, a payment API, or
heavyweight computation Agape does not express natively. Tools are the controlled-FFI
surface: Agape does not link arbitrary foreign code. The tool dependency speaks the **Model
Context Protocol (MCP)** — an enumerated, declared, permissioned tool-call protocol — so a
program imports the MCP tool ecosystem as capabilities without inventing its own ABI.
Tools form an enumerated capability surface (cf. eBPF helper functions: a fixed set of
approved calls, never arbitrary linkage).

```agape
read  tool text search(text query);          // observes the world; result carries its inputs' trust
write tool bool transfer(int amount, text to);  // changes the world: a consequential sink (§13)

agent Researcher grants { use search } {
    text hits = search("agape language");    // a tool call: needs `use search`
}
```

- **Declaration.** `read tool RET NAME(params);` or `write tool RET NAME(params);` — every tool
declares its **effect class**: a `read` tool observes the world, a `write` tool changes it (a
consequential sink, below). The class is mandatory; omitting it is a `ParseError`. The return type
leads, like a function signature; use `null` for a tool with no meaningful return. The
binding to a concrete MCP server/endpoint is configuration (`[tools]` in the manifest,
§16); no endpoint or secret appears in source, exactly as `<-` names no model. An
undeclared tool call is a `TypeError`.
- **Authority.** A tool call requires a `use NAME` capability in the agent's `grants`
(§13). Default-deny applies: no `grants` ⇒ no tool calls. `use` is subtractive under
`extend`, like `emit` and `reach`.
- **Color.** A tool call reaches the tool dependency → async (`A`). A `sync` function may not
call a tool.
- **Trust.** A read-tool result carries the join of its inputs' trust: `settled` when its inputs
are settled (external data, settled by origin), `graded`/`raw` when a `Credence` flowed in. A
**write** tool is a consequential sink — its inputs must be `settled` and endorsed, exactly
like a `perform`. Agape gates the model's judgment, not the correctness of external data.
- **Spine.** A tool call appends a correlated `ToolStarted(NAME)` / `ToolResolved(NAME)`
pair (§7). Every world-effect is on the log, so the spine is a complete, replayable
account of what the program did to the world, not only what it thought.
- **Replay.** A tool result is an external observation and is journaled (§15.4.2) like an
oracle output; replay re-serves it from the recording and never re-invokes the tool. A
write tool is replayed as its recorded result.
- **Standing tool sensors.** A tool may be opened as a push sensor (a subscription, a
socket, a file watch) rather than a pull call, in which case it behaves like `prompt`
(§5b): it appends events as they arrive and makes the program always-on.

A tool is not a new trust hole; it is the same membrane discipline (capability + trust +
spine + replay) applied to the world. This is what lets the host's deterministic work be a
general-purpose language reached through a governed boundary rather than reimplemented
inside Agape (§0.1).

---

## 7. The spine, events, and `when`

### Events

Every meaningful action appends an immutable `Event`: `{ tick, etype, subject, payload, corr, agent }`. `tick` is system-assigned and monotonic; `subject` is the source the event
is about (the `when` correlation key); `corr` links a `Started` to its `Resolved`.

### Subjects: every event has a source

A send `d <- p` produces events with subject `d`; a typed binding `event<T> x = …;` gives
the produced event subject `x`. A gate over a `Credence` produces one event for the
operation (subject = the binding or an ephemeral). A tool call's pair is subjected at the
tool name. A literal operand has an ephemeral address; its event still lands on the spine.

### Async event discipline

A send (`<-`) appends the three-phase `Sent`/`Delivered`/`Resolved` chain (§6). Any other
operation with a pending window that reaches a declared dependency (`attest … by p`, a tool
call) appends a `Started`/`Resolved` pair correlated by `corr`. Synchronous ops (`==`,
arithmetic, the collapse `c by R`, an in-hand `endorse`) append a single event or none.

### `when` — the subscription

`when (Type binding [about subject]) [if (guard)] { ... }` is a spine subscription. It matches
events of `Type` (by subtype, §9); the `binding` is the matched event, which evaluates to its
payload (`binding.field`); `about subject` filters to events about a held subject; and `if (guard)`
is an ordinary predicate over the bound event's fields. With no `about` and no guard it matches
every event of that type, any source — including faults (`when (Error e)`).

```agape
when (Refund r)                       { ... }   // every Refund; r is the payload
when (Refund r about desk)            { ... }   // only Refunds about the agent `desk`
when (Refund r) if (r.amount > 1000)  { ... }   // a payload guard
```

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
endorse (c by confidence 0.9) { true: emit Logged("john"); false: ; }  // records the Decision (subject: c)
when (Contradiction k about john) { ... }    // a Credence<Entailment> that committed to Contradicts at john
when (Error e) { ... }                       // every error, any source (incl. Contradiction)
```

---

## 8. Semantic checking

### The provider

Cognition enters only through the provider (`think` / `embed`). Agape source never
names a concrete provider; semantic judgments and structured replies resolve through it;
swapping it changes no source.

### Graded judgments → `Credence<E>`

A semantic judgment is a send bound to a `Credence<E>` slot. The slot's enum `E` is
the output schema; the provider is forced to answer inside `E`, and the result is a
distribution over `E`'s variants (the credence).

```agape
Credence<bool> ok        = self <- f"is {x} an approval?";           // over { true, false }
Credence<Entailment> rel = self <- f"does {p} entail {h}?";          // over { Entails, Contradicts, Neutral }
Credence<Ticket> kind    = self <- f"classify this ticket: {body}";  // over a user enum Ticket
```

`Credence<E>` over any user enum is a constrained classifier whose output is trust-tracked
and gate-disciplined. The threshold is not applied here — it lives in the gate's `Rule`
(§13). To use a judgment as a committed value, gate it: `c by R`.

- On an array operand a judgment decomposes over elements but returns one `Credence<E>`
for the whole: the parts inform the distribution; the evidence records where a partial
mismatch was. The result type stays uniform.
- **Mechanism vs policy:** when a gate commits a `Credence<Entailment>` to `Contradicts`,
the runtime also emits a first-class `Contradiction` event, independent of any arm,
so a global `when (Contradiction about subject)` can react.

### Materializing a distribution (cost)

A single dependency call already yields the full per-variant distribution. A spread over
repeated judgments — sampling the same question N times — is a separate, heavyweight
operation not in the surface language. A use of `sample` is an unknown-identifier error.
(The stochastic-consistency harness, §15.5.3, samples re-runs externally.)

### Structured output (the provider contract)

- A declared `event<T>` compiles to a JSON Schema; the provider returns schema-conforming
output via constrained decoding (mandatory; no fuzzy fallback).
- Type → schema: `bool→boolean`, `text→string`, `int→integer`, `float→number`,
enum→`{type:string,enum:[...]}`, struct→`{type:object,…,additionalProperties:false}`,
array→`{type:array,items}`. A `Credence<E>` reply is the per-variant token probabilities
of the constrained decode, calibrated (§3).
- The provider must expose token probabilities for any gated/`Credence` decision.
- On schema failure the runtime raises a clean `TypeMismatch` (catchable, retryable).

---

## 9. The prelude

```
enum Entailment { Entails, Contradicts, Neutral }          // committed from a Credence<Entailment>
type Credence<E>                                           // a graded judgment over enum E (§3)
type Decision<E>                                           // a gate's committed outcome over E (§13)
type Principal                                             // an accountable identity — a declared dependency (§3)
// Rule is the gate's PARAMETER, not a type: `confidence θ [margin δ]` | `conformal α`  (§3, §13)

// Built-in spine events:
//   Event(text)            user progress/info event (via `emit`)
//   Error(text)            ROOT error type (hierarchy below)
//   Decided(subj)          a gate committed a Decision at subj
//   Abstained(subj)        a gate could not commit at subj
//   Contradiction(subj)    emitted when a Credence<Entailment> commits to Contradicts
//   Attestation(subj)      a principal gate (attest … by p)
//   QueryResult(subj)      the event a query STATEMENT lands
//   ToolStarted/ToolResolved   the tool pair (§6b)
//   Spawned / AgentAwake / SleepEvent / AgentCrashed   lifecycle (§5)
//   Sent / Delivered / Resolved                message lifecycle (§6)
//   Expired(corr) / DeliveryRefused(corr)      message expiry / refused-late-delivery (§6)
//   PromptOpened(name) / Prompt(name)          external input sensor (§5b)
//   <Op>Started / <Op>Resolved                 async dependency pairs (tool, attest…by)
```

**Event-type hierarchy.** `Error` is the root; `Contradiction`, `TypeMismatch`,
`RetryExhausted`, `FailedAttestation`, and `AgentCrashed` extend it. `when` matches by
subtype, so `when (Error e)` catches a `Contradiction`; a contradiction is an `Error`
subtype, and code that wants only faults matches the specific types. `Expired` and a lost
send are not errors.

`**say(x)`** prints its argument; it is not a spine operation.

---

## 10. Memory — three modalities, one unit

Each agent has its own memory:

- **FACTS** → a deterministic table, queried with `select`.
- **RELATIONSHIPS** → a graph, queried with `find ... where`.
- **SEMANTICS** → a vector store, queried with `match`. `match` is a gate: `match { m: q } > θ` thresholds similarity, settling hits against `θ`, and yields `settled` but
off-spine — like `c by R`, it must be `endorse`-recorded to admit a consequential use.

### Internalization

Every event an agent receives (via `<-`) is decomposed through the provider into facts,
relationships, and embeddings written to that agent's memory. Decomposition is
non-deterministic (it is cognition) but its shape is fixed (typed facts; SPO triples over
a typed predicate set).

### Provenance

Every memory cell carries an immutable backpointer to the spine event that produced it;
`find n, origin(n) where { … }` returns the fact and its originating event.

### Trust of queried facts

A queried fact carries the trust of the spine event it traces to (provenance-based).
Because most facts trace to internalized cognition, the default trust of a `find` /
`select` result is `graded` (structured but not gate-committed): it may flow through
control flow but must be re-gated before a consequential sink. A fact whose origin is an
already-endorsed (`settled`) event carries `settled`. `match` hits are `settled` but off-spine (a
gate, above). A value's provenance, not its having-been-stored, determines whether it may act.

### Query surface

- **Facts (SQL):** `select COLS from AGENT where { COND }` → `array<Record>` — rows of the
projected columns. `COND` is a boolean filter over fields: `field op value` (`op ∈ {==, !=, <, >, <=, >=}`) combined by `&&` / `||`. No joins or aggregates — heavy analysis is host work (§6b).
- **Relationships (graph):** `find x [, origin(x)] where { TRIPLE+ }` → `array<T>` of the bound
node's type — the entities matching the pattern. Each `TRIPLE` is a `subject predicate object`
atom (any position a variable or a literal); the body is their conjunction.
- **Semantics (vector):** `match VECTOR > θ` → `array<Hit>` — the nearest neighbours above
similarity `θ`, each a matched item with its score. `match` is a gate (above).
- **Spine:** `select COLS from spine where { COND }` — the same `select` over the log itself.

Each query is an **expression** yielding its `array<…>` result set, bound by an ordinary
declaration (`array<Refund> prior = select * from Refund where { … };`) and consumed by fan-out
(`|>`, `all`/`any`/`quorum`, §12). A bare **statement** form binds nothing and lands a
`QueryResult(subject)` event, where `subject` is the query target (the agent name, or `spine`). A query reads the log; it never re-emits. Replay folds the spine and appends
nothing.

---

## 11. Control flow

### `if` / `else`

The condition is `bool`; `!` is boolean negation. A `Credence<bool>` is not a `bool` — gate it (`c by R`, then dispatch on the `Decision`); a bare `Credence` in an `if` is a `TypeError`.

### `case` — enum pattern matching

```agape
case (EXPR) as e {
    VARIANT_A: { ... }
    default:   { ... }
}
```

- General over any enum; `Entailment`/`Decision`/user enums are the common cases.
- Exhaustiveness is checked at compile time; a non-exhaustive `case` with no `default` is
an `ExhaustivenessError`.
- A `Credence<E>` is not matched directly; gate it first (`case (EXPR by r) …`): the collapse
yields a singleton variant if its margin over the runner-up clears the rule, else `abstain`.
Committing to `Contradicts` also fires the first-class `Contradiction` event (§8). `case` over a
pure enum is synchronous.

### `retry` — re-attempts

`{ block } retry(N)` re-attempts the block up to `N` times on a fault (an `Error` — e.g. a
`TypeMismatch` from a malformed reply): assignments the block makes persist, and on exhaustion it
emits `RetryExhausted` and the fault propagates. The bound is mandatory — there is no unbounded
form, so every Agape program terminates.

---

## 12. Aggregation, pipes, graded combination, and quorum

- `coll |> fn` pipes each element into `fn`. If `fn` is async, `|>` is a concurrent fan-out
(await-all; no short-circuit).
- `all(...)` / `any(...)` reduce a collection. Over `bool` they are ordinary
conjunction/disjunction. Over `Credence<bool>` they fuse evidence into a single
`Credence<bool>` to gate once, instead of collapsing each judgment early.

### Fusion must declare its dependence structure

Fusing graded judgments has no assumption-free default. By the Fréchet inequalities, for a
conjunction `p₁…pₙ` the joint is pinned only to an interval, `max(0, Σpᵢ − (n−1)) ≤ p(∧) ≤ min(pᵢ)`, whose value depends entirely on correlation: at independence it is the product
`∏ pᵢ`; at maximal positive dependence, `min(pᵢ)`. Independence is itself a specific
assumption, not the absence of one. The dependence structure of any fused set must be
declared:

```agape
independent c1, c2, c3;           // assert these judgments' errors are uncorrelated
dependent   c4, c5;               // assert these are correlated (e.g. share a source)
Credence<bool> ok = all(c1, c2, c3, c4, c5);
```

- `**independent v…**` — fusion is log-odds addition (Good's weight of evidence;
naive-Bayes combination): confidence accumulates — several independent confirmations
fuse higher than any one.
- `**dependent v…**` — fusion takes the conservative Fréchet bound (`min` for conjunction,
`max` for disjunction): confidence does not accumulate, capped at the weakest link.
- **No default.** Aggregating two or more `Credence` values with no dependence declaration
covering every pair is a compile error (`TypeError`). Coverage must be total.
- **Mixed sets** compose by the declarations: each `dependent` cluster is fused
conservatively first, then cluster results combine by the independent rule.

This is the only operation Agape offers over graded values: forward evidence fusion before
the single gate — not general inference (no `observe` / conditioning / `bind`). Fusion
lives entirely in the credence tier (`P → P`); only the gate crosses `P → U`. Independence
is an asserted, unverified claim, recorded on the spine so an over-confident outcome traces
back to the assertion that licensed it. Calibration is the provider's job (§3), not fusion's.

### Quorum

A single non-deterministic judgment can flip run-to-run (its margin bounds the flip
probability, §15.5.5). Multiple judgments that agree flip less often (Condorcet's jury
theorem: independent judges better than chance, combined by majority, have error that
collapses as their number grows). `quorum` expresses this:

```agape
independent j1, j2, j3;                          // diverse judges/evidence
Credence<bool> agreed = quorum(2, [j1, j2, j3]); // graded "at least 2 of 3 commit"
endorse (agreed by confidence 0.9) { ... }       // gate the fused quorum once
```

- `**quorum(k, [c1, …, cn])**` fuses `n` `Credence<bool>` judgments into a single
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

Five properties are bounded by the compiler, not hoped for at runtime: authority, trust,
color, tool use, and the gate that connects them. The formal rules are §15.3.

### Authority (`grants`)

An agent's `grants` clause is its total authority — in Hohfeld's terms, its **powers**: the
actions it may `perform`, agents it may `reach`, and tools it may `use` (§6b). Acting outside it
is a compile error. Capabilities are subtractive under `extend`. An `**action`** declaration
(`action Transfer(…);`) is a consequential, performative event type (vs a plain `event`, a
record) — performing one engages the trust rule below.

```agape
grants { perform Transfer, reach Worker, use search } // concrete capabilities
grants { * }                                          // the explicit unconstrained opt-out
```

A grant entry is `perform NAME` (may perform action type `NAME`), `reach NAME` (may send
into agents of type `NAME`), or `use NAME` (may call tool `NAME`).

**Default is deny.** No `grants` clause ⇒ perform/reach/use nothing (fails closed). The only
escape hatch is the explicit `grants { * }` (unconstrained, lattice top, visible in source
and spine). `reach` covers every agent-typed binding (parameter, `spawn` result, any
variable of agent type), not only parameters.

### Taint — the three-level lattice

A value's trust records its cognition-provenance: `settled ⊑ graded ⊑ raw` (§15.3.1).

- a bare send reply, before it is bound to a `Credence`, → `raw`.
- a send bound to a `Credence<E>` slot → `graded` (a graded judgment), for any destination; a
queried fact defaults to `graded` (§10).
- a gate → `settled` (committed and recorded).
- a constant, a `prompt`, and a read-`tool` called with `settled` inputs → `settled` by
origin: external data carries no un-endorsed cognition.

Trust is contagious upward (a value is as `raw` as its least-settled input); only a gate
settles. A `Principal` is `settled`.

### The gate — `endorse`, `attest`, `abstain`

A gate turns a graded judgment into a committed decision **or abstains**. Over a `Credence<E>` it
forms a **prediction set** — the variants it deems plausible under its rule — and **commits iff
that set is a singleton**; otherwise it **abstains**. A prediction set is the principled object
over three-plus variants, where a bare scalar threshold has no meaning. Two properties travel with
a settled value:

- **Settled** (a value property): the value carries no un-endorsed cognition (`graded → settled`).
- **Endorsement** (a provenance property): the settling is recorded on the spine, hence
checkable.

```agape
Decision d = c by confidence 0.9 margin 0.1;   // collapse a Credence; UNTAINTS (P→U); off-spine; sync
endorse (c by confidence 0.9) { ... }            // ENDORSES: records the Decision, authorizes it for a `perform`
attest memo by alice;                            // principal basis: alice attests; UNTAINTS + ENDORSES
endorse (kind by conformal 0.1) { ... }          // conformal calibrates from the spine
  abstain { ... } by triage_lead { ... };        // ambiguity / cold-start → defer to a principal
```

- `**c by R**` collapses a `Credence<E>` to a `Decision` (a committed variant, or `abstain`) by a
`Rule` `R` (§3). It settles trust (`graded → settled`) and is color-`S`. A bare `Decision` is
settled but *off-spine* (unendorsed): it may drive control flow, not a consequential action. The
rule is mandatory.
- `**endorse (c by R) { … }*`* records the `Decision` and **endorses** it — settled *and* on the
spine — then dispatches on the `Decision`'s variants (the arms, written with `:`). Over an in-hand
`Credence` it is synchronous (`sync`-permitted); the inline `endorse (self <- "…" by R)` form is
async. An endorsed `Decision` may drive a `perform`.
- `**attest e by p`** / the `**by p**` clause (`p` a `principal`) is the external basis: it reaches
the identity dependency, obtains `p`'s signed `Decision`, and records an `Attestation { who, what, decision, signature }`. The decision is `p`'s, deferred to the model for the clear cases.

**The rule selects the basis (§3); the gate stays uniform.** `by confidence θ` is the
**threshold** basis; `by conformal α` is the **conformal** basis — the prediction set is
`{ v : nonconformity(v) ≤ q̂ }`, where `q̂` is the level-`α` quantile of the gate's own recorded
decisions and their labels on the spine, a distribution-free, finite-sample bound (wrong at most
`α` of the time under exchangeability) that does **not** require the model's probabilities to be
honest; `by p` is the **principal** basis. The recorded `Decision` pins which basis settled it and
the applied rule, so a recalibration does not change how an earlier run replays.

**The `abstain` clause** is optional, like an `else`: on a singleton set the matching arm runs;
otherwise the `abstain` block runs, and a `by p` clause defers to a principal whose ruling
re-enters the arms. An omitted `abstain` is a recorded no-op — the gate still records its
abstention. Because an un-settled value cannot reach a consequential sink (the rule below), an
unhandled abstain cannot leak into an action. This removes any need for a designated abstain
*variant* on a user enum; `Entailment`'s `Neutral` is a convenience over it.

**The supervised-to-autonomous bootstrap.** A conformal gate certifies nothing without data, and
its data is the spine itself — its own past decisions and their recorded outcomes. Below a minimum
of labelled cases (§16) the gate abstains, routing every case to `abstain`/`by p` — typically a
principal `attest`. Those attestations become the first labelled cases; once enough accrue the gate
commits autonomously, escalating thereafter only genuinely ambiguous (non-singleton) cases. A fresh
agent is thus human-supervised by construction and earns autonomy as it accumulates grounded
labels. A recorded outcome that labels a judgment references that judgment's spine id, so the
judgment↔label join stays auditable on the spine rather than in untyped host state.

**The consequential-action rule.** A consequential sink — a `perform` argument or a write-tool
input — may consume a value only if it is `**settled`**: it carries no un-endorsed cognition. A
`Credence` reaches `settled` only through a recorded gate (`endorse`/`attest`, not a bare
`c by R`); external data is `settled` by origin and passes freely — only un-endorsed cognition is
rejected (the check is static). Additionally, if the value is a gated decision, the margin floor is
checked at runtime — `margin ≥ m`, with `m` from the manifest (`[runtime] consequential_margin`, §16). A judgment below `m` abstains and is the typed trigger for
escalation.

**Loss direction.** Whether a false accept or a false reject is costlier is a property of the
action's loss, declared per `action` type. It is also what *grounds* a threshold: the
Bayes-optimal `θ = c_FA / (c_FA + c_FR)`. `m` sets how confident the gate must be; the
loss-direction declaration sets which way to fail when it is not. Absent a declaration, a
consequential gate fails closed.

### The external dependencies, one discipline


| dependency | supplies        | reached at      | color | trust of result                        |
| ---------- | --------------- | --------------- | ----- | -------------------------------------- |
| provider   | a model         | `self <- p`     | `A`   | `raw` / `graded` (Credence slot)       |
| identity   | a `principal`   | `attest … by p` | `A`   | `settled` (endorsed)                   |
| tool       | the world (MCP) | `name(args)`    | `A`   | `⊔` inputs (read) / a sink (write) |


All three are external, non-deterministic, journaled, and swappable by config. A conformal gate
needs no external dependency — it calibrates from its own recorded decisions on the spine (§13).
The membrane — capability + trust + spine + gate — is identical across them.

### Provenance

Authority (including tool use) is bounded at compile time, cognition is endorsed-and-
recorded before it acts, and every fact's provenance is auditable on an append-only spine.

---

## 14. Invariants the implementation must preserve

**Foundational** — the log is the source of truth; external capability (cognition,
identity, world/tools) enters only through a declared dependency; no hidden runtime (every sugar
desugars).

**Type & effect** — `sync` is the marked color and cannot reach a declared dependency (including a tool
call), though it may `emit` and `endorse` an in-hand `Credence`; `event<T>` marks spine
presence; a send bound to a `Credence<E>` slot yields a graded judgment, never a
committed value; the collapse `c by R` settles (`graded → settled`) off-spine, `endorse` records
it, and only a `settled` value may drive a consequential sink (a `perform` arg or a write-tool
input); fusion of two or more `Credence`s (including `quorum`) requires a total
`independent`/`dependent` declaration over the `array<Credence>`; `attest … by p` takes a
`Principal` (no `text → Principal`); user `struct`/`enum`/`event`/`action` types are explicitly
declared; a read `tool` requires a `use` grant and carries its inputs' trust; authority, trust
(three-level), color, and tool-use are checked statically and interprocedurally; a violation is a
compile error.

**Runtime** — ticks are system-level; structured output uses constrained decoding;
subscriptions are prospective and hoisted (never retroactive), and history is reached by
query; multi-handler firing is registration-order; a message trace is a prefix of
`Sent→Delivered→Resolved`; every memory write carries a provenance backpointer; all three
dependencies journal their oracle/tool results to the spine for replay (§15.4.2); the margin floor
`m` is enforced at the consequential sink.

---

# 15. Formal Semantics

> The source of truth: the abstract grammar, a static (type + effect) semantics, a dynamic
> (operational) semantics with the spine as explicit state, and the reproducibility model.
> Where §0–§14 and §15 conflict, §15 wins.

## 15.0 Modeling choices

- Two qualifiers travel with every expression. Color `c ∈ {S, A}` (does it reach a declared dependency?)
and trust `t ∈ {settled, graded, raw}` (cognition-provenance). A gate has color `A`
when its judgment touched a declared dependency, but `c by R`/in-hand-`endorse` on a `Credence` value
is `S`.
- Endorsement is a provenance property checked at the consequential sink;
modeled as a predicate `endorsed(·)`.
- Authority is a property of the agent context (its `grants`, including `use`).
- The three external dependencies (provider, identity, tool) are the only sources of dynamic
non-determinism, modeled as oracle relations (§15.4.2).

## 15.1 Notation

```
c ∈ {S,A}   color   (S ⊑ A)        t ∈ {settled,graded,raw}   trust   (settled ⊑ graded ⊑ raw)
Γ           x ↦ (T, t)             r : Rule       a decision rule {threshold, margin}
Σ           agent signatures       A              action type names (consequential)
G           grants set incl. ("perform",A) ("reach",D) ("use",K)
endorsed(v) v's settling is spine-recorded (true only via endorse / attest)
```

Judgment `**Γ; Σ; A ⊢ e : T ! c · t**`.

## 15.2 Abstract syntax (EBNF)

```
program   ::= decl*
decl      ::= typedecl | tool | agent | policy | fn | stmt
typedecl  ::= "struct" Ident "{" field ("," field)* "}"
            | "enum" Ident "{" Ident ("," Ident)* "}"
            | "event"  Ident "(" field ("," field)* ")" ";"   // a plain record (assertive)
            | "action" Ident "(" field ("," field)* ")" ";"   // a performative; a power is needed
field     ::= type Ident                                     // "name: T" also accepted
tool      ::= ("read"|"write") "tool" type Ident params config?  // mandatory effect class; write = consequential sink
agent     ::= "agent" Ident params grants? "{" abody* "}"
policy    ::= "policy" Ident config                          // a decision policy (§13)
grants    ::= "grants" "{" ( "*" | cap ("," cap)* ) "}"
cap       ::= "perform" Ident | "reach" Ident | "use" Ident
config    ::= "{" directive* "}"                             // colon-free `keyword operand…` directives
directive ::= Ident operand*
abody     ::= extend | on | stmt
extend    ::= "extend" Ident args ";"
on        ::= "on" ("awake"|"sleep"|"crash") block
fn        ::= "sync"? type Ident params block          // async is the default
params    ::= "(" (type Ident ("," type Ident)*)? ")"
type      ::= "int"|"float"|"bool"|"text"|"null" | "event" "<" type ">"
            | "array" "<" type ">"                     // collection (query results, fan-out source)
            | "Credence" "<" type ">"                  // graded judgment over enum
            | "Decision" "<" type ">"                  // a gate's committed outcome
            | Ident                                    // enum/struct/agent/action names, incl. Principal, Rule

stmt      ::= vardecl | assign | spawn | prompt | principal | depdecl
            | "awake" Ident ";" | "sleep" Ident ";"
            | "emit" Ident "(" expr ")" ";"            // a plain event (no power)
            | "perform" Ident "(" expr ")" ";"         // an action (needs a power and a settled value)
            | endorse | attest
            | "say" "(" expr ")" ";" | "return" expr? ";"
            | "if" "(" expr ")" block ("else" block)?
            | when | case | retry
            | expr ";"
vardecl   ::= type Ident ("=" expr)? ";"
assign    ::= (Ident | "self" "." Ident | postfix) "=" expr ";"
spawn     ::= "spawn" Ident Ident args? ";"            // allocate + construct (args here)
prompt    ::= "prompt" type Ident ";"
principal ::= "principal" Ident config? ";"            // config lists `attest NAME, …`
depdecl   ::= ("independent"|"dependent") Ident ("," Ident)* ";"
when      ::= "when" "(" type Ident? ("about" expr)? ")" ("if" "(" expr ")")? block
endorse   ::= "endorse" "(" expr "by" rule ")" arms ("abstain" block)? ("by" Ident block)?
attest    ::= "attest" expr "by" Ident (arms | ";")
arms      ::= "{" (Ident ":" block)* "}"               // dispatch on a Decision's variants
case      ::= "case" "(" expr ")" "as" Ident "{" (Ident ":" block)* ("default" ":" block)? "}"
retry     ::= block "retry" "(" Int ")"          // re-attempt the block up to N times on a fault
find      ::= "find" Ident ("," "origin" "(" Ident ")")? "where" "{" triple+ "}"   // → array<T>
select    ::= "select" (Ident ("," Ident)* | "*") "from" Ident "where" "{" cond "}"  // → array<Record>
match     ::= "match" expr ">" Number                                             // → array<Hit>
triple    ::= operand operand operand ";"          // subject predicate object (vars or literals)
cond      ::= cmp (("&&"|"||") cmp)*                // a boolean filter over fields
operand   ::= Ident | String | Int | Float

expr      ::= expr "<-" expr ("expires" Number)?              // send; optional lifetime
            | expr "|>" expr                            // pipe
            | expr "by" rule                            // collapse a Credence → Decision
            | "endorse" "(" expr "by" rule ")"          // gate (expr form): the endorsed Decision
            | "all" "(" expr ")" | "any" "(" expr ")"   // fuse an array<Credence<bool>>
            | "quorum" "(" Int "," expr ")"             // ≥ k of an array<Credence<bool>>
            | find | select | match                     // spine/memory queries → array<…>
            | cmp
rule      ::= "confidence" Number ("margin" Number)? | "conformal" Number | expr  // or a Rule value
cmp       ::= add (("=="|"!="|"<"|">"|"<="|">=") add)?
add       ::= mul (("+"|"-") mul)*
mul       ::= unary (("*"|"/") unary)*
unary     ::= "!" unary | postfix
postfix   ::= primary ("." Ident | args | "[" expr "]")*
primary   ::= Int|Float|String|FString|"true"|"false"|"null"|"self"|Ident
            | "(" expr ")"
            | Ident "{" (Ident ":" expr ("," Ident ":" expr)*)? "}"  // struct literal
            | "[" (expr ("," expr)*)? "]"               // array literal
```

**Collections.** `array<T>` is the collection type *produced* by queries (`find`, which may
bind many results) and *consumed* by fan-out (`|>`, `all`/`any`, `quorum`, §12). It is a
value to map and reduce over — not an imperative data structure. Agape has no general-purpose
imperative substrate of its own; heavy or world-affecting computation is imported as a tool
(§6b) and governed at the tool dependency, never reimplemented in the language.

## 15.3 Static semantics

### 15.3.1 Qualifier lattices

`color: S ⊑ A`. `trust: settled ⊑ graded ⊑ raw`, tracking cognition-provenance: `settled`
carries no un-endorsed cognition (constants, external data settled by origin, gated
`Decision`s); `graded` is a `Credence`; `raw` is unstructured model output. `⊔` is the join;
both contagious upward (a value is as `raw` as its least-settled input) unless a gate settles.

### 15.3.2 Expression rules (selected)

```
Γ ⊢ d : Agent   Γ ⊢ p : Text                    // any send invokes cognition at d; raw until bound to a Credence
──────────────────────────────  (T-Send)        Γ ⊢ (d <- p) : T_reply ! A · raw

Γ ⊢ d : Agent   Γ ⊢ p : Text    E an enum
─────────────────────────────────────────────  (T-Credence)
Γ ⊢ (Credence<E> _ = d <- p) : Credence<E> ! A · graded    // any destination d

Γ ⊢ aᵢ : Tᵢ · tᵢ    tool R K(T₁..Tₙ) declared `read`      ("use",K) ∈ G ∨ G = {*}
─────────────────────────────────────────────────────────────────────────  (T-Tool-Read)
Γ ⊢ K(a₁..aₙ) : R ! A · (⊔tᵢ)        // result carries its inputs' provenance; ILL-FORMED if use not granted

Γ ⊢ e : Credence<E> ! c · _    r : Rule
──────────────────────────────────────  (T-Collapse / GATE)
Γ ⊢ (e by r) : Decision<E> ! c · settled        // graded → settled, off-spine; rule MANDATORY

Γ ⊢ e : Credence<E> ! S · _    r : Rule          // in-hand Credence: synchronous
─────────────────────────────────────────────  (T-Endorse / GATE, recorded, sync)
Γ ⊢ endorse(e by r) : Decision<E> ! S · settled   with endorsed := true

Γ ⊢ e : _ ! _ · _    Γ ⊢ p : Principal    p may-attest dom(e)
──────────────────────────────────────────────────────────────  (T-Attest / GATE, recorded, async)
Γ ⊢ (attest e by p) : Decision ! A · settled    with endorsed := true

Γ ⊢ cs : array<Credence<Bool>> ! col · graded    dep-declared(cs)
──────────────────────────────────────────────────────────────  (T-Fuse)   // all/any/quorum
Γ ⊢ fuse(cs) : Credence<Bool> ! col · graded
        // ILL-FORMED if any pair in cs is neither independent- nor dependent-declared
```

The GATE rules (`T-Collapse`, `T-Endorse`, `T-Attest`) are the only routes to `settled`; only
`endorse`/`attest` set `endorsed`. A read-`tool` is async and carries its inputs' provenance (an
write tool is a consequential sink, §15.3.3); both require a `use` grant. `T-Endorse` is
synchronous (no dependency reach); the inline form inherits `A` from its `<-`. T-Fuse (covering
`all`/`any`/`quorum`) requires total dependence coverage over the `array<Credence>`.

### 15.3.3 Statement & agent well-formedness — the guarantees

**Effect signatures (interprocedural).** Each `f` carries `Φ(f) = (c_f, ρ_f, κ_f)`:

- `c_f ∈ {S,A}` — `A` if its body reaches any declared dependency (including a tool call) or calls any
`A`-colored `g`; else `S`. A `sync`-declared `f` asserts `c_f = S`.
- `ρ_f` — trust-transparent parameters (trust flows to the result, three-level).
- `κ_f` — consequentially-consumed parameters (fed into a `perform`/reach/write-tool, or a
`use` tool whose result is consequentially consumed).

`Φ` is the least fixpoint over the call graph; a builtin is `(A, ∅, ∅)` unless modeled.

```
// COLOR — interprocedural (a tool call forces A):
c_f = S
──────────────────────────────────────  (W-SyncSeamFree)
⊢ f  ok    // body reaches no declared dependency (no <-, no Credence-slot, no attest, NO tool call) AND calls only S fns

// AUTHORITY — perform / reach / use (DEFAULT-DENY):
allowed(C,kind,X) ⟺ G ≠ ⊥ ∧ ((kind,X) ∈ G ∨ G = {*})
──────────────────────────────────────────────────────────  (W-Auth)
in C:  ⊢ perform A(e) ok ⟺ allowed(C,"perform",A)
       ⊢ (x <- p)    ok ⟺ x = self ∨ allowed(C,"reach",typeof(x))
       ⊢ K(a…)       ok ⟺ allowed(C,"use",K)
       ⊢ emit E(e)   ok                        // a plain event needs no power

// AUTHORITY — subtractive extend:
agent C extends P
──────────────────────  (W-Extend)
grants(C) ⊆ grants(P)        // ⊥ ⊆ G ⊆ {*}; covers perform/reach/use uniformly

// THE CONSEQUENTIAL-ACTION RULE (static endorsement; runtime margin):
sink(s)     Γ ⊢ e : _ · t     t ≠ settled
──────────────────────────────────────────────────────────────  (W-Consequential-static)
s(…e…)  is ILL-FORMED       // sink = perform arg / write-tool input; an un-settled value rejected
// at runtime, for a gated decision:  endorsed(e) ⇒ margin(e) ≥ m   else the action faults

// ATTEST capability:
Γ ⊢ p : Principal    p may-attest D    e in domain D
──────────────────────────────────────────────────  (W-Attest)
⊢ (attest e by p)  ok

// CALL — trust transfer and consequential-arg rejection:
Γ ⊢ aᵢ : _ ! _ · tᵢ        t_result = ⊔ { tᵢ : i ∈ ρ_f }
∀ i ∈ κ_f.  tᵢ = settled
──────────────────────────────────────────────────────────────  (W-Call)
Γ ⊢ f(a₁..aₙ) : T ! c_f · t_result     // ILL-FORMED if some i∈κ_f is not settled
```

The endorsement half of the consequential rule is static (W-Consequential-static); the
margin floor is runtime.

## 15.4 Dynamic semantics

### 15.4.1 Runtime configuration

`⟨ Π | Ψ | Ω | Â | μ | S | k ⟩` — provider `Π`, identity `Ψ`, tool `Ω`, agents `Â`, memory
`μ`, spine `S` (append-only, `tick(S)=|S|`), continuation `k`.

### 15.4.2 The external dependencies as oracles (where stochasticity lives)

```
think  : Π × Prompt × Schema  ⇝  Value × Π             (provider; NON-deterministic)
attest : Ψ × Principal × Value ⇝  Decision×Sig × Ψ      (identity dependency; external, auditable)
invoke : Ω × Tool × Args      ⇝  Value × Ω              (tool dependency; external, effectful)
```

All three oracles' results are journaled to the spine as produced (`ThinkResolved` /
`Attestation` / `ToolResolved`). Replay never re-invokes an oracle or a tool: it serves
each from the recording in order — a write tool is replayed as its recorded
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
// COLLAPSE (c by r) — gate collapse; no oracle; off-spine:
v' = collapse(eval(e), r)        // singleton prediction set ⇒ that variant; else abstain
─────────────────────────────────────────────  (E-Collapse)
⟨…|S| e by r ⟩ → Decision v', spine S           // off-spine; endorsed(v') = false

// ENDORSE (in-hand Credence) — collapse + record; synchronous; single event:
v' = collapse(eval(e), r) ;  ev = (v' = abstain) ? Abstained(src) : Decided(src, v')
─────────────────────────────────────────────  (E-Endorse)
⟨…|S| endorse(e by r); k⟩ → ⟨…| append(S, ev) | dispatch(v', arms); k⟩   // endorsed := true; no Started/Resolved pair

// ATTEST … BY p (external gate) — identity dependency + record; async (reactive):
(Ψ, p, eval(e)) ⇝ (decision, sig, Ψ')
─────────────────────────────────────────────  (E-Attest)
⟨…|Ψ|S| attest e by p; k⟩ → ⟨…|Ψ'| append(S, Attestation(who:p,what:eval(e),decision,sig)); dispatch(decision, arms) | k⟩

// TOOL CALL (read-only) — tool dependency + record; async pair; result carries inputs' trust:
("use",K) granted    (Ω, K, eval(a…)) ⇝ (v, Ω')    t = ⊔ trust(aᵢ)
S' = append(append(S, ToolStarted(K)), ToolResolved(K, v))
─────────────────────────────────────────────  (E-Tool)
⟨…|Ω|μ|S| x = K(a…); k⟩ → ⟨…|Ω'|μ[x↦v (trust t)]|S'| k⟩   // a write tool is a consequential sink (W-Consequential)

// SPAWN — allocate + bind ctor args + run constructor; mailbox closed; hoist subs:
Â' = Â[name ↦ { type, params := eval(args), awake:false }] ;  register-hoisted-subs(ctor-body)
─────────────────────────────────────────────────────────────  (E-Spawn)
⟨…|Â|μ|S| spawn T name(args); k⟩ → ⟨…|Â'|μ| run(ctor-body); append(S, Spawned(name)) |k⟩

// AWAKE — open mailbox, emit AgentAwake, run on-awake hook (no args; state is the spine):
─────────────────────────────────────────────────────────────  (E-Awake)
⟨…|Â| awake name; k⟩ → ⟨…|Â[name.awake:=true]| append(S, AgentAwake(name)); on-awake-hook; k⟩

// CRASH — a contained fault: record, run on-crash, keep the mailbox open and state intact:
fault in a handler invocation
─────────────────────────────────────────────────────────────  (E-Crash)
⟨…|Â|S| …fault…; k⟩ → ⟨…|Â| append(S, AgentCrashed(name)); on-crash-hook; resume⟩   // not a death

// SEND — three-phase lifecycle; reply raw until Credence-bound; content not stored (only the lifecycle):
awake(dest)   (Π, render(p), schema(T)) ⇝ (v, Π')       // responder thinks through Π (the provider) — any dest
S' = append³(S, Sent(x,@d), Delivered(x,@d), Resolved(x,@d))   // subjects only; v is not logged
─────────────────────────────────────────────────────────────  (E-Send)
⟨Π|…|μ|S| x = (d <- p); k⟩ → ⟨Π'|…|μ[x↦v (trust raw; graded if x : Credence<E>, T-Credence)]|S'| k⟩

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
on scope entry:  register every when in the scope (before its statements run).
on append(S, ev'): for each live sub (in REGISTRATION order) with matches(sub, ev'): fire once.
matches(sub, ev) ⟺ subtype(ev.etype, sub.etype) ∧ (sub.subj = ⊥ ∨ sub.subj = ev.subj)
// A subscription NEVER fires for an event with tick < its registration tick.

// SUBJECTS:
src(x)=x   src(self)=current agent   src(d<-p)=binding name else @vN   src(composite)=@vN
```

## 15.5 Reproducibility, consistency, idempotency

### 15.5.1 Observable outcome vs incidental trace

For a terminal spine `S`, the observable outcome `obs(S)` is the subsequence of committed
events: performed actions, gate decisions and attestations, `case`-selected
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

`P` is stochastically consistent for provider `𝒫`, inputs `I` iff `∀ R1,R2 ∈ runs(P,I,𝒫). R1 ≈ R2`. Testable by sampling N runs (§15.5.5 makes the bound quantitative: flip
probability `≤ Σⱼ β(δⱼ)`).

### 15.5.4 Idempotency

`P` is idempotent iff its committed outcome is a function of `I` up to `≈`. The language
guarantees the decision is a stable function of gated inputs; exactly-once delivery is a
sink property (dedup by key).

### 15.5.5 Gates collapse stochasticity — margin-quantified Stability

**Margin.** For a binary gate at threshold `τ`, the margin of judgment `p` is `δ = |p − τ|`; for a multi-class gate, the gap between the top and runner-up variant. A decision
flips between runs only if run-to-run variation in `p` exceeds `δ`: big margin ⇒ stable,
small margin ⇒ fragile.

A settled value is one of two kinds:

- **exactly-gated** — a finite-schema verdict chosen with high margin. The model is forced
to answer inside a small fixed set (a `bool`, a verdict enum — constrained decoding, §8)
and answers confidently (large `δ`). The wording still varies; the bounded choice does
not.
  > ⚠ This is not string-matching free text. `(reply == "approved")` compares model
  > prose to a literal — it flips almost every run and is not exactly-gated. The exact gate
  > is over a bounded judgment — bind the reply to a `Credence<bool>` slot ("is this an
  > approval?") and gate that. `==` is exactly-gated only when both operands are already
  > bounded/committed.
- **bounded-gated** — a low-margin verdict, or one carrying open `Text` / a raw tool
result. Reproducible only up to the margin. The lint (§15.7) flags a consequential value
cleared only this way; the lint is advisory, not part of the hard conformance bar.

**Oracle model (assumption O).** Fix `𝒫`. For a given `(Π, prompt)` the provider's graded
output is a random variable whose scalar confidence has bounded variance, and two
independent draws satisfy `P(|p₁ − p₂| > δ) ≤ β(δ)` for some nonincreasing `β` with `β(δ) → 0` as `δ →` maximal. For a finite-schema reply via constrained decoding the draw
concentrates, so `β(δ_max) = 0`.

**Lemma 1 — Factoring (non-interference with endorsement).** For well-typed `P`,
`obs(P,I) = F(I, d)` is a deterministic function of inputs `I` and the gate-outcome
sequence `d`, independent of every un-settled (`raw`/`graded`) value.

> *Proof.* Read trust as an integrity lattice tracking cognition-provenance: `raw`,`graded`
> = un-endorsed cognition (high); `settled` = low. The gate (`endorse`/`attest`) is the only
> operation that settles a `graded` judgment, and it records the discharge on the spine. By
> the consequential rule (W-Consequential-static) and W-Call, every constituent of `obs` is
> `settled` — hence an input `I` (a constant or external datum, settled by origin), a gate
> outcome `dⱼ`, or a pure settled-function of these. Progress+preservation (§15.6) preserves
> the invariant under `→`. Non-interference modulo delimited release (Sabelfeld–Myers;
> Sabelfeld–Sands). A read-`tool` adds no declassifier: its result carries the join of its
> inputs' provenance, so it reaches `obs` only as `settled` (clean inputs) or through a gate
> (cognition in its inputs); a write tool is a consequential sink, covered by the same
> rule as `perform`. ∎ *(The two-run bisimulation is the mechanization obligation — §15.7,
> and the first artifact to be built with Agape.)*

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

For well-typed `P`: **(T1) Authority safety** — an agent `perform`s, `use`s, and `reach`es
only what its `grants` (powers) name; grants are subtractive under `extend`; no runtime value
extends them. **(T2) Endorsement** — the only operation that settles a `graded` judgment is a
gate (`endorse`/`attest`), which records the discharge; a gate commits a singleton `Decision`
(recorded, `margin ≥ m`) or `abstain`s. **(T3) Consequential non-interference** — no value
carrying un-endorsed cognition reaches a consequential sink (a `perform` argument or an
write-tool input); equivalently, varying the model's raw judgments
changes no world-effect except through a gate (Lemma 1, §15.5). **(T4) Reproducibility up to
`≈`** — state is a function of the spine plus recorded oracle results; a recorded run replays
to chain-head equality unconditionally; inter-agent message content is derived, not stored.
**(T5) Color safety** — no `sync` function reaches a declared dependency. Technique for
T1/T2/T5: progress+preservation. T3 is Lemma 1 (two-run bisimulation, §15.7); T4 is the
Stability theorem (§15.5.5), modulo O/NI of §15.7.

## 15.7 Mechanization and open obligations

The Stability proof rests on two assumptions discharged by machine-checked proof. The
intended mechanization (Lean 4 + Mathlib):

1. **Model Agape-core** — an idealized calculus: values, the trust lattice
  `settled⊑graded⊑raw`, the gate (`endorse`/`attest`), `commit`, and `obs`. The theorem is
   proved of the core; the implementation is argued to refine it.
2. **(NI) Non-interference (Lemma 1)** — the deterministic part. Define low-equivalence
  `≈_L` (agreement on `settled` data and endorsed decisions); prove stepping preserves it by
   a two-run bisimulation. A standard IFC development; no probability. This is the first
   artifact to be built with Agape itself.
3. **Replay corollary** — journaled `d` is a constant ⇒ `obs` equal by Lemma 1;
  deterministic.
4. **(O) Oracle bound + amplification (Lemma 2)** — the probabilistic part. State the
  calibration bound as a hypothesis (a property of the provider, not provable from the
   semantics); mechanize monotonicity in `m` and the Condorcet/Hoeffding fusion
   concentration for `quorum`, with the independence hypothesis explicit.
5. **Headline theorem** — compose 2–4.

The proof certifies Agape-core, not the implementation; closing that gap is verified-
compiler-scale work. The probabilistic part assumes the oracle is calibrated; it does not
prove the model is, but isolates exactly which empirical property the guarantees rest on.

Further obligations: **formalize the gate** — the prediction-set commit-or-abstain
semantics, the `abstain` form, the threshold and conformal bases, and `Rule` as a parameter
rather than a struct — in §15.2–§15.4, and re-discharge the soundness statements (§15.6); state
the conformal bound and calibration-readiness as hypotheses (a property of the calibration, not
provable from the semantics, alongside the oracle bound of step 4); re-prove Stability under the
three-phase message + tool model; the identity-dependency authentication contract; the
reliable/ordered channel surface; the optional distributed-spine and Multi-verse layers; and
interprocedural authority for top-level (non-agent) functions.

---

## 16. Configuration & the project manager

Every Agape project is governed by the project manager — the `agape` toolchain. A project
is a directory with an `agape.toml` manifest; configuration is baked into the project, not
passed ad hoc. The declared dependencies and the default decision parameters resolve from the
manifest.

### 16.1 The manifest

Configuration is the binding of declared dependencies (§3) to concrete resources, plus the default
decision parameters. Each `principal` / `tool` / `prompt` declaration in source
resolves to a manifest entry; an undeclared-in-config dependency is a configuration error.

```toml
[project]   name = "my-app"   entry = "main.ag"   version = "0.1.0"

# the cognition dependency
[provider]  backend = "anthropic"   model = "claude-…"   temperature = 0
            exposes_logprobs = false      # connector capability; false ⇒ sampling fallback
            fallback_samples = 10         # samples to estimate one judgment's distribution (min 10)
            fallback_temperature = 0.7    # REQUIRED when temperature = 0 and exposes_logprobs = false

# the identity dependency (`principal NAME;`)
[identity]  backend = "local-keyring"

# conformal needs no manifest entry: it calibrates from the spine, and a gate's readiness
# floor and default α live in its `policy` declaration in source (§13)

# world capabilities (the `tool NAME;` dependencies)
[tools]
search   = { mcp = "stdio:mcp-server-brave" }
transfer = { mcp = "https://payments.internal/mcp" }

# default decision parameters (NOT a dependency)
[runtime]   threshold = 0.8   margin = 0.0   consequential_margin = 0.1
```

- `**exposes_logprobs**` declares whether the provider connector returns the per-variant
distribution (`true` — e.g. OpenAI, or a local vLLM/TGI connector reading logits) or only the
committed variant (`false` — e.g. a text-only backend). When `false`, a graded gate is served by
the **sampling fallback**: the judgment is drawn `fallback_samples` times (minimum 10) and its
distribution is the empirical frequency. Sampling needs variation, so `fallback_temperature` is
**required when `temperature = 0`**. A custom connector for a local model may set
`exposes_logprobs = true`.
- `[runtime]` holds the default decision parameters — the default threshold/margin and the
consequential-margin floor `m` (§13). These are values, not dependencies.
- Swapping a dependency's backend changes no source.

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
low-margin judgment. The remedy is the margin floor `m` → escalate to a principal (`attest e by p`), or fuse independent judges by `quorum` (§12) to raise the margin.

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
records the applied `Rule` in its `Decided`/`Attestation` event), so precedence (§16.2)
is testable.

---

## 17. Deployment

An Agape runtime runs entirely in userspace. It executes programs, exposes the tool dependency as
the gated capability surface, enforces the membrane (the capability and gating discipline of
§13), and writes every consequential action to the spine for audit and replay. No kernel
support is required.

The membrane is a verifiable safety property — capability-gated and audited — in the sense
that an eBPF program earns an in-kernel seat by being verifiable rather than trusted. Pushing
that enforcement boundary into the operating system, so that the system rather than a trusted
compiler mediates an agent's consequential actions, is the aim of a separate project (AIOS)
and is out of scope here.