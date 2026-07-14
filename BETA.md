# Agape Beta Readiness

This file tracks the surfaces that must be treated as stable before Agape moves
from alpha to beta. Beta means app developers can dogfood Agape without chasing
breaking feature changes every week.

## Compatibility Promise

The beta compatibility promise covers these surfaces:

- `agape.toml`: provider, memory, prompt, tool, action, security, and runtime binding shape (SPEC §17.1).
- Markdown memory layout: project-root `.agape/memory/MEMORY.md` plus scoped files under `.agape/memory/scopes/<scope>/<agent>/<slot>.md` (SPEC §16.7, "The default substrate: markdown"; `[memory]` keys in SPEC §17.1).
- Runtime receipts: ledger event names and payloads used for decisions, endorsements, memory writes, tool calls, prompt ingress, and provider outputs (SPEC §7, §10, §13, §16.2).
- Tool bindings: host `toolHandlers` (SPEC §17.7), built-in HTTP tools, and MCP-over-HTTP tools configured from the manifest (SPEC §17.1, the `[tools.*]` catalog).
- Provider behavior: mock cognition when no provider is configured; live calls and live embeddings when provider configuration is present (SPEC §17.1 provider fields, §16.8).
- Studio/project contract: Studio edits the same project root that the app runtime executes.
- Soma deployment contract: app and Studio share a persistent Agape project mount, with markdown memory surviving redeploys (SPEC §16.7, "What survives a redeploy").

Breaking changes to these surfaces should wait for a new beta line once the beta
tag is cut.

## Core Test Suite

Agape core owns the canonical conformance and certification suite first. App and
adapter test tooling can later graduate into `@agape/test` or `agape/testkit`,
but the source of truth starts here.

Current commands:

```sh
cd agape-ts
npm run typecheck
npm test
npm run test:cert
npm run test:core
```

The certification suite lives in `agape-ts/test/certification.test.ts` and uses
`agape-ts/src/testkit.ts` to assert ledger events, decisions, endorsements,
memory writes, tool calls, prompt inputs, and stable golden traces.

## Dogfood Gates

The beta push should keep both dogfood apps in view:

- `league-analyzer`: should expose a real Agape project hook and run with markdown memory plus live provider calls.
- `agape-fact-checker`: should migrate its Agape program to the current TypeScript runtime grammar and run with live provider calls.

Smoke command:

```sh
node scripts/dogfood-smoke.mjs --json
node scripts/dogfood-smoke.mjs --strict
```

`--strict` is intended for CI once the dogfood apps are wired. Until then, the
non-strict mode reports integration gaps without failing local development.

## Soma Gate

Soma is part of the beta push. The required deployment pattern is
`agape-soma` v0.3.0 `modules/agape-app`:

- App image embeds the TypeScript runtime in-process.
- Studio runs from the same vendored runtime and points at the same project root.
- `AGAPE_PROJECT_DIR` points at the persistent state mount, typically `/data/agape`.
- The image ships an Agape seed project, and the cloud entrypoint copies missing files only.
- `.agape/memory` persists across Cloud Run revisions.
- Provider keys live in the app project's `.env` locally and Secret Manager in cloud; no `.env` is shipped in Agape itself.

The dogfood smoke runner checks this contract when `agape-soma` is present as a
sibling checkout.