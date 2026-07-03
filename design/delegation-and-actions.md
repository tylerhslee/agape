# Design: Subagent delegation and the action/tool split

Status: **shipped** (2026-07-02, commit 59ca03c) — EXCEPT §2 (the action/write-tool split),
which owner review superseded on 2026-07-03: `tool` left the language entirely; see
[[design/world-interface.md]]. The delegation half (§1, §3–§12) stands as shipped.
Decided interactively with the owner; supersedes the earlier draft summary
(`receiver <- self { … }` form) where they differ. Follows doc → test → build:
this document first, conformance tests second, compiler/runtime third.

Design stance, one line: **delegation is not a new communication primitive — it is a
send with a governed payload and a programmatic reply.**

---

## 1. Kernel accounting

Almost all of this design is sugar over existing kernel primitives (structs, events,
`when`, the send lifecycle, endorse, taint contagion). Exactly **two kernel
extensions** are required:

1. **Programmatic resolution.** Today a send is answered *by thinking* — one provider
   invocation (§6). `complete r;` (and `fail reason;`) let the recipient of a task-send
   resolve it with a computed value instead: a handler run (tools, gates, sub-sends)
   ends in `complete`. This is the entire semantic difference between "ask an agent a
   question" and "delegate a task."
2. **Task-scoped perform enablement.** A runtime check at the sink (same shape as the
   margin floor). **Not** an authority widening — §14's invariant ("grants are never
   widened by runtime data") and soundness T1 are unchanged.

Everything else is compiler-level.

## 2. The action / write-tool split

- Keep `read tool` **and** `write tool` declarations, both mandatory effect classes
  (§6b unchanged lexically). What changes is callability only:
  - `read tool` — declared and **directly callable** (needs `use NAME` grant, as today).
  - `write tool` — declared but **not callable from source**. A direct call is a
    compile error. It is reachable only through a bound action.
- `action NAME(fields) uses TOOL;` — source-level binding of a performative to at most
  **one** write tool. Multiple actions may share one tool (different domain framings).
  `uses` on a read tool is a compile error.
- An action with **no** `uses` stays legal: a pure ledgered performative (current §13
  behavior) whose effect is the record itself.
- `perform NAME(args)` is the **only** source syntax that executes a write tool.
  Consequential-sink rules (settled + endorsed inputs, margin floor) apply at the
  perform, as today.
- `use <writeTool>` in a grants clause becomes **illegal** — `perform NAME` subsumes it.
- Endpoint binding stays in config (`[tools.deploy] driver = "mcp" tool = "infra.deploy"`);
  no endpoint/secret in source. So binding is **both layers**: source binds action→tool
  (auditable, compile-checked), config binds tool→endpoint.
- Audit property: the `write tool` declarations enumerate a program's entire mutation
  surface; the `action … uses` declarations enumerate how each mutation is reachable.

Spec edits forced: §6b/§13 currently describe write tools as directly-callable sinks —
rewrite to the single-door rule; grammar (§15.2) gains `uses`.

## 3. Delegation surface

**Rejected:** `researcher <- self { … }` (the RHS `self` is redundant or an
authority-laundering hazard; `<- self;` vs `<- self { };` is a one-token semantic cliff).

**Adopted:** the message *is* the task — a keyword-introduced task literal, ordinary
receiver-left send, `expires` in its existing §6 postfix position:

```agape
// foreground (result-bound)
ResearchResult r = researcher <- task {
  objective obj;          // text, literal or variable
  acceptance crit;        // text, literal or variable
} expires ttl;            // ttl: any settled numeric expression

// background (handle-bound)
Task<ResearchResult> h = researcher <- task { … } expires ttl;

// endorsed task (perform-granting) — message typed Endorsement<TaskSpec>
DeployResult d = deployer <- approved expires ttl;
```

Rules:
- A `task { }` literal produces a canonical `TaskSpec` struct. `objective` and
  `acceptance` are **required**, both `text`; empty block is a compile error.
- Optional `scope { perform NAME, … }` clause inside the literal (see §5).
- `expires` is **mandatory on every delegation** (foreground and background): every task
  is terminal by construction — exactly one of Completed / Failed / Expired / Cancelled
  lands on the ledger. This is also what converts a lost send (never `Delivered`,
  silence by §6) into a signal: the `Expired` tombstone is appended by the delegator's
  runtime.
- **Binding is mandatory.** Foreground binds the result `T`; background binds a settled
  `Task<T>` handle (usable in `when (… about h)` and `cancel h;`). Bare statement-form
  delegation is a compile error — every task must be addressable.
- Foreground vs background is **dataflow, not a keyword**: result-bound waits;
  handle-bound doesn't.

## 4. Trust

- TaskSpec trust is the join of its fields (existing contagion rule): tainted
  objectives/acceptance stay tainted. **Delegation does not launder trust.**
- A task that grants perform scope must be an `Endorsement<TaskSpec>`, constructible
  only inside a committed branch (existing endorse rule, no new machinery):

```agape
if (d.committed == Approved) {
  Endorsement<TaskSpec> approved = endorse draft_task by d;
  DeployResult r = deployer <- approved expires ttl;
}
```

## 5. Authority: static grant ∧ task enablement

- The worker must **statically** hold `perform NAME` in its grants. The upper bound
  never moves; §14 invariant and T1 untouched.
- The endorsed task's `scope { perform NAME }` is a **runtime enablement check at the
  sink**, like the margin floor: a `perform` executed while running an assigned task
  requires the active task to be endorsed AND name that action in scope. A perform with
  no active task needs only the static grant.
