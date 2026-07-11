# Agape Language Specification (v1.0.0-alpha.2026.7.11.2)

> Agape is a programming language for multi-agent systems. This document is the
> authoritative reference. The prose (§0–§14) defines the language for a reader; the formal
> semantics (§15) defines it precisely enough that two implementations are obligated to agree.
> Where the prose and §15 conflict, §15 wins.
>
> Agape draws on established results from probability theory, distributed systems,
> decision theory, and information-flow security; these are cited inline where they are
> first used.
>
> Single document, two layers. §0–§15 define what programs *mean*; **§16 (The runtime)**
> defines what every conformant implementation *does* — the obligations shared by every
> conformant runtime: how ledgers, agents, private memory, replay, and runtime APIs must
> behave. The two layers are kept distinct so a reader can follow either alone, but they are
> one contract: the runtime is the operational substrate that makes the language true over time.
>
> This is the **core kernel** of Agape: the complete language with no syntactic sugar. Every
> construct here is either a kernel operation, ordinary computation over settled values, or a
> reactive primitive. There is one path from model testimony to world effect, and it is small
> enough to audit.

---

## 0. What Agape is

Agape is a language for multi-agent systems in which:

- **agents are first-class** — a spawn / awake / sleep lifecycle, private memory,
a mailbox;
- **cognition is a swappable substrate** reached only through the **provider** — a declared
dependency (the cognition backend, §17) that program code never names directly;
- **meaning is checkable, and its uncertainty is typed** — a semantic judgment asks
the provider to commit to one variant of a closed enum and returns a **graded
judgment** (`Credence<E>`, §3); `decide` is the only operation that collapses a graded
judgment into a sealed `Decision<E>`, and `endorse` is the only operation that applies that
decision to a subject value (§13);
- **the world is reached only through wired events and actions** — every
world-affecting effect (I/O, an API call, a database, heavyweight computation) enters as a
declared **event** or leaves as a declared **action**, wired in the manifest to an endpoint
catalog (§6b), enumerated and configured, never an ambient call;
- **authority is governed** — what an agent may do and which cognition-derived values may
drive consequential actions are bounded at compile time
(§13).

Two ideas underlie the language:

1. **The event ledger.** Every meaningful action appends an immutable event to a single
  append-only log. The log is the source of truth; state is a projection of it; replay
   re-derives state by folding it.
2. **Declared dependencies.** Everything outside the program — the model, an accountable
  identity, the world — is reached through a **declared seam**: a name the program
   declares but does not define, whose value configuration supplies at run time (§17). Cognition
   is the **provider**; accountability is a `**principal`**; the world is wired to declared
   **events and actions** through the manifest's endpoint catalog (§6b). Swapping a
   dependency's backend changes no Agape source.

These ideas form Agape's **trusted kernel**: `Credence`, sealed `Decision`, subject
`Endorsement`, `decide`, `endorse`, the taint lattice, default-deny grants, consequential sink checks
(`perform` — the only outbound path, §6b), and ledger record/replay. Everything else in the language is
ordinary computation over already-settled values, or a reactive primitive over the ledger. No
feature may introduce a new path from model testimony to world effect.

The whole of it in one small program — a judgment graded, decided, endorsed, and only then
allowed to act, every step on the ledger:

```agape
enum Verdict { Ship, Hold }

event  Reviewed(text note);
action Release(text build);          // a consequential sink (needs a grant)

agent Gatekeeper grants { perform Release } {
  on awake {
    text build = self <- "name the release candidate";           // testimony (raw)
    Credence<Verdict> c = self <- f"is {build} safe to ship?";   // graded judgment
    Decision<Verdict> d = decide c by confidence 0.9;            // sealed; ledgered as Decided
    if (d.committed == Ship) {
      Endorsement<text> e = endorse build by d;                  // the settled subject
      perform Release(e);                                        // the granted sink
    } else if (d.committed == Hold) {
      emit Reviewed("held");
    } else {
      emit Reviewed("abstained — no action");                    // fail closed
    }
  }
}

spawn Gatekeeper g;
awake g;
```

### 0.1 Scope and layering

Agape is a domain language for the cognitive/agentic layer; it is not a general-purpose
language. General-purpose computation — arithmetic-heavy kernels, data structures,
parsers — is imported through the world interface (§6b) — an MCP endpoint in the manifest's
`[tools.*]` catalog, wired to declared events and actions — never reimplemented in Agape:
Agape has no imperative substrate of its own. The deterministic work lives in the host and is
reached, and governed, through that wired seam. The
primitive Agape provides is **endorsed judgment under uncertainty**: a non-deterministic
semantic decision, trust-tracked, collapsed by an auditable gate, recorded on an
append-only ledger.

The kernel boundary is intentionally small. A conformant implementation may
be large, but its authority to act must reduce to the same chain:

```
testimony -> Credence<E> -> Decision<E> -> Endorsement<T> about subject T -> granted sink -> ledger
```

### 0.2 Execution model

An Agape program is evaluated **top to bottom**, like an ordinary program — not as a
perpetual event loop. Reactivity happens *within* that evaluation: appending an event to
the ledger synchronously fires any matching subscription before evaluation continues. The
program **terminates at quiescence** — when the top-level statements are exhausted and no
subscription work remains.

A long-running or simulated environment is expressed explicitly, never by making the
language itself a loop. Computation is **total**: the language has no unbounded control
construct — control is `if`, event-driven reaction (`when`), bounded fan-out over finite
collections (§12), and function call — so every reaction terminates. The one way a program
stays live is an open external input source (`prompt`, §5b, or a standing sensor, §6b) that
keeps it from quiescing. An always-on agent is not one long non-terminating computation; it
is an unbounded sequence of finite, terminating reactions — one per external event — over a
single growing ledger, so replay and the reproducibility guarantees (§15.5) hold per event.
The default — no open source — is deterministic, terminating, top-to-bottom evaluation.

**Concurrency and determinism are independent.** Agape is genuinely concurrent,
asynchronous, and event-driven: agents overlap in lifetime, a send returns immediately
and resolves later, and a fan-out over a collection (§12) can have many dependency calls in
flight at once. What Agape excludes is nondeterministically scheduled interleaving. There is
no shared mutable state to race over (each agent owns its memory, §10), and the ledger
assigns a total order to observable effects, so independent cognition runs in parallel while
the observable result is serialized. The model is a discrete-event simulation: concurrent and
replayable at once. Determinism here is a property of the scheduler, not a denial of
concurrency.

---

## 1. The four orthogonal axes

Agape tracks four independent properties that are easy to conflate.

### Axis A — function reachability: pure vs async

- Code is **asynchronous by default**. The common case is cognition, which is async.
- `**pure`** is the marked keyword. A `pure` function may not touch a declared dependency (no `<-`, no
binding to a `Credence` slot, no `perform`, no principal-driven `decide`)
and may only call other `pure` functions.
- `pure` is an affirmative, auditable claim of cognition-freedom and effect-freedom; it
propagates downward. Marking the safe property makes visible which code provably cannot
reach a model, the world, or a human. It is not a scheduling promise that the function
must monopolize the executor; runtimes may still meter or cooperatively schedule local work.
- `emit`, rule-driven `decide` over an in-hand `Credence`, and `endorse` over an in-hand
committed `Decision` are not dependency reaches and are permitted in `pure`; a principal-driven
`decide` reaches identity and is async. Only reaching a declared dependency forces async.

### Axis B — value trust: how settled is the value?

Trust records a value's cognition-provenance. Agape uses three levels (§13, §15.3.1):

