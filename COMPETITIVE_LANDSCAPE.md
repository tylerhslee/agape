# Agape — Competitive Landscape Intelligence

> Status: VERIFIED (2026-06-22, second agent). Every arXiv ID in Priority 1–2
> resolves to its claimed paper; nothing was fabricated. The strategy-driving
> Quine claim is confirmed verbatim. Corrections from verification are folded in
> below and marked `[corrected]`. Two items warrant a direct human read before
> anchoring load-bearing decisions: ActiveGraph internal claims and Vercel Zero
> repo details (both exist; verified via summaries, not raw source).

## Executive summary

The space Agape occupies — a programming language with native agentic
primitives whose runtime *is* the OS — has no direct competitor today. The
ecosystem splits into three layers nobody has unified:

1. **Framework libraries** bolted onto Python (LangGraph, AutoGen, CrewAI, Strands)
2. **Runtime substrates** that manage agent processes from *outside* (AIOS, Quine)
3. **Early academic calculi** (Pel, LLMbda, Quasar)

Agape's thesis — the *language* is the substrate, and the OS is written *in* that
language — is the one position nobody currently occupies. The window is open, not
empty: multiple teams are converging on pieces of it.

---

## 1. Direct competitors — languages with their own syntax + runtime

### Pel (arXiv 2505.13453, May 2025)
Lisp/Elixir/Haskell-inspired language for LLM orchestration. Homoiconic, first-class
closures, natural-language conditions evaluated by an LLM, auto-parallelization via
AST dependency analysis, REPL with Lisp-style restarts.
- **Ahead of Agape:** compiles to analyzable AST; automatic parallelization; safety via grammar restriction.
- **Behind Agape:** orchestration-only. No lifecycle (spawn/awake/sleep), no world graph, no triple-store memory, no event spine, no semantic `verify`. Pel would be an *application* you write in Agape.

### Quasar (arXiv 2506.12202, June 2025)
The LLM writes a Python subset that is transpiled **to Quasar** (Python = source,
Quasar = target). `[corrected: direction is Python→Quasar, not the reverse]` Adds
parallelism, reliability via conformal prediction, fewer human approvals.
- **Perf `[corrected]`:** ~56% reduction in execution time + ~53% fewer approvals (not "42% faster").
- **Ahead:** zero new syntax; measurable perf/reliability gains; human-in-the-loop verification.
- **Behind:** not a first-class language. No agent model, events, or world graph. A Python execution backend.

### SARL (sarl.io, since 2014, v0.15.1 Sep 2025)
Mature JVM agent-oriented language: Agent, Capacity, Skill, Space, Behavior, holonic
(agent-of-agents) composition. Compiles to JVM bytecode on the Janus platform.
- **Ahead:** a decade of maturity; real IDE tooling (Eclipse); holonic agents match `extend`.
- **Behind:** built for classical MAS, not LLM agents. No `think()`/`embed()`, no event spine, no semantic `verify`, no world graph. Janus manages agents — the kernel is not written in SARL. Agape is its LLM-native successor.

### LLMbda Calculus (arXiv 2602.20064, Feb 2026)
Formal calculus (not a shipped language) extending lambda calculus with LLM primitives
(`@e`, `fork e`, `clear`) + dynamic information-flow tracking. Proves a noninterference
theorem against prompt injection.
- **Ahead:** rigorous formal semantics; security guarantees Agape lacks.
- **Behind:** academic only — no runtime, tooling, lifecycle, world graph, or OS model. This is what you'd *publish* to give Agape a theoretical underpinning, not a mindshare competitor.

---

## 2. Agent OS projects

### AIOS — AI Agent Operating System (arXiv 2403.16971, COLM 2025)
The most rigorous academic implementation. An LLM Kernel above the conventional OS
kernel; agents submit "syscalls" to modules (scheduler, context, memory, storage,
access control, tool manager) `[note: "syscalls" is paraphrase — design-consistent,
not a verbatim quote]`. **Up to 2.1x** faster for *serving* agents `[corrected: "up
to", a serving figure, not specifically multi-agent]`. Companion SDK Cerebrum
(github.com/agiresearch/Cerebrum) confirmed. ~6k stars, active, v0.3.0.
- **The inversion:** AIOS's kernel *manages* agents (both kernel + SDK ~98% Python). Agape's claim is the kernel *is* agents. Opposite positions — this supports Agape's positioning.
- GitHub: github.com/agiresearch/AIOS

