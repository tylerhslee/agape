# The Cognition library — design

> A reference library implementing a **Jungian cognitive-functions** architecture on top of
> Agape **v1.1.0** (the library layer, SPEC §19). It is the substrate the demos build on
> (a productive team — Studio; a cautionary institution — the prison experiment).
>
> **Status.** This targets the v1.1.0 spec; it uses modules, visibility, generics,
> interfaces, and error subtyping (§19), none of which `agape-rs` implements yet, so it is a
> *reference* package — authoritative as design, not yet executable. Agent bodies show the
> intended shape; fusion/calibration detail is elided with comments.

## 1. The idea in one paragraph

LLM output is bounded chaos. A **gate** collapses it by asking a bounded question (SPEC §13).
A **cognition** is a mind built from eight such collapse-functions (Jung's cognitive
functions), wired so that perception flows inward, judgment closes it, and only **settled**
decisions leave the mind. In Agape terms a cognition is an ordinary `agent` that satisfies the
`Cognition` interface; its interior is `graded`, its exports are `settled`, and the gate is the
wall between minds — enforced by the trust lattice, not by convention.

## 2. The function → construct mapping

| | **S** (concrete) | **N** (relational) | **T** (impersonal) | **F** (value) |
|---|---|---|---|---|
| **ext** | **Se** `prompt`/`read tool`/`<-` | **Ne** internalized graph + `\|>` | **Te** threshold gate → `write`/`perform` | **Fe** `attest … by p` |
| **int** | **Si** FACTS (`select`) | **Ni** `find`/`match` + fuse → collapse | **Ti** `Credence<Entailment>` / enum / `case` | **Fi** loss-direction + `grants` + `policy` |

**What is runtime vs authored.** Se/Si/Ne are *not* agents you write — they are the runtime's
automatic **internalization** of every received event into facts, relationships, and embeddings
(SPEC §10). What this library authors is:

- **Ni** — active re-query + convergence (`Synthesizer`, `functions.ag`).
- **T** — the judging leaf (`ThresholdJudge<E>`, `functions.ag`) and the role gates.
- **F** — the escalation path (`Escalate` signal; a `by principal` defer in a real role).
- **the PFC** — a shared long-term memory (`Consolidator`, `consolidator.ag`).

## 3. Module layout

```
libs/cognition/
  agape.toml            # [package] name="cognition" lib="src/lib.ag"
  src/
    lib.ag              # module cognition            — the public Cognition interface + Query/Verdict
    signals.ag          # module cognition.signals    — the typed neurotransmitter/hormone vocabulary
    functions.ag        # module cognition.functions  — Ni + the generic judging leaf (T)
    consolidator.ag     # module cognition.consolidator — the PFC / long-term memory (option-b)
    roles.ag            # module cognition.roles      — role archetypes (function-priority + grants)
  examples/
    triage.ag           # a tiny orchestration demo (the "test" layer)
```

Every file declares an explicit `module …;` header (so module paths are unambiguous regardless
of path-derivation). Cross-module names use **selective imports** (`import { X } from m;`) to
keep references bare — which also matters because `grants { reach X }` and `agent A : I` name
types that must be in scope (§19.4–§19.5).

## 4. Signals — neurotransmitters and hormones

`signals.ag` is the shared vocabulary, split exactly as the body's chemistry is:

- **Neurotransmitters** — point-to-point typed events between functions: `Sensed` (Se→),
  `Mapped` (Ne→), `Concluded` (Ni→), `Asked`/`Ruled` (the request/reply pair).
- **Hormones** — ambient, broadcast events many agents read: `Confidence` (a global "how
  settled are we"), `Escalate` (route the epistemic remainder to a principal/human).
- **A typed fault** — `CognitiveFault(reason) : Error` (v1.1.0 error subtyping), caught by any
  `when (Error e)`.

Events carry a **single field** (a struct when rich), matching the `emit X(expr)` /
`perform X(expr)` single-payload form in the grammar.

## 5. The Cognition interface — the settled-export wall

```agape
// lib.ag
pub interface Cognition { handles Asked -> Ruled; }
```

`handles Asked -> Ruled` means: send a cognition an `Asked` (carrying a `Query`); it reacts,
runs its internal perceive→judge cascade, and produces a `Ruled` (carrying a **settled**
`Verdict`). The reply is settled because it is emitted from inside a gate arm — the interior
`Credence` chatter is `graded` and, by the consequential-action rule (§13), cannot cross to a
consumer except through the gate. So the abstraction is leak-proof *by type*: a consumer can
only ever receive gated outputs.

## 6. The Consolidator — the prefrontal cortex

Shared long-term memory is modeled as **one actor that owns it** (the option-b pattern): the
`Consolidator` subscribes to the cognitive cascade (`Concluded`, optionally `Sensed`) and
`store`/`embed`s into *its own* memory (§10), which thereby becomes the collective store.
Concurrent writes serialize through its mailbox, so the no-shared-mutable-state invariant
(§0.2) holds and replay stays deterministic. The **depth knob** lives here: consolidate only
judged `Concluded` (a curated memory) vs also eager `Sensed` (a high-recall memory).

## 7. Roles — function-priority + grants

A role archetype is a concrete agent that satisfies `Cognition`; its "type" (in the MBTI
sense) is *which functions dominate* plus its authority. `roles.ag` ships `Reviewer` (a Ti/Si
critic). Studio and the prison demo are just different role sets wired by `reach` grants over
the same substrate.

## 8. Known gaps surfaced (candidates for v1.1.x)

- **No re-export.** §19 `import` binds names into a module's scope but does not re-export them,
  so `lib.ag` cannot republish `Query`/`Verdict` from `signals.ag`; users import both modules.
  A `pub import` / re-export form is the obvious follow-up.
- **`cap` names must be in scope.** `grants { reach Consolidator }` requires `Consolidator`
  imported (the grammar's `cap ::= reach Ident` takes a bare name, not a `modpath`). Selective
  import covers it; a qualified-cap form would be more ergonomic.
- **Request/reply is event-driven.** Because a `<-` reply is a single provider think, a
  multi-step cognition replies via an emitted `Ruled` event rather than a bound `<-` result;
  `handles A -> B` is therefore "consumes A, produces B," not a synchronous call.

## 9. Next

Demos as the test layer: wire role sets over this substrate — Studio (Engineer/PM/QA) and the
prison experiment (Jailor/Prisoner/Superintendent), each a different governance regime over the
same spine.