- **raw** — raw, unstructured model output: a `<-` reply before it is bound to a `Credence`.
- **graded** — the credence tier: a quantified judgment, a `Credence<E>` (a
constrained distribution over a closed enum's variants, §3). More structured than **raw**
— the model has been forced to commit to a fixed set of outcomes — but not yet
committed by a gate. Recalled memory also defaults to **graded** (§10).
- **settled** — a value carrying no un-endorsed cognition: a sealed `Decision`, an
`Endorsement` of an exact subject value, a constant, or external data at an ingress
boundary (`prompt`, sensor, or wired result-event payload, §5b, §6b).

Trust is contagious upward; only a gate moves cognition down toward **settled**. A
consequential action may consume only a **settled** value: for cognition-derived
subjects, the settling is recorded on the ledger as a `Decision` plus committed
`Endorsement`; constants and external ingress values may be ordinary program data
because they carry no un-endorsed model cognition (§13). This says nothing about
whether external bytes are safe, policy-compliant, or non-adversarial; that is tracked
by the ingress axis below.

### Axis C — ledger presence: values vs ledger records

Every dependency reach and kernel transition is ledgered, but ordinary provider replies
are ordinary typed values. If a program declares `struct Receipt { text id }`, a binding
such as `Receipt r = self <- "..."` records the send lifecycle
(`Sent`/`Delivered`/`Resolved`) and yields an ordinary user-defined `Receipt` value; it
does not wrap the value in a surface `event<T>` type or imply a built-in send handle.
Ledger presence is inspected through events and ledger queries, not by changing the
reply's value type.

Named `event Foo(...)` declarations remain the way to define ledger-record payloads for
`emit`, `when`, and typed ledger queries. A matched event binding exposes its payload
fields directly (`h.reason`) and reserves `_meta` for event metadata.

### Axis D — ingress provenance: where did external bytes enter?

Ingress provenance records whether a value contains data that entered from outside the
Agape program. It is separate from judgment trust:

- **internal** — produced inside the program or by trusted kernel operations without
external payload bytes.
- **external_unscreened** — carries prompt, standing-sensor, or result-event data that
has entered from the world and has not passed a manifest-configured ingress screen.
- **external_screened** — carries external ingress data whose configured screen ran and
recorded an accepting verdict for the bytes delivered to the program.

Ingress joins upward (`internal ⊑ external_screened ⊑ external_unscreened`) and is
preserved by ordinary computation. Manifest-level screening may convert a value at an
ingress boundary from `external_unscreened` to `external_screened`; there is no source
syntax for screening and no expression-level cast. Unscreened ingress flowing into a
provider/cognition prompt is governed by the manifest security policy (§17): default
warn, strict deny, or off. Consequential actions are not governed by an ingress
allow/warn/deny knob; they remain governed only by the fixed `perform` sink rule over
judgment trust (§13).

### The axes are independent

| construct                            | async? | judgment trust       | ingress provenance | # events | type             |
| ------------------------------------ | ------ | -------------------- | ------------------ | -------- | ---------------- |
| `Credence<bool> c = self <- "is …?"` | yes    | `graded`             | joins prompt expr  | lifecycle | `Credence<bool>` |
| `decide c by r`                      | no     | `settled`            | joins inputs       | single    | `Decision<bool>` |
| `endorse memo by d`                  | no¹    | `settled`            | joins subject      | single    | `Endorsement<text>` |
| `alice decide c by r`                | yes    | `settled`            | joins inputs       | 1 or 2¹   | `Decision<Verdict>` |
| `Credence<E> c = peer <- "…?"`       | yes    | `graded`             | joins prompt expr  | lifecycle | `Credence<E>`    |
| `perform Search(q) expires 5` (wired, §6b) | yes | `settled` (⊔ args) | external unless screened | act+pair+result | `text` |
| `double(3)` (pure)                   | no     | `settled`            | `internal`         | no        | `int`            |

¹ `endorse` over an in-hand committed `Decision` is synchronous (record only, no dependency
reach). A principal-prefixed `decide` is async (it may reach the identity dependency) and always
appends `Decided`, plus **1** terminal identity event (`PrincipalDecision`, or
`FailedPrincipalDecision` on decline) when it escalates. A rule-only `decide` appends exactly one
`Decided` event. See §13.

- A semantic judgment yields a `Credence<E>` — a graded distribution over the variants of
enum `E`, not a `bool`. To obtain a committed value, gate it with `decide c by r`; the rule is
never hidden.
- `decide c by r` is the gate (`graded → settled`); it is seam-free for a rule-only gate and async when
prefixed with a `principal`.
- `endorse subject by d` applies the decision to that exact subject value and yields an
`Endorsement<T>`, the settled form admissible for consequential use (§13).
- A `Credence` is produced by binding a send to a `Credence<E>`-typed slot (§3, §8), whatever
the destination. If the rendered prompt contains `external_unscreened` ingress, the
manifest's provider-prompt ingress policy applies (§17).

The axes, one per comment, in a single agent:

```agape
pure int fee(int cents) { return cents / 10; }   // pure: provably no dependency reach

agent Teller {
  on awake {
    text note = self <- "describe the request";              // async · raw · lifecycle events
    Credence<bool> ok = self <- f"is this routine: {note}";  // async · graded · lifecycle events
    Decision<bool> d = decide ok by confidence 0.8;           // local collapse · settled · Decided
    if (d.committed == true) { emit Event("routine"); }      // branch on a settled fact
    else if (d.committed == false) { emit Event("escalate"); }
    say(f"fee: {fee(1250)}");                                // pure call · settled · no events
  }
}
spawn Teller t; awake t;
```

---

## 2. Lexical structure

- **Comments:** `//` to end of line.
- **Whitespace:** insignificant except as a token separator.
- **Statement terminator:** `;` (explicit, required).
- **String:** `String` = `"..."` with escapes `\n \t \" \\`.
- **F-string:** `FString` = `f"...{expr}..."`. Lexed as one `FSTR` token; `{expr}` parsed after.
- **Numbers:** `Int` = a decimal integer (`42`); `Float` = a decimal with a point (`3.5`).
The grammar terminal `Number` = `Int | Float` (so `conformal α` accepts either; `quorum(Int, …)`
requires an `Int`).
- **Identifiers:** `Ident` = `[A-Za-z_][A-Za-z0-9_]`*. Type names are conventionally capitalized;
values and instances are lowercase.
- **Operators (multi-char first):** `<-  ->  |>  &&  ||  >=  <=  ==  !=  { } ( ) [ ] ; , . : =
  +  -  *  /  <  >  !`
- **The two arrows:** `<-` is the one communication/write arrow (send a message, write a
  `mem`, §6, §10); `->` is the memory-recall operator (`mem -> "query"`, §10). `->` is **not**
  a `LexError` — it lexes as an operator, and the checker rejects it on a non-`mem` left-hand
  side as a `TypeError` (§10).

### Keywords

```
int float bool text null event action       // scalar types + event/action declarations
agent extend pure                         // declarations (pure = marked seam-free function)
struct enum                               // user nominal-type declarations
grants                                    // capability typing (§13)
spawn awake sleep crash self on prompt instruction   // lifecycle (incl. `on crash`) + external input sensor + system prompt (§5)
principal                                 // accountable identity (§3, §13)
when if else return                       // control / reactive
decide endorse perform emit               // gate collapse / subject endorsement / action perform / event emit
select from where                         // the ledger query (§10)
mem forget                                // private-memory handle + seams (§10): `mem m <- v` / `m -> q` / `forget m`
quorum independent dependent              // graded fusion + dependence declaration (§12)
task complete fail cancel                 // delegation: the task literal + task verbs (§6c)
true false abstained                      // bool literals + the abstained-decision sentinel (§3, §13)
```

`decide` is the only gate collapse: it turns a `Credence<E>` into a sealed `Decision<E>`.
`endorse` applies a `Decision<E>` to a specific subject value and yields a settled
`Endorsement<T>` (§13). `independent` / `dependent` declare the dependence structure of values fused
by `quorum` (§12).

**Contextual words** are recognized only in their syntactic position; elsewhere they lex as
ordinary identifiers, and a declaration may not use one where it would collide with that position:
`by` (gate rule), `about` (the `when` subject filter, §7), `reach` (grants), `origin`
(query projection), `expires` (send-lifetime clause, §6; also the `perform`-binding lifetime, §6b),
`confidence` / `margin` / `conformal` /
`floor` / `readiness` (rule clauses, recognized positionally after `by`, §13), `objective` /
`acceptance` / `scope` (task-literal clauses, recognized only inside `task { … }`, §6c). `Error` (a prelude
identifier) doubles as the only permitted user-event supertype in `event Foo(..) : Error;` (§9).

**Prelude identifiers** (selected; the full set is defined in §9, not the grammar): the types
`Credence`, `Decision`, `Endorsement`, `Principal`, `TaskSpec`, `Task`; the enum `Entailment`
(`Entails`, `Contradicts`, `Neutral`) and `Basis`; the built-in events `Event`, `Error`, `Decided`,
`Endorsed`, `PrincipalDecision`, `FailedPrincipalDecision`, `Contradiction`, `Spawned`, `AgentAwake`,
`AgentAsleep`, `AgentCrashed`, `Sent`, `Delivered`, `Resolved`, `Expired`, `DeliveryRefused`,
`PromptOpened`, `Prompt`, `QueryResult`, `MemoryConsulted`, `Internalized`, `ArtifactObserved`,
`Forgotten`, `ToolStarted`, `ToolResolved`, `TypeMismatch`, `MarginFloorViolation`,
`TaskCompleted`, `TaskFailed`, `TaskCancelled`, `TaskProgress`, `CompletionRefused` (and the
subscription aliases `TaskSubmitted`, `TaskAssigned`, `TaskExpired`, §6c);
the built-in function `say`; and the generic ledger row type `LedgerEntry<E>`. (`Rule` is
the gate's parameter, not a type — §3.)

Most of the lexical surface in a few lines — comments, the two arrows, f-strings, numbers,
and the explicit terminator:

```agape
// a line comment; every statement ends in ;
agent Notes {
  on awake {
    mem log <- "the first note";                     // <- writes into a mem region
    text hit = log -> "what was noted?";             // -> recalls (always tainted)
    Credence<bool> b = self <- f"useful? {hit}";     // an f-string interpolates {expr}
    Decision<bool> d = decide b by confidence 0.75;  // Number literals: 0.75, 42
    if (d.committed == true) { say("kept"); } else { say("dropped"); }
  }
}
spawn Notes n; awake n;
```

---

## 3. Types

### Scalars

`int`, `float`, `bool`, `text`, `null`.

### `event<T>` — ledger-message type

Removed from the surface language. Use bare `T` for typed provider replies, and use
named `event Foo(...)` declarations for ledger records.

### Collections and ledger entries

`T[]` is the collection type produced by queries and structured provider replies and
consumed by fan-out/fusion constructs. The older spelling `array<T>` is not the canonical
surface syntax.

`LedgerEntry<E>` is the typed receipt/row shape for an objective ledger event of named
event type `E` (including built-in events such as `Internalized` and user events such as
`Held`). Payload fields are available directly, while event metadata lives under `_meta`:

```agape
LedgerEntry<Held>[] rows =
  select Held as h from ledger where { h.reason == "late" };

say(rows[0]._meta.tick);
say(rows[0].reason);
```

### User nominal types

User-defined nominal types are explicitly declared. Explicit declaration is what makes the
`event`/`action` distinction and grant-set checking statically decidable: an `action`
type is a declared name with a known payload.

```agape
struct Memo  { amount: int, to: text }            // a record; all fields required
enum  Ticket { Billing, Bug, Feature }            // a closed variant set
action Transfer(int cents, text to);               // a performative; fields invoked positionally
action Wire(int cents, text to);                   // wired to an effector in the manifest, or pure (§6b)
```

- `**struct NAME { field: T, … }**` — a record with named, typed fields. All fields are
required: structured output (§8) has no optional-by-omission, so optionality is modeled
as a nullable union field. A struct literal is `NAME { field: v, … }` and must supply
every field; a missing field is a `TypeError`.
- `**enum NAME { A, B, … }**` — a closed set of named variants; `if`/`==` branches on a committed
variant (§11).
- `**event NAME(T field, …);**` — a plain record (assertive); anyone may `emit` it, no power
needed. `**action NAME(T field, …);**` — a performative: `perform NAME(v, …)` is a
consequential act that needs the `perform NAME` power (§13) and only `settled` values. Whether
performing it also invokes an external effector is a deployment fact: the manifest may **wire**
the action to an endpoint in the `[tools.*]` catalog (`[actions.NAME]`, §6b, §17.1); several
actions may share one endpoint (different domain framings). An **unwired** action is a **pure
ledgered performative** — an act whose effect is the record itself. Event/action/function
parameters are declared **type-first** (`T name`, like a `var`); a **struct** field is the sole
exception and is declared **name-first** (`name: T`, mirroring the struct literal `NAME { name: v }`).
Event/action invocation is positional in declaration order: `emit E(a, b)` / `perform A(a, b)` must supply exactly one
argument per declared field, and each argument must match the corresponding field type. The field
names remain part of the declared event/action schema and canonical payload. An undeclared
`emit`/`perform` is a `TypeError`. Explicit declaration is what lets `grants { perform NAME }` be
checked statically.

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
the slot's enum is the output schema, so the model is forced to answer inside `E` by the
provider's structured-output / constrained-decoding API. Prompt wording is not the enforcement
mechanism; the type annotation is. It is consumed only by `decide` (§13) and by the graded
combinator `quorum` (§12). It is not
a probabilistic-programming distribution object: there is no inference, conditioning, or sampling
combinator. Producing a `Credence<E>` any other way (e.g. from arithmetic) is a `TypeError`;
consuming one anywhere but the gate or `quorum` is a `TypeError`.

```agape
enum Route { Handle, Escalate }

Credence<Route> route =
  self <- f"triage this request: {body}";
```

The provider receives the rendered prompt plus a schema whose only legal categorical outputs are
`Handle` and `Escalate`. If the backend returns prose, an extra label, or a malformed structured
object, the runtime raises `TypeMismatch` (§8, §16.6); it does not parse free text into a variant.

**Why a scored distribution over an enum, and not an inherent probability guarantee.** The value
is categorical (a score distribution over exhaustive, mutually-exclusive variants), not a scalar in
`[0,1]`. The variants being mutually exclusive and exhaustive is exactly why the recorded scores
are normalized to sum to 1; the type *is* that constraint. Normalization does **not** mean the
scores are calibrated probabilities. A `Credence<E>` is structured testimony with provenance: it
tells the gate what the provider scored, over which fixed label space, under which schema and
prompt, not that the score is already decision-theoretically trustworthy.

**Where the score comes from.** A `Credence` is read from the provider's constrained categorical
decision — the model's scored answer inside the enum's variants — not from a model's verbalized
self-rating. Verbalized confidence is systematically overconfident; token/logit scores and
sampling frequencies are better structured but still distribution- and task-specific. A provider
that exposes logprobs or equivalent per-variant score data (`exposes_logprobs`, §17) yields
per-variant scores from the forced decode; one that does not (a text-only backend) is served by the
**sampling fallback** —
drawing the forced choice `fallback_samples` times and taking the empirical frequency (§17). The
runtime journals the score vector and its provenance on the ledger (§15.5.1). Calibration is not
intrinsic to `Credence`; it is a property of a compatible **GateProfile** (§13, §16.8) fitted from
ledgered labels.

### `Rule` — the gate's parameter (not a primitive)

A `Rule` is **not** a first-class type or a primitive — it is the parameter a gate decides by, a
value that carries its own *basis*, so the gate is uniform ("apply this rule to this `Credence`")
whatever basis the rule holds. Two bases (§13):

- **threshold** — `confidence θ` (optionally `confidence θ margin δ`): commit the top variant when
its score ≥ `θ` and its lead over the runner-up ≥ `δ`, else abstain. `margin δ` constrains the
top-vs-runner-up gap for any enum; for exactly two variants (and `bool`) the gap is monotone in the
top score, so `δ` is redundant with `θ` there — it is **accepted as a no-op**, not an error. Cheap,
needs no data, no guarantee. When backed by an active calibrated GateProfile, the same basis can be read as
a calibrated probability threshold or expected-loss boundary; without that profile it is an
explicit heuristic.
- **conformal** — `conformal α`: a distribution-free, finite-sample coverage bound at level `α`,
calibrated from the gate's own recorded labels on the ledger (§13, §15.5.6). The conformal
procedure produces a prediction set and commits only on singleton sets. It does not require the
provider scores to be calibrated probabilities.

A rule may carry a consequential **`floor m`** — the margin floor checked at the sink (§13) — and a
conformal rule may carry a **`readiness N`** — the minimum labelled cases before autonomous commit.
A `Rule` is a value — a literal (`confidence 0.9`), a reference (`conformal 0.1`), or one a pipeline
computed (`self.policy_rule`). A rule-driven `decide` requires a rule basis.

### Declared dependencies — `principal` (and `prompt`)

Everything the program reaches but does not define is a **declared dependency**: a name declared in
source, bound to a concrete resource by configuration (§17). It is one construct, fixed by a single
fact — *it is supplied from outside the program* — from which the rest follows: **declared, not
constructed** (no literal form — `text → Principal`, etc. are `TypeError`s);
**config-bound**; **opaque** (the program cannot read a signing key or an endpoint's credentials);
**unforgeable** (only configuration may supply it); and **used only at a governed site**, recorded
on the ledger. Two flavours differ only in what they supply:

| declaration        | supplies                       | used at                      |
| ------------------ | ------------------------------ | ---------------------------- |
| `prompt T name;`   | an external input source (§5b) | `when (Prompt p about name)` |
| `principal name;`  | an accountable identity        | `name decide c by r`         |

The world is deliberately **not** a source-declared dependency: it is reached through declared
events and actions wired in the manifest to the `[tools.*]` endpoint catalog (§6b, §17.1), under
the same discipline — config-bound, opaque, unforgeable, ledgered.

```agape
principal alice;          // an accountable identity, resolved by config (§17)
```

A `principal` is the escalation prefix of a decision (`alice decide c by r`, §13); its own trust is
`settled`, and a name is a forgeable claim, not a credential (a string in the prefix position is a
`TypeError`). A conformal gate needs no separate dependency: it calibrates from its own recorded
decisions on the ledger, and below the rule's `readiness` minimum of labelled cases it abstains. No
credential appears in source; it is bound in the manifest (`[identity]`, §17), and
authentication/signing happen at the gate, not the declaration. `Credence<E>` is **not** a declared
dependency — it is a value *received* from the provider, not a declared name.

### The judgment enums (prelude — §9)

A pure enum — a categorical outcome and nothing more; all contextual metadata lives on the
ledger event that carries it.

- `**Entailment`** — `enum Entailment { Entails, Contradicts, Neutral }` — what a
`Credence<Entailment>` judgment commits to. A `Credence<bool>` commits to `true`/`false`.

A `Credence<E>` is the graded judgment before the gate; the committed variant is what the gate
produces. The graded layer is where a model's "0.87" lives — the `Credence` carries it;
the decided enum does not pretend to.

---

## 4. Functions

```
[pure]? RET_TYPE NAME ( [TYPE PARAM] , ... ) { BODY }
```

- A leading optional `pure` marks cognition-freedom and effect-freedom (Axis A); unmarked
= async.
- `RET_TYPE` is type-first.
- A function returns an ordinary value. To return a ledger row/receipt, use a concrete type such
  as `LedgerEntry<Held>` or `LedgerEntry<Internalized>`.

```agape
pure int   double(int x)            { return x * 2; }                 // pure, bare int
pure Decision<bool> collapse(Credence<bool> c) { return decide c by confidence 0.9; }  // pure; the collapse is deterministic
Credence<bool> about_poker(text x)  {                                 // async, graded judgment
    Credence<bool> c = self <- f"is {x} a game of poker?";
    return c;
}
```

A rule-only `decide c by r` is seam-free (§13). The cognition is in producing the `Credence` (the
provider send bound to a `Credence` slot, which is async); applying a threshold/margin to a
`Credence` value is pure comparison. So a `pure` function may take a `Credence` and decide it by a
local rule; the judgment is agentic, the collapse is deterministic, and the decision is fixed
given the `Credence` (§15.5). A `pure` function may likewise `emit`, and may `endorse` a subject
by an in-hand `Decision` (record only, no dependency reach); it may not use a `principal`-prefixed
`decide` (`p decide c by r` reaches the identity dependency = async)
and may not `perform` (every `perform` is async, §6b).

---

## 5. Agents

### Declaration (template)

```agape
agent NAME ( [TYPE PARAM] , ... ) [grants { CAP , ... }] {
    FIELD_DECLS          // typed value slots, mem handles, etc.
    CONSTRUCTOR_STMTS    // run at spawn (see Lifecycle)
    when (SUBJECT) { ... }
    on awake { ... }
    on sleep { ... }
    on crash { ... }     // a contained fault — recover here; state is intact
    on assigned { ... }  // a delegated task arrived (sugar over `when`, §6c)
    on cancelled { ... } // the active task was cancelled by its delegator (§6c)
}
```

- `agent` is a template (like a class). A field `T name;` is a typed value slot.
- The `( TYPE PARAM , … )` list declares the constructor parameters; they are bound at
`spawn`, when the constructor body runs — not at `awake`, which takes no arguments (see Lifecycle).
- `self` is the agent's reference to itself.
- `extend PARENT(args);` (first statement) is composition/inheritance.
- `grants { ... }` (optional) declares the agent's authority (§13).

### Lifecycle

Each transition is a ledger event. Construction is at `spawn`; `awake` and `sleep` toggle the
mailbox:

- `**spawn TYPE name(args);**` — allocate and construct. Give the instance an address, bind the
constructor parameters to `args`, run the constructor body, and hoist its subscriptions. It
reaches no cognition and opens no mailbox yet. Appends `Spawned(name)`.
- `**awake name;**` — announce: open the mailbox, append `AgentAwake(name)`, and run the
`on awake` hook. It takes no arguments; the constructor already ran at `spawn`. A re-`awake`
after `sleep` resumes the agent — and loses nothing, because the agent's state is a function of
the ledger, not fragile in-memory state.
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

### `instruction` — the compile-time system prompt

```agape
instruction "You are a careful agent. Prefer abstaining to guessing.";   // global

agent A {
    instruction "Answer in one sentence.";   // agent-scoped; composes after the global block
}
```

`instruction STRING;` declares a **compile-time system prompt** — the behavioral spec the
provider sees behind every `<-`. Its argument is a string literal; a non-string argument is a
`ParseError`.

- **Scope.** A top-level `instruction` is the **global** prompt (every agent inherits it). An
`instruction` inside an agent body is **agent-scoped** and composes **after** the global block
(fixed order, for determinism). `extend` inherits the parent's instructions and appends the
child's (append-only — a child cannot silently weaken a parent's guardrails).
- **Settled by source.** An instruction is procedural behavior, and procedural behavior lives
in **source, not mutable memory** — it is `settled` by origin and injection-proof: no recalled
fact or injected memory can rewrite it, because the system prompt is not in memory (contrast a
runtime jotted note, which lands in tainted memory, §10). To change an agent's behavior you
**ship a new version**; runtime self-modification of instructions is deliberately absent.

### Lifecycle hooks vs `when`

`on awake` / `on sleep` / `on crash` are hooks tied to the agent's own transitions; `when (X)`
is a general ledger subscription keyed by an arbitrary subject `X` (§7). `on crash` runs in the
agent's own context after a contained fault (see Lifecycle), with state preserved, so it can
compensate for or retry the abandoned work. The two task hooks are pure sugar over `when`
(§6c): `on assigned` fires when a delegated task is delivered to this agent (the filtered
`Delivered` subscription), `on cancelled` when the agent's active task is cancelled by its
delegator. There is no `on submitted` (the delegator's next statement already follows the
send) and no worker-side `on completed`/`on failed` — outcomes are observed with ordinary
`when` subscriptions on the task events (§6c).

### §5b — `prompt`: the external input boundary

```agape
prompt text question;          // opens a standing external input SENSOR
```

`prompt TYPE name;` declares an external input source — the push mirror of the pull send
`<-`. Each external arrival lands a `Prompt` event on the ledger with subject `name`. React
with `when (Prompt p about name)`, where `p` evaluates to the arrived value.

- A `prompt` source makes a program always-on (§0.2): while open it cannot quiesce; when
it closes (EOF) the program reaches quiescence and ends.
- Its values are external data at the program boundary. They are **judgment-settled**
  (§13): they carry no un-endorsed model cognition and may be ordinary program data.
  Separately, they enter with ingress provenance `external_unscreened` unless the
  manifest binds the prompt source to a replayed screen that records an accepting verdict,
  in which case the delivered value is `external_screened` (§17). Agape gates model
  judgment; it does not by itself mark external input safe.
- If a prompt value is interpolated into a provider/cognition prompt, the manifest's
provider-prompt ingress policy applies: default warn, strict deny, or off (§17). That
policy is only for ingress-to-cognition; it does not add an action-sink relaxation.
- `prompt` is one of a family of sensors (socket, timer, queue, file watch — a standing
sensor is an event wired in the manifest, `[events.NAME]`, §6b), sharing one runtime contract:
an external source that appends events to the ledger as they arrive, including the recorded
ingress provenance and any screening verdict, so replay folds the recorded input stream
deterministically.

---

## 6. Communication — the send operator `<-`

`dest <- message`

- A send `dest <- p` goes to the agent at `dest`, which answers by thinking — invoking the
model through the provider. `self` is just your own address: every agent reasons through the
same provider, so the destination changes only which agent thinks, never the kind of operation.
- A typed reply (`T x = dest <- "…";`) is the responder's structured output for `T`
(§8); binding it to a `Credence<E>` slot constrains that output to `E`'s variants and yields
a graded `Credence` (§3, §8) — for any destination.
- A bare reply is `raw`; the `Credence` binding is what grades it. Either way a reply is an
ordinary value: it reaches the ledger only by being emitted, performed, or gated, never by
being produced — so a send logs its lifecycle, not its content (§15.4).
- Every send is asynchronous and actor-routed: it carries the `Sent → Delivered → Resolved`
lifecycle (below) and may be lost or expire — `self` included. A send is a send; the
destination is only an address.

```agape
agent Analyst {}
agent Desk(Analyst quant) grants { reach Analyst } {
  on awake {
    text view = quant <- "one-line view on the filing" expires 5;  // Sent → Delivered → Resolved
    Credence<bool> agree = self <- f"do we agree: {view}";        // graded when Credence-bound
    Decision<bool> d = decide agree by confidence 0.8;
    if (d.committed == true) { emit Event("aligned"); }
    else { emit Event("review"); }
  }
}
spawn Analyst a;
spawn Desk desk(a);
awake a;
awake desk;
```

### The message lifecycle — `Sent → Delivered → Resolved`

Every send moves through three phases, each an event on the ledger, correlated by `corr`:

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
below `Delivered`. The delivery contract is at-most-once.

### Expiry — an optional tombstone

A send may carry a lifetime: `dest <- message expires N;`, where `N` is any **settled**
numeric expression (a literal, an `int` variable, arithmetic over them — not a graded or raw
value). Expiry adds a second terminal branch:

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

## 6b. The world interface — wired events and actions

Cognition is reached through the provider; accountability through the identity dependency;
the world is reached through **wired events and actions**. The program speaks only `event`
(inbound — the world talks *to* the program in events) and `action` (outbound — the program
acts *on* the world in actions). **"Tool" is a manifest concept**: an endpoint in the
deployment's `[tools.*]` catalog that events and actions are wired to (§17.1). No `tool`,
`read`, `write`, `uses`, or `use` exists anywhere in the language. The catalog speaks the
**Model Context Protocol (MCP)** — an enumerated, declared, permissioned tool-call protocol —
so a deployment imports the MCP tool ecosystem as wirable endpoints without Agape inventing
its own ABI. The catalog is the controlled-FFI surface: Agape does not link arbitrary foreign
code (cf. eBPF helper functions: a fixed set of approved calls, never arbitrary linkage).

```agape
event  SearchResult(text hits);      // inbound:  the world talks TO the program in events
action Search(text query);           // outbound: the program acts ON the world in actions
action Deploy(text artifact);
action Announce(text note);          // unwired action: a pure ledgered performative

agent Researcher grants { perform Search } {
  on awake {
    text hits = perform Search("prior art") expires 5;   // foreground binding (below)
    emit Event(f"found: {hits}");
  }
}
```

```toml
[tools.web_search]                   # the endpoint catalog — the ONLY place "tool" exists
driver = "mcp"
tool   = "web.search"

[actions.Search]                     # outbound wiring: perform → effector; reply → event
tool         = "web_search"
result_event = "SearchResult"

[actions.Deploy]                     # outbound wiring, fire-and-forget (no result event)
tool = "infra_deploy"

[events.NewsArrived]                 # inbound wiring: a standing sensor appends events
tool = "news_feed"

[events.SearchRequested]             # emit-trigger wiring: the LOOSE observation channel
tool         = "web_search"
result_event = "SearchResult"
```

- **Source declares WHAT exists** — typed events and actions (§3). **The manifest declares
HOW they touch the world** (§17.1): `[tools.*]` is the endpoint catalog; `[actions.NAME]`
wires a `perform` to an effector, optionally naming the `result_event` its reply lands as;
`[events.NAME]` wires an event either as a **standing sensor** (arrivals append it — like
`prompt`, §5b, it keeps the program always-on) or as an **emit-trigger** (emitting it invokes
the endpoint; the reply lands as `result_event`). No endpoint or secret appears in source,
exactly as `<-` names no model.
- **Unwired = pure.** An unwired action is a pure ledgered performative — the act is the
record (§13); an unwired event is a plain record. Wiring is additive and changes no program
semantics — only what the deployment does at the seam.
- **Read vs write moves to which verb you wire.** There is no `read`/`write` effect class;
the verbs' existing trust semantics carry it. Wire a read to an **`emit`**
(`[events.SearchRequested]`): `emit` is not a consequential sink, so tainted payloads may
flow — the loose observation channel (RAG-style, model-suggested queries), now an explicit,
manifest-visible opt-in. **No laundering:** the `result_event` payload carries the JOIN of
the triggering emit's payload trust — a raw query taints its own results. Wire a read (or
any effector) to a **`perform`** (`[actions.Search]`): the uniform consequential-sink rule
applies (§13) — **settled args only**. Prompt, sensor, and result-event values can satisfy
this judgment-trust rule because they carry no un-endorsed model cognition, but they still
carry ingress provenance (`external_unscreened` or `external_screened`). Model-generated
payloads must be gated first.
- **Anti-exfiltration.** On the perform path no un-endorsed cognition ever leaves the
process — T3 non-interference (§15.6) extends to observation requests. A deployment that
wires **all** its outbound seams to actions has the hard guarantee; each emit-wiring is a
visible, auditable exception in the manifest. This guarantee is about cognition-derived
content; ingress provenance is handled by the provider-prompt policy below, not by a
separate action-sink knob.
- **Trust and ingress.** A result-event or sensor payload is external data. Its judgment
trust is **joined** with the request payload's trust: on the perform path a settled
request yields judgment-settled results; on the emit path a tainted query taints its own
results. Separately, the result or sensor payload's ingress provenance is
`external_unscreened` unless the manifest-configured screen for that ingress records an
accepting verdict, in which case it is `external_screened`. A standing-sensor arrival has
no request payload and is judgment-settled like `prompt` (§5b), while still carrying
external ingress provenance.
- **Authority.** `perform NAME` (grants, §13) governs all outbound acts, wired or not.
Emitting stays grant-free: an emit-wired observation is deployment-controlled through the
manifest, not grant-controlled — a documented posture mirroring `prompt`.
- **Color.** Every `perform` is async (`A`): an act is an act; whether it reaches the world
is a deployment fact the checker must not depend on. Expressions can never reach the world;
a `pure` function may not `perform` (§4).
- **Foreground binding.** A wired action with a `result_event` supports result binding,
reusing the §6c delegation discipline — the world is just another worker:

  ```agape
  text hits = perform Search("prior art") expires 5;
  ```

  `expires` is **mandatory** on the binding form (terminal by construction, §6c); failure or
  expiry faults the awaiting invocation via the contained-crash path (§5, §16.6). The binding
  is **typed from the manifest-named result event's payload** (the checker receives the
  manifest, §17.1): a single-field event binds that field's value directly; a multi-field
  event binds a struct of its fields; with no manifest in scope the binding types
  conservatively (`unknown`) and the runtime enforces. Statement-form `perform Search(q);`
  stays legal, wired or not (reactive consumption via `when (SearchResult r …)`). A
  foreground binding on an action with no configured `result_event` is a `ConfigError`
  (§17.1) — there is nothing to bind.
- **Ledger.** The domain story is named, typed rows: the action's own row (`Search(…)`,
`Deploy(…)`) and the result/sensor event rows (`SearchResult(…)`) — every wiring is tied to
a specific event or action, structurally, because there is nothing else for a wiring to
attach to. `ToolStarted(name)` / `ToolResolved(name)` remain, demoted to the seam's **replay
journal** (§16.5; incidental trace, §15.5.1): appended for every wired invocation
(emit- or perform-triggered), correlated by catalog name, beneath the domain rows. Order for
a wired `perform`: **action row → ToolStarted → ToolResolved → result event row** (when
configured). For a wired `emit`: **event row → ToolStarted → ToolResolved → result event
row**. Every world-effect is on the log, so the ledger is a complete, replayable account of
what the program did to the world, not only what it thought.
- **Replay.** A wired invocation's result is an external observation and is journaled
(§15.4.2) like an oracle output, including its ingress provenance and any screening
verdict; replay re-serves it from the recording and never re-invokes the effector or
screen (§16.5).

The world interface is not a new trust hole; it is the same membrane discipline (capability +
trust + ledger + replay) applied to the world. This is what lets the host's deterministic
work be a general-purpose language reached through a governed boundary rather than
reimplemented inside Agape (§0.1).

---

## 6c. Delegation — the task-send

Delegation is **not a new communication primitive**: it is a send whose message is a governed
task payload and whose reply is produced by the recipient's *code* instead of one provider
invocation. Everything else — lifecycle, expiry, correlation, loss — is the ordinary send
discipline of §6.

```agape
struct ResearchResult { summary: text, refs: text }

agent Researcher {
  on assigned {                                        // a task arrived (sugar, §5)
    ResearchResult r = self <- "complete the assigned task";
    complete r;                                        // programmatic resolution
  }
  on cancelled { say("stopping"); }                    // cooperative cancellation
}

agent Lead grants { reach Researcher } {
  on awake {
    spawn Researcher worker; awake worker;
    int ttl = 50;

    // foreground — result-bound; this handler waits on r
    ResearchResult r = worker <- task {
      objective "Find relevant sources on conformal prediction";
      acceptance "Concise findings; every claim carries an evidence ref";
    } expires ttl;

    // background — handle-bound; outcomes observed reactively
    Task<ResearchResult> h = worker <- task {
      objective "Survey related work";
      acceptance "A one-paragraph map of the field";
    } expires 200;
    when (TaskCompleted done about h) { emit Event("survey landed"); }
    when (TaskFailed oops about h)    { emit Event(f"survey failed: {oops.reason}"); }
  }
}
spawn Lead lead; awake lead;
```

### The task literal

`task { … }` is an expression building a **`TaskSpec`** (a prelude struct). It may be sent
inline (`dest <- task { … } expires N`) or bound to a `TaskSpec` variable first — the draft
form the endorsed flow gates before sending. Its clauses, recognized only inside the literal
(§2):

- `**objective EXPR;**` and `**acceptance EXPR;**` — both **required**, both `text` (literal or
variable); an empty task block, a missing clause, or a non-`text` clause is a compile error.
- `**scope { perform NAME, … }**` — optional; the perform authority this task *enables* on the
worker (below). Each listed action must be held (`perform NAME`) by the **delegator** — a task
can only attenuate its delegator's authority, never mint new authority.
- `**expires N**` — **mandatory** on every delegation (postfix, exactly as §6; `N` is a settled
numeric expression). Every task is therefore terminal by construction: exactly one of
*completed / failed / expired / cancelled* is guaranteed to land on the ledger. Expiry is also
what converts a lost task-send (never `Delivered` — silence, §6) into a signal: the `Expired`
tombstone is appended by the delegator's runtime. A delegation without `expires` is a compile
error.

**Trust.** A `TaskSpec`'s trust is the join of its fields (ordinary contagion, §13): a generated
objective stays `graded`/`raw` — **delegation does not launder trust**. A task that carries a
`scope` clause is only *enabling* if it is **endorsed**: the message must be an
`Endorsement<TaskSpec>`, constructible only inside a committed branch (§13). An unendorsed
scoped task is a compile error at the send.

### Binding — foreground and background

Foreground vs background is **dataflow, not a keyword**:

- `**T r = dest <- task { … } expires N;**` — foreground. The handler's continuation waits on
`r`. The result of a delegated task is `**raw**` by default — like any send reply, it is the
worker's cognition until the delegator gates it; a worker that completes with an
`Endorsement<T>` hands over a settled, ledger-backed subject instead.
- `**Task<T> h = dest <- task { … } expires N;**` — background. `h` is a settled handle used for
correlation: `when (TaskCompleted x about h)`, `when (TaskFailed x about h)`, and `cancel h;`.
- **Bare statement-form delegation is a compile error** — hold the result or the handle; every
task is addressable.

