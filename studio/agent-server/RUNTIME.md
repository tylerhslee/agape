# Simulating the Agape runtime — memory + the learning loop

This is a working simulation of the part of the Agape runtime that matters most for
a builder agent that must **learn Agape and get good at it**: the **spine** (§7) and
the **three-modality memory** (§10). On top of it runs a learning loop — read the
spec, internalize it, write Agape, run it, learn from failures, repeat.

It is a *reference* in TypeScript. Per the plan, the real version is the same shapes
**rewritten in Rust** with the **LLM provider swapped to OpenAI** — so everything
here sits behind two seams (`Cognition`, `Embedder`) and a portable schema.

## The memory architecture (faithful to SPEC §10, §7)

One unit, three modalities — every cell carries a provenance backpointer to the
spine event (§7) that produced it, exactly as §10 requires.

| Modality | SPEC | Store (SQLite) | Query |
|---|---|---|---|
| **FACTS** | deterministic table | `facts(agent, key, value, origin_tick, taint)` | `select` |
| **RELATIONSHIPS** | SPO graph over a typed predicate set | `triples(agent, s, p, o, origin_tick, taint)` | `find … where` |
| **SEMANTICS** | vector store | `embeddings(agent, text, vec, origin_tick)` | `match … > θ` |

The **spine** is the source of truth and everything else folds from it:

```
spine(tick PK monotonic, etype, subject, payload, corr, agent, ts)
```

- **Internalization (§10).** Every event an agent receives is decomposed by the
  provider (cognition) into facts + SPO triples + an embedding, all written with
  `origin_tick` = the event that produced them. Non-deterministic content, fixed
  shape (typed facts; SPO triples).
- **Provenance (§10).** `origin_tick` is the immutable backpointer; `find n,
  origin(n)` returns a relationship and its originating event.
- **Taint (§10).** A queried fact inherits the taint of the spine event it traces
  to — default `P` (graded: structured but not gate-committed). `match` is a gate:
  hits clear θ and are `U` but off-spine.
- **Replay.** State is a fold of the spine; a query reads the log and appends
  nothing.

## The two seams (swap points for Rust + OpenAI)

- **`Cognition`** — `complete()` and `decompose()` (text → facts + triples).
  `AnthropicCognition` (haiku today). Swap to OpenAI by implementing the same
  interface.
- **`Embedder`** — `embed(text) → vector`. `HashingEmbedder` is a dependency-free
  local default (hashed token TF, L2-normalized; cosine = dot). Swap to a real
  embedding model (OpenAI / Voyage / a local transformer) by implementing the same
  interface. The architecture and thresholds don't change.

## The learning loop

A builder agent learns Agape by living on the spine:

1. **Ingest** — chunk `SPEC.md`, append each as a spine event, **internalize** it
   (facts + triples + embedding, with provenance). This *is* the §10 mechanism.
2. **Retrieve** — for a coding task: `match` (vector) the task against the spec,
   `find/where` related concepts, `select` prior lessons. Assemble grounded context.
3. **Write** — the LLM writes Agape source for the task, given that context.
4. **Run** — execute it through the `Runner` (agape-rs: `agape check <file>`).
   Exit 0 = accepted; exit 1 = the checker/runtime error.
5. **Reflect** — on failure, internalize the error + a one-line lesson (more facts /
   triples / embeddings with provenance). On success, record the working pattern.
6. **Repeat** — retry the task with the new lessons, or advance the curriculum.

Every step appends to the spine, so the whole run is replayable and the agent's
competence is literally the fold of its memory.

## The runner

`Runner` is pluggable. `CargoRunner` shells out to `agape-rs`
(`cargo run --bin agape -- check <file>`), which is dependency-free and offline.
If cargo / the binary is unavailable, the loop still ingests, internalizes, and
writes — it just can't get execution feedback, and says so. Building agape-rs once
(`cargo build --release -p agape-rs`) makes step 4 real.

## Endpoints (driven by the studio)

| Method | Path | Does |
|---|---|---|
| POST | `/learn/ingest` | chunk + internalize `SPEC.md` into a fresh agent memory |
| POST | `/learn/step` | run one task through retrieve → write → run → reflect |
| GET | `/learn/state` | spine size + per-store counts + recent lessons |
| GET | `/learn/recall?q=` | `match` the query and return grounded hits (debug the vector store) |

## Run / test

```bash
cd studio/agent-server
npm install
npm test                 # memory, embedder, decomposition shaping (no API key)
npm run dev              # serves /agent/* and /learn/* on :8799
```
