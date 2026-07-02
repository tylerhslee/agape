import { beforeEach, describe, expect, it } from "vitest";
import { loadAdapter } from "../src/loader.js";
import { eventsOf, expectEventOrder, expectGapFreeTicks } from "../src/assertions.js";

const adapter = await loadAdapter();
const suite = adapter ? describe : describe.skip;

suite("SPEC 16.1 scheduler, lifecycle, and external sources", () => {
  beforeEach(async () => {
    await adapter!.reset();
  });

  it("dispatches async resolutions FIFO by issue tick, not wall-clock completion order", async () => {
    const run = await adapter!.run({
      source: `
        event Done(text id);
        agent A {
          on awake {
            event<Done> first = self <- "first";
            event<Done> second = self <- "second";
          }
        }
        spawn A a; awake a;
      `,
      testMode: {
        providerReplies: [
          { subject: "first", delayMs: 50, payload: { id: "first" } },
          { subject: "second", delayMs: 0, payload: { id: "second" } },
        ],
      },
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    const sent = eventsOf(run.events, "Sent");
    const resolved = eventsOf(run.events, "Resolved");
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(resolved.length).toBeGreaterThanOrEqual(2);
    expect(String(resolved[0].subject).toLowerCase()).toContain("first");
    expect(String(resolved[1].subject).toLowerCase()).toContain("second");
  });

  it("fires matching subscriptions synchronously in hoist order before the successor statement", async () => {
    const run = await adapter!.run({
      source: `
        event Start(text id); event First(text id); event Second(text id); event After(text id);
        when (Start s) { emit First(s.id); }
        when (Start s) { emit Second(s.id); }
        emit Start("x");
        emit After("x");
      `,
    });

    expect(run.ok).toBe(true);
    expectGapFreeTicks(run.events);
    expectEventOrder(run.events, ["Start", "First", "Second", "After"]);
  });

  it("keeps a prompt source live until an external arrival is processed, then reaches quiescence", async () => {
    const result = await adapter!.triggerExternalSource({
      source: `
        prompt text request;
        event Seen(text body);
        when (Prompt p about request) { emit Seen(p.body); }
      `,
      sourceName: "request",
      arrival: "hello",
    });

    expect(result.liveBeforeArrival).toBe(true);
    expect(result.quiescentAfterArrival).toBe(true);
    expect(result.afterArrival.events.some((e) => e.etype === "Prompt" && e.subject === "request")).toBe(true);
    expect(result.afterArrival.events.some((e) => e.etype === "Seen")).toBe(true);
  });

  it("preserves agent generation across sleep, awake, and contained crash", async () => {
    const run = await adapter!.run({
      source: `
        agent A {
          on crash { say("contained"); }
          on awake { self <- "crash please"; }
        }
        spawn A a; awake a; sleep a; awake a;
      `,
      testMode: { provider: "empty" },
    });

    expect(run.ok).toBe(true);
    expect(run.events.some((e) => e.etype === "AgentCrashed")).toBe(true);
    const awakeEvents = run.events.filter((e) => e.etype === "AgentAwake");
    expect(awakeEvents.length).toBeGreaterThanOrEqual(2);
    const generations = new Set(awakeEvents.map((e) => (e as any).agentGeneration ?? (e.payload as any)?.agentGeneration ?? 0));
    expect(generations.size).toBe(1);
  });
});