### The worker side

While an assigned task is active, the worker's provider context composes in a fixed,
documented order: global `instruction` → agent `instruction` → **the active task's objective
and acceptance, as data**. A tainted objective is data in context, never an instruction — it
cannot override instruction guardrails (§5: instructions are settled by source). The worker
ends its task with one of two verbs, each legal **only inside a task handler**:

- `**complete EXPR;**` — resolves the task-send: appends the transport `Resolved` plus a
`TaskCompleted` record carrying the result (an event payload, like an `emit` — §7).
- `**fail EXPR;**` — terminal failure: appends `TaskFailed(reason)` (`reason` is `text`); the
transport chain simply stops at its `Delivered` prefix (a stalled prefix is not a violation, §6).

`TaskProgress(text note)` may be emitted by the worker inside a task handler
(`emit TaskProgress("halfway");`) — the one repeatable task event, correlated to the active task.

### Cancellation — cooperative, tombstone-first

`**cancel h;**` (delegator-side) appends `TaskCancelled` immediately — the **authoritative
tombstone**. The worker's in-flight handler is **not preempted** (handler invocations stay
atomic); its `on cancelled` hook fires, and a late `complete`/`fail` for a cancelled (or
expired) task is **refused and recorded** as `CompletionRefused` — exactly the
`DeliveryRefused` discipline of §6. The same refusal applies after expiry.

### Failure reaches the delegator on two paths

- **Foreground** (result-bound): `TaskFailed` / `TaskExpired` / `TaskCancelled` **fault the
delegator's awaiting invocation** through the contained-crash path (§5) — the invocation is
abandoned, `AgentCrashed` is appended, `on crash` runs with state intact. The reason is not
lost: it is the `TaskFailed(reason)` row, one ledger query away by correlation. (Precedent: a
task that comes back empty is the same shape as "the provider returns nothing," which already
faults.)
- **Background** (handle-bound): outcomes are ordinary `when` subscriptions. The backstop is
the ledger itself — terminal task events are durable rows, findable later by query even if the
delegator was asleep when they landed.

### Ledger shape — aliases + four real events

No `TaskUpdated`-style status event exists: `when` is keyed by event **type**, payloads are
fixed-typed, and the §6 prefix-safety property is structural. Instead:

- **Subscription aliases** (zero new rows): `TaskSubmitted ≡ Sent`, `TaskAssigned ≡ Delivered`,
`TaskExpired ≡ Expired`, each filtered to task-sends. `when (TaskAssigned about h)` compiles to
the filtered transport subscription.
- **Real events** (new payloads, correlated to the task): `TaskCompleted(result)`,
`TaskFailed(text reason)`, `TaskCancelled`, `TaskProgress(text note)` — plus the refusal record
`CompletionRefused`.
- The unified "one status per task" view is a **ledger projection** (a `select … from ledger`
query folding the chain per correlation; §16), not an event.

### Authority — static grant ∧ endorsed-task enablement

A worker's `perform` executed **while running an assigned task** requires *both*: the static
`perform NAME` grant (§13 — the upper bound, never widened at runtime) *and* an active task
that is endorsed and names `NAME` in its `scope`. A perform outside any task needs only the
static grant. The task check is a **runtime enablement at the sink**, exactly like the margin
floor (§13); failing it faults the action (`TaskScopeViolation`, §16.6). Delegation therefore
**attenuates** authority (delegator ∩ worker ∩ task scope) and never widens it — §14's
invariants and the T1 soundness statement are unchanged.

Re-delegation is governed by the worker's own `reach` grants (default-deny already covers it).
Fan-out delegation composes with `|>` (§12): map an async delegating function over a finite
collection of workers, then fuse the results with `quorum` under a declared dependence
structure. There is no unbounded supervisor loop (§0.2, §11); the idiomatic retry shape is a
bounded, reactive re-dispatch — a `when (TaskFailed about …)` subscription that submits a
revised task.

---

## 7. The ledger, events, and `when`

### Events

Every meaningful action appends an immutable `Event`: `{ tick, etype, subject, payload, corr, agent }`. `tick` is system-assigned and monotonic; `subject` is the source the event
is about (the `when (… about subject)` filter key); `corr` is the correlation key that links a `Started` to its `Resolved`.

### Ledger heads, projections, and stale state

The ledger head is the content address of a ledger prefix, not a mutable state cell. Runtime
state is the deterministic projection of that prefix:

```
state_at(head) = fold(events[genesis..head])
```

Any materialized fact or view records the prefix it was derived from and the scope of future
events that can affect it:

```
Fact<T> = { value, provenance, basisHead, validThrough, dependencyScope, status }
```

`basisHead` says when the value was derived; `dependencyScope` says which event keys / state keys
can make the derivation stale in the future. The two are not interchangeable: without a dependency
scope the only sound rule would be "any new event stales everything." Conformant runtimes may
materialize projections for speed, but the semantics remains the fold above.

On append, a runtime computes the new event's write-set and intersects it with the indexed
dependency scopes of materialized facts/views. Only intersecting facts are recomputed or marked
stale; unrelated events do not invalidate the world. If a projection cannot determine its
dependency scope, its scope is conservative/global, so every event may stale it. This is the
runtime obligation behind "ledger as source of truth": efficient caches are allowed, hidden
uncertainty about what they depend on is not.

### Subjects: every event has a source

A send `d <- p` produces events with subject `d`; a typed binding `T x = …;` gives
the send lifecycle subject `x`. A `decide c by r` produces a `Decided` event subjected at the
credence/provenance scope or the binding name receiving the `Decision`. A principal-prefixed
`p decide c by r` that escalates first produces a `PrincipalDecision` or
`FailedPrincipalDecision` at that same scope, then the canonical `Decided` event. An
`endorse subject by d` is legal only when `d.committed` has been flow-narrowed to a real variant and
produces an `Endorsed` event whose subject is the exact endorsed value. A wired invocation's
journal pair is subjected at the catalog name (§6b). A literal operand has an ephemeral address; its event still lands on
the ledger.

### Async event discipline

A send (`<-`) appends the three-phase `Sent`/`Delivered`/`Resolved` chain (§6). A wired
`perform`/`emit` appends a `ToolStarted`/`ToolResolved` pair correlated by `corr` (§6b). A principal-prefixed `p decide c by r` is
async (it may reach the identity dependency) and always appends the canonical `Decided` event, plus
a terminal `PrincipalDecision` or `FailedPrincipalDecision` when the rule escalates. Synchronous ops
such as `==` and arithmetic append no event; rule-only `decide` and committed `endorse` each append
a single event.

### `when` — the subscription

`when (Type binding [about subject]) [if (guard)] { ... }` is a ledger subscription. It matches
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
for an event already on the ledger before its scope began. History is reached by query
(§10), never by a subscription. A program that must react to a prior event queries the
ledger and acts on the result.

**Multi-handler firing order.** When several subscriptions match one appended event in one
tick, they fire in registration (hoist) order — the order in which they were registered
when their scopes were entered; within a single scope, lexical order. This total order is
part of the semantics so that replay is well-defined.

```agape
event Logged(text note);
Credence<Entailment> rel = self <- f"does {claim} entail {evidence}?";
Decision<Entailment> d = decide rel by confidence 0.9;
if      (d.committed == Entails)     { emit Logged("supported"); }
else if (d.committed == Contradicts) { emit Logged("refuted"); }
else if (d.committed == Neutral)     { emit Logged("unrelated"); }

when (Contradiction k about rel) { ... }   // fires when the gate commits `rel` to Contradicts (§8)
when (Error e) { ... }                     // every error, any source (Contradiction is an Error subtype)
```

---

## 8. Semantic checking

### The provider

Cognition enters only through the provider (`think`). Agape source never
names a concrete provider; semantic judgments and structured replies resolve through it;
swapping it changes no source.

For a typed reply, the provider call is a structured-output call. The runtime renders the
prompt and compiles the destination type into a schema:

```agape
enum Triage { Auto, Human }
struct Summary { title: text, urgent: bool }

Credence<Triage> t = self <- f"triage: {body}";
Summary s = self <- f"summarize: {body}";
```

The first call constrains the backend to the closed enum `Triage` and records a distribution over
its variants. The second constrains the backend to the exact `Summary` object shape. The words
"triage" and "summarize" help the model, but only the schema is authoritative.

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
(§13). To use a judgment as a committed value, gate it: `decide c by R`.

- On an array operand a judgment decomposes over elements but returns one `Credence<E>`
for the whole: the parts inform the distribution; the evidence records where a partial
mismatch was. The result type stays uniform.
- **Mechanism vs policy:** when a gate commits a `Credence<Entailment>` to `Contradicts`,
the runtime also emits a first-class `Contradiction` event, independent of any branch,
so a global `when (Contradiction about subject)` can react.

### Materializing a distribution (cost)

A single dependency call already yields the full per-variant distribution. A spread over
repeated judgments — sampling the same question N times — is a separate, heavyweight
operation not in the surface language. A use of `sample` is an unknown-identifier error.
(The stochastic-consistency harness, §15.5.3, samples re-runs externally.)

### Structured output (the provider contract)

- A declared destination type `T` compiles to a JSON Schema; the provider returns schema-conforming
output via constrained decoding (mandatory; no fuzzy fallback).
- Type → schema: `bool→boolean`, `text→string`, `int→integer`, `float→number`,
enum→`{type:string,enum:[...]}`, struct→`{type:object,…,additionalProperties:false}`,
array→`{type:array,items}`. A `Credence<E>` reply records the per-variant score vector
of the constrained decode or sampling fallback (§3, §16.8).
- A provider should expose logprobs or equivalent per-variant score data for efficient
gated/`Credence` decisions; when it does not, a configured sampling fallback estimates the score
distribution (§17).
- On schema failure the runtime raises a clean `TypeMismatch` (catchable, retryable).

---

## 9. The prelude

```
enum Entailment { Entails, Contradicts, Neutral }          // committed from a Credence<Entailment>
type Credence<E>                                           // a graded judgment over enum E (§3)
type Decision<E>                                           // a gate's ledgered outcome over E (§13); fields: .decision_id (int), .committed (E|abstained), .basis (Basis), .margin (float)
type Endorsement<T>                                        // the SETTLED subject of type T: .subject:T (coerces to T at a sink), exposes T's fields, + .decision_id/.committed/.basis/.margin (§13)
enum Basis { Threshold, Conformal, Calibrated, Principal } // how a Decision was settled (Decision.basis, §13)
type Principal                                             // an accountable identity — a declared dependency (§3)
type TaskSpec                                              // a delegated-task payload built by `task { … }` (§6c); fields: .objective (text), .acceptance (text); trust = join of its fields
type Task<T>                                               // a settled background-task handle (§6c): correlates `when (… about h)` and `cancel h`
// Rule is the gate's PARAMETER, not a type: `confidence θ [margin δ] [floor m]` | `conformal [α] [readiness N] [floor m]`  (§3, §13)
// abstained — the prelude sentinel value of Decision.committed when the gate did not commit (§3, §13)

// Built-in ledger events:
//   Event(text)            user progress/info event (via `emit`)
//   Error(text)            ROOT error type (hierarchy below)
//   Decided(subj)          a Credence was collapsed by a Rule into a Decision, committed or abstained
//   Endorsed(subj)         a committed Decision was applied to an exact subject value
//   Contradiction(subj)    emitted when a Credence<Entailment> commits to Contradicts
//   PrincipalDecision(subj)    a principal-prefixed `p decide c by r` that escalated and got a ruling
//   FailedPrincipalDecision(subj)  the principal declined or was unavailable (decision stays abstained)
//   MarginFloorViolation(subj)  a committed decision's margin was below the rule floor at a sink (§13)
//   QueryResult(subj)      the event a query STATEMENT lands
//   MemoryConsulted(subj)  the memory-envelope consult trace (counts/query meta, §16.7)
//   Internalized(subj)     a memory write (incidental trace, §15.5.1)
//   ArtifactObserved(subj) a knowledge-artifact ingest opening (kind/uri/hash, §16.7b)
//   Forgotten(subj)        a `forget` memory tombstone (§10)
//   ToolStarted/ToolResolved   the wired-invocation replay-journal pair (§6b)
//   Spawned / AgentAwake / AgentAsleep / AgentCrashed   lifecycle (§5)
//   Sent / Delivered / Resolved                message lifecycle (§6); a send's provider reply is its Resolved
//   Expired(corr) / DeliveryRefused(corr)      message expiry / refused-late-delivery (§6)
//   PromptOpened(name) / Prompt(name)          external input sensor (§5b)
//   TaskCompleted(subj) / TaskFailed(subj)     task terminals: `complete r` / `fail reason` (§6c)
//   TaskCancelled(corr) / TaskProgress(subj)   delegator cancel tombstone / repeatable worker progress (§6c)
//   CompletionRefused(corr)                    a late complete/fail after cancel/expiry, refused (§6c)
//   TaskScopeViolation(subj)                   a perform outside the endorsed task's scope at the sink (§6c, §13)
//   TaskSubmitted / TaskAssigned / TaskExpired subscription ALIASES for Sent/Delivered/Expired filtered to task-sends (§6c) — no rows of their own
```

**Event-type hierarchy.** `Error` is the root; `Contradiction`, `TypeMismatch`,
`FailedPrincipalDecision`, `MarginFloorViolation`, `TaskScopeViolation`, and `AgentCrashed` extend
it. `when` matches by
subtype, so `when (Error e)` catches a `Contradiction`; a contradiction is an `Error`
subtype, and code that wants only faults matches the specific types. `Expired` and a lost
send are not errors, and neither is `TaskFailed` — a recorded task outcome, not a program
fault (the delegator-side fault, when foreground, is the `AgentCrashed` it induces, §6c). A user `event` may extend this root — `event Foo(..) : Error;`
adds a *leaf* under `Error` so `when (Error e)` catches it too; the only permitted supertype is
the built-in `Error` (no user intermediate supertypes), and `action` may not extend it (only
`event` may).

```agape
event AuditGap(text what) : Error;   // a user leaf under the built-in Error root

when (Error e) { say("caught an error subtype"); }   // catches AuditGap by subtype

agent Auditor {
  on awake { emit AuditGap("missing receipt"); }
}
spawn Auditor a; awake a;
```

`**say(x)`** prints its argument; it is not a ledger operation. Private-memory internalization is
spelled with the memory write seam, `mem <- value` (§10), not a prelude `store()` call.

---

## 10. Memory

Each agent instance has its own **private memory** — subjective, agentic belief, distinct from the
global ledger. It is per-instance: two instances of the same agent template have separate memory and
share no subjective state (§16.7).

### The substrate — one region, three views

A memory region maintains up to three live materialized views of what it holds: a **fact table**
(exact, selective facts), a **relationship graph** (SPO triples over a typed predicate set), and a
**vector store** (chunks/embeddings for similarity). These are not three stores the program chooses
between; they are three views of one region. Internalization decomposes each stored value across
them and mutates the live views incrementally. A runtime may compact or fully re-index a region in
the background, but a program-level `mem <- value` is not required to rebuild every view from
scratch.

The ledger records the recipe/provenance of each mutation, while private memory keeps the current
usable state. Archival blob storage is runtime-configured and durable: `refs` in an `Internalized`
or `Forgotten` payload point to recoverable blob bytes by hash, even if a runtime later moves old
bytes to cold storage.

### The `mem` handle — store, recall, forget

A `mem` is a handle into an agent's private memory. Its surface is two seams plus a tombstone:

```agape
mem notes <- "nothing published yet";            // declare + store
notes <- "the earth is an oblate spheroid";      // STORE more into the region (`<-`)
text t = notes -> "what shape is earth?";        // RECALL (`->`) — ALWAYS tainted
forget notes;                                    // audit-preserving tombstone
```

- `**mem NAME [<- EXPR];**` declares a private-memory handle, optionally initializing it; the handle
  has type `mem`.
- `**NAME <- EXPR**` (an established `mem` on the left) **stores**: it internalizes the value across
  the region's live views. The same `<-` arrow as a send, disambiguated by the left-hand type — an
  *agent* on the left thinks (provider), a *mem* on the left stores. If the expression is bound, it
  returns a `LedgerEntry<Internalized>` receipt.
- `**NAME -> "query"**` **recalls**: a cognition-mediated retrieval that draws across the three views
  and fuses them. `->` requires a `mem` on the left; `->` on any non-`mem` left-hand side (e.g.
  `self -> "x"`) is a **`TypeError`**.
- `**forget NAME;**` removes the region's active private-memory data by the runtime's cascade policy
  and appends a `Forgotten` event. The live fact/graph/vector views stop returning the forgotten data;
  the historical ledger record remains. If a runtime tombstones rather than deletes a modality, the
  `Forgotten` payload must say `tombstoned`, not `deleted`. `redact` is a separate operation, not the
  default `forget`.

An `Internalized` payload records what changed using exact modality terms:

```json
{
  "value": { "kind": "text", "rendered": "info", "value": "info" },
  "effects": {
    "facts": { "upserted": 1, "tombstoned": 0, "deleted": 0 },
    "graph": {
      "nodes_upserted": 1,
      "edges_upserted": 0,
      "nodes_tombstoned": 0,
      "edges_tombstoned": 0,
      "nodes_deleted": 0,
      "edges_deleted": 0
    },
    "vectors": { "chunks_upserted": 1, "chunks_deleted": 0, "embeddings_deleted": 0 },
    "blobs": { "archived": 1, "redacted": 0, "deleted": 0 }
  },
  "refs": {
    "input": "blob:sha256:...",
    "facts_delta": "blob:sha256:...",
    "graph_delta": "blob:sha256:...",
    "vector_delta": "blob:sha256:..."
  },
  "policy": {
    "indexing": "incremental",
    "background_reindex": "runtime-managed",
    "graph_forget": "cascade",
    "archive": "runtime-configured"
  }
}
```

### A recall is ALWAYS tainted

A recall is taint-equivalent to a send reply (`->` on the trust axis behaves exactly like `<-`): the
result is `graded` when bound to a `Credence<E>` slot, else `raw` `text`. Memory is **agentic** — it
stores anything, and nothing leaves it `settled`, so there is no laundering path: a recalled value
must be **re-decided and endorsed** before it reaches a consequential sink. This reuses the §13
send-taint rule wholesale; there is no store-side trust enforcement. Because memory quality bears only
on usefulness and never on safety (a recall is re-gated regardless), the runtime is free to tune the
substrate — backends, chunking, fidelity, budget (§16.7) — without affecting any guarantee.

### The ledger is not memory

The ledger is the **objective** record: append-only, deterministic, and shared. It is queried with the
structured **ledger query** — `select Event as e from ledger where { e.field ... }` or
`select COLS from ledger where { COND }` — and carries **recorded
trust**: an `Endorsed` subject reads back `settled`, because the ledger *is* the proof it was endorsed.
It keeps none of `<-` / `->` / `forget`. The split is exactly *objective shared record* (ledger,
recorded-trust, structured query) vs *subjective private belief* (memory, always-tainted store/recall).
There is no `ledger -> "prompt"`: an agentic reading of the log is composed — a deterministic ledger
query feeds a `<-` send, and the seam taints the *result*.

### The ledger query

`select Event as e from ledger where { COND }` → `LedgerEntry<Event>[]` — typed rows for a
named event, with payload fields available through `e` and metadata under `e._meta`;
`select COLS from ledger where { COND }` → `Record[]` — rows of the projected columns.
`select * from ledger where { … }` yields the full events; `origin(x)` projects a value's producing
event. `COND` is a boolean filter over fields: `field op value` (`op in {==, !=, <, >, <=, >=}`)
combined by `&&` / `||`. No joins or aggregates — heavy analysis is host work (§6b). The query is an
**expression** yielding its `[]` result set, bound by an ordinary declaration
(`Record[] prior = select * from ledger where { … };`) and consumed by fan-out (§12). A bare
**statement** form binds nothing and lands a `QueryResult(ledger)` event. A query reads the log; it
never re-emits. Replay folds the ledger and appends nothing.

### Provenance

Every memory cell carries an immutable backpointer to the ledger event that produced it (§7, §16.7).
A recalled value stays subjective and tainted (above) regardless of its origin's trust; the objective,
recorded-trust reading of that same origin is the ledger query.

---

## 11. Control flow

`if`/`else` is the deterministic branch: the condition is a settled `bool` — a comparison
(`==`/`!=`/`<`/`>`/`<=`/`>=`) or a boolean field — and `!` is boolean negation.
It branches on *facts*, never on cognition: a `Credence<bool>` is not a `bool`, so a bare `Credence`
in an `if` is a `TypeError`. To branch on a judgment, collapse it first (`Decision<bool> d = decide c
by r`) and test the committed variant (`if (d.committed == true)`).

A committed variant is a settled value, so `==` over `.committed` is exactly-gated (§15.5.5) and is
the kernel form of verdict branching. Branching on a gate's outcome is an ordinary `if`-chain over
`.committed`, with the `abstained` sentinel as the case no committed variant matched. `if`, the
reactive `when` (§7), bounded fan-out over a finite collection (§12), and function call are the whole
of Agape's control vocabulary; there is no unbounded loop (§0.2).

```agape
enum Grade { Pass, Fail }
agent Marker {
  on awake {
    Credence<Grade> g = self <- "grade this submission";
    Decision<Grade> d = decide g by confidence 0.85 margin 0.1;
    if      (d.committed == Pass) { emit Event("pass"); }
    else if (d.committed == Fail) { emit Event("fail"); }
    else                          { emit Event("abstained — needs a human"); }  // == abstained
  }
}
spawn Marker m; awake m;
```

---

## 12. Aggregation, graded combination, and quorum

Fusing graded judgments has no assumption-free default. By the Fréchet inequalities, for a
conjunction `p₁…pₙ` the joint is pinned only to an interval, `max(0, Σpᵢ − (n−1)) ≤ p(∧) ≤ min(pᵢ)`,
whose value depends entirely on correlation: at independence it is the product `∏ pᵢ`; at maximal
positive dependence, `min(pᵢ)`. Independence is itself a specific assumption, not the absence of one.
The dependence structure of any fused set must be declared:

```agape
independent j1, j2, j3;                          // assert these judgments' errors are uncorrelated
dependent   j4, j5;                              // assert these are correlated (e.g. share a source)
Credence<bool> agreed = quorum(2, [j1, j2, j3]); // graded "at least 2 of 3 commit"
Decision<bool> d = decide agreed by confidence 0.9;  // gate the fused quorum once
```

