# Agape — the real (compiled) language

This crate is the production implementation of Agape, kept deliberately separate
from the Python POC in `../poc/`. The POC pins down the semantics; this is where
the language is built for real.

## Why Rust (and not Elixir)

Agape's runtime model — first-class agents with mailboxes, a spawn/awake/sleep
lifecycle, async-by-default message passing, and an append-only event spine — is
an almost exact description of the BEAM/OTP actor model. Elixir was a serious
candidate, and for a purely *hosted* runtime it might still be the shortest path:
processes are mailboxes, supervision trees give fault tolerance, and the spine is
event-sourcing the BEAM already supports.

We chose **Rust** anyway, for three reasons:

1. **This is "AIOS" — an OS context.** The goal is a language that compiles to a
   native artifact and can eventually sit at the substrate level. You don't build
   an OS layer on a managed VM.
2. **"A proper compiled language" means owning the pipeline.** Lexer → parser →
   type checker → IR → codegen. Rust is built for writing that pipeline (and can
   target Cranelift/LLVM later); Elixir would have us building Agape *on top of*
   the BEAM rather than compiling it.
3. **The two-color (`sync`/async) model and structured concurrency** map cleanly
   onto Rust's own async and ownership story, which lets the type checker enforce
   the cognition-freedom guarantee the language promises.

The BEAM's actor semantics aren't lost — they become a design target for the
runtime we build in Rust (the spine, mailboxes, and supervision are modeled
explicitly rather than inherited from a VM).

## Layout

```
agape/
  src/
    token.rs     Token kinds and the Token type.
    lexer.rs     Source → tokens. Faithful port of the POC lexer.
    ast.rs       The abstract syntax tree.
    parser.rs    Tokens → AST (recursive descent).
    spine.rs     The event spine: the append-only source-of-truth log.
    provider.rs  The cognition seam (Provider trait) + a deterministic mock.
    lib.rs       Crate root.
    main.rs      The `agape` CLI.
  examples/
    hello.ag     The canonical program (mirrors ../poc/hello.ag).
    basics.ag    The slice the parser fully supports today.
  tests/
    frontend.rs  Integration tests against the example programs.
```

## Using it

```sh
cargo run -- lex   examples/hello.ag    # tokenize (645 tokens, matches the POC)
cargo run -- parse examples/basics.ag   # parse to AST
cargo run -- check examples/basics.ag   # lex + parse, report only
cargo test                               # unit + integration tests
```

## Status

**Front-end + runtime foundations.** What works today:

- **Lexer** — complete. Cross-checked *token-for-token* against the verified POC
  lexer on the full `hello.ag` (645 tokens, zero mismatches).
- **Parser** — parses the **entire canonical `hello.ag`** (44 top-level
  statements). Covers scalar/`event` types, `sync`/async function declarations,
  agents (headers, fields, `extend`, `on awake`/`on sleep` hooks), variable
  declarations and assignment, `spawn`/`awake`/`sleep`, `verify` (statement and
  expression forms), `emit`, `say`, `return`, `if`/`else`, the reactive blocks
  `when`/`catch`/`case`/`retry` (block and trailing-send forms), the query
  statements `find`/`select`/`match`, and the full expression precedence ladder
  (send `<-`, pipe `|>`, entail/`~`, comparison, arithmetic, unary, postfix
  call/member).
- **Spine** — the append-only event log with system-assigned monotonic ticks and
  Started/Resolved correlation (the pending set falls out of it).
- **Provider seam** — the `Provider` trait plus a deterministic `MockProvider`,
  so the runtime can be exercised offline.

## Roadmap

In rough dependency order:

1. **Type checker** — the two locked invariants: `sync` cannot reach the seam and
   only calls `sync`; `event<T>` vs bare `T`; `case` exhaustiveness; the
   type → JSON-Schema bridge for structured output.
2. **Tree-walking interpreter** — drive the spine, the provider seam, agent
   lifecycle, subscriptions, and per-agent memory (mirroring the POC), so the
   real implementation runs `hello.ag` end to end.
3. **A real `AnthropicProvider`** — structured output via constrained decoding,
   per-agent conversation memory (as the POC already does).
4. **IR + codegen** — lower the AST to an IR and emit a native artifact (the
   point of choosing Rust). Until then the interpreter is the execution model.
