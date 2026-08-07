# AGENTS.md — Agape (repo root)

Agape is a language for agent systems you can inspect, gate, and replay. `SPEC.md`
plus the conformance suites are **THE ORACLE**. This file governs the whole repo;
nearest-file-wins — a subdirectory `AGENTS.md` overrides this one.

## Environment (verified)
Drive everything through WSL when on Windows; Windows tooling breaks on
`\\wsl.localhost` UNC paths.
```sh
wsl bash -lc "cd /home/tylerhyun/_projects/agape && <cmd>"   # git/npm/node/python
git worktree add /tmp/agape-work origin/main                 # fresh tree for agent work
ln -s <main>/agape-ts/node_modules agape-ts/node_modules     # symlink deps into a worktree
```
- LF endings are enforced by `.gitattributes` (`* text=auto eol=lf`).
- Commit by explicit pathspec, imperative subject + why-body.

## Prime directive: doc -> test -> build (TDD)
Language changes go **design-doc/SPEC first, conformance test second, implementation
third**. A failing conformance test means the implementation is wrong until
spec-grounded evidence proves the test wrong. Every bug fix starts by pinning a
failing test/scenario. Every piece of released code is fully tested.

## Release gate matrix
Run these gates in order. Counts shown below are the latest verified results for
the green gates. Production conformance is release-blocking and remains pending/red,
so the full release matrix is not yet green.

```sh
node scripts/check-version.mjs                                    # -> version check ok
cd agape-ts && npm run typecheck                                 # tsc --noEmit, clean
cd agape-ts && npm test                                          # 232/232 vitest
cd agape-ts && npx tsx conformance/run.mts                       # 254/254 (100%)
cd agape-conformance && python3 build_manifests.py --check       # ok: 254 tests, in sync
cd agape-runtime-conformance && npm run test:agape-ts            # 59/59 (agape-ts adapter)
cd agape-runtime-conformance && npm test                         # 59 skipped (adapterless, clean)
cd agape-production-conformance && npm test                      # RELEASE-BLOCKING; pending/red
cd studio/agent-server && npm test                               # 62 passed + 1 optional dogfood skip
cd studio/web && npm test                                        # 27 passed (components)
cd studio/web && npm run build                                   # vite build, clean
bash scripts/studio-smoke.sh                                     # PASS (shipped bundle boots + runs)
bash scripts/package.sh                                          # PASS + verifies the shipped CLI
cd studio/web && npm run e2e                                     # 3 passed (Playwright, real app)
```

## Lockstep releases
Spec, compiler/runtime, conformance, and studio share **one** version.
`VERSION.md` is the source of truth (scheme `1.0.0-(alpha|beta).YYYY.M.D.N`) and is
touched **only** in a release commit. Release flow:
```sh
# 1. full gate matrix above passes  2. bump VERSION.md + tracked references
git commit <pathspec> -m "Release Agape <version>"
git tag -a v<version> -m "Agape <version>"
git push origin main --follow-tags        # push fires CI + 3-OS Release workflow
```

## Boundaries
**Always:** work in a fresh `/tmp` worktree for parallel/agent work; run the gate
matrix before any release commit; add a conformance test before/with any language
change.
**Ask first:** editing `SPEC.md` semantics; bumping `VERSION.md`; pushing `origin main`;
cutting a tag.
**NEVER:** weaken or delete a test to make it pass; touch `VERSION.md` outside a
release commit; `git add -A` / commit by wildcard (always explicit pathspec); run
git/npm/node/python via Windows tooling against a `\\wsl.localhost` path; work in a
dirty checkout that is on another branch (make a worktree).

## Hierarchy (child AGENTS.md files)
- `agape-ts/AGENTS.md` — TypeScript compiler/runtime + kernel invariants.
- `agape-conformance/AGENTS.md` — black-box `.ag` conformance suite (the oracle).
- `agape-runtime-conformance/AGENTS.md` — black-box runtime-contract suite (adapters).
- `studio/AGENTS.md` — Studio web + agent-server + Playwright e2e.
