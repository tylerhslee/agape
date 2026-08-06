# Studio testing — strategy & journey inventory

You can't test *every possible* user journey (the input space is infinite). The
goal is **tractable, auditable coverage**: enumerate the journeys that carry
value, map each to a test, and push combinatorial edge cases down to fast tests.

## The pyramid (and what each layer owns here)

| Layer | Tool | Owns | Where |
|---|---|---|---|
| **Unit** | Vitest | pure logic & security guards (`safeProjectPath`, `.ag` parsing, `pickVariant`) | `studio/agent-server/lib.test.ts`, `*.test.ts` |
| **Integration** | Vitest | the real HTTP backend over a scaffolded project | `studio/agent-server/server.integration.test.ts` |
| **E2E** | Playwright | the real browser against the real app — the marquee flow | `studio/web/e2e/` |
| **Bundle smoke** | bash | the *shipped artifact* boots & runs | `scripts/studio-smoke.sh` |
| **Language** | agape-ts | every gate/seam/runtime rule | `agape-ts/test`, `agape-conformance` |

The studio's surface is **thin on purpose**: most journeys bottom out in `agape
run` → a ledger, which the **conformance suite already covers exhaustively**. So
the studio tests the plumbing (parse, serve, run, render), not the language.

A run is **deterministic on the mock provider** — byte-identical ledger, no API
key — so integration/E2E tests assert *exact* outputs without flakiness.

## Journey inventory (every entry maps to a test)

| # | User journey | Layer · test |
|---|---|---|
| J1 | Open the studio → see my agents & sensors | integration `lists the scaffolded project's agents`; unit `agentsAndPrompts` |
| J2 | Ask a question → get a **verified** answer | integration `runs a program … delivers a verified answer`; E2E `marquee` |
| J3 | A program that fails the static checks → a clear error, no crash | integration `reports a static rejection as ok:false` |
| J4 | Edit an agent → save → re-run | E2E (planned); backend `POST /project/file` covered by J3's save |
| J5 | Turn on 🧠 Claude / tune samples-temp | E2E (planned); backend wiring in `runProjectFile` |
| J6 | The gate abstains / rejects → "no answer delivered" | unit (gate logic) + conformance `gov_*_abstains`; UI branch E2E (planned) |
| J7 | Malicious path (`../../etc/passwd`) → refused | unit `safeProjectPath`; integration `refuses a path-traversal file read` |
| J8 | No API key → studio still runs (mock), Claude errors gracefully | bundle smoke (offline); backend lazy-cognition |
| J9 | `agape studio` from a packaged bundle serves the app | bundle smoke `studio-smoke.sh` |
| J10 | Open a visual flow → edit a literal prompt/gate → compile-check and save; stale/unsafe edits leave source untouched | unit flow-model.test.ts; integration flow-server.integration.test.ts; web component FlowBuilder.test.jsx |
| J11 | Open Code -> Monaco loads -> edit and save the attached .ag file | E2E open Code -> edit and save through Monaco |

`(planned)` = not yet automated; tracked here so the gap is visible, not implied.

## How we keep it honest (the process, not a number)

- **New feature ⇒ new row here ⇒ new test.** Definition of done.
- **Coverage is a gap-finder, not a trophy** — it shows untested *code*, never proves all *journeys*.
- **Combinatorics go to unit tests** (every input shape), E2E stays a handful.
- **Property/fuzz** for un-enumerable input: the conformance suite fuzzes the language; feed-random-`.ag` is the natural extension.
- **Prod closes the loop** — the ledger is an audit log; a real-world failure becomes a new row + a regression test.

## Run it

```
cd studio/agent-server && npm test     # unit + integration
cd studio/web          && npm test     # components
bash scripts/studio-smoke.sh           # bundle smoke (needs a built binary + web dist)
cd studio/web && npm run e2e           # 3 Playwright journeys
```

CI (`.github/workflows/ci.yml`, `studio` job) runs unit + integration on every
push and gates the build on them; `release.yml` runs the bundle smoke per platform.
