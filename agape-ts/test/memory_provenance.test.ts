import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.js";
import { run } from "../src/interp.js";
import { MockProvider } from "../src/runtime.js";
import {
  type MemoryConsultRequest,
  type MemoryConsultResult,
  type MemoryDriver,
  type MemoryForgetRequest,
  type MemoryReceipt,
  type MemoryScope,
  type MemoryStoredCell,
  type MemoryWriteRequest,
} from "../src/memory.js";
import { MarkdownMemoryDriver } from "../src/memory_markdown.js";
import { MemoryRuntimeDriver } from "../src/memory_runtime.js";

class RecordingMemory implements MemoryDriver {
  writes: MemoryWriteRequest[] = [];

  async declare(_scope: MemoryScope): Promise<void> {}

  async internalize(req: MemoryWriteRequest): Promise<MemoryReceipt> {
    this.writes.push(req);
    return { status: "RECORDED" };
  }

  async consult(_req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    return { hits: [], recalled: "", candidates: [] };
  }

  async forget(_req: MemoryForgetRequest): Promise<MemoryReceipt> {
    return { status: "FORGOTTEN" };
  }
}

// A substrate whose recall returns a cell that already carries provenance,
// so the runtime rerank path can be checked in isolation.
class ProvenancedSubstrate extends RecordingMemory {
  constructor(private readonly hit: MemoryStoredCell) {
    super();
  }

  override async consult(_req: MemoryConsultRequest): Promise<MemoryConsultResult> {
    return { hits: [this.hit], recalled: this.hit.memory, candidates: [{ ...this.hit }] };
  }
}

describe("memory-cell provenance threading", () => {
  it("threads the prompt attestation into explicit stores and provider-reply internalizations", async () => {
    const memory = new RecordingMemory();
    const prog = `
      prompt text question;
      agent A {
        when (Prompt p about question) {
          mem notes;
          notes <- p.text;
          text r = self <- f"note this down: \${p.text}";
        }
      }
      spawn A a; awake a;
    `;
    await run(parse(prog), {
      memory,
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "question", value: "the deploy step is npm run deploy", attestation: { attester: "test-harness" } }],
    });

    const store = memory.writes.find((w) => w.metadata?.source === "store");
    const reply = memory.writes.find((w) => w.metadata?.source === "provider_reply");
    expect(store?.metadata?.provenance).toEqual({ attester: "test-harness", prompt_name: "question" });
    expect(reply?.metadata?.provenance).toEqual({ attester: "test-harness", prompt_name: "question" });
  });

  it("records the default local attester when the prompt input carries no attestation", async () => {
    const memory = new RecordingMemory();
    const prog = `
      prompt text question;
      agent A {
        when (Prompt p about question) {
          mem notes;
          notes <- p.text;
        }
      }
      spawn A a; awake a;
    `;
    await run(parse(prog), {
      memory,
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "question", value: "hello" }],
    });

    expect(memory.writes[0]?.metadata?.provenance).toEqual({ attester: "studio-user", prompt_name: "question" });
  });

  it("omits provenance for reactions with no originating prompt delivery", async () => {
    const memory = new RecordingMemory();
    const prog = `
      agent A {
        on awake {
          mem notes <- "a boot-time note with no prompt behind it";
          notes <- "an explicit store, still promptless";
        }
      }
      spawn A a; awake a;
    `;
    await run(parse(prog), { memory, provider: new MockProvider(() => ({})) });

    expect(memory.writes).toHaveLength(2);
    for (const w of memory.writes) {
      expect(w.metadata).not.toHaveProperty("provenance");
    }
  });

  it("carries the delegating reaction's provenance into a background task handler's stores", async () => {
    const memory = new RecordingMemory();
    const prog = `
      prompt text question;
      agent Worker {
        on assigned {
          mem log;
          log <- "worker finding";
          complete "done";
        }
      }
      agent Lead grants { reach Worker } {
        when (Prompt p about question) {
          spawn Worker w; awake w;
          Task<text> h = w <- task {
            objective  "record a finding";
            acceptance "one note in the log";
          } expires 50;
        }
      }
      spawn Lead lead; awake lead;
    `;
    await run(parse(prog), {
      memory,
      provider: new MockProvider(() => ({})),
      promptInputs: [{ name: "question", value: "go", attestation: { attester: "test-harness" } }],
    });

    const store = memory.writes.find((w) => w.metadata?.source === "store");
    expect(store?.metadata?.provenance).toEqual({ attester: "test-harness", prompt_name: "question" });
  });

  it("persists provenance in the markdown cell's json metadata block and recalls it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agape-md-provenance-"));
    try {
      const prog = `
        prompt text question;
        agent A {
          when (Prompt p about question) {
            mem notes;
            notes <- "the deploy command is npm run deploy";
          }
        }
        spawn A a; awake a;
      `;
      await run(parse(prog), {
        memoryRoot: dir,
        provider: new MockProvider(() => ({})),
        promptInputs: [{ name: "question", value: "remember the deploy command", attestation: { attester: "local-user" } }],
      });

      const topic = await readFile(join(dir, ".agape", "memory", "scopes", "default", "a", "notes.md"), "utf8");
      expect(topic).toContain("the deploy command is npm run deploy");
      expect(topic).toContain('"provenance"');
      expect(topic).toContain('"attester": "local-user"');
      expect(topic).toContain('"prompt_name": "question"');

      // Recall surfaces the same provenance on the candidate, through the runtime rerank.
      const runtime = new MemoryRuntimeDriver(new MarkdownMemoryDriver({ path: join(dir, ".agape", "memory") }));
      const consulted = await runtime.consult({
        scope: { agent: "a", mem: "notes" },
        query: "deploy command",
        topK: 1,
      });
      expect(consulted.candidates[0]?.metadata).toMatchObject({
        provenance: { attester: "local-user", prompt_name: "question" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes provenance metadata through the memory runtime untouched, memory text byte-identical", async () => {
    const substrate = new RecordingMemory();
    const runtime = new MemoryRuntimeDriver(substrate, { dedupe: false });
    const req: MemoryWriteRequest = {
      scope: { agent: "a", mem: "notes", project: "t" },
      value: { kind: "text", v: "npm test", trust: "settled" },
      memory: "the build command is npm test",
      episode: { act: "store" },
      summary: { rendered: "npm test" },
      metadata: { source: "store", provenance: { attester: "test-harness", prompt_name: "question" } },
    };

    await runtime.internalize(req);

    expect(substrate.writes[0]?.memory).toBe(req.memory);
    expect(substrate.writes[0]?.metadata?.provenance).toEqual({ attester: "test-harness", prompt_name: "question" });
    expect(substrate.writes[0]?.metadata?.source).toBe("store");
  });

  it("keeps provenance on reranked recall candidates", async () => {
    const substrate = new ProvenancedSubstrate({
      id: "hit-1",
      memory: "the user prefers conservative waiver advice",
      score: 0.5,
      metadata: { memory_kind: "preference", provenance: { attester: "local-user", prompt_name: "chat" } },
    });
    const runtime = new MemoryRuntimeDriver(substrate);

    const consulted = await runtime.consult({
      scope: { agent: "a", mem: "notes", project: "t" },
      query: "waiver advice preference",
      topK: 1,
    });

    expect(consulted.hits[0]?.metadata?.provenance).toEqual({ attester: "local-user", prompt_name: "chat" });
    expect(consulted.candidates[0]?.metadata).toMatchObject({
      provenance: { attester: "local-user", prompt_name: "chat" },
    });
  });
});
