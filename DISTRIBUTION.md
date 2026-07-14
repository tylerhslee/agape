# Shipping Agape — distribution, the CLI toolchain, and config (DRAFT v0.1)

> **Status.** Design for how Agape is packaged and shipped: a single-binary
> project-manager CLI with the compiler/runtime built in, a project manifest +
> layered config, and a `serve` protocol that frontends (e.g. Agape Studio) attach
> to. The current base release vehicle is the TypeScript implementation.
> Cross-refs: the provider seam (SPEC §0, §8), the reproducibility model
> (SPEC §15.5), the runtime contract (SPEC §16–§17), thesis #8 ("swap the config").

---

## 1. Two shipping stories (the cognition twist)

Agape is unusual: the **provider seam** means an agentic program *calls a model at
runtime*. So shipping splits in two:

- **Somatic Agape** — the compiler, the stdlib, any `#!somatic`/all-`pure`
  program. Deterministic, no cognition. **Ships like any normal language**: a
  CLI/runtime package, runs offline, anywhere.
- **Agentic Agape** — also needs a provider at runtime. The **mock** provider
  ships *in-box* (deterministic, offline) and is the default, so a fresh install
  runs out of the box with no key. Real cognition (Anthropic, or a local model) is
  **configured, not bundled** — you bring an API key the way you bring a database
  connection string.

The mock-in-box default is what keeps the offline/somatic case feeling like an
ordinary language while real cognition is one config step away.

---

## 2. The toolchain: a project-manager CLI with the compiler built in

Agape ships as **one tool that owns the project lifecycle**: the
`deno`/`bun` style of an executable runtime, not a bare compiler. The
`lex -> parse -> check -> run` pipeline lives inside the TypeScript CLI/runtime,
so distribution can be a packaged Node executable or source checkout without any
separate project.

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
It is also Agape's ecosystem integration surface: `.ag` source declares
dependencies, and config binds those declarations to existing model APIs,
identity systems, MCP/tool servers, prompt sources, memory policy, and deployment
endpoints. Two scopes:

```toml
# agape.toml  —  PROJECT scope (committed; pins behavior for reproducibility)
[project]   name = "my-app"   entry = "main.ag"

[provider]
backend = "mock"                 # default ships in-box and runs offline
model = "mock-deterministic"
temperature = 0
fallback_samples = 10
fallback_temperature = 0.7

[identity]
backend = "local-keyring"

[memory]
driver = "markdown"
path = ".agape/memory"
auto_memory = true

[tools]
payments = { mcp = "https://payments.internal/mcp" }

[prompts]
request = { source = "http", path = "/requests" }
```
```toml
# ~/.agape/config.toml  —  GLOBAL/user scope (NOT committed)
default_provider = "anthropic"
```

Three principles to lock in:

1. **Provider is swappable by config, never by source.** The same `.ag` runs on
   mock, Anthropic, OpenAI, Gemini, or a local connector by flipping the manifest
   — thesis #8 ("swap the config") realized at the toolchain level.
2. **Secrets stay out of the manifest.** `agape.toml` *references* a provider; the
   API key comes from env / OS keychain. The manifest is safe to commit.
3. **The project pins provider + model; the key is global.** Reproducibility
   (SPEC §15.5) only holds up to `≈` if the model is pinned, so pinning belongs in
   the *project* manifest. Mock-in-box means a fresh clone runs offline with zero
   setup.
4. **Decision policy lives in source.** Thresholds, margins, floors, conformal
   `α`, and readiness are `policy` declarations or inline gate rules, not hidden
   manifest knobs. Config binds dependencies; source declares the decision theory.

---

## 4. The `serve` protocol — the frontend contract

The CLI is the **engine**; a frontend (the Agape Studio IDE) is a **client**. The
frontend must not reimplement the runtime — it attaches to a stable interface that
`<cli> serve` exposes. SPEC §16–§17 is the cross-runtime contract (and §16.9 the
runtime API surface); this interface is the transport/API shape the toolchain
exposes to frontends, and it should be pinned **before** the two efforts drift:

- **ledger stream** — events out: the live append-only log the frontend renders.
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
can't be inlined.** A `<-` send is always a runtime call to a provider; the ledger,
mailboxes, and agent lifecycle are runtime services. So *every* Agape artifact
links against a **runtime** that owns the ledger + the seam — exactly Go's model
(program code + a runtime), with the ledger and provider added.

Consequence: **ship interpreted-first.** A single CLI package that tree-walks, with the
runtime + mock provider inside, is a legitimate release (Python, Ruby, Node all
shipped interpreted for years). Native **codegen is a later optimization, and only
ever touches the somatic layer** — the agentic layer stays a runtime library.

---

## 6. Implementation - TypeScript is the base vehicle

No rethink of the architecture; the current shippable base is the TypeScript
runtime in `agape-ts`. Path to shippable:

1. Keep `lex -> parse -> check -> run` in `agape-ts` as the vanilla runtime.
2. Wrap it with the `bin/agape` package script in release bundles.
3. Keep provider, tool, memory, and prompt bindings manifest-driven.
4. Expose Studio/project operations through the local agent-server seam.

Native codegen stays deferred. Other runtime implementations can exist as
separate projects, but they are not part of the base Agape installation.

---

## 7. Build & release pipeline

`scripts/package.sh` is the package-and-ship pipeline. It reads the version from
`agape-ts/package.json`, stages `agape-ts`, installs its Node dependencies inside
the staged tree, writes a `bin/agape` wrapper, adds examples, a default
`agape.toml`, and a README, then archives it to
`dist/agape-<version>-<target>.tar.gz` with a SHA256 sidecar:

```sh
bash scripts/package.sh
```

It is verified by extracting the archive to a clean directory and running the
shipped wrapper (`./bin/agape run examples/hello.ag`) with no repo path.

**Status (implemented).** `scripts/package.sh` stages the TypeScript CLI/runtime,
examples, default markdown memory manifest, and, when Node is present, Studio
(`studio/web-dist` built by Vite plus `studio/agent-server` source without
`node_modules` or runtime data). The agent-server can serve the built web app via
`AGAPE_WEB_DIST`, so Studio can run as one local process with no Vite at runtime.

- **Studio launcher.** `bin/agape studio` launches the full React Studio when a
  web build is available — `AGAPE_WEB_DIST`, or the bundle-relative
  `studio/web-dist` staged by `package.sh` — by starting the agent-server
  (installing its dependencies on first run) with the web app mounted. Without a
  build, or with `--inspector`, it serves the embedded single-file inspector; it
  prints one line saying which Studio it launched.
- **Version checking.** `scripts/check-version.mjs` treats `VERSION.md` as the
  source of truth and understands both prerelease channels (`alpha` and `beta`),
  flagging any stale reference on either channel; `--root <dir>` checks a
  non-repo tree (e.g. a release-rehearsal copy). The smoke/E2E fixtures derive
  the language version from `agape-ts/package.json` instead of hardcoding it,
  and `agape-ts` dependencies are pinned to caret ranges (no `latest`).

Later: more packaged executable targets, an npm wrapper for `npm i -g agape`, a
package registry, and a LICENSE before any public release.
## 8. Open questions

- **CLI name — decided: unified `agape`** (one binary, the go/deno model). The
  name `agora` is reserved for the package *registry* if/when one lands.
- **`serve` transport** — HTTP+SSE / WebSocket / something else; the exact event
  schema for the ledger stream.
- **Package registry & dependency resolution** — out of scope for v0.2; the
  manifest leaves room (`[dependencies]`) for it.
- **Local-model provider** — the third backend behind the seam, after mock and
  Anthropic.
