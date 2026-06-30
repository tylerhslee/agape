# Agape Runtime Specification (Draft v0.1)

> Status: normative draft. This document defines the runtime contract shared by
> the Rust CLI runtime, the Studio runtime, and hosted runtimes such as Soma.
> `SPEC.md` defines the language. This document defines the operational substrate
> that makes that language true over time.

---

## 1. Scope

An Agape runtime is the authority for one running Agape system. It owns:

- the append-only ledger;
- the agent population and lifecycle;
- provider, identity, tool, prompt, and memory dependencies;
- each agent instance's private memory;
- replay, inspection, and runtime API surfaces.

A runtime does not share mutable state with another runtime. Studio, a product
app, and Soma tenant runtimes are separate runtimes unless explicitly connected
through an external protocol. If two runtimes communicate, their messages are
ordinary ledgered events at each boundary.

The runtime is not "global agent memory." The runtime has a ledger. Agents have
private memory.

---

## 2. Required Invariants

Every conforming runtime preserves these invariants:

1. **Ledger as source of truth.** Every meaningful action appends a canonical event
   to one append-only, hash-chained ledger. Runtime state is a projection of the
   ledger plus recorded oracle results.
2. **Per-agent private memory.** Each agent instance owns its own fact table,
   relationship graph, and vector store. No agent may read or mutate another
   agent's memory except through an explicit, ledgered Agape interaction.
3. **Mandatory memory envelope.** Every agent reaction consults private memory
   before cognition and internalizes the resulting experience after cognition,
   tool use, check/test feedback, run feedback, or user correction.
4. **No silent memory bypass.** An empty memory lookup is still a meaningful
   result. The runtime records that memory was consulted and returned no
   applicable context.
5. **Memory cannot launder trust.** Recalled memory is subjective. It remains
   tainted according to SPEC section 10 and must be re-gated before consequential
   use.
6. **Artifact knowledge is agent-owned.** A project file, uploaded file, spec
   document, README, test result, or run ledger is a knowledge artifact. When an
   agent learns from it, that knowledge is internalized into that agent's private
   memory with provenance.
7. **Replay does not re-invoke oracles.** Provider, identity, tool, memory
   decomposition, summary, and embedding outputs needed for replay are
   recorded or reproducibly derived from recorded outputs.
8. **Behavior lives in source.** Agent instructions and authority are source and
   config artifacts. Memory may guide a turn, but it cannot rewrite source-settled
   instruction, grants, policy, or dependency bindings.

---

## 3. Runtime Identity And Isolation

Each runtime has a stable runtime id and runtime kind:

- `rust-local` for the CLI/toolchain runtime;
- `studio-local` for the Studio control-plane runtime;
- `cloud` or `soma` for hosted runtimes.

Each agent instance has a stable runtime-local id. Multiple instances of the same
agent template are distinct cognitive entities and have distinct private memory
namespaces.

Recommended identity shape:

```text
runtime_id
agent_template
agent_instance_id
agent_generation
ledger_head
```

`agent_generation` changes when an agent is collected and respawned as a fresh
entity. Sleeping, waking, or crashing does not erase memory.

---

## 4. Ledger Contract

The ledger is append-only and totally ordered within a runtime. Each event
includes at least:

```text
tick
etype
subject
payload
corr
agent
ts
prev_hash
hash
```

Implementations may store extra fields, but canonical replay defines which fields
are hashed. The canonical hash algorithm, serialization, and redaction rules are
fixed per runtime version and advertised by runtime metadata.

The ledger records objective shared history. It is queried as the ledger. It is
not queried with memory recall syntax and is not treated as a memory store.

---

## 5. Agent Private Memory Architecture

Each agent instance owns one private memory unit with three modalities:

| Modality | Required store | Query role |
|---|---|---|
| Facts | relational table | exact/selective facts |
| Relationships | SPO graph | concept/entity relations |
| Semantics | vector index | similarity recall |

Each memory cell includes:

```text
agent_instance_id
modality
key_or_subject
value_or_edge
origin_tick
taint
basis_head
valid_through
dependency_scope
created_at
```

Memory cells point back to the ledger event that caused them. If an implementation
physically deduplicates storage across agents, the semantic memory projection is
still per-agent. Shared physical storage cannot create shared subjective memory.

---

## 6. Mandatory Memory Envelope

Every agent reaction executes this envelope:

```text
1. Receive stimulus.
2. Append or identify the ledger event representing that stimulus.
3. Build a memory query from the stimulus, current task, agent role, and ledger head.
4. Consult the agent's private facts, graph, and vector memory.
5. Append MemoryConsulted with counts, query metadata, and result provenance.
6. Build the cognition/tool/action context from source instruction, project context,
   and the memory packet.
7. Execute the reaction.
8. Append resulting ledger events.
9. Internalize the experience into the same agent's private memory.
```

The memory packet supplied to cognition includes, within budget:

- whole-artifact summaries relevant to the task;
- precise chunk/vector hits with origin ticks;
- graph relationships relevant to entities in the task;
- prior lessons, failures, and working patterns;
- recent related run/check/test outcomes;
- the fact that memory was empty, when applicable.

