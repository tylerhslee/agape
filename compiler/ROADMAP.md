# Roadmap — the self-hosted somatic-Agape compiler (compiler v0.1)

> **Goal.** `compiler/` holds `lexer.ag`, `parser.ag`, `checker.ag`, and a driver
> that together replicate the Rust front-end (lex → parse → the three-guarantee
> static checks) — **written in somatic Agape**, runnable on the POC interpreter,
> and cross-validated against the Rust `agape/` crate on the example programs.
>
> **Method.** Each milestone = (somatic-kernel feature(s) landed) + (compiler phase
> advanced) + (a commit). The kernel grows only as a phase demands it — the
> compiler is the forcing function (SOMATIC_KERNEL.md §7). The discipline holds:
> before extending the core, ask "can this be a library?" — if yes, it's stdlib.
>
> **Correctness oracle.** The Rust front-end's accept/reject verdicts and token
> counts on `examples/*.ag` are ground truth; each phase is done when it matches.

## Milestones

| # | Milestone | Kernel feature(s) | Phase deliverable | Status |
|---|-----------|-------------------|-------------------|--------|
| **M1** | Data core + minimal lexer | `while`/`break`, `array<T>` (index, `len`/`push`) | `lexer.ag` tokenizes ID/INT/OP; stdlib `and`/`or` + char-classification | **DONE** (b61cddd) |
| **M2** | Tagged unions | `enum` decls + `case` payload destructuring (#3) | a real `Token` type; `case` over token kinds; exhaustiveness over user enums | **DONE** |
| **M3** | Records + full lexer | recursive `struct` (#2) | `Token{kind,value,line,col}`; full token set (keywords, multi-char ops, strings, f-strings, comments, positions); token count matches Rust | next |
| **M4** | Collections | `List`/`Map` stdlib on `array`; AST as enum/struct | the AST type (recursive ADT); `Map` symbol-table | |
| **M5** | The parser | — | `parser.ag`: tokens → AST (recursive descent), sub-bites expr → stmt → decl; parses the examples | |
| **M6** | The checker | — | `checker.ag`: authority/taint/color + exhaustiveness in Agape; matches the Rust checker on examples + violations | |
| **M7** | Self-hosting | modules (#6) ✅ + FFI (#7) | **modules + `#!somatic` done** (`std/bool`, `std/char` shipped); FFI (read source from a file) + `agc.ag` driver still pending | partial |
| **M8** | Typing | user generics (#5) | `List<T>`/`Map<K,V>` as proper generic stdlib; tighten static types | |

## Release

Tag **agape v0.2** + **compiler v0.1** once M5–M7 land — a working, self-hosted
front-end that lexes, parses, and statically checks Agape, written in Agape.

## Sequencing notes

- The POC interpreter is dynamically typed, so the **type system can lag**:
  `List`/`Map` work on dynamic arrays *now*; user generics (M8) only *harden* them.
- **FFI (M7)** is needed only to read real source files; until then phases are
  driven from an embedded/literal program.
- Each milestone stays **green** (POC `test_guarantees` 7/7, `hello.ag` runs) and
  is **cross-checked** against the Rust front-end before its commit.
