# AGENTS.md — studio

Agape Studio: the control surface for `.ag` projects. `web/` (React + Vite + Monaco),
`agent-server/` (local backend: project APIs, providers, memory, review), and the
Playwright `e2e/`. Studio's surface is thin on purpose — most journeys bottom out in
`agape run` -> a ledger, which the conformance suites already cover.

## Commands (verified green — WSL only; Windows tooling breaks here)
```sh
cd agent-server && npm test          # 62 passed + 1 optional dogfood skip
cd web && npm test                   # 27 passed (components)
cd web && npm run build              # vite build -> dist/, clean
bash ../scripts/studio-smoke.sh      # PASS: shipped bundle boots, detects project, runs a program
cd web && npm run e2e                # 3 passed (Playwright drives the real served app + backend)
```
A run is deterministic on the mock provider (byte-identical ledger, no API key), so
integration and e2e assert exact outputs without flakiness.

## Layout & wiring
- `web/` vendors `@agape-lang/syntax` as a **file: dep** from `../../vendor/agape-syntax`
  (`file:../../vendor/agape-syntax`). The Vite dev server proxies to the agent-server on
  `127.0.0.1:8799`.
- `agent-server/` runs projects through the agape-ts CLI (`AGAPE_TS_CLI` / `TSX_CLI`);
  `AGAPE_PROJECT` resolves upward to the nearest `agape.toml`.
- e2e `e2e/serve.mjs` scaffolds a project and serves the built web app; `studio.spec.ts`
  drives it. Fixtures **derive** the version (never hardcode it).
- Studio versions independently of the language (app is `1.0.0`); the shared runtime
  contract is `SPEC.md` §16–17.

## Testing layers (see TESTING.md for the journey inventory)
Unit (Vitest: `safeProjectPath`, `.ag` parse, `pickVariant`) → integration (real HTTP
backend over a scaffolded project) → e2e (Playwright, marquee flow) → bundle smoke
(`studio-smoke.sh`). New feature ⇒ new journey row in `TESTING.md` ⇒ new test.

## Boundaries
**Always:** build/test Studio in WSL; keep e2e/fixtures version-derived; add a `TESTING.md`
journey row + test with every new feature; run agent-server + web tests before the build.
**Ask first:** changing the agent-server ↔ web proxy contract or the vendored
`agape-syntax` dependency path.
**NEVER:** hardcode a version in an e2e fixture or test; run Studio builds/tests via
Windows tooling against a `\\wsl.localhost` path; weaken/skip a journey test to go green;
ship a web change without rerunning the bundle smoke.
