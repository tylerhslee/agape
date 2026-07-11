import { describe, expect, it } from "vitest";
import { settledText, type Provider, type Variant } from "../src/runtime.js";
import {
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryWriteRequest,
} from "../src/memory.js";
import { MemoryRuntimeDriver } from "../src/memory_runtime.js";

class RecordingSubstrate implements MemoryDriver {
  writes: MemoryWriteRequest[] = [];

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    this.writes.push(req);
    return { status: "APPENDED" };
  }

  async consult(_req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    return { hits: [], recalled: "", candidates: [] };
  }

  async forget(_req: MemoryForgetRequest): Promise<MemoryReceipt> {
    return { status: "FORGOTTEN" };
  }
}

class ProseProvider implements Provider {
  prompts: string[] = [];
  async judge(_p: string, _e: string, variants: Variant[]) {
    return { scores: Object.fromEntries(variants.map((v, i) => [v, i === 0 ? 1 : 0])) };
  }
  async reply(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return "I met Tyler today; he prefers replies without a greeting.";
  }
}

class FailingProvider extends ProseProvider {
  override async reply(): Promise<string> {
    throw new Error("provider down");
  }
}

const SCOPE = { agent: "a", mem: "notes", project: "t" };
const RAW =
  "exchange — Tyler said: hello there, please stop greeting me every time | I replied: Hello Tyler — understood, I can adjust!";

function writeReq(memory: string): MemoryWriteRequest {
  return { scope: SCOPE, value: settledText(memory), memory, summary: { rendered: memory } };
}

describe("memory reflection ([memory] reflect)", () => {
  it("rewrites the raw episode into provider prose before storing", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, provider);

    const receipt = await driver.internalize(writeReq(RAW));

    expect(substrate.writes).toHaveLength(1);
    const stored = substrate.writes[0]!;
    expect(stored.memory).toBe("I met Tyler today; he prefers replies without a greeting.");
    expect(stored.metadata?.memory_reflection).toBe("reflected");
    expect(stored.metadata?.reflected_from_hash).toBeTypeOf("string");
    expect(receipt.refs?.stored_memory).toBe(stored.memory);
    expect(receipt.policy?.reflection).toBe("reflected");
    // The reflection prompt carries the raw episode to the provider.
    expect(provider.prompts[0]).toContain("first-person memory");
    expect(provider.prompts[0]).toContain(RAW);
  });

  it("stores verbatim by default — reflection is opt-in", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { dedupe: false }, provider);

    await driver.internalize(writeReq(RAW));

    expect(substrate.writes[0]!.memory).toBe(RAW);
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBeUndefined();
    expect(provider.prompts).toHaveLength(0);
  });

  it("stores verbatim when reflect is on but no provider handle exists", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false });

    await driver.internalize(writeReq(RAW));

    expect(substrate.writes[0]!.memory).toBe(RAW);
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBeUndefined();
  });

  it("falls back to the raw episode when the provider fails", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, new FailingProvider());

    const receipt = await driver.internalize(writeReq(RAW));

    expect(substrate.writes[0]!.memory).toBe(RAW);
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBe("failed_fallback_raw");
    expect(receipt.policy?.reflection).toBe("failed_fallback_raw");
  });

  it("classifies the reflected prose, not the raw episode", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, new ProseProvider());

    await driver.internalize(writeReq(RAW));

    // "prefers" in the reflected prose → preference classification.
    expect(substrate.writes[0]!.metadata?.memory_kind).toBe("preference");
  });
});