The runtime may tune limits, ranking, summarization, and embedding backends. It
does not omit steps 4, 5, or 9 merely to save cost. A cost-constrained runtime may
record a budget-limited memory packet, but the packet says it was limited.

---

## 7. Knowledge Artifact Internalization

A knowledge artifact is any durable input an agent is allowed or instructed to
learn from:

- `SPEC.md` or any project file;
- README/design docs;
- generated code;
- check/test/run output;
- user correction or review;
- tool result;
- prior ledger slice;
- hosted document or uploaded file.

Artifact internalization is an agent capability, not an ambient sweep over every
file the runtime can see. An agent internalizes an artifact when source,
configuration, a user instruction, or host initialization policy explicitly
selects that artifact as part of the agent's knowledge. The runtime provides the
operation and preserves provenance; it does not decide that every visible artifact
is learned by default.

When an agent internalizes an artifact, the runtime preserves both whole-artifact
context and precise chunks:

```text
1. Record ArtifactObserved(kind, uri, source_hash, title).
2. Summarize the whole artifact for future orientation.
3. Chunk the artifact with stable chunk hashes.
4. Decompose new chunks into facts and SPO triples.
5. Embed new chunks.
6. Store summary, facts, triples, and embeddings in the agent's private memory.
7. Record provenance from each cell to its ledger event and artifact hash.
```

Chunking by headings is the default for Markdown and source files with clear
sections. The summary is part of artifact internalization because chunks alone can
lose the artifact's larger purpose.

Re-ingesting an unchanged artifact is idempotent: source hash and chunk hashes
prevent duplicate memory cells. When an artifact changes, new chunks are added and
old chunks remain historical unless a tombstone/retraction event marks them
superseded.

File upload is not special. A file saved in the project folder and read by an
agent can be internalized through the same artifact mechanism.

---

## 8. Learning From Experience

Every agent-internal experience that can improve future behavior is recorded and
internalized:

- code written;
- tests written or selected;
- `agape check` results;
- `agape run` results and ledger events;
- unit/integration/conformance test pass/fail;
- provider failures;
- tool failures;
- user feedback and corrections;
- accepted working patterns.

For implementation work, agents follow:

```text
consult memory -> write/identify tests -> implement -> run checks/tests ->
internalize pass/fail -> retry or report
```

Failure memories are distilled into reusable lessons. Success memories are stored
as working patterns. User correction outranks inferred lessons when retrieval
conflicts.

---

## 9. Replay And Determinism

Replay reproduces the same ledger head for the same recorded run. During replay,
the runtime does not re-call:

- cognition completions;
- decomposition/summarization calls;
- embedding calls, unless embeddings are deterministically derived and versioned;
- identity decisions;
- tools.

If an implementation uses a non-deterministic provider for decomposition or
summarization, the result must be journaled. If it uses deterministic local
decomposition, the algorithm version must be part of runtime metadata.

Memory is a projection of ledgered events and recorded oracle outputs. A faithful
runtime can rebuild memory from the ledger or verify materialized memory against
ledger provenance.

---

## 10. Runtime API Surface

Any interactive runtime, including Studio and Soma, exposes these operations or
an equivalent transport-level surface:

| Operation | Required behavior |
|---|---|
| `health` | runtime id, version, language version, ledger head, provider status |
| `run` | execute source or project entry and return events/head |
| `check` | run static checks and return structured diagnostics |
| `ledger.read` | query event ranges and subjects |
| `agent.respond` | run an agent turn through the memory envelope |
| `memory.ingest` | internalize an artifact into one agent's private memory |
| `memory.context` | return the memory packet for a task without cognition |
| `memory.inspect` | inspect counts, summaries, recent cells, and provenance |
| `config.read/write` | manage provider, tool, identity, and memory budgets |

The transport may be HTTP, MCP, stdio, WebSocket, or another protocol. The
semantic contract is independent of transport.

---

## 11. Conformance Requirements

A runtime is memory-conformant only if it passes tests for:

1. mandatory memory consultation on every agent turn, including empty memory;
2. per-agent memory isolation across multiple instances of the same template;
3. artifact summary + chunk + fact + graph + vector ingestion when an artifact is internalized;
4. idempotent unchanged artifact ingestion;
5. check/test/run failure internalization;
6. check/test/run success internalization;
7. user correction internalization and retrieval precedence;
8. memory provenance back to ledger origin ticks;
9. replay without re-invoking provider/tool/decomposition oracles;
10. no memory-to-action trust laundering.

The Rust runtime, Studio runtime, and Soma runtime share a runtime conformance
suite for these behaviors. Studio may have UI-specific tests, and Soma may have
cloud isolation tests, but the memory envelope tests are common.

---

## 12. Runtime Lockstep

The release process reports:

- language spec version;
- runtime spec version;
- runtime implementation version;
- conformance suite version;
- memory schema/projection version;
- provider/decomposition/embedding algorithm versions.

Changing the memory envelope, ledger schema, replay contract, or private-memory
semantics requires a runtime spec update and conformance tests before it is
considered implemented.
