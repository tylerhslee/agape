# Agape — Implementation Handoff (for Claude Code)

This is a POC interpreter for **Agape**, an agentic programming language. The
authoritative language reference is **`SPEC.md`** — read it fully before writing
code. The canonical program to make run is **`hello.ag`** (it teaches the whole
language top to bottom; if you understand it, you understand Agape).

## Goal

Make `hello.ag` run **end-to-end on a mock provider** and print the full event
spine at the end. Then ensure swapping `MockProvider` → `AnthropicProvider`
(one line + an API key) runs the same source against real cognition.

This is a **POC in Python**. It will later be rewritten in Rust and turned into a
compiled language for an OS — so keep the architecture clean and the phases
separable, but don't gold-plate.

## What is already built and TESTED (reference implementations — reuse these)

- **`agape/spine.py`** — the event spine. THE most important component. Provides:
  - `Spine.append / started / resolved` (system-assigned monotonic ticks;
    Started/Resolved pairs correlated by `corr`).
  - `Spine.subscribe(etype, subject, handler, polarity)` — the single mechanism
    behind both `when` and `catch`. Retroactive (most-recent match at
    registration) + prospective (once per new match). This matches the LOCKED
    semantics in SPEC §7.
  - `Spine.query / pending / dump`.
  - Subject matching via `_subject_eq` (uses a `.subject_key` for stable
    identity; see SPEC §7 on subjects as correlation keys).
- **`agape/lexer.py`** — full lexer. Verified to tokenize `hello.ag` cleanly
  (631 tokens). Handles `//` comments, strings, f-strings (`FSTR` token),
  numbers, identifiers/keywords, and the operator set incl. `<- |> >= <= == !=`.
  There is exactly ONE send arrow `<-`; there is no `->`.
- The **type → JSON Schema bridge** was prototyped and tested separately
  (bool/enum/struct/array all round-trip; constrained-decoding model; NO regex
  fallback). Re-implement it as `agape/schema.py` following SPEC §8. (The proven
  prototype logic: each Agape type compiles to a JSON Schema; the provider must
  return schema-conforming JSON via constrained decoding; parse back to a typed
  value; on non-conformance raise `TypeMismatch`.)

## What to build (order matters — see SPEC §13)

1. **`agape/ast_nodes.py`** — AST dataclasses for every construct in SPEC.
2. **`agape/parser.py`** — recursive-descent parser, tokens → AST. Grammar notes:
   - Function: `[sync]? RET_TYPE NAME(params) { body }` (type-first; `sync` is
     the only color keyword; async is default).
   - `event<T>` is a type; `T` may be scalar, struct, enum, or `event<...>`-free
     inner type. `event<null>` is valid.
   - Agent: `agent NAME(params) { fields; ctor stmts; when(...){} on awake{}
     on sleep{} }`, optional first `extend PARENT(args);`.
   - Statements: var decl (`TYPE NAME = EXPR;`), `spawn`, `awake`, `sleep`,
     `<-` send, `verify`, `emit`, `find/where`, `select/from/where`, `match`,
     `case`, `if/else`, `retry` (block form and trailing send form), `catch`,
     `when`, `return`, expression-statements, `say`.
   - `catch EVENT_TYPE(subject) as e { }` and `when (subject) { }`.
   - Expressions: literals, f-strings, identifiers, calls, `~`, `entail`, `|>`,
     `all`/`any`, arithmetic, comparisons, `!`, member access (`a.b`, `self.x`),
     `EventType(subject)` retrieval calls.
3. **`agape/schema.py`** — type → JSON Schema + response → typed value (SPEC §8).
4. **`agape/provider.py`** — `Provider` interface with `think(prompt, schema)` and
   `embed(text)`. Implement:
   - `MockProvider`: `think` uses **keyword rules** (deterministic; see below),
     `embed` uses **hash-based pseudo-vectors** (deterministic, cosine-comparable).
   - `AnthropicProvider`: uses `messages.create(..., output_config={"format":
     {"type":"json_schema","schema": <schema>}})`. Constrained decoding; no
     fallback. (Beta header / model per current Anthropic docs.)
5. **`agape/memory.py`** — per-agent memory: SQLite (facts) + NetworkX (graph) +
   a vector store (numpy or pure-Python cosine). Implicit internalization on every
   received `<-`, using the **controlled vocabulary**: SPO triples + typed
   predicates (`is_named`, `beats`, `is_a`, `result_for`). Query ops `find/where`,
   `select/from/where`, `match` fan out across all agents (SPEC §10).
6. **`agape/interpreter.py`** — tree-walking evaluator over the AST, driving the
   spine, the provider seam, agent lifecycle, subscriptions, and memory.
7. **`agape/typecheck.py`** (can be folded into the parser/interpreter for the
   POC) — enforce: `sync` cannot touch the seam and only calls `sync`;
   `event<T>` vs bare `T` per SPEC §1; `case` exhaustiveness.
8. **`run.py`** — entrypoint: `python run.py hello.ag [--provider mock|anthropic]`.
   Runs the program, prints the final spine via `Spine.dump()`.

## Mock provider keyword rules (so both pass and fail paths are testable)

Make these deterministic and tuned so `hello.ag` exercises both branches:
- Identity: a `<- "What is your name?"` to an agent seeded with name N returns
  `"My name is N."` (so `~ "John"` passes and `== "John"` can be made to pass/fail
  as you choose for the demo).
- Role confirmations (`"Are you a poker coach?"`) return `true` for the matching
  role, `false` otherwise.
- Rules (`"Does a flush beat a straight?"`) return an affirmative text.
- `entail` returns `Entailment` when the answer affirms the claim, `Contradiction`
  when it denies, else `Neutral`. Key off seeded facts (`beats(flush, straight)`).
- `~` similarity = cosine of hash pseudo-vectors, thresholded (default ~0.8; pick
  so the demo's intended passes/fails land correctly; SPEC allows tuning).

## Invariants you must NOT violate (SPEC §15)

- The log is the source of truth; nothing that matters happens off the spine.
- No hidden runtime: `retry`, `case`, etc. desugar to primitives.
- Ticks are system-level, monotonic, never agent-controlled.
- Constrained decoding is mandatory; **no regex fallback** anywhere.
- `sync` is marked; async is default; `sync` can't reach cognition.
- `event<T>` = spine presence, orthogonal to async.
- `~` returns `bool`; `verify`/`entail` emit to the spine.
- Verdict types (`Verification`, `Verdict`) are concrete, not generic.

## Open design points (SPEC §14) — leave as TODOs, don't invent

Subject granularity for routine errors; `|>` cancellation; optional struct
fields; distributed ticks; internalization semantic stability. POC picks the
simple option for each (documented in SPEC §14).

## Run

```
python run.py hello.ag                 # mock provider (default)
python run.py hello.ag --provider anthropic   # needs ANTHROPIC_API_KEY
```
