# AIOS — Agape

This repository contains the **Agape** language: a programming language for
multi-agent systems where agents are first-class, cognition is a swappable
substrate reached through a provider *seam*, and *meaning* is checkable
(`~`, `verify`, `entail`). Two ideas sit under everything: an append-only
**event spine** that is the source of truth, and a **provider seam** that lets
you swap the model (mock → Anthropic → local) without changing any Agape source.

The canonical program is **`poc/hello.ag`** — it teaches the whole language top
to bottom. If you understand it, you understand Agape.

## Repository layout

| Path | What it is |
|------|------------|
| `SPEC.md` | The authoritative language specification. |
| `poc/` | **The Python POC interpreter** — the working demo. Runs `hello.ag` end-to-end on a mock provider or the real Anthropic API. This is throwaway-grade reference code that pins down the semantics. |
| `agape/` | **The real, compiled language** — a Rust implementation (lexer → parser → … → codegen). This is where the language is being built for real, kept deliberately separate from the Python demo. |
| `AIOS_MVP_DESIGN.md`, `COMPETITIVE_LANDSCAPE.md` | Design notes. |

## Running the Python POC

```sh
cd poc
python run.py hello.ag                       # mock provider (deterministic, no API key)
python run.py hello.ag --provider anthropic  # real cognition (needs ANTHROPIC_API_KEY)
```

The mock provider is keyword-driven and fully deterministic. The Anthropic
provider gives every agent its own conversation memory, uses structured output
(constrained decoding) for typed replies, and serves `~`/`entail` with real
model judgments. Both run the *same* `hello.ag` source unchanged — that is the
provider seam working as designed.

## Building the real language

See `agape/README.md`. The short version:

```sh
cd agape
cargo run -- lex   examples/hello.ag   # tokenize
cargo run -- parse examples/hello.ag   # parse to AST
cargo test                              # run the compiler test suite
```

## Status

- **POC (`poc/`)** — `hello.ag` runs end-to-end on both the mock and the real
  Anthropic API. The event spine, agent lifecycle, `when`/`catch` subscriptions,
  similarity/entailment checks, `find`/`select`/`match` queries, and `retry` all
  work.
- **Real language (`agape/`)** — in progress. The lexer and parser front-end are
  underway; the spine runtime, provider seam, type checker, and codegen are the
  road ahead (see `agape/README.md` → Roadmap).
