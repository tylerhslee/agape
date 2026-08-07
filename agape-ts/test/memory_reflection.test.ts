import { describe, expect, it } from "vitest";
import { settledText, type Provider, type Variant } from "../src/runtime.js";
import {
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryEpisode,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryWriteRequest,
} from "../src/memory.js";
import {
  MemoryRuntimeDriver,
  renderStoreRecollection,
} from "../src/memory_runtime.js";

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

// What the interpreter actually sends: the raw value, the deterministic
// recollection template as req.memory, and the structured episode context.
function writeReq(raw: string, episode: MemoryEpisode = { act: "store" }): MemoryWriteRequest {
  const value = settledText(raw);
  return {
    scope: SCOPE,
    value,
    memory: renderStoreRecollection(SCOPE.mem, value),
    episode,
    summary: { rendered: raw },
  };
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
    expect(receipt.memory).toBe(stored.memory);
    expect(receipt.refs?.stored_memory).toBe(stored.memory);
    expect(receipt.policy?.reflection).toBe("reflected");
    // Reflection reads the structured episode, never the recollection template.
    expect(provider.prompts[0]).toContain("first-person memory");
    expect(provider.prompts[0]).toContain(RAW);
    expect(provider.prompts[0]).not.toContain("I stored a text value");
    expect(provider.prompts[0]).toContain("memory 'notes'");
  });

  it("reflects explicit writes without special-casing their metadata source", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, provider);

    await driver.internalize({
      ...writeReq("The answer is 4."),
      metadata: { source: "external_import", subject: "q" },
    });

    expect(provider.prompts[0]).toContain("Something I chose to remember");
    expect(provider.prompts[0]).toContain("The answer is 4.");
    expect(provider.prompts[0]).not.toContain("I asked:");
    expect(substrate.writes[0]!.metadata?.subject).toBe("q");
  });

  it("keeps the reflect-off path byte-identical: the template is what gets stored", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { dedupe: false });

    const req = writeReq(RAW);
    const receipt = await driver.internalize(req);

    expect(substrate.writes[0]!.memory).toBe(req.memory);
    expect(substrate.writes[0]!.memory).toContain("I stored a text value in private memory 'notes'.");
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBeUndefined();
    expect(receipt.memory).toBe(req.memory);
  });

  it("stores verbatim by default — reflection is opt-in", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { dedupe: false }, provider);

    const req = writeReq(RAW);
    await driver.internalize(req);

    expect(substrate.writes[0]!.memory).toBe(req.memory);
    expect(provider.prompts).toHaveLength(0);
  });

  it("stores verbatim when reflect is on but no provider handle exists", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false });

    const req = writeReq(RAW);
    await driver.internalize(req);

    expect(substrate.writes[0]!.memory).toBe(req.memory);
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBeUndefined();
  });

  it("falls back to the template when the provider fails", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, new FailingProvider());

    const req = writeReq(RAW);
    const receipt = await driver.internalize(req);

    expect(substrate.writes[0]!.memory).toBe(req.memory);
    expect(substrate.writes[0]!.metadata?.memory_reflection).toBe("failed_fallback_raw");
    expect(receipt.policy?.reflection).toBe("failed_fallback_raw");
  });

  it("falls back to req.memory as reflection input when the value renders empty", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, provider);

    const req: MemoryWriteRequest = {
      scope: SCOPE,
      value: settledText(""),
      memory: "a recollection with no renderable value",
      episode: { act: "store" },
      summary: {},
    };
    await driver.internalize(req);

    expect(provider.prompts[0]).toContain("a recollection with no renderable value");
  });

  it("keeps the reflection instruction name-free so no example name can leak into memories", async () => {
    const substrate = new RecordingSubstrate();
    const provider = new ProseProvider();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, provider);

    const nameless = "exchange — the user said: im heading to bed | I replied: sleep well";
    await driver.internalize(writeReq(nameless));

    // The only proper names the reflector may see are ones the episode itself
    // contains — an example name in the instruction gets copied into real
    // memories by small models.
    const instruction = provider.prompts[0]!.replace(nameless, "");
    expect(instruction).not.toMatch(/\b[A-Z][a-z]+ (uses|said|prefers)\b/);
    expect(provider.prompts[0]).toContain("never invent or assume a name");
  });

  it("classifies the reflected prose, not the raw episode", async () => {
    const substrate = new RecordingSubstrate();
    const driver = new MemoryRuntimeDriver(substrate, { reflect: true, dedupe: false }, new ProseProvider());

    await driver.internalize(writeReq(RAW));

    // "prefers" in the reflected prose → preference classification.
    expect(substrate.writes[0]!.metadata?.memory_kind).toBe("preference");
  });
});
