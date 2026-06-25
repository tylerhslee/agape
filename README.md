# Agape

A programming language whose computational primitive is **cognition**.

Agape exists to make **multi-agent systems reliable, bounded, and auditable** —
the things that cause 40–86% of agentic projects to fail in production
([MAST, NeurIPS 2025](https://arxiv.org/pdf/2503.13657)) are coordination
breakdowns, verification gaps, and unbounded authority, and Agape attacks each at
the *language* level rather than as a runtime library bolted onto a general-purpose
language.

It does **not** make the model correct — nothing can. It makes the *consequences*
of an unreliable model **contained, gated, and replayable.** Think "memory safety
for agency": the language can't make an agent right, but it can prove what a wrong
agent is structurally unable to do, and let you replay exactly what it did.

## What it guarantees (the hard part)

- **Authority is bounded and non-amplifiable.** An agent can only `emit` the events
  its `grants` permit, and *nothing it learns at runtime can widen that.*
- **Untrusted cognition can't drive a consequential action ungated.** A value from
  the model is *tainted* until an explicit `decide`/`verify` gate endorses it; the
  type checker rejects any path that routes tainted cognition into an `authority`
  emit. (Soundness = a noninterference theorem; see `SPEC.md` §16.)
- **Deterministic replay.** The spine is an append-only log of everything that
  happened; state is a pure projection of it, so any run replays exactly — and you
  can fork the log to explore counterfactual timelines.

What it explicitly does **not** claim: that the model's output is *true*. Gates
confer *integrity* (you decided to trust it, on the record), not *correctness*.

## Layout

```
SPEC.md                  the language spec (v1.0) — the definition every impl must obey
agape-conformance/       black-box conformance suite (gen.py + tests/) — validates any impl
agape-rs/                the reference implementation in Rust (lexer → parser → checker → interp)
compiler/                the self-hosting compiler, written in Agape
editors/                 VS Code / Cursor syntax highlighting (shared TextMate grammar)
studio/                  Agape Studio — the event-spine IDE (React + the runtime)
COMPETITIVE_LANDSCAPE.md / DISTRIBUTION.md   positioning + packaging notes
```

## Run the conformance suite against the reference impl

```bash
cd agape-rs
cargo run --bin conformance        # reads ../agape-conformance/tests
```

A conformant implementation must satisfy **every** test: `reject` tests reject with
the declared error class; `accept` tests are accepted and match any asserted spine.

## Status

Early. The spec and conformance suite (v1.0) are the source of truth; the Rust
reference implementation runs most of the suite today. The formal core (a minimal
calculus + machine-checked soundness theorems) is in progress.
