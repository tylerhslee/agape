# Changelog

All notable changes to Agape are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project follows
[Semantic Versioning](https://semver.org). The language/runtime, the conformance
suite, and the studio move in lockstep — a release is the whole bundle at one
version.

## [1.0.0] — 2026-06-27

The first canonical release: the Agape language, compiler, runtime, and studio,
packaged as one self-contained `agape` CLI. Agape governs multi-agent systems —
model output is *testimony* with no authority until a calibrated gate endorses it,
and every effect is recorded on an append-only **ledger**.

### Language & runtime
- A clean-room Rust implementation (lexer → parser → checker → interpreter + the
  event **ledger**) passing the full conformance suite — **144/144**, a hard CI gate.
- **The decision surface** — testimony → `Credence<E>` (a graded judgment over a
  closed enum, read from the provider's token probabilities) → a gate (`endorse` /
  `attest` / the readable `decide`, by `c by R` / `conformal α`) → a settled
  `Decision` that alone may drive a `perform` action. Static checks reject
  unauthorized authority, un-endorsed (tainted) values at consequential sinks, and
  ill-typed gates before anything runs.
- **The ledger** — a hash-chained, append-only, tamper-evident event log (the
  objective shared record of what happened), queried deterministically by
  `select … from ledger` and `find … where`. A deterministic scheduler/tick
  cascade, plus injectable seams (cognition / memory / ledger) for test-mode,
  replay, and fault injection.

### Library layer (§19)
- **Modules & imports** — `module path;`; `import m;` / `import m as x;` /
  `import { a, b } from m;`; `pub import` re-export; packages via `[package]` /
  `[dependencies]` in `agape.toml`.
- **Namespacing & visibility** — fully-qualified event types; `pub` (default
  module-private) governs *names, not the ledger* (a private event still lands on
  the ledger for audit; `pub` is shallow).
- **Generics & interfaces** — type parameters on `struct`/`fn`, monomorphized;
  `interface I { when EVENT decide RESULT; requires CAP }` with nominal conformance
  (an implementor is a subtype); single-level **error subtyping** (`event Foo(..) : Error;`).

### The readable decision gate (§20)
- A surface where intent plus one fact about stakes derives and enforces the
  decision theory: `reversible` marks a consequential sink; `decide { … }` carries
  commit / `default:` / `defer` arms with a principal for the contested case; one
  `conformal α` dial sets the error guarantee (file, per-gate, or manifest scope).
  A non-reversible arm with no reachable principal is a **compile error**. It
  desugars to the `endorse` / `c by R` engine, which remains for hand-calibration.

### Compile-time behavior (§5) and private memory (§10)
- **`instruction "…";`** — a compile-time system prompt: global at the top level, or
  agent-scoped (composing after the global block). Procedural behavior lives in
  *source*, versioned and reviewable — no recalled fact or injected memory can
  rewrite it; to change behavior, ship a new version.
- **`mem` private memory** — `mem m <- v` writes a handle, `m -> "q"` recalls,
  `forget m` is an audit-preserving tombstone. A recall is **always tainted**
  (taint-equivalent to a send reply): memory cannot launder trust, so a recalled
  value must be re-gated before it reaches a consequential sink. The ledger, by
  contrast, is the objective record and reads back at recorded trust.

### Gate providers (§17)
- Pluggable LLM backends for the gate's `Credence`: **OpenAI** and **Gemini** read
  per-variant mass from token **logprobs** (OpenAI Chat-Completions `top_logprobs`,
  Gemini enum-mode `responseLogprobs`); **Anthropic** exposes no logprobs and is
  served by the **sampling fallback** (draw the forced choice N times, take the
  empirical frequency). `exposes_logprobs` is **derived from the backend**, not
  hand-set; API secrets bind from the environment, never the manifest.

### CLI & studio
- `agape init` / `run` (`--prompt` / `--claude` / `--samples` / `--temperature` /
  `--json`) / `check` (static guarantees only) / `build` / `configure` / `studio`.
  The mock provider ships in-box, so `run` works offline with no API key; a live
  model is one `configure` step away.
- A project-aware IDE: inspect, edit, and run a project's agents, with a question →
  verified-answer view over the ledger; offline on the deterministic mock provider
  or against a live model. One-process bundle mode (the agent-server serves the
  prebuilt web app — no Vite at runtime).

### Packaging & CI
- `scripts/package.sh` builds a portable, self-contained bundle (binary + studio +
  a runnable example + default `agape.toml`), archived with a SHA-256 sidecar and
  verified by running the *shipped* binary with no repo present.
- `ci.yml` builds and tests the language and gates on conformance (**144/144**) and
  manifest drift; `release.yml` builds the bundle for Linux, macOS, and Windows on a
  `v1.0.0` tag and publishes a GitHub Release.

[1.0.0]: https://github.com/tylerhslee/agape/releases/tag/v1.0.0