### Quine (arXiv 2603.18030, Mar 2026) — CLOSEST RISK
Maps LLM agents onto native POSIX processes: spawn=`fork`, continue=`exec`,
terminate=`exit`; IPC via stdin/stdout/env/exit codes; three-tier memory.
- **Why it matters `[CONFIRMED verbatim]`:** Quine's own paper (Section 5, "Related Work and the Boundaries of POSIX") names two open problems that Agape directly fills:
  - *Task-relative worlds* (§5.2 "From Namespace to World") — worlds "scoped by relevance rather than only permission," constitution "task-relative rather than permission-derived" = Agape's per-agent triple store + world graph.
  - *Revisable time* (§5.3 "From Execution to Revision") — "rollback without amnesia — the ability to undo effects while preserving experience" = Agape's append-only event spine.
- **Lifecycle mapping CONFIRMED verbatim** (§2.4): spawn→fork, continue→exec, terminate→exit(status).
- **Behind:** no semantic assertion, no reactive `when`, no `catch` subscriptions, no `think()`/`embed()` seam.
- GitHub: github.com/kehao95/quine (author Hao Ke, submitted 8 Mar 2026)

### ActiveGraph / "The Log is the Agent" (arXiv 2605.21997, May 2026) — CLOSEST PHILOSOPHY
By **Yohei Nakajima — the creator of BabyAGI** (repo github.com/yoheinakajima/activegraph).
`[corrected: author + repo confirmed; this is a notable name in the agent space]`
Append-only event log as source of truth; working graph is a deterministic projection;
behaviors react to graph changes and emit new events. Deterministic replay, cheap
forking, end-to-end lineage. Apache-2.0 per paper + repo (one site said MIT — Apache wins).
- **Closest to Agape's event spine** — but a Python *framework* (`pip install activegraph`), not a language.
- **Behind:** no lifecycle syntax, no `verify`, no `catch`, no `think()`/`embed()` seam, no `find/where` triple-pattern query, no `<-`/`->` IPC operator.
- **Watch this one:** a credible operator (BabyAGI) building the event-spine idea. Highest framework-absorption risk.

### AgentOS (arXiv 2603.08938, Mar 2026)
Replaces the GUI desktop with a Natural Language Interface — a "personal agent OS."
A UI paradigm / position paper, not a language or runtime. Agape is an execution model;
this is a UI vision.

---

## 3. Major frameworks — strong vs. weak

| Framework | Strong | Weak |
|---|---|---|
| **LangGraph** | Production-grade; graph workflow control; LangSmith observability; big ecosystem | Per-run cloud pricing; no built-in tenant isolation; boilerplate; DSL is Python |
| **AutoGen / MS Agent Framework** | Conversational multi-agent; merged into MS Agent Framework 1.0 GA (Apr 2026) | AutoGen in maintenance mode; migration burden; Python-hosted; no event spine |
| **CrewAI** | Role-based crews; easy onboarding | Poor logging; painful debugging; token-wasteful manager chatter; ~54% completion on complex tasks |
| **AWS Strands** | Model-first (LLM plans); native MCP+A2A; multi-agent primitives; OTel | Thin state management (wire DynamoDB yourself); Python; no event spine |
| **Cloudflare Agents SDK** | Each agent a Durable Object w/ SQLite, hibernation, scheduling — best persistence | JS/TS only; no language-level primitives; no world graph |
| **Jido (Elixir)** | OTP supervision; Jido.Signal (CloudEvents v1.0.2) typed/replayable events (`replay_since`); fault-tolerant; now at **2.x** `[corrected: not early-stage/1.x]` | Niche ecosystem; thin LLM tooling; not a new language; no `verify`/triple-store/world graph |

**Structural gaps shared by ALL frameworks:** no built-in tenant isolation; no
semantic assertion (`verify`); provider abstraction is duct-tape, not a primitive;
observability is bolt-on; no language-queryable world graph.

---

## 4. Historical PL parallels

| Predecessor | Agape borrows | Agape adds |
|---|---|---|
| Erlang/OTP | Actor isolation, spawn, message passing, supervisors | LLM-backed actors, semantic `verify`, world graph, event spine |
| Smalltalk | Everything is a message; live, reflexive environments | Agent lifecycle, `think()`/`embed()` seam, `verify`, IPC operators |
| Reactive (Rx/FRP) | `when` blocks, event subscription | Every execution line emits an event, not just data streams |
| Prolog/Datalog | `find/where` triple-pattern queries | Integrated into agent language; per-agent + shared stores |
| Event Sourcing | Append-only log as source of truth | A language primitive, not an architecture pattern |

---

## 5. Risks to relevance

