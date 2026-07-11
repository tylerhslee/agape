# agape-ts — a TypeScript compiler + runtime for Agape

A from-scratch implementation of the Agape **core kernel** (per `../SPEC.md`,
v1.0.0-alpha.2026.7.11.3), written in TypeScript so it can live inside Agape Studio. It lexes,
parses, statically checks, and runs the complete core language, with the trusted kernel
(`decide` → `Decided` → committed `endorse` → granted sink → ledger) enforced both statically and at runtime.

**Conformance: 167/167 (100%)** against `../agape-conformance` — see [CONFORMANCE.md](CONFORMANCE.md).

## Run

```bash
npm install
npm run hello                     # runs examples/hello.ag on the mock provider
npx tsx src/cli.ts run examples/hello.ag --manifest agape.toml
npx tsx src/cli.ts studio         # the execution-inspection UI (serves .ag files in the cwd)
npx tsx src/cli.ts studio --share # live providers + an ephemeral token for a short tunnel demo
npm test                          # the kernel safety test suite

# live providers — secrets come from the environment / a .env (never the manifest):
npx tsx src/cli.ts run examples/hello.ag --provider openai     # OPENAI_API_KEY  → logprob path
npx tsx src/cli.ts run examples/hello.ag --provider anthropic  # ANTHROPIC_API_KEY → sampling fallback
```

The runtime is **async** end-to-end (cognition is a model call): the mock resolves on a microtask, so
tests and the demo exercise the same async path as a live model. OpenAI reads `top_logprobs` for
graded per-variant scores; Anthropic (no token logprobs) draws the forced choice `fallback_samples`
times and uses the empirical frequency; Gemini is wired the same way.

`examples/hello.ag` is the whole trusted kernel on one screen — a Greeter that judges a draft,
collapses the judgment with `decide`, endorses the exact draft, and reaches the `Announce` sink only
inside the committed `Publish` branch (`if (d.committed == Publish)`):

```
testimony  ->  Credence<Verdict>  ->  Decided Decision<Verdict>  ->  Endorsement<text>  ->  granted sink  ->  ledger
```

## Pipeline

| stage | file | does |
|---|---|---|
| lexer | `src/lexer.ts` | source → tokens (§2) |
| parser | `src/parser.ts` | tokens → AST (§15.2), + `assertCore` grammar lockstep |
| AST | `src/ast.ts` | node types |
| checker | `src/check.ts` | the static semantics (§15.3): type/trust/color/authority + the gate |
| errors | `src/errors.ts` | the error taxonomy (`AgapeError { cls }`) the suite asserts on |
| runtime core | `src/runtime.ts` | values + the trust lattice, the **provider seam**, the ledger |
| interpreter | `src/interp.ts` | discrete-event runtime (§15.4/§16); the gate; the consequential-action rule |
| memory | `src/memory.ts` | pluggable private-memory substrate contract + local driver (§10/§16.7) |
| config | `src/config.ts` | binds the provider/identity/tool/memory dependencies to backends (§17) |
| cli | `src/cli.ts` | `run <file.ag>` · `graph <file.ag>` · `studio [--port N]` |
| graph | `src/graph.ts` | the statically derived orchestration graph — see `GRAPH.md` |
| studio | `studio/` | the execution-inspection web UI (see below) |
| conformance | `conformance/run.mts` | runs the suite against this impl — see [CONFORMANCE.md](CONFORMANCE.md) |

## Studio — execution inspection

`npx tsx src/cli.ts studio` starts a local web UI that lists the `.ag` programs in the directory it
was launched from, runs them through this interpreter, and visualizes the execution: the ledger
timeline (every event, tick by tick), the trusted-kernel chain (Credence → Decision → Endorsement →
sink), gate outcomes with basis/margin, say output, and the chain-head. A rejected program shows its
error class and message — it is a quality-control lens over Agape runs, not an editor.

The **Orchestration graph** panel shows the statically derived agent graph (`GRAPH.md`) —
agents, handlers, gates, principals, and sinks with their typed edges — and a run’s ledger
events light up the witnessed path through it. Click a node to jump to its source line.

## Providers are configurable (not mock-locked)

The provider is a **declared dependency** reached through the `self <- …` seam; the concrete
backend is config-bound (`SPEC.md` §17). `mock` is just one backend behind the `Provider`
interface in `src/runtime.ts`. The manifest (`agape.toml`) selects the backend:

```toml
[provider]
backend = "anthropic"   # or openai / gemini / mock
model   = "claude-…"
```

- `exposes_logprobs` is **derived** from the backend (anthropic=false, openai/gemini=true, §17.1).
- A backend with token logprobs yields per-variant scores directly; one without (anthropic) is
  served by the **sampling fallback** — draw the forced choice `fallback_samples` times and use the
  empirical frequency (§16.8). Both paths live in `RemoteProvider` in `src/config.ts`.
- Secrets come from the environment (`ANTHROPIC_API_KEY`, etc.), never the manifest.

For conformance, the harness injects a deterministic/scripted provider (the mock), so runs are
replay-stable (same scripted judgment → identical chain-head). Live API calls run through the same
seam on an async execution path.

## Memory substrates are configurable

Agape source uses the same `mem` surface regardless of storage backend. The interpreter depends on
the generic `MemoryDriver` interface in `src/memory.ts`; concrete backends are selected by `[memory]`
in `agape.toml`.

The default vanilla substrate is markdown: a project-local `MEMORY.md` index plus scoped topic files
under `.agape/memory/scopes/<project>/<agent>/<mem>.md`. This follows the public Claude Code shape:
plain markdown, user-auditable files, a concise entrypoint, and richer topic files behind it.

```toml
[memory]
# Markdown is the editable substrate; the default Agape memory runtime wraps it
# with classification, dedupe/consolidation, auto-memory judgment, and recall ranking.
driver = "markdown"
auto_memory = true
classify = true
dedupe = true
dedupe_threshold = 0.9
recall_pool = 40
path = ".agape/memory"
entrypoint = "MEMORY.md"
top_k = 10
index_lines = 200
index_bytes = 25600
archive_on_forget = true
# domain_terms = ["league", "roster", "scoring"]
```

Use `driver = "local"` for ephemeral in-process memory. By default, Agape wraps the selected substrate with the memory runtime in `src/memory_runtime.ts`, which handles automatic low-signal filtering, preference/fact/procedure separation, duplicate suppression, and recall re-ranking. Agape still owns taint, per-agent isolation, ledger receipts, and sink authority; markdown is only the canonical storage substrate.

## What's implemented

The complete core kernel: agents + lifecycle (`spawn`/`awake`/`sleep`/crash + `on` hooks +
`extend` + `instruction`), the send `<-` with the three-phase lifecycle (+ `expires`/refusal),
`Credence<E>` slots, `decide c by confidence θ [margin δ] [floor m]` / `conformal α [readiness N]
[floor m]`, the principal escalation prefix (`p decide c by r`) with `PrincipalDecision`/
`FailedPrincipalDecision`, `Decided` ledger records, `endorse` with `if (d.committed == V)` flow narrowing, the
consequential-action rule (static admission + the runtime margin floor), default-deny `grants` with
subtractive `extend`, read/write tools over the tool seam, `when` subscriptions (subtype match,
`about`, guards, registration order), private memory (`mem` store/recall/`forget`, always-tainted
recall) + `store()`, the objective `select … from ledger` (recorded trust), `quorum` fusion over
`independent`/`dependent` declarations, structs/enums/events/actions, sync color, the §17.5
conformance harness directives (fault injection, principal grant/deny, manifest fixtures, replay
chain-head equality), and a hash-chained ledger.
