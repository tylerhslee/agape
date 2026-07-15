import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { eventsOf, expectEventOrder, expectGapFreeTicks, payloadObject, requireEvent } from "../src/assertions.js";

// SPEC 16.3a — Task-send dispatch (delegation runtime contract, §6c).
//
// Delegation is proven at the LANGUAGE level in agape-conformance/tests/06c_delegation. These tests pin
// the same discipline at the RUNTIME-CONTRACT level, black-box through the RuntimeConformanceAdapter: the
// scheduler's assignment path, the Task* ledger receipts and their correlation, foreground fault recovery
// (§16.6), the first-terminal-wins refusal rule, the endorsed-completion handoff, and deterministic replay
// of a delegation trace (§16.5). Correlation for the Task* terminal rows is carried in `subject` (the
// handle / bind name), exactly the key `when (… about h)` filters on (§6c ledger shape, §16.3a aliases).

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.3a task-send dispatch and delegation lifecycle", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  // §6c ("`complete EXPR` resolves the task-send: appends the transport Resolved plus a TaskCompleted
  // record carrying the result") + §16.3a ("TaskCompleted via complete — which also appends the transport
  // Resolved"). Pins the full receipt chain, its correlation to the bound handle, and the result payload.
  it("records the full task-send receipt chain (Sent -> Delivered -> Resolved -> TaskCompleted) correlated by handle", async () => {
    const run = await adapter!.run({
      source: `
        event Done(int got);
        agent Worker { on assigned { complete 42; } }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            int r = w <- task { objective "produce the number"; acceptance "an int"; } expires 10;
            emit Done(r);
          }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    expectEventOrder(run.events, ["Sent", "Delivered", "Resolved", "TaskCompleted", "Done"]);

    // one correlation across the whole chain: the delegator's bound handle name `r`.
    for (const etype of ["Sent", "Delivered", "Resolved", "TaskCompleted"]) {
      requireEvent(run.events, etype, "r");
    }
    const completed = requireEvent(run.events, "TaskCompleted", "r");
    expect(payloadObject(completed).result).toBeTruthy();
    // and the delegator's continuation resumed with the settled result.
    expect(run.events.some((e) => e.etype === "Done")).toBe(true);
  });

  // §6c ("Task<T> h = ... background; h is a settled handle used for correlation: when (TaskCompleted x
  // about h)") + §16.3a assignment. Pins that a background worker completion is delivered to the
  // delegating reaction rather than faulting the delegator's flow.
  it("delivers a background worker completion to the delegating reaction via when(TaskCompleted about h)", async () => {
    const run = await adapter!.run({
      source: `
        event Landed(int got);
        agent Worker { on assigned { complete 7; } }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            Task<int> h = w <- task { objective "produce"; acceptance "an int"; } expires 10;
            when (TaskCompleted c about h) { emit Landed(7); }
          }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    requireEvent(run.events, "TaskCompleted", "h");
    expectEventOrder(run.events, ["Sent", "Delivered", "TaskCompleted", "Landed"]);
    // background delivery: the delegator did NOT fault.
    expect(run.events.some((e) => e.etype === "AgentCrashed")).toBe(false);
  });

  // §6c ("`fail EXPR` appends TaskFailed(reason); the transport chain simply stops at its Delivered prefix
  // — a stalled prefix is not a violation"). A background delegator observes it with `when`.
  it("records TaskFailed(reason) on worker fault, resting at the Delivered prefix with no Resolved/TaskCompleted", async () => {
    const run = await adapter!.run({
      source: `
        event FailSeen(text why);
        agent Worker { on assigned { fail "acceptance criteria unmeetable"; } }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            Task<int> h = w <- task { objective "produce"; acceptance "an int"; } expires 10;
            when (TaskFailed f about h) { emit FailSeen("seen"); }
          }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    const failed = requireEvent(run.events, "TaskFailed", "h");
    expect(payloadObject(failed).reason).toBe("acceptance criteria unmeetable");
    requireEvent(run.events, "FailSeen");
    // the chain rests at Delivered — no Resolved and no completion for this correlation.
    expect(run.events.some((e) => e.etype === "Resolved" && e.subject === "h")).toBe(false);
    expect(run.events.some((e) => e.etype === "TaskCompleted")).toBe(false);
  });

  // §6c ("Foreground fault") + §16.6 ("Foreground task failure ... faults the delegator's awaiting
  // invocation through the crash path; on crash recovers with state intact"). A result-bound delegation
  // whose terminal is not TaskCompleted must fault the delegator, not silently drop.
  it("faults the delegator's awaiting invocation when a foreground task terminal is not TaskCompleted, recovering via on crash", async () => {
    const run = await adapter!.run({
      source: `
        event Done(int got);
        event Recovered(text how);
        agent Worker { on assigned { fail "cannot"; } }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            int r = w <- task { objective "produce"; acceptance "an int"; } expires 10;
            emit Done(r);
          }
          on crash { emit Recovered("compensated"); }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    requireEvent(run.events, "TaskFailed", "r");
    expectEventOrder(run.events, ["TaskFailed", "AgentCrashed", "Recovered"]);
    requireEvent(run.events, "AgentCrashed", "lead");
    // the awaiting continuation was abandoned before the sink — Done never runs.
    expect(run.events.some((e) => e.etype === "Done")).toBe(false);
  });

  // §6c ("a worker that completes with an Endorsement<T> hands over a settled, ledger-backed subject — the
  // delegator may sink it directly"). The delegated result is settled, so the delegator's `perform` runs
  // with no margin-floor or task-scope fault and no crash.
  it("settles an endorsed completion so the delegator sinks the result directly", async () => {
    const run = await adapter!.run({
      source: `
        enum Quality { Good, Bad }
        action Publish(text body);
        agent Worker {
          on assigned {
            text draft = self <- "write the copy";
            Credence<Quality> q = self <- f"is the copy good: \${draft}";
            Decision<Quality> d = decide q by confidence 0.9;
            if (d.committed == Good) {
              Endorsement<text> e = endorse draft by d;
              complete e;
            } else { fail "copy not good enough"; }
          }
        }
        agent Lead grants { reach Worker, perform Publish } {
          on awake {
            spawn Worker w; awake w;
            Endorsement<text> body = w <- task { objective "write the launch copy"; acceptance "one endorsed paragraph"; } expires 10;
            perform Publish(body);
          }
        }
        spawn Lead lead; awake lead;
      `,
      testMode: { provider: { credence: { Good: 0.95, Bad: 0.05 }, kind: "static", text: "great copy" } },
    });

    expect(run.ok).toBe(true);
    const completed = requireEvent(run.events, "TaskCompleted", "body");
    const result = payloadObject(completed).result as Record<string, unknown>;
    expect(result.kind).toBe("endorsement");
    expect(result.committedNarrowed).toBe(true);
    // the delegator sank the settled subject — Publish ran and nothing faulted.
    expectEventOrder(run.events, ["TaskCompleted", "Publish"]);
    expect(run.events.some((e) => e.etype === "MarginFloorViolation")).toBe(false);
    expect(run.events.some((e) => e.etype === "TaskScopeViolation")).toBe(false);
    expect(run.events.some((e) => e.etype === "AgentCrashed")).toBe(false);
  });

  // §6c ("a late complete/fail for a cancelled (or expired) task is refused and recorded as
  // CompletionRefused") + §16.3a ("The first terminal for a correlation wins ... A late complete/fail after
  // a tombstone appends CompletionRefused(corr); the payload is discarded"). The worker's own late
  // `complete` (reached after a cooperative cancel fired inside its handler) must not win.
  it("refuses and records a late completion after a tombstone (CompletionRefused) — first terminal wins", async () => {
    const run = await adapter!.run({
      source: `
        event CancelAck(text ok);
        agent Worker {
          on assigned { emit TaskProgress("working"); complete 1; }
          on cancelled { emit CancelAck("stopped"); }
        }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            Task<int> h = w <- task { objective "long haul"; acceptance "an int"; } expires 10;
            when (TaskProgress p about h) { cancel h; }
          }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    // the cancel tombstone is authoritative and precedes the refused late completion.
    expectEventOrder(run.events, ["TaskProgress", "TaskCancelled", "CompletionRefused"]);
    requireEvent(run.events, "TaskCancelled", "h");
    requireEvent(run.events, "CompletionRefused", "h");
    // the late complete was discarded — the task never reports completion.
    expect(run.events.some((e) => e.etype === "TaskCompleted")).toBe(false);
  });

  // §6c ("a `perform` executed while running an assigned task requires both the static grant AND an active
  // task that is endorsed and names NAME in its scope ... failing it faults the action (TaskScopeViolation,
  // §16.6)") + §16.6. A plain (unendorsed, unscoped) task enables nothing at the sink.
  it("faults a perform inside an unendorsed task with TaskScopeViolation at the sink, and the task never completes", async () => {
    const run = await adapter!.run({
      source: `
        action Deploy(text artifact);
        agent Worker grants { perform Deploy } {
          on assigned { perform Deploy("artifact-v2"); complete 1; }
        }
        agent Lead grants { reach Worker } {
          on awake {
            spawn Worker w; awake w;
            Task<int> h = w <- task { objective "ship it"; acceptance "an int"; } expires 10;
          }
        }
        spawn Lead lead; awake lead;
      `,
    });

    expect(run.ok).toBe(true);
    const violation = requireEvent(run.events, "TaskScopeViolation", "w");
    expect(payloadObject(violation).action).toBe("Deploy");
    requireEvent(run.events, "AgentCrashed", "w");
    // the action never ran, and the faulted handler never reached its `complete`.
    expect(run.events.some((e) => e.etype === "Deploy")).toBe(false);
    expect(run.events.some((e) => e.etype === "TaskCompleted")).toBe(false);
  });

  // §16.5 ("A faithful replay regenerates an identical ledger and therefore an identical chain-head (T4) ...
  // Replay invokes nothing external"). A delegation trace with worker-side provider calls must replay to
  // the same head with zero oracle re-invocation.
  it("replays a delegation trace deterministically — identical chain-head, zero provider re-invocation", async () => {
    const run = await adapter!.run({
      source: `
        enum Quality { Good, Bad }
        action Publish(text body);
        agent Worker {
          on assigned {
            text draft = self <- "write the copy";
            Credence<Quality> q = self <- f"is the copy good: \${draft}";
            Decision<Quality> d = decide q by confidence 0.9;
            if (d.committed == Good) {
              Endorsement<text> e = endorse draft by d;
              complete e;
            } else { fail "copy not good enough"; }
          }
        }
        agent Lead grants { reach Worker, perform Publish } {
          on awake {
            spawn Worker w; awake w;
            Endorsement<text> body = w <- task { objective "write the launch copy"; acceptance "one endorsed paragraph"; } expires 10;
            perform Publish(body);
          }
        }
        spawn Lead lead; awake lead;
      `,
      record: true,
      testMode: { provider: { credence: { Good: 0.95, Bad: 0.05 }, kind: "static", text: "great copy" } },
    });

    expect(run.ok).toBe(true);
    expect(run.recording).toBeTruthy();
    // sanity: the trace really did drive worker-side oracle calls and land a task completion.
    expect(eventsOf(run.events, "TaskCompleted").length).toBeGreaterThanOrEqual(1);

    const before = await adapter!.oracleStats();
    const replay = await adapter!.replay(run.recording);
    const after = await adapter!.oracleStats();

    expect(replay.ok).toBe(true);
    expect(replay.headHash).toBe(run.headHash);
    expect(after.providerCalls).toBe(before.providerCalls);
    expect(after.toolCalls).toBe(before.toolCalls);
  });
});
