# agape-ts — a TypeScript compiler + runtime for Agape

A from-scratch implementation of the Agape language (per `../SPEC.md`,
v1.0.0-alpha.2026.6.30.0), written in TypeScript so it can eventually live inside Agape
Studio. This is a **vertical slice**: it lexes, parses, and runs a useful subset of the
language end-to-end, with the trusted kernel (`decide` → `endorse` → granted sink → ledger)
enforced at runtime. It is not yet 100% conformant — that is validated against
`../agape-conformance` as the suite is re-aligned to the finalized spec.

## Run

```bash
npm install
npm run hello                     # runs examples/hello.ag on the mock provider
npx tsx src/cli.ts run examples/hello.ag --manifest agape.toml
npm test                          # the kernel safety test suite

# live providers — secrets come from the environment / a .env (never the manifest):
npx tsx src/cli.ts run examples/hello.ag --provider openai     # OPENAI_API_KEY  → logprob path
npx tsx src/cli.ts run examples/hello.ag --provider anthropic  # ANTHROPIC_API_KEY → sampling fallback
```

The runtime is **async** end-to-end (cognition is a model call): the mock resolves on a microtask, so
tests and the demo exercise the same async path as a live model. Both live backends above are verified
to run `examples/hello.ag` end-to-end — OpenAI reads `top_logprobs` for graded per-variant scores;
Anthropic (no token logprobs) draws the forced choice `fallback_samples` times and uses the empirical
frequency. Gemini is wired the same way (sampling fallback) and selectable, pending a key to exercise.

`examples/hello.ag` is the whole trusted kernel on one screen — a Greeter that judges a draft,
collapses the judgment with `decide`, and reaches the `Announce` sink only inside the committed
`Publish` arm:

```
testimony  ->  Credence<Verdict>  ->  Decision<Verdict>  ->  Endorsement<text>  ->  granted sink  ->  ledger
```

## Pipeline

| stage | file | does |
|---|---|---|
| lexer | `src/lexer.ts` | source → tokens (§2) |
| parser | `src/parser.ts` | tokens → AST (subset of §15.2) |
| AST | `src/ast.ts` | node types |
| checker | `src/check.ts` | static pass: compile-error classes (TypeError/Exhaustiveness/…) before run |
| errors | `src/errors.ts` | the error taxonomy (`AgapeError { cls }`) the suite asserts on |
| runtime core | `src/runtime.ts` | values + the trust lattice, the **provider seam**, the ledger |
| interpreter | `src/interp.ts` | discrete-event runtime; the gate; the consequential-action rule |
| config | `src/config.ts` | binds the `provider` dependency to a backend (§17) |
| cli | `src/cli.ts` | `agape-ts run <file.ag>` |
| conformance | `conformance/run.mts` | runs the suite (`../agape-conformance`) against this impl — see [CONFORMANCE.md](CONFORMANCE.md) |

## Providers are configurable (not mock-locked)

The provider is a **declared dependency** reached through the `self <- …` seam; the concrete
backend is config-bound (`SPEC.md` §17). `mock` is just one backend behind the `Provider`
interface in `src/runtime.ts`. The manifest (`agape.toml`) selects the backend:

```toml
[provider]
backend = "anthropic"   # or openai / gemini / mock
model   = "claude-…"
```

- `exposes_logprobs` is **derived** from the backend (anthropic=false, openai/gemini=true, §17.1).
- A backend with token logprobs yields per-variant scores directly; one without (anthropic) is
  served by the **sampling fallback** — draw the forced choice `fallback_samples` times and use the
  empirical frequency (§16.8). Both paths live in `RemoteProvider` in `src/config.ts`.
- Secrets come from the environment (`ANTHROPIC_API_KEY`, etc.), never the manifest.

For conformance, the harness injects a deterministic/scripted provider (the mock), so runs are
replay-stable (same scripted judgment → identical chain-head). Live API calls run through the same
seam on an async execution path.

## What's implemented (v0)

agents + lifecycle (`spawn`/`awake`/`on awake`), the send `<-` bound to a `Credence<E>` slot,
`decide c by confidence θ [margin δ]` (+ a conformal/principal stub), the `endorse subject by d { … }`
arm sugar, `perform`/`emit`/`say`/`if`, enums/actions/events, default-deny `grants`, the
consequential-action rule (settled + committed-narrowed at a sink; `Endorsement<T>` coerces to its
subject), and a hash-chained ledger with a `chain-head`.

Not yet: the full static checker, `when`/memory/tools/modules, the principal/identity backend, and
the conformance harness directives.