1. **Framework absorption (HIGH).** ActiveGraph + Jido/LangGraph could cover ~80% of the use case without a new language. *Mitigation:* correctness guarantees (compile-time agent contracts, semantic assertions, provable lineage) can't be bolted onto a framework — they need the compiler to know about agents.
2. **LLM providers build the OS layer (HIGH).** Anthropic/OpenAI/Google are building down into orchestration. *Mitigation:* provider runtimes are provider-locked; market the `think()`/`embed()` seam as "POSIX for cognition."
3. **Elixir/BEAM gets there first (MEDIUM).** Jido already has OTP + CloudEvents signals + production hardening. *Mitigation:* event spine as a language primitive and "agents all the way down" aren't achievable as Elixir libraries.
4. **MCP + A2A standardize IPC (MEDIUM).** *Mitigation:* MCP is HTTP tool-calling, not a typed/ordered/logged event primitive. Support MCP as a *transport*, don't compete with it.
5. **SARL modernization (LOW).** Right conceptual model + tooling, but JVM/MAS heritage makes a clean LLM pivot unlikely.
6. **Quine ships task-relative worlds + revisable time (MEDIUM-LOW).** Its authors know what they're missing. *Mitigation:* monitor the repo; syntax-level `find/where`, `verify`, `when` are hard to add as POSIX extensions.

---

## 6. Differentiation (priority order)

1. **Event spine as a language primitive** — every line emits a typed event to an append-only log. Not observability bolted on; it *is* the execution model. ActiveGraph is closest, but as a library.
2. **`verify` — semantic assertion via vector similarity.** No other language has this. Wedge into the ML eval/testing community, which has the pain and no good solution.
3. **Per-agent triple store + shared world graph with `find/where`.** Quine explicitly names this as the missing primitive.
4. **`think()`/`embed()` provider seam at the language level.** Others use DI/config; Agape makes the seam part of the grammar — you can't accidentally couple cognition to a provider.
5. **The OS written in Agape — agents all the way down.** Most ambitious, most unique. AIOS manages agents from a Python kernel; Quine uses POSIX. Nobody writes the kernel/shell/services as agents in the agent language.

---

## 7. Recommendations

**Immediate (0–3 mo)**
- Nail and *publish* the event-spine spec (event schema, query model, replay). Differentiate explicitly from ActiveGraph (arXiv 2605.21997).
- Ship `verify` with a reference embedding backend + a compelling demo. Target the ML eval community — `verify` is the wedge product that bypasses "why learn a new language."
- Write "What Quine Cannot Do" — Quine's §5.2/§5.3 read like an Agape requirements doc.

