# Shipping Agape — distribution, the CLI toolchain, and config (DRAFT v0.1)

> **Status.** Design for how Agape is packaged and shipped: a single-binary
> project-manager CLI with the compiler built in, a project manifest + layered
> config, and a `serve` protocol that frontends (e.g. the Agape Studio IDE) attach
> to. Forward-looking; the Rust implementation is the intended vehicle.
> Cross-refs: the provider seam (SPEC §0, §8), the reproducibility model
> (SPEC §15.5), thesis #8 ("swap the config").

---

## 1. Two shipping stories (the cognition twist)

Agape is unusual: the **provider seam** means an agentic program *calls a model at
runtime*. So shipping splits in two:

- **Somatic Agape** — the compiler, the stdlib, any `#!somatic`/all-`sync`
  program. Deterministic, no cognition. **Ships like any normal language**: a
  binary, runs offline, anywhere.
- **Agentic Agape** — also needs a provider at runtime. The **mock** provider
  ships *in-box* (deterministic, offline) and is the default, so a fresh install
  runs out of the box with no key. Real cognition (Anthropic, or a local model) is
  **configured, not bundled** — you bring an API key the way you bring a database
  connection string.

The mock-in-box default is what keeps the offline/somatic case feeling like an
ordinary language while real cognition is one config step away.

---

## 2. The toolchain: a project-manager CLI with the compiler built in

Agape ships as **one tool that owns the project lifecycle** — the
`cargo`/`deno`/`bun` shape, not a bare compiler. The `lex → parse → check → run`
pipeline lives *inside the binary*, and the stdlib is **embedded** into it (Rust
`include_str!`), so distribution is a single self-contained download.

```
<cli> new <name> / <cli> init    scaffold: writes the manifest + main.ag
<cli> run [file]                 lex → parse → check → interpret (project entry by default)
<cli> check [file]               static guarantees only (authority/taint/color + types)
<cli> repl                       interactive
<cli> fmt                        formatter
<cli> config <key> <value>       manage provider / model / θ
<cli> serve                      run the project as a live service a frontend attaches to (§4)
<cli> build                      (later) emit an artifact — somatic layer to native
<cli> add <dep>                  (later) package management
```

(The CLI's *name* is an open question — see §7.)

---

## 3. Configuration — owned by the release, managed via the CLI

Config is **project state the toolchain manages**, not user-hand-wired wiring.
Two scopes, mirroring cargo:

```toml
# agape.toml  —  PROJECT scope (committed; pins behavior for reproducibility)
[project]   name = "my-app"   entry = "main.ag"
[provider]  backend = "mock"  model = "claude-haiku-4-5"   # default ships as mock
[runtime]   threshold = 0.8                                # θ for ~ similarity
```
```toml
# ~/.agape/config.toml  —  GLOBAL/user scope (NOT committed)
default_provider = "anthropic"
```

Three principles to lock in:

1. **Provider is swappable by config, never by source.** The same `.ag` runs on
   mock or Anthropic by flipping the manifest — thesis #8 ("swap the config")
   realized at the toolchain level.
2. **Secrets stay out of the manifest.** `agape.toml` *references* a provider; the
   API key comes from env / OS keychain. The manifest is safe to commit.
3. **The project pins provider + model; the key is global.** Reproducibility
   (SPEC §15.5) only holds up to `≈` if the model is pinned, so pinning belongs in
   the *project* manifest. Mock-in-box means a fresh clone runs offline with zero
   setup.

---

## 4. The `serve` protocol — the frontend contract

The CLI is the **engine**; a frontend (the Agape Studio IDE) is a **client**. The
frontend must not reimplement the runtime — it attaches to a stable interface that
`<cli> serve` exposes. That interface is the contract between the toolchain and any
frontend, and it should be pinned **before** the two efforts drift:

- **spine stream** — events out: the live append-only log the frontend renders.
- **eval** — run a snippet in the project's accumulated context (guarantees
  re-checked incrementally), returning the resulting events.
