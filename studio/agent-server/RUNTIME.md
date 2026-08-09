# Simulating the Agape runtime — memory + the learning loop

This is a working Studio-runtime implementation of the part of the Agape runtime
that matters most for any agent that must **learn Agape and get good at it**: the
**ledger** (§7), the **three-modality memory** (§10), and the mandatory memory
envelope defined in [SPEC.md](../../SPEC.md) §16.7. On top of it runs a learning loop —
read an artifact, summarize it, internalize it, write Agape, run it, learn from
failures, repeat.

It is a TypeScript implementation of the runtime contract that local Studio and
Soma/cloud runtimes must satisfy. Storage choices may differ, but ledger,
private-memory, provenance, replay, and learning semantics must stay in lockstep.

## The memory architecture (faithful to SPEC §10, §7)

One unit, three modalities — every cell carries a provenance backpointer to the
ledger event (§7) that produced it, exactly as §10 requires.

| Modality | SPEC | Store (SQLite) | Query |
|---|---|---|---|
| **FACTS** | deterministic table | `facts(agent, key, value, origin_tick, taint)` | `select` |
| **RELATIONSHIPS** | SPO graph over a typed predicate set | `triples(agent, s, p, o, origin_tick, taint)` | `find … where` |
| **SEMANTICS** | vector store | `embeddings(agent, text, vec, origin_tick)` | `match … > θ` |

The **ledger** is the source of truth and everything else folds from it. The
current TypeScript prototype keeps the legacy SQLite table name `spine`:

```
spine(tick PK monotonic, etype, subject, payload, corr, agent, ts)
```

- **Internalization (§10).** Every event an agent receives is decomposed by the
  provider (cognition) into facts + SPO triples + an embedding, all written with
  `origin_tick` = the event that produced them. Non-deterministic content, fixed
  shape (typed facts; SPO triples).
- **Provenance (§10).** `origin_tick` is the immutable backpointer; `find n,
  origin(n)` returns a relationship and its originating event.
- **Taint (§10).** A queried fact inherits the taint of the ledger event it traces
  to — default `P` (graded: structured but not gate-committed). `match` is a gate:
  hits clear θ and are `U` but off-ledger.
- **Replay.** State is a fold of the ledger; a query reads the log and appends
  nothing.

## The two seams (swap points for providers and embeddings)

- **`Cognition`** - `complete()` and `decompose()` (text -> facts + triples).
  `AnthropicCognition` and `OpenAICognition` plug in behind the same interface;
  `MockCognition` remains the offline default.
- **`Embedder`** - `embed(text) -> vector`. `HashingEmbedder` is a dependency-free
  local default (hashed token TF, L2-normalized; cosine = dot). When OpenAI is
  configured, `OpenAIEmbedder` provides live embeddings behind the same interface.
  The architecture and thresholds do not change.

## The learning loop

Studio's Builder operator learns Agape by living on the ledger. This is Studio's
application policy for that operator; the shared runtime rule is only that agents
can internalize selected artifacts into their own private memory:

1. **Ingest** — summarize the whole artifact, chunk `SPEC.md`, append each new
   chunk as a ledger event, **internalize** it (facts + triples + embedding, with
   provenance). The summary travels with future recall packets so chunk retrieval
   never loses the document's larger shape.
2. **Retrieve** — for a coding task: `match` (vector) the task against the spec,
   `find/where` related concepts, `select` prior lessons. Assemble grounded context.
3. **Write** — the LLM writes Agape source for the task, given that context.
4. **Run** - execute it through the `Runner` (`agape-ts check <file>`).
   Exit 0 = accepted; exit 1 = the checker/runtime error.
5. **Reflect** — on failure, internalize the error + a one-line lesson (more facts /
   triples / embeddings with provenance). On success, record the working pattern.
6. **Repeat** — retry the task with the new lessons, or advance the curriculum.

Every step appends to the ledger, so the whole run is replayable and the agent's
competence is literally the fold of its memory.

## Persistent application runtime sessions

Studio owns a registry of live `agape-ts` `RuntimeSession` objects. A session has
one immutable project subject, lineage ID, session ID, conversation ID, and
host-verified application-user identity. Prompt turns reuse that exact runtime,
so ledger ticks and named-memory recording continue instead of restarting a CLI
process for every message.

A principal gate appends `PendingPrincipalDecision` before the runtime invokes
Studio's `onConsult` hook. Studio returns that pending state to the client while
the runtime promise remains blocked. A ruling can resume it only with the opaque
bearer capability for that session, the current request ID, and the exact pending
principal. Accepted rulings carry a host HMAC over the session, lineage,
conversation, project, application user, request, decision, and pending tick;
the runtime's attester verifier checks every binding. Wrong, stale, duplicate,
or tampered rulings fail closed.

Studio exposes **action authorization certificates** only after restoring and
hashing the canonical ledger and independently validating the exact
`Decided -> Endorsed -> ActionAuthorized -> action` links, typed argument and request
commitments, receipt sequence, principal attestation, and protected-envelope bindings.
A certificate proves kernel admission and a committed action attempt; only a separate
`ToolResolved` row proves that a wired external effector completed.

## The runner

`Runner` is pluggable. `AgapeTsRunner` shells out to the TypeScript Agape CLI
(`agape-ts check <file>`), which is deterministic and offline with the mock
provider. If the TypeScript dependencies are unavailable, the loop still ingests,
internalizes, and writes; it just cannot get execution feedback, and says so.

## Endpoints (driven by the studio)

| Method | Path | Does |
|---|---|---|
| POST | `/learn/ingest` | summarize, chunk, dedupe, and internalize `SPEC.md`, a project-relative artifact (`rel`), or an inline body into one agent's private memory |
| POST | `/learn/step` | run one task through retrieve → write → run → reflect |
| GET | `/learn/state` | ledger size + per-store counts + recent lessons |
| GET | `/learn/recall?q=` | `match` the query and return grounded hits (debug the vector store) |
| POST | `/runtime/sessions` | start one project runtime session and receive its one-time bearer capability |
| GET | `/runtime/sessions/:id` | inspect the authenticated session, ledger, pending ruling, and validated action authorization certificates |
| POST | `/runtime/sessions/:id/prompts` | deliver another prompt to the same runtime session |
| POST | `/runtime/sessions/:id/rulings` | decide or decline the exact pending principal request, then resume that session |
| POST | `/runtime/sessions/:id/close` | close a quiescent session and its runtime-owned resources |

## Run / test

```bash
cd studio/agent-server
npm install
npm test                 # memory, embedder, decomposition shaping (no API key)
npm run dev              # serves /agent/* and /learn/* on :8799
```
