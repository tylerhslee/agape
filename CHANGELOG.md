# Changelog

All notable changes to Agape are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project follows
[Semantic Versioning](https://semver.org). The language/runtime, the v1.0
conformance suite, and the studio move in lockstep — a release is the whole
bundle at one version.

## [1.0.1] — 2026-06-27

A test-and-pipeline patch. **No language, compiler, runtime, or spec changes**:
the `agape` binary is functionally identical to 1.0.0 (only its reported version
differs). What's new is a real studio test suite and a CI pipeline that gates on
it — so future studio changes can't regress the shipped user journeys unnoticed.

### Added
- **Studio test pyramid**, run as a hard gate in CI:
  - **Unit** — `studio/agent-server/lib.test.ts` covers the pure helpers,
    including path-traversal cases for `safeProjectPath` (the guard that keeps
    `/project/file` from escaping the project root or reading non-`.ag` files).
  - **Integration** — `studio/agent-server/server.integration.test.ts` boots the
    real agent-server against an `agape init` project and drives the journeys end
    to end: health, project info/agents, a mock run returning a decided + verified
    reply, a rejected program surfacing `ok:false` (not a crash), and a rejected
    path traversal.
  - **End-to-end** — `studio/web/e2e/studio.spec.ts` (Playwright) drives a real
    browser against the served app and the real binary: ask a question, get a
    ✓-verified answer, and see the gate decision + delivered reply recorded on the
    spine.
  - `studio/TESTING.md` — the testing strategy plus a J1–J9 user-journey
    inventory, each journey mapped to the test that covers it.
- `@playwright/test` dev dependency, an `e2e` npm script, and a Playwright config
  (`playwright.config.ts`) with a `serve.mjs` launcher that boots the bundle path.

### Changed
- **CI gates on the studio tests.** The `studio` job now runs both Vitest suites
  (agent-server + web) with JUnit reporting and uploads the results, and a new
  `e2e` job builds the binary + web app and runs Playwright. Previously CI only
  *built* the studio. (`.github/workflows/ci.yml`)
- **Agent-server refactor — behavior preserving.** The pure helpers `pickVariant`,
  `agentsAndPrompts`, and `safeProjectPath` were lifted out of `server.ts` into a
  new `studio/agent-server/lib.ts` so they can be unit-tested in isolation;
  `server.ts` now imports them. No runtime behavior changed.
- Vitest is scoped to `studio/web/src/` so it no longer tries to execute the
  Playwright `*.spec` files (both tools claim `.spec`).

### Chore
- Ignore test output (`test-results/`, `playwright-report/`).
- Commit the `package-lock.json` updates for the new dev dependency so installs
  stay reproducible.
- Bump `agape-rs`, `studio/web`, and `studio/agent-server` to 1.0.1 so the release
  bundle (named from `Cargo.toml`) matches the `v1.0.1` tag.

## [1.0.0] — 2026-06-27

First release: the Agape language, compiler, runtime, and studio, packaged as one
self-contained `agape` CLI.

### Language & runtime
- A clean-room Rust implementation (lexer → parser → checker → interpreter +
  event spine) passing the full v1.0 conformance suite — **102/102**, enforced as
  a CI gate.
- The decision surface: testimony → `Credence<E>` → a gate (`endorse` / `attest`
  with `c by R` readiness) → a `Decision` that drives `perform` actions and `emit`
  events. Static checks reject unauthorized authority, tainted/settled inputs, and
  ill-typed gates before anything runs.
- A hash-chained event spine (tamper-evident journal), a deterministic
  scheduler/tick cascade, injectable seams (cognition / memory / spine) for
  test-mode, replay, and fault injection, and a sampling fallback for graded
  judgments when a model can't return log-probabilities.

### CLI
- `agape init` (scaffold a project), `run` (with `--prompt` / `--claude` /
  `--samples` / `--temperature` / `--json`), `check` (static guarantees only),
  `build` (check every `.ag` → `.agape/build.json`), `configure` (provider/model/
  runtime defaults in `agape.toml`), and `studio`.
- The mock provider ships in-box, so `run` works offline with no API key; a live
  Claude model is one `configure` step away.

### Studio
- A project-aware IDE: inspect, edit, and run a project's agents, with a question
  → verified-answer view and the underlying spine.
- Runs offline on the deterministic mock provider, or against a live Claude model
  (with the sampling fallback when log-probabilities aren't available).
- One-process bundle mode: the agent-server serves the prebuilt web app, no Vite
  at runtime.

### Packaging & CI
- `scripts/package.sh` builds a portable, self-contained bundle (binary + studio
  source + a runnable example + default `agape.toml`), archives it with a SHA-256
  sidecar, and verifies by running the *shipped* binary with no repo present.
- `release.yml` builds that bundle for Linux, macOS, and Windows on a `v*` tag and
  publishes a GitHub Release.
- `ci.yml` builds and tests the language, gates on conformance (102/102) and
  manifest drift, and builds the studio.

[1.0.1]: https://github.com/tylerhslee/agape/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tylerhslee/agape/releases/tag/v1.0.0
