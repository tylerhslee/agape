# Agape

**A programming language for agent systems you can actually trust.**

Agape treats a model's output as *testimony* — a typed, graded judgment that carries **no authority** until your program earns the right to act on it. Bounded authority, mandatory endorsement, and a complete replayable record are **compile-time guarantees**, not runtime hope.

The language is organized around a small trusted kernel: `Credence`, `Decision`,
`endorse`/`attest`, taint, default-deny grants, write-tool gating, and ledger replay. Modules,
interfaces, memory helpers, Studio, and the readable `decide` surface are useful only insofar
as they preserve that kernel. The core chain is always the same:

```
testimony -> Credence<E> -> Decision<E> -> endorsed action -> ledger
```

The smallest useful Agape program is a guarded action. The text prompt asks the
model for help, but the `Credence<Approval>` slot is what enforces the output
shape: the provider receives a structured-output schema for the closed enum
`Approval`, not permission to answer with arbitrary prose.

```agape
prompt text request;

enum Approval { Approve, Decline }
action ReleaseFunds(int cents);
reversible action Notify(text message);

policy Payments { threshold 0.95  floor 0.20 }

agent Clerk grants { perform ReleaseFunds, perform Notify } {
  when (Prompt p about request) {
    Credence<Approval> decision =
      self <- f"assess this payment request: {p}";

    endorse (decision by Payments) {
      Approve: perform ReleaseFunds(10000);
      Decline: perform Notify("declined; no funds released");
    } abstain {
      perform Notify("needs human review");
    }
  }
}

spawn Clerk clerk;
awake clerk;
```

> Most agent systems don't survive production. Across the seven frameworks in the [MAST taxonomy](https://arxiv.org/abs/2503.13657) — 1,642 annotated execution traces — multi-agent systems fail **41–87% of the time**, almost never because the model wasn't capable enough. They fail for *structural* reasons: agents coordinate through unstructured text and misread each other, act on testimony they had no grounds to trust, exceed the authority they were meant to hold, and leave no record to replay when something breaks. Those aren't model problems. They're the missing guarantees every other class of critical software takes for granted — types, contracts, access control, an audit log. Agape makes them properties of the *program*, checked before it runs.

## Quickstart

