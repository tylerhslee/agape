import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { totalMemoryCells } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.5 record/replay and memory rebuild", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("replays provider, identity, tool, prompt, and memory oracles without reinvocation", async () => {
    const run = await adapter!.run({
      source: `
        enum Verdict { Send, Hold }
        principal alice;
        write tool null notify(text body);
        prompt text request;
        when (Prompt p about request) {
          Credence<Verdict> c = self <- p.body;
          Decision<Verdict> d = alice decide c by conformal 0.05;
          endorse p.body by d {
            Send as e { notify(e); }
            Hold { }
          } abstain { }
        }
      `,
      record: true,
      testMode: {
        promptArrivals: [{ source: "request", value: "hello" }],
        provider: { credence: { Send: 0.4, Hold: 0.6 } },
        principal: "grant:Send",
        tools: { notify: { result: null } },
        memoryInternalization: "journaled",
      },
    });

    expect(run.ok).toBe(true);
    expect(run.recording).toBeTruthy();

    const before = await adapter!.oracleStats();
    const replay = await adapter!.replay(run.recording);
    const after = await adapter!.oracleStats();

    expect(replay.ok).toBe(true);
    expect(replay.headHash).toBe(run.headHash);
    expect(after.providerCalls).toBe(before.providerCalls);
    expect(after.toolCalls).toBe(before.toolCalls);
    expect(after.identityCalls).toBe(before.identityCalls);
    expect(after.promptArrivals).toBe(before.promptArrivals);
    expect(after.decompositionCalls).toBe(before.decompositionCalls);
    expect(after.embeddingCalls).toBe(before.embeddingCalls);
  });

  it("rebuilds private memory from the recording with the same cells and provenance", async () => {
    const agent = { template: "ReplayAgent", instanceId: "replay-agent" };
    await adapter!.memoryIngest({
      agent,
      artifact: {
        kind: "doc",
        uri: "mem://rebuild",
        title: "Rebuild",
        text: "# Rebuild\nMemory is a projection of ledgered evidence.",
      },
    });
    const run = await adapter!.run({
      source: `event Done(text id); emit Done("x");`,
      record: true,
    });
    const before = await adapter!.memoryInspect({ agent });
    const rebuilt = await adapter!.rebuildMemoryFromRecording(run.recording);
    const after = rebuilt[agent.instanceId];

    expect(after).toBeTruthy();
    expect(totalMemoryCells(after)).toBe(totalMemoryCells(before));
    for (const group of [after.summaries, after.chunks, after.facts, after.triples, after.vectors]) {
      for (const cell of group) expect(Number.isInteger(cell.originTick)).toBe(true);
    }
  });
});
