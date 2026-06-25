# Agape

**A programming language where cognition is a first-class operation — for building AI agent systems that are reliable, bounded, and auditable.**

---

## Why Agape exists

AI agents are everywhere, and most of them don't survive contact with production.
Across 1,600+ real deployments, multi-agent systems
[fail 41–87% of the time](https://arxiv.org/pdf/2503.13657) — almost never because
the model wasn't smart enough, and almost always for mundane structural reasons:
agents miscoordinate, skip verification, step on each other's resources, and act
on unvetted model output.

That isn't a model problem. It's a **language** problem. We're building agents with
tools designed for deterministic code — frameworks bolted onto Python where
coordination, verification, and authority are conventions you *hope* hold at
runtime. Agape makes them **guarantees the compiler checks before anything runs.**

## The shift: agentic is the new management layer

Here's the paradigm worth naming. Computing is becoming "agentic" — but not the part
you'd think. The low-level work stays deterministic: compiling a file, sorting a
list, encoding a video are mechanical processes and always will be. What's becoming
agentic is the **layer where a human directs and manages computation.**

Take a compiler. You don't make *compiling* agentic — it's mechanical. You make
*using the compiler* agentic: the cognitive load of deciding what to build,
interpreting errors, choosing flags, recovering from failure. **That management
layer is cognitive, and it's where the value of "agentic" actually lives** — taking
that load off the person.

Agape is the language for that layer. It treats **a model call — cognition — as the
atomic operation**, the way conventional languages treat arithmetic, and gives it the
structure deterministic code always had: types, contracts, bounded authority, and an
audit trail. The deterministic work stays in your existing code, reached through a
typed tool seam; Agape governs the cognitive layer on top.

## What it guarantees

Agape's promises are the ones the failure data says you need — and it makes them
*structural*, not aspirational:

- **Cognition is typed.** A model's answer isn't a raw string you parse and pray
  over; it's a typed, schema-constrained value (`Credence<E>`).
- **Authority is bounded at compile time.** An agent can only do what its `grants`
  permit — and *nothing it learns at runtime can widen that.* It cannot acquire
  authority it was never given.
- **Verified cognition is unavoidable.** Untrusted model output is "tainted" until an
  explicit, recorded gate endorses it. The type checker *rejects* any path that routes
  raw cognition into a consequential action. You can't forget to verify — it won't
  compile.
- **Everything replays.** A run is an append-only event log (the *spine*); state is a
  pure projection of it. Any run replays exactly — and you can fork the log to ask
  "what if the agent hadn't known X?"

And the honest part, because it's the whole point: **Agape does not make the model
correct. Nothing can.** It makes the *consequences* of an unreliable model contained,
gated, and auditable. Think of it as **memory safety for agency** — it can't make an
agent right, but it can prove what a *wrong* agent is structurally unable to do, and
show you exactly what it did.

## Who it's for

Anyone building agent systems that have to be **trusted** — where "the agent probably
won't do X" isn't good enough and you need *"the agent provably cannot do X, and here's
the audit trail."* That's sharpest in high-stakes and regulated work (money, access,
safety), but it's also for any builder tired of agent systems that fall over in week
two and can't be debugged.

## A taste

```agape
authority Refund;
event Refund(amount: int, to: text);

agent Desk grants { emit Refund } {
  on awake {
    Credence<bool> ok = self <- "is refund #4217 within policy?";  // a model judgment — tainted
    event<Verification> v = verify ok by > 0.9;                    // the explicit gate
    when Pass(v) { emit Refund(50, "alice"); }                     // reachable only on a passed gate
    // emit Refund(...) on the raw `ok` would be a compile error.
  }
}
spawn Desk d; awake d;
```

## Where to go next

- **[`SPEC.md`](SPEC.md)** — the precise definition (dense by design; this README is
  the friendly version).
- **[`agape-conformance/`](agape-conformance)** — the black-box test suite that defines
  what any correct implementation must do.
- **[`agape-rs/`](agape-rs)** — the reference implementation in Rust.

**Status: early.** The v1.0 spec and conformance suite are the source of truth; the
Rust reference implementation runs most of the suite today; a minimal formal core with
machine-checked soundness proofs is in progress. Agape isn't the only project taking
cognition seriously as a computational substrate — it's betting, uniquely, on making
the guarantees **foundational to the language** rather than bolted on at runtime.
