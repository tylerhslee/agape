# Agape OS — MVP Design

## What it is

Agape OS is an operating system written *in* Agape. The kernel is an agent. The shell is an agent. Services are agents. There is no host runtime managing agents from outside the language — the OS describes itself using the same primitives a user program uses.

The core claim: an agentic substrate where processes communicate through events, share knowledge through a queryable world graph, and fail gracefully because errors are events, not exceptions.

---

## The model

| OS concept        | Agape primitive                          |
|-------------------|------------------------------------------|
| Process           | `agent` instance (spawn/awake/sleep)     |
| IPC               | send events (`<-`, `->`)                 |
| Scheduler         | `when` handlers + event spine            |
| Shared memory     | world graph (`find/where`)               |
| Private memory    | per-agent triple store                   |
| System call       | built-in functions + `emit`              |
| Process hierarchy | `extend`                                 |
| Error isolation   | `catch` (retroactive + prospective)      |
| Health monitor    | `verify` contracts + `find` queries      |

---

## Language prerequisites

The following Agape features must be working before implementation begins:

| Feature                     | Status         | Notes                                      |
|-----------------------------|----------------|--------------------------------------------|
| `agent` declaration + body  | Done           |                                            |
| `spawn` / `awake` / `sleep` | In progress    |                                            |
| `when` reactive blocks      | In progress    |                                            |
| `self` reference            | In progress    |                                            |
| `emit`                      | In progress    |                                            |
| `extend` (inheritance)      | In progress    |                                            |
| `if` / `else`               | In progress    |                                            |
| `fn` declarations           | In progress    |                                            |
| f-string interpolation      | In progress    |                                            |
| Arithmetic                  | In progress    |                                            |
| `true` / `false` / `null`   | Needed         | No lexer token yet                         |
| Numeric literals            | Needed         | No `INT`/`FLOAT` token yet                 |
| `<`, `>`, `<=`, `>=`        | Needed         | LT/GT exist for generics, need dual use    |
| `all` / `any` built-ins     | Needed         | Used in hello.ag, not yet defined          |
| `catch` (retroactive)       | Done           |                                            |
| `find` / `where`            | Done           |                                            |
| `verify`                    | Done           |                                            |
| Provider seam (AnthropicProvider) | Done     |                                            |

---

## Agent hierarchy

```
Kernel
├── Shell          — user-facing REPL; parses intent; presents results
├── Planner        — decomposes tasks into subtasks; routes to workers
├── Registry       — tracks what agents exist and what they know
└── Workers (spawned on demand, slept when idle)
    ├── Researcher — LLM-backed retrieval / knowledge queries
    ├── Coder      — code generation
    └── Synthesizer — merges multi-agent outputs into a coherent response
```

**Kernel** is the only always-awake agent. Everything else is spawned by the Kernel on request and slept when idle. This mirrors a real OS: the kernel runs continuously; user processes are created and destroyed around tasks.

---

## Agent templates (sketch)

```agape
// ── Kernel ────────────────────────────────────────────────────────────────
agent Kernel {
    event<null> boot = self <- "You are the OS kernel. Coordinate all agents.";

    when (shell.task_received) {
        spawn Planner p(shell.task_received);
        awake p;
    }

    when (sleep self) {
        emit Event("Kernel shutdown.");
    }
}

// ── Shell ─────────────────────────────────────────────────────────────────
agent Shell {
    event<text> task_received;

    event<null> ready = self <- "You are the OS shell. Accept user input.";

    when (ready) {
        event<text> input = self <- "Awaiting user task...";
        self.task_received = input;
        emit Event(f"Shell received: {input}");
    }
}

// ── Planner ───────────────────────────────────────────────────────────────
agent Planner(event<text> task) {
    event<null> init = self <- "You are a task planner.";

    when (init) {
        event<text[]> subtasks = self <- f"Break into subtasks: {task}";

        spawn Researcher r(subtasks[0]);
        spawn Synthesizer s(subtasks[1]);
        awake r;
        awake s;

        catch Error(r) as e {
            emit Event(f"Researcher failed: {e}. Synthesizer continues with partial data.");
        }

        when (s.result) {
            shell <- s.result;
            sleep r;
            sleep s;
            sleep self;
        }
    }
}

// ── Researcher ────────────────────────────────────────────────────────────
agent Researcher(string query) {
    event<text> result;

    event<null> init = self <- "You are a research agent with broad knowledge.";

    when (init) {
        event<text> answer = self <- f"Research this topic thoroughly: {query}";
        verify answer ~ query;
        self.result = answer;
        emit Event(f"Researcher completed: {query}");
    }

    catch FailedVerification(answer) as e {
        emit Error(f"Researcher could not verify answer quality: {e}");
    }

    when (sleep self) {
        emit Event("Researcher released.");
    }
}

// ── Synthesizer ───────────────────────────────────────────────────────────
agent Synthesizer(string goal) {
    event<text> result;

    event<null> init = self <- "You are a synthesis agent. Merge inputs into a coherent answer.";

    when (init) {
        find research where { Researcher result_for goal };
        event<text> merged = self <- f"Synthesize these findings for: {goal}. Data: {research}";
        self.result = merged;
        emit Event("Synthesizer completed.");
    }

    when (sleep self) {
        emit Event("Synthesizer released.");
    }
}

// ── Registry ──────────────────────────────────────────────────────────────
agent Registry {
    event<null> init = self <- "You are the agent registry. Track system state.";

    when (init) {
        find agents where { Agent is_a Worker };
        emit Event(f"Registry: {agents} workers online.");
    }
}

// ── Boot sequence ─────────────────────────────────────────────────────────
spawn Kernel k;
spawn Shell  shell;
spawn Registry reg;

awake k;
awake shell;
awake reg;
```

