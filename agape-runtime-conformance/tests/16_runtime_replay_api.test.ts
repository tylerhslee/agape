import { beforeEach, describe, expect, it } from "vitest";
import { LANGUAGE_SPEC_VERSION } from "../src/adapter.js";
import { loadAdapter } from "../src/loader.js";
import { requireEvent } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16 runtime API, ledger, and replay", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("reports runtime identity and release lockstep fields through health", async () => {
    const health = await adapter!.health();

    expect(health.runtimeId.length).toBeGreaterThan(0);
    expect(health.runtimeKind.length).toBeGreaterThan(0);
    expect(health.implementationVersion.length).toBeGreaterThan(0);
    expect(health.languageSpecVersion).toBe(LANGUAGE_SPEC_VERSION);
    expect(Number.isInteger(health.ledgerHead)).toBe(true);
    expect(health.provider.status.length).toBeGreaterThan(0);
  });

  it("canonical ledger hashing ignores non-canonical wall-clock fields", async () => {
    const canonical = {
      tick: 0,
      etype: "ConformanceEvent",
      subject: "subject",
      payload: { value: 1 },
      corr: "corr-1",
      agent: "agent-1",
    };
    const withEarlyClock = { ...canonical, ts: 1 };
    const withLateClock = { ...canonical, ts: 999999 };

    const early = await adapter!.canonicalHash([withEarlyClock]);
    const late = await adapter!.canonicalHash([withLateClock]);

    expect(early).toBe(late);
  });

  it("rejects config writes that try to set decision policy", async () => {
    await expect(
      adapter!.configWrite({
        policy: {
          threshold: 0.5,
          margin: 0.1,
          floor: 0.2,
          conformalAlpha: 0.05,
        },
      })
    ).rejects.toMatchObject({ category: "ConfigError" });
  });

  it("replays from the journal without re-invoking provider, tools, decomposition, or embeddings", async () => {
    const source = `
      enum Verdict { Yes, No }
      write tool null audit(text body);
      agent A grants { use audit } {
        on awake {
          Credence<Verdict> c = self <- "should this be audited?";
          Decision<Verdict> d = decide c by confidence 0.8;
          endorse "audit-payload" by d {
            Yes as e { audit(e); }
            No { }
          }
        }
      }
      spawn A a; awake a;
    `;

    const run = await adapter!.run({
      source,
      record: true,
      testMode: {
        provider: { credence: { Yes: 0.95, No: 0.05 } },
        tools: { audit: { result: null } },
      },
    });
    expect(run.ok).toBe(true);
    expect(run.recording).toBeTruthy();
    requireEvent(run.events, "ToolStarted");
    requireEvent(run.events, "ToolResolved");

    const beforeReplay = await adapter!.oracleStats();
    const replay = await adapter!.replay(run.recording);
    const afterReplay = await adapter!.oracleStats();

    expect(replay.ok).toBe(true);
    expect(replay.headHash).toBe(run.headHash);
    expect(afterReplay.providerCalls).toBe(beforeReplay.providerCalls);
    expect(afterReplay.toolCalls).toBe(beforeReplay.toolCalls);
    expect(afterReplay.decompositionCalls).toBe(beforeReplay.decompositionCalls);
    expect(afterReplay.embeddingCalls).toBe(beforeReplay.embeddingCalls);
  });

  it("records ArtifactObserved and explicitly requested MemoryConsulted as ordinary ledger events", async () => {
    const agent = { template: "LedgerAgent", instanceId: "ledger-agent" };

    const ingest = await adapter!.memoryIngest({
      agent,
      artifact: {
        kind: "doc",
        uri: "mem://ledger-events",
        title: "Ledger Events",
        text: "# Ledger Events\nArtifact observation is an auditable runtime event.",
      },
    });
    requireEvent(ingest.events, "ArtifactObserved", "mem://ledger-events");

    const context = await adapter!.memoryContext({ agent, task: "use memory" });
    expect(context.consulted).toBe(true);
    requireEvent(await adapter!.ledgerRead({ agent: agent.instanceId }), "MemoryConsulted");
  });
});