Agape needs [Rust](https://rustup.rs). From a clone of this repo, install the toolchain, scaffold a project, and run it — **offline, no API key** (a deterministic mock model ships in-box):

```sh
cargo install --path agape-rs            # puts `agape` on your PATH
agape init hello && cd hello
agape run main.ag --prompt question="is the earth round?"
```

`agape init` scaffolds a fact-checked Q&A system — two agents and one decision gate — and `agape run` executes it, printing the **ledger**: the immutable, append-only, hash-chained log that *is* the program's state.

```
[  5] Prompt        question   is the earth round?
[  6] Sent          answer     answer the user's question concisely: is the earth round?
[  8] Resolved      answer      ok
[  9] Answered      responder   ok
[ 11] Resolved      sound       Entails 0.90       ← the model's graded judgment (a Credence)
[ 13] Decided       sound       Entails            ← the gate endorsed it (conformal, ≤ 5% error)
[ 14] Published     checker     ok                 ← only now may the answer be delivered

15 events · chain-head 61b05688d023acf8
```

Every step is on the record, and `chain-head` hashes the whole run — replay it and you get the identical chain. Drop the model's confidence below the gate's bar and `Publish` never fires: no endorsement, no action.

```sh
agape check main.ag      # static guarantees only — authority, endorsement, types, trust
agape studio             # open the project in Agape Studio (live ledger, eval, lifecycle)
```

By default everything runs on the in-box mock provider. To run against a real model, name a backend in the manifest and bind its key from the environment — `anthropic` (sampling fallback), `openai`, or `gemini` (token-logprob credences). Configuration is Agape's ecosystem seam: providers, tools, prompts, identity, memory policy, and deployment endpoints are bound outside `.ag` source. See **[DISTRIBUTION.md](DISTRIBUTION.md)** and SPEC §17.

## Studio deployments

Agape ships with Studio because the language is easiest to understand when you can
drive agents, inspect the ledger, and watch gates resolve in one place:

```sh
agape studio
```

That bundled path is the default local developer experience. It should always work
offline with the deterministic mock provider, and it can use live providers when
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` are present in the
environment or the repo `.env`.

Studio is also developed as a detachable frontend in `../agape-studio/`. That
standalone package can attach to different Agape deployments without being tied to
this repo layout:

- **Embedded/local** — `agape studio` launches the Studio bundled with the Agape
  toolchain and attaches to the current project.
- **Standalone/local** — `../agape-studio` runs as its own Vite app and agent
  server, attaching to the sibling `agape` runtime during development.
- **Remote/cloud** — the same Studio frontend can point at a hosted Agape runtime
  or a product-specific deployment, such as Soma, through the stable API seams for
  project files, runs, provider config, memory, review, and ledger inspection.

The intended rule is: **the Agape package includes a Studio, but Studio does not
require living inside the Agape package.** Core language releases should not depend
on frontend churn, and Studio should be free to grow into a cloud/runtime control
plane for agentic work.

Studio is versioned separately from both the language and runtime. The active
project determines the language version Studio displays, and the configured
runtime deployment determines the runtime endpoint/version. This keeps the same
Studio usable against a local folder, a packaged runtime, or a future Soma/cloud
deployment.

## What Agape guarantees

- **Cognition is typed.** A model's testimony returns as a schema-constrained `Credence<E>` — a calibrated distribution over a closed set of outcomes, enforced by the provider's structured-output API and read from token probabilities or sampling fallback — not a string to parse and pray over.
- **Authority is bounded at compile time.** An agent may `perform` only what its `grants` permit, and nothing it computes at runtime can widen that set.
- **Endorsement is unavoidable.** A value derived from cognition is untrusted until a gate endorses it. The type checker rejects any program that lets an unendorsed `Credence` drive an action — a missing endorsement is a compile error, not a latent incident.
- **The kernel is fail-closed.** At a consequential boundary, unknown type, trust, endorsement, tool effect, grant, or replay source is a rejection, not a guessed permission.
- **Behavior is versioned, not mutable.** An agent's system prompt is an `instruction` in source — settled, reviewable, append-only under inheritance. No recalled fact or injected memory can rewrite it; changing behavior means shipping a new version.
- **Memory cannot launder trust.** Private memory stores anything, but every recall comes out **tainted** — taint-equivalent to a fresh model reply — so a remembered "fact" must be re-gated before it can drive an action, just like a new one.
- **Every run replays.** Execution is an append-only, hash-chained ledger; state is a function of that ledger. A recorded run replays exactly, and any prefix can be replayed under altered facts to test a counterfactual.

## How a decision is made

Work moves through four stages, each typed and each recorded — and because each value's standing (untrusted testimony → graded credence → endorsed decision) is part of its **type**, nothing slips from testimony to action without passing the gate. It's one path the compiler checks end to end, not a sequence the program is trusted to follow.

1. **Testimony** — a model assertion, solicited with the cognition operator `self <- "…"`. Never trusted as a string; bound as a `Credence`.
2. **Credence** — a graded judgment over a closed set of outcomes. Carries no authority on its own.
3. **Decision** — the `endorse` gate collapses a credence to a `Decision` *only* when it meets a stated standard of confidence; short of that, it **abstains** and may defer to a `principal`.
4. **Action** — an endorsed decision may license an `action`, performed only within the agent's granted authority. Every stage is appended to the ledger.

## Complete workflow example

The compact example shows the kernel. A fuller program can include safe replies,
ledger records, and a realistic abstain path. The checked-in example models a
support workflow: the agent may reply safely, but issuing credit is consequential.
The model can classify the case; it cannot spend on its own. The typed
`Credence<Outcome>` compiles to a structured-output schema over `Outcome`, and
the resulting judgment has to pass a recorded gate first.

```agape
prompt text request;

enum Outcome { Refund, Explain, Escalate }
event Case(text request);
reversible action Reply(text message);
action IssueCredit(int amount, text reason);

policy Support { threshold 0.85  floor 0.15 }

agent SupportDesk grants { perform Reply, perform IssueCredit } {
  when (Prompt p about request) {
    emit Case(p);

    Credence<Outcome> outcome =
      self <- f"classify this support request: {p}";

    endorse (outcome by Support) {
      Refund: {
        perform IssueCredit(25, "duplicate charge");
        perform Reply("I've issued a $25 credit and recorded the decision.");
      }
      Explain: perform Reply("I can explain the charge and the next step.");
      Escalate: perform Reply("I'm routing this to a specialist.");
    } abstain {
      perform Reply("I need a human review before taking action.");
    }
  }
}

spawn SupportDesk desk;
awake desk;
```

Run the checked-in version:

```sh
agape check agape-rs/examples/support-desk.ag
agape run agape-rs/examples/support-desk.ag --prompt request="my card was charged twice and I need help before rent is due"
```

With the deterministic mock provider, the ledger shows the whole chain:

```
[  3] Prompt       request  my card was charged twice and I need help before rent is due
[  5] Sent         outcome  classify this support request: ...
[  7] Resolved     outcome  Refund 0.90      ← typed model testimony
[  8] Decided      outcome  Refund           ← endorsed by the Support policy
[  9] IssueCredit  desk     {amount: 25, reason: duplicate charge}
                                              ← money moves only after the gate
[ 10] Reply        desk     I've issued a $25 credit and recorded the decision.
```

The model's answer is a `Credence` — **untrusted**. Calling `perform IssueCredit`
straight from it *does not compile*: an action may consume only an **endorsed**
value, and a `Credence` is endorsed only by passing the `endorse` gate. `Support`
is the bar the judgment must clear; below it the gate **abstains** and only the
safe reply path runs. The model can be wrong — but what it is allowed to *do*
when it is wrong is fixed in advance, and on the record.

## The v1.0.2 surface

Agape is a real language, not a toy DSL. Beyond the four-stage core:

- **A library layer.** `module` / `import` / `pub` namespace and hide code; `interface` names an agent's external surface (the events it handles, the outcomes it decides) with nominal conformance; generics parameterize data and helpers. You build and ship libraries, not just scripts.
- **The readable gate — `decide`.** State *intent + one fact about stakes* and the compiler derives the decision theory. Mark a sink `reversible` and the gate just acts (argmax); leave it unmarked and it runs **conformal** every time, certified to a single dial, `conformal α`. A non-reversible arm with no reachable `principal` is a *compile error* — autonomy is earned from labelled cases, never assumed.
- **`instruction` — procedural memory in source.** The compile-time system prompt. Global or agent-scoped, append-only under `extend`; an agent's behavioral spec cannot drift without a reviewable release.
- **Private memory — `mem` handles.** `mem m <- v` writes, `m -> "query"` recalls, `forget m` tombstones (audit-preserving). Recall is **always tainted**: re-gate it before any sink. The **ledger** is its dual — the objective, deterministic, untainted record of *what happened*, queried with `select … from ledger` and traversed by causal lineage.
- **Provider-backed Credence.** The cognition backend produces the calibrated mass the gate consumes: providers with token probabilities read it from logprobs; text-only providers derive it through a sampling fallback. Capabilities are intrinsic to the backend (never hand-set knobs); secrets bind from the environment, never source.

The long-term deployment target is not merely "an Agape app server." The same kernel can be
the infrastructure boundary: a cloud control plane, service fabric, or OS/runtime layer where
process, network, storage, and tool effects are mediated by Agape grants, gates, and ledger
replay.

A single self-contained program touching all of this is **[`design/v1.0.0-showcase.ag`](design/v1.0.0-showcase.ag)**; the full reference is **[`SPEC.md`](SPEC.md)**.

## Who it's for

Builders of agent systems that must be *trusted*, not hoped for — where the requirement isn't "the agent probably won't do X" but "the agent **cannot** do X, and here's the proof." Sharpest in regulated and high-stakes work; useful to anyone who needs an agent system to stay stable and auditable past its first week.

## Foundations

Agape is assembled from established ideas, not invented from nothing: treating model output as *testimony* requiring grounds before trust is the stance of the [epistemology of testimony](https://iep.utm.edu/ep-testi/); *credence* is formal epistemology's term for a graded degree of belief; *endorsement* — raising a value from untrusted to trusted — is the integrity operation from [information-flow control](https://www.cs.cornell.edu/andru/papers/robknowledge.pdf); performing an action by issuing it is a [speech-act](https://plato.stanford.edu/entries/speech-acts/) *performative* (Austin), valid only with the authority for it — a *power* in [Hohfeld's](https://en.wikipedia.org/wiki/Wesley_Newcomb_Hohfeld) analysis of rights. The contribution is the combination, enforced at compile time.

## Project

- [`SPEC.md`](SPEC.md) — the language specification (the authoritative reference).
- [`design/v1.0.0-showcase.ag`](design/v1.0.0-showcase.ag) — one annotated program over the whole v1.0.2 surface.
- [`agape-conformance/`](agape-conformance) — the black-box conformance suite an implementation must satisfy.
- [`agape-rs/`](agape-rs) — the reference implementation (the `agape` toolchain).
- `../agape-language-pack/` — editor support and syntax highlighting for Studio, VS Code, Cursor, and docs renderers.

The specification and conformance suite define the language; the reference implementation passes the suite in full.