- **lifecycle control** — load a program; `spawn`/`awake`/`sleep`; quiesce.

This lines up with where the IDE is already headed: its Phase-2 plan (a backend
written *in Agape* on a `listen` HTTP sensor — the socket sensor foreshadowed in
SPEC §5b) is literally "`serve` runs an Agape program that serves." Defining the
protocol once lets the Python-backend-now and Agape-backend-later versions
implement the same contract.

---

## 5. Execution model (the honest part)

Agape can't compile to a fully-static native binary the way C does — **cognition
can't be inlined.** A `<-` send is always a runtime call to a provider; the spine,
mailboxes, and agent lifecycle are runtime services. So *every* Agape artifact
links against a **runtime** that owns the spine + the seam — exactly Go's model
(compiled code + a linked runtime), with the spine and provider added.

Consequence: **ship interpreted-first.** A single binary that tree-walks, with the
runtime + mock provider inside, is a legitimate release (Python, Ruby, Node all
shipped interpreted for years). Native **codegen is a later optimization, and only
ever touches the somatic layer** — the agentic layer stays a runtime library.

---

## 6. Implementation — Rust is the vehicle

No rethink of the architecture; Rust is the right home *because* the CLI wants a
single static binary with the stdlib embedded. Path to shippable:

1. **Finish the Rust tree-walking interpreter** (`agape/src/eval.rs`) — the engine
   that runs the full language end to end (the Python POC is the reference oracle,
   not the shipped artifact — it distributes badly).
2. **Wrap it in the CLI surface** (§2), e.g. with `clap`.
3. **Manifest + two-scope config + provider selection** (§3).
4. **`serve`** exposing the spine stream + eval + control (§4).

Native codegen stays deferred. The Python POC remains the cross-validation oracle.

---

## 7. Build & release pipeline

`scripts/package.sh` is the package-and-ship pipeline. It reads the version from
`agape/Cargo.toml` (single source of truth), builds the release binary, and stages
a self-contained tree — `bin/agape` + the `std/` library + a runnable example + a
default `agape.toml` + a README — then archives it to
`dist/agape-<version>-<target>.tar.gz` with a SHA256 sidecar:

```sh
bash scripts/package.sh
```

It is verified by extracting the archive to a clean directory and running the
*shipped* binary (`./bin/agape run examples/hello.ag`) with no repo, source tree,
or dependencies present — i.e. exactly what a user gets.

**Status (implemented).** `scripts/package.sh` exists and stages the bundle:
`bin/agape` (release binary) + `examples/hello.ag` + a default `agape.toml` +
README, and — when Node is present — the **studio** (`studio/web-dist` built by
Vite + `studio/agent-server`, deps installed). In a bundle the agent-server
*also serves the built web app* (`AGAPE_WEB_DIST`), so `agape studio` is a single
process with no Vite at runtime. CI (`.github/workflows/ci.yml`) gates every push
on build + test + 102/102 conformance + manifest-sync + studio build;
`release.yml` runs `package.sh` on `ubuntu`/`macos`/`windows` on a `v*` tag and
attaches the archives to a GitHub Release.

Later: cross-compiled targets beyond the three native runners, embedding `std/`
into the binary (`include_str!`) once the Rust front-end gains module support, an
npm wrapper for `npm i -g agape`, and a LICENSE (currently held off) before any
public release.

## 8. Open questions

- **CLI name — decided: unified `agape`** (one binary, the go/deno model). The
  name `agora` is reserved for the package *registry* if/when one lands.
- **`serve` transport** — HTTP+SSE / WebSocket / something else; the exact event
  schema for the spine stream.
- **Package registry & dependency resolution** — out of scope for v0.2; the
  manifest leaves room (`[dependencies]`) for it.
- **Local-model provider** — the third backend behind the seam, after mock and
  Anthropic.