- `xs |> f` maps async function `f` over every element of finite collection `xs`, issuing the
  independent paths before joining their returned values in source collection order. Work scales with
  the number of elements times the work per element; span is the longest single element path plus the
  join, not a serial chain over the collection. A path remains sequential internally: an
  observation then a judgment inside one mapped function is ordered, while other mapped elements may overlap.
- `**independent v…**` — fusion is log-odds addition (Good's weight of evidence; naive-Bayes
combination): confidence accumulates — several independent confirmations fuse higher than any one.
- `**dependent v…**` — fusion takes the conservative Fréchet bound (`min` for conjunction, `max` for
disjunction): confidence does not accumulate, capped at the weakest link.
- `**quorum(k, [c1, …, cn])**` fuses `n` `Credence<bool>` judgments into a single `Credence<bool>` for
the proposition "at least `k` of the `n` commit," combined under the declared dependence structure.
It is a thresholded reduction over the fusion algebra.
- **No default.** Aggregating two or more `Credence` values with no dependence declaration covering
every pair is a compile error (`TypeError`). Coverage must be total.
- **Mixed sets** compose by the declarations: each `dependent` cluster is fused conservatively first,
then cluster results combine by the independent rule.

Fusion is the only operation Agape offers over graded values: forward evidence fusion before the
single gate — not general inference (no `observe` / conditioning / `bind`). Fusion lives entirely in
the credence tier (`P → P`); only the gate crosses `P → U`. Independence is an asserted, unverified
claim, recorded on the ledger so an over-confident outcome traces back to the assertion that licensed
it. Calibration is the provider's job (§3), not fusion's.

**Quorum and stability.** A single non-deterministic judgment can flip run-to-run (its margin bounds
the flip probability, §15.5.5). Multiple independent judgments that agree flip less often (Condorcet's
jury theorem: independent judges better than chance, combined by majority, have error that collapses
as their number grows). Fusing independent judgments tightens the Stability bound (§15.5.5): the fused
margin exceeds any single judge's, so `β(δ_fused) ≤ β(δᵢ)`. The amplification holds only to the extent
the judges' errors are uncorrelated — `n` calls to the same model with the same prompt have correlated
errors and gain little, which is why `quorum` requires an explicit `independent`/`dependent`
declaration, and why robustness comes from diverse judges (different models, framings, evidence).
`quorum` is single-runtime evidence fusion, not a consensus protocol (Paxos/BFT); those tolerate
faults across mutually-distrusting nodes, a concern that arises only at the optional distributed-ledger
boundary (§15.4.2a).

---

## 13. Capabilities and governance

Five properties are bounded by the compiler, not hoped for at runtime: authority, trust,
color, outbound wiring, and the gate that connects them. The formal rules are §15.3.

### Authority (`grants`)

An agent's `grants` clause is its total authority — in Hohfeld's terms, its **powers**: the
actions it may `perform` and agents it may `reach`. Acting outside it
is a compile error. Capabilities are subtractive under `extend`. An `**action`** declaration
(`action Transfer(…);`) is a consequential, performative event type (vs a plain `event`, a
record) — performing one engages the trust rule below.

```agape
grants { perform Transfer, reach Worker }             // concrete capabilities
grants { * }                                          // the explicit unconstrained opt-out
```

A grant entry is `perform NAME` (may perform action type `NAME` — including invoking its wired
effector, §6b) or `reach NAME` (may send into agents of type `NAME`). Grants are exactly
`perform` + `reach`; emitting needs no power (§6b).

**Default is deny.** No `grants` clause ⇒ perform/reach nothing (fails closed). The only
escape hatch is the explicit `grants { * }` (unconstrained, lattice top, visible in source
and ledger). `reach` covers every agent-typed binding (parameter, `spawn` result, any
variable of agent type), not only parameters.

### Taint — the three-level lattice

A value's trust records its cognition-provenance: `settled ⊑ graded ⊑ raw` (§15.3.1).

- a bare send reply, before it is bound to a `Credence`, → `raw`.
- a send bound to a `Credence<E>` slot → `graded` (a graded judgment), for any destination; a
recalled memory value is always tainted (`graded`/`raw`, §10).
- `decide c by r` → a sealed `Decision<E>` carrying `.decision_id`, `.committed` (a variant of `E`,
or `abstained`), `.basis`, and `.margin`, with a `Decided(...)` ledger record. A `Decision` guides
branching but is not itself an endorsed subject.
- `endorse subject by d` → an `Endorsement<T>`: the **settled** form of the subject value, carrying
the subject's own fields plus the decision's `.decision_id`/`.committed`/`.basis`/`.margin`, with an
`Endorsed(subject, decision_id, variant)` ledger record. It is constructible only inside a branch
that has narrowed `d.committed` to a committed variant (below); an abstained `Decision` has no
endorsement to give.
- a constant → `settled` and `internal`.
- a `prompt`, standing-sensor payload, and wired result-event payload (§5b, §6b) →
judgment-settled external data: it carries no un-endorsed model cognition, while separately
carrying ingress provenance (`external_unscreened` unless a manifest-configured screen records
an accepting verdict and marks it `external_screened`). Result-event judgment trust joins the
request payload's trust: a settled `perform` request yields judgment-settled results; a tainted
emit-wired request taints its own results.

Trust is contagious upward (a value is as `raw` as its least-settled input). Only `decide` creates
a `Decision`; only `endorse` produces a settled `Endorsement` of a subject value. A `Principal` is `settled`.

### Ingress provenance — separate from judgment trust

Ingress provenance is an independent lattice (§1): `internal ⊑ external_screened ⊑
external_unscreened`. It answers "did these bytes enter from outside, and have they passed
the configured ingress screen?" rather than "does this value contain un-endorsed model
cognition?"

Prompt arrivals, standing-sensor events, and world result-events enter as
`external_unscreened` by default. The manifest may bind those ingress points to a screen; if
the screen accepts, the delivered value is `external_screened`, and if it rejects the arrival
is not delivered as ordinary data. Screening is configuration-only and replayed from the
ledger; Agape source has no `screen` expression, cast, or annotation.

The only policy knob attached to unscreened ingress is the provider-prompt policy (§17):
when `external_unscreened` data flows into a cognition prompt, the manifest default is to
warn, strict mode denies, and `off` suppresses the diagnostic. This policy does not govern
`perform`. Consequential actions have no configurable ingress allow/warn/deny relaxation or
denial layer; the sink rule below remains the fixed settled-only judgment-trust check plus
the existing runtime margin and task-scope checks.

```agape
enum Approval { Approve, Decline }
event Reviewed(text note);
action ReleaseFunds(int cents);

agent Clerk grants { perform ReleaseFunds } {
  on awake {
    text request = "release $100";
    Credence<Approval> a = self <- f"assess this request: {request}";
    Decision<Approval> d = decide a by confidence 0.95 margin 0.2;

    if (d.committed == Approve) {
      Endorsement<text> e = endorse request by d;
      perform ReleaseFunds(10000);
    } else if (d.committed == Decline) {
      Endorsement<text> e = endorse request by d;
      emit Reviewed("declined");
    } else {                              // d.committed == abstained
      emit Reviewed("needs-review");
    }
  }
}
```

### The gate — `decide` and `endorse`

The gate is two value-producing operations; branching on them is an ordinary `if` over `.committed`.

1. `decide c by r` collapses a `Credence<E>` into a sealed, ledgered `Decision<E>`. The rule `r` is
   always present (§3). The gate's uniform surface is **commit-or-abstain**: it records the chosen
   variant in `.committed`, or `.committed` is `abstained`, and appends a `Decided` event whose
   tick is the `Decision`'s `.decision_id`. *How* it commits depends on the basis — under
   `confidence θ [margin δ]` it commits the top variant when its score ≥ `θ` and its lead ≥ `δ`
   (§3); under `conformal α` it forms a **prediction set** `{ v : nonconformity(v) ≤ q̂ }` and commits
   iff that set is a singleton (§15.5.6). The prediction set is the principled object over three-plus
   variants, where a bare scalar threshold has no meaning.
2. `endorse subject by d` applies a committed decision `d` to an exact `subject` and yields an
   `Endorsement<T>` — the settled form of the subject, carrying its fields plus `.decision_id`,
   `.committed`, `.basis`, `.margin`, with an `Endorsed(subject, decision_id, variant)` ledger
   record. If `d.committed == abstained`, no endorsement exists.

`decide` then `endorse` is the canonical pipeline; the resulting `Endorsement` is the settled value
a sink consumes:

```agape
enum Verdict { Faithful, Unsupported }
action Publish(text body);   event NeedsRevision(text body);   action Escalate(text id);

Credence<Verdict> c = self <- f"is this faithful: {response}";
Decision<Verdict>  d = decide c by confidence 0.9 margin 0.1;

if (d.committed == Faithful) {
  Endorsement<text> e = endorse response by d;
  perform Publish(e);              // e is the settled subject, admissible in this committed branch
} else if (d.committed == Unsupported) {
  Endorsement<text> e = endorse response by d;
  emit NeedsRevision(response);    // emit is not a sink; `perform X(response)` here would be rejected (raw)
} else {                           // d.committed == abstained
  perform Escalate("needs-review");// a literal is settled internal data
}
```

A `decide` may be written **without endorsing** — bound to a `Decision` value — to defer subject
endorsement or to record an abstention. Branching itself is never skipped. A `Decision` (no subject)
may guide branching and `emit`, but **cannot drive a consequential sink**; only an `endorse`'s
settled subject, constructed inside a committed branch, reaches a sink.

### Decision and Endorsement — the settled values and their fields

A `Decision<E>` is introspectable for how it was settled: read-only `**.decision_id`** (the tick of
the `Decided` event), `**.committed`** (the variant, or `abstained`), `**.basis`** (`Basis =
Threshold | Conformal | Calibrated | Principal`), and `**.margin`** (the gap `g`, §15.5.6), plus
provenance for the source `Credence`, profile, or principal. An `Endorsement<T>` **is** the settled
subject: it carries the underlying value of type `T` (reachable explicitly as **`e.subject : T`**,
and the whole `Endorsement<T>` coerces to `T` at a consequential sink), exposes `T`'s own fields
directly (`e.some_field`), and adds the read-only gate metadata `.decision_id` / `.committed` /
`.basis` / `.margin`. The `.decision_id` is the endorsement's single ledger join key: the
recorded subject, tick, and chain position live on its `Endorsed` row (and the `Decided` row it
references), reached by the ledger query — `select Endorsed as r from ledger where { … }`, then
`r._meta.tick` (§10); a gate value carries no `_meta` of its own. Where a field of `T`
collides with a reserved metadata accessor, the metadata name wins and the shadowed field is reached
through `e.subject` (e.g. `e.subject.committed`). This is Agape's reflection surface over gate
metadata, not general structural `typeof`.

- `**decide c by R**` collapses a `Credence<E>` to a `Decision<E>` by a `Rule` `R` (§3), appending
`Decided { decision_id, credence, rule, committed, basis, margin }`. It is color-`S` when the
`Credence` is already in hand.
- `**p decide c by R**`, with a `principal` `p` as the prefix, attaches human escalation. The rule
runs first; when it cannot commit, the identity dependency is reached — `p` is consulted (over MCP
or another identity backend), the human's reply arrives as one of `E`'s variants, and the runtime
records `PrincipalDecision { who, credence, decision, signature }`. A declined or unavailable
principal records `FailedPrincipalDecision` and the decision stays `abstained`. Either way the final
`Decision` is recorded as `Decided`, with `principal_event` pointing at the identity event when one
exists. A principal-prefixed `decide` is color-`A` (it may reach identity); a rule-only `decide` is
color-`S`.
- `**endorse subject by d**` requires `d` to be flow-narrowed by an explicit committed-variant test
such as `if (d.committed == V)`; it records `Endorsed { subject_hash, decision_id, variant }` and
returns `Endorsement<T>`. In the `else`/abstained branch (`d.committed == abstained`) no
endorsement may be constructed, so the subject cannot reach a sink unless it is independently
judgment-settled (for example, a literal or external ingress value with no un-endorsed model
cognition).

### The rule selects the basis; the gate stays uniform

`by confidence θ` is the **threshold** basis; `by conformal α` is the **conformal** basis — the
prediction set is `{ v : nonconformity(v) ≤ q̂ }`, where `q̂` is the level-`α` quantile of the gate's
own recorded decisions and their labels on the ledger, giving finite-sample set coverage under
exchangeability without requiring calibrated provider scores. Human escalation is the `principal`
prefix, not a basis. A rule may carry a consequential **`floor m`** (the margin floor checked at the
sink, below) and a conformal rule a **`readiness N`** (the minimum labelled cases before autonomous
commit); the inline keyword `confidence θ` and the threshold basis are the same thing. The recorded
`Decided` event pins which rule, profile, and (if any) principal settled it, so a recalibration or
identity-backend change does not change how an earlier run replays.

**GateProfile — empirical authority, not source syntax.** Source declares the decision intent
(label space, rule, readiness, margin/floor). The runtime records the empirical evidence that makes
autonomous use legitimate in ledgered **GateProfiles**: the provider/model, schema hash,
prompt-template hash, score function, calibration examples, calibration ledger head, fitted
parameters/quantile, metrics, and status (`active`, `stale`, `retired`). A profile is a projection of
ledger events such as labelled outcomes, principal decisions, profile activation, and profile staling;
it is not normally written in `.ag` source. Replaying an old run uses the profile recorded in that
run's `Decided` event. Future runs may not silently reuse a stale or incompatible profile.

**Autonomy is earned from ledgered labels.** Gates are expected to mature in phases:

- **Cold** — no compatible profile or too few labels. Consequential cases fail closed: only
  explicitly low-risk/obvious threshold decisions may proceed, and ambiguous or high-stakes cases
  route to the gate's `principal` prefix (or stay `abstained` if none). Those principal decisions become labels.
- **Warm** — enough compatible labels for conformal coverage. The gate forms a prediction set and
  commits iff the set is singleton; otherwise it abstains and accumulates more labels.
- **Mature** — enough labels and a stable distribution for calibrated expected-loss decisions. The
  active profile maps score vectors to calibrated probabilities; if the expected loss of acting is
  below the cost/policy of deferral, the gate may commit, otherwise it abstains. Mature gates may
  still defer; "mature" means autonomous when justified, not autonomous always.

**The supervised-to-autonomous bootstrap.** A conformal gate guarantees nothing without data, and
its data is the ledger itself — its own past decisions and their recorded outcomes. Below the rule's
`readiness` minimum of labelled cases the gate cannot commit, so a principal-prefixed `decide`
(`p decide c by r`) routes those cases to `p`. Those principal decisions become the first labelled
cases; once enough accrue the gate commits autonomously, escalating thereafter only genuinely
ambiguous (non-singleton) cases. Only an actual ruling labels its judgment: a declined or
unavailable consult (`FailedPrincipalDecision`) contributes **no** label — a refusal to rule is not
evidence, so it never enters the gate's calibration set. A fresh agent is thus human-supervised by construction and earns
autonomy as it accumulates grounded labels. A recorded outcome that labels a judgment references that
judgment's ledger id, so the judgment↔label join stays auditable on the ledger rather than in untyped
host state.

**Profile invalidation.** A profile is valid only for the source and runtime conditions it records:
same rule, enum/schema, prompt-template hash, provider/model, score function, calibration pool, and
drift status. Changing any of those conditions, observing coverage drift, discovering bad labels, or
materially changing the task distribution records a stale/retired profile. This never rewrites
history: prior gate decisions remain replay-valid because they record the profile they used. It only
prevents future decisions from treating old evidence as current.

### The consequential-action rule

A consequential sink — a `perform` argument (whether or not the action is wired to an effector,
§6b; there is no other outbound path) — may consume a value only if it is
`**settled`**: it carries no un-endorsed cognition. A `Credence` reaches a usable settlement only
through `decide` then `endorse`; `endorse` is constructible only inside a branch that has narrowed
the `Decision` to a committed variant (so an `abstained` decision has no endorsement to give and
statically cannot reach a sink). External prompt, sensor, and result-event values may satisfy
this judgment-trust check because they carry no un-endorsed cognition, but their ingress
provenance is not erased and is not interpreted as action safety. There is deliberately no
manifest option such as `tainted_to_action = allow|warn|deny`: ingress-tainted external data
does not add an action-sink policy layer, and it does not relax the settled-only rule for
model cognition. This static check is joined by two runtime checks at the sink. First, the
**margin floor** — `margin ≥ m`, with `m` the rule's `floor`. A committed decision whose margin is below `m`
faults the action (`MarginFloorViolation`, §16.6), the typed trigger for escalation. A gate whose rule
declares no `floor` performs only the static admission check and raises no `MarginFloorViolation`; to
impose a runtime floor, give the rule a `floor m`. Second, the **task-scope enablement** (§6c):
a `perform` executed while the agent is running an assigned task additionally requires the
active task to be **endorsed** and to name that action in its `scope` clause; otherwise the
action faults (`TaskScopeViolation`, §16.6). A perform with no active task needs only the
static grant. The static grant is always the upper bound — the task check can only *disable*
a granted power, never widen one (§14).

**Fail-closed by default.** `m` (the margin floor) sets how confident the gate must be; when a
consequential decision does not clear it, the action faults rather than proceeds — a consequential
gate **fails closed**. (Asymmetric loss — weighting a false accept against a false reject to ground
the threshold decision-theoretically, e.g. the Bayes-optimal `θ = c_FA / (c_FA + c_FR)` — is a future
enrichment carried by the calibrated GateProfile, §16.8, not a source annotation in this version.)

### Static checks

Extending the consequential-action rule (§15.3.3):
- **Subject-scope requirement.** The endorsed subject must be in the decision's dependency scope: a
  decision about `other_response` cannot endorse `response`. If the dependency scope is dynamic or
  unknown, the checker rejects the endorsement or forces an explicit principal path. This catches
  irrelevant decision use mechanically; it does not attempt to prove natural-language semantic
  relevance.
- **Deference requirement.** A consequential path with no `principal` prefix and no compatible mature
  profile is a compile error unless the rule explicitly declares a non-human cold-start strategy.
  Autonomy is earned via labels; a local fallback action does not substitute for labels.
- **Distribution-source check** (config-aware, §16). A consequential gate needs a distribution: a
  provider with logprobs → ok; without, but with the sampling fallback configured → ok (warn on
  cost); with neither → **warning**, conformal degrades to pure deferral. The fallback is
  manifest-switchable (`[provider] sampling_fallback = false`).

### The external dependencies, one discipline

| dependency | supplies        | reached at        | color | judgment trust of result               | ingress provenance |
| ---------- | --------------- | ----------------- | ----- | -------------------------------------- | ------------------ |
| provider   | a model         | `self <- p`       | `A`   | `raw` / `graded` (Credence slot)       | joins prompt expr  |
| identity   | a `principal`   | `p decide c by r` | `A`   | `Decision<E>` with principal provenance | joins inputs       |
| world      | the world (MCP) | `perform A(args)` / a wired `emit` / a standing sensor (§6b) | `A`   | `⊔` request payload (settled on the perform path) | external unless screened |

All three are external, non-deterministic, journaled, and swappable by config. A rule-only gate
needs no external dependency — a conformal gate calibrates from its own recorded decisions on the
ledger. The membrane — capability + trust + ledger + gate — is identical across them.

### Provenance

Authority is bounded at compile time, cognition is endorsed-and-recorded before
it acts, external ingress is labeled separately from judgment trust, and every fact's
provenance is auditable on an append-only ledger.

---

## 14. Trusted kernel and invariants

Agape's implementation is allowed to be broad, but its trusted kernel is deliberately
small. A conformant implementation must preserve the following invariants before any
surface feature, optimization, host integration, or deployment adapter is considered valid.

**Kernel objects** — `Credence<E>` is the only model-derived graded judgment; `Decision<E>` is the
sealed, ledgered committed-or-abstained form of a `Credence<E>`; `Endorsement<T>` is the recorded
proof that a committed `Decision<E>` was applied to an exact subject value `T`; `decide` and
`endorse` are the only source
operations that discharge judgment trust; the taint lattice is monotone except at those gates;
`grants` are default-deny and never widened by runtime data (an endorsed task's `scope` can only
*disable* a statically granted power at the sink, never add one — attenuation, §6c); `perform`
is the consequential sink and the only outbound path to the world (§6b); the ledger is the root
of replayable state.

**Allowed trust transitions** — there are no hidden declassifiers. The only legal path from
model testimony to world effect is:

```
raw reply -> Credence<E> -> Decision<E> -> Endorsement<T> -> granted sink -> ledger
```

The subject `T` may be anything cognition produced — a reply, a generated artifact, a parsed claim;
the chain is the same. The `Decision<E>` link is always recorded as `Decided`; the
`Endorsement<T>` link exists only for committed variants.

A helper function, memory recall, ledger query, or wired result event may make this path easier to write,
but may not add a second path. A `Decision` may guide control flow, but only an `Endorsement`
(settled subject) can drive a consequential sink, and that endorsement can be constructed only after
the `Decision` is narrowed to a committed variant. Recall from memory is always tainted; a wired
result event joins the trust of its request payload; an effector is invoked only behind a wired
`perform` or `emit` (§6b). If the checker cannot establish a value's type, trust,
endorsement, wiring, grant, or replay source at a kernel boundary, the conformant behavior is
to reject rather than infer authority.

**Foundational** — the log is the source of truth; external capability (cognition,
identity, the world) enters only through a declared seam — a declared dependency or a
manifest-wired event/action (§6b); no hidden runtime exists
outside the kernel contract; every surface construct reduces to kernel operations and adds no
new trust transition.

**Type & effect** — `pure` is the marked seam-free function form and cannot reach a declared dependency
(and cannot `perform`), though it may `emit`, rule-decide an in-hand `Credence`, and `endorse` by
an in-hand `Decision`;
typed provider replies are bare values whose send lifecycle is ledgered; a send bound to a
`Credence<E>` slot yields a graded judgment, never a committed value; `decide c by r` creates
and records a sealed `Decision<E>`,
`endorse subject by d` produces and records an `Endorsement<T>` of an exact subject only when `d`
has been committed-narrowed, and only an `Endorsement` may drive a consequential sink
(a `perform` arg — the only outbound path, §6b); fusion of two or more `Credence`s (including
`quorum`) requires a total `independent`/`dependent` declaration over the `Credence[]`;
a `principal` prefix on `decide` takes a `Principal` (no `text → Principal`); user
`struct`/`enum`/`event`/`action` types are explicitly declared; a wired result-event payload
carries judgment trust joined with its request payload's trust and separate ingress provenance
(§6b); authority, trust (three-level), ingress, and color are checked statically and
interprocedurally; a violation is a compile error.