- **Attenuation, never amplification**: the delegator must itself hold `perform NAME`
  to include it in a scope clause (compile-checked).

## 6. Failure model

| situation | mechanism |
|---|---|
| foreground task Failed / Expired / Cancelled | **faults the delegator's awaiting invocation** via the existing contained-crash path (§5): invocation abandoned, `AgentCrashed`, `on crash` runs with state intact; the reason is the `TaskFailed(reason)` ledger row, one query away by `corr`. No Result/option types introduced. Precedent: a task that comes back empty is the same shape as "the provider returns nothing," which already faults. |
| background task outcome | reactive `when (TaskCompleted/TaskFailed about h)`; the backstop is the ledger itself — terminal events are durable rows, findable later by query even if the agent was asleep. |
| lost send | absence of `Delivered` (§6, not an event); mandatory `expires` converts it into a `TaskExpired` tombstone. |

## 7. Cancellation (cooperative)

- `cancel h;` appends `TaskCancelled` immediately — the **authoritative tombstone**.
- The worker's in-flight handler is **not preempted** (no preemption machinery; handler
  invocations stay atomic). Its `on cancelled` hook fires; its eventual
  `complete`/`fail` is **refused** and recorded, exactly like a post-`Expired` delivery
  (`DeliveryRefused` discipline, §6).

## 8. Ledger shape: lean rows + projections

Rejected: a single `TaskUpdated(status)` event (fights type-keyed `when`, needs
nullable/union payloads the kernel lacks, and degrades the §6 prefix-safety property
from structural to value-dependent).

Adopted:
- **Subscription-layer aliases, zero new rows:** `TaskSubmitted ≡ Sent`,
  `TaskAssigned ≡ Delivered`, `TaskExpired ≡ Expired` — the compiler rewrites
  `when (TaskAssigned about h)` to a `Delivered` subscription filtered to task-sends.
- **Four real event types** (genuinely new payloads, correlated by `corr`):
  - `TaskCompleted(T result)` / `TaskFailed(text reason)` — programmatic terminals
  - `TaskCancelled` — delegator-initiated tombstone
  - `TaskProgress(text note)` — the one repeatable, worker-emittable event
- The unified "one status per task" view is a **ledger projection** (`select … from
  ledger` folding the chain per `corr`; Studio task timeline) — status-as-data at the
  query layer, types at the event layer. Precedent: GateProfile is already a projection.

## 9. Worker surface

```agape
agent Researcher {
  on assigned {                    // sugar for the filtered Delivered subscription
    ResearchResult r = self <- "complete the assigned task";
    complete r;                    // programmatic resolution (kernel ext. #1)
  }
  on cancelled { /* stop cooperatively */ }
}
```

- **Hooks: `on assigned` and `on cancelled` only.** `on submitted` dropped (delegator-
  side, it's just the next line after the send); `on completed`/`on failed` dropped
  (worker-side marginal; delegator-side is `when`/crash). Everything else is explicit
  `when`.
- Verbs: `complete expr;` and `fail expr;`, valid only inside a task handler.
- **Task context channel (specified, not magic):** while a task handler runs, the
  active TaskSpec (objective, acceptance) composes into the provider context in fixed
  documented order: global `instruction` → agent `instruction` → active task. The task
  text enters as **data, not instruction** — a tainted objective cannot override
  instruction guardrails (consistent with §5 "settled by source").

## 10. Composition notes

- Delegation composes with `|>` (fan-out over a finite collection of workers) and the
  results with `quorum`/`independent`/`dependent` — parallel delegation with principled
  fusion, a differentiator no framework competitor has.
- Re-delegation by a worker is governed by its own `reach`/grants — default-deny
  already covers it.
- Supervisor loops ("re-delegate until acceptance is met") are deliberately
  inexpressible (no unbounded loops); the idiomatic form is a `when (TaskFailed …)`
  re-dispatch, bounded by design. The spec should show this pattern explicitly — it is
  the #1 objection evaluators coming from LangGraph will raise.
- Known market gaps accepted for v1: no retry policy (retry layer deferred), progress
  is `TaskProgress` events not streaming.

## 11. Competitive position (summary)

The `objective`/`acceptance` shape matches market-validated ergonomics (CrewAI
`Task(description, expected_output)`); grants, typed results, expiry, principal
escalation are table stakes already present. Differentiated and defensible:
taint-preserving delegation, endorsed authority attenuation, terminal-by-construction
tasks ("no zombie subagent tasks — deadlines are in the language"), ledgered lifecycle
with deterministic replay, quorum fusion over parallel workers.

## 12. Spec-edit checklist (phase: doc → SPEC)

- §2 keywords: `task`, `uses`, `scope`, `complete`, `fail`, `cancel` (+ contextual
  `objective`, `acceptance`); prelude events `TaskCompleted`, `TaskFailed`,
  `TaskCancelled`, `TaskProgress`; prelude types `TaskSpec`, `Task<T>`.
- §6b + §13: write tools no longer directly callable; single-door rule; `use` illegal
  on write tools; action `uses` binding.
- §6: delegation as task-send; mandatory `expires`; alias events.
- §5: `on assigned` / `on cancelled` hooks; task context composition order.
- §13: scope-enablement check at the sink (beside the margin floor).
- §14/§15: note that T1 is unchanged (static grants remain the bound); add the
  enablement check to §15.3.3; `complete`/`fail` dynamic semantics in §15.4.
- §16: task lifecycle in the journal; cancellation-refusal; projection for task status.
- §17: no new manifest keys beyond existing `[tools.*]`.
