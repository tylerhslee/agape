import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Memory } from "./memory.ts";
import type { ChatMessage } from "./agent.ts";
import { HashingEmbedder, type Cognition, type Decomposition } from "./provider.ts";
import { Learner } from "./learner.ts";
import type { Runner, RunResult } from "./runner.ts";

class FakeCognition implements Cognition {
  readonly model = "fake";
  async complete(system: string, _messages: ChatMessage[], _maxTokens?: number): Promise<string> {
    if (/Summarize a knowledge artifact/i.test(system)) return "Whole artifact summary: Agape agents must gate cognition, use private memory, and record ledger evidence.";
    if (/Distill ONE reusable lesson/i.test(system)) return "Fix the failing Agape construct before retrying.";
    return "event Note(text message);\nagent Main { on awake { emit Note(\"ok\"); } }\nspawn Main main;\nawake main;";
  }
  async decompose(text: string): Promise<Decomposition> {
    const title = text.match(/^#+\s+(.+)$/m)?.[1] || "chunk";
    return {
      facts: [{ key: title.toLowerCase().replace(/\s+/g, "-"), value: text }],
      triples: [{ s: title, p: "describes", o: "Agape" }],
    };
  }
}

class FakeRunner implements Runner {
  readonly name = "fake-runner";
  available(): boolean { return true; }
  async run(): Promise<RunResult> {
    return { ok: true, output: "accepted", error: "", runner: this.name };
  }
}

let mem: Memory;
beforeEach(() => {
  mem = new Memory(new HashingEmbedder(), ":memory:");
});
afterEach(() => mem.close());

const spec = `# Agape Spec
This introduction is long enough to be retained and describes the whole language contract.

## Memory
Agents own private memory, consult it on every turn, and internalize experiences over time.

## Gates
Credence values must be decided and endorsed before consequential action.
`;

describe("Learner artifact ingestion", () => {
  it("summarizes, chunks, and dedupes a knowledge source", async () => {
    const learner = new Learner(mem, new FakeCognition(), new FakeRunner(), "Builder-1");
    const first = await learner.ingest(spec, 3);
    expect(first.chunks).toBe(3);
    expect(first.skipped).toBe(0);
    expect(first.summary).toContain("Whole artifact summary");
    expect(first.counts.sources).toBe(1);
    expect(first.counts.chunks).toBe(3);

    const second = await learner.ingest(spec, 3);
    expect(second.chunks).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.counts.sources).toBe(1);
    expect(second.counts.chunks).toBe(3);

    const ctx = learner.codingContext("write an agent with a gate");
    expect(ctx.context).toContain("Knowledge artifact summaries");
    expect(ctx.context).toContain("Agape agents must gate cognition");
  });

  it("records a memory consult even when memory is empty", () => {
    const learner = new Learner(mem, new FakeCognition(), new FakeRunner(), "Builder-1");
    const ctx = learner.codingContext("new task", { recordConsult: true });
    expect(ctx.consultTick).toBeGreaterThan(0);
    expect(mem.event(ctx.consultTick!)?.etype).toBe("MemoryConsulted");
    expect(ctx.context).toBe("");
  });

  it("internalizes experiences into the addressed agent only", () => {
    const a = new Learner(mem, new FakeCognition(), new FakeRunner(), "Builder-1");
    const b = new Learner(mem, new FakeCognition(), new FakeRunner(), "Builder-2");
    a.internalizeExperience("project-run", "main.ag", "checker accepted", { ok: true });

    expect(a.state().counts.facts).toBeGreaterThan(0);
    expect(b.state().counts.facts).toBe(0);
    expect(a.recall("checker accepted")[0]?.text).toContain("checker accepted");
  });
});