**Runtime** — ticks are system-level; structured output uses constrained decoding;
subscriptions are prospective and hoisted (never retroactive), and history is reached by
query; multi-handler firing is registration-order; a message trace is a prefix of
`Sent→Delivered→Resolved`; a task-send additionally lands exactly one terminal task record
(`TaskCompleted`/`TaskFailed`/`TaskCancelled`/`Expired`, §6c) and a late `complete`/`fail`
after a tombstone is refused (`CompletionRefused`); every memory write carries a provenance backpointer; each agent
instance's private memory is isolated and is consulted-then-internalized on every reaction (the
mandatory envelope, §16.7), and recall cannot launder trust; all three
dependencies journal their oracle results to the ledger for replay (§15.4.2); replay
re-serves recorded dependency results (including memory decomposition/embedding) and never
re-invokes a wired effector; the margin floor `m`
is enforced at the consequential sink.

The invariants, exercised — default-deny authority, the one legal trust path, human escalation,
and fail-closed abstention:

```agape
enum Approval { Approve, Deny }

struct Payout { amount_cents: int, payee: text }

event  Held(text why);
action Pay(int cents);

principal treasurer;

agent Clerk grants { perform Pay } {            // authority: exactly one power
  on awake {
    Payout req = self <- "extract the payout request";         // raw cognition
    Credence<Approval> c = self <- f"approve {req.amount_cents} to {req.payee}?";
    Decision<Approval> d = treasurer decide c by conformal 0.05;  // cold → escalates to a human
    if (d.committed == Approve) {
      Endorsement<Payout> e = endorse req by d;                // the only path to settlement
      perform Pay(e.amount_cents);                             // the sink admits only the endorsed datum
    } else if (d.committed == Deny) {
      emit Held("denied");
    } else {
      emit Held("no ruling — withheld");                       // fail closed
    }
  }
}

spawn Clerk k;
awake k;
```

---

# 15. Formal Semantics

> The source of truth: the abstract grammar, a static (type + effect) semantics, a dynamic
> (operational) semantics with the ledger as explicit state, and the reproducibility model.
> Where §0–§14 and §15 conflict, §15 wins.

## 15.0 Modeling choices

- Two qualifiers travel with every expression. Color `c ∈ {S, A}` (does it reach a declared dependency?)
and trust `t ∈ {settled, graded, raw}` (cognition-provenance). A gate has color `A` when it may
reach a declared dependency, such as a principal-prefixed `p decide c by r`; a rule-only
`decide` and an `endorse` are `S`.
- `Endorsement<T>` is the first-class recorded proof that a decision was applied to an exact
subject value; it is the proof object checked at consequential sinks.
- Authority is a property of the agent context (its `grants`).
- The three external dependencies (provider, identity, world) are the only sources of dynamic
non-determinism, modeled as oracle relations (§15.4.2).

## 15.1 Notation

```
c ∈ {S,A}   color   (S ⊑ A)        t ∈ {settled,graded,raw}   trust   (settled ⊑ graded ⊑ raw)
Γ           x ↦ (T, t)             r : Rule   a decision rule (threshold `confidence θ [margin δ] [floor m]` | conformal `α [readiness N] [floor m]`)
Σ           agent signatures       A              action type names (consequential)
G           grants set incl. ("perform",A) ("reach",D)
Endorsement<T>  a ledger-recorded endorsement about subject type T (created only via endorse)
```

Judgment `**Γ; Σ; A ⊢ e : T ! c · t**`.

## 15.2 Abstract syntax (EBNF)

```
program    ::= decl*                                          // one flat namespace

decl       ::= typedecl | agent | fn | confdecl | stmt
typedecl   ::= "struct" Ident "{" field ("," field)* "}"
             | "enum"   Ident "{" Ident ("," Ident)* "}"
             | "event"  Ident "(" field ("," field)* ")" (":" "Error")? ";"   // optional Error supertype (§9)
             | "action" Ident "(" field ("," field)* ")" ";"   // performative sink; wiring to an effector is manifest config, not source (§6b)
field      ::= type Ident                                     // "name: T" also accepted (struct fields)
agent      ::= "agent" Ident params grants? "{" abody* "}"
fn         ::= "pure"? type Ident params block                // async is the default
confdecl   ::= "conformal" Number ";"                         // file-level default conformal α

grants     ::= "grants" "{" ( "*" | cap ("," cap)* ) "}"
cap        ::= "perform" Ident | "reach" Ident
config     ::= "{" directive* "}"                             // colon-free `keyword operand…` directives
directive  ::= Ident operand*
operand    ::= Ident | String | Int | Float
params     ::= "(" (type Ident ("," type Ident)*)? ")"
abody      ::= extend | on | stmt
extend     ::= "extend" Ident args ";"
on         ::= "on" ("awake"|"sleep"|"crash"|"assigned"|"cancelled") block    // task hooks are `when` sugar (§6c)

type       ::= "int"|"float"|"bool"|"text"|"null" | "event" "<" type ">"
             | "array" "<" type ">"                     // collection (query results, fan-out source)
             | "Credence" "<" type ">"                  // graded judgment over enum
             | "Decision" "<" type ">"                  // a gate's committed outcome
             | "Endorsement" "<" type ">"               // a recorded subject endorsement
             | "Task" "<" type ">"                      // a background-task handle (§6c)
             | Ident                                     // enum/struct/agent/action names, incl. Principal, mem

stmt       ::= vardecl | assign | spawn | prompt | principal | depdecl
             | instruction | memdecl | forget            // system prompt (§5); private-memory handle + tombstone (§10)
             | "awake" Ident ";" | "sleep" Ident ";"
             | "emit" Ident "(" [expr ("," expr)*] ")" ";"     // plain event; args match fields positionally
             | "perform" Ident "(" [expr ("," expr)*] ")" ";"  // action; args match fields positionally
             | "complete" expr ";"                      // resolve the active assigned task (§6c; task handler only)
             | "fail" expr ";"                          // fail the active assigned task with a text reason (§6c)
             | "cancel" postfix ";"                     // delegator-side task cancel; operand must be Task<T> (§6c)
             | "return" expr? ";"                       // `say(x)` is an ordinary call (`expr ;`)
             | "if" "(" expr ")" block ("else" block)?
             | when
             | expr ";"
vardecl    ::= type Ident ("=" expr)? ";"               // disambiguated from `assign` by the leading `type Ident` (LL(2))
assign     ::= postfix "=" expr ";"                     // postfix covers `x`, `self.f`, `x.f`, `x[i]`
spawn      ::= "spawn" Ident Ident args? ";"            // allocate + construct
prompt     ::= "prompt" type Ident ";"
instruction ::= "instruction" String ";"                // compile-time system prompt; global or agent-scoped (§5)
memdecl    ::= "mem" Ident ("<-" expr)? ";"             // declare a private-memory handle, optionally initialized (§10)
forget     ::= "forget" Ident ";"                       // tombstone a `mem` handle; consumes it (§10)
principal  ::= "principal" Ident config? ";"            // identity backend binds principal names
depdecl    ::= ("independent"|"dependent") Ident ("," Ident)* ";"
when       ::= "when" "(" type Ident? ("about" expr)? ")" ("if" "(" expr ")")? block
block      ::= "{" (vardecl | stmt | when)* "}"         // a scope; hoists its `when` subscriptions (§16.3)
args       ::= "(" (expr ("," expr)*)? ")"              // call / spawn / extend arguments (no trailing comma)

gate       ::= Ident? "decide" expr "by" rule           // → Decision<E>; the optional leading Ident is the escalation prefix — it must resolve to a `Principal` (T-Decide-Principal, §15.3.2); needs LL(2) lookahead to `decide`
             | "endorse" expr "by" expr                 // → Endorsement<T> (subject, decision)
rule       ::= "confidence" Number ("margin" Number)? ("floor" Number)?     // threshold basis
             | "conformal" Number? ("readiness" Int)? ("floor" Number)?     // conformal basis; with no α, inherits the file `conformal` default (else 0.05)
             | "(" expr ")"                              // a Rule-valued expression (parenthesized); must be Rule-typed (else TypeError)

expr       ::= expr "<-" expr ("expires" expr)?          // send (agent on left); or STORE into a `mem` (mem on left, §10); `expires` operand is a settled numeric expr; MANDATORY when the message is TaskSpec-typed (a tasklit or TaskSpec/Endorsement<TaskSpec>, §6c)
             | expr "->" expr                            // RECALL from a `mem` (always tainted, §10)
             | expr "|>" Ident                           // bounded fan-out: map async fn over a finite collection (§12)
             | gate                                      // a gate as an expression: decide → Decision<E>, endorse → Endorsement<T>
             | "perform" Ident "(" (expr ("," expr)*)? ")" ("expires" expr)?   // foreground perform BINDING (§6b): an expression ONLY when result-bound, and `expires` is then MANDATORY (checked); the statement form remains in stmt
             | "quorum" "(" Int "," expr ")"             // at least k of a Credence<bool>[] (§12)
             | ledgerquery                               // objective ledger read → LedgerEntry<E>[] / Record[]
             | cmp
tasklit    ::= "task" "{" taskclause* "}"                // builds a TaskSpec (§6c); objective+acceptance REQUIRED
taskclause ::= "objective" expr ";" | "acceptance" expr ";"
             | "scope" "{" "perform" Ident ("," "perform" Ident)* "}"   // enabling scope; delegator must hold each power
ledgerquery ::= "select" Ident "as" Ident "from" "ledger" "where" "{" cond "}"
              | "select" (Ident ("," Ident)* | "*") "from" "ledger" "where" "{" cond "}"  // recorded-trust read of the log
cond       ::= cmp (("&&"|"||") cmp)*                    // a boolean filter over fields
cmp        ::= add (("=="|"!="|"<"|">"|"<="|">=") add)?
add        ::= mul (("+"|"-") mul)*
mul        ::= unary (("*"|"/") unary)*
unary      ::= "!" unary | postfix
postfix    ::= primary ("." Ident | args | "[" expr "]")*    // "." Ident is field/metadata access
primary    ::= Int|Float|String|FString|"true"|"false"|"null"|"abstained"|"self"|Ident
             | "(" expr ")"
             | Ident "{" (Ident ":" expr ("," Ident ":" expr)*)? "}"  // struct literal
             | tasklit                                    // : TaskSpec — bindable (e.g. a draft to endorse) or sent directly (§6c)
             | "[" (expr ("," expr)*)? "]"               // array literal
```

**Types.** `type[]` is the collection suffix. `Credence<E>`, `Decision<E>`,
`Endorsement<T>`, `Task<T>`, and `LedgerEntry<E>` are the prelude generic types; there is no
surface `event<T>` reply wrapper.

**Collections.** `T[]` is the collection type *produced* by the ledger query (which may bind
many results) and *consumed* by fan-out (`|>`) and fusion (`quorum`, §12). It is a value to map and reduce over — not
an imperative data structure. Agape has no general-purpose imperative substrate of its own; heavy or
world-affecting computation is imported through the world interface (§6b) — wired events and
actions over the manifest's endpoint catalog — and governed at that seam, never
reimplemented in the language.

## 15.3 Static semantics

### 15.3.1 Qualifier lattices

`color: S ⊑ A`. `trust: settled ⊑ graded ⊑ raw`, tracking cognition-provenance: `settled`
carries no un-endorsed cognition (constants, judgment-settled external ingress, gated
`Decision`s); `graded` is a `Credence`; `raw` is unstructured model output. `ingress:
internal ⊑ external_screened ⊑ external_unscreened`, tracking whether a value carries
external bytes and whether a manifest screen accepted them. `⊔` is the join; color, trust,
and ingress are contagious upward unless a kernel gate settles trust or a manifest ingress
screen marks a boundary value `external_screened`.

### 15.3.2 Expression rules (selected)

```
Γ ⊢ d : Agent   Γ ⊢ p : Text · t_p · ι_p        // any send invokes cognition at d; raw until bound to a Credence
provider_ingress_policy(ι_p, manifest) ≠ deny
──────────────────────────────  (T-Send)        Γ ⊢ (d <- p) : T_reply ! A · raw · ι_p

Γ ⊢ d : Agent   Γ ⊢ p : Text · t_p · ι_p    E an enum
provider_ingress_policy(ι_p, manifest) ≠ deny
─────────────────────────────────────────────  (T-Credence)
Γ ⊢ (Credence<E> _ = d <- p) : Credence<E> ! A · graded · ι_p    // any destination d

Γ ⊢ aᵢ : Tᵢ · settled · ιᵢ    action A(T₁..Tₙ) declared    ("perform",A) ∈ G ∨ G = {*}
result_event(A) = E per the manifest    Γ ⊢ n : Int · settled
─────────────────────────────────────────────────────────────────────────  (T-Perform-Bound)
Γ ⊢ (x = perform A(a₁..aₙ) expires n) : T_E ! A · settled · ingress(E)
// T_E from the configured result event E: a single-field event binds that field's value; a
// multi-field event binds a struct of its fields; no manifest in scope ⇒ conservative (`unknown`),
// runtime-enforced. Result judgment trust = boundary-settled ⊔ (⊔ tᵢ) = settled (args are settled);
// result ingress = external_unscreened unless E's manifest-configured screen accepts and records
// external_screened.
// `expires` MANDATORY on the binding form; failure/expiry faults the awaiting invocation (§6c, §16.6).
// ILL-FORMED if any arg is not settled; a ConfigError at runtime if A has no result_event (§17.1).

Γ ⊢ e : Credence<E> ! c · graded    r : Rule
────────────────────────────────────────────  (T-Decide / GATE)
Γ ⊢ decide e by r : Decision<E> ! c · settled

Γ ⊢ e : Credence<E> ! _ · graded    r : Rule    Γ ⊢ p : Principal
────────────────────────────────────────────  (T-Decide-Principal / GATE, async)
Γ ⊢ p decide e by r : Decision<E> ! A · settled

Γ ⊢ a : T · _ · ι_a    Γ ⊢ d : Decision<E> · settled    a ∈ scope(d)    committed-narrowed(d)
────────────────────────────────────────────  (T-Endorse / GATE)
Γ ⊢ endorse a by d : Endorsement<T> ! S · settled · ι_a

Γ ⊢ cs : Credence<Bool>[] ! col · graded    dep-declared(cs)
──────────────────────────────────────────────────────────────  (T-Fuse)   // quorum
Γ ⊢ quorum(k, cs) : Credence<Bool> ! col · graded
        // ILL-FORMED if any pair in cs is neither independent- nor dependent-declared
```

The GATE rules (`T-Decide`, `T-Decide-Principal`) are the only routes from `Credence` to `Decision`;
`T-Endorse` is the only route from a `Decision` to a settled `Endorsement` of a subject, and is
synchronous (the committed `Decision` is in hand). A principal prefix makes `decide` async (it may
reach the identity dependency). A result-bound `perform` (T-Perform-Bound) is async and settled;
every `perform` requires its `perform` grant (W-Auth). T-Fuse (`quorum`) requires total
dependence coverage over the `Credence[]`. Branching on a gate is an ordinary `if` over
`.committed`; the flow-narrowing that permits subject endorsement is W-Decision (below).

### 15.3.3 Statement & agent well-formedness — the guarantees

**Effect signatures (interprocedural).** Each `f` carries `Φ(f) = (c_f, ρ_f, κ_f)`:

- `c_f ∈ {S,A}` — `A` if its body reaches any declared dependency (including a `perform`) or calls any
`A`-colored `g`; else `S`. A `pure`-declared `f` asserts `c_f = S`.
- `ρ_f` — transparent parameters (judgment trust and ingress flow to the result).
- `κ_f` — consequentially-consumed parameters (fed into a `perform`/reach).

`Φ` is the least fixpoint over the call graph; a builtin is `(A, ∅, ∅)` unless modeled.

```
// COLOR — interprocedural (a perform forces A):
c_f = S
──────────────────────────────────────  (W-PureSeamFree)
⊢ f  ok    // body reaches no declared dependency (no <-, no Credence-slot, no principal-prefixed decide, NO perform) AND calls only S fns

// AUTHORITY — perform / reach (DEFAULT-DENY):
allowed(C,kind,X) ⟺ G ≠ ⊥ ∧ ((kind,X) ∈ G ∨ G = {*})
──────────────────────────────────────────────────────────  (W-Auth)
in C:  ⊢ perform A(e) ok ⟺ allowed(C,"perform",A)
       ⊢ (x <- p)    ok ⟺ x = self ∨ allowed(C,"reach",typeof(x))
       ⊢ emit E(e)   ok                        // a plain event needs no power (an emit-trigger wiring is manifest-controlled, §6b)

// AUTHORITY — subtractive extend:
agent C extends P
──────────────────────  (W-Extend)
grants(C) ⊆ grants(P)        // ⊥ ⊆ G ⊆ {*}; covers perform/reach uniformly

// THE CONSEQUENTIAL-ACTION RULE (static admission + runtime margin floor):
sink(s)     Γ ⊢ e : Te · t · ι     ¬( t = settled )
──────────────────────────────────────────────────────────────  (W-Consequential-static)
s(…e…)  is ILL-FORMED
// sink = perform arg — wired or unwired; there is no other outbound path (§6b).
// A settled NON-Endorsement (a constant, a `prompt` value,
// a judgment-settled result-event payload) passes the judgment-trust check even when its ingress is
// external_unscreened. An `Endorsement` is settled only because T-Endorse required a
// committed-narrowed Decision. A graded/raw value is rejected. There is no manifest allow/warn/deny
// policy for ingress-tainted data at this sink.
// At runtime, for an admitted `Endorsement`: margin(e) ≥ m, else the action faults (MarginFloorViolation).
// At runtime, inside an assigned task: the active task must be endorsed and name the action in
// its scope, else the action faults (TaskScopeViolation, §6c) — enablement, checked like the floor.

// PROVIDER-PROMPT INGRESS POLICY (manifest-aware; no source syntax):
Γ ⊢ p : Text · _ · external_unscreened    provider_ingress_policy = deny
──────────────────────────────────────────────────────────────  (W-ProviderIngress)
⊢ (d <- p) is ILL-FORMED for this (source, manifest) pair
// default warn emits a diagnostic and preserves external_unscreened in the rendered prompt's audit
// metadata; off accepts silently. A configured ingress screen may mark the source value
// external_screened before it reaches this rule.

// DELEGATION — the task-send (§6c):
Γ ⊢ d : Agent    Γ ⊢ o : Text · t_o · ι_o    Γ ⊢ a : Text · t_a · ι_a    Γ ⊢ n : Int · settled
──────────────────────────────────────────────────────────────  (T-Delegate)
Γ ⊢ (d <- task { objective o; acceptance a; } expires n) : T_result ! A · raw
        // bound as `T r = …` (foreground) or `Task<T> h = …` (background handle · settled).
        // ILL-FORMED if: `expires` is absent; the result is unbound (statement form);
        // objective/acceptance missing or not Text; the task block is empty.
        // TaskSpec trust = t_o ⊔ t_a and ingress = ι_o ⊔ ι_a (delegation never launders either).

// DELEGATION — scope attenuation (compile time):
task carries scope { perform A₁ … perform Aₙ } in agent C
──────────────────────────────────────────────────────────────  (W-Scope-Attenuate)
∀ i. allowed(C,"perform",Aᵢ)    ∧    the sent message : Endorsement<TaskSpec>
        // a scoped task can only attenuate its DELEGATOR's authority, and is enabling only
        // when endorsed (endorse requires a committed-narrowed Decision, T-Endorse).
        // An unendorsed scoped task at a send is ILL-FORMED.

// DELEGATION — task verbs (worker side):
`complete e;` / `fail e;` ok ⟺ enclosing handler is a task handler (`on assigned` / the
        filtered Delivered subscription); `fail` requires e : Text; `complete e` requires
        e : T_result of the active task. `cancel h;` requires h : Task<T>. Elsewhere: ILL-FORMED.

// DECISION / flow narrowing (subject endorsement is flow-sensitive on `d.committed`):
Γ ⊢ d : Decision<E> · settled
──────────────────────────────────────────────────────────────  (W-Decision)
inside a branch where d.committed is narrowed to a real variant v (an `if (d.committed == v)`):
    Γ[d ↦ Decision<E> · settled, committed-narrowed(d)]  ⊢ body ok    // `endorse a by d` is constructible
inside the else / non-committed branch (d.committed == abstained):
    Γ[d ↦ Decision<E> · settled]                         ⊢ body ok    // no endorsement may be constructed

// CALL — trust/ingress transfer and consequential-arg rejection:
Γ ⊢ aᵢ : _ ! _ · tᵢ · ιᵢ        t_result = ⊔ { tᵢ : i ∈ ρ_f }        ι_result = ⊔ { ιᵢ : i ∈ ρ_f }
∀ i ∈ κ_f.  tᵢ = settled
──────────────────────────────────────────────────────────────  (W-Call)
Γ ⊢ f(a₁..aₙ) : T ! c_f · t_result · ι_result     // ILL-FORMED if some i∈κ_f is not settled
```

The endorsement half of the consequential rule is static (W-Consequential-static); the
margin floor and the task-scope enablement are runtime.

## 15.4 Dynamic semantics

### 15.4.1 Runtime configuration

`⟨ Π | Ψ | Ω | Â | μ | S | k ⟩` — provider `Π`, identity `Ψ`, world `Ω`, agents `Â`, memory
`μ`, ledger `S` (append-only, `tick(S)=|S|`), continuation `k`.

### 15.4.2 The external dependencies as oracles (where stochasticity lives)

```
think   : Π × Prompt × Schema   ⇝  Value × Π             (provider; NON-deterministic)
consult : Ψ × Principal × Credence<E> ⇝ (E × Signature) × Ψ  (identity dependency; external, auditable; Signature = the principal's signed ruling)
invoke  : Ω × Endpoint × Args   ⇝  Value × Ω              (the world seam — the wired [tools.*] endpoint; external, effectful)
screen  : Σ × IngressPoint × Value ⇝ (accept|reject, Value) × Σ
                                                            (optional manifest ingress screen; not source-visible)
```

