# AGENTS.md — agape-ts

TypeScript compiler + runtime for the Agape **core kernel** (`../SPEC.md`). Embedded
in Studio. The conformance suites are the oracle — see the root `AGENTS.md` for the
doc -> test -> build directive and release flow.

## Commands (verified green)
```sh
npm run typecheck                       # tsc --noEmit -> clean
npm test                                # 232/232 vitest (kernel, memory, certification, graph)
npx tsx conformance/run.mts             # 254/254 (100%) against ../agape-conformance
npm run test:cert                       # certification.test.ts (golden ledger traces)
npm run test:core                       # kernel + memory + certification only
npm run hello                           # run examples/hello.ag on the mock provider
npx tsx src/cli.ts run examples/hello.ag --manifest agape.toml
npx tsx src/cli.ts studio               # execution-inspection UI (serves cwd .ag files)
```
Runtime is async end-to-end; the mock provider is deterministic (same scripted
judgment -> identical chain-head), so tests assert exact ledgers without flakiness.

## Pipeline (edit at the right seam)
`src/lexer.ts` -> `src/parser.ts` (`assertCore` grammar lockstep) -> `src/check.ts`
(static semantics: type/trust/color/authority + the gate) -> `src/interp.ts`
(discrete-event runtime + consequential-action rule) -> `src/runtime.ts` (values,
trust lattice, provider seam, ledger). Memory: `src/memory.ts` + `src/memory_runtime.ts`.
Config/manifest binding: `src/config.ts`. Runtime-conformance adapter:
`src/runtime_adapter.ts` (+ `runtime_adapter_*.ts`).

## Kernel invariants (must hold; conformance pins each)
- **Determinism / issue order.** The ledger appends in issue order (turn-scheduler /
  `inResolutionOrder` discipline); FIFO commit.
- **Replay (§16.5).** Replay reproduces chain heads with **zero** oracle re-invocation —
  provider/tool/identity/prompt/embedding results are re-served from the recording.
- **Fault containment (§16.6).** Faults are contained per-agent (`AgentCrashed`, not a
  death) and always carry an informative message.
- **No null into a typed binding.** A structured send never lands null into a typed
  slot — fault-at-send plus bounded `retry`.
- **Non-tail `return` is a static error.**
- **Grammar is the core kernel only** (`assertCore`) — no syntactic sugar in the kernel.
- The trusted path is enforced statically **and** at runtime:
  `testimony -> Credence<E> -> Decided Decision<E> -> committed Endorsement<T> -> granted sink -> ledger`.

## Boundaries
**Always:** add/adjust a conformance case (`../agape-conformance`) before changing
language behavior; keep `assertCore` and the checker in lockstep with `SPEC.md`; run
typecheck + `npm test` + `conformance/run.mts` before committing.
**Ask first:** changing a kernel invariant, the ledger canonical-hash fields, or the
provider/memory seam contracts.
**NEVER:** weaken/delete a test to go green; make a change that reduces conformance
below 254/254; let a model-derived value reach a sink without a committed decision +
endorsement; introduce a non-`assertCore` construct into the kernel grammar.
