import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Memory } from "./memory.ts";
import { HashingEmbedder } from "./provider.ts";

let mem: Memory;
beforeEach(() => {
  mem = new Memory(new HashingEmbedder(), ":memory:");
});
afterEach(() => mem.close());

const ENDORSE = {
  facts: [{ key: "endorse", value: "endorse collapses a Credence into a trusted Decision when it clears a confidence bar" }],
  triples: [
    { s: "endorse", p: "collapses", o: "Credence" },
    { s: "endorse", p: "produces", o: "Decision" },
  ],
};

describe("spine (§7)", () => {
  it("assigns monotonic ticks and stores events", () => {
    const t1 = mem.append("builder", "Awake", "self", "");
    const t2 = mem.append("builder", "Internalized", "endorse", "text");
    expect(t2).toBeGreaterThan(t1);
    expect(mem.event(t2)?.etype).toBe("Internalized");
    expect(mem.spineSize()).toBe(2);
  });
});

describe("internalization + provenance (§10)", () => {
  it("writes facts, triples, and an embedding all pinned to the originating event", () => {
    const tick = mem.internalize("builder", "Internalized", "§13 gate", "the endorse gate…", ENDORSE, "P");
    const facts = mem.select("builder");
    const triples = mem.find("builder");
    expect(facts).toHaveLength(1);
    expect(triples).toHaveLength(2);
    // provenance: every cell points back to the spine event that produced it
    expect(facts[0].origin_tick).toBe(tick);
    expect(triples.every((t) => t.origin_tick === tick)).toBe(true);
    expect(mem.event(tick)?.etype).toBe("Internalized");
    // taint defaults to P (graded)
    expect(facts[0].taint).toBe("P");
  });
});

describe("query surface (§10)", () => {
  beforeEach(() => {
    mem.internalize("builder", "Internalized", "gate", "endorse gate text", ENDORSE);
  });

  it("select returns FACTS, filterable", () => {
    expect(mem.select("builder", { key: "endorse" })).toHaveLength(1);
    expect(mem.select("builder", { contains: "Credence" })).toHaveLength(1);
    expect(mem.select("builder", { key: "missing" })).toHaveLength(0);
  });

  it("find matches the SPO graph by pattern", () => {
    expect(mem.find("builder", { p: "collapses" })).toHaveLength(1);
    expect(mem.find("builder", { s: "endorse" })).toHaveLength(2);
    expect(mem.find("builder", { o: "Decision" })[0].s).toBe("endorse");
    expect(mem.find("builder", { s: "abstain" })).toHaveLength(0);
  });

  it("match is a θ gate over SEMANTICS, ranked by similarity", () => {
    mem.internalize("builder", "Internalized", "refund", "performing a Refund action within granted authority", {
      facts: [{ key: "refund", value: "a refund is an action" }],
      triples: [],
    });
    const hits = mem.match("builder", "how does the endorse gate work", 0.0, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("endorse"); // the gate chunk outranks the refund chunk
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[hits.length - 1].score);
  });

  it("isolates memory per agent", () => {
    expect(mem.select("other-agent")).toHaveLength(0);
    expect(mem.counts("builder").facts).toBe(1);
  });
});

describe("inspection reads (free — no cognition)", () => {
  it("spineRecent returns events newest-first, capped", () => {
    for (let i = 0; i < 5; i++) mem.append("builder", "Tick", `e${i}`, "");
    const recent = mem.spineRecent("builder", 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].tick).toBeGreaterThan(recent[2].tick); // newest first
  });

  it("listEmbeddings returns texts + provenance, without raw vectors", () => {
    mem.internalize("builder", "Internalized", "gate", "endorse gate text", ENDORSE);
    const embs = mem.listEmbeddings("builder", 10);
    expect(embs).toHaveLength(1);
    expect(embs[0].text).toContain("endorse");
    expect(embs[0].origin_tick).toBeGreaterThan(0);
    expect((embs[0] as any).vec).toBeUndefined();
  });
});