The three source-visible oracles' results are journaled to the ledger as produced (the send's
`Resolved` / `PrincipalDecision` or `FailedPrincipalDecision` / `ToolResolved`). A configured
ingress screen is also replay-bound: its input bytes, verdict, normalized output, and resulting
ingress provenance (`external_screened` on accept, no ordinary delivery on reject) are recorded at
the boundary that invoked it. Gate collapses are journaled as `Decided`, whether they commit or
abstain. Replay never re-invokes an oracle, endpoint, or screen: it serves each from the recording
in order — a wired effector is replayed as its recorded result, not re-run. The ledger is
hash-chained, so a faithful replay regenerates an identical chain — chain-head equality is the
proof of replay-equivalence.

**Task-send dynamics (§6c).** A task-send is an ordinary send whose `Resolved` is produced by
the recipient's `complete` statement rather than by `think`; `complete e` appends `Resolved`
then `TaskCompleted(e)` in the same reaction; `fail e` appends `TaskFailed(e)` and the
transport chain rests at its `Delivered` prefix; `cancel h` appends `TaskCancelled(corr(h))`.
The first terminal for a correlation wins: after `TaskCancelled` or `Expired`, a `complete`/
`fail` for that correlation appends `CompletionRefused(corr)` and its payload is discarded.
A foreground (result-bound) delegation whose terminal is `TaskFailed`/`Expired`/`TaskCancelled`
faults the awaiting invocation (the contained-crash path, §5 — `AgentCrashed`). All task rows
are ordinary ledger events: replay folds them deterministically like every other record.

### 15.4.2a The ledger as an audit log — consensus, forking, forensics