---

## Key flows

### 1. Happy path — task completes end-to-end

```
User input
  → Shell receives text, stores as task_received event
  → Kernel's when(shell.task_received) fires
  → Kernel spawns Planner
  → Planner spawns Researcher + Synthesizer
  → Researcher queries LLM, emits result event
  → Synthesizer's when fires, merges, stores in self.result
  → Planner's when(s.result) fires, sends to Shell
  → Shell presents output to user
  → Planner sleeps all workers + self
```

### 2. Worker failure — error isolation

```
Researcher fails mid-run (bad LLM response fails verify)
  → FailedVerificationEvent emitted on Researcher's answer
  → catch Error(r) in Planner fires
  → Planner emits a degraded-mode Event (not an Error — system continues)
  → Synthesizer runs with whatever is in the world graph
  → Shell still receives a response; user sees a warning, not a crash
```

### 3. System introspection via find/where

At any point during or after a run:

```agape
// Who is running?
find agents where { Agent is_a Worker };

// What did the Researcher produce?
find answer where { Researcher result_for answer };

// What failed?
find failures where { FailedVerification emitted_by Worker };

// Trace an output back to its source agent
find who where { shell.result emitted_by Agent is_named who };
```

### 4. Graceful shutdown

```agape
sleep shell;
sleep reg;
sleep k;
// Each agent's when(sleep self) destructor fires in order.
// Registry logs final state. Kernel confirms shutdown.
```

---

## MVP demo script

The demo shows one complete flow against a real LLM (AnthropicProvider):

1. **Boot** — Kernel, Shell, Registry spawn and awake
2. **User task** — Shell receives `"Research the history of operating systems and write a two-paragraph summary"`
3. **Dispatch** — Kernel → Planner → Researcher + Synthesizer
4. **Failure injection** — Researcher's `verify` is intentionally strict; it fails on the first attempt; `catch` handles it; Synthesizer continues
5. **Result** — Shell presents the synthesized summary
6. **Introspection** — `find/where` prints: which agents ran, what they produced, what failed, how long the chain was
7. **Shutdown** — all agents sleep cleanly; destructors fire in order

Total: ~60–80 lines of Agape. Enough to demo every core language feature.

---

## What this demo proves

| Claim | How it's shown |
|---|---|
| Agents are processes | spawn/awake/sleep lifecycle visible in output |
| Events are IPC | every inter-agent message is a named event in the log |
| Errors are events, not exceptions | Researcher fails; system continues; no stack trace |
| `catch` is temporal | handler registered after the failure still fires |
| World graph is queryable | find/where introspects live system state |
| Cognition is swappable | same program runs on StubProvider or AnthropicProvider |

---

## What is explicitly deferred

| Feature | Why deferred |
|---|---|
| Persistence | Memory is in-RAM; agent state doesn't survive restarts |
| True parallelism | Event loop is cooperative for MVP; concurrent agents are a later layer |
| Module / import system | MVP is a single file |
| Networking / distributed agents | Local only for now |
| Security / agent isolation | No OS-level sandbox between agents yet |
| Scheduler priority | `when` handlers fire in registration order; priority is unspecified |

---

## Open design question — `when` concurrency semantics

If two `when` handlers fire in the same tick (e.g., Researcher and Coder both complete simultaneously), what is the execution order?

**Proposed rule for MVP**: first-registered wins (FIFO). Handlers for the same event source fire in the order they appear in source. This is deterministic, easy to reason about, and sufficient for the demo. Revisit when true parallelism is added.

---

## Implementation order

1. Finish in-progress language features (when, self, emit, spawn/awake/sleep, fn, extend, if/else, f-strings, arithmetic)
2. Add missing primitives: `true`/`false`/`null`, numeric literals, `<`/`>`/`<=`/`>=`, `all`/`any`
3. Implement Registry agent (pure Agape, exercises find/where)
4. Implement Researcher agent (exercises when + verify + catch)
5. Implement Synthesizer agent (exercises when + find)
6. Implement Planner agent (exercises spawn + error isolation)
7. Implement Shell + Kernel (exercises the full lifecycle)
8. Wire AnthropicProvider, run the demo script end-to-end
9. Add introspection output (find/where queries printed after the run)
