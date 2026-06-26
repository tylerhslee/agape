# Agape

Agape is a programming language for the cognitive layer of software — the layer where a model's judgment, rather than deterministic code, decides what happens next. It treats a model's output as what it is: *testimony*, a typed and graded judgment that carries no authority until the program establishes grounds to act on it. Around that judgment it enforces, at compile time, the properties judgment-driven systems need and rarely have: authority bounded to what an agent is granted, cognition that cannot drive a consequential action until it is endorsed, and a complete, replayable record of every decision.

## The problem

Most agent systems do not survive production. Across the seven open-source frameworks studied in the [MAST taxonomy](https://arxiv.org/abs/2503.13657) — 1,642 annotated execution traces — multi-agent systems fail between 41% and 87% of the time, almost never because the model was not capable enough. They fail for structural reasons: agents coordinate through unstructured text and misread one another, act on testimony they had no grounds to trust, exceed the authority they were meant to hold, and leave no record that can be replayed when something goes wrong.

These are not model problems. They are the absence of guarantees that every other class of critical software takes for granted: types, contracts, access control, an audit log. Today those guarantees are, at best, conventions a framework enforces at runtime — which a developer can forget and a reviewer cannot see. Agape makes them properties of the program, checked before it runs.

## What it is

Computation divides into two kinds of work. Deterministic work — parsing, sorting, arithmetic, calling a service — is mechanical and belongs in conventional code. Deciding *how and why to do something* — interpreting a request, judging whether an action is warranted, recovering from an ambiguous result — is cognitive. As software becomes agentic, the cognitive layer is the one that grows, and it is the layer Agape governs.

Agape does not replace deterministic code; it orchestrates it. Deterministic work stays in the host language and is reached through a typed **tool seam**. Agape owns the cognitive layer above it, and the boundary between the two is stable. The agentic logic — the part that changes as fast as the field does — is encapsulated behind that boundary, and can evolve without disturbing the rest of the system.

## How a decision is made

Work in Agape moves through four stages, each typed and each recorded.

A model produces **testimony** — an assertion solicited with the cognition operator (`self <- "…"`). Agape never treats testimony as a string to be trusted; it binds it as a `Credence`, a graded judgment over a closed set of outcomes.

A credence carries no authority on its own. Before an agent may act on it, the judgment must pass a gate — `endorse` — which collapses it to a `Decision` and endorses that decision: raises it from untrusted to trusted, but only when it meets a stated standard of confidence. A judgment that falls short is not endorsed, and the gate **abstains**.

An endorsed decision may license an **action** — *performed* only within the authority the agent was granted. Recording an `event` is how all state changes in Agape; performing an `action` is the consequential kind, whose effect is fixed by the decision that licensed it.

Every stage — the testimony, the credence, the decision, the action — is appended to an immutable log, and the system's state is a function of that log. A run therefore reproduces exactly.

## What it guarantees

- **Cognition is typed.** A model's testimony comes back as a schema-constrained value — a `Credence<E>`, a calibrated distribution over a closed set of outcomes read from the model's own token probabilities — not a string to parse and trust.
- **Authority is bounded at compile time.** An agent may perform only the actions its `grants` permit, and no value it computes or learns at runtime can extend that set.
- **Endorsement is unavoidable.** A value derived from cognition is untrusted until a gate endorses it. The type checker rejects any program that lets an unendorsed `Credence` drive an action; a missing endorsement is a compile error, not a latent risk.
- **Every run replays.** Execution is an append-only, hash-chained log, and state is a function of that log. A recorded run replays exactly, and any prefix can be replayed under altered facts to test a counterfactual.

Agape makes no claim that a model's testimony is correct; no system can. It bounds and records the consequences of testimony that is wrong. The model may err; what it is permitted to do when it errs is fixed in advance, and what it did is on the record.

## Example

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

The model's answer is a `Credence` — untrusted. `perform Refund` driven directly from it does not compile: an action may consume only an endorsed value, and a `Credence` is endorsed only by passing the `endorse` gate. The rule (`confidence 0.9`) is the standard the judgment must meet; below it the gate abstains and no action is performed.

## Who it is for

Builders of agent systems that must be trusted rather than hoped for — where the requirement is not "the agent probably will not do X" but "the agent cannot do X, and here is the proof." That requirement is sharpest in regulated and high-stakes work, and it applies to anyone who needs an agent system to stay stable and auditable past its first week.

## Foundations

Agape's model is assembled from established ideas, not invented from nothing. Treating a model's output as *testimony* that requires grounds before it is trusted is the stance of the [epistemology of testimony](https://iep.utm.edu/ep-testi/). *Credence* is the term from formal epistemology for a graded degree of belief. *Endorsement* — raising a value from untrusted to trusted — is the integrity operation studied in [information-flow control](https://www.cs.cornell.edu/andru/papers/robknowledge.pdf). Performing an action that changes state by being issued is, in [speech-act](https://plato.stanford.edu/entries/speech-acts/) terms, a *performative* (Austin), valid only when the agent holds the authority for it — which in [Hohfeld's](https://en.wikipedia.org/wiki/Wesley_Newcomb_Hohfeld) analysis of rights is a *power*. The contribution is the combination of these and their enforcement at compile time, not the parts in isolation.

## Documents

- `[SPEC.md](SPEC.md)` — the language specification.
- `[agape-conformance/](agape-conformance)` — the conformance suite an implementation must satisfy.
- `[agape-rs/](agape-rs)` — the reference implementation.

Agape is in early development. The specification and conformance suite define the language; the reference implementation runs most of the suite.