The ledger is a hash-linked, append-only log (a Merkle-style commitment), so immutability
and auditability hold by construction. This is the transparency half of a blockchain; the
consensus half is absent: a single Agape runtime is the authority that assigns ticks, so
consensus is pure overhead. Consensus becomes load-bearing only at one boundary — multiple
mutually-distrusting runtimes sharing one ledger — and is therefore an optional
distributed-ledger layer, never the core. (This is distinct from `quorum`, §12, which is
single-runtime evidence fusion, not multi-node agreement.) Counterfactual/forensic replay
(Jefferson's *Time Warp*, 1985) and fork/merge are scoped to an optional Multi-verse
library.

```
// DECIDE (rule only) — local gate collapse; no oracle; sealed ledgered Decision value:
v' = collapse(eval(c), r)        // singleton prediction set ⇒ that variant; else `abstained`
id = tick(S)
S' = append(S, Decided(subject(c), { decision_id:id, credence:c, rule:r, committed:v', basis, margin }))
─────────────────────────────────────────────  (E-Decide)
⟨…|S| decide c by r ⟩ → Decision{decision_id:id, committed:v', …}, ledger S'

// DECIDE (principal prefix) — rule first; on non-commit, reach the identity dependency; async:
v' = collapse(eval(c), r)
(v' ≠ abstained)                       ⇒ S₁ = S , v'' = v' , Ψ' = Ψ , principal_event = null
(v' = abstained ∧ consult succeeds)    ⇒ (Ψ, p, eval(c)) ⇝ (decision, sig, Ψ') , principal_event = tick(S) , S₁ = append(S, PrincipalDecision(who:p, credence:c, decision, sig)) , v'' = decision
(v' = abstained ∧ consult declines/unavailable) ⇒ principal_event = tick(S) , S₁ = append(S, FailedPrincipalDecision(who:p, credence:c)) , v'' = abstained , Ψ' = Ψ
id = tick(S₁)
S₂ = append(S₁, Decided(subject(c), { decision_id:id, credence:c, rule:r, committed:v'', basis, margin, principal_event }))
─────────────────────────────────────────────  (E-Decide-Principal)
⟨…|Ψ|S| p decide c by r; k⟩ → ⟨…|Ψ'| S₂ | Decision{decision_id:id, committed:v'', …}; k⟩

// ENDORSE — apply an existing committed Decision to an exact subject; synchronous; single event; → Endorsement value:
d = eval(decision) ; v' = d.committed ; require v' ≠ abstained ∧ subject ∈ scope(d)
ev = Endorsed(subject_hash(subject), decision_id(d), v')
─────────────────────────────────────────────  (E-Endorse)
⟨…|S| endorse subject by decision ⟩ → append(S, ev), Endorsement{subject, decision_id:decision_id(d), committed:v', …}
// There is no abstained endorsement; abstinence is represented by the Decision's `Decided` event.

// SPAWN — allocate + bind ctor args + run constructor; mailbox closed; hoist subs:
Â' = Â[name ↦ { type, params := eval(args), awake:false }] ;  register-hoisted-subs(ctor-body)
─────────────────────────────────────────────────────────────  (E-Spawn)
⟨…|Â|μ|S| spawn T name(args); k⟩ → ⟨…|Â'|μ| run(ctor-body); append(S, Spawned(name)) |k⟩

// AWAKE — open mailbox, emit AgentAwake, run on-awake hook (no args; state is the ledger):
─────────────────────────────────────────────────────────────  (E-Awake)
⟨…|Â| awake name; k⟩ → ⟨…|Â[name.awake:=true]| append(S, AgentAwake(name)); on-awake-hook; k⟩

// CRASH — a contained fault: record, run on-crash, keep the mailbox open and state intact:
fault in a handler invocation
─────────────────────────────────────────────────────────────  (E-Crash)
⟨…|Â|S| …fault…; k⟩ → ⟨…|Â| append(S, AgentCrashed(name)); on-crash-hook; resume⟩   // not a death

// SEND — three-phase lifecycle; reply raw until Credence-bound; content not stored (only the lifecycle):
awake(dest)   provider_ingress_policy(ingress(render(p)), manifest) ≠ deny
(Π, render(p), schema(T)) ⇝ (v, Π')       // responder thinks through Π (the provider) — any dest
S' = append³(S, Sent(x,@d), Delivered(x,@d), Resolved(x,@d))   // subjects only; v is not logged
─────────────────────────────────────────────────────────────  (E-Send)
⟨Π|…|μ|S| x = (d <- p); k⟩ → ⟨Π'|…|μ[x↦v (trust raw; graded if x : Credence<E>, T-Credence; ingress ingress(render(p)))]|S'| k⟩
// default warn records an audit diagnostic for external_unscreened prompt ingress; off is silent.
// strict deny aborts before `think`, so no provider call is made.

// SEND (lost) — dest not awake at delivery: chain stalls at Sent:
¬awake(dest)
─────────────────────────────────────────────────────────────  (E-Send-Lost)
⟨…|S| x = (d <- p); k⟩ → ⟨…| append(S, Sent(x,@d)) | k⟩         // no Delivered; queryable orphan

// EXPIRE — lifetime elapses before Delivered: tombstone:
Sent(corr) ∈ S   ¬Delivered(corr)   lifetime(corr) elapsed
─────────────────────────────────────────────────────────────  (E-Expire)
⟨…|S| … ⟩ → ⟨…| append(S, Expired(corr)) | … ⟩

// STORE / RECALL — private memory seams; store internalizes, recall is ALWAYS tainted:
─────────────────────────────────────────────────────────────  (E-Store / E-Recall)
⟨…|μ|S| m <- v ⟩ → ⟨…|μ' = internalize(μ, m, v)| append(S, Internalized(m)) ⟩          // decompose across the three views (§16.7)
⟨…|μ|S| x = (m -> q) ⟩ → ⟨…|μ| x ↦ recall(μ, m, q) (trust raw; graded if x : Credence<E>) ⟩   // fused across views; never settled

// EMIT:
─────────────────────────────────────────────────────────────  (E-Emit)
⟨…|μ|S| emit E(e₁,…,eₙ); k⟩ → ⟨…|μ| append(S, E(subj, eval(e₁),…,eval(eₙ))) | k⟩

// EMIT (wired) — an emit-trigger wiring invokes its catalog endpoint through Ω (§6b):
[events.E] wired to K    (Ω, K, eval(e…)) ⇝ (v, Ω')
result_event(E) = E' ⇒ the result row E'(v) is appended, judgment trust boundary-settled ⊔ trust(eval(e…)),
                         ingress external_unscreened unless E' screening records external_screened
─────────────────────────────────────────────────────────────  (E-Emit-Wired)
⟨…|Ω|S| emit E(e…); k⟩ → ⟨…|Ω'| append(S, E(subj, eval(e…)), ToolStarted(K), ToolResolved(K, v) [, E'(v)]) | k⟩
// order: event row → ToolStarted → ToolResolved → result event row (§6b). No laundering:
// a tainted emitted payload taints the result event's judgment trust (the JOIN above); ingress remains
// external unless screened.

// PERFORM — the consequential act; a wired action invokes its catalog endpoint through Ω (§6b):
allowed(C,"perform",A)   admitted (W-Consequential-static)   margin ≥ floor   task-scope enabled (§6c)
[actions.A] wired to K ⇒ (Ω, K, eval(e…)) ⇝ (v, Ω') and the ToolStarted(K)/ToolResolved(K,v) pair is appended
result_event(A) = E ⇒ the result row E(v) is appended, judgment trust boundary-settled ⊔ trust(eval(e…)) = settled,
                      ingress external_unscreened unless E screening records external_screened
─────────────────────────────────────────────────────────────  (E-Perform)
⟨…|Ω|S| perform A(e…); k⟩ → ⟨…|Ω'| append(S, A(subj, eval(e…)) [, ToolStarted, ToolResolved, E(v)]) | k⟩
// order: action row → ToolStarted → ToolResolved → result event row (§6b). A result-bound
// perform (T-Perform-Bound) resumes its awaiting continuation with E's payload when E lands;
// failure or `expires` faults the awaiting invocation (E-Crash, §6c, §16.6).
// failing the margin or task-scope runtime check appends MarginFloorViolation / TaskScopeViolation
// and faults the invocation instead (E-Crash); the action (and any wired effector) does not run.

// DELEGATE — a task-send (§6c, §16.3a): E-Send transport, but Delivered fires the worker's task
// handler instead of think, and Resolved is produced by that worker's `complete`:
⟨…|S| complete e; k⟩ → ⟨…| append²(S, Resolved(corr), TaskCompleted(corr, eval(e))) | k⟩  // corr = the active task
⟨…|S| fail e; k⟩     → ⟨…| append(S, TaskFailed(corr, eval(e))) | k⟩       // transport rests at its Delivered prefix
⟨…|S| cancel h; k⟩   → ⟨…| append(S, TaskCancelled(corr(h))) | k⟩          // the authoritative tombstone
tombstoned(corr) ∧ complete/fail for corr  →  append(S, CompletionRefused(corr))   // payload discarded
foreground(corr) ∧ terminal(corr) ∈ {TaskFailed, Expired, TaskCancelled}  →  fault the awaiting invocation (E-Crash)

// LEDGER QUERY (statement form) — reads the log, lands a QueryResult:
─────────────────────────────────────────────────────────────  (E-Query-Stmt)
⟨…|μ|S| select … from ledger where {…}; k⟩ → ⟨…| append(S, QueryResult(ledger)) | k⟩   // expr form appends nothing

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

For a terminal ledger `S`, the observable outcome `obs(S)` is the subsequence of committed
events: performed actions, decisions (`Decided`), subject endorsements (`Endorsed`), principal
decisions (`PrincipalDecision`/`FailedPrincipalDecision`), `Contradiction`s, wired-effector results, and top-level
bindings of bounded type. It excludes the incidental trace: send `Resolved` reply payloads
(the wording), `say` output, internalized memory text, the `ToolStarted`/`ToolResolved`
replay-journal pair (§6b), tainted result-event
payloads not yet gated, graded `Credence` distributions no gate committed, and raw
raw typed replies that never reach a committed event.

### 15.5.2 Observational equivalence `≈`

```
≈_Bool, ≈_Int, ≈_Null, ≈_Entailment, ≈_Enum, ≈_AgentId  :=  structural equality
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
- **bounded-gated** — a low-margin verdict, or one carrying open `Text` / a tainted
result-event payload. Reproducible only up to the margin. The lint (§15.7) flags a consequential value
cleared only this way; the lint is advisory, not part of the hard conformance bar.

**Oracle model (assumption O).** Fix `𝒫`. For a given `(Π, prompt)` the provider's graded
output is a random variable whose scalar confidence has bounded variance, and two
independent draws satisfy `P(|p₁ − p₂| > δ) ≤ β(δ)` for some nonincreasing `β` with `β(δ) → 0` as `δ →` maximal. For a finite-schema reply via constrained decoding the draw
concentrates, so `β(δ_max) = 0`.

**Lemma 1 — Factoring (non-interference with endorsement).** For well-typed `P`,
`obs(P,I) = F(I, d)` is a deterministic function of inputs `I` and the gate-outcome
sequence `d`, independent of every un-settled (`raw`/`graded`) value.

> *Proof.* Read trust as an integrity lattice tracking cognition-provenance: `raw`,`graded`
> = un-endorsed cognition (high); `settled` = low. `decide` is the only operation that settles a
> `graded` judgment into a sealed `Decision`, and `endorse` is the only operation that settles an
> exact subject value from that decision. Both record their discharge on the ledger. By
> the consequential rule (W-Consequential-static) and W-Call, every constituent of `obs` is
> `settled` — hence an input `I` (a constant or judgment-settled external ingress datum), a gate
> outcome `dⱼ`, or a pure settled-function of these. Progress+preservation (§15.6) preserves
> the invariant under `→`. Non-interference modulo delimited release (Sabelfeld–Myers;
> Sabelfeld–Sands). A wired result event adds no declassifier: its payload carries
> boundary judgment trust joined with the request payload's trust (§6b), so it reaches `obs` only as
> `settled` (a settled perform request) or through a gate (a tainted emit-wired request); an
> effector is invoked only inside a wired `perform` or `emit` (§6b), and the consequential
> path is covered by exactly the `perform` rule. ∎ *(The two-run bisimulation is the mechanization obligation — §15.7,
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
> structural equality, unconditionally (Lemma 1; hash-chained ledger).
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

## 15.5.6 Conformal calibration, and the margin — the gate's evidence

This subsection establishes the two distinct guarantees a gate can offer, so the `Rule` bases
(§13) rest on stated mathematics rather than assertion. Let the provider's scored judgment for
input `x` over the enum's variants be `s_vec(x)` (§3). A compatible calibrated GateProfile may map
that vector to calibrated probabilities `p_cal(y | x)` (§16.8); without such a profile, the vector
is a score distribution only. Let `g(x)` be the **margin**: the lead of the top variant over the
runner-up in the score/probability vector actually used by the gate (for binary at threshold `τ`,
equivalently distance from the boundary, §15.5.5).

**(A) The conformal basis — a coverage guarantee.** `by conformal α` is *split conformal
prediction* (Vovk, Gammerman, Shafer, *Algorithmic Learning in a Random World*, 2005), calibrated
from the gate's own labeled decisions on the ledger:

- **Nonconformity score** `nc(x, y)` (how poorly label `y` fits), for example
  `1 − score(y | x)`. It need not be a calibrated probability; it must be fixed for the profile.
- **Calibration set** `{(xᵢ, yᵢ)}_{i=1..n}` — the gate's past decisions whose true label `yᵢ`
  was later recorded (a principal decision or a fed-back outcome, §13); score each at its *true*
  label, `ncᵢ = nc(xᵢ, yᵢ)`.
- **Quantile** `q̂ = ` the `⌈(n+1)(1−α)⌉`-th smallest of `{nc₁,…,ncₙ}`.
- **Prediction set** `Cα(x) = { y : nc(x, y) ≤ q̂ }`.

> **Coverage theorem.** If `(x₁,y₁),…,(xₙ,yₙ),(x,y)` are exchangeable, then
> `Pr( y_true ∈ Cα(x) ) ≥ 1 − α` (and `≤ 1 − α + 1/(n+1)`). Finite-sample, distribution-free,
> and **assuming nothing about whether the score vector is calibrated**. This is a coverage guarantee
> for the set, not a direct expected-loss guarantee and not a conditional guarantee over only the
> singleton cases.

The gate **commits iff `|Cα(x)| = 1`**, else **abstains** (a non-singleton set is the principled
"ambiguous" signal over three-plus variants, where a scalar threshold has none). The operating
cutoff `1 − q̂` is *derived* to achieve `α`; nobody sets it. **Cold start:** below the rule's
`readiness` minimum of labelled cases the quantile is uncertified, so the gate abstains/defers to a
principal (§13); those rulings are the first labels — the supervised→autonomous bootstrap.

**(B) The margin — a stability property, and the clarification of `δ` vs `m`.** The margin `g`
governs a *different* property from coverage: run-to-run **stability**. By the oracle model (O,
§15.5.5) two fixed-`𝒫` draws flip only if they straddle the boundary, `Pr(flip) ≤ β(g)` with `β`
nonincreasing and `β(g) → 0` as `g` grows.

> **`δ` and `m` are the same quantity `g`, checked at two sites.** `δ` is the threshold rule's
> requirement `g ≥ δ` at *decision time* (a parameter of `by confidence θ margin δ`); `m` (the
> consequential floor on the rule) is the requirement `g ≥ m` at the *consequential sink*, applied
> to *any* committed decision before it acts. They are not two margins; one quantity, two
> checkpoints. For a threshold gate with `δ ≥ m`, `m` is redundant; the conformal basis has no `δ`,
> so `m` is the only place to add a stability floor on top of coverage — a conformal singleton can
> satisfy coverage yet sit on a knife-edge `g` (flipping at `temperature > 0`), and `m` is the
> optional cure.

**Two orthogonal properties, then.** `α` bounds *set coverage* under the exchangeability
assumption; `g` (as `δ` or `m`) bounds *how often two runs disagree* (stability, basis B /
§15.5.5). `α` is **not** a margin. The threshold basis is explicit and cheap but only becomes
decision-theoretic when backed by a calibrated profile and a loss model; the conformal basis gives
coverage via `α` and takes stability from `m`. Calibration-readiness, exchangeability, and the
oracle bound are hypotheses about the runtime/profile and provider, not consequences of the
operational semantics.

## 15.6 Soundness statements

For well-typed `P`: **(T1) Authority safety** — an agent `perform`s and `reach`es
only what its `grants` (powers) name; grants are subtractive under `extend`; no runtime value
extends them. **(T2) Decision and endorsement** — the only operation that settles a `graded`
judgment is `decide`, which yields a ledgered `Decision` whose `.committed` is a singleton variant
or `abstained`; the only operation that settles a subject value is `endorse subject by d`, yielding
an `Endorsement` that records the exact subject and decision id, and only when `d` has been
committed-narrowed. **(T3) Consequential non-interference** —
no value carrying un-endorsed cognition reaches a consequential sink (a `perform` argument —
the only outbound path, §6b — so on the perform path no un-endorsed cognition leaves the
process, observation requests included),
and an `Endorsement` can only be constructed from a committed-narrowed
`Decision` (so an `abstained` decision cannot reach a sink), with the runtime margin floor
`margin ≥ m` checked there; equivalently, varying the model's raw judgments
changes no world-effect except through a gate (Lemma 1, §15.5). **(T4) Reproducibility up to
`≈`** — state is a function of the ledger plus recorded oracle results; a recorded run replays
to chain-head equality unconditionally; inter-agent message content is derived, not stored.
**(T5) Pure seam safety** — no `pure` function reaches a declared dependency. Technique for
T1/T2/T5: progress+preservation. T3 is Lemma 1 (two-run bisimulation, §15.7); T4 is the
Stability theorem (§15.5.5), modulo O/NI of §15.7.

## 15.7 Mechanization and open obligations

The Stability proof rests on two assumptions discharged by machine-checked proof. The
intended mechanization (Lean 4 + Mathlib):

1. **Model Agape-core** — an idealized calculus: values, the trust lattice
  `settled⊑graded⊑raw`, `decide`, `endorse`, `commit`, and `obs`. The theorem is
   proved of the core; the implementation is argued to refine it.
2. **(NI) Non-interference (Lemma 1)** — the deterministic part. Define low-equivalence
  `≈_L` (agreement on `settled` data, `Decided` events, and `Endorsed` subjects); prove stepping preserves it by
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
compiler-scale work. The probabilistic part assumes the relevant empirical profile property:
calibrated probabilities for expected-loss threshold gates, exchangeability/coverage for
conformal gates, and the oracle stability bound for replay. It does not prove the model is
trustworthy; it isolates exactly which empirical properties the guarantees rest on.

Further obligations: the identity-dependency authentication contract; the reliable/ordered
channel surface; the optional distributed-ledger and Multi-verse layers; and interprocedural
authority for top-level (non-agent) functions.

---

## 16. The runtime

§0–§15 define what an Agape program *means*; this section defines what an implementation *does* to
execute it — the concrete contract a conformant runtime is built against, making the abstract
operational semantics of §15.4 buildable. Where §16 and §15 appear to differ, §15 governs the
meaning and §16 the mechanism; a conformant runtime satisfies both. Design points not fixed by §0–§15 are settled here by explicit, conformance-visible choices.

The runtime is the implementation of the trusted kernel, not a host framework around it.
Schedulers, storage engines, cloud services, OS hooks, and endpoint transports may vary, but they
must expose the same kernel boundary: no external dependency is reached except through a
declared seam, no consequential sink runs except through grants plus endorsement, and no
future-relevant state escapes the ledger/replay contract.

**One runtime, one system.** An Agape runtime is the sole authority for one running Agape
system: it owns the append-only ledger, the agent population and lifecycle, the provider,
identity, and prompt dependencies, the wired world seam (§6b), and each agent instance's private memory substrate. A
runtime shares **no mutable state** with another runtime — separate runtimes are *separate* runtimes
unless explicitly connected through an external protocol, and when two runtimes communicate their
messages are ordinary ledgered events at each boundary (§6). The runtime is not "global agent
memory": the runtime has a *ledger* (objective, shared, §16.2); agents have *private memory*
(subjective, per-instance, §16.7). The obligations below (§16.1–§16.9) are the cross-runtime contract
every conformant implementation satisfies; a release reports its conformance against them (§17.6).

### 16.1 Execution model and the scheduler

The runtime is a **discrete-event simulator** over a single growing ledger (§0.2, §15.4.1). Its state
is the configuration `⟨Π|Ψ|Ω|Â|μ|S|k⟩` of §15.4.1 plus a **reaction queue** `Q` of pending work.
Logical time is the **tick**: every appended event is assigned `tick = |S|` at append — system-
assigned, monotonic, gap-free (§7).

- **Top-level evaluation.** The program's top-level statements run in source order (§0.2). A statement
  executes to a value or to a ledger append; an append fires any matching subscriptions (§16.3) before
  the next statement begins.
- **Asynchrony.** Reaching a declared seam (a send `<-`, a wired `perform`/`emit`, a principal-prefixed `p decide c by r`) does not
  block: the runtime appends the operation's opening event(s) (`Sent`, `ToolStarted`, …), issues the
  oracle call (§16.4), and enqueues a **resolution** on `Q`. The continuation after the call resumes
  when that resolution is dispatched. Many operations may be in flight at once (a query's fan-out over
  a collection, §12, issues all its calls before any resolves).
- **The scheduler loop.** While `Q` is non-empty or the top level is unfinished: take the next ready
  resolution, apply its effect (append the closing event(s) — `Resolved`, `ToolResolved`, a bound
  `Credence` — and resume its continuation), then drain any subscriptions the appends fired.
  **Resolution order:** ready resolutions are dispatched in **issue order** — FIFO by the tick
  of their opening event. This fixes one total order on observable effects independent of wall-clock
  timing, so replay (§16.5) is well-defined.
- **Quiescence and termination.** The program **terminates** when the top level is exhausted, `Q` is
  empty, and no external source is open (`prompt`/standing sensor, §5b/§6b). An open source keeps the
  program live: each external arrival enqueues a reaction and the loop continues (§0.2). Every reaction
  terminates (the language has no unbounded loop, §0.2, §11), so an always-on program is an unbounded
  sequence of terminating reactions over one ledger.
- **Determinism.** Concurrency and determinism are independent (§0.2): the scheduler serializes
  observable effects by the issue-order rule, and there is no shared mutable state (each agent owns its
  memory, §10), so given the journaled oracle results the ledger is reproduced exactly (§16.5).

### 16.1a Runtime identity and isolation

Each runtime has a stable **runtime id** and a **runtime kind** — e.g. `rust-local` (a CLI /
toolchain runtime) or a hosted runtime. The kind names the deployment, not a different language: every
kind satisfies the same §16 contract.

Each agent **instance** has a stable runtime-local id. Two instances of the same agent template
(§5) are *distinct cognitive entities* with *distinct private-memory namespaces* (§16.7) — same
code, different memory, no shared subjective state. A recommended identity tuple:

```text
runtime_id        // which runtime authority
agent_template    // the agent declaration (§5)
agent_instance_id // this spawned instance
agent_generation  // bumped when an instance is collected and respawned fresh
ledger_head       // the ledger prefix the view is derived from (§7)
```

`agent_generation` advances only when a slept agent with no live references is collected and a
later `spawn` creates a *fresh* entity (§5); `sleep` / `awake` / a contained crash do **not** erase
memory or advance the generation, because an agent's state is a function of the ledger and its
private memory, not fragile in-flight state (§5, §16.6).

### 16.2 The ledger journal — serialization, hashing, ticks

The ledger is an append-only, hash-chained log (§7, §15.4.2a). A conformant runtime fixes three things
a replay (§16.5) and an audit depend on:

- **Event record.** Each event is `{ tick, etype, subject, payload, corr, agent }` (§7): `tick` the
  append index; `etype` the prelude or user event-type name (§9); `subject` the source / correlation
  key (§7); `payload` the typed value carried (or empty); `corr` the id linking an opening event to its
  close (or the event's own id); `agent` the acting agent's address.
- **Canonical serialization.** An event serializes to bytes as **canonical JSON**: object keys
  in the fixed order above, no insignificant whitespace, UTF-8 strings, numbers in shortest
  round-tripping form, the payload encoded by its structured-output schema (§8). Canonical means
  byte-identical for equal events — which is what makes the chain-head a function of content alone.
- **Hash chain.** Genesis `h₀ = SHA-256("agape/v1")`; thereafter `hᵢ = SHA-256(hᵢ₋₁ ‖
  serialize(eventᵢ))`. The **chain-head** is `h_{|S|−1}`: SHA-256 over the canonical serialization of
  every field, so nothing observable sits outside the commitment.
- **Stored vs hashed fields.** A runtime **may persist additional, non-canonical fields** beside the
  hashed record — most commonly a wall-clock `ts`, and the materialized `prev_hash` / `hash` of the
  chain above. Only the six canonical fields are hashed; the wall-clock `ts` is **never** part of the
  serialization, so wall-clock time cannot affect the chain-head and replay (§16.5) reproduces it
  exactly. (A behavior that genuinely depends on wall time — a `wall-clock expires` lifetime, §6 — is
  captured not by `ts` but by a *journaled* event whose firing is recorded, §16.5.) Which fields are
  hashed, the hash algorithm, the canonical serialization, and any redaction rules are fixed per
  runtime version and advertised by runtime metadata (§17.6).
- **Chain-head equality (T4).** Two runs are replay-equivalent iff their chain-heads are equal (§15.4.2,
  §16.5) — the operational form of observational equivalence `≈` (§15.5.2) for a recorded run: identical
  journals ⇒ identical ledger ⇒ identical head.

### 16.3 Subscription dispatch and the tick cascade

Subscriptions (`when`, §7) are **hoisted**: on entering a scope (the program top level, an agent body, a
handler block) the runtime registers every `when` in that scope, in lexical order, *before* the scope's
statements run, and deregisters them on scope exit. The live set is ordered by registration (the **hoist
order**).

- **Matching.** `matches(sub, ev) ⟺ subtype(ev.etype, sub.etype) ∧ (sub.subj = ⊥ ∨ sub.subj = ev.subj)`
  (§9, §15.4.2), further filtered by a `when … if (guard)` predicate (§7).
- **Synchronous within-tick cascade.** When an event is appended, the runtime fires every matching
  live subscription **immediately**, in registration order, before the appending statement's successor
  runs (§0.2). A handler body that itself appends events triggers *their* matching subscriptions the same
  way — **depth-first**, recursively, until no new matches remain. This realises §0.2's "appending an event
  synchronously fires any matching subscription before evaluation continues."
- **Ticks within a cascade.** Each append takes the next tick (`|S|`, §16.2). The several subscriptions
  matching one appended event are triggered *by* that event (logically one instant), but each body's own
  appends take subsequent ticks, in the depth-first registration order above — so the ledger's total order
  is exactly the append order, and is deterministic.
- **Prospective.** A subscription never fires for an event whose tick precedes its registration (§7);
  history is reached only by query (§10).

### 16.3a Task-send dispatch (§6c)

A task-send routes like any send; what changes is who resolves it and what lands on the ledger.

- **Assignment.** Delivery of a task-send fires the worker's `on assigned` hook — compiled to a
  `Delivered` subscription filtered to task-sends — instead of a provider invocation. While that
  handler (and any handler resolving the same task) runs, the worker's provider calls compose the
  active task's `objective`/`acceptance` into context **after** the instruction blocks, as data
  (§5, §6c). The runtime tracks the agent's *active task* (its correlation id) for the duration.
- **Aliases.** `when (TaskSubmitted|TaskAssigned|TaskExpired about h)` are compile-time rewrites
  to the corresponding `Sent`/`Delivered`/`Expired` subscriptions filtered by the handle's
  correlation — they are not distinct rows (§6c), so the journal (§16.2) is unchanged by them.
- **Terminals and refusal.** The first terminal for a correlation wins (`TaskCompleted` via
  `complete` — which also appends the transport `Resolved` — or `TaskFailed`, `TaskCancelled`,
  `Expired`). A late `complete`/`fail` after a tombstone appends `CompletionRefused(corr)`; the
  payload is discarded (§15.4.2).
- **Foreground fault.** A result-bound delegation whose terminal is not `TaskCompleted` faults
  the delegator's awaiting invocation through the crash path (§16.6).
- **Status projection.** "One status per task" is a ledger projection — a `select … from ledger`
  fold over the correlation — maintained like any projection (§16.7a), never a stored event.

### 16.4 The seam protocol — provider, identity, world

The three external seams are reached as oracles (§15.4.2): cognition through the **provider**,
accountability through the **identity** dependency, the world through the **wiring seam** (§6b). Each call
appends its opening event, invokes the seam, journals the result (§16.5), and appends its close.

- **Provider (`think`).** A judgment `Credence<E> c = d <- p` or a typed reply `T x = d <- p`
  renders the prompt `p` and compiles the destination schema: for a `Credence<E>` slot, the forced
  categorical choice over `E`'s variants; for a typed reply, `T`'s JSON Schema (§8). The connector
  receives the rendered prompt only after the runtime applies the manifest's provider-prompt
  ingress policy to the prompt's ingress provenance: `warn` records an audit diagnostic for
  `external_unscreened` ingress, `deny` aborts before invoking the provider, and `off` accepts
  silently (§17). This policy has no effect on `perform` sink admission.
  The connector
  receives `{ prompt, schema }` and must return schema-conforming output by constrained decoding
  (mandatory; no fuzzy fallback). A logprob-exposing connector returns the committed value plus the
  per-variant score/logprob vector; a text-only connector returns only the value and is served by the
  sampling fallback (§16.8). The result is journaled as the send's `Resolved` (with the raw response and
  per-variant scores, §15.5.1, for replay and calibration). A schema-violating return is a `TypeMismatch`
  (§16.6).
- **Identity (`principal_decide`).** A principal-prefixed `p decide c by r` runs the rule first; when
  it cannot commit, it presents `(p, c)` to the identity dependency, which returns the principal's
  signed verdict (a variant of `E`). The backend (e.g. `local-keyring`, §17)
  signs a canonical serialization of `(who = p, credence = ledger-id(c), decision)`; the runtime
  records `PrincipalDecision { who, credence, decision, signature }` (§9). A declined ruling
  records a `FailedPrincipalDecision` (§13). In both cases, and also when the rule commits without
  escalation, the resulting `Decision` is recorded as `Decided`. No key material appears in source
  (§3).
- **World (`invoke`, MCP).** A wired `perform A(args)` — or a wired `emit` — resolves its
  `[actions.NAME]`/`[events.NAME]` wiring to its `[tools.*]` catalog entry (§17.1), issues an
  MCP `tools/call` with the marshalled args, appends the `ToolStarted`/`ToolResolved` pair (the
  replay journal, §6b, §7), and lands the configured `result_event` row when one is wired (§6b).
  Args and results marshal between Agape values and MCP JSON by the action's/event's declared
  fields and the result event's declared fields. A result-event payload carries judgment trust
  joined with the request payload's trust; a `perform`'s arguments must be settled (§6b, §13).
  Separately, result-event and standing-sensor payloads carry ingress provenance
  `external_unscreened` unless the manifest-configured screen for that ingress accepts and records
  `external_screened`. A standing sensor (`[events.NAME]` with no triggering emit) appends its
  events as they arrive, like `prompt` (§5b, §6b).

- **Ingress screening.** Prompt arrivals, standing-sensor events, and result-event payloads may be
  bound in the manifest to an ingress screen (§17). The screen is not source syntax and is not a
  way to grant action authority. The runtime records the original boundary payload, screen identity,
  verdict, normalized delivered payload, and resulting ingress provenance. Accepted values are
  delivered as `external_screened`; unscreened accepted values remain `external_unscreened`;
  rejected values do not enter ordinary program data.

### 16.5 Record and replay

A run is a **recording**: every oracle result (§16.4) is journaled to the ledger as the operation's
closing event, carrying the result payload — and, for the provider, the per-variant scores (§15.5.1).
Nondeterministic *inputs* are journaled too: external `prompt` arrivals, standing-sensor arrivals,
world result-event payloads, ingress provenance labels, screening verdicts/normalizations, and a
wall-clock `expires` lifetime's firing (§6); a logical-tick lifetime is already deterministic.

- **Replay.** Given a recording, the runtime re-executes the program but **serves each oracle call
  from the journal instead of invoking the seam**: the *i*-th call of a given kind, in issue order
  (§16.1), is answered by the *i*-th recorded result of that kind. Replay invokes nothing external — a
  wired effector is replayed as its recorded result, never re-run against the world. Ingress screens
  are likewise not re-run during recorded replay; their recorded verdict and delivered payload are
  served from the journal.
- **What must be reproducible.** Replay never re-calls cognition completions, identity decisions, or
  wired endpoints (above), and it likewise never re-calls the **memory-internalization oracles** — decomposition,
  summarization, and embedding (§16.7). Each such call is either journaled (a non-deterministic provider
  result is recorded like any oracle output) or **deterministically derived from recorded inputs by a
  versioned algorithm** whose version is part of runtime metadata (§17.6). Either way memory is a
  projection of ledgered events plus recorded oracle results: a faithful runtime can rebuild every
  agent's private memory from the ledger, or verify materialized memory against its ledger provenance
  (§16.7).
- **Chain-head equality (T4).** A faithful replay regenerates an identical ledger and therefore an
  identical chain-head (§16.2); chain-head equality *is* the proof of replay-equivalence (§15.4.2), the
  operational form of `≈` (§15.5.2). The conformance test-mode asserts it (§17.5).
- **Counterfactual replay.** Any prefix may be replayed under altered recorded facts to test a
  counterfactual; fork/merge of divergent continuations is the optional Multi-verse layer (§15.4.2a),
  outside the core.

### 16.6 Fault and recovery

- **The reaction boundary.** A *handler invocation* — the unit a fault is contained to — is one
  top-level statement, or one `when`/`on`-hook body firing (each cascaded firing, §16.3, is its own
  invocation). A fault abandons that invocation only.
- **Crash.** An unrecoverable seam failure (the provider returns nothing, a connector error) or an
  uncaught error within an invocation **crashes** the agent: the invocation is abandoned, `AgentCrashed`
  is appended, the `on crash` hook runs in the agent's own context, and the agent continues with its
  fields and memory intact — they are a function of the ledger, not fragile in-flight state (§5). Unlike
  `sleep`, the mailbox stays open. A crash loop is a policy concern for an ordinary `when (AgentCrashed …)`
  subscription (§5), not a built-in.
- **TypeMismatch.** A schema-violating provider return is a typed `TypeMismatch` (§8) — catchable and
  handleable, not in itself a crash.
- **MarginFloorViolation.** When a consequential sink receives an endorsed value whose `.margin` is
  below the gate's rule `floor m` (§13), the runtime appends a typed `MarginFloorViolation` and
  faults the invocation (the action does not run). Like `TypeMismatch` it is a catchable `Error`
  (§9): `when (Error e)` / `on crash` may handle it — it is the typed trigger for escalation, not a
  silent skip.
- **TaskScopeViolation.** When a `perform` executes while the agent is running an assigned task and
  the active task is not endorsed or does not name the action in its `scope` (§6c, §13), the runtime
  appends a typed `TaskScopeViolation` and faults the invocation (the action does not run) — the
  same shape and handling as the margin floor.
- **Foreground task failure.** A result-bound delegation whose terminal is `TaskFailed`, `Expired`,
  or `TaskCancelled` faults the delegator's awaiting invocation through the crash path above
  (`AgentCrashed`; `on crash` recovers with state intact). The failure reason is the correlated
  `TaskFailed(reason)` row, reached by query — a task that comes back empty is the same fault shape
  as a provider that returns nothing (§5, §6c).

### 16.7 The memory runtime

Each agent instance owns one private memory unit. The runtime presents substrate-independent
logical views over that unit: exact facts, relationship hints, semantic/chunk recall, and the
canonical stored cells. A substrate may physically be markdown, a relational store, a graph store, a
vector store, or a combination. Derived indexes are materialized views over the canonical cells: they
may be rebuilt, budget-limited, or absent in a vanilla runtime, but their absence cannot change
isolation, taint, ledger receipts, or authority. No store is shared - there is no cross-agent mutable
state (Section 0.2).

- **Per-agent isolation.** Memory is namespaced per *instance*, not per *template*: no agent may read
  or mutate another agent's memory except through an explicit, ledgered Agape interaction (a send, §6).
  If an implementation physically deduplicates storage across instances, the *semantic* projection is
  still per-agent — **shared physical storage cannot create shared subjective memory.**
- **The memory cell.** Each stored cell is the storage realization of the §7 `Fact<T>` projection
  record, carrying the same staleness metadata plus its physical coordinates:

  ```text
  agent_instance_id    // the owning instance (§16.1a) — the isolation key
  view                 // canonical | facts | relationships | semantics
  key_or_subject       // the cell id / fact key / node / item
  value_or_edge        // the stored value, extracted fact, SPO edge, or semantic chunk
  origin_tick          // backpointer to the producing ledger event (§7, §10)
  taint                // graded | raw — recall is always tainted (§10, §13)
  basis_head           // the ledger prefix the value was derived from (§7)
  valid_through        // the head through which it is known current
  dependency_scope     // the event/state keys whose change can stale it (§7, §16.7a)
  created_at           // wall-clock, non-canonical (never hashed, §16.2)
  ```

- **Memory envelope (mandatory trigger).** Each agent reaction runs the **memory envelope** below
  in full. The runtime may tune limits, ranking, summarization, and embedding backends, and a
  cost-constrained run may record a *budget-limited* packet — but it does **not** omit the consult
  (step 4), its recorded trace (step 5), or the internalization (step 9) to save cost, and a limited
  packet says it was limited. Configuration controls budget and fidelity, not whether memory is part
  of the turn.

  ```text
  1. Receive the stimulus.
  2. Append (or identify) the ledger event representing that stimulus.
  3. Build a memory query from the stimulus, current task, agent role, and ledger head.
  4. Consult the instance's canonical cells and any available fact, relationship, or semantic indexes.
  5. Append MemoryConsulted with counts, query metadata, and result provenance (§9).
  6. Build the cognition/action context from source instruction (§5), project context,
     and the memory packet.
  7. Execute the reaction.
  8. Append the resulting ledger events.
  9. Internalize the experience into the same instance's private memory.
  ```

  The **memory packet** supplied to cognition includes, within budget: whole-artifact summaries
  relevant to the task (§16.7b); precise chunk or semantic hits with their origin ticks; relationship
  hints for entities in the task; prior lessons, failures, and working patterns (§16.7c);
  recent related run/check/test outcomes; and, when applicable, the explicit fact that memory was
  empty. **An empty lookup is a meaningful recorded result, not an omitted step** — step 5 records
  that memory was consulted and returned no applicable context.

  Internalization (step 9) records the canonical cell and may decompose it into typed facts,
  relationship hints, semantic chunks, embeddings, or substrate-native records. Any provider-assisted
  decomposition is non-deterministic but shape-fixed (Section 10), and journaled (or deterministically
  derived, Section 16.5), so replay reproduces it without re-invoking the provider. **Memory cannot launder
  trust:** a recalled value is subjective and stays tainted (§10, §13); it must be re-gated before a
  consequential sink. And **memory cannot rewrite behavior:** instructions, grants, and dependency
  bindings are source/config artifacts (§5, §13, §17) — memory may *guide* a turn but never silently
  override them.

  When a received typed reply is internalized, the payload's memory content is written as an agent
  recollection of the turn: who or what prompted it, what the agent did, what the provider returned,
  and what was learned or found wanting. The event itself is the episode, so payloads do not need an
  episode discriminator such as `kind: "episode"` and should not split the recollection into an
  `experienced` field. Machine-readable backpointers such as `source_event` may accompany the memory
  content for audit and replay.
- **Provenance.** Every memory cell carries an immutable backpointer to the ledger event that produced it;
  `origin(n)` projects it (§10). A recalled value stays tainted regardless of its origin (§10); the
  recorded-trust reading of the same origin is the ledger query.
- **Recall and query execution.** Recall (`m -> q`, §10) is a cognition-mediated retrieval fused across
  the region's fact, graph, and vector views, always tainted. The **ledger query**
  `select Event as e from ledger where { e.field ... }` or `select COLS from ledger where { COND }`
  is a relational scan with a boolean field filter over the objective log; it carries recorded trust
  (an `Endorsed` subject reads back `settled`). A typed event query yields `LedgerEntry<Event>[]`;
  a projected `select COLS ...` yields `Record[]`; `select * from ledger ...` yields the full events.

### 16.7a Projection maintenance and conflicts

The runtime may keep materialized projections of the ledger: agent lifecycle tables, memory facts,
graph indexes, active GateProfiles, file/project views, or domain facts. Each projection reducer
declares or traces:

- a **write-set** for each event it consumes — the state keys the event changes;
- a **read/dependency set** for each materialized fact/view — the state keys whose later changes
  can make the value stale;
- a **global scope** marker for projections whose dependency set cannot be made precise.

The implementation keeps an inverse index (`state key -> materialized facts/views`). On append it
looks up only the keys written by the event and recomputes or stales the intersecting facts. This
is an implementation strategy, but the soundness condition is semantic: a cached value may be used
as current only if every event since its `basisHead` has been checked against its dependency scope
(`validThrough` equals the current head) or the value was recomputed at the current head.

A **Conflict** is a projection object, not an exhaustive language enum:

```
Conflict = {
  subject,
  invariant,
  facts,
  detectedAt,
  status   // open | resolved | ignored
}
```

It means that two or more active, settled facts cannot all hold under a declared invariant.
Examples include a single-valued field receiving two active values, overlapping exclusive leases,
two verdicts from a mutually-exclusive enum for the same claim, or a domain-specific invariant.
Agape does not attempt to infer arbitrary natural-language contradiction in the kernel.
Natural-language conflict is built *in Agape* by extracting atomic typed claims, endorsing them as
facts, and checking declared invariants over those facts; it is not built *into* Agape as ambient
semantics.

### 16.7b Knowledge-artifact internalization

A **knowledge artifact** is any durable input an agent is allowed or instructed to learn from: this
spec or any project file, a README or design doc, generated code, check/test/run output, a user
correction or review, a result-event payload, a prior ledger slice, or a hosted/uploaded file. Internalizing
an artifact is the same memory operation as §16.7 step 9, applied to a durable source rather than to
the immediate experience.

- **It is an agent capability, not an ambient sweep.** An agent internalizes an artifact only when
  source, configuration, a user instruction, or host-initialization policy *explicitly selects* that
  artifact as part of the agent's knowledge. The runtime provides the operation and preserves
  provenance; it does **not** decide that every file it can see is learned by default. (This is the
  §16.7 isolation discipline applied to inputs: knowledge is agent-owned, with provenance.)
- **Both whole and parts are preserved.** Chunks alone can lose an artifact's larger purpose, so
  ingestion keeps a whole-artifact summary *and* precise chunks:

  ```text
  1. Append ArtifactObserved(kind, uri, source_hash, title) (§9).
  2. Summarize the whole artifact for future orientation.
  3. Chunk it with stable chunk hashes (by headings, the default for Markdown / sectioned source).
  4. Decompose new chunks into facts and SPO triples.
  5. Embed new chunks.
  6. Store summary, facts, triples, and embeddings in the agent's private memory (§16.7).
  7. Record provenance from each cell to its ledger event and the artifact hash.
  ```

- **Idempotent on unchanged input.** Source hash and chunk hashes prevent duplicate memory cells:
  re-ingesting an unchanged artifact is a no-op. When an artifact changes, new chunks are added and
  old chunks remain historical unless a tombstone/retraction event marks them superseded (§10
  `forget`, §7 staleness).
- **File upload is not special.** A file saved in the project folder and read by an agent is
  internalized through this same mechanism — there is no separate upload path.

### 16.7c Learning from experience

Beyond explicit artifacts, every agent-internal experience that can improve future behavior is
recorded and internalized through the §16.7 envelope: code written, tests written or selected,
`agape check` results, `agape run` results and their ledger events, unit/integration/conformance
pass/fail, provider failures, wired-endpoint failures, user feedback and corrections, and accepted working
patterns.

For implementation work, an agent follows the loop:

```text
consult memory -> write/identify tests -> implement -> run checks/tests ->
internalize pass/fail -> retry or report
```

Failure memories are distilled into reusable **lessons**; success memories are stored as working
**patterns**. When retrieval conflicts, **user correction outranks an inferred lesson** — explicit
human feedback is higher-authority memory than a pattern the agent inferred on its own. None of this
is new kernel authority: a lesson is an ordinary tainted memory fact (§10), so acting on it still
requires re-gating at the sink (§13). (`agape check` / `run` are the toolchain commands of §17; the
events they emit are ordinary ledger events.)

### 16.8 The calibration pipeline

A `Credence<E>` is a scored structured judgment over the forced categorical choice of `E`'s variants
— not a verbalized self-rating and not, by itself, a calibrated probability (§3).

- **From logprobs.** A logprob-exposing connector (`exposes_logprobs`, §17) yields per-variant scores;
  the runtime normalizes them over `E`'s variants to the `Credence` score distribution and journals the
  raw vector plus connector provenance.
- **Sampling fallback.** A text-only connector is served by drawing the forced choice `fallback_samples`
  times (min 10, at `fallback_temperature`) and taking the empirical frequency as the score distribution
  (§17). This is an estimator of model behavior, not a calibrated correctness probability.
- **Calibrated profile.** A fitted calibrator (temperature / Platt / isotonic / multiclass vector
  calibration, depending on the connector and label space) maps raw score vectors to probability vectors.
  It is fit from the ledger's recorded `(judgment, outcome)` pairs for a compatible gate profile (§13).
  Only a gate with an active compatible profile may treat the calibrated vector as a probability for
  expected-loss decisions.
- **Conformal profile.** A conformal gate scores each variant's nonconformity and forms the prediction set
  `{ v : nonconformity(v) ≤ q̂ }`, with `q̂` the level-`α` quantile of compatible recorded
  decisions-and-labels on the ledger; below the readiness floor it abstains — the supervised cold start
  (§13). Conformal coverage does not require the `Credence` scores to be calibrated probabilities.
- **Invalidation.** Gate profiles are active only for the provider/model, schema, prompt template,
  rule, score function, calibration pool, and drift status recorded at activation. A mismatch stales the
  profile for future decisions and forces abstain/fallback until a new profile is activated; replay of old
  decisions remains stable because each gate event records the profile it used.

### 16.9 The runtime API surface

Any *interactive* runtime — a CLI server or a hosted runtime — exposes the following
operations, or an equivalent transport-level surface. The transport may be HTTP, MCP, stdio,
WebSocket, or another protocol; the **semantic contract is independent of transport**. A
non-interactive embedding (a library linking the runtime directly) need not expose them as a network
API but must offer the same operations as calls.

| operation          | required behavior                                                         |
| ------------------ | ------------------------------------------------------------------------ |
| `health`           | runtime id/kind, impl version, language-spec version, ledger head, provider status (§17.6) |
| `run`              | execute source or the project entry; return the appended events and the new head |
| `check`            | run the static checks (§15.3) and return structured diagnostics          |
| `ledger.read`      | query event ranges and subjects over the ledger (§7, §10)                |
| `agent.respond`    | run one agent turn through the memory envelope (§16.7)                    |
| `memory.ingest`    | internalize an artifact into one agent's private memory (§16.7b)         |
| `memory.context`   | return the memory packet for a task *without* running cognition (§16.7)   |
| `memory.inspect`   | inspect counts, summaries, recent cells, and provenance (§16.7)          |
| `config.read/write`| manage the **dependency/connector** bindings and memory budgets (provider, the `[tools.*]` catalog and its wiring, identity; §17) — **never** decision rules, which live in source (§13, §17.2) |

`config.read/write` is deliberately scoped to dependency and connector configuration plus memory
budgets; it cannot set a gate threshold, margin, floor, or conformal α, because those are source rule
clauses (§13), not manifest knobs (§17.2). All operations act through the same kernel
boundary — `run`/`agent.respond` cannot bypass grants, endorsement, or the ledger; `memory.*` cannot
launder trust (§16.7).

---

## 17. Configuration & the project manager

Every Agape project is governed by the project manager — the `agape` toolchain. A project
is a directory with an `agape.toml` manifest; configuration is baked into the project, not
passed ad hoc. The manifest binds declared dependencies and connector/runtime transport; decision
rules live in source and empirical gate profiles live on the ledger.

Configuration is Agape's ecosystem integration surface. Source declares *what* it depends on
(`provider`, `principal`, `prompt`) and which events and actions exist (§3, §6b); configuration
binds those names to existing model
APIs, identity systems, prompt sources, memory policy, and deployment
endpoints — and wires events and actions to the MCP/tool endpoint catalog (§6b). A feature that
needs provider-specific credentials, URLs, transports, or model names
belongs in configuration, not in `.ag` source.

### 17.1 The manifest

The manifest is the normative deployment configuration. Its canonical portable serialization is
TOML in a project-root `agape.toml`. A host UI, build system, or service manager may generate the
same manifest data model from another source, but conformance fixtures and portable projects use
the TOML shape below.

The manifest is an integration contract, not a second programming language. Source declares *what*
exists:

```agape
prompt text question;
principal reviewer;
event  SearchResult(text hits);
action Search(text q);
action CreateTicket(text body);
```

The manifest binds the dependency names to concrete backends, catalogs the world endpoints,
and wires the declared events and actions to them (§6b):

```toml
[project]
name = "fact-checker"
entry = "main.ag"
version = "0.1.0"
spec = "1.0.0-alpha.2026.7.11.2"

[provider]
backend = "openai"
model = "gpt-4o-mini"
temperature = 0
sampling_fallback = true
fallback_samples = 10
fallback_temperature = 0.7

[security]
tainted_ingress_to_provider = "warn"  # warn | deny | off; default is warn when omitted

[security.ingress.prompts.question]
driver = "builtin"
policy = "prompt_input_baseline"

[security.ingress.events.SearchResult]
driver = "builtin"
policy = "web_result_baseline"

[prompts.question]
driver = "studio"

[identity.reviewer]
driver = "studio_local"

[tools.web_search]
driver = "web_search"
provider = "tavily"
api_key_env = "TAVILY_API_KEY"
timeout_ms = 10000

[tools.ticketing]
driver = "http"
url = "https://tickets.internal/create"
method = "POST"
auth_env = "TICKET_API_TOKEN"
timeout_ms = 10000

[actions.Search]
tool         = "web_search"
result_event = "SearchResult"

[actions.CreateTicket]
tool = "ticketing"

[memory]
facts_driver = "sqlite"
graph_driver = "sqlite"
vector_driver = "sqlite-vec"
blob_store = "archive"
indexing = "incremental"
background_reindex = true
forget_policy = "cascade"
archive_retention = "forever"
max_internalize_chars = 12000
```

Required stable tables:

| table | purpose | required when |
| --- | --- | --- |
| `[project]` | project metadata and entrypoint | portable project |
| `[provider]` | cognition backend for every `<-` to an agent | program reaches cognition |
| `[prompts.NAME]` | external input source for `prompt T NAME;` | source declares that prompt |
| `[identity.NAME]` | principal backend for `principal NAME;` | source declares that principal |
| `[tools.NAME]` | the endpoint catalog — a driver/transport for a world endpoint (§6b) | a wiring references it |
| `[actions.NAME]` | wires a declared action's `perform` to a catalog endpoint (`tool = …`), with an optional `result_event` | the deployment wires that action |
| `[events.NAME]` | wires a declared event as a standing sensor (`tool = …`) or an emit-trigger (`tool = …` + `result_event`) | the deployment wires that event |
| `[security]` | ingress-to-cognition policy (`tainted_ingress_to_provider = "warn"|"deny"|"off"`) | optional; default is `warn` |
| `[security.ingress.prompts.NAME]` | manifest-level ingress screening for a prompt source | optional; that prompt binding is screened |
| `[security.ingress.events.NAME]` | manifest-level ingress screening for a standing sensor or result-event payload | optional; that event binding is screened |
| `[memory]` | private-memory storage, indexing, and archival policy | runtime has private memory |

Resolution rules:

- The key `NAME` in `[prompts.NAME]` and `[identity.NAME]` is the source
  declaration's dependency name. A declared dependency with no binding is a `ConfigError` before
  execution. A binding for a name not declared in source is ignored or warned by default; strict mode
  may reject it as a `ConfigError`.
- `[tools.NAME]` keys are **catalog names**, not source names: tools are not source-declared
  (§6b), so an unreferenced catalog entry is not an error. An `[actions.NAME]`/`[events.NAME]`
  wiring entry must name a declared `action`/`event` and reference an existing `[tools.*]`
  catalog entry in its `tool` field; its optional `result_event` must name a declared `event`.
  A violation is a `ConfigError` before execution. A foreground-bound `perform` (§6b) whose
  action has no configured `result_event` is a `ConfigError`. An unwired declared action or
  event is pure — never an error (§6b).
- Screening is manifest-only. A `[security.ingress.prompts.NAME]` table screens the inbound
  payload for `prompt NAME`; a `[security.ingress.events.NAME]` table screens the inbound payload
  for a standing sensor `event NAME`, an action `result_event = "NAME"`, or an emit-trigger
  `result_event = "NAME"`. These tables do not create source syntax, do not change declared types,
  and do not grant or deny action authority.
- Source owns type and authority. An action's or event's fields come from the `.ag` declaration,
  never the manifest; the manifest chooses only the endpoint, driver, transport, and wiring. If a
  driver cannot satisfy the wired shape, configuration fails.
- Secrets are references, not values. API keys, signing keys, OAuth tokens, and MCP credentials live
  in the environment, OS keychain, or host secret manager. The manifest may name them with fields
  such as `api_key_env`, `auth_env`, or `secret_ref`; it must not contain secret material.
- Connector-specific extension keys are allowed inside the binding's own table. They are ignored by
  other drivers unless the driver declares them. Portable meaning comes from the stable table name,
  `driver`, and the source declaration.
- TOML table form is canonical. Inline tables are acceptable shorthand only when they are equivalent
  to the table form; conformance tests use table form.

Provider fields:

- `backend` names the provider connector (`mock`, `openai`, `anthropic`, `gemini`, or an
  implementation-defined connector).
- `model`, `temperature`, and connector-specific fields configure the backend, not Agape semantics.
- `exposes_logprobs` is a backend capability, normally derived: `anthropic` is `false`,
  `openai`/`gemini` are `true` for connectors that expose per-token scores. A custom connector may
  declare either value.
- When `exposes_logprobs = false`, a `Credence<E>` judgment uses the sampling fallback if
  `sampling_fallback = true`: the forced categorical judgment is drawn `fallback_samples` times
  (minimum 10) and the distribution is the empirical frequency. Sampling needs variation, so
  `fallback_temperature` is required when the main `temperature = 0`. If fallback is disabled and
  no distribution is available, consequential gates defer/abstain rather than fabricating confidence.

Prompt bindings:

- `driver = "studio"` means Studio/user input supplies `Prompt` arrivals.
- `driver = "stdin"`, `"http"`, `"queue"`, `"webhook"`, `"timer"`, or implementation-defined
  drivers may be used by runtimes that support them.
- The manifest does not restate the prompt type; the source declaration `prompt T NAME;` is
  authoritative. The driver must coerce or reject incoming payloads against `T`.
- Without a matching `[security.ingress.prompts.NAME]` table, delivered prompt values carry ingress
  provenance `external_unscreened`. With a matching table, the runtime records the screen input,
  verdict, output, and resulting provenance; accepted values are delivered as `external_screened`,
  and rejected values are not delivered as ordinary prompt data.

Ingress security:

- `[security].tainted_ingress_to_provider` governs only `external_unscreened` ingress flowing into
  provider/cognition prompts (`<-`). The default is `warn`: a conformant checker/runtime emits an
  audit diagnostic but allows the provider call. `deny` rejects the `(source, manifest)` pair when
  statically visible and aborts before provider invocation if encountered dynamically. `off` accepts
  silently. This is not an action-sink policy.
- There is no manifest option for `tainted_to_action`, `ingress_to_action`, or any other
  allow/warn/deny relaxation at `perform`. Consequential actions remain governed by the fixed
  settled-only judgment-trust rule, grants, margin floor, and task-scope enablement (§13).
- `[security.ingress.prompts.NAME]` and `[security.ingress.events.NAME]` tables configure ingress
  screening backends. Their drivers and policies are implementation-defined, but a conformant
  runtime must make screening replayable by recording the screener identity, input bytes or hash
  plus recoverable payload reference, verdict, normalized output, and resulting ingress provenance.
  Screening is a deployment boundary operation, not `.ag` source syntax.

Identity bindings:

- `driver = "studio_local"` is an interactive local attestation flow.
- `driver = "local_keyring"`, `"oidc"`, `"webauthn"`, `"kms"`, or implementation-defined drivers
  may back production principals.
- A principal decision must return a variant of the gated enum plus an attestation/signature payload
  recorded in `PrincipalDecision` or `FailedPrincipalDecision` (§13, §16.4).

The `[tools.*]` endpoint catalog (referenced by `[actions.*]`/`[events.*]` wiring, §6b):

- `driver = "mcp"` binds a catalog entry to an MCP server tool and issues `tools/call` — the
  flagship driver: the catalog is how a deployment imports the MCP tool ecosystem (§6b).
- `driver = "http"` binds a catalog entry to an HTTP endpoint; args marshal by the wired
  action's/event's declared field names, and a result must validate against the wired
  `result_event`'s declared fields.
- `driver = "web_search"` is a standardized search-connector class; provider-specific
  fields (`provider`, `region`, `max_results`, etc.) live in the same `[tools.NAME]` table.
- `driver = "host"` binds a catalog entry to an in-process function supplied by the embedding runtime.
- `driver = "process"` or `"script"` may spawn a configured local command under the host's sandbox
  policy; args still marshal by declared field names and results validate against the wired
  result event.
- `driver = "skill"` may bind a catalog entry to a host-discovered skill/capability. The skill system is
  outside the core kernel; the Agape contract is still the wired action/event shape, authority,
  journaling, and replay behavior.
- A conformant runtime may support additional drivers, but every invocation is still governed by
  the `perform NAME` grant (on the perform path), typed marshalling, `ToolStarted`/`ToolResolved`
  journaling, optional result screening, and replay from the recorded result (§6b, §16.4, §16.5).

Memory bindings:

- `facts_driver`, `graph_driver`, `vector_driver`, and `blob_store` select private-memory storage
  implementations. They do not change memory trust: recall remains tainted (§10).
- `indexing = "incremental"` and `background_reindex = true` express the default contract:
  `mem <- value` mutates live views incrementally, while compaction/full re-indexing is
  runtime-managed in the background.
- `forget_policy = "cascade"` is the core default for active private memory. If an implementation
  tombstones or deletes per modality, the ledger payload must say exactly which happened (§10).
- `archive_retention = "forever"` means blob refs in ledger payloads are recoverable by hash, though
  the runtime may move old bytes to cold storage.

Decision rules are not in the manifest. A gate's threshold, margin, floor, conformal alpha, and
readiness are written inline in source (`decide c by confidence θ margin δ floor m`, §13). The
manifest binds dependencies, runtime storage/transport, and ingress-boundary security policy; it is
never a hidden decision policy layer.
Swapping a dependency backend changes no source, but it does change the `(source, manifest)` program
being run (§17.3).

### 17.2 Scopes and precedence (lowest → highest)

For **connector, dependency, and ingress-security config** (provider backend/model,
`exposes_logprobs`, the identity bindings, the `[tools.*]` catalog and its wiring,
`[security]`, and `[security.ingress.prompts/events.*]`): 1. spec defaults; 2. global user config (`~/.agape/config.toml`); 3. project
manifest (`agape.toml`) — higher wins. **Decision rules are not on this ladder at all**: a gate's
threshold, margin, and floor are inline on the gate (§13), so a threshold is never a hidden global —
there is nothing in the manifest for a gate to override. Secrets (API keys, signing keys, MCP
credentials) come from the environment or OS keychain, never the manifest.

### 17.3 Configuration and reproducibility

The Stability theorem is stated for a fixed provider, and the committed manifest fixes it.
A run is identified by `(I, manifest, recording)`. Changing the manifest changes the
program's meaning, visible in version control; this includes changing the provider ingress policy
or any ingress-screening binding. Recorded replay uses the recorded screening verdicts and
delivered payloads rather than re-running screens.

### 17.4 Reproducibility in practice — two kinds of uncertainty, three knobs

A model's answer varies for two reasons:

- **Aleatoric** (sampling) — governed by `temperature`; `temperature = 0` is greedy
(near-deterministic); replay eliminates it by re-serving the journal.
- **Epistemic** (genuine ambiguity) — no temperature removes it; a true coin-flip yields a
low-margin judgment. The remedy is the margin floor `m` → escalate to a principal (the `p decide c by r` prefix), or fuse independent judges by `quorum` (§12) to raise the margin.

Three knobs: config (`temperature=0` + pinned model + `m`); gate design (crisp criteria →
high margin → exactly-gated); escalation/quorum (the human path or independent fusion for
the epistemic remainder). All three are explicit, enforced, and checkable.

### 17.5 The conformance harness contract

A conformant implementation ships a test mode the black-box suite drives:

- **Fault injection.** A designated stub provider returns schema-violating output on
demand, so a `TypeMismatch` is triggerable deterministically.
- **Recorded replay.** The runner can capture a run's journal and replay it; "chain-head
equality" is equality of the ledger's terminal hash under the canonical event
serialization.
- **Rule observation.** Decision rules are in the test's own source — the gate's inline rule
(§13), no manifest fixture — and the gate records the applied `Rule` in its
`Decided` event (and, when it escalates, the paired `PrincipalDecision` event), so which rule
governed is observable. A fixture `agape.toml`
sets only **connector/dependency** config for the run (e.g. `exposes_logprobs` to exercise the
sampling fallback, §16.8).
- **Kernel bypass coverage.** Every surface feature introduced above the kernel (the gate, memory
  store/recall, the ledger query, provider fallback, runtime adapters) must have negative tests
  proving it cannot bypass taint, endorsement, grants, the perform-only outbound path, or replay. A feature is
  conformant only if its accepted forms reduce to kernel operations and its rejected forms fail at the
  correct boundary.
- **Memory-envelope coverage.** Because the memory runtime (§16.7) is part of the contract, a
  runtime is memory-conformant only if it passes tests for: (1) mandatory memory consultation on
  every agent turn, *including* the empty-memory case (the `MemoryConsulted` trace, §16.7); (2)
  per-agent memory isolation across multiple instances of the same template (§16.1a); (3)
  artifact ingestion producing summary + chunks + facts + graph + vectors when an artifact is
  internalized (§16.7b); (4) idempotent re-ingestion of an unchanged artifact; (5) check/test/run
  *failure* internalization and (6) *success* internalization (§16.7c); (7) user-correction
  internalization and its retrieval precedence over inferred lessons; (8) memory provenance back to
  ledger origin ticks (§10); (9) replay without re-invoking provider/endpoint/decomposition oracles
  (§16.5); and (10) no memory-to-action trust laundering (§16.7, §13).

### 17.6 Runtime lockstep and release reporting

Because the language and its runtime are one contract (§16), a release is only meaningful if its
moving parts are reported together. Every release reports:

- the **language-spec version** (this document);
- the **runtime implementation version**;
- the **conformance suite version** (kernel + memory-envelope, §17.5);
- the **memory schema / projection version** (§16.7);
- the **provider / decomposition / embedding algorithm versions** used for memory and calibration
  (§16.5, §16.8);
- the **canonical-ledger version** — hash algorithm, serialization, and redaction rules (§16.2).

These are what `health` advertises (§16.9) and what a recording is identified against alongside
`(I, manifest, recording)` (§17.3). **Changing the memory envelope, the ledger schema, the replay
contract, or private-memory semantics requires a spec update and passing conformance tests before it
is considered implemented** — the runtime contract does not drift ahead of (or behind) the document.

---

## 18. Deployment

An Agape runtime may run entirely in userspace: it executes programs, exposes the world
through wired events and actions (§6b) as the gated capability surface, enforces the membrane
(the capability and gating
discipline of §13), and writes every consequential action to the ledger for audit and replay.
No kernel support is required for conformance.

The intended deployment trajectory is stronger than "an app engine that happens to run
Agape." The trusted kernel can be the infrastructure component itself: a cloud control plane
whose service calls are wired Agape actions, a microservice fabric whose inter-service messages
are ledgered Agape events, or an OS/runtime boundary where process, storage, network, and world
effects are mediated by Agape grants and gates. In all of these deployments, the substrate is
conformant only if it preserves the same kernel contract: declared dependencies for external
power, ledgered decisions plus committed subject endorsements for cognition-derived consequences,
default-deny authority, and record/replay as the source of truth.

This is analogous to eBPF's bargain with an operating system: code earns a lower-level seat by
being verifiable, not merely trusted. Moving Agape's enforcement boundary downward — into a
cloud platform, service mesh, or OS — is an implementation strategy for the same language, not a
license to add ambient authority outside the ledger.
