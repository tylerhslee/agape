import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { eventsOf, requireEvent } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.4 and 16.6 seams, faults, and recovery", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("treats schema violation as TypeMismatch that retry can handle without crashing the agent", async () => {
    const run = await adapter!.run({
      source: `
        struct Memo { body: text }
        agent A {
          on awake {
            {
              event<Memo> memo = self <- "extract memo";
            } retry(2)
          }
        }
        spawn A a; awake a;
      `,
      testMode: {
        providerReplies: [
          { mode: "schema_violation" },
          { payload: { body: "ok" } },
        ],
      },
    });

    expect(run.ok).toBe(true);
    requireEvent(run.events, "TypeMismatch");
    expect(run.events.some((e) => e.etype === "AgentCrashed")).toBe(false);
    expect(eventsOf(run.events, "Resolved").length).toBeGreaterThanOrEqual(1);
  });

  it("records AgentCrashed and runs the crash hook for unrecoverable seam failure", async () => {
    const run = await adapter!.run({
      source: `
        event Recovered(text id);
        agent A {
          on crash { emit Recovered("a"); }
          on awake { self <- "provider returns nothing"; }
        }
        spawn A a; awake a;
      `,
      testMode: { provider: "empty" },
    });

    expect(run.ok).toBe(true);
    requireEvent(run.events, "AgentCrashed");
    requireEvent(run.events, "Recovered");
  });

  it("records FailedPrincipalDecision when the identity dependency declines", async () => {
    const run = await adapter!.run({
      source: `
        enum Verdict { Yes, No }
        principal alice;
        agent A {
          on awake {
            Credence<Verdict> c = self <- "yes?";
            Decision<Verdict> d = alice decide c by conformal 0.05;
            endorse "subject" by d {
              Yes { say("yes"); }
              No { say("no"); }
            } abstain { say("declined"); }
          }
        }
        spawn A a; awake a;
      `,
      testMode: { principal: "deny" },
    });

    expect(run.ok).toBe(true);
    requireEvent(run.events, "FailedPrincipalDecision");
  });

  it("raises MarginFloorViolation and prevents the sink when an endorsed value misses policy floor", async () => {
    const run = await adapter!.run({
      source: `
        enum Verdict { Publish, Revise }
        action PublishMemo(text body);
        policy Strict { threshold 0.8 margin 0.0 floor 0.5 }
        agent A grants { perform PublishMemo } {
          on awake {
            text body = "draft";
            Credence<Verdict> c = self <- "publish?";
            Decision<Verdict> d = decide c by Strict;
            endorse body by d {
              Publish as e { perform PublishMemo(e); }
              Revise { }
            }
          }
        }
        spawn A a; awake a;
      `,
      testMode: { provider: { credence: { Publish: 0.81, Revise: 0.79 } } },
    });

    expect(run.ok).toBe(true);
    requireEvent(run.events, "MarginFloorViolation");
    expect(run.events.some((e) => e.etype === "PublishMemo")).toBe(false);
  });
});
