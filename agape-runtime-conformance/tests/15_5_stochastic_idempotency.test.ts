import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 15.5 stochastic consistency and idempotency", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("reports multi-run observational equivalence and enforces the configured stability bound", async () => {
    const result = await adapter!.multiRunScenario({
      source: `
        enum Verdict { Yes, No }
        agent A {
          on awake {
            Credence<Verdict> c = self <- "is this high-margin?";
            Decision<Verdict> d = decide c by confidence 0.9 margin 0.4;
            endorse "subject" by d {
              Yes { emit Event("yes"); }
              No { emit Event("no"); }
            } abstain { emit Event("abstain"); }
          }
        }
        spawn A a; awake a;
      `,
      runs: 25,
      observation: "committed-outcome",
      testMode: {
        stochasticProvider: {
          distribution: { Yes: 0.98, No: 0.02 },
          betaBound: 0.05,
        },
      },
    });

    expect(result.runs.length).toBe(25);
    expect(result.observations.length).toBe(25);
    expect(result.betaBound).toBeDefined();
    expect(result.violationRate).toBeLessThanOrEqual(result.betaBound!);
  });

  it("deduplicates repeated external input so consequential side effects are exactly-once", async () => {
    const result = await adapter!.idempotencyScenario({
      source: `
        enum Verdict { Send, Hold }
        write tool null notify(text body);
        prompt text request;
        when (Prompt p about request) {
          Credence<Verdict> c = self <- p.body;
          Decision<Verdict> d = decide c by confidence 0.9;
          endorse p.body by d {
            Send as e { notify(e); }
            Hold { }
          }
        }
      `,
      repeatedInput: { source: "request", idempotencyKey: "same-event", body: "hello" },
      repetitions: 3,
      testMode: { provider: { credence: { Send: 0.99, Hold: 0.01 } }, tools: { notify: { result: null } } },
    });

    expect(result.deduped).toBe(true);
    expect(result.sideEffectCount).toBe(1);
    expect(new Set(result.committedOutcomes).size).toBe(1);
  });
});
