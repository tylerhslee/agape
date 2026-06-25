# Agape

Agape is a programming language for the cognitive layer of software — the layer where a
model's judgment, rather than deterministic code, decides what happens next. It treats a
model call as a typed, first-class operation and enforces, at compile time, the properties
that judgment-driven systems need and rarely have: bounded authority, mandatory
verification, and a complete, replayable record of every decision.

## The problem

Most agent systems do not survive production. Across the 1,600+ deployments studied in the
[MAST taxonomy](https://arxiv.org/pdf/2503.13657), multi-agent systems fail between 41% and
87% of the time — almost never because the model was not capable enough. They fail for
structural reasons: agents coordinate through unstructured text and misread one another, act
on unverified model output, exceed the authority they were meant to have, and leave no record
that can be replayed when something goes wrong.

These are not model problems. They are the absence of guarantees that every other class of
critical software takes for granted: types, contracts, access control, an audit log. Today
those guarantees are, at best, conventions a framework enforces at runtime — which a developer
can forget and a reviewer cannot see. Agape makes them properties of the program, checked
before it runs.

## What it is

Computation divides into two kinds of work. Deterministic work — parsing, sorting,
arithmetic, calling a service — is mechanical and belongs in conventional code. Deciding
*what to do* — interpreting a request, judging whether an action is warranted, recovering
from an ambiguous result — is cognitive. As software becomes agentic, the cognitive layer is
the one that grows, and it is the layer Agape governs.

Agape does not replace deterministic code; it orchestrates it. Deterministic work stays in the
host language and is reached through a typed **tool seam**. Agape owns the cognitive layer
above it, and the boundary between the two is stable. The agentic logic — the part that
changes as fast as the field does — is encapsulated behind that boundary, and can evolve
without disturbing the rest of the system.

## What it guarantees

- **Cognition is typed.** A model's answer is a schema-constrained value (`Credence<E>`), not a
  string to parse and trust.
- **Authority is bounded at compile time.** An agent may perform only the actions its `grants`
  declare, and no value it computes or learns at runtime can extend that set.
- **Verification is unavoidable.** A value derived from cognition is *tainted* until an explicit
  gate endorses it. The type checker rejects any program that lets a tainted value drive a
  consequential action; a missing check is a compile error, not a latent risk.
- **Every run replays.** Execution is an append-only log, and state is a function of that log.
  A run reproduces exactly, and any prefix can be replayed under altered facts to test a
  counterfactual.

Agape makes no claim that a model's output is correct; no system can. It bounds and records the
consequences of output that is wrong. The model may err; what it is permitted to do when it errs
is fixed in advance, and what it did is on the record.

## Who it is for

Builders of agent systems that must be trusted rather than hoped for — where the requirement is
not "the agent probably will not do X" but "the agent cannot do X, and here is the proof." That
requirement is sharpest in regulated and high-stakes work, and it applies to anyone who needs an
agent system to stay stable and auditable past its first week.

## Example

```agape
authority Refund;
event Refund(amount: int, to: text);

agent Desk grants { emit Refund } {
  on awake {
    Credence<bool> ok = self <- "is refund #4217 within policy?";
    event<Verification> v = verify ok by > 0.9;
    when Pass(v) { emit Refund(50, "alice"); }
  }
}
spawn Desk d; awake d;
```

`emit Refund` applied directly to `ok` does not compile: a value from the model cannot reach a
consequential action without passing the gate.

## Documents

- [`SPEC.md`](SPEC.md) — the language specification.
- [`agape-conformance/`](agape-conformance) — the conformance suite an implementation must satisfy.
- [`agape-rs/`](agape-rs) — the reference implementation.

Agape is in early development. The specification and conformance suite define the language; the
reference implementation runs most of the suite.