**Medium-term (3–12 mo)**
- Implement MCP as a transport for `<-`/`->` (compose with the ecosystem, don't fight it).
- Write a formal-semantics paper (operational semantics as a process calculus) for academic credibility.
- Build one compelling OS-in-Agape demo (REPL agent that spawns children, talks via `<-`/`->`, inspects the world graph).

**Positioning to avoid**
- Don't fight LangGraph/CrewAI/Strands on orchestration — lost before it starts. Compete on what needs a compiler, not a library: event spine, `verify`, world graph, runtime-as-agent-language.

---

## Landscape map

| Project | Type | Lifecycle | Event spine | World graph | `verify` | think/embed seam | OS model | LLM-native |
|---|---|---|---|---|---|---|---|---|
| **Agape** | Language | Yes | Yes | Yes | Yes | Yes | Yes (agents down) | Yes |
| Pel | Language | No | No | No | No | Partial | No | Yes |
| Quasar | Transpiler | No | No | No | No | No | No | Yes |
| SARL | Language | Partial | No | No | No | No | No | No |
| LLMbda | Calculus | Partial | No | No | No | Partial | No | Yes |
| Quine | Runtime | Yes (POSIX) | No | No | No | No | No | Yes |
| AIOS | Runtime+SDK | Yes (syscalls) | No | No | No | No | Partial | Yes |
| ActiveGraph | Framework | No | Yes (lib) | Yes (lib) | No | No | No | Yes |
| Jido | Framework | Yes (OTP) | Yes (lib) | No | No | No | No | Partial |
| LangGraph | Framework | No | No | No | No | No | No | Yes |
| Strands | Framework | No | No | No | No | No | No | Yes |

No project fills all of Agape's columns. The closest hypothetical is Jido's signals +
ActiveGraph's event spine — which does not exist as one thing.

---

## Newly discovered (second-pass research — not in the original report)

Strongest finds; verify the two flagged before relying on them:

- **Vercel Zero** `[verify directly — repo not loaded]` — statically-typed *systems
  language for agents*; compiler emits structured JSON diagnostics with typed "repair
  IDs"; capability-based I/O via a `World` object. github.com/vercel-labs/zero ·
  zerolang.ai (v0.1.1, Apache-2.0). **Closest new language competitor** — typed,
  compiler-first, capability-based. Watch it.
- **NERD (nerd-lang)** — LLM-native orchestration language, "a language machines write,
  humans audit"; first-class LLM calls + MCP tools; compiles to native via LLVM.
  github.com/Nerd-Lang/nerd-lang-core · nerd-lang.org (v0.1.4, very early).
- **Synergy** (arXiv 2603.28428, github.com/SII-Holos/synergy) — runtime for persistent
  collaborative agents ("Agentic Citizens" w/ identity). Runtime/architecture, not a kernel-OS.
- **Autellix** (arXiv 2502.13965) — agent-serving engine treating agentic *programs* as
  first-class scheduling units; 4–15× throughput vs vLLM. Relevant to the "first-class
  process" angle (serving engine, not full OS).
- **BranchFS / "Fork, Explore, Commit"** (arXiv 2602.08199, github.com/multikernel/branchfs)
  — fork/CoW filesystem branching as an OS primitive for agent exploration.

**Name-collision warning:** arXiv 2603.08938 "AgentOS: From Application Silos..." (Rui Liu
et al.) is a *different* project from the AgentOS NUI paper. Don't conflate them. Also note
an OS-for-Agents workshop ecosystem (ASPLOS/SOSP 2026, os-for-agent.github.io) with many
unverified sub-projects.

---

## Sources (VERIFIED 2026-06-22 unless noted)

- Pel (arXiv 2505.13453): https://arxiv.org/abs/2505.13453
- Quasar (arXiv 2506.12202): https://arxiv.org/abs/2506.12202
- Quine (arXiv 2603.18030): https://arxiv.org/abs/2603.18030 · github.com/kehao95/quine
- LLMbda Calculus (arXiv 2602.20064): https://arxiv.org/abs/2602.20064
- AIOS (arXiv 2403.16971): https://arxiv.org/abs/2403.16971 · github.com/agiresearch/AIOS
- "The Log is the Agent" / ActiveGraph (arXiv 2605.21997): https://arxiv.org/abs/2605.21997
- AgentOS (arXiv 2603.08938): https://arxiv.org/abs/2603.08938
- SARL: https://www.sarl.io/ · github.com/sarl/sarl
- Jido: github.com/agentjido/jido · github.com/agentjido/jido_signal
- ActiveGraph repo: github.com/yoheinakajima/activegraph · activegraph.ai
- AIOS SDK (Cerebrum): github.com/agiresearch/Cerebrum
- Vercel Zero: github.com/vercel-labs/zero · zerolang.ai
- NERD: github.com/Nerd-Lang/nerd-lang-core · nerd-lang.org
- Synergy (arXiv 2603.28428): github.com/SII-Holos/synergy
- Autellix (arXiv 2502.13965): https://arxiv.org/abs/2502.13965
- BranchFS (arXiv 2602.08199): github.com/multikernel/branchfs

---

## Verification results (2026-06-22, second agent)

Nothing in Priority 1–2 was hallucinated. Every arXiv ID resolves to its claimed paper.

- [x] **Quine** — CONFIRMED. Paper + repo exist; "task-relative worlds" (§5.2) and "rollback without amnesia"/revisable time (§5.3) named as open boundaries; fork/exec/exit mapping verbatim (§2.4).
- [x] **ActiveGraph** — PARTIALLY CONFIRMED. Exists (by Yohei Nakajima/BabyAGI); event-log model holds; it's a framework not a language. Internal claims via summaries — read directly before anchoring. Apache-2.0 (a site said MIT).
- [x] **AIOS** — CONFIRMED. COLM 2025; kernel + Cerebrum SDK ~98% Python (the inversion holds). "2.1x" is "up to 2.1x for serving"; "syscalls" is paraphrase.
- [x] **Pel** — CONFIRMED. All claims hold.
- [x] **Quasar** — PARTIALLY CONFIRMED. Direction is Python→Quasar (inverted in v1); figure ~56% not 42%.
- [x] **LLMbda** — CONFIRMED. Termination-insensitive noninterference theorem.
- [x] **SARL** — CONFIRMED. v0.15.1 (11 Sep 2025), actively maintained, holonic agents real.
- [x] **Jido** — CONFIRMED. CloudEvents v1.0.2, replay real; now at 2.x (not early-stage).
- [ ] **Vercel Zero** — exists (secondary coverage); repo not directly loaded. Read before anchoring.

Two items to read with your own eyes before they anchor load-bearing decisions:
**ActiveGraph internal claims** and **Vercel Zero repo details**.
