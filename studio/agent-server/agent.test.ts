import { describe, it, expect } from "vitest";
import { buildMessages, systemPrompt } from "./agent.ts";

const item = { title: "refund policy agent", destination: "endorse refunds within policy", status: "active" };

describe("systemPrompt", () => {
  it("grounds the agent in the work item and Agape's model", () => {
    const s = systemPrompt(item);
    expect(s).toContain("refund policy agent");
    expect(s).toContain("endorse refunds within policy");
    expect(s).toMatch(/Credence/);
    expect(s).toMatch(/grants/);
    expect(s).toMatch(/ledger/);
  });

  it("includes project and memory context when supplied", () => {
    const s = systemPrompt(item, { project: "Project: x", memory: "Rules:\n- gate before perform" });
    expect(s).toContain("Project context:");
    expect(s).toContain("Project: x");
    expect(s).toContain("Builder memory context:");
    expect(s).toContain("gate before perform");
  });
});

describe("buildMessages - respond", () => {
  it("maps thread roles and ends on a user turn", () => {
    const thread = [
      { who: "you" as const, text: "Draft the gate." },
      { who: "ai" as const, text: "Here's my plan." },
      { who: "you" as const, text: "Focus on the abstain path." },
    ];
    const { system, messages } = buildMessages(item, thread, "respond");
    expect(system).toContain("refund policy agent");
    expect(messages).toEqual([
      { role: "user", content: "Draft the gate." },
      { role: "assistant", content: "Here's my plan." },
      { role: "user", content: "Focus on the abstain path." },
    ]);
    expect(messages.at(-1)!.role).toBe("user");
  });

  it("drops sys breadcrumbs and starts on a user turn", () => {
    const thread = [
      { who: "sys" as const, text: "Delegated to Builder-1." },
      { who: "you" as const, text: "What's first?" },
    ];
    const { messages } = buildMessages(item, thread, "respond");
    expect(messages.every((m) => m.content !== "Delegated to Builder-1.")).toBe(true);
    expect(messages[0].role).toBe("user");
    expect(messages.at(-1)).toEqual({ role: "user", content: "What's first?" });
  });

  it("cold-starts with a user turn when the thread is empty", () => {
    const { messages } = buildMessages(item, [], "respond");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });
});

describe("buildMessages - kickoff", () => {
  it("appends a start-now instruction as the final user turn", () => {
    const { messages } = buildMessages(item, [{ who: "sys", text: "Delegated to Builder-1." }], "kickoff");
    expect(messages.at(-1)!.role).toBe("user");
    expect(messages.at(-1)!.content).toMatch(/delegated/i);
    expect(messages.at(-1)!.content).toMatch(/Start it now/i);
  });
});

describe("buildMessages - intent turns", () => {
  it("turns inspect into a concrete findings instruction", () => {
    const { messages } = buildMessages(item, [{ who: "you", text: "tell me what this project is about" }], "inspect");
    expect(messages.at(-1)!.role).toBe("user");
    expect(messages.at(-1)!.content).toMatch(/concrete findings/i);
    expect(messages.at(-1)!.content).toMatch(/Do not merely promise/i);
  });
});
