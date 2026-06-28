# Agape

**A programming language for agent systems you can actually trust.**

Agape treats a model's output as *testimony* — a typed, graded judgment that carries **no authority** until your program earns the right to act on it. Bounded authority, mandatory endorsement, and a complete replayable record are **compile-time guarantees**, not runtime hope.

> Most agent systems don't survive production. Across the seven frameworks in the [MAST taxonomy](https://arxiv.org/abs/2503.13657) — 1,642 annotated execution traces — multi-agent systems fail **41–87% of the time**, almost never because the model wasn't capable enough. They fail for *structural* reasons: agents coordinate through unstructured text and misread each other, act on testimony they had no grounds to trust, exceed the authority they were meant to hold, and leave no record to replay when something breaks. Those aren't model problems. They're the missing guarantees every other class of critical software takes for granted — types, contracts, access control, an audit log. Agape makes them properties of the *program*, checked before it runs.

## Quickstart

Agape needs [Rust](https://rustup.rs). From a clone of this repo, install the toolchain, scaffold a project, and run it — **offline, no API key** (a deterministic mock model ships in-box):

```sh
cargo install --path agape-rs            # puts `agape` on your PATH
agape init hello && cd hello
agape run main.ag --prompt question="is the earth round?"
```

`agape init` scaffolds a fact-checked Q&A system — two agents and one decision gate — and `agape run` executes it, printing the **spine**: the immutable, append-only log that *is* the program's state.

```
[  5] Prompt        question   is the earth round?
[  6] Sent          answer     answer the user's question concisely: is the earth round?
[  8] Resolved      answer      ok
[  9] Draft         responder   ok
[ 11] Resolved      sound       true 0.90          ← the model's graded judgment (a Credence)
[ 13] Decided       sound       true               ← the gate endorsed it (≥ 0.8 confidence)
[ 14] Reply         checker     ok                 ← only now may the answer be delivered

15 events · chain-head 61b05688d023acf8
```

Every step is on the record, and `chain-head` hashes the whole run — replay it and you get the identical chain. Drop the model's confidence below the gate's bar and `Reply` never fires: no endorsement, no action.

```sh
agape check main.ag      # static guarantees only — authority, endorsement, types, color
agape studio             # open the project in Agape Studio (live spine, eval, lifecycle)
```

By default everything runs on the in-box mock provider. To run against a real model, configure a provider (`agape configure provider …`) or attach the studio's live provider (`agape run --claude`, `agape studio`). See **[DISTRIBUTION.md](DISTRIBUTION.md)**.

## The shape of a program

```agape
action Refund(amount: int, to: text);

agent HelpDesk grants { perform Refund } {
  on awake {
    Credence<bool> withinPolicy = self <- "is refund #4217 within policy?";
    endorse (withinPolicy by confidence 0.9) {
      true: perform Refund(50, "alice");
    }
  }
}

spawn HelpDesk d; awake d;
```

The model's answer is a `Credence` — **untrusted**. Calling `perform Refund` straight from it *does not compile*: an action may consume only an **endorsed** value, and a `Credence` is endorsed only by passing the `endorse` gate. `confidence 0.9` is the bar the judgment must clear; below it the gate **abstains** and nothing happens. The model can be wrong — but what it's allowed to *do* when it's wrong is fixed in advance, and on the record.

## What Agape guarantees

- **Cognition is typed.** A model's testimony returns as a schema-constrained `Credence<E>` — a calibrated distribution over a closed set of outcomes, read from the model's own token probabilities — not a string to parse and pray over.
- **Authority is bounded at compile time.** An agent may `perform` only what its `grants` permit, and nothing it computes at runtime can widen that set.
- **Endorsement is unavoidable.** A value derived from cognition is untrusted until a gate endorses it. The type checker rejects any program that lets an unendorsed `Credence` drive an action — a missing endorsement is a compile error, not a latent incident.
- **Every run replays.** Execution is an append-only, hash-chained log; state is a function of that log. A recorded run replays exactly, and any prefix can be replayed under altered facts to test a counterfactual.

## How a decision is made

Work moves through four stages, each typed and each recorded — and because each value's standing (untrusted testimony → graded credence → endorsed decision) is part of its **type**, nothing slips from testimony to action without passing the gate. It's one path the compiler checks end to end, not a sequence the program is trusted to follow.

1. **Testimony** — a model assertion, solicited with the cognition operator `self <- "…"`. Never trusted as a string; bound as a `Credence`.
2. **Credence** — a graded judgment over a closed set of outcomes. Carries no authority on its own.
3. **Decision** — the `endorse` gate collapses a credence to a `Decision` *only* when it meets a stated standard of confidence; short of that, it **abstains**.
4. **Action** — an endorsed decision may license an `action`, performed only within the agent's granted authority. Every stage is appended to the spine.

## Beyond the basics

Agape is a real language, not a toy DSL — modules and imports, visibility, generics, and interfaces let you build and ship libraries; the readable **`decide`** gate lets a non-programmer state intent and stakes (`reversible`) while the compiler derives and enforces the decision theory underneath. See [`SPEC.md`](SPEC.md).

## Who it's for

Builders of agent systems that must be *trusted*, not hoped for — where the requirement isn't "the agent probably won't do X" but "the agent **cannot** do X, and here's the proof." Sharpest in regulated and high-stakes work; useful to anyone who needs an agent system to stay stable and auditable past its first week.

## Foundations

Agape is assembled from established ideas, not invented from nothing: treating model output as *testimony* requiring grounds before trust is the stance of the [epistemology of testimony](https://iep.utm.edu/ep-testi/); *credence* is formal epistemology's term for a graded degree of belief; *endorsement* — raising a value from untrusted to trusted — is the integrity operation from [information-flow control](https://www.cs.cornell.edu/andru/papers/robknowledge.pdf); performing an action by issuing it is a [speech-act](https://plato.stanford.edu/entries/speech-acts/) *performative* (Austin), valid only with the authority for it — a *power* in [Hohfeld's](https://en.wikipedia.org/wiki/Wesley_Newcomb_Hohfeld) analysis of rights. The contribution is the combination, enforced at compile time.

## Project

- [`SPEC.md`](SPEC.md) — the language specification (the authoritative reference).
- [`agape-conformance/`](agape-conformance) — the black-box conformance suite an implementation must satisfy.
- [`agape-rs/`](agape-rs) — the reference implementation (the `agape` toolchain).

The specification and conformance suite define the language; the reference implementation passes the suite in full.
